import cors from 'cors';
import express from 'express';
import { z } from 'zod';
import { renderTaskPage } from './chromiumEnvironment.js';
import { config } from './config.js';
import { MatchOrchestrator } from './orchestrator.js';
import { JsonStore } from './storage.js';

const store = new JsonStore();
const orchestrator = new MatchOrchestrator(store);
const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'agent-gauntlet-api' });
});

app.get('/api/bootstrap', async (_req, res, next) => {
  try {
    const state = await store.all();
    res.json({
      models: state.models,
      harnesses: state.harnesses,
      tasks: state.tasks,
      matches: state.matches,
      runs: state.runs,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/matches', async (_req, res, next) => {
  try {
    const state = await store.all();
    res.json(state.matches);
  } catch (error) {
    next(error);
  }
});

app.get('/api/matches/:id', async (req, res, next) => {
  try {
    const detail = await store.matchDetail(req.params.id);
    if (!detail) {
      res.status(404).json({ error: 'match not found' });
      return;
    }
    res.json(detail);
  } catch (error) {
    next(error);
  }
});

app.post('/api/matches', async (req, res, next) => {
  try {
    const input = createMatchSchema.parse(req.body);
    const match = await orchestrator.createMatch(input);
    res.status(201).json(match);
  } catch (error) {
    next(error);
  }
});

app.post('/api/matches/:id/cancel', async (req, res, next) => {
  try {
    const detail = await orchestrator.cancelMatch(req.params.id);
    if (!detail) {
      res.status(404).json({ error: 'match not found' });
      return;
    }
    res.json(detail);
  } catch (error) {
    next(error);
  }
});

app.get('/api/analytics', async (_req, res, next) => {
  try {
    res.json(await store.analytics());
  } catch (error) {
    next(error);
  }
});

app.get('/task-pages/:taskId', async (req, res, next) => {
  try {
    const state = await store.all();
    const task = state.tasks.find((item) => item.id === req.params.taskId);
    if (!task) {
      res.status(404).send('Task not found');
      return;
    }
    const seed = Number(req.query.seed || 818);
    res.type('html').send(renderTaskPage(task, seed));
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  res.status(error instanceof z.ZodError ? 400 : 500).json({ error: message });
});

await store.load();

app.listen(config.port, () => {
  console.log(`AgentGauntlet API listening on http://localhost:${config.port}`);
});

const createMatchSchema = z.object({
  name: z.string().min(1).default('Local match'),
  taskId: z.string().min(1),
  agentA: z.object({
    modelId: z.string().min(1),
    harnessId: z.string().min(1),
  }),
  agentB: z.object({
    modelId: z.string().min(1),
    harnessId: z.string().min(1),
  }),
  seed: z.number().int().positive().optional(),
  runMode: z.enum(['sequential', 'parallel']),
  maxSteps: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive().optional(),
  hurdlesEnabled: z.boolean(),
});
