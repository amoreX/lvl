import fs from 'node:fs/promises';
import dotenv from 'dotenv';
import type { MatchDetail, RunRecord } from '../src/shared/types.js';
import { databaseFilePath, legacyStateFilePath } from '../src/server/config.js';
import { MatchOrchestrator } from '../src/server/orchestrator.js';
import { JsonStore } from '../src/server/storage.js';
import { shutdownStockfish } from '../src/server/stockfish.js';

dotenv.config({ path: '.env.local' });
dotenv.config();

type Standing = {
  modelId: string;
  played: number;
  matchPoints: number;
  elo: number;
  totalScore: number;
  qualityTotal: number;
  qualityRuns: number;
  cplTotal: number;
  cplRuns: number;
  illegalMoves: number;
  costUsd: number;
};

const models = (process.env.TOURNAMENT_MODELS || 'openrouter-gpt-4o-mini,openrouter-gemini-flash,openrouter-qwen-9b')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
const rounds = Number(process.env.TOURNAMENT_ROUNDS || 1);
const maxPlies = Number(process.env.TOURNAMENT_MAX_PLIES || 24);
const maxCostUsdPerRun = Number(process.env.TOURNAMENT_MAX_COST_USD_PER_RUN || 0);
const waitMs = Number(process.env.TOURNAMENT_WAIT_MS || Math.max(300_000, maxPlies * rounds * models.length * 20_000));

const store = new JsonStore();
const orchestrator = new MatchOrchestrator(store);

async function main() {
  if (models.length < 2) throw new Error('TOURNAMENT_MODELS must contain at least two model IDs.');
  if (process.env.TOURNAMENT_RESET_STATE === 'true') {
    await fs.rm(databaseFilePath(), { force: true });
    await fs.rm(legacyStateFilePath(), { force: true });
  }
  await store.load();

  const matchIds: string[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    for (const [modelA, modelB] of pairModels(models)) {
      const match = await orchestrator.createMatch({
        name: `Tournament R${round}: ${modelA} vs ${modelB}`,
        taskId: 'chess-full-match',
        agentA: { modelId: modelA, harnessId: 'ghost-barebones' },
        agentB: { modelId: modelB, harnessId: 'ghost-barebones' },
        memoryMode: process.env.TOURNAMENT_MEMORY_MODE === 'context_dump' ? 'context_dump' : 'fresh',
        runMode: 'sequential',
        maxSteps: maxPlies,
        maxToolCalls: maxPlies * 6,
        maxCostUsdPerRun: maxCostUsdPerRun > 0 ? maxCostUsdPerRun : undefined,
      });
      matchIds.push(match.id);
    }
  }

  const details = await waitForMatches(matchIds);
  printTournament(details);
}

async function waitForMatches(matchIds: string[]) {
  const pending = new Set(matchIds);
  const details = new Map<string, MatchDetail>();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && pending.size) {
    for (const matchId of [...pending]) {
      const detail = await store.matchDetail(matchId);
      if (!detail || !['completed', 'failed', 'cancelled'].includes(detail.match.status)) continue;
      details.set(matchId, detail);
      pending.delete(matchId);
      console.log(`${detail.match.status.toUpperCase()} ${detail.match.name}`);
    }
    await sleep(1000);
  }
  if (pending.size) {
    throw new Error(`Timed out waiting for ${pending.size} tournament matches: ${[...pending].join(', ')}`);
  }
  return matchIds.map((id) => details.get(id)).filter(Boolean) as MatchDetail[];
}

function printTournament(details: MatchDetail[]) {
  const standings = new Map(models.map((modelId) => [modelId, emptyStanding(modelId)]));
  for (const detail of details.filter((item) => item.match.status === 'completed')) {
    const byModel = pairedPointsByModel(detail.runs);
    const entries = [...byModel.entries()];
    if (entries.length !== 2) continue;
    const [[modelA, pointsA], [modelB, pointsB]] = entries;
    const standingA = standings.get(modelA) ?? emptyStanding(modelA);
    const standingB = standings.get(modelB) ?? emptyStanding(modelB);
    standings.set(modelA, standingA);
    standings.set(modelB, standingB);
    const scoreA = pointsA > pointsB ? 1 : pointsA === pointsB ? 0.5 : 0;
    updateElo(standingA, standingB, scoreA);
    standingA.played += 1;
    standingB.played += 1;
    standingA.matchPoints += pointsA;
    standingB.matchPoints += pointsB;
    for (const run of detail.runs) {
      const standing = standings.get(run.modelId) ?? emptyStanding(run.modelId);
      standings.set(run.modelId, standing);
      accumulateRun(standing, run);
    }
  }

  const rows = [...standings.values()].sort((a, b) => b.elo - a.elo || b.matchPoints - a.matchPoints);
  console.log('\nTournament leaderboard');
  console.log('model, played, points, elo, avgScore, avgQuality, avgCPL, illegal, cost');
  for (const row of rows) {
    console.log([
      row.modelId,
      row.played,
      row.matchPoints,
      Math.round(row.elo),
      avg(row.totalScore, row.qualityRuns),
      avg(row.qualityTotal, row.qualityRuns),
      row.cplRuns ? avg(row.cplTotal, row.cplRuns) : '-',
      row.illegalMoves,
      `$${row.costUsd.toFixed(4)}`,
    ].join(', '));
  }
}

function accumulateRun(standing: Standing, run: RunRecord) {
  standing.totalScore += run.scorecard?.total ?? 0;
  standing.qualityTotal += run.scorecard?.chessQuality ?? 0;
  standing.qualityRuns += 1;
  const cpl = run.scorecard?.chess?.averageCentipawnLoss;
  if (typeof cpl === 'number') {
    standing.cplTotal += cpl;
    standing.cplRuns += 1;
  }
  standing.illegalMoves += run.scorecard?.chess?.illegalMoves ?? 0;
  standing.costUsd += run.costUsd;
}

function pairedPointsByModel(runs: RunRecord[]) {
  const points = new Map<string, number>();
  for (const run of runs) {
    const runPoints = run.scorecard?.taskSuccess === 100 ? 1 : run.scorecard?.taskSuccess === 50 ? 0.5 : 0;
    points.set(run.modelId, (points.get(run.modelId) ?? 0) + runPoints);
  }
  return points;
}

function updateElo(a: Standing, b: Standing, scoreA: number) {
  const expectedA = 1 / (1 + 10 ** ((b.elo - a.elo) / 400));
  const expectedB = 1 - expectedA;
  const scoreB = 1 - scoreA;
  const k = 32;
  a.elo += k * (scoreA - expectedA);
  b.elo += k * (scoreB - expectedB);
}

function emptyStanding(modelId: string): Standing {
  return {
    modelId,
    played: 0,
    matchPoints: 0,
    elo: 1000,
    totalScore: 0,
    qualityTotal: 0,
    qualityRuns: 0,
    cplTotal: 0,
    cplRuns: 0,
    illegalMoves: 0,
    costUsd: 0,
  };
}

function pairModels(modelIds: string[]) {
  const pairs: Array<[string, string]> = [];
  for (let a = 0; a < modelIds.length; a += 1) {
    for (let b = a + 1; b < modelIds.length; b += 1) {
      pairs.push([modelIds[a], modelIds[b]]);
    }
  }
  return pairs;
}

function avg(total: number, count: number) {
  return count ? (total / count).toFixed(1) : '-';
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  await main();
} finally {
  await shutdownStockfish();
  await store.close();
}
