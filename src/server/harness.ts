import type { BrowserToolInput, HarnessConfig, ModelConfig, ModelInput, ModelOutput, Observation } from '../shared/types.js';
import { config } from './config.js';
import { adapterFor } from './modelAdapters.js';

export class BarebonesHarness {
  constructor(
    private readonly harness: HarnessConfig,
    private readonly model: ModelConfig,
  ) {}

  async runStep(input: {
    runId: string;
    seed: number;
    stepIndex: number;
    observation: Observation;
    maxToolCalls: number;
    timeoutMs: number;
    contextDump?: string;
    abortSignal?: AbortSignal;
  }): Promise<ModelOutput> {
    const modelInput: ModelInput = {
      system: this.systemPrompt(),
      observation: input.observation,
      contextDump: input.contextDump,
      abortSignal: input.abortSignal,
      budget: {
        maxTokens: config.modelMaxTokens,
        maxToolCalls: input.maxToolCalls,
        timeoutMs: input.timeoutMs,
      },
      metadata: {
        runId: input.runId,
        seed: input.seed,
        stepIndex: input.stepIndex,
        modelId: this.model.id,
        harnessId: this.harness.id,
      },
    };
    const output = await adapterFor(this.model).call(this.model, modelInput);
    return {
      ...output,
      browserTool: normalizeBrowserTool(output.browserTool),
    };
  }

  private systemPrompt() {
    return [
      'You are running inside lvl.',
      'Use exactly one browser tool call per step.',
      'The browser tool has mode="state" for inspection and mode="run" for restricted browser scripts.',
      'Prefer tab.snapshot(), indexed tab.click(ref), tab.input(ref, text), and verification after actions.',
      'For chess tasks, use the displayed legal moves, then click the source square first and destination square second in the same script when possible.',
      'For full chess matches, do not keep trying the opening move after the position changes; always choose from the current legal moves list.',
      'If your previous chess move was illegal, read the updated status/legal moves and retry a legal move for the same side; do not repeat the illegal move.',
      'When an own-turn context dump is provided, use it as memory of your prior attempts and outputs, but obey the current board/legal moves over stale plans.',
      'Return JSON only: {"mode":"run","script":"..."}',
    ].join('\n');
  }
}

function normalizeBrowserTool(tool: BrowserToolInput | undefined): BrowserToolInput {
  if (!tool) {
    return {
      mode: 'state',
      include_text: true,
      include_screenshot: true,
    };
  }
  if (tool.mode === 'run') {
    return {
      ...tool,
      max_actions: Math.min(Math.max(tool.max_actions || config.browserMaxActionsPerCall, 1), config.browserMaxActionsPerCall),
    };
  }
  return tool;
}
