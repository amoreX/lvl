import fs from 'node:fs/promises';
import dotenv from 'dotenv';
import type { MatchDetail } from '../src/shared/types.js';
import { MatchOrchestrator } from '../src/server/orchestrator.js';
import { JsonStore } from '../src/server/storage.js';

dotenv.config({ path: '.env.local' });
dotenv.config();

const store = new JsonStore();
const orchestrator = new MatchOrchestrator(store);

async function main() {
  await fs.rm('./data/lvl-state.json', { force: true });
  await fs.rm('./artifacts', { recursive: true, force: true });
  await store.load();

  const match = await orchestrator.createMatch({
    name: 'Chess verify: GPT-4o Mini vs Dummy Strong',
    taskId: 'chess-opening-e4',
    agentA: { modelId: 'openrouter-gpt-4o-mini', harnessId: 'ghost-barebones' },
    agentB: { modelId: 'dummy-strong', harnessId: 'ghost-barebones' },
    seed: 64,
    runMode: 'parallel',
    hurdlesEnabled: false,
    maxSteps: 6,
    maxToolCalls: 24,
  });

  const detail = await waitForMatch(match.id);
  printResult(detail);
}

async function waitForMatch(matchId: string) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const detail = await store.matchDetail(matchId);
    if (detail && ['completed', 'failed', 'cancelled'].includes(detail.match.status)) {
      if (detail.match.status !== 'completed') {
        throw new Error(`${detail.match.name} finished with status ${detail.match.status}: ${detail.match.error ?? 'no error'}`);
      }
      return detail;
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
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
    const moveEvent = run.steps
      .flatMap((step) => step.scoreEvents)
      .find((event) => event.reason.includes('e2e4'));
    const move = moveEvent ? 'e2e4' : 'none';
    console.log(`${winner}${run.model?.name ?? run.modelId}: score ${score}, success ${success}, steps ${run.stepCount}, tools ${run.toolCallCount}, move ${move}, cost $${run.costUsd.toFixed(4)}, labels ${labels}`);
  }
}

await main();
