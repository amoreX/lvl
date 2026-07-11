import type { ModelConfig } from '../shared/types.js';
import { config } from './config.js';
import { getOpenRouterApiKey } from './runtimeSettings.js';
import { seedModels } from './seeds.js';

type OpenRouterModel = {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
};

type OpenRouterModelsResponse = {
  data?: OpenRouterModel[];
};

let cachedAt = 0;
let cachedModels: ModelConfig[] = [];
const cacheTtlMs = 5 * 60 * 1000;

export async function searchOpenRouterModels(query: string, limit = 40) {
  const apiKey = await getOpenRouterApiKey();
  const models = await openRouterCatalog();
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? models.filter((model) => `${model.name} ${model.defaultModel ?? ''} ${model.description}`.toLowerCase().includes(normalized))
    : models;
  return filtered.slice(0, limit).map((model) => ({ ...model, enabled: Boolean(apiKey) }));
}

async function openRouterCatalog() {
  if (cachedModels.length && Date.now() - cachedAt < cacheTtlMs) return cachedModels;
  const apiKey = await getOpenRouterApiKey();
  const headers: Record<string, string> = {
    'http-referer': config.openRouterSiteUrl,
    'x-title': config.openRouterAppName,
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetch('https://openrouter.ai/api/v1/models', { headers });
  if (!response.ok) {
    throw new Error(`OpenRouter model search failed with ${response.status}`);
  }
  const data = await response.json() as OpenRouterModelsResponse;
  cachedModels = (data.data ?? [])
    .filter((model) => model.id)
    .map(toModelConfig)
    .sort((a, b) => a.name.localeCompare(b.name));
  cachedAt = Date.now();
  return cachedModels;
}

function toModelConfig(model: OpenRouterModel): ModelConfig {
  const seeded = seedModels.find((item) => item.defaultModel === model.id);
  return {
    id: seeded?.id ?? `openrouter-${model.id.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}`,
    provider: 'openrouter',
    name: model.name || model.id,
    version: model.id,
    defaultModel: model.id,
    description: model.description || `OpenRouter catalog model${model.context_length ? ` with ${model.context_length.toLocaleString()} context tokens` : ''}.`,
    enabled: false,
  };
}
