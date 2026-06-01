import cors from 'cors';
import express from 'express';
import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';
import { z } from 'zod';
import type { MatchDetail, TraceStep } from '../shared/types.js';
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
  res.json({ ok: true, service: 'lvl-api' });
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

app.get('/api/matches/:id/replay', async (req, res, next) => {
  try {
    const detail = await store.matchDetail(req.params.id);
    if (!detail) {
      res.status(404).json({ error: 'match not found' });
      return;
    }
    res.json(chessReplay(detail));
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

app.delete('/api/matches/:id', async (req, res, next) => {
  try {
    const deleted = await orchestrator.deleteMatch(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'match not found' });
      return;
    }
    res.json({ ok: true });
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
    const match = typeof req.query.matchId === 'string'
      ? state.matches.find((item) => item.id === req.query.matchId)
      : null;
    const seed = match?.seed || Math.floor(Math.random() * 1_000_000_000) + 1;
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
  console.log(`lvl API listening on http://localhost:${config.port}`);
});

function chessReplay(detail: MatchDetail) {
  const chess = new Chess();
  const runsById = new Map(detail.runs.map((run) => [run.id, run]));
  const steps = detail.runs
    .flatMap((run) => run.steps.map((step) => ({ step, run })))
    .sort((a, b) => a.step.stepIndex - b.step.stepIndex || a.step.createdAt.localeCompare(b.step.createdAt));
  const frames: Array<{
    index: number;
    board: Record<string, string>;
    fen: string;
    turn: Color;
    moveHistory: string[];
    legalMoves: string[];
    status: string;
    label: string;
    actor?: string;
    model?: string;
    move?: string;
    san?: string;
    result?: 'legal' | 'illegal' | 'incomplete';
    messages?: string[];
  }> = [{
    index: 0,
    board: chessBoardMap(chess),
    fen: chess.fen(),
    turn: chess.turn(),
    moveHistory: chess.history(),
    legalMoves: chess.moves({ verbose: true }).map((move) => `${move.from}${move.to}${move.promotion ?? ''} (${move.san})`),
    status: 'Game started.',
    label: 'Start position',
  }];

  for (const { step, run } of steps) {
    const proposed = proposedChessMove(step);
    const legalMarker = step.scoreEvents.find((event) => event.reason.startsWith('Legal move played:'));
    const actor = run.role === 'agentA' ? 'Agent A' : 'Agent B';
    const model = shortModelName(run.model?.name ?? run.modelId);
    const messages = step.scoreEvents.map((event) => event.reason);

    if (!proposed) {
      frames.push({
        index: frames.length,
        board: chessBoardMap(chess),
        fen: chess.fen(),
        turn: chess.turn(),
        moveHistory: chess.history(),
        legalMoves: chess.moves({ verbose: true }).map((move) => `${move.from}${move.to}${move.promotion ?? ''} (${move.san})`),
        status: `${actor} did not complete a chess move.`,
        label: `${actor} incomplete move`,
        actor,
        model,
        result: 'incomplete',
        messages,
      });
      continue;
    }

    let move = null;
    try {
      move = chess.move({
        from: proposed.from as Square,
        to: proposed.to as Square,
        promotion: proposed.promotion || 'q',
      });
    } catch {
      move = null;
    }

    frames.push({
      index: frames.length,
      board: chessBoardMap(chess),
      fen: chess.fen(),
      turn: chess.turn(),
      moveHistory: chess.history(),
      legalMoves: chess.moves({ verbose: true }).map((item) => `${item.from}${item.to}${item.promotion ?? ''} (${item.san})`),
      status: move && legalMarker ? `${actor} played ${move.san}.` : `${actor} attempted illegal move ${proposed.from}${proposed.to}.`,
      label: move ? `${actor}: ${move.san}` : `${actor}: ${proposed.from}${proposed.to} illegal`,
      actor,
      model,
      move: `${proposed.from}${proposed.to}${proposed.promotion && proposed.promotion !== 'q' ? proposed.promotion : ''}`,
      san: move?.san,
      result: move ? 'legal' : 'illegal',
      messages,
    });
  }

  return {
    match: {
      id: detail.match.id,
      name: detail.match.name,
      status: detail.match.status,
      winnerRunId: detail.match.winnerRunId ?? null,
    },
    task: {
      id: detail.task.id,
      title: detail.task.title,
    },
    runs: detail.runs.map((run) => ({
      id: run.id,
      role: run.role,
      modelId: run.modelId,
      modelName: shortModelName(runsById.get(run.id)?.model?.name ?? run.modelId),
    })),
    frames,
  };
}

function proposedChessMove(step: TraceStep) {
  for (const event of step.scoreEvents) {
    const match = event.reason.match(/Proposed chess move ([a-h][1-8])([a-h][1-8])([qrbn])?/i);
    if (match) return { from: match[1], to: match[2], promotion: match[3] ?? 'q' };
  }
  const script = step.toolCall?.input.mode === 'run' ? step.toolCall.input.script : '';
  const refs = [...script.matchAll(/click\((\d+)\)/g)].map((match) => Number(match[1]));
  if (refs.length < 2) return null;
  const from = squareFromRef(refs.at(-2)!);
  const to = squareFromRef(refs.at(-1)!);
  return from && to ? { from, to, promotion: 'q' } : null;
}

function squareFromRef(ref: number) {
  const offset = ref - 201;
  if (offset < 0 || offset > 63) return null;
  const file = String.fromCharCode(97 + (offset % 8));
  const rank = Math.floor(offset / 8) + 1;
  return `${file}${rank}`;
}

function shortModelName(value: string) {
  return value
    .replace(/^openrouter[-: ]/i, '')
    .replace(/^anthropic[-: ]/i, '')
    .replace(/^openai[-: ]/i, '')
    .replace(/^google[-: ]/i, '')
    .replace(/^meta[-: ]/i, '')
    .replace(/\bClaude\s+/gi, '')
    .replace(/\bAnthropic\s+/gi, '')
    .replace(/\bOpenRouter\s+/gi, '')
    .replace(/\bOpenAI\s+/gi, '')
    .replace(/\bGoogle\s+/gi, '')
    .replace(/\bDummy Strong\b/gi, 'Strong')
    .replace(/\bDummy Chaotic\b/gi, 'Chaotic')
    .replace(/sonnet-(\d)-(\d)/gi, 'Sonnet $1.$2')
    .replace(/opus-(\d)-(\d)/gi, 'Opus $1.$2')
    .replace(/gpt-(\d)-(\d)/gi, 'GPT $1.$2')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function chessBoardMap(chess: Chess) {
  const output: Record<string, string> = {};
  const board = chess.board();
  for (let rankIndex = 0; rankIndex < board.length; rankIndex += 1) {
    const rank = 8 - rankIndex;
    for (let fileIndex = 0; fileIndex < board[rankIndex].length; fileIndex += 1) {
      const piece = board[rankIndex][fileIndex];
      if (!piece) continue;
      const file = String.fromCharCode(97 + fileIndex);
      output[`${file}${rank}`] = pieceGlyph(piece.color, piece.type);
    }
  }
  return output;
}

function pieceGlyph(color: Color, type: PieceSymbol) {
  const glyphs: Record<Color, Record<PieceSymbol, string>> = {
    w: { p: '♙', r: '♖', n: '♘', b: '♗', q: '♕', k: '♔' },
    b: { p: '♟', r: '♜', n: '♞', b: '♝', q: '♛', k: '♚' },
  };
  return glyphs[color][type];
}

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
  memoryMode: z.enum(['fresh', 'context_dump']).optional(),
  runMode: z.enum(['sequential', 'parallel']),
  maxSteps: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive().optional(),
});
