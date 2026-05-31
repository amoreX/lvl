import fs from 'node:fs/promises';
import dotenv from 'dotenv';
import type { MatchDetail } from '../src/shared/types.js';
import { MatchOrchestrator } from '../src/server/orchestrator.js';
import { JsonStore } from '../src/server/storage.js';

dotenv.config({ path: '.env.local' });
dotenv.config();

const store = new JsonStore();
const orchestrator = new MatchOrchestrator(store);

const suites = [
  {
    name: 'Grid: Sonnet 4.6 vs GPT-5.4',
    taskId: 'target-grid-duel',
    a: 'openrouter-sonnet-4-6',
    b: 'openrouter-gpt-5-4',
    seed: 946,
  },
  {
    name: 'Grid: Sonnet 4.6 vs Opus 4.6',
    taskId: 'target-grid-duel',
    a: 'openrouter-sonnet-4-6',
    b: 'openrouter-opus-4-6',
    seed: 947,
  },
  {
    name: 'Checkout: Sonnet 4.6 vs GPT-5.4',
    taskId: 'simple-checkout-popup',
    a: 'openrouter-sonnet-4-6',
    b: 'openrouter-gpt-5-4',
    seed: 948,
  },
  {
    name: 'Checkout: Sonnet 4.6 vs Opus 4.6',
    taskId: 'simple-checkout-popup',
    a: 'openrouter-sonnet-4-6',
    b: 'openrouter-opus-4-6',
    seed: 949,
  },
];

async function main() {
  await fs.rm('./data/lvl-state.json', { force: true });
  await fs.rm('./artifacts', { recursive: true, force: true });
  await store.load();

  const failures: Array<{ name: string; error: string }> = [];
  for (const suite of suites) {
    try {
      const match = await orchestrator.createMatch({
        name: suite.name,
        taskId: suite.taskId,
        agentA: { modelId: suite.a, harnessId: 'ghost-barebones' },
        agentB: { modelId: suite.b, harnessId: 'ghost-barebones' },
        seed: suite.seed,
        runMode: 'parallel',
        hurdlesEnabled: true,
        maxSteps: suite.taskId === 'target-grid-duel' ? 30 : 24,
        maxToolCalls: suite.taskId === 'target-grid-duel' ? 120 : 96,
      });
      printResult(await waitForMatch(match.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ name: suite.name, error: message });
      console.log(`\nFAIL ${suite.name}: ${message}`);
    }
  }

  const analytics = await store.analytics();
  console.log('\nPremium standings');
  for (const row of analytics.byModel.filter((model) => model.runs > 0).sort((a, b) => b.elo - a.elo)) {
    console.log(`${row.name}: Elo ${row.elo}, avg ${row.avgScore}, wins ${row.wins}/${row.runs}, cost $${row.avgCostUsd.toFixed(4)}`);
  }
  if (failures.length) {
    console.log('\nFailed suites');
    for (const failure of failures) console.log(`${failure.name}: ${failure.error}`);
  }
}

async function waitForMatch(matchId: string) {
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const detail = await store.matchDetail(matchId);
    if (detail && ['completed', 'failed', 'cancelled'].includes(detail.match.status)) {
      if (detail.match.status !== 'completed') {
        throw new Error(`${detail.match.name} finished with status ${detail.match.status}: ${detail.match.error ?? 'no error'}`);
      }
      return detail;
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
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
    console.log(`${winner}${run.model?.name ?? run.modelId}: score ${score}, success ${success}, steps ${run.stepCount}, tools ${run.toolCallCount}, cost $${run.costUsd.toFixed(4)}, labels ${labels}`);
  }
}

await main();
