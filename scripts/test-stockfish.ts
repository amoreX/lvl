import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { evaluateMoveWithStockfish, evaluatePositionWithStockfish, shutdownStockfish } from '../src/server/stockfish.js';

async function main() {
  const chess = new Chess();
  const beforeFen = chess.fen();
  const move = chess.move('e4');
  assert.ok(move);

  const startEval = await evaluatePositionWithStockfish(beforeFen);
  assert.equal(typeof startEval.centipawns, 'number');
  assert.ok(startEval.bestMove || startEval.depth);

  const quality = await evaluateMoveWithStockfish(beforeFen, chess.fen());
  assert.equal(quality.source, 'stockfish');
  assert.equal(typeof quality.score, 'number');
  assert.equal(typeof quality.centipawnLoss, 'number');

  console.log([
    'Stockfish smoke test passed',
    `start=${startEval.centipawns}cp`,
    `best=${startEval.bestMove ?? 'unknown'}`,
    `e4 score=${quality.score}/100`,
    `CPL=${quality.centipawnLoss}`,
  ].join(' · '));
}

try {
  await main();
} finally {
  await shutdownStockfish();
}
