import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: '.env.local' });
dotenv.config();

export const config = {
  port: Number(process.env.PORT || 4321),
  databaseUrl: process.env.DATABASE_URL || 'file:./data/lvl-state.json',
  artifactDir: process.env.ARTIFACT_DIR || './artifacts',
  workerConcurrency: Number(process.env.MATCH_WORKER_CONCURRENCY || 2),
  defaultTimeoutMs: Number(process.env.MATCH_DEFAULT_TIMEOUT_MS || 300_000),
  defaultMaxSteps: Number(process.env.MATCH_DEFAULT_MAX_STEPS || 40),
  defaultMaxToolCalls: Number(process.env.MATCH_DEFAULT_MAX_TOOL_CALLS || 160),
  modelMaxTokens: Number(process.env.MODEL_MAX_TOKENS || 4096),
  modelRequestTimeoutMs: Number(process.env.MODEL_REQUEST_TIMEOUT_MS || 120_000),
  contextWindowTokens: Number(process.env.CONTEXT_WINDOW_TOKENS || 200_000),
  contextCompactionTriggerRatio: Number(process.env.CONTEXT_COMPACTION_TRIGGER_RATIO || 0.70),
  contextCompactionCooldownMs: Number(process.env.CONTEXT_COMPACTION_COOLDOWN_MS || 30_000),
  openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
  openRouterModel: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
  openRouterSiteUrl: process.env.OPENROUTER_SITE_URL || 'http://localhost:5173',
  openRouterAppName: process.env.OPENROUTER_APP_NAME || 'lvl Local',
  browserControlUrl: process.env.BROWSER_CONTROL_URL || 'http://127.0.0.1:34981',
  browserControlToken: process.env.BROWSER_CONTROL_TOKEN || '',
  browserMaxActionsPerCall: Number(process.env.BROWSER_MAX_ACTIONS_PER_CALL || 50),
};

export function stateFilePath() {
  if (config.databaseUrl.startsWith('file:')) {
    return path.resolve(config.databaseUrl.slice('file:'.length));
  }
  return path.resolve('./data/lvl-state.json');
}
