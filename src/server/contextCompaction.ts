import type { TraceStep } from '../shared/types.js';
import { config } from './config.js';

const SYSTEM_TOKEN_ESTIMATE = 5_000;

type CompactionResult = {
  contextDump?: string;
  compacted: boolean;
  elapsedMs: number;
};

export class ContextCompactionTracker {
  private compactedSummary = '';
  private compactedThroughStep = -1;
  private lastCompactionAt = 0;
  private compactionCount = 0;

  prepare(steps: TraceStep[]): CompactionResult {
    const started = Date.now();
    if (!steps.length) {
      return {
        contextDump: 'No previous turns for this agent.',
        compacted: false,
        elapsedMs: Date.now() - started,
      };
    }

    const pendingSteps = steps.filter((step) => step.stepIndex > this.compactedThroughStep);
    const candidate = this.renderContext(pendingSteps);
    const estimatedTokens = estimateTokens(candidate);
    const threshold = compactionThreshold();
    const hardThreshold = Math.floor(threshold / Math.max(config.contextCompactionTriggerRatio, 0.01) * 0.90);
    const pastCooldown = Date.now() - this.lastCompactionAt >= config.contextCompactionCooldownMs;
    const shouldCompact = estimatedTokens >= threshold && (pastCooldown || estimatedTokens >= hardThreshold);

    if (shouldCompact) {
      this.compactionCount += 1;
      this.compactedSummary = summarizeSteps(steps, this.compactionCount);
      this.compactedThroughStep = Math.max(...steps.map((step) => step.stepIndex));
      this.lastCompactionAt = Date.now();
      return {
        contextDump: this.compactedSummary,
        compacted: true,
        elapsedMs: Date.now() - started,
      };
    }

    return {
      contextDump: candidate,
      compacted: false,
      elapsedMs: Date.now() - started,
    };
  }

  private renderContext(pendingSteps: TraceStep[]) {
    const sections = [];
    if (this.compactedSummary) sections.push(this.compactedSummary);
    if (pendingSteps.length) sections.push(pendingSteps.map(renderStep).join('\n\n---\n\n'));
    return sections.join('\n\n=== NEW TURNS SINCE COMPACTION ===\n\n');
  }
}

function compactionThreshold() {
  const usableWindow = config.contextWindowTokens - SYSTEM_TOKEN_ESTIMATE - config.modelMaxTokens;
  return Math.floor(Math.max(8_000, usableWindow) * config.contextCompactionTriggerRatio);
}

function summarizeSteps(steps: TraceStep[], compactionCount: number) {
  const lines = steps.map((step) => {
    const move = step.scoreEvents.find((event) => event.reason.startsWith('Legal move played:'))?.reason
      .replace('Legal move played: ', '')
      .replace(/\.$/, '');
    const proposed = step.scoreEvents.find((event) => event.reason.includes('Proposed chess move'))?.reason
      .replace('Proposed chess move ', '')
      .replace(/\.$/, '');
    const failures = step.scoreEvents
      .filter((event) => event.dimension === 'failure' || event.delta < 0)
      .map((event) => event.reason)
      .join(' | ');
    const action = step.toolCall?.actions.map((item) => item.action).join(', ') || 'state';
    return [
      `Turn ${step.stepIndex + 1}`,
      move ? `legal=${move}` : proposed ? `proposed=${proposed}` : 'move=none',
      failures ? `issues=${failures}` : 'issues=none',
      `actions=${action}`,
    ].join(' | ');
  });
  return [
    `Own prior-turn context compacted by harness (${compactionCount}).`,
    'This is a compaction summary of earlier turns. Trust the current board/legal moves over stale plans.',
    ...lines.slice(-80),
  ].join('\n');
}

function renderStep(step: TraceStep) {
  const toolInput = step.toolCall?.input.mode === 'run'
    ? step.toolCall.input.script
    : step.toolCall?.input.mode ?? 'none';
  const actions = step.toolCall?.actions.map((action) => `${action.action}:${action.successful ? 'ok' : action.error ?? 'failed'}`).join(', ') || 'none';
  const score = step.scoreEvents.map((event) => `${event.delta >= 0 ? '+' : ''}${event.delta} ${event.dimension}: ${event.reason}`).join(' | ') || 'none';
  const { screenshotDataUrl: _screenshotDataUrl, ...observation } = step.observation;
  return [
    `Turn ${step.stepIndex + 1}`,
    `Observation:\n${JSON.stringify(observation, null, 2)}`,
    `Model output:\n${step.modelOutput.rawText}`,
    `Tool input:\n${toolInput}`,
    `Tool actions: ${actions}`,
    `Score events: ${score}`,
  ].join('\n');
}

function estimateTokens(text: string) {
  return Math.ceil(text.length / 3);
}
