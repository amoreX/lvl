import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HarnessConfig } from '../shared/types.js';

type LinkedHarness = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  modulePath: string;
  exportName?: string;
};

const linkedHarnessesPath = path.resolve('./data/harness-adapters.json');

export async function loadLinkedHarnesses(): Promise<HarnessConfig[]> {
  const report = await loadLinkedHarnessReport();
  return report.harnesses;
}

export type HarnessRegistryReport = {
  configPath: string;
  configured: boolean;
  harnesses: HarnessConfig[];
  errors: string[];
};

export async function loadLinkedHarnessReport(): Promise<HarnessRegistryReport> {
  const result = await readLinkedHarnesses();
  return {
    configPath: linkedHarnessesPath,
    configured: result.configured,
    harnesses: result.adapters.map(toHarnessConfig),
    errors: result.errors,
  };
}

export async function checkLinkedHarnesses(): Promise<HarnessRegistryReport> {
  const report = await loadLinkedHarnessReport();
  const errors = [...report.errors];
  for (const harness of report.harnesses) {
    const modulePath = harness.adapter?.modulePath;
    if (!modulePath) {
      errors.push(`${harness.id}: missing modulePath`);
      continue;
    }
    try {
      const resolved = path.isAbsolute(modulePath) ? modulePath : path.resolve(modulePath);
      const loaded = await import(pathToFileURL(resolved).toString()) as Record<string, unknown>;
      const exportName = harness.adapter?.exportName || 'createHarness';
      const factory = loaded[exportName] ?? loaded.default;
      if (typeof factory !== 'function') {
        errors.push(`${harness.id}: module must export ${exportName}() or a default factory`);
      }
    } catch (error) {
      errors.push(`${harness.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    ...report,
    errors,
  };
}

function toHarnessConfig(adapter: LinkedHarness): HarnessConfig {
  return {
    id: adapter.id,
    name: adapter.name,
    version: adapter.version || 'local',
    description: adapter.description || `Local harness adapter from ${adapter.modulePath}`,
    systemPromptHash: hash(`external:${adapter.id}:${adapter.modulePath}`),
    toolSchemaHash: hash('external-browser-tool-adapter-v0.1.0'),
    adapter: {
      type: 'module',
      modulePath: adapter.modulePath,
      exportName: adapter.exportName,
    },
  };
}

async function readLinkedHarnesses() {
  const errors: string[] = [];
  try {
    const raw = await fs.readFile(linkedHarnessesPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return {
        configured: true,
        adapters: [],
        errors: [`${linkedHarnessesPath} must contain a JSON array.`],
      };
    }
    const adapters = parsed.map((item, index) => {
      const harness = parseLinkedHarness(item);
      if (!harness) errors.push(`Entry ${index + 1} must include string id, name, and modulePath.`);
      return harness;
    }).filter((item): item is LinkedHarness => Boolean(item));
    return {
      configured: true,
      adapters,
      errors,
    };
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return { configured: false, adapters: [], errors: [] };
    }
    return {
      configured: true,
      adapters: [],
      errors: [`Could not read ${linkedHarnessesPath}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

function parseLinkedHarness(value: unknown): LinkedHarness | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.name !== 'string' || typeof record.modulePath !== 'string') return null;
  return {
    id: record.id,
    name: record.name,
    version: typeof record.version === 'string' ? record.version : undefined,
    description: typeof record.description === 'string' ? record.description : undefined,
    modulePath: record.modulePath,
    exportName: typeof record.exportName === 'string' ? record.exportName : undefined,
  };
}

function hash(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}
