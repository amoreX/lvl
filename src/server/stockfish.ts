import { spawn } from 'node:child_process';
import { config } from './config.js';

type EngineEval = {
  centipawns: number;
  bestMove?: string;
};

export type EngineMoveQuality = {
  score: number;
  label: string;
  reason: string;
  source: 'stockfish';
  centipawnLoss: number;
};

let stockfishUnavailable = false;

export async function evaluateMoveWithStockfish(beforeFen: string, afterFen: string): Promise<EngineMoveQuality | null> {
  if (stockfishUnavailable) return null;
  try {
    const before = await evaluateFen(beforeFen);
    const after = await evaluateFen(afterFen);
    if (!before || !after) return null;
    const playedPositionForMover = -after.centipawns;
    const centipawnLoss = Math.max(0, before.centipawns - playedPositionForMover);
    const score = scoreFromCentipawnLoss(centipawnLoss);
    return {
      score,
      label: labelFromCentipawnLoss(centipawnLoss),
      reason: `Stockfish depth ${config.stockfishDepth}, centipawn loss ${Math.round(centipawnLoss)}${before.bestMove ? `, best move ${before.bestMove}` : ''}`,
      source: 'stockfish',
      centipawnLoss: Math.round(centipawnLoss),
    };
  } catch {
    stockfishUnavailable = true;
    return null;
  }
}

function evaluateFen(fen: string): Promise<EngineEval | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.stockfishPath, [], { stdio: 'pipe' });
    let buffer = '';
    let latestScore = 0;
    let bestMove: string | undefined;
    const waiters: Array<{ predicate: (line: string) => boolean; resolve: () => void }> = [];
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Stockfish evaluation timed out.'));
    }, config.stockfishTimeoutMs);

    function waitFor(predicate: (line: string) => boolean) {
      return new Promise<void>((lineResolve) => waiters.push({ predicate, resolve: lineResolve }));
    }

    function handleLine(line: string) {
      const score = line.match(/\bscore\s+(cp|mate)\s+(-?\d+)/);
      if (score) {
        latestScore = score[1] === 'mate'
          ? (Number(score[2]) > 0 ? 100_000 - Number(score[2]) : -100_000 - Number(score[2]))
          : Number(score[2]);
      }
      const best = line.match(/^bestmove\s+(\S+)/);
      if (best) bestMove = best[1];
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        if (waiters[index].predicate(line)) {
          const waiter = waiters.splice(index, 1)[0];
          waiter.resolve();
        }
      }
    }

    child.on('error', reject);
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line.trim());
    });

    void (async () => {
      child.stdin.write('uci\n');
      await waitFor((line) => line === 'uciok');
      child.stdin.write('isready\n');
      await waitFor((line) => line === 'readyok');
      child.stdin.write(`position fen ${fen}\n`);
      child.stdin.write(`go depth ${config.stockfishDepth}\n`);
      await waitFor((line) => line.startsWith('bestmove '));
      clearTimeout(timeout);
      child.stdin.write('quit\n');
      resolve({ centipawns: latestScore, bestMove });
    })().catch((error) => {
      clearTimeout(timeout);
      child.kill();
      reject(error);
    });
  });
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
