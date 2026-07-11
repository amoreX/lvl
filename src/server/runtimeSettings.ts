import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

type RuntimeSettings = {
  openRouterApiKey?: string;
};

const settingsPath = path.resolve('./data/lvl-settings.json');

export async function readRuntimeSettings(): Promise<RuntimeSettings> {
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    return JSON.parse(raw) as RuntimeSettings;
  } catch {
    return {};
  }
}

export async function updateRuntimeSettings(patch: RuntimeSettings) {
  const current = await readRuntimeSettings();
  const next = {
    ...current,
    ...cleanSettings(patch),
  };
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  return redactedSettings(next);
}

export async function getOpenRouterApiKey() {
  const settings = await readRuntimeSettings();
  return settings.openRouterApiKey || config.openRouterApiKey;
}

export async function openRouterKeySource(): Promise<'runtime' | 'env' | 'missing'> {
  const settings = await readRuntimeSettings();
  if (settings.openRouterApiKey) return 'runtime';
  if (config.openRouterApiKey) return 'env';
  return 'missing';
}

export function redactedSettings(settings: RuntimeSettings) {
  return {
    openRouterApiKeyConfigured: Boolean(settings.openRouterApiKey || config.openRouterApiKey),
  };
}

function cleanSettings(settings: RuntimeSettings) {
  return {
    openRouterApiKey: settings.openRouterApiKey?.trim() || undefined,
  };
}
