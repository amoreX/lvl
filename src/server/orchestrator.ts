import { randomUUID } from 'node:crypto';
import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';
import type { CreateMatchInput, MatchRecord, RunRecord, Scorecard, ScoreEvent, TaskConfig, TraceStep } from '../shared/types.js';
import { ChromiumGameEnvironment } from './chromiumEnvironment.js';
import { config } from './config.js';
import { ContextCompactionTracker } from './contextCompaction.js';
import { BarebonesHarness } from './harness.js';
import { evaluateMoveWithStockfish } from './stockfish.js';
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

    const chess = new Chess();
    const env = new ChromiumGameEnvironment(task, match.seed);
    const harnessByColor = {
      w: new BarebonesHarness(whiteHarnessConfig, whiteModel),
      b: new BarebonesHarness(blackHarnessConfig, blackModel),
    } satisfies Record<Color, BarebonesHarness>;
    const runByColor = { w: whiteRun, b: blackRun } satisfies Record<Color, RunRecord>;
    const runStartedAt = { w: Date.now(), b: Date.now() } satisfies Record<Color, number>;
    const maxPlies = Math.min(match.maxSteps || task.objective.maxPlies || 120, task.objective.maxPlies || 120);
    const illegalCounts = { w: 0, b: 0 } satisfies Record<Color, number>;
    const compactionExcludedMs = { w: 0, b: 0 } satisfies Record<Color, number>;
    const quality = {
      w: { total: 0, moves: 0, blunders: 0 },
      b: { total: 0, moves: 0, blunders: 0 },
    } satisfies Record<Color, { total: number; moves: number; blunders: number }>;
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
            const moveQuality = await analyzeMoveQuality(beforeFen, chess, move, color);
            quality[color].total += moveQuality.score;
            quality[color].moves += 1;
            if (moveQuality.label === 'blunder') quality[color].blunders += 1;
            scoreEvents.push(chessEvent(activeRun.id, ply, 'progress', 10, `Legal move played: ${move.san}.`));
            scoreEvents.push(chessEvent(activeRun.id, ply, 'chessQuality', 0, `Move quality ${moveQuality.label}: ${moveQuality.score}/100 (${moveQuality.reason}).`));
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
        qualityAverage: averageQuality(quality.w),
        blunderCount: quality.w.blunders,
        startedAt: runStartedAt.w,
        excludedMs: compactionExcludedMs.w,
      });
      const blackScorecard = chessScorecard({
        color: 'b',
        result,
        run: currentRunByColor.b,
        chess,
        illegalCount: illegalCounts.b,
        qualityAverage: averageQuality(quality.b),
        blunderCount: quality.b.blunders,
        startedAt: runStartedAt.b,
        excludedMs: compactionExcludedMs.b,
      });

      const endedAt = new Date().toISOString();
      await this.store.updateRun(whiteRun.id, {
        status: 'completed',
        endedAt,
        latencyMs: Math.max(0, Date.now() - runStartedAt.w - compactionExcludedMs.w),
        scorecard: whiteScorecard,
        failureLabels: whiteScorecard.failureLabels,
        costUsd: whiteScorecard.costUsd,
      });
      await this.store.updateRun(blackRun.id, {
        status: 'completed',
        endedAt,
        latencyMs: Math.max(0, Date.now() - runStartedAt.b - compactionExcludedMs.b),
        scorecard: blackScorecard,
        failureLabels: blackScorecard.failureLabels,
        costUsd: blackScorecard.costUsd,
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
  qualityAverage: number;
  blunderCount: number;
  startedAt: number;
  excludedMs: number;
}): Scorecard {
  const won = input.result.winner === input.color;
  const drew = input.result.winner == null;
  const taskSuccess = won ? 100 : drew ? 50 : 0;
  const efficiency = clampScore(100 - Math.max(0, input.run.stepCount - 1) * 2);
  const progress = clampScore(50 + materialBalance(input.chess) * (input.color === 'w' ? 5 : -5) + input.run.stepCount * 2);
  const chessQuality = clampScore(input.qualityAverage - input.blunderCount * 4);
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
  if (input.blunderCount > 0) failureLabels.push('chess_blunder');
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
    latencyMs: Math.max(0, Date.now() - input.startedAt - input.excludedMs),
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

async function analyzeMoveQuality(
  beforeFen: string,
  afterChess: Chess,
  move: { san: string; captured?: PieceSymbol; piece: PieceSymbol; to: string },
  color: Color,
) {
  const engineQuality = await evaluateMoveWithStockfish(beforeFen, afterChess.fen());
  if (engineQuality) return engineQuality;
  const before = new Chess(beforeFen);
  const materialDelta = (materialBalance(afterChess) - materialBalance(before)) * (color === 'w' ? 1 : -1);
  const captureBonus = move.captured ? pieceValue(move.captured) * 4 : 0;
  const checkBonus = move.san.includes('#') ? 22 : move.san.includes('+') ? 6 : 0;
  const replyPenalty = opponentCanCaptureMovedPiece(afterChess, move.to, color) ? pieceValue(move.piece) * 5 : 0;
  const mobility = Math.min(8, afterChess.moves().length / 4);
  const score = clampScore(70 + materialDelta * 8 + captureBonus + checkBonus + mobility - replyPenalty);
  const label = score >= 90 ? 'excellent' : score >= 75 ? 'good' : score >= 55 ? 'inaccuracy' : score >= 35 ? 'mistake' : 'blunder';
  const reason = [
    materialDelta ? `material ${materialDelta > 0 ? '+' : ''}${materialDelta}` : 'material stable',
    move.captured ? `captured ${move.captured}` : '',
    checkBonus ? 'check pressure' : '',
    replyPenalty ? 'moved piece can be captured' : '',
  ].filter(Boolean).join(', ');
  return { score, label, reason: `heuristic fallback, ${reason}`, source: 'heuristic' as const };
}

function opponentCanCaptureMovedPiece(chess: Chess, square: string, mover: Color) {
  const opponent = mover === 'w' ? 'b' : 'w';
  if (chess.turn() !== opponent) return false;
  return chess.moves({ verbose: true }).some((reply) => reply.to === square && Boolean(reply.captured));
}

function pieceValue(piece: PieceSymbol) {
  const values: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  return values[piece];
}

function averageQuality(value: { total: number; moves: number }) {
  return value.moves ? roundScore(value.total / value.moves) : 50;
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
