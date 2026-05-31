import crypto from 'node:crypto';
import type { AppState, HarnessConfig, ModelConfig, TaskConfig } from '../shared/types.js';

function hash(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export const seedModels: ModelConfig[] = [
  {
    id: 'dummy-strong',
    provider: 'dummy',
    name: 'Dummy Strong',
    version: '0.1.0',
    description: 'Deterministic local agent that reads the snapshot, closes popups, and clicks the intended target.',
    enabled: true,
  },
  {
    id: 'dummy-chaotic',
    provider: 'dummy',
    name: 'Dummy Chaotic',
    version: '0.1.0',
    description: 'Local baseline that sometimes loops, clicks decoys, and ignores verification.',
    enabled: true,
  },
  {
    id: 'openrouter-default',
    provider: 'openrouter',
    name: 'OpenRouter Default',
    version: 'env.OPENROUTER_MODEL',
    defaultModel: 'env.OPENROUTER_MODEL',
    description: 'Real model path through OpenRouter. Disabled until OPENROUTER_API_KEY is present.',
    enabled: Boolean(process.env.OPENROUTER_API_KEY),
  },
  {
    id: 'openrouter-gpt-4o-mini',
    provider: 'openrouter',
    name: 'GPT-4o Mini',
    version: 'openai/gpt-4o-mini',
    defaultModel: 'openai/gpt-4o-mini',
    description: 'OpenRouter adapter using OpenAI GPT-4o Mini for low-cost browser-task runs.',
    enabled: Boolean(process.env.OPENROUTER_API_KEY),
  },
  {
    id: 'openrouter-gemini-flash',
    provider: 'openrouter',
    name: 'Gemini Flash',
    version: 'google/gemini-2.0-flash-001',
    defaultModel: 'google/gemini-2.0-flash-001',
    description: 'OpenRouter adapter using Gemini Flash for low-cost browser-task runs.',
    enabled: Boolean(process.env.OPENROUTER_API_KEY),
  },
  {
    id: 'openrouter-llama-8b',
    provider: 'openrouter',
    name: 'Llama 3.1 8B',
    version: 'meta-llama/llama-3.1-8b-instruct',
    defaultModel: 'meta-llama/llama-3.1-8b-instruct',
    description: 'OpenRouter adapter using a small open model as a cheaper baseline.',
    enabled: Boolean(process.env.OPENROUTER_API_KEY),
  },
  {
    id: 'openrouter-qwen-9b',
    provider: 'openrouter',
    name: 'Qwen 3.5 9B',
    version: 'qwen/qwen3.5-9b',
    defaultModel: 'qwen/qwen3.5-9b',
    description: 'OpenRouter adapter using Qwen 3.5 9B as a low-cost baseline.',
    enabled: Boolean(process.env.OPENROUTER_API_KEY),
  },
  {
    id: 'openrouter-sonnet-4-6',
    provider: 'openrouter',
    name: 'Claude Sonnet 4.6',
    version: 'anthropic/claude-sonnet-4.6',
    defaultModel: 'anthropic/claude-sonnet-4.6',
    description: 'OpenRouter adapter using Claude Sonnet 4.6.',
    enabled: Boolean(process.env.OPENROUTER_API_KEY),
  },
  {
    id: 'openrouter-opus-4-6',
    provider: 'openrouter',
    name: 'Claude Opus 4.6',
    version: 'anthropic/claude-opus-4.6',
    defaultModel: 'anthropic/claude-opus-4.6',
    description: 'OpenRouter adapter using Claude Opus 4.6.',
    enabled: Boolean(process.env.OPENROUTER_API_KEY),
  },
  {
    id: 'openrouter-gpt-5-4',
    provider: 'openrouter',
    name: 'GPT-5.4',
    version: 'openai/gpt-5.4',
    defaultModel: 'openai/gpt-5.4',
    description: 'OpenRouter adapter using GPT-5.4.',
    enabled: Boolean(process.env.OPENROUTER_API_KEY),
  },
];

export const seedHarnesses: HarnessConfig[] = [
  {
    id: 'ghost-barebones',
    name: 'Ghost Barebones Harness',
    version: '0.1.0',
    description: 'A small Pi/Ghost-style harness that asks models for one browser tool call per step.',
    systemPromptHash: hash('ghost-barebones-system-v0.1.0'),
    toolSchemaHash: hash('browser-tool-state-run-v0.1.0'),
  },
];

export const seedTasks: TaskConfig[] = [
  {
    id: 'simple-checkout-popup',
    title: 'Checkout With Popup',
    version: '0.1.0',
    environment: 'chromium_game',
    instructions: 'Close any newsletter popup, add the product to cart, and press Confirm Checkout.',
    maxSteps: 8,
    maxToolCalls: 24,
    difficulty: 'easy',
    allowedTools: ['browser'],
    objective: {
      kind: 'checkout',
    },
    hurdles: [
      {
        id: 'newsletter-popup',
        type: 'popup',
        stepIndex: 1,
        payload: {
          title: 'Newsletter popup',
          closeRef: 7,
          penaltyIfIgnored: 12,
        },
      },
    ],
  },
  {
    id: 'confirm-button-decoy',
    title: 'Confirm The Real Target',
    version: '0.1.0',
    environment: 'chromium_game',
    instructions: 'Click the real Confirm button. Avoid the decoy button.',
    maxSteps: 6,
    maxToolCalls: 18,
    difficulty: 'easy',
    allowedTools: ['browser'],
    objective: {
      kind: 'checkout',
    },
    hurdles: [],
  },
  {
    id: 'target-grid-duel',
    title: 'Target Grid Duel',
    version: '0.1.0',
    environment: 'chromium_game',
    instructions: 'Score three points by clicking only the highlighted target tile. Avoid decoys and close any obstacle popup.',
    maxSteps: 10,
    maxToolCalls: 30,
    difficulty: 'medium',
    allowedTools: ['browser'],
    objective: {
      kind: 'target_game',
      targetScore: 3,
    },
    hurdles: [
      {
        id: 'midgame-popup',
        type: 'popup',
        stepIndex: 2,
        payload: {
          title: 'Obstacle popup',
          closeRef: 7,
          penaltyIfIgnored: 12,
        },
      },
      {
        id: 'moving-target',
        type: 'moving_target',
        stepIndex: 4,
        payload: {
          note: 'Target position changes after successful hits.',
        },
      },
    ],
  },
];

export function emptyState(): AppState {
  return {
    models: seedModels,
    harnesses: seedHarnesses,
    tasks: seedTasks,
    matches: [],
    runs: [],
    steps: [],
  };
}
