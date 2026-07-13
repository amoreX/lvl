import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Chess } from 'chess.js';
import type { TaskConfig } from '../shared/types.js';

type LinkedTaskPack = {
  id: string;
  title: string;
  description?: string;
  puzzles: LinkedPuzzle[];
};

type LinkedPuzzle = {
  id: string;
  title: string;
  difficulty?: TaskConfig['difficulty'];
  fen?: string;
  instructions?: string;
  maxPlies?: number;
};

export type TaskPackRegistryReport = {
  configPath: string;
  configured: boolean;
  tasks: TaskConfig[];
  errors: string[];
};

const taskPacksPath = path.resolve('./data/task-packs.json');

export async function loadLinkedTasks(): Promise<TaskConfig[]> {
  const report = await loadTaskPackReport();
  return report.tasks;
}

export async function loadTaskPackReport(): Promise<TaskPackRegistryReport> {
  const result = await readTaskPacks();
  return {
    configPath: taskPacksPath,
    configured: result.configured,
    tasks: result.packs.flatMap(toTaskConfigs),
    errors: result.errors,
  };
}

export async function checkTaskPacks(): Promise<TaskPackRegistryReport> {
  return loadTaskPackReport();
}

async function readTaskPacks() {
  const errors: string[] = [];
  try {
    const raw = await fs.readFile(taskPacksPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return {
        configured: true,
        packs: [],
        errors: [`${taskPacksPath} must contain a JSON array.`],
      };
    }
    const packs = parsed.map((item, index) => {
      const pack = parseTaskPack(item, index + 1, errors);
      return pack;
    }).filter((item): item is LinkedTaskPack => Boolean(item));
    return {
      configured: true,
      packs,
      errors,
    };
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return { configured: false, packs: [], errors: [] };
    }
    return {
      configured: true,
      packs: [],
      errors: [`Could not read ${taskPacksPath}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

function parseTaskPack(value: unknown, index: number, errors: string[]): LinkedTaskPack | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`Pack ${index} must be an object.`);
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.title !== 'string' || !Array.isArray(record.puzzles)) {
    errors.push(`Pack ${index} must include string id, string title, and puzzles array.`);
    return null;
  }
  const packId = safeId(record.id);
  const puzzles = record.puzzles.map((item, puzzleIndex) => {
    const puzzle = parsePuzzle(item, packId, puzzleIndex + 1, errors);
    return puzzle;
  }).filter((item): item is LinkedPuzzle => Boolean(item));
  return {
    id: packId,
    title: record.title,
    description: typeof record.description === 'string' ? record.description : undefined,
    puzzles,
  };
}

function parsePuzzle(value: unknown, packId: string, index: number, errors: string[]): LinkedPuzzle | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${packId} puzzle ${index} must be an object.`);
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.title !== 'string') {
    errors.push(`${packId} puzzle ${index} must include string id and title.`);
    return null;
  }
  const difficulty = parseDifficulty(record.difficulty);
  if (record.difficulty && !difficulty) {
    errors.push(`${packId}/${record.id}: difficulty must be easy, medium, or hard.`);
  }
  const fen = typeof record.fen === 'string' && record.fen.trim() ? record.fen.trim() : undefined;
  if (fen) {
    try {
      new Chess(fen);
    } catch (error) {
      errors.push(`${packId}/${record.id}: invalid FEN (${error instanceof Error ? error.message : String(error)}).`);
      return null;
    }
  }
  const maxPlies = typeof record.maxPlies === 'number' && Number.isInteger(record.maxPlies) && record.maxPlies > 0
    ? Math.min(record.maxPlies, 240)
    : undefined;
  return {
    id: safeId(record.id),
    title: record.title,
    difficulty: difficulty ?? 'medium',
    fen,
    instructions: typeof record.instructions === 'string' ? record.instructions : undefined,
    maxPlies,
  };
}

function toTaskConfigs(pack: LinkedTaskPack): TaskConfig[] {
  return pack.puzzles.map((puzzle) => {
    const maxPlies = puzzle.maxPlies ?? 40;
    return {
      id: `${pack.id}-${puzzle.id}`,
      title: `${pack.title}: ${puzzle.title}`,
      version: `task-pack:${hash(`${pack.id}:${puzzle.id}`)}`,
      environment: 'chromium_game',
      instructions: puzzle.instructions ?? `Play the chess challenge "${puzzle.title}" from ${pack.title}. Use the legal moves list, click source square, then destination square. Promotions default to queen.`,
      maxSteps: maxPlies,
      maxToolCalls: maxPlies * 3,
      difficulty: puzzle.difficulty ?? 'medium',
      allowedTools: ['browser'],
      source: {
        type: 'task_pack',
        packId: pack.id,
        puzzleId: puzzle.id,
      },
      objective: {
        kind: 'chess_match',
        maxPlies,
        initialFen: puzzle.fen,
      },
    };
  });
}

function parseDifficulty(value: unknown): TaskConfig['difficulty'] | null {
  return value === 'easy' || value === 'medium' || value === 'hard' ? value : null;
}

function safeId(value: string) {
  return value.trim().replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

function hash(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
}
