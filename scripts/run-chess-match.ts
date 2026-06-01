import fs from 'node:fs/promises';
import dotenv from 'dotenv';
import type { MatchDetail } from '../src/shared/types.js';
import { MatchOrchestrator } from '../src/server/orchestrator.js';
import { databaseFilePath, legacyStateFilePath } from '../src/server/config.js';
import { JsonStore } from '../src/server/storage.js';

dotenv.config({ path: '.env.local' });
dotenv.config();

const store = new JsonStore();
const orchestrator = new MatchOrchestrator(store);

const whiteModel = process.env.CHESS_WHITE_MODEL || 'openrouter-gpt-4o-mini';
const blackModel = process.env.CHESS_BLACK_MODEL || 'openrouter-qwen-9b';
const maxPlies = Number(process.env.CHESS_MAX_PLIES || 16);

async function main() {
  if (process.env.CHESS_RESET_STATE === 'true') {
    await fs.rm(databaseFilePath(), { force: true });
    await fs.rm(legacyStateFilePath(), { force: true });
  }
  if (process.env.CHESS_RESET_ARTIFACTS === 'true') {
    await fs.rm('./artifacts', { recursive: true, force: true });
  }
  await store.load();

  const match = await orchestrator.createMatch({
    name: `Chess full match: ${whiteModel} vs ${blackModel}`,
    taskId: 'chess-full-match',
    agentA: { modelId: whiteModel, harnessId: 'ghost-barebones' },
    agentB: { modelId: blackModel, harnessId: 'ghost-barebones' },
    runMode: 'sequential',
    maxSteps: maxPlies,
    maxToolCalls: maxPlies * 6,
  });

  const detail = await waitForMatch(match.id);
  printResult(detail);
}

async function waitForMatch(matchId: string) {
  const waitMs = Number(process.env.CHESS_WAIT_MS || Math.max(240_000, maxPlies * 20_000));
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const detail = await store.matchDetail(matchId);
    if (detail && ['completed', 'failed', 'cancelled'].includes(detail.match.status)) {
      if (detail.match.status !== 'completed') {
        throw new Error(`${detail.match.name} finished with status ${detail.match.status}: ${detail.match.error ?? 'no error'}`);
      }
      return detail;
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new Error(`Timed out waiting for ${matchId}`);
}

function printResult(detail: MatchDetail) {
  console.log(`\n${detail.match.name}`);
  for (const run of detail.runs) {
    const winner = detail.match.winnerRunId === run.id ? 'WIN ' : '    ';
    const score = run.scorecard?.total ?? 0;
    const success = run.scorecard?.taskSuccess ?? 0;
    const labels = run.failureLabels.length ? run.failureLabels.join('|') : 'none';
    const moves = run.steps
      .flatMap((step) => step.scoreEvents)
      .filter((event) => event.reason.startsWith('Legal move played:'))
      .map((event) => event.reason.replace('Legal move played: ', '').replace('.', ''));
    console.log(`${winner}Game ${run.gameIndex} ${run.color === 'w' ? 'White' : 'Black'} ${run.model?.name ?? run.modelId}: score ${score}, success ${success}, quality ${run.scorecard?.chessQuality ?? 0}, moves [${moves.join(', ')}], steps ${run.stepCount}, cost $${run.costUsd.toFixed(4)}, labels ${labels}`);
  }
}

await main();
