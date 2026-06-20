import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { config } from './config.js';

type EngineEval = {
  centipawns: number;
  whiteCentipawns: number;
  bestMove?: string;
  depth?: number;
  pv?: string[];
  mate?: number;
};

export type EngineMoveQuality = {
  score: number;
  label: string;
  reason: string;
  source: 'stockfish';
  centipawnLoss: number;
  bestMove?: string;
  beforeCentipawns: number;
  afterCentipawns: number;
  advantageSwing: number;
  depth?: number;
  pv?: string[];
};

export type EnginePositionEvaluation = {
  centipawns: number;
  bestMove?: string;
  depth?: number;
  pv?: string[];
  mate?: number;
};

let engine: StockfishEngine | null = null;

export async function evaluateMoveWithStockfish(beforeFen: string, afterFen: string): Promise<EngineMoveQuality> {
  const before = await stockfishEngine().evaluateFen(beforeFen);
  const after = await stockfishEngine().evaluateFen(afterFen);
  const playedPositionForMover = -after.centipawns;
  const centipawnLoss = Math.max(0, before.centipawns - playedPositionForMover);
  const advantageSwing = playedPositionForMover - before.centipawns;
  const score = scoreFromCentipawnLoss(centipawnLoss);
  const depth = Math.min(
    before.depth ?? config.stockfishDepth,
    after.depth ?? config.stockfishDepth,
  );
  return {
    score,
    label: labelFromCentipawnLoss(centipawnLoss),
    reason: [
      `Stockfish score ${score}/100`,
      `depth ${depth}`,
      config.stockfishMovetimeMs > 0 ? `movetime ${config.stockfishMovetimeMs}ms` : '',
      `centipawn loss ${Math.round(centipawnLoss)}`,
      `swing ${formatCp(advantageSwing)}`,
      `before ${formatCp(before.centipawns)}`,
      `after ${formatCp(playedPositionForMover)}`,
      before.bestMove ? `best move ${before.bestMove}` : '',
    ].filter(Boolean).join(', '),
    source: 'stockfish',
    centipawnLoss: Math.round(centipawnLoss),
    bestMove: before.bestMove,
    beforeCentipawns: Math.round(before.centipawns),
    afterCentipawns: Math.round(playedPositionForMover),
    advantageSwing: Math.round(advantageSwing),
    depth,
    pv: before.pv,
  };
}

export async function evaluatePositionWithStockfish(fen: string): Promise<EnginePositionEvaluation> {
  const value = await stockfishEngine().evaluateFen(fen);
  return {
    centipawns: Math.round(value.whiteCentipawns),
    bestMove: value.bestMove,
    depth: value.depth,
    pv: value.pv,
    mate: value.mate,
  };
}

export async function shutdownStockfish() {
  await engine?.dispose();
  engine = null;
}

function stockfishEngine() {
  engine ??= new StockfishEngine();
  return engine;
}

type Waiter = {
  predicate: (line: string) => boolean;
  resolve: (line: string) => void;
  reject: (error: Error) => void;
};

class StockfishEngine {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private starting: Promise<void> | null = null;
  private queue = Promise.resolve();
  private waiters: Waiter[] = [];
  private lineListeners = new Set<(line: string) => void>();
  private disposed = false;

  evaluateFen(fen: string): Promise<EngineEval> {
    const job = this.queue.then(() => this.evaluateFenNow(fen));
    this.queue = job.then(() => undefined, () => undefined);
    return job;
  }

  async dispose() {
    this.disposed = true;
    await this.queue.catch(() => undefined);
    if (this.child) {
      try {
        this.child.stdin.write('quit\n');
      } catch {
        // The process may already be gone after a spawn or timeout failure.
      }
      this.child.kill();
    }
    this.child = null;
  }

  private async evaluateFenNow(fen: string): Promise<EngineEval> {
    await this.ensureReady();
    const child = this.requireChild();
    let latestScore = 0;
    let latestMate: number | undefined;
    let bestMove: string | undefined;
    let depth: number | undefined;
    let pv: string[] | undefined;
    const listener = (line: string) => {
      const parsed = parseInfoLine(line);
      if (parsed) {
        latestScore = parsed.centipawns;
        latestMate = parsed.mate;
        depth = parsed.depth ?? depth;
        pv = parsed.pv ?? pv;
      }
      const best = line.match(/^bestmove\s+(\S+)/);
      if (best) bestMove = best[1] === '(none)' ? undefined : best[1];
    };
    this.lineListeners.add(listener);
    try {
      child.stdin.write(`position fen ${fen}\n`);
      child.stdin.write(config.stockfishMovetimeMs > 0
        ? `go movetime ${config.stockfishMovetimeMs}\n`
        : `go depth ${config.stockfishDepth}\n`);
      await this.waitFor((line) => line.startsWith('bestmove '), `Stockfish evaluation timed out for ${fen}`);
      const sideToMove = fen.split(/\s+/)[1] === 'b' ? 'b' : 'w';
      return {
        centipawns: latestScore,
        whiteCentipawns: sideToMove === 'w' ? latestScore : -latestScore,
        bestMove,
        depth,
        pv,
        mate: latestMate,
      };
    } finally {
      this.lineListeners.delete(listener);
    }
  }

  private async ensureReady() {
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = this.start();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async start() {
    this.disposed = false;
    try {
      this.child = spawn(config.stockfishPath, [], { stdio: 'pipe' });
    } catch (error) {
      throw stockfishError(error);
    }
    const child = this.child;
    child.stdout.on('data', (chunk: Buffer) => this.handleOutput(chunk.toString('utf8')));
    child.stderr.on('data', () => undefined);
    child.on('error', (error) => {
      this.child = null;
      this.failAll(stockfishError(error));
    });
    child.on('exit', (code, signal) => {
      if (this.disposed) return;
      this.child = null;
      this.failAll(new Error(`Stockfish exited unexpectedly (${signal ?? code ?? 'unknown'}).`));
    });
    child.stdin.write('uci\n');
    await this.waitFor((line) => line === 'uciok', 'Stockfish did not complete UCI initialization.');
    child.stdin.write('isready\n');
    await this.waitFor((line) => line === 'readyok', 'Stockfish did not become ready.');
    child.stdin.write('ucinewgame\n');
  }

  private waitFor(predicate: (line: string) => boolean, timeoutMessage: string) {
    return new Promise<string>((resolve, reject) => {
      const waiter: Waiter = { predicate, resolve, reject };
      this.waiters.push(waiter);
      const timeout = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        this.restartAfterFailure();
        reject(new Error(timeoutMessage));
      }, config.stockfishTimeoutMs);
      const finish = (line: string) => {
        clearTimeout(timeout);
        resolve(line);
      };
      waiter.resolve = finish;
    });
  }

  private handleOutput(chunk: string) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) this.handleLine(line.trim());
  }

  private handleLine(line: string) {
    if (!line) return;
    for (const listener of this.lineListeners) listener(line);
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index];
      if (waiter.predicate(line)) {
        this.waiters.splice(index, 1);
        waiter.resolve(line);
      }
    }
  }

  private requireChild() {
    if (!this.child) throw new Error('Stockfish is not running.');
    return this.child;
  }

  private failAll(error: Error) {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }

  private restartAfterFailure() {
    if (!this.child) return;
    try {
      this.child.kill();
    } catch {
      // Best effort cleanup. The next evaluation will spawn a fresh engine.
    }
    this.child = null;
  }
}

function parseInfoLine(line: string) {
  if (!line.startsWith('info ')) return null;
  const score = line.match(/\bscore\s+(cp|mate)\s+(-?\d+)/);
  if (!score) return null;
  const depth = Number(line.match(/\bdepth\s+(\d+)/)?.[1] ?? NaN);
  const mate = score[1] === 'mate' ? Number(score[2]) : undefined;
  const centipawns = score[1] === 'mate'
    ? mateScoreToCentipawns(Number(score[2]))
    : Number(score[2]);
  const pv = line.match(/\bpv\s+(.+)$/)?.[1]?.trim().split(/\s+/);
  return {
    centipawns,
    mate,
    depth: Number.isFinite(depth) ? depth : undefined,
    pv,
  };
}

function mateScoreToCentipawns(mate: number) {
  return mate > 0 ? 100_000 - mate : -100_000 - mate;
}

function stockfishError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const detail = config.stockfishRequired
    ? 'Stockfish is required for lvl chess scoring.'
    : 'Stockfish failed; heuristic scoring is disabled for new matches.';
  return new Error(`${detail} Configure STOCKFISH_PATH or install a stockfish binary. Original error: ${message}`);
}

function labelFromCentipawnLoss(loss: number) {
  if (loss <= 20) return 'excellent';
  if (loss <= 60) return 'good';
  if (loss <= 120) return 'inaccuracy';
  if (loss <= 250) return 'mistake';
  return 'blunder';
}

function scoreFromCentipawnLoss(loss: number) {
  return Math.max(0, Math.min(100, Math.round(100 - loss / 4)));
}

function formatCp(value: number) {
  return `${value >= 0 ? '+' : ''}${Math.round(value)}cp`;
}
