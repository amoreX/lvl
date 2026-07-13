import { randomUUID } from 'node:crypto';
import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';
import type { ChessScoreMetrics, CreateMatchInput, MatchRecord, RunRecord, Scorecard, ScoreEvent, TaskConfig, TraceStep } from '../shared/types.js';
import { ChromiumGameEnvironment } from './chromiumEnvironment.js';
import { config } from './config.js';
import { ContextCompactionTracker } from './contextCompaction.js';
import { createHarnessAdapter, type HarnessAdapter } from './harness.js';
import { evaluateMoveWithStockfish, evaluatePositionWithStockfish } from './stockfish.js';
import type { JsonStore } from './storage.js';

type Job = { matchId: string; run: () => Promise<void> };
type MoveQuality = {
  score: number;
  label: string;
  reason: string;
  source: 'stockfish';
  centipawnLoss?: number;
  bestMove?: string;
  beforeCentipawns?: number;
  afterCentipawns?: number;
  advantageSwing?: number;
  depth?: number;
  pv?: string[];
};
type QualityTracker = {
  total: number;
  moves: number;
  stockfishMoves: number;
  inaccuracies: number;
  mistakes: number;
  blunders: number;
  centipawnLossTotal: number;
  centipawnLossMoves: number;
  advantageSwingTotal: number;
  advantageSwingMoves: number;
  worstAdvantageSwing: number | null;
  depthTotal: number;
  depthMoves: number;
};

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
    const seed = 0;
    const runs: RunRecord[] = [
      this.makeRun(matchId, 'agentA', 1, 'w', input.agentA.modelId, input.agentA.harnessId, task, seed, now),
      this.makeRun(matchId, 'agentB', 1, 'b', input.agentB.modelId, input.agentB.harnessId, task, seed, now),
      this.makeRun(matchId, 'agentB', 2, 'w', input.agentB.modelId, input.agentB.harnessId, task, seed, now),
      this.makeRun(matchId, 'agentA', 2, 'b', input.agentA.modelId, input.agentA.harnessId, task, seed, now),
    ];
    const match: MatchRecord = {
      id: matchId,
      name: input.name || `${modelA.name} vs ${modelB.name}`,
      taskId: task.id,
      seed,
      memoryMode: input.memoryMode || 'fresh',
      runMode: input.runMode,
      status: 'queued',
      maxSteps: input.maxSteps || task.maxSteps || config.defaultMaxSteps,
      maxToolCalls: input.maxToolCalls || task.maxToolCalls || config.defaultMaxToolCalls,
      maxCostUsdPerRun: input.maxCostUsdPerRun,
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

  async deleteMatch(matchId: string) {
    const match = await this.store.getMatch(matchId);
    if (!match) return false;
    const isActive = this.abortControllers.has(matchId) || this.queue.some((job) => job.matchId === matchId);
    if (isActive || !['completed', 'failed', 'cancelled'].includes(match.status)) {
      await this.cancelMatch(matchId);
    }
    return this.store.deleteMatch(matchId);
  }

  shutdown() {
    for (const job of this.queue) {
      this.cancelled.add(job.matchId);
    }
    this.queue = [];
    for (const [matchId, controller] of this.abortControllers) {
      this.cancelled.add(matchId);
      controller.abort(new Error('Server shutting down.'));
    }
  }

  status() {
    return {
      state: this.active > 0 ? 'running' : 'idle',
      active: this.active,
      queued: this.queue.length,
    } as const;
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
    const runtimeSeed = randomSeed();
    await this.store.updateMatch(matchId, { status: 'running', startedAt: new Date().toISOString(), seed: runtimeSeed });
    for (const runId of detail.match.runIds) {
      await this.store.updateRun(runId, { seed: runtimeSeed });
    }
    try {
      await Promise.all([
        this.runChessGame(matchId, 1, abortController.signal),
        this.runChessGame(matchId, 2, abortController.signal),
      ]);
      await this.finishPairedMatch(matchId);
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
      const endedAt = new Date().toISOString();
      for (const runId of detail.match.runIds) {
        const run = await this.store.getRun(runId);
        if (run && !['completed', 'failed', 'cancelled'].includes(run.status)) {
          await this.store.updateRun(runId, {
            status: 'failed',
            endedAt,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.abortControllers.delete(matchId);
    }
  }

  private async runChessGame(matchId: string, gameIndex: number, abortSignal: AbortSignal) {
    const state = await this.store.all();
    const match = state.matches.find((item) => item.id === matchId);
    if (!match) throw new Error(`Match not found ${matchId}`);
    const task = state.tasks.find((item) => item.id === match.taskId);
    if (!task) throw new Error(`Task not found ${match.taskId}`);
    const whiteRun = state.runs.find((run) => run.matchId === matchId && run.gameIndex === gameIndex && run.color === 'w');
    const blackRun = state.runs.find((run) => run.matchId === matchId && run.gameIndex === gameIndex && run.color === 'b');
    if (!whiteRun || !blackRun) throw new Error('Chess match requires two model runs.');
    const whiteModel = state.models.find((model) => model.id === whiteRun.modelId);
    const blackModel = state.models.find((model) => model.id === blackRun.modelId);
    const whiteHarnessConfig = state.harnesses.find((harness) => harness.id === whiteRun.harnessId);
    const blackHarnessConfig = state.harnesses.find((harness) => harness.id === blackRun.harnessId);
    if (!whiteModel || !blackModel || !whiteHarnessConfig || !blackHarnessConfig) throw new Error('Chess run dependencies missing.');

    const chess = chessForTask(task);
    const env = new ChromiumGameEnvironment(task, match.seed);
    const harnessByColor = {
      w: await createHarnessAdapter(whiteHarnessConfig, whiteModel),
      b: await createHarnessAdapter(blackHarnessConfig, blackModel),
    } satisfies Record<Color, HarnessAdapter>;
    const runByColor = { w: whiteRun, b: blackRun } satisfies Record<Color, RunRecord>;
    const runStartedAt = { w: Date.now(), b: Date.now() } satisfies Record<Color, number>;
    const maxPlies = Math.min(match.maxSteps || task.objective.maxPlies || 120, task.objective.maxPlies || 120);
    const illegalCounts = { w: 0, b: 0 } satisfies Record<Color, number>;
    const compactionExcludedMs = { w: 0, b: 0 } satisfies Record<Color, number>;
    const quality = {
      w: emptyQualityTracker(),
      b: emptyQualityTracker(),
    } satisfies Record<Color, QualityTracker>;
    let currentRunByColor = { w: whiteRun, b: blackRun } satisfies Record<Color, RunRecord>;
    const historyByRunId: Record<string, TraceStep[]> = {
      [whiteRun.id]: [],
      [blackRun.id]: [],
    };
    const compactionByRunId: Record<string, ContextCompactionTracker> = {
      [whiteRun.id]: new ContextCompactionTracker(),
      [blackRun.id]: new ContextCompactionTracker(),
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
        enforceRunBudget(match, activeRun);
        const harness = harnessByColor[color];
        const observation = await env.currentObservation(ply);
        const preparedContext = match.memoryMode === 'context_dump'
          ? compactionByRunId[activeRun.id].prepare(historyByRunId[activeRun.id])
          : { contextDump: undefined, compacted: false, elapsedMs: 0 };
        compactionExcludedMs[color] += preparedContext.elapsedMs;

        await this.store.updateRun(activeRun.id, { status: 'waiting_for_model' });
        const modelOutput = await harness.runStep({
          runId: activeRun.id,
          seed: activeRun.seed,
          stepIndex: ply,
          observation,
          contextDump: preparedContext.contextDump,
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
          modelLatencyMs: (activeRun.modelLatencyMs ?? 0) + modelOutput.latencyMs,
          costUsd: activeRun.costUsd + modelOutput.costUsd,
          costEstimated: Boolean(activeRun.costEstimated || modelOutput.costEstimated),
        });
        enforceRunBudget(match, {
          ...activeRun,
          costUsd: activeRun.costUsd + modelOutput.costUsd,
        });

        const result = await env.executeBrowserTool(modelOutput.browserTool!, activeRun.id, ply);
        if (this.cancelled.has(match.id) || abortSignal.aborted) {
          await this.markMatchCancelled(match.id);
          return;
        }
        const proposedMove = chessProposedMove(result.observation.pageState);
        const scoreEvents = [...result.scoreEvents];
        if (preparedContext.compacted) {
          scoreEvents.push(chessEvent(activeRun.id, ply, 'progress', 0, 'Harness auto-compacted own prior-turn context before this move.'));
        }
        let legalMovePlayed = false;
        let fatalScoringError: Error | null = null;

        if (!proposedMove) {
          const reason = 'No complete source/destination chess move was proposed. Same player must retry with a legal move.';
          illegalCounts[color] += 1;
          scoreEvents.push(chessEvent(activeRun.id, ply, 'failure', -18, reason));
          await env.applyChessState(chessState(chess, `${reason} ${chessStatus(chess)}`));
        } else {
          const beforeFen = chess.fen();
          const move = tryChessMove(chess, proposedMove);
          if (!move) {
            const reason = `Illegal chess move ${proposedMove.from}${proposedMove.to}. Same player must retry with a legal move.`;
            illegalCounts[color] += 1;
            scoreEvents.push(chessEvent(activeRun.id, ply, 'failure', -18, reason));
            await env.applyChessState(chessState(chess, `${reason} ${chessStatus(chess)}`));
          } else {
            legalMovePlayed = true;
            scoreEvents.push(chessEvent(activeRun.id, ply, 'progress', 10, `Legal move played: ${move.san}.`));
            try {
              const moveQuality = await analyzeMoveQuality(beforeFen, chess, move, color);
              quality[color].total += moveQuality.score;
              quality[color].moves += 1;
              trackMoveQuality(quality[color], moveQuality);
              scoreEvents.push(chessEvent(activeRun.id, ply, 'chessQuality', 0, moveQualityReason(moveQuality)));
            } catch (error) {
              fatalScoringError = error instanceof Error ? error : new Error(String(error));
              scoreEvents.push(chessEvent(activeRun.id, ply, 'failure', -100, `Stockfish scoring failed: ${fatalScoringError.message}`));
            }
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
          modelLatencyMs: (activeRun.modelLatencyMs ?? 0) + modelOutput.latencyMs,
          costUsd: activeRun.costUsd + modelOutput.costUsd,
          costEstimated: Boolean(activeRun.costEstimated || modelOutput.costEstimated),
        };
        currentRunByColor[color] = updatedRun;
        await this.store.updateRun(activeRun.id, {
          status: 'running',
          stepCount: updatedRun.stepCount,
          toolCallCount: updatedRun.toolCallCount,
          latencyMs: updatedRun.latencyMs,
          modelLatencyMs: updatedRun.modelLatencyMs,
          costUsd: updatedRun.costUsd,
          costEstimated: updatedRun.costEstimated,
        });

        if (fatalScoringError) throw fatalScoringError;

        if (!legalMovePlayed) {
          await sleep(120);
          continue;
        }
        await sleep(120);
      }

      const result = await chessResult(chess);
      const whiteWallClockMs = Math.max(0, Date.now() - runStartedAt.w - compactionExcludedMs.w);
      const blackWallClockMs = Math.max(0, Date.now() - runStartedAt.b - compactionExcludedMs.b);
      const whiteScorecard = chessScorecard({
        color: 'w',
        result,
        run: currentRunByColor.w,
        chess,
        illegalCount: illegalCounts.w,
        qualityAverage: averageQuality(quality.w),
        metrics: chessMetrics(quality.w, illegalCounts.w),
        startedAt: runStartedAt.w,
        excludedMs: compactionExcludedMs.w,
        wallClockMs: whiteWallClockMs,
      });
      const blackScorecard = chessScorecard({
        color: 'b',
        result,
        run: currentRunByColor.b,
        chess,
        illegalCount: illegalCounts.b,
        qualityAverage: averageQuality(quality.b),
        metrics: chessMetrics(quality.b, illegalCounts.b),
        startedAt: runStartedAt.b,
        excludedMs: compactionExcludedMs.b,
        wallClockMs: blackWallClockMs,
      });

      const endedAt = new Date().toISOString();
      await this.store.updateRun(whiteRun.id, {
        status: 'completed',
        endedAt,
        latencyMs: currentRunByColor.w.latencyMs,
        modelLatencyMs: currentRunByColor.w.modelLatencyMs ?? currentRunByColor.w.latencyMs,
        wallClockMs: whiteWallClockMs,
        scorecard: whiteScorecard,
        failureLabels: whiteScorecard.failureLabels,
        costUsd: whiteScorecard.costUsd,
        costEstimated: whiteScorecard.costEstimated,
      });
      await this.store.updateRun(blackRun.id, {
        status: 'completed',
        endedAt,
        latencyMs: currentRunByColor.b.latencyMs,
        modelLatencyMs: currentRunByColor.b.modelLatencyMs ?? currentRunByColor.b.latencyMs,
        wallClockMs: blackWallClockMs,
        scorecard: blackScorecard,
        failureLabels: blackScorecard.failureLabels,
        costUsd: blackScorecard.costUsd,
        costEstimated: blackScorecard.costEstimated,
      });
    } finally {
      await env.dispose();
    }
  }

  private async finishPairedMatch(matchId: string) {
    const detail = await this.store.matchDetail(matchId);
    if (!detail) return;
    const completed = detail.runs.filter((run) => run.status === 'completed' && run.scorecard);
    if (completed.length < detail.runs.length) return;

    const points = { agentA: 0, agentB: 0 } satisfies Record<RunRecord['role'], number>;
    for (const run of completed) {
      points[run.role] += run.scorecard?.taskSuccess === 100 ? 1 : run.scorecard?.taskSuccess === 50 ? 0.5 : 0;
    }
    const winnerRole = points.agentA > points.agentB ? 'agentA' : points.agentB > points.agentA ? 'agentB' : null;
    const winnerRunId = winnerRole
      ? completed
        .filter((run) => run.role === winnerRole)
        .sort((a, b) => (b.scorecard?.total ?? 0) - (a.scorecard?.total ?? 0))[0]?.id ?? null
      : null;
    await this.store.updateMatch(matchId, {
      status: this.cancelled.has(matchId) ? 'cancelled' : 'completed',
      endedAt: new Date().toISOString(),
      winnerRunId,
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
    gameIndex: number,
    color: Color,
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
      gameIndex,
      color,
      modelId,
      harnessId,
      taskId: task.id,
      seed,
      status: 'queued',
      stepCount: 0,
      toolCallCount: 0,
      costUsd: 0,
      costEstimated: false,
      latencyMs: 0,
      modelLatencyMs: 0,
      wallClockMs: 0,
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

function chessForTask(task: TaskConfig) {
  return task.objective.initialFen ? new Chess(task.objective.initialFen) : new Chess();
}

function enforceRunBudget(match: MatchRecord, run: RunRecord) {
  const cap = match.maxCostUsdPerRun;
  if (!cap || run.costUsd < cap) return;
  throw new Error(`Run budget exceeded: ${run.modelId} game ${run.gameIndex} ${run.color} spent $${run.costUsd.toFixed(4)} of $${cap.toFixed(2)}.`);
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
    lastMove: chess.history().at(-1) ?? null,
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

function chessStatus(chess: Chess) {
  if (chess.isCheckmate()) return 'checkmate';
  if (chess.isStalemate()) return 'stalemate';
  if (chess.isThreefoldRepetition()) return 'threefold repetition';
  if (chess.isInsufficientMaterial()) return 'insufficient material';
  if (chess.isDraw()) return 'draw';
  if (chess.inCheck()) return `${chess.turn() === 'w' ? 'White' : 'Black'} to move, in check`;
  return `${chess.turn() === 'w' ? 'White' : 'Black'} to move`;
}

async function chessResult(chess: Chess): Promise<{ winner: Color | null; reason: string }> {
  if (chess.isCheckmate()) {
    return {
      winner: chess.turn() === 'w' ? 'b' : 'w',
      reason: 'checkmate',
    };
  }
  if (chess.isDraw()) return { winner: null, reason: chessStatus(chess) };
  const evaluation = await evaluatePositionWithStockfish(chess.fen());
  const threshold = config.stockfishAdjudicationThresholdCp;
  const score = evaluation.centipawns;
  const engineNote = `Stockfish ${formatCp(score)}${evaluation.bestMove ? `, best ${evaluation.bestMove}` : ''}`;
  if (score >= threshold) return { winner: 'w', reason: `adjudicated by ${engineNote} after move cap` };
  if (score <= -threshold) return { winner: 'b', reason: `adjudicated by ${engineNote} after move cap` };
  return { winner: null, reason: `adjudicated draw by ${engineNote} after move cap` };
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
  qualityAverage: number;
  metrics: ChessScoreMetrics;
  startedAt: number;
  excludedMs: number;
  wallClockMs: number;
}): Scorecard {
  const won = input.result.winner === input.color;
  const drew = input.result.winner == null;
  const taskSuccess = won ? 100 : drew ? 50 : 0;
  const efficiency = clampScore(100 - Math.max(0, input.run.stepCount - 1) * 2);
  const progress = clampScore(50 + materialBalance(input.chess) * (input.color === 'w' ? 5 : -5) + input.run.stepCount * 2);
  const chessQuality = clampScore(input.qualityAverage - input.metrics.blunders * 4 - input.metrics.mistakes * 2 - input.metrics.inaccuracies);
  const toolUseQuality = clampScore(100 - input.illegalCount * 18);
  const robustness = 75;
  const consistency = null;
  const total = roundScore(
    taskSuccess * 0.35
    + efficiency * 0.12
    + robustness * 0.08
    + progress * 0.15
    + toolUseQuality * 0.15
    + chessQuality * 0.10
    + (consistency ?? 75) * 0.05,
  );
  const failureLabels = won || drew ? [] : ['chess_loss'];
  if (input.illegalCount > 0) failureLabels.push('illegal_chess_move');
  if (input.metrics.inaccuracies > 0) failureLabels.push('chess_inaccuracy');
  if (input.metrics.mistakes > 0) failureLabels.push('chess_mistake');
  if (input.metrics.blunders > 0) failureLabels.push('chess_blunder');
  return {
    total,
    taskSuccess,
    efficiency,
    robustness,
    progress,
    chessQuality,
    toolUseQuality,
    consistency,
    costUsd: roundScore(input.run.costUsd, 6),
    costEstimated: Boolean(input.run.costEstimated),
    latencyMs: input.run.latencyMs,
    modelLatencyMs: input.run.modelLatencyMs ?? input.run.latencyMs,
    wallClockMs: input.wallClockMs,
    chess: input.metrics,
    failureLabels,
    rubricVersion: `chess-0.2.0:${input.result.reason}`,
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

function emptyQualityTracker(): QualityTracker {
  return {
    total: 0,
    moves: 0,
    stockfishMoves: 0,
    inaccuracies: 0,
    mistakes: 0,
    blunders: 0,
    centipawnLossTotal: 0,
    centipawnLossMoves: 0,
    advantageSwingTotal: 0,
    advantageSwingMoves: 0,
    worstAdvantageSwing: null,
    depthTotal: 0,
    depthMoves: 0,
  };
}

function trackMoveQuality(tracker: QualityTracker, quality: MoveQuality) {
  if (quality.source === 'stockfish') tracker.stockfishMoves += 1;
  if (quality.label === 'inaccuracy') tracker.inaccuracies += 1;
  if (quality.label === 'mistake') tracker.mistakes += 1;
  if (quality.label === 'blunder') tracker.blunders += 1;
  if (typeof quality.centipawnLoss === 'number') {
    tracker.centipawnLossTotal += quality.centipawnLoss;
    tracker.centipawnLossMoves += 1;
  }
  if (typeof quality.advantageSwing === 'number') {
    tracker.advantageSwingTotal += quality.advantageSwing;
    tracker.advantageSwingMoves += 1;
    tracker.worstAdvantageSwing = tracker.worstAdvantageSwing === null
      ? quality.advantageSwing
      : Math.min(tracker.worstAdvantageSwing, quality.advantageSwing);
  }
  if (typeof quality.depth === 'number') {
    tracker.depthTotal += quality.depth;
    tracker.depthMoves += 1;
  }
}

function chessMetrics(tracker: QualityTracker, illegalMoves: number): ChessScoreMetrics {
  return {
    movesAnalyzed: tracker.moves,
    engineMoves: tracker.stockfishMoves,
    averageStockfishDepth: tracker.depthMoves ? roundScore(tracker.depthTotal / tracker.depthMoves) : null,
    averageCentipawnLoss: tracker.centipawnLossMoves ? roundScore(tracker.centipawnLossTotal / tracker.centipawnLossMoves) : null,
    averageAdvantageSwing: tracker.advantageSwingMoves ? roundScore(tracker.advantageSwingTotal / tracker.advantageSwingMoves) : null,
    worstAdvantageSwing: tracker.worstAdvantageSwing === null ? null : roundScore(tracker.worstAdvantageSwing),
    inaccuracies: tracker.inaccuracies,
    mistakes: tracker.mistakes,
    blunders: tracker.blunders,
    illegalMoves,
  };
}

function moveQualityReason(quality: MoveQuality) {
  const metrics = [
    typeof quality.centipawnLoss === 'number' ? `CPL ${quality.centipawnLoss}` : '',
    typeof quality.advantageSwing === 'number' ? `swing ${quality.advantageSwing >= 0 ? '+' : ''}${quality.advantageSwing}cp` : '',
    quality.bestMove ? `best ${quality.bestMove}` : '',
  ].filter(Boolean).join(', ');
  return `Move quality ${quality.label}: ${quality.score}/100${metrics ? ` (${metrics})` : ''}. ${quality.reason}.`;
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, roundScore(value)));
}

function roundScore(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}

async function analyzeMoveQuality(
  beforeFen: string,
  afterChess: Chess,
  _move: { san: string; captured?: PieceSymbol; piece: PieceSymbol; to: string },
  _color: Color,
): Promise<MoveQuality> {
  return evaluateMoveWithStockfish(beforeFen, afterChess.fen());
}

function averageQuality(value: { total: number; moves: number }) {
  return value.moves ? roundScore(value.total / value.moves) : 50;
}

function formatCp(value: number) {
  return `${value >= 0 ? '+' : ''}${Math.round(value)}cp`;
}

function randomSeed() {
  return Math.floor(Math.random() * 1_000_000_000) + 1;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === 'AbortError' || /aborted|cancelled/i.test(error.message));
}
