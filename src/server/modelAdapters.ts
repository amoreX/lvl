import type { BrowserToolInput, ModelConfig, ModelInput, ModelOutput } from '../shared/types.js';
import { parseBrowserTool } from './browserActionParser.js';
import { config } from './config.js';
import { getOpenRouterApiKey } from './runtimeSettings.js';

export interface ModelAdapter {
  call(model: ModelConfig, input: ModelInput): Promise<ModelOutput>;
}

export class DummyModelAdapter implements ModelAdapter {
  async call(model: ModelConfig, input: ModelInput): Promise<ModelOutput> {
    throwIfAborted(input.abortSignal);
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
        inputTokens: approxTokens(JSON.stringify(input.observation) + (input.contextDump ?? '')),
        outputTokens: approxTokens(script),
      },
      latencyMs: Date.now() - started,
      costUsd: 0,
      costEstimated: false,
    };
  }
}

export class OpenRouterAdapter implements ModelAdapter {
  async call(model: ModelConfig, input: ModelInput): Promise<ModelOutput> {
    const apiKey = await getOpenRouterApiKey();
    if (!apiKey) {
      throw new Error('OpenRouter API key is not configured. Add it in the lvl setup panel before running real model matches.');
    }
    const started = Date.now();
    const controller = new AbortController();
    const abortFromMatch = () => controller.abort(input.abortSignal?.reason);
    if (input.abortSignal?.aborted) abortFromMatch();
    input.abortSignal?.addEventListener('abort', abortFromMatch, { once: true });
    const timeout = setTimeout(() => controller.abort(), config.modelRequestTimeoutMs);
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
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
              input.contextDump ? `Own prior-turn context dump (may be harness-compacted):\n${input.contextDump}` : 'Own prior-turn context dump: disabled for this match.',
              `Observation:\n${JSON.stringify(input.observation, null, 2)}`,
            ].join('\n\n'),
          },
        ],
      }),
    }).finally(() => {
      clearTimeout(timeout);
      input.abortSignal?.removeEventListener('abort', abortFromMatch);
    });
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
        inputTokens: data.usage?.prompt_tokens ?? approxTokens(JSON.stringify(input.observation) + (input.contextDump ?? '')),
        outputTokens: data.usage?.completion_tokens ?? approxTokens(rawText),
      },
      latencyMs: Date.now() - started,
      costUsd: estimateOpenRouterCost(data.usage?.prompt_tokens ?? 0, data.usage?.completion_tokens ?? 0),
      costEstimated: true,
    };
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Model call aborted.');
}

export function adapterFor(model: ModelConfig): ModelAdapter {
  if (model.provider === 'openrouter') return new OpenRouterAdapter();
  return new DummyModelAdapter();
}

function strongScript(input: ModelInput) {
  const elements = input.observation.elements;
  const chessMove = nextDeterministicChessMove(elements);
  if (chessMove) {
    return `const tab = await browser.currentTab(); await tab.snapshot(); await tab.click(${chessMove.from}); await tab.click(${chessMove.to}); return await tab.snapshot();`;
  }
  return 'const tab = await browser.currentTab(); return await tab.snapshot();';
}

function nextDeterministicChessMove(elements: ModelInput['observation']['elements']) {
  const plans = [
    [/white pawn on e2/i, /empty square e4|destination square e4|square e4/i],
    [/black pawn on e7/i, /empty square e5|square e5/i],
    [/white knight on g1/i, /empty square f3|square f3/i],
    [/black knight on b8/i, /empty square c6|square c6/i],
    [/white bishop on f1/i, /empty square c4|square c4/i],
    [/black knight on g8/i, /empty square f6|square f6/i],
    [/white pawn on d2/i, /empty square d4|square d4/i],
    [/black pawn on d7/i, /empty square d5|square d5/i],
  ] as const;
  for (const [fromPattern, toPattern] of plans) {
    const from = elements.find((el) => fromPattern.test(el.label));
    const to = elements.find((el) => toPattern.test(el.label));
    if (from && to) return { from: from.ref, to: to.ref };
  }
  return null;
}

function chaoticScript(input: ModelInput) {
  const elements = input.observation.elements;
  const chessSquares = elements.filter((el) => /square|pawn|knight|bishop|rook|queen|king/i.test(el.label));
  const from = chessSquares[input.metadata.stepIndex % Math.max(chessSquares.length, 1)];
  const to = chessSquares[(input.metadata.stepIndex + 9) % Math.max(chessSquares.length, 1)];
  if (from && to) {
    return `const tab = await browser.currentTab(); await tab.snapshot(); await tab.click(${from.ref}); await tab.click(${to.ref}); return await tab.snapshot();`;
  }
  return 'const tab = await browser.currentTab(); return await tab.snapshot();';
}

function approxTokens(text: string) {
  return Math.ceil(text.length / 4);
}

function estimateOpenRouterCost(inputTokens: number, outputTokens: number) {
  return Number((((inputTokens / 1_000_000) * 0.15) + ((outputTokens / 1_000_000) * 0.6)).toFixed(6));
}
