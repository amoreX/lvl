import type { BrowserToolInput, ModelConfig, ModelInput, ModelOutput } from '../shared/types.js';
import { config } from './config.js';

export interface ModelAdapter {
  call(model: ModelConfig, input: ModelInput): Promise<ModelOutput>;
}

export class DummyModelAdapter implements ModelAdapter {
  async call(model: ModelConfig, input: ModelInput): Promise<ModelOutput> {
    const started = Date.now();
    const script = model.id === 'dummy-chaotic'
      ? chaoticScript(input)
      : strongScript(input);
    return {
      rawText: JSON.stringify({ tool: 'browser', mode: 'run', script }, null, 2),
      browserTool: {
        mode: 'run',
        max_actions: 3,
        script,
      },
      usage: {
        inputTokens: approxTokens(JSON.stringify(input.observation)),
        outputTokens: approxTokens(script),
      },
      latencyMs: Date.now() - started,
      costUsd: 0,
    };
  }
}

export class OpenRouterAdapter implements ModelAdapter {
  async call(model: ModelConfig, input: ModelInput): Promise<ModelOutput> {
    if (!config.openRouterApiKey) {
      throw new Error('OPENROUTER_API_KEY is not configured. Use dummy agents or add the key to .env.local.');
    }
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.modelRequestTimeoutMs);
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.openRouterApiKey}`,
        'content-type': 'application/json',
        'http-referer': config.openRouterSiteUrl,
        'x-title': config.openRouterAppName,
      },
      body: JSON.stringify({
        model: model.defaultModel === 'env.OPENROUTER_MODEL' ? config.openRouterModel : model.defaultModel || config.openRouterModel,
        temperature: 0.1,
        max_tokens: input.budget.maxTokens,
        messages: [
          { role: 'system', content: input.system },
          {
            role: 'user',
            content: [
              'Return only JSON for one browser tool call.',
              'Schema: {"mode":"run","script":"const tab = await browser.currentTab(); await tab.snapshot(); ...; return await tab.snapshot();"}',
              `Observation:\n${JSON.stringify(input.observation, null, 2)}`,
            ].join('\n\n'),
          },
        ],
      }),
    }).finally(() => clearTimeout(timeout));
    if (!response.ok) {
      throw new Error(`OpenRouter request failed with ${response.status}`);
    }
    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const rawText = data.choices?.[0]?.message?.content || '';
    return {
      rawText,
      browserTool: parseBrowserTool(rawText),
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? approxTokens(JSON.stringify(input.observation)),
        outputTokens: data.usage?.completion_tokens ?? approxTokens(rawText),
      },
      latencyMs: Date.now() - started,
      costUsd: estimateOpenRouterCost(data.usage?.prompt_tokens ?? 0, data.usage?.completion_tokens ?? 0),
    };
  }
}

export function adapterFor(model: ModelConfig): ModelAdapter {
  if (model.provider === 'openrouter') return new OpenRouterAdapter();
  return new DummyModelAdapter();
}

function strongScript(input: ModelInput) {
  const elements = input.observation.elements;
  const target = elements.find((el) => /target tile|real target|highlighted target/i.test(el.label));
  const close = elements.find((el) => /close|dismiss/i.test(el.label));
  const add = elements.find((el) => /add to cart/i.test(el.label));
  const confirm = elements.find((el) => /^confirm checkout$/i.test(el.label) || /^confirm$/i.test(el.label));
  if (close) {
    return `const tab = await browser.currentTab(); await tab.snapshot(); await tab.click(${close.ref}); return await tab.snapshot();`;
  }
  if (target) {
    return `const tab = await browser.currentTab(); await tab.snapshot(); await tab.click(${target.ref}); return await tab.snapshot();`;
  }
  if (add) {
    return `const tab = await browser.currentTab(); await tab.snapshot(); await tab.click(${add.ref}); return await tab.snapshot();`;
  }
  if (confirm) {
    return `const tab = await browser.currentTab(); await tab.snapshot(); await tab.click(${confirm.ref}); return await tab.snapshot();`;
  }
  return 'const tab = await browser.currentTab(); return await tab.snapshot();';
}

function chaoticScript(input: ModelInput) {
  const elements = input.observation.elements;
  const decoy = elements.find((el) => /decoy|cancel|newsletter|trap tile/i.test(el.label));
  const fallback = elements.find((el) => /confirm|add|close|target tile/i.test(el.label)) ?? elements[0];
  if (input.metadata.stepIndex % 3 === 1 && decoy) {
    return `const tab = await browser.currentTab(); await tab.snapshot(); await tab.click(${decoy.ref}); return await tab.snapshot();`;
  }
  if (fallback) {
    return `const tab = await browser.currentTab(); await tab.snapshot(); await tab.click(${fallback.ref}); return await tab.snapshot();`;
  }
  return 'const tab = await browser.currentTab(); return await tab.snapshot();';
}

function parseBrowserTool(rawText: string): BrowserToolInput | undefined {
  const jsonStart = rawText.indexOf('{');
  const jsonEnd = rawText.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1) return undefined;
  try {
    const parsed = JSON.parse(rawText.slice(jsonStart, jsonEnd + 1)) as BrowserToolInput;
    if (parsed.mode === 'state') return parsed;
    if (parsed.mode === 'run' && typeof parsed.script === 'string') return parsed;
  } catch {
    return undefined;
  }
  return undefined;
}

function approxTokens(text: string) {
  return Math.ceil(text.length / 4);
}

function estimateOpenRouterCost(inputTokens: number, outputTokens: number) {
  return Number((((inputTokens / 1_000_000) * 0.15) + ((outputTokens / 1_000_000) * 0.6)).toFixed(6));
}
