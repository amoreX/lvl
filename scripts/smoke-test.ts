import fs from 'node:fs/promises';
import { MatchOrchestrator } from '../src/server/orchestrator.js';
import { JsonStore } from '../src/server/storage.js';

const store = new JsonStore();
const orchestrator = new MatchOrchestrator(store);

async function main() {
  await fs.rm('./data/lvl-state.json', { force: true });
  await fs.rm('./artifacts', { recursive: true, force: true });
  await store.load();

  const match = await orchestrator.createMatch({
    name: 'Smoke: target grid duel',
    taskId: 'target-grid-duel',
    agentA: { modelId: 'dummy-strong', harnessId: 'ghost-barebones' },
    agentB: { modelId: 'dummy-chaotic', harnessId: 'ghost-barebones' },
    seed: 818,
    runMode: 'parallel',
    hurdlesEnabled: true,
    maxSteps: 10,
    maxToolCalls: 30,
  });

  const detail = await waitForMatch(match.id);
  const runs = detail.runs;
  const strong = runs.find((run) => run.modelId === 'dummy-strong');
  const chaotic = runs.find((run) => run.modelId === 'dummy-chaotic');

  if (!strong?.scorecard || !chaotic?.scorecard) {
    throw new Error('Smoke test failed: missing scorecards.');
  }
  if (strong.scorecard.total <= chaotic.scorecard.total) {
    throw new Error(`Smoke test failed: expected strong score > chaotic score, got ${strong.scorecard.total} <= ${chaotic.scorecard.total}.`);
  }
  if (!strong.steps.length || !chaotic.steps.length) {
    throw new Error('Smoke test failed: traces were not recorded.');
  }

  console.log('Smoke test passed');
  console.log(`Match: ${detail.match.id}`);
  console.log(`Strong score: ${strong.scorecard.total}`);
  console.log(`Chaotic score: ${chaotic.scorecard.total}`);
  console.log(`Winner: ${detail.match.winnerRunId}`);
}

async function waitForMatch(matchId: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const detail = await store.matchDetail(matchId);
    if (detail && ['completed', 'failed', 'cancelled'].includes(detail.match.status)) {
      if (detail.match.status !== 'completed') {
        throw new Error(`Match finished with status ${detail.match.status}: ${detail.match.error ?? 'no error'}`);
      }
      return detail;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for smoke match.');
}

await main();
