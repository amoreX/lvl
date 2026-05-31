import type { BrowserToolInput } from '../shared/types.js';

export type ParsedBrowserScript = {
  clicks: number[];
  coordinateClicks: Array<{ x: number; y: number }>;
  inputs: Array<{ ref: number; text: string }>;
  keys: string[];
  selects: Array<{ ref: number; text: string }>;
  snapshots: number;
};

export function parseBrowserTool(rawText: string): BrowserToolInput | undefined {
  const normalized = stripCodeFences(rawText).trim();
  for (const candidate of jsonCandidates(normalized)) {
    const parsed = parseJson(candidate);
    const tool = normalizeToolObject(parsed);
    if (tool) return tool;
  }

  const script = extractScriptFromText(normalized);
  if (script) {
    return {
      mode: 'run',
      script,
    };
  }

  if (/mode\s*[:=]\s*["']?state/i.test(normalized)) {
    return {
      mode: 'state',
      include_text: true,
      include_screenshot: true,
    };
  }

  return undefined;
}

export function parseBrowserScript(script: string): ParsedBrowserScript {
  const clicks = [
    ...extractNumericCalls(script, ['click', 'clickAndSnapshot']),
    ...extractObjectIndexCalls(script, ['click', 'clickAndSnapshot']),
    ...extractSquareClicks(script),
  ];
  return {
    clicks,
    coordinateClicks: extractCoordinateClicks(script),
    inputs: [
      ...extractTextInputs(script, ['input', 'type', 'safeInput']),
      ...extractObjectTextInputs(script, ['input', 'type', 'safeInput']),
    ],
    keys: extractStringCalls(script, ['keys', 'press', 'sendKeys']),
    selects: [
      ...extractTextInputs(script, ['select']),
      ...extractObjectTextInputs(script, ['select']),
    ],
    snapshots: countCalls(script, ['snapshot', 'resnapshot', 'screenshot']),
  };
}

export function chessSquareRef(square: string) {
  const normalized = square.trim().toLowerCase();
  if (!/^[a-h][1-8]$/.test(normalized)) return null;
  const file = normalized.charCodeAt(0) - 96;
  const rank = Number(normalized[1]);
  return 200 + ((rank - 1) * 8) + file;
}

function stripCodeFences(value: string) {
  return value
    .replace(/^```(?:json|javascript|js|ts|typescript)?\s*/i, '')
    .replace(/\s*```$/i, '');
}

function* jsonCandidates(text: string): Generator<string> {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) yield trimmed;
  for (const fenced of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const body = fenced[1].trim();
    if (body.startsWith('{')) yield body;
  }
  for (const candidate of balancedObjects(text)) yield candidate;
}

function balancedObjects(text: string) {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let quote: string | null = null;
    let escaped = false;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          out.push(text.slice(i, j + 1));
          break;
        }
      }
    }
  }
  return out;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeToolObject(value: unknown): BrowserToolInput | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const nested = [record.input, record.arguments, record.args, record.browserTool, record.browser_tool]
    .map((item) => normalizeToolObject(item))
    .find(Boolean);
  if (nested) return nested;

  if (record.mode === 'state') {
    return {
      mode: 'state',
      tab_id: stringOrNumber(record.tab_id ?? record.tabId),
      include_text: bool(record.include_text ?? record.includeText),
      include_screenshot: bool(record.include_screenshot ?? record.includeScreenshot),
      max_length: num(record.max_length ?? record.maxLength),
      max_elements: num(record.max_elements ?? record.maxElements),
      group_title: str(record.group_title ?? record.groupTitle),
    };
  }
  const script = str(record.script ?? record.code ?? record.javascript);
  if (record.mode === 'run' && script) {
    return {
      mode: 'run',
      tab_id: stringOrNumber(record.tab_id ?? record.tabId),
      max_actions: num(record.max_actions ?? record.maxActions),
      script,
    };
  }
  if (script) {
    return {
      mode: 'run',
      script,
      max_actions: num(record.max_actions ?? record.maxActions),
    };
  }
  return undefined;
}

function extractScriptFromText(text: string) {
  const fenced = [...text.matchAll(/```(?:javascript|js|ts|typescript)?\s*([\s\S]*?)```/gi)]
    .map((match) => match[1].trim())
    .find((body) => /browser\.|tab\./.test(body));
  if (fenced) return fenced;
  if (/browser\.|tab\./.test(text)) return text;
  return null;
}

function extractNumericCalls(script: string, names: string[]) {
  const joined = names.join('|');
  const refs: number[] = [];
  const pattern = new RegExp(`\\.(?:${joined})\\(\\s*([0-9]+)`, 'g');
  for (const match of script.matchAll(pattern)) refs.push(Number(match[1]));
  return refs;
}

function extractObjectIndexCalls(script: string, names: string[]) {
  const joined = names.join('|');
  const refs: number[] = [];
  const pattern = new RegExp(`\\.(?:${joined})\\(\\s*\\{[^}]*?(?:index|ref)\\s*:\\s*([0-9]+)[^}]*?\\}`, 'g');
  for (const match of script.matchAll(pattern)) refs.push(Number(match[1]));
  return refs;
}

function extractSquareClicks(script: string) {
  const refs: number[] = [];
  for (const match of script.matchAll(/\.(?:click|clickAndSnapshot)\(\s*["']([a-h][1-8])["']/gi)) {
    const ref = chessSquareRef(match[1]);
    if (ref != null) refs.push(ref);
  }
  return refs;
}

function extractCoordinateClicks(script: string) {
  const clicks: Array<{ x: number; y: number }> = [];
  for (const match of script.matchAll(/\.clickAt\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/g)) {
    clicks.push({ x: Number(match[1]), y: Number(match[2]) });
  }
  for (const match of script.matchAll(/\.(?:click|clickAndSnapshot)\(\s*\{[^}]*?x\s*:\s*(-?\d+(?:\.\d+)?)[^}]*?y\s*:\s*(-?\d+(?:\.\d+)?)[^}]*?\}/g)) {
    clicks.push({ x: Number(match[1]), y: Number(match[2]) });
  }
  return clicks;
}

function extractTextInputs(script: string, names: string[]) {
  const joined = names.join('|');
  const inputs: Array<{ ref: number; text: string }> = [];
  const pattern = new RegExp('\\.(?:' + joined + ')\\(\\s*([0-9]+)\\s*,\\s*([\\"\\\'`])([\\s\\S]*?)\\2', 'g');
  for (const match of script.matchAll(pattern)) {
    inputs.push({ ref: Number(match[1]), text: unescapeJs(match[3]) });
  }
  return inputs;
}

function extractObjectTextInputs(script: string, names: string[]) {
  const joined = names.join('|');
  const inputs: Array<{ ref: number; text: string }> = [];
  const pattern = new RegExp(`\\.(?:${joined})\\(\\s*\\{([\\s\\S]*?)\\}\\s*\\)`, 'g');
  for (const match of script.matchAll(pattern)) {
    const body = match[1];
    const refMatch = body.match(/(?:index|ref)\s*:\s*([0-9]+)/);
    const textMatch = body.match(/(?:text|value|option)\s*:\s*(["'`])([\s\S]*?)\1/);
    if (refMatch && textMatch) {
      inputs.push({ ref: Number(refMatch[1]), text: unescapeJs(textMatch[2]) });
    }
  }
  return inputs;
}

function extractStringCalls(script: string, names: string[]) {
  const joined = names.join('|');
  const values: string[] = [];
  const pattern = new RegExp('\\.(?:' + joined + ')\\(\\s*([\\"\\\'`])([\\s\\S]*?)\\1', 'g');
  for (const match of script.matchAll(pattern)) values.push(unescapeJs(match[2]));
  return values;
}

function countCalls(script: string, names: string[]) {
  const joined = names.join('|');
  return [...script.matchAll(new RegExp(`\\.(?:${joined})\\(`, 'g'))].length;
}

function unescapeJs(value: string) {
  return value.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\'/g, "'");
}

function str(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown) {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function bool(value: unknown) {
  return typeof value === 'boolean' ? value : undefined;
}

function stringOrNumber(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}
