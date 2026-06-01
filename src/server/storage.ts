import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AnalyticsSummary,
  AppState,
  MatchDetail,
  MatchRecord,
  RunRecord,
  TraceStep,
} from '../shared/types.js';
import { stateFilePath } from './config.js';
import { emptyState, seedHarnesses, seedModels, seedTasks } from './seeds.js';

export class JsonStore {
  private state: AppState | null = null;
  private writeQueue = Promise.resolve();

  async load(): Promise<AppState> {
    if (this.state) return this.state;
    const file = stateFilePath();
    try {
      const raw = await fs.readFile(file, 'utf8');
      this.state = this.withSeeds(JSON.parse(raw) as AppState);
    } catch {
      this.state = emptyState();
      await this.save();
    }
    return this.state;
  }

  async save() {
    const file = stateFilePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.writeFile(file, JSON.stringify(this.state ?? emptyState(), null, 2), 'utf8');
    });
    await this.writeQueue;
  }

  async mutate<T>(fn: (state: AppState) => T | Promise<T>): Promise<T> {
    const state = await this.load();
    const result = await fn(state);
    await this.save();
    return result;
  }

  async all() {
    return this.load();
  }

  async matchDetail(matchId: string): Promise<MatchDetail | null> {
    const state = await this.load();
    const match = state.matches.find((item) => item.id === matchId);
    if (!match) return null;
    const task = state.tasks.find((item) => item.id === match.taskId);
    if (!task) return null;
    const runs = state.runs
      .filter((run) => run.matchId === match.id)
      .map((run) => ({
        ...run,
        model: state.models.find((model) => model.id === run.modelId),
        harness: state.harnesses.find((harness) => harness.id === run.harnessId),
        steps: state.steps.filter((step) => step.runId === run.id).sort((a, b) => a.stepIndex - b.stepIndex),
      }));
    return { match, task, runs };
  }

  async analytics(): Promise<AnalyticsSummary> {
    const state = await this.load();
    const completedRuns = state.runs.filter((run) => run.status === 'completed' && run.scorecard);
    const elo = computeModelElo(state.matches, state.runs);
    const globalFailureLabels: Record<string, number> = {};
    for (const run of completedRuns) {
      for (const label of run.failureLabels) {
        globalFailureLabels[label] = (globalFailureLabels[label] || 0) + 1;
      }
    }
    const byModel = state.models.map((model) => {
      const runs = completedRuns.filter((run) => run.modelId === model.id);
      const wins = runs.filter((run) => {
        const match = state.matches.find((item) => item.id === run.matchId);
        return match?.winnerRunId === run.id;
      }).length;
      const failureLabels: Record<string, number> = {};
      for (const run of runs) {
        for (const label of run.failureLabels) {
          failureLabels[label] = (failureLabels[label] || 0) + 1;
        }
      }
      return {
        modelId: model.id,
        name: model.name,
        runs: runs.length,
        wins,
        avgScore: average(runs.map((run) => run.scorecard?.total ?? 0)),
        elo: Math.round(elo[model.id] ?? 1000),
        avgCostUsd: average(runs.map((run) => run.costUsd)),
        avgLatencyMs: average(runs.map((run) => run.latencyMs)),
        failureLabels,
      };
    });
    const byTask = state.tasks.map((task) => {
      const runs = completedRuns.filter((run) => run.taskId === task.id);
      return {
        taskId: task.id,
        title: task.title,
        runs: runs.length,
        avgScore: average(runs.map((run) => run.scorecard?.total ?? 0)),
        successRate: runs.length
          ? Number(((runs.filter((run) => (run.scorecard?.taskSuccess ?? 0) >= 100).length / runs.length) * 100).toFixed(1))
          : 0,
      };
    });
    const buckets = [
      { bucket: '0-25', min: 0, max: 25 },
      { bucket: '26-50', min: 26, max: 50 },
      { bucket: '51-75', min: 51, max: 75 },
      { bucket: '76-100', min: 76, max: 100 },
    ].map(({ bucket, min, max }) => ({
      bucket,
      runs: completedRuns.filter((run) => {
        const score = run.scorecard?.total ?? 0;
        return score >= min && score <= max;
      }).length,
    }));
    return {
      totals: {
        matches: state.matches.length,
        runs: state.runs.length,
        completedRuns: completedRuns.length,
        avgScore: average(completedRuns.map((run) => run.scorecard?.total ?? 0)),
        avgCostUsd: average(completedRuns.map((run) => run.costUsd)),
      },
      byModel,
      byTask,
      scoreDistribution: buckets,
      failureLabels: globalFailureLabels,
    };
  }

  async insertMatch(match: MatchRecord, runs: RunRecord[]) {
    await this.mutate((state) => {
      state.matches.unshift(match);
      state.runs.push(...runs);
    });
  }

  async updateMatch(matchId: string, patch: Partial<MatchRecord>) {
    await this.mutate((state) => {
      const match = state.matches.find((item) => item.id === matchId);
      if (match) Object.assign(match, patch);
    });
  }

  async updateRun(runId: string, patch: Partial<RunRecord>) {
    await this.mutate((state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (run) Object.assign(run, patch);
    });
  }

  async addStep(step: TraceStep) {
    await this.mutate((state) => {
      state.steps.push(step);
    });
  }

  async deleteMatch(matchId: string) {
    return this.mutate((state) => {
      const match = state.matches.find((item) => item.id === matchId);
      if (!match) return false;
      const runIds = new Set(state.runs.filter((run) => run.matchId === matchId).map((run) => run.id));
      state.matches = state.matches.filter((item) => item.id !== matchId);
      state.runs = state.runs.filter((run) => run.matchId !== matchId);
      state.steps = state.steps.filter((step) => !runIds.has(step.runId));
      return true;
    });
  }

  async getRun(runId: string) {
    const state = await this.load();
    return state.runs.find((run) => run.id === runId) ?? null;
  }

  async getMatch(matchId: string) {
    const state = await this.load();
    return state.matches.find((match) => match.id === matchId) ?? null;
  }

  private withSeeds(state: AppState): AppState {
    return {
      models: mergeById(state.models, seedModels),
      harnesses: mergeById(state.harnesses, seedHarnesses),
      tasks: seedTasks,
      matches: (state.matches ?? []).map((match) => ({
        ...match,
        memoryMode: match.memoryMode ?? 'fresh',
      })),
      runs: (state.runs ?? []).map((run) => ({
        ...run,
        gameIndex: run.gameIndex ?? 1,
        color: run.color ?? (run.role === 'agentA' ? 'w' : 'b'),
      })),
      steps: state.steps ?? [],
    };
  }
}

function mergeById<T extends { id: string }>(current: T[] = [], seeds: T[]) {
  const seedMap = new Map(seeds.map((seed) => [seed.id, seed]));
  const currentIds = new Set(current.map((item) => item.id));
  return [
    ...current.map((item) => ({ ...item, ...(seedMap.get(item.id) ?? {}) })),
    ...seeds.filter((seed) => !currentIds.has(seed.id)),
  ];
}

function average(values: number[]) {
  if (!values.length) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function computeModelElo(matches: MatchRecord[], runs: RunRecord[]) {
  const ratings: Record<string, number> = {};
  const byId = new Map(runs.map((run) => [run.id, run]));
  const chronological = matches
    .filter((match) => match.status === 'completed' && match.winnerRunId)
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const match of chronological) {
    const matchRuns = match.runIds.map((id) => byId.get(id)).filter(Boolean) as RunRecord[];
    if (matchRuns.length < 2 || !match.winnerRunId) continue;
    const winner = byId.get(match.winnerRunId);
    const loser = matchRuns.find((run) => run.role !== winner?.role);
    if (!winner || !loser) continue;
    ratings[winner.modelId] ??= 1000;
    ratings[loser.modelId] ??= 1000;
    const winnerExpected = expected(ratings[winner.modelId], ratings[loser.modelId]);
    const loserExpected = expected(ratings[loser.modelId], ratings[winner.modelId]);
    const k = 32;
    ratings[winner.modelId] += k * (1 - winnerExpected);
    ratings[loser.modelId] += k * (0 - loserExpected);
  }
  return ratings;
}

function expected(a: number, b: number) {
  return 1 / (1 + 10 ** ((b - a) / 400));
}
