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

  const seeds = [810, 811, 812, 813, 814];
  const results: MatchDetail[] = [];
  for (const seed of seeds) {
    const match = await orchestrator.createMatch({
      name: `Multi-seed smoke · seed ${seed}`,
      taskId: 'target-grid-duel',
      agentA: { modelId: 'dummy-strong', harnessId: 'ghost-barebones' },
      agentB: { modelId: 'dummy-chaotic', harnessId: 'ghost-barebones' },
      seed,
      runMode: 'parallel',
      hurdlesEnabled: true,
      maxSteps: 10,
      maxToolCalls: 30,
    });
    results.push(await waitForMatch(match.id));
  }

  const wins: Record<string, number> = {};
  for (const detail of results) {
    const winner = detail.runs.find((run) => run.id === detail.match.winnerRunId);
    const name = winner?.model?.name ?? winner?.modelId ?? 'unknown';
    wins[name] = (wins[name] ?? 0) + 1;
    console.log(`${detail.match.name}: ${name} won`);
  }
  console.log('\nSuite summary');
  for (const [name, count] of Object.entries(wins)) console.log(`${name}: ${count}/${results.length}`);
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

await main();
