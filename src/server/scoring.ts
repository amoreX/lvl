import type { RunRecord, ScoreEvent, Scorecard, TaskConfig, TraceStep } from '../shared/types.js';

export function scoreRun(run: RunRecord, task: TaskConfig, steps: TraceStep[]): Scorecard {
  const events = steps.flatMap((step) => step.scoreEvents);
  const finalObservation = steps.at(-1)?.observation;
  const confirmed = events.some((event) => event.dimension === 'task_success' && event.delta > 0)
    || Boolean(finalObservation?.pageState.confirmed);
  const wrongClicks = events.filter((event) => event.reason.toLowerCase().includes('decoy') || event.reason.toLowerCase().includes('non-progress')).length;
  const popupStillOpen = Boolean(finalObservation?.pageState.popupOpen);
  const toolFailures = Number(finalObservation?.pageState.toolFailures || 0);

  const taskSuccess = confirmed ? 100 : 0;
  const efficiency = clamp(100 - (run.stepCount - 1) * 8 - run.toolCallCount * 2);
  const robustness = clamp(75 + sum(events, 'robustness') - (popupStillOpen ? 20 : 0));
  const progress = clamp((confirmed ? 100 : 0) + sum(events, 'progress'));
  const toolUseQuality = clamp(100 + sum(events, 'toolUseQuality') - wrongClicks * 8 - toolFailures * 12);
  const consistency = null;
  const total = round(
    taskSuccess * 0.35
    + efficiency * 0.20
    + robustness * 0.15
    + progress * 0.10
    + toolUseQuality * 0.10
    + (consistency ?? 75) * 0.10,
  );

  return {
    total,
    taskSuccess,
    efficiency,
    robustness,
    progress,
    toolUseQuality,
    consistency,
    costUsd: round(run.costUsd, 6),
    latencyMs: run.latencyMs,
    failureLabels: failureLabels({ confirmed, wrongClicks, popupStillOpen, toolFailures, steps, task }),
    rubricVersion: 'mvp-0.1.0',
  };
}

function sum(events: ScoreEvent[], dimension: ScoreEvent['dimension']) {
  return events
    .filter((event) => event.dimension === dimension)
    .reduce((total, event) => total + event.delta, 0);
}

function failureLabels(input: {
  confirmed: boolean;
  wrongClicks: number;
  popupStillOpen: boolean;
  toolFailures: number;
  steps: TraceStep[];
  task: TaskConfig;
}) {
  const labels = new Set<string>();
  if (!input.confirmed) labels.add('task_incomplete');
  if (input.wrongClicks >= 2) labels.add('wrong_target');
  if (input.popupStillOpen) labels.add('missed_popup');
  if (input.toolFailures > 0) labels.add('tool_error');
  if (input.steps.length >= input.task.maxSteps && !input.confirmed) labels.add('budget_exceeded');
  if (repeatedOutputs(input.steps)) labels.add('looping');
  return [...labels];
}

function repeatedOutputs(steps: TraceStep[]) {
  const outputs = steps.map((step) => step.modelOutput.rawText);
  return outputs.length >= 3 && new Set(outputs.slice(-3)).size === 1;
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, round(value)));
}

function round(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}
