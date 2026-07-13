import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AnalyticsSummary,
  AppState,
  HarnessConfig,
  MatchDetail,
  MatchRecord,
  ModelConfig,
  RunRecord,
  TaskConfig,
  TraceStep,
} from '../shared/types.js';
import { databaseFilePath, legacyStateFilePath } from './config.js';
import { loadLinkedHarnesses } from './harnessRegistry.js';
import { emptyState, seedHarnesses, seedModels, seedTasks } from './seeds.js';
import { loadLinkedTasks } from './taskRegistry.js';

export class JsonStore {
  private state: AppState | null = null;
  private db: DatabaseSync | null = null;
  private writeQueue = Promise.resolve();

  async load(): Promise<AppState> {
    if (this.state) return this.state;
    await this.open();
    const stored = this.readSqliteState();
    const linkedHarnesses = await loadLinkedHarnesses();
    const linkedTasks = await loadLinkedTasks();
    this.state = this.withSeeds(stored ?? await this.readLegacyJsonState() ?? emptyState(), linkedHarnesses, linkedTasks);
    await this.save();
    return this.state;
  }

  async save() {
    await this.open();
    this.writeQueue = this.writeQueue.then(async () => {
      this.writeSqliteState(this.state ?? emptyState());
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
    const byHarness = state.harnesses.map((harness) => {
      const runs = completedRuns.filter((run) => run.harnessId === harness.id);
      const failureLabels: Record<string, number> = {};
      for (const run of runs) {
        for (const label of run.failureLabels) {
          failureLabels[label] = (failureLabels[label] || 0) + 1;
        }
      }
      return {
        harnessId: harness.id,
        name: harness.name,
        runs: runs.length,
        wins: runs.filter((run) => run.scorecard?.taskSuccess === 100).length,
        avgScore: average(runs.map((run) => run.scorecard?.total ?? 0)),
        avgChessQuality: average(runs.map((run) => run.scorecard?.chessQuality ?? 0)),
        avgCostUsd: average(runs.map((run) => run.costUsd)),
        costEstimated: runs.some((run) => Boolean(run.costEstimated || run.scorecard?.costEstimated)),
        avgLatencyMs: average(runs.map((run) => run.latencyMs)),
        avgModelLatencyMs: average(runs.map((run) => run.modelLatencyMs ?? run.latencyMs)),
        avgWallClockMs: average(runs.map((run) => run.wallClockMs ?? run.scorecard?.wallClockMs ?? run.latencyMs)),
        illegalMoves: runs.reduce((total, run) => total + (run.scorecard?.chess?.illegalMoves ?? 0), 0),
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
      byHarness,
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

  async upsertModels(models: ModelConfig[]) {
    await this.mutate((state) => {
      const byId = new Map(state.models.map((model) => [model.id, model]));
      for (const model of models) {
        byId.set(model.id, { ...(byId.get(model.id) ?? {}), ...model });
      }
      state.models = [...byId.values()];
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

  async close() {
    await this.writeQueue;
    this.db?.close();
    this.db = null;
  }

  private withSeeds(state: AppState, linkedHarnesses: HarnessConfig[] = [], linkedTasks: TaskConfig[] = []): AppState {
    const dynamicModels = (state.models ?? []).filter((model) => model.provider !== 'dummy');
    const linkedHarnessIds = new Set(linkedHarnesses.map((harness) => harness.id));
    const currentHarnesses = (state.harnesses ?? [])
      .filter((harness) => harness.adapter?.type !== 'module' || linkedHarnessIds.has(harness.id));
    const linkedTaskIds = new Set(linkedTasks.map((task) => task.id));
    const currentTasks = (state.tasks ?? [])
      .filter((task) => task.source?.type !== 'task_pack' || linkedTaskIds.has(task.id));
    return {
      models: mergeById(dynamicModels, seedModels),
      harnesses: mergeById(currentHarnesses, [...seedHarnesses, ...linkedHarnesses]),
      tasks: mergeById(currentTasks, [...seedTasks, ...linkedTasks]),
      matches: (state.matches ?? []).map((match) => ({
        ...match,
        memoryMode: match.memoryMode ?? 'fresh',
      })),
      runs: (state.runs ?? []).map((run) => ({
        ...run,
        gameIndex: run.gameIndex ?? 1,
        color: run.color ?? (run.role === 'agentA' ? 'w' : 'b'),
        modelLatencyMs: run.modelLatencyMs ?? run.latencyMs ?? 0,
      })),
      steps: state.steps ?? [],
    };
  }

  private async open() {
    if (this.db) return;
    const file = databaseFilePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      this.db = this.openDatabase(file);
    } catch (error) {
      if (!isNotDatabaseError(error)) throw error;
      this.db?.close();
      this.db = null;
      await quarantineInvalidDatabase(file);
      this.db = this.openDatabase(file);
    }
  }

  private openDatabase(file: string) {
    const db = new DatabaseSync(file);
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS harnesses (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS matches (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, match_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS steps (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_index INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_runs_match_id ON runs(match_id);
        CREATE INDEX IF NOT EXISTS idx_steps_run_id ON steps(run_id);
      `);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private readSqliteState(): AppState | null {
    const db = this.requireDb();
    const hasRows = ['models', 'harnesses', 'tasks', 'matches', 'runs', 'steps'].some((table) => {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      return row.count > 0;
    });
    if (!hasRows) return null;
    return {
      models: readTable(db, 'models'),
      harnesses: readTable(db, 'harnesses'),
      tasks: readTable(db, 'tasks'),
      matches: readTable(db, 'matches'),
      runs: readTable(db, 'runs'),
      steps: readTable(db, 'steps'),
    };
  }

  private writeSqliteState(state: AppState) {
    const db = this.requireDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of ['models', 'harnesses', 'tasks', 'matches', 'runs', 'steps']) {
        db.prepare(`DELETE FROM ${table}`).run();
      }
      writeTable(db, 'models', state.models);
      writeTable(db, 'harnesses', state.harnesses);
      writeTable(db, 'tasks', state.tasks);
      writeTable(db, 'matches', state.matches);
      writeTable(db, 'runs', state.runs, (run) => ({ match_id: run.matchId }));
      writeTable(db, 'steps', state.steps, (step) => ({ run_id: step.runId, step_index: step.stepIndex }));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  private async readLegacyJsonState(): Promise<AppState | null> {
    try {
      const raw = await fs.readFile(legacyStateFilePath(), 'utf8');
      return JSON.parse(raw) as AppState;
    } catch {
      return null;
    }
  }

  private requireDb() {
    if (!this.db) throw new Error('SQLite store is not open.');
    return this.db;
  }
}

function readTable<T>(db: DatabaseSync, table: string): T[] {
  return (db.prepare(`SELECT data FROM ${table}`).all() as Array<{ data: string }>).map((row) => JSON.parse(row.data) as T);
}

function writeTable<T extends { id: string }>(
  db: DatabaseSync,
  table: string,
  values: T[],
  extra?: (value: T) => Record<string, string | number>,
) {
  const columns = ['id', ...(values[0] && extra ? Object.keys(extra(values[0])) : []), 'data'];
  const placeholders = columns.map(() => '?').join(', ');
  const statement = db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`);
  for (const value of values) {
    const extraValues = extra ? Object.values(extra(value)) : [];
    statement.run(value.id, ...extraValues, JSON.stringify(value));
  }
}

function isNotDatabaseError(error: unknown) {
  return error instanceof Error && /file is not a database/i.test(error.message);
}

async function quarantineInvalidDatabase(file: string) {
  try {
    await fs.rename(file, `${file}.invalid-${Date.now()}`);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'ENOENT') throw error;
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
