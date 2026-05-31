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
    name: 'Grid: Dummy Strong vs Dummy Chaotic',
    taskId: 'target-grid-duel',
    a: 'dummy-strong',
    b: 'dummy-chaotic',
    seed: 818,
  },
  {
    name: 'Grid: GPT-4o Mini vs Dummy Strong',
    taskId: 'target-grid-duel',
    a: 'openrouter-gpt-4o-mini',
    b: 'dummy-strong',
    seed: 819,
  },
  {
    name: 'Grid: Qwen 3.5 9B vs Dummy Strong',
    taskId: 'target-grid-duel',
    a: 'openrouter-qwen-9b',
    b: 'dummy-strong',
    seed: 820,
  },
  {
    name: 'Checkout: GPT-4o Mini vs Qwen 3.5 9B',
    taskId: 'simple-checkout-popup',
    a: 'openrouter-gpt-4o-mini',
    b: 'openrouter-qwen-9b',
    seed: 821,
  },
];

async function main() {
  await fs.rm('./data/lvl-state.json', { force: true });
  await fs.rm('./artifacts', { recursive: true, force: true });
  await store.load();

  const state = await store.all();
  const available = new Set(state.models.filter((model) => model.enabled).map((model) => model.id));
  const runnable = suites.filter((suite) => available.has(suite.a) && available.has(suite.b));
  if (!runnable.length) throw new Error('No benchmark suites are runnable. Check model config and OPENROUTER_API_KEY.');

  const results: MatchDetail[] = [];
  const failures: Array<{ name: string; error: string }> = [];
  for (const suite of runnable) {
    try {
      const match = await orchestrator.createMatch({
        name: suite.name,
        taskId: suite.taskId,
        agentA: { modelId: suite.a, harnessId: 'ghost-barebones' },
        agentB: { modelId: suite.b, harnessId: 'ghost-barebones' },
        seed: suite.seed,
        runMode: 'parallel',
        hurdlesEnabled: true,
        maxSteps: suite.taskId === 'target-grid-duel' ? 10 : 8,
        maxToolCalls: suite.taskId === 'target-grid-duel' ? 30 : 24,
      });
      const detail = await waitForMatch(match.id);
      results.push(detail);
      printResult(detail);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ name: suite.name, error: message });
      console.log(`\nFAIL ${suite.name}: ${message}`);
    }
  }

  const analytics = await store.analytics();
  console.log('\nModel standings');
  for (const row of analytics.byModel.filter((model) => model.runs > 0).sort((a, b) => b.elo - a.elo)) {
    console.log(`${row.name}: Elo ${row.elo}, avg ${row.avgScore}, wins ${row.wins}/${row.runs}, cost $${row.avgCostUsd.toFixed(4)}`);
  }
  if (failures.length) {
    console.log('\nFailed suites');
    for (const failure of failures) console.log(`${failure.name}: ${failure.error}`);
  }
}

async function waitForMatch(matchId: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const detail = await store.matchDetail(matchId);
    if (detail && ['completed', 'failed', 'cancelled'].includes(detail.match.status)) {
      if (detail.match.status !== 'completed') {
        throw new Error(`${detail.match.name} finished with status ${detail.match.status}: ${detail.match.error ?? 'no error'}`);
      }
      return detail;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${matchId}`);
}

function printResult(detail: MatchDetail) {
  const rows = detail.runs.map((run) => {
    const score = run.scorecard?.total ?? 0;
    const success = run.scorecard?.taskSuccess ?? 0;
    const labels = run.failureLabels.length ? run.failureLabels.join('|') : 'none';
    return {
      role: run.role,
      model: run.model?.name ?? run.modelId,
      score,
      success,
      steps: run.stepCount,
      tools: run.toolCallCount,
      cost: run.costUsd,
      labels,
      winner: detail.match.winnerRunId === run.id,
    };
  });
  console.log(`\n${detail.match.name}`);
  for (const row of rows) {
    console.log(`${row.winner ? 'WIN ' : '    '}${row.model}: score ${row.score}, success ${row.success}, steps ${row.steps}, tools ${row.tools}, cost $${row.cost.toFixed(4)}, labels ${row.labels}`);
  }
}

await main();
