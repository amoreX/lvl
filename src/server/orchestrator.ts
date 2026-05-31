import { randomUUID } from 'node:crypto';
import type { CreateMatchInput, MatchRecord, RunRecord, TaskConfig, TraceStep } from '../shared/types.js';
import { ChromiumGameEnvironment } from './chromiumEnvironment.js';
import { config } from './config.js';
import { BarebonesHarness } from './harness.js';
import { scoreRun } from './scoring.js';
import type { JsonStore } from './storage.js';

type Job = () => Promise<void>;

export class MatchOrchestrator {
  private queue: Job[] = [];
  private active = 0;
  private cancelled = new Set<string>();

  constructor(private readonly store: JsonStore) {}

  async createMatch(input: CreateMatchInput) {
    const state = await this.store.all();
    const task = state.tasks.find((item) => item.id === input.taskId);
    if (!task) throw new Error(`Unknown task ${input.taskId}`);
    const harnessA = state.harnesses.find((item) => item.id === input.agentA.harnessId);
    const harnessB = state.harnesses.find((item) => item.id === input.agentB.harnessId);
    const modelA = state.models.find((item) => item.id === input.agentA.modelId);
    const modelB = state.models.find((item) => item.id === input.agentB.modelId);
    if (!harnessA || !harnessB || !modelA || !modelB) throw new Error('Invalid model or harness selection.');

    const now = new Date().toISOString();
    const matchId = randomUUID();
    const seed = input.seed || Math.floor(Math.random() * 1_000_000);
    const runs: RunRecord[] = [
      this.makeRun(matchId, 'agentA', input.agentA.modelId, input.agentA.harnessId, task, seed, now),
      this.makeRun(matchId, 'agentB', input.agentB.modelId, input.agentB.harnessId, task, seed, now),
    ];
    const match: MatchRecord = {
      id: matchId,
      name: input.name || `${modelA.name} vs ${modelB.name}`,
      taskId: task.id,
      seed,
      runMode: input.runMode,
      status: 'queued',
      maxSteps: input.maxSteps || task.maxSteps || config.defaultMaxSteps,
      maxToolCalls: input.maxToolCalls || task.maxToolCalls || config.defaultMaxToolCalls,
      hurdlesEnabled: input.hurdlesEnabled,
      runIds: runs.map((run) => run.id),
      winnerRunId: null,
      createdAt: now,
    };
    await this.store.insertMatch(match, runs);
    this.enqueueMatch(match.id);
    return match;
  }

  async cancelMatch(matchId: string) {
    this.cancelled.add(matchId);
    const match = await this.store.getMatch(matchId);
    if (!match) return null;
    await this.store.updateMatch(matchId, { status: 'cancelled', endedAt: new Date().toISOString() });
    for (const runId of match.runIds) {
      const run = await this.store.getRun(runId);
      if (run && !['completed', 'failed', 'cancelled'].includes(run.status)) {
        await this.store.updateRun(runId, { status: 'cancelled', endedAt: new Date().toISOString() });
      }
    }
    return this.store.matchDetail(matchId);
  }

  enqueueMatch(matchId: string) {
    this.queue.push(async () => this.runMatch(matchId));
    this.pump();
  }

  private pump() {
    while (this.active < config.workerConcurrency && this.queue.length) {
      const job = this.queue.shift();
      if (!job) return;
      this.active += 1;
      void job()
        .catch(() => undefined)
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }

  private async runMatch(matchId: string) {
    const detail = await this.store.matchDetail(matchId);
    if (!detail || this.cancelled.has(matchId)) return;
    await this.store.updateMatch(matchId, { status: 'running', startedAt: new Date().toISOString() });
    try {
      if (detail.match.runMode === 'parallel') {
        await Promise.all(detail.runs.map((run) => this.runOne(run.id)));
      } else {
        for (const run of detail.runs) {
          if (this.cancelled.has(matchId)) break;
          await this.runOne(run.id);
        }
      }
      await this.finishMatch(matchId);
    } catch (error) {
      await this.store.updateMatch(matchId, {
        status: 'failed',
        endedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async runOne(runId: string) {
    const state = await this.store.all();
    const run = state.runs.find((item) => item.id === runId);
    if (!run) throw new Error(`Run not found ${runId}`);
    const match = state.matches.find((item) => item.id === run.matchId);
    const task = state.tasks.find((item) => item.id === run.taskId);
    const model = state.models.find((item) => item.id === run.modelId);
    const harnessConfig = state.harnesses.find((item) => item.id === run.harnessId);
    if (!match || !task || !model || !harnessConfig) throw new Error('Run dependencies missing.');
    if (this.cancelled.has(match.id)) return;

    const env = new ChromiumGameEnvironment(task, run.seed, match.hurdlesEnabled);
    const harness = new BarebonesHarness(harnessConfig, model);
    let observation = await env.reset();
    let currentRun = run;
    const runStarted = Date.now();

    await this.store.updateRun(runId, { status: 'running', startedAt: new Date().toISOString() });

    try {
      for (let stepIndex = 0; stepIndex < match.maxSteps; stepIndex += 1) {
      if (this.cancelled.has(match.id)) {
        await this.store.updateRun(runId, { status: 'cancelled', endedAt: new Date().toISOString() });
        return;
      }
      await this.store.updateRun(runId, { status: 'waiting_for_model' });
      const modelOutput = await harness.runStep({
        runId,
        seed: run.seed,
        stepIndex,
        observation,
        maxToolCalls: match.maxToolCalls,
        timeoutMs: config.defaultTimeoutMs,
      });
      await this.store.updateRun(runId, {
        status: 'executing_tool',
        latencyMs: currentRun.latencyMs + modelOutput.latencyMs,
        costUsd: currentRun.costUsd + modelOutput.costUsd,
      });

      const result = await env.executeBrowserTool(modelOutput.browserTool!, runId, stepIndex);
      const step: TraceStep = {
        id: randomUUID(),
        runId,
        stepIndex,
        observation,
        modelOutput,
        toolCall: result.toolCall,
        scoreEvents: result.scoreEvents,
        createdAt: new Date().toISOString(),
      };
      await this.store.addStep(step);
      currentRun = {
        ...currentRun,
        stepCount: stepIndex + 1,
        toolCallCount: currentRun.toolCallCount + result.toolCall.actions.length,
        latencyMs: currentRun.latencyMs + result.toolCall.latencyMs,
        costUsd: currentRun.costUsd + modelOutput.costUsd,
      };
      await this.store.updateRun(runId, {
        status: 'running',
        stepCount: currentRun.stepCount,
        toolCallCount: currentRun.toolCallCount,
        latencyMs: currentRun.latencyMs,
        costUsd: currentRun.costUsd,
      });
      observation = result.observation;
      if (result.done) break;
      await sleep(120);
      }
    } finally {
      await env.dispose();
    }

    await this.store.updateRun(runId, { status: 'scoring' });
    const steps = (await this.store.all()).steps.filter((step) => step.runId === runId);
    const latestRun = await this.store.getRun(runId);
    const scorecard = scoreRun(latestRun ?? currentRun, task, steps);
    await this.store.updateRun(runId, {
      status: 'completed',
      endedAt: new Date().toISOString(),
      latencyMs: Date.now() - runStarted,
      scorecard,
      failureLabels: scorecard.failureLabels,
      costUsd: scorecard.costUsd,
    });
  }

  private async finishMatch(matchId: string) {
    const detail = await this.store.matchDetail(matchId);
    if (!detail) return;
    const completed = detail.runs.filter((run) => run.status === 'completed' && run.scorecard);
    const winner = completed
      .slice()
      .sort((a, b) => (b.scorecard?.total ?? 0) - (a.scorecard?.total ?? 0))[0];
    await this.store.updateMatch(matchId, {
      status: this.cancelled.has(matchId) ? 'cancelled' : 'completed',
      endedAt: new Date().toISOString(),
      winnerRunId: winner?.id ?? null,
    });
  }

  private makeRun(
    matchId: string,
    role: RunRecord['role'],
    modelId: string,
    harnessId: string,
    task: TaskConfig,
    seed: number,
    now: string,
  ): RunRecord {
    return {
      id: randomUUID(),
      matchId,
      role,
      modelId,
      harnessId,
      taskId: task.id,
      seed,
      status: 'queued',
      stepCount: 0,
      toolCallCount: 0,
      costUsd: 0,
      latencyMs: 0,
      failureLabels: [],
      createdAt: now,
    };
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
