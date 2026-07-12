import type { BrowserToolInput, HarnessConfig, ModelConfig, ModelInput, ModelOutput, Observation } from '../shared/types.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { adapterFor } from './modelAdapters.js';

export type HarnessStepInput = {
  runId: string;
  seed: number;
  stepIndex: number;
  observation: Observation;
  maxToolCalls: number;
  timeoutMs: number;
  contextDump?: string;
  abortSignal?: AbortSignal;
};

export type HarnessAdapter = {
  runStep(input: HarnessStepInput): Promise<ModelOutput>;
};

export type HarnessAdapterFactoryContext = {
  harness: HarnessConfig;
  model: ModelConfig;
  callModel(input: ModelInput): Promise<ModelOutput>;
  normalizeBrowserTool(tool: BrowserToolInput | undefined): BrowserToolInput;
};

export class BarebonesHarness {
  constructor(
    private readonly harness: HarnessConfig,
    private readonly model: ModelConfig,
  ) {}

  async runStep(input: HarnessStepInput): Promise<ModelOutput> {
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
      'When an own-turn context dump is provided, use it as memory of your prior attempts and outputs. It may be auto-compacted by the harness when long; obey the current board/legal moves over stale plans.',
      'Return JSON only: {"mode":"run","script":"..."}',
    ].join('\n');
  }
}

export async function createHarnessAdapter(harness: HarnessConfig, model: ModelConfig): Promise<HarnessAdapter> {
  if (harness.adapter?.type === 'module') {
    return loadExternalHarness(harness, model);
  }
  return new BarebonesHarness(harness, model);
}

export function normalizeBrowserTool(tool: BrowserToolInput | undefined): BrowserToolInput {
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

async function loadExternalHarness(harness: HarnessConfig, model: ModelConfig): Promise<HarnessAdapter> {
  const modulePath = harness.adapter?.modulePath;
  if (!modulePath) throw new Error(`Harness ${harness.id} is missing adapter.modulePath.`);
  const resolved = path.isAbsolute(modulePath) ? modulePath : path.resolve(modulePath);
  const loaded = await import(pathToFileURL(resolved).toString()) as Record<string, unknown>;
  const exportName = harness.adapter?.exportName || 'createHarness';
  const factory = loaded[exportName] ?? loaded.default;
  if (typeof factory !== 'function') {
    throw new Error(`Harness ${harness.id} module must export ${exportName}() or a default factory.`);
  }
  const adapter = await factory({
    harness,
    model,
    callModel: async (input: ModelInput) => adapterFor(model).call(model, input),
    normalizeBrowserTool,
  } satisfies HarnessAdapterFactoryContext);
  if (!adapter || typeof adapter !== 'object' || typeof (adapter as HarnessAdapter).runStep !== 'function') {
    throw new Error(`Harness ${harness.id} factory must return an object with runStep(input).`);
  }
  return adapter as HarnessAdapter;
}
