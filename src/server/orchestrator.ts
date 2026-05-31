import { randomUUID } from 'node:crypto';
import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';
import type { CreateMatchInput, MatchRecord, RunRecord, Scorecard, ScoreEvent, TaskConfig, TraceStep } from '../shared/types.js';
import { ChromiumGameEnvironment } from './chromiumEnvironment.js';
import { config } from './config.js';
import { BarebonesHarness } from './harness.js';
import { scoreRun } from './scoring.js';
import type { JsonStore } from './storage.js';

type Job = { matchId: string; run: () => Promise<void> };

export class MatchOrchestrator {
  private queue: Job[] = [];
  private active = 0;
  private cancelled = new Set<string>();
  private abortControllers = new Map<string, AbortController>();

  constructor(private readonly store: JsonStore) {}

  async createMatch(input: CreateMatchInput) {
    const state = await this.store.all();
    const task = state.tasks.find((item) => item.id === input.taskId);
    if (!task) throw new Error(`Unknown task ${input.taskId}`);
    const harnessA = state.harnesses.find((item) => item.id === input.agentA.harnessId);
    const harnessB = state.harnesses.find((item) => item.id === input.agentB.harnessId);
    const modelA = state.models.find((item) => item.id === input.agentA.modelId);
    const modelB = state.models.find((item) => item.id === input.agentB.modelId);
    if (!harnessA || !harnessB || !modelA || !modelB) throw new Error('Invalid model or harness selection.');

    const now = new Date().toISOString();
    const matchId = randomUUID();
    const seed = input.seed || Math.floor(Math.random() * 1_000_000);
    const runs: RunRecord[] = [
      this.makeRun(matchId, 'agentA', input.agentA.modelId, input.agentA.harnessId, task, seed, now),
      this.makeRun(matchId, 'agentB', input.agentB.modelId, input.agentB.harnessId, task, seed, now),
    ];
    const match: MatchRecord = {
      id: matchId,
      name: input.name || `${modelA.name} vs ${modelB.name}`,
      taskId: task.id,
      seed,
      seedMode: input.seedMode || (input.seed == null ? 'random' : 'fixed'),
      suiteIndex: input.suiteIndex,
      suiteCount: input.suiteCount,
      memoryMode: input.memoryMode || 'fresh',
      runMode: input.runMode,
      status: 'queued',
      maxSteps: input.maxSteps || task.maxSteps || config.defaultMaxSteps,
      maxToolCalls: input.maxToolCalls || task.maxToolCalls || config.defaultMaxToolCalls,
      hurdlesEnabled: input.hurdlesEnabled,
      runIds: runs.map((run) => run.id),
      winnerRunId: null,
      createdAt: now,
    };
    await this.store.insertMatch(match, runs);
    this.enqueueMatch(match.id);
    return match;
  }

  async cancelMatch(matchId: string) {
    this.cancelled.add(matchId);
    this.queue = this.queue.filter((job) => job.matchId !== matchId);
    this.abortControllers.get(matchId)?.abort(new Error('Match cancelled.'));
    const match = await this.store.getMatch(matchId);
    if (!match) return null;
    await this.store.updateMatch(matchId, { status: 'cancelled', endedAt: new Date().toISOString() });
    for (const runId of match.runIds) {
      const run = await this.store.getRun(runId);
      if (run && !['completed', 'failed', 'cancelled'].includes(run.status)) {
        await this.store.updateRun(runId, { status: 'cancelled', endedAt: new Date().toISOString() });
      }
    }
    return this.store.matchDetail(matchId);
  }

  enqueueMatch(matchId: string) {
    this.queue.push({ matchId, run: async () => this.runMatch(matchId) });
    this.pump();
  }

  private pump() {
    while (this.active < config.workerConcurrency && this.queue.length) {
      const job = this.queue.shift();
      if (!job) return;
      this.active += 1;
      void job.run()
        .catch(() => undefined)
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }

  private async runMatch(matchId: string) {
    const detail = await this.store.matchDetail(matchId);
    if (!detail || this.cancelled.has(matchId)) return;
    const abortController = new AbortController();
    this.abortControllers.set(matchId, abortController);
    await this.store.updateMatch(matchId, { status: 'running', startedAt: new Date().toISOString() });
    try {
      if (detail.task.objective.kind === 'chess_match') {
        await this.runChessMatch(matchId, abortController.signal);
        return;
      }
      if (detail.match.runMode === 'parallel') {
        await Promise.all(detail.runs.map((run) => this.runOne(run.id, abortController.signal)));
      } else {
        for (const run of detail.runs) {
          if (this.cancelled.has(matchId)) break;
          await this.runOne(run.id, abortController.signal);
        }
      }
      if (this.cancelled.has(matchId)) return;
      await this.finishMatch(matchId);
    } catch (error) {
      if (this.cancelled.has(matchId) || abortController.signal.aborted || isAbortError(error)) {
        await this.markMatchCancelled(matchId);
        return;
      }
      await this.store.updateMatch(matchId, {
        status: 'failed',
        endedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.abortControllers.delete(matchId);
    }
  }

  private async runChessMatch(matchId: string, abortSignal: AbortSignal) {
    const state = await this.store.all();
    const match = state.matches.find((item) => item.id === matchId);
    if (!match) throw new Error(`Match not found ${matchId}`);
    const task = state.tasks.find((item) => item.id === match.taskId);
    if (!task) throw new Error(`Task not found ${match.taskId}`);
    const whiteRun = state.runs.find((run) => run.matchId === matchId && run.role === 'agentA');
    const blackRun = state.runs.find((run) => run.matchId === matchId && run.role === 'agentB');
    if (!whiteRun || !blackRun) throw new Error('Chess match requires two model runs.');
    const whiteModel = state.models.find((model) => model.id === whiteRun.modelId);
    const blackModel = state.models.find((model) => model.id === blackRun.modelId);
    const whiteHarnessConfig = state.harnesses.find((harness) => harness.id === whiteRun.harnessId);
    const blackHarnessConfig = state.harnesses.find((harness) => harness.id === blackRun.harnessId);
    if (!whiteModel || !blackModel || !whiteHarnessConfig || !blackHarnessConfig) throw new Error('Chess run dependencies missing.');

    const chess = new Chess();
    const env = new ChromiumGameEnvironment(task, match.seed, false);
    const harnessByColor = {
      w: new BarebonesHarness(whiteHarnessConfig, whiteModel),
      b: new BarebonesHarness(blackHarnessConfig, blackModel),
    } satisfies Record<Color, BarebonesHarness>;
    const runByColor = { w: whiteRun, b: blackRun } satisfies Record<Color, RunRecord>;
    const runStartedAt = { w: Date.now(), b: Date.now() } satisfies Record<Color, number>;
    const maxPlies = Math.min(match.maxSteps || task.objective.maxPlies || 120, task.objective.maxPlies || 120);
    const illegalCounts = { w: 0, b: 0 } satisfies Record<Color, number>;
    let currentRunByColor = { w: whiteRun, b: blackRun } satisfies Record<Color, RunRecord>;
    const historyByRunId: Record<string, TraceStep[]> = {
      [whiteRun.id]: [],
      [blackRun.id]: [],
    };

    await this.store.updateRun(whiteRun.id, { status: 'running', startedAt: new Date().toISOString() });
    await this.store.updateRun(blackRun.id, { status: 'running', startedAt: new Date().toISOString() });

    try {
      await env.reset();
      await env.applyChessState(chessState(chess, 'Game started.'));

      for (let ply = 0; ply < maxPlies; ply += 1) {
        if (this.cancelled.has(match.id) || abortSignal.aborted) {
          await this.markMatchCancelled(match.id);
          return;
        }
        if (chess.isGameOver()) break;

        const color = chess.turn();
        const activeRun = currentRunByColor[color];
        const harness = harnessByColor[color];
        const observation = await env.currentObservation(ply);

        await this.store.updateRun(activeRun.id, { status: 'waiting_for_model' });
        const modelOutput = await harness.runStep({
          runId: activeRun.id,
          seed: activeRun.seed,
          stepIndex: ply,
          observation,
          contextDump: match.memoryMode === 'context_dump' ? contextDump(historyByRunId[activeRun.id]) : undefined,
          abortSignal,
          maxToolCalls: match.maxToolCalls,
          timeoutMs: config.defaultTimeoutMs,
        });

        if (this.cancelled.has(match.id) || abortSignal.aborted) {
          await this.markMatchCancelled(match.id);
          return;
        }

        await this.store.updateRun(activeRun.id, {
          status: 'executing_tool',
          latencyMs: activeRun.latencyMs + modelOutput.latencyMs,
          costUsd: activeRun.costUsd + modelOutput.costUsd,
        });

        const result = await env.executeBrowserTool(modelOutput.browserTool!, activeRun.id, ply);
        const proposedMove = chessProposedMove(result.observation.pageState);
        const scoreEvents = [...result.scoreEvents];
        let legalMovePlayed = false;

        if (!proposedMove) {
          const reason = 'No complete source/destination chess move was proposed. Same player must retry with a legal move.';
          illegalCounts[color] += 1;
          scoreEvents.push(chessEvent(activeRun.id, ply, 'failure', -18, reason));
          await env.applyChessState(chessState(chess, `${reason} ${chessStatus(chess)}`));
        } else {
          const move = tryChessMove(chess, proposedMove);
          if (!move) {
            const reason = `Illegal chess move ${proposedMove.from}${proposedMove.to}. Same player must retry with a legal move.`;
            illegalCounts[color] += 1;
            scoreEvents.push(chessEvent(activeRun.id, ply, 'failure', -18, reason));
            await env.applyChessState(chessState(chess, `${reason} ${chessStatus(chess)}`));
          } else {
            legalMovePlayed = true;
            scoreEvents.push(chessEvent(activeRun.id, ply, 'progress', 10, `Legal move played: ${move.san}.`));
            await env.applyChessState(chessState(chess, chessStatus(chess)));
          }
        }

        const step: TraceStep = {
          id: randomUUID(),
          runId: activeRun.id,
          stepIndex: ply,
          observation,
          modelOutput,
          toolCall: result.toolCall,
          scoreEvents,
          createdAt: new Date().toISOString(),
        };
        await this.store.addStep(step);
        historyByRunId[activeRun.id].push(step);

        const updatedRun: RunRecord = {
          ...activeRun,
          stepCount: activeRun.stepCount + 1,
          toolCallCount: activeRun.toolCallCount + result.toolCall.actions.length,
          latencyMs: activeRun.latencyMs + modelOutput.latencyMs + result.toolCall.latencyMs,
          costUsd: activeRun.costUsd + modelOutput.costUsd,
        };
        currentRunByColor[color] = updatedRun;
        await this.store.updateRun(activeRun.id, {
          status: 'running',
          stepCount: updatedRun.stepCount,
          toolCallCount: updatedRun.toolCallCount,
          latencyMs: updatedRun.latencyMs,
          costUsd: updatedRun.costUsd,
        });

        if (!legalMovePlayed) {
          await sleep(120);
          continue;
        }
        await sleep(120);
      }

      const result = chessResult(chess);
      const whiteScorecard = chessScorecard({
        color: 'w',
        result,
        run: currentRunByColor.w,
        chess,
        illegalCount: illegalCounts.w,
        startedAt: runStartedAt.w,
      });
      const blackScorecard = chessScorecard({
        color: 'b',
        result,
        run: currentRunByColor.b,
        chess,
        illegalCount: illegalCounts.b,
        startedAt: runStartedAt.b,
      });

      const endedAt = new Date().toISOString();
      await this.store.updateRun(whiteRun.id, {
        status: 'completed',
        endedAt,
        latencyMs: Date.now() - runStartedAt.w,
        scorecard: whiteScorecard,
        failureLabels: whiteScorecard.failureLabels,
        costUsd: whiteScorecard.costUsd,
      });
      await this.store.updateRun(blackRun.id, {
        status: 'completed',
        endedAt,
        latencyMs: Date.now() - runStartedAt.b,
        scorecard: blackScorecard,
        failureLabels: blackScorecard.failureLabels,
        costUsd: blackScorecard.costUsd,
      });

      const winnerRunId = result.winner === 'w' ? whiteRun.id : result.winner === 'b' ? blackRun.id : null;
      await this.store.updateMatch(matchId, {
        status: this.cancelled.has(matchId) ? 'cancelled' : 'completed',
        endedAt,
        winnerRunId,
      });
    } finally {
      await env.dispose();
    }
  }

  private async runOne(runId: string, abortSignal: AbortSignal) {
    const state = await this.store.all();
    const run = state.runs.find((item) => item.id === runId);
    if (!run) throw new Error(`Run not found ${runId}`);
    const match = state.matches.find((item) => item.id === run.matchId);
    const task = state.tasks.find((item) => item.id === run.taskId);
    const model = state.models.find((item) => item.id === run.modelId);
    const harnessConfig = state.harnesses.find((item) => item.id === run.harnessId);
    if (!match || !task || !model || !harnessConfig) throw new Error('Run dependencies missing.');
    if (this.cancelled.has(match.id)) return;

    const env = new ChromiumGameEnvironment(task, run.seed, match.hurdlesEnabled);
    const harness = new BarebonesHarness(harnessConfig, model);
    let observation = await env.reset();
    let currentRun = run;
    const priorSteps: TraceStep[] = [];
    const runStarted = Date.now();

    await this.store.updateRun(runId, { status: 'running', startedAt: new Date().toISOString() });

    try {
      for (let stepIndex = 0; stepIndex < match.maxSteps; stepIndex += 1) {
      if (this.cancelled.has(match.id) || abortSignal.aborted) {
        await this.store.updateRun(runId, { status: 'cancelled', endedAt: new Date().toISOString() });
        return;
      }
      await this.store.updateRun(runId, { status: 'waiting_for_model' });
      const modelOutput = await harness.runStep({
        runId,
        seed: run.seed,
        stepIndex,
        observation,
        contextDump: match.memoryMode === 'context_dump' ? contextDump(priorSteps) : undefined,
        abortSignal,
        maxToolCalls: match.maxToolCalls,
        timeoutMs: config.defaultTimeoutMs,
      });
      if (this.cancelled.has(match.id) || abortSignal.aborted) {
        await this.store.updateRun(runId, { status: 'cancelled', endedAt: new Date().toISOString() });
        return;
      }

      await this.store.updateRun(runId, {
        status: 'executing_tool',
        latencyMs: currentRun.latencyMs + modelOutput.latencyMs,
        costUsd: currentRun.costUsd + modelOutput.costUsd,
      });

      const result = await env.executeBrowserTool(modelOutput.browserTool!, runId, stepIndex);
      const step: TraceStep = {
        id: randomUUID(),
        runId,
        stepIndex,
        observation,
        modelOutput,
        toolCall: result.toolCall,
        scoreEvents: result.scoreEvents,
        createdAt: new Date().toISOString(),
      };
      await this.store.addStep(step);
      priorSteps.push(step);
      currentRun = {
        ...currentRun,
        stepCount: stepIndex + 1,
        toolCallCount: currentRun.toolCallCount + result.toolCall.actions.length,
        latencyMs: currentRun.latencyMs + result.toolCall.latencyMs,
        costUsd: currentRun.costUsd + modelOutput.costUsd,
      };
      await this.store.updateRun(runId, {
        status: 'running',
        stepCount: currentRun.stepCount,
        toolCallCount: currentRun.toolCallCount,
        latencyMs: currentRun.latencyMs,
        costUsd: currentRun.costUsd,
      });
      observation = result.observation;
      if (result.done) break;
      await sleep(120);
      }
    } finally {
      await env.dispose();
    }

    await this.store.updateRun(runId, { status: 'scoring' });
    const steps = (await this.store.all()).steps.filter((step) => step.runId === runId);
    const latestRun = await this.store.getRun(runId);
    const scorecard = scoreRun(latestRun ?? currentRun, task, steps);
    await this.store.updateRun(runId, {
      status: 'completed',
      endedAt: new Date().toISOString(),
      latencyMs: Date.now() - runStarted,
      scorecard,
      failureLabels: scorecard.failureLabels,
      costUsd: scorecard.costUsd,
    });
  }

  private async finishMatch(matchId: string) {
    const detail = await this.store.matchDetail(matchId);
    if (!detail) return;
    const completed = detail.runs.filter((run) => run.status === 'completed' && run.scorecard);
    const winner = completed
      .slice()
      .sort((a, b) => (b.scorecard?.total ?? 0) - (a.scorecard?.total ?? 0))[0];
    await this.store.updateMatch(matchId, {
      status: this.cancelled.has(matchId) ? 'cancelled' : 'completed',
      endedAt: new Date().toISOString(),
      winnerRunId: winner?.id ?? null,
    });
  }

  private async markMatchCancelled(matchId: string) {
    const match = await this.store.getMatch(matchId);
    if (!match) return;
    const endedAt = new Date().toISOString();
    await this.store.updateMatch(matchId, { status: 'cancelled', endedAt });
    for (const runId of match.runIds) {
      const run = await this.store.getRun(runId);
      if (run && !['completed', 'failed', 'cancelled'].includes(run.status)) {
        await this.store.updateRun(runId, { status: 'cancelled', endedAt });
      }
    }
  }

  private makeRun(
    matchId: string,
    role: RunRecord['role'],
    modelId: string,
    harnessId: string,
    task: TaskConfig,
    seed: number,
    now: string,
  ): RunRecord {
    return {
      id: randomUUID(),
      matchId,
      role,
      modelId,
      harnessId,
      taskId: task.id,
      seed,
      status: 'queued',
      stepCount: 0,
      toolCallCount: 0,
      costUsd: 0,
      latencyMs: 0,
      failureLabels: [],
      createdAt: now,
    };
  }
}

function chessProposedMove(value: Record<string, unknown>) {
  const move = value.proposedMove;
  if (!move || typeof move !== 'object' || Array.isArray(move)) return null;
  const record = move as Record<string, unknown>;
  if (typeof record.from !== 'string' || typeof record.to !== 'string') return null;
  if (!/^[a-h][1-8]$/.test(record.from) || !/^[a-h][1-8]$/.test(record.to)) return null;
  return {
    from: record.from,
    to: record.to,
    promotion: typeof record.promotion === 'string' ? record.promotion : 'q',
  };
}

function tryChessMove(chess: Chess, proposedMove: { from: string; to: string; promotion?: string }) {
  try {
    return chess.move({
      from: proposedMove.from as Square,
      to: proposedMove.to as Square,
      promotion: proposedMove.promotion || 'q',
    });
  } catch {
    return null;
  }
}

function chessState(chess: Chess, gameStatus: string) {
  return {
    board: chessBoardMap(chess),
    fen: chess.fen(),
    turn: chess.turn(),
    moveHistory: chess.history(),
    legalMoves: chess.moves({ verbose: true }).map((move) => `${move.from}${move.to}${move.promotion ?? ''} (${move.san})`),
    gameStatus,
    confirmed: chess.isGameOver(),
    clearSelection: true,
  };
}

function chessBoardMap(chess: Chess) {
  const output: Record<string, string> = {};
  const board = chess.board();
  for (let rankIndex = 0; rankIndex < board.length; rankIndex += 1) {
    const rank = 8 - rankIndex;
    for (let fileIndex = 0; fileIndex < board[rankIndex].length; fileIndex += 1) {
      const piece = board[rankIndex][fileIndex];
      if (!piece) continue;
      const file = String.fromCharCode(97 + fileIndex);
      output[`${file}${rank}`] = pieceGlyph(piece.color, piece.type);
    }
  }
  return output;
}

function pieceGlyph(color: Color, type: PieceSymbol) {
  const glyphs: Record<Color, Record<PieceSymbol, string>> = {
    w: { p: '♙', r: '♖', n: '♘', b: '♗', q: '♕', k: '♔' },
    b: { p: '♟', r: '♜', n: '♞', b: '♝', q: '♛', k: '♚' },
  };
  return glyphs[color][type];
}

function contextDump(steps: TraceStep[]) {
  if (!steps.length) return 'No previous turns for this agent.';
  return steps.map((step) => {
    const toolInput = step.toolCall?.input.mode === 'run'
      ? step.toolCall.input.script
      : step.toolCall?.input.mode ?? 'none';
    const actions = step.toolCall?.actions.map((action) => `${action.action}:${action.successful ? 'ok' : action.error ?? 'failed'}`).join(', ') || 'none';
    const score = step.scoreEvents.map((event) => `${event.delta >= 0 ? '+' : ''}${event.delta} ${event.dimension}: ${event.reason}`).join(' | ') || 'none';
    const { screenshotDataUrl: _screenshotDataUrl, ...observation } = step.observation;
    return [
      `Turn ${step.stepIndex + 1}`,
      `Observation:\n${JSON.stringify(observation, null, 2)}`,
      `Model output:\n${step.modelOutput.rawText}`,
      `Tool input:\n${toolInput}`,
      `Tool actions: ${actions}`,
      `Score events: ${score}`,
    ].join('\n');
  }).join('\n\n---\n\n');
}

function chessStatus(chess: Chess) {
  if (chess.isCheckmate()) return 'checkmate';
  if (chess.isStalemate()) return 'stalemate';
  if (chess.isThreefoldRepetition()) return 'threefold repetition';
  if (chess.isInsufficientMaterial()) return 'insufficient material';
  if (chess.isDraw()) return 'draw';
  if (chess.inCheck()) return `${chess.turn() === 'w' ? 'White' : 'Black'} to move, in check`;
  return `${chess.turn() === 'w' ? 'White' : 'Black'} to move`;
}

function chessResult(chess: Chess): { winner: Color | null; reason: string } {
  if (chess.isCheckmate()) {
    return {
      winner: chess.turn() === 'w' ? 'b' : 'w',
      reason: 'checkmate',
    };
  }
  if (chess.isDraw()) return { winner: null, reason: chessStatus(chess) };
  const material = materialBalance(chess);
  if (material > 0) return { winner: 'w', reason: 'adjudicated by material after move cap' };
  if (material < 0) return { winner: 'b', reason: 'adjudicated by material after move cap' };
  return { winner: null, reason: 'adjudicated draw after move cap' };
}

function materialBalance(chess: Chess) {
  const values: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  let total = 0;
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece) continue;
      total += (piece.color === 'w' ? 1 : -1) * values[piece.type];
    }
  }
  return total;
}

function chessScorecard(input: {
  color: Color;
  result: { winner: Color | null; reason: string };
  run: RunRecord;
  chess: Chess;
  illegalCount: number;
  startedAt: number;
}): Scorecard {
  const won = input.result.winner === input.color;
  const drew = input.result.winner == null;
  const taskSuccess = won ? 100 : drew ? 50 : 0;
  const efficiency = clampScore(100 - Math.max(0, input.run.stepCount - 1) * 2);
  const progress = clampScore(50 + materialBalance(input.chess) * (input.color === 'w' ? 5 : -5) + input.run.stepCount * 2);
  const toolUseQuality = clampScore(100 - input.illegalCount * 18);
  const robustness = 75;
  const consistency = null;
  const total = roundScore(
    taskSuccess * 0.40
    + efficiency * 0.15
    + robustness * 0.10
    + progress * 0.15
    + toolUseQuality * 0.15
    + (consistency ?? 75) * 0.05,
  );
  const failureLabels = won || drew ? [] : ['chess_loss'];
  if (input.illegalCount > 0) failureLabels.push('illegal_chess_move');
  return {
    total,
    taskSuccess,
    efficiency,
    robustness,
    progress,
    toolUseQuality,
    consistency,
    costUsd: roundScore(input.run.costUsd, 6),
    latencyMs: Date.now() - input.startedAt,
    failureLabels,
    rubricVersion: `chess-0.1.0:${input.result.reason}`,
  };
}

function chessEvent(
  runId: string,
  stepIndex: number,
  dimension: ScoreEvent['dimension'],
  delta: number,
  reason: string,
): ScoreEvent {
  return { id: randomUUID(), runId, stepIndex, dimension, delta, reason };
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, roundScore(value)));
}

function roundScore(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === 'AbortError' || /aborted|cancelled/i.test(error.message));
}
