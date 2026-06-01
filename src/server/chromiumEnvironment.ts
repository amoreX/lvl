import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type {
  BrowserActionLog,
  BrowserToolInput,
  Observation,
  ScoreEvent,
  TaskConfig,
  ToolCallRecord,
} from '../shared/types.js';
import { parseBrowserScript } from './browserActionParser.js';
import { config } from './config.js';

type ChessPageState = {
  confirmed: boolean;
  wrongClicks: number;
  toolFailures: number;
  clickedRefs: number[];
  events: Array<{ type: string; ref?: number; message: string }>;
  selectedSquare?: string | null;
  chessMove?: string | null;
  proposedMove?: { from: string; to: string; promotion?: string } | null;
  fen?: string;
  turn?: 'w' | 'b';
  moveHistory?: string[];
  legalMoves?: string[];
  gameStatus?: string;
  board: Record<string, string>;
};

export class ChromiumGameEnvironment {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(
    private readonly task: TaskConfig,
    private readonly seed: number,
  ) {}

  async reset(): Promise<Observation> {
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      viewport: { width: 1180, height: 820 },
      deviceScaleFactor: 1,
    });
    this.page = await this.context.newPage();
    await this.page.setContent(renderTaskPage(this.task, this.seed), { waitUntil: 'domcontentloaded' });
    return this.observe(0);
  }

  async dispose() {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.context = null;
    this.browser = null;
    this.page = null;
  }

  async currentObservation(stepIndex: number): Promise<Observation> {
    return this.observe(stepIndex);
  }

  async applyChessState(input: {
    board: Record<string, string>;
    fen: string;
    turn: 'w' | 'b';
    moveHistory: string[];
    legalMoves?: string[];
    gameStatus: string;
    confirmed?: boolean;
    clearSelection?: boolean;
  }) {
    await this.requirePage().evaluate((state) => {
      window.__lvl.applyChessState(state);
    }, input);
  }

  async executeBrowserTool(input: BrowserToolInput, runId: string, stepIndex: number): Promise<{
    toolCall: ToolCallRecord;
    observation: Observation;
    scoreEvents: ScoreEvent[];
    done: boolean;
  }> {
    const page = this.requirePage();
    const started = Date.now();
    const actions: BrowserActionLog[] = [];
    const scoreEvents: ScoreEvent[] = [];
    let success = true;
    let error: string | null = null;

    try {
      if (input.mode === 'state') {
        actions.push({ action: 'get_content', successful: true, tab_id: 'chromium' });
      } else {
        const maxActions = Math.min(Math.max(input.max_actions || config.browserMaxActionsPerCall, 1), config.browserMaxActionsPerCall);
        const parsed = parseBrowserScript(input.script);
        const refs = parsed.clicks.slice(0, maxActions);
        const keyInputs = parsed.keys.slice(0, maxActions);
        const inputs = parsed.inputs.slice(0, maxActions);
        const selects = parsed.selects.slice(0, maxActions);
        const coordinateClicks = parsed.coordinateClicks.slice(0, maxActions);

        if (!refs.length && !keyInputs.length && !inputs.length && !selects.length && !coordinateClicks.length && parsed.snapshots > 0) {
          actions.push({ action: 'get_content', successful: true, tab_id: 'chromium' });
        }

        for (const inputAction of inputs) {
          await page.locator(`[data-lvl-ref="${inputAction.ref}"]`).fill(inputAction.text);
          actions.push({ action: 'input', tab_id: 'chromium', successful: true });
        }
        for (const selectAction of selects) {
          await page.locator(`[data-lvl-ref="${selectAction.ref}"]`).selectOption({ label: selectAction.text }).catch(async () => {
            await page.locator(`[data-lvl-ref="${selectAction.ref}"]`).selectOption(selectAction.text);
          });
          actions.push({ action: 'select_dropdown', tab_id: 'chromium', successful: true });
        }
        for (const keys of keyInputs) {
          await page.keyboard.press(keys);
          actions.push({ action: 'send_keys', tab_id: 'chromium', successful: true });
        }
        for (const click of coordinateClicks) {
          await page.mouse.click(click.x, click.y);
          actions.push({ action: 'click_at', tab_id: 'chromium', successful: true });
        }
        for (const ref of refs) {
          await page.locator(`[data-lvl-ref="${ref}"]`).click({ timeout: 2000 });
          actions.push({ action: 'click', tab_id: 'chromium', successful: true });
        }
      }

      scoreEvents.push(...await this.flushPageEvents(runId, stepIndex));
    } catch (caught) {
      success = false;
      error = caught instanceof Error ? caught.message : String(caught);
      actions.push({ action: 'browser_runtime', tab_id: 'chromium', successful: false, error });
      scoreEvents.push(scoreEvent(runId, stepIndex, 'failure', -8, error));
      await page.evaluate(() => {
        window.__lvl.state.toolFailures += 1;
      }).catch(() => undefined);
    }

    const observation = await this.observe(stepIndex + 1);
    const pageState = observation.pageState as Partial<ChessPageState>;
    const done = Boolean(pageState.confirmed) || stepIndex + 1 >= this.task.maxSteps;

    return {
      toolCall: {
        id: randomUUID(),
        runId,
        stepIndex,
        toolName: 'browser',
        input,
        actions,
        success,
        latencyMs: Date.now() - started,
        error,
      },
      observation,
      scoreEvents,
      done,
    };
  }

  private async observe(stepIndex: number): Promise<Observation> {
    const page = this.requirePage();
    const data = await page.evaluate(() => window.__lvl.snapshot());
    const screenshot = await page.screenshot({ type: 'png', fullPage: false }).catch(() => null);
    return {
      url: page.url() || `chromium://task/${this.task.id}`,
      title: data.title,
      stepIndex,
      instructions: this.task.instructions,
      text: data.text,
      elementTree: data.elementTree,
      elements: data.elements,
      screenshotDataUrl: screenshot ? `data:image/png;base64,${screenshot.toString('base64')}` : undefined,
      pageState: data.pageState,
    };
  }

  private async flushPageEvents(runId: string, stepIndex: number) {
    const events = await this.requirePage().evaluate(() => window.__lvl.flushEvents());
    return events.map((event) => {
      if (event.type === 'chess_selected') return scoreEvent(runId, stepIndex, 'progress', 5, event.message);
      if (event.type === 'chess_move_proposed') return scoreEvent(runId, stepIndex, 'progress', 0, event.message);
      if (event.type === 'chess_illegal') return scoreEvent(runId, stepIndex, 'toolUseQuality', -18, event.message);
      return scoreEvent(runId, stepIndex, 'toolUseQuality', -8, event.message);
    });
  }

  private requirePage() {
    if (!this.page) throw new Error('Chromium page is not initialized.');
    return this.page;
  }
}

export function renderTaskPage(task: TaskConfig, seed: number) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(task.title)}</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; color: #0f172a; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px; }
    main { width: min(920px, 100%); border: 1px solid #cbd5e1; border-radius: 24px; background: #ffffff; box-shadow: 0 20px 40px rgba(15, 23, 42, 0.08); padding: 28px; }
    h1 { margin: 0 0 8px; font-size: 32px; line-height: 1.1; }
    p { color: #475569; font-size: 16px; line-height: 1.6; }
    button { min-height: 44px; border: 1px solid #94a3b8; border-radius: 14px; background: #f8fafc; color: #0f172a; font-weight: 700; cursor: pointer; }
    button:focus-visible { outline: 3px solid #f59e0b; outline-offset: 3px; }
    .hud { display: flex; flex-wrap: wrap; gap: 12px; margin: 20px 0; }
    .chip { border: 1px solid #cbd5e1; border-radius: 999px; padding: 8px 12px; font-weight: 700; }
    .result { margin-top: 18px; padding: 14px; border-radius: 16px; background: #ecfdf5; color: #065f46; font-weight: 800; }
    .chess-wrap { display: grid; grid-template-columns: minmax(320px, 520px) minmax(220px, 1fr); gap: 20px; align-items: center; margin-top: 20px; }
    .board { display: grid; grid-template-columns: repeat(8, 1fr); border: 2px solid #334155; border-radius: 18px; overflow: hidden; aspect-ratio: 1; }
    .square { min-height: 44px; border: 0; border-radius: 0; font-size: clamp(24px, 5vw, 48px); display: grid; place-items: center; position: relative; }
    .light { background: #f1e3c4; }
    .dark { background: #8b5e34; color: #fff7ed; }
    .selected { outline: 4px solid #2563eb; outline-offset: -4px; }
    .coord { position: absolute; left: 6px; bottom: 4px; font-size: 11px; font-weight: 800; opacity: 0.78; }
    .notation { border: 1px solid #cbd5e1; border-radius: 16px; padding: 14px; background: #f8fafc; max-height: min(620px, calc(100vh - 220px)); overflow: auto; }
    .replay-panel { margin-top: 16px; border-top: 1px solid #cbd5e1; padding-top: 14px; }
    .replay-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; align-items: center; margin-bottom: 12px; }
    .replay-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .replay-controls button { min-height: 38px; padding: 8px 12px; }
    .replay-controls input { flex: 1 1 240px; accent-color: #d97706; }
    .replay-meta { display: grid; gap: 4px; margin-top: 10px; }
    .replay-meta strong { font-size: 18px; }
    .replay-meta span { color: #475569; }
    .replay-log { display: grid; gap: 8px; margin-top: 14px; max-height: 260px; overflow: auto; padding-right: 2px; }
    .replay-log button { min-height: 0; display: grid; grid-template-columns: 68px minmax(0, 1fr) auto; gap: 8px; align-items: center; width: 100%; padding: 9px 10px; text-align: left; background: #fffaf0; }
    .replay-log button[aria-current="true"] { border-color: #d97706; background: #ffedd5; }
    .replay-log strong, .replay-log span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .replay-log small { color: #64748b; font-weight: 800; }
    .live-dot { display: inline-flex; align-items: center; gap: 6px; color: #166534; font-weight: 800; }
    .live-dot::before { content: ""; width: 9px; height: 9px; border-radius: 999px; background: #22c55e; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(task.title)}</h1>
    <p>${escapeHtml(task.instructions)}</p>
    <div class="hud">
      <span class="chip" id="score-chip">Turn: White</span>
      <span class="chip" id="status-chip">Status: running</span>
    </div>
    ${renderChess()}
    <div id="result" class="result" hidden>Objective complete.</div>
  </main>
  <script>
    const seed = ${JSON.stringify(seed)};
    const params = new URLSearchParams(window.location.search);
    const matchId = params.get('matchId');
    let gameIndex = Number(params.get('game') || 1);
    const initialBoard = {
      a1: '♖', b1: '♘', c1: '♗', d1: '♕', e1: '♔', f1: '♗', g1: '♘', h1: '♖',
      a2: '♙', b2: '♙', c2: '♙', d2: '♙', e2: '♙', f2: '♙', g2: '♙', h2: '♙',
      a7: '♟', b7: '♟', c7: '♟', d7: '♟', e7: '♟', f7: '♟', g7: '♟', h7: '♟',
      a8: '♜', b8: '♞', c8: '♝', d8: '♛', e8: '♚', f8: '♝', g8: '♞', h8: '♜'
    };
    const state = {
      confirmed: false,
      board: JSON.parse(JSON.stringify(initialBoard)),
      selectedSquare: null,
      chessMove: null,
      proposedMove: null,
      fen: 'start',
      turn: 'w',
      moveHistory: [],
      legalMoves: [],
      gameStatus: 'running',
      wrongClicks: 0,
      toolFailures: 0,
      clickedRefs: [],
      events: []
    };
    function event(type, message, ref) { state.events.push({ type, message, ref }); }
    function render() {
      document.getElementById('score-chip').textContent = 'Turn: ' + (state.turn === 'w' ? 'White' : 'Black');
      document.getElementById('status-chip').textContent = state.confirmed ? 'Status: complete' : 'Status: ' + state.gameStatus;
      document.getElementById('result').hidden = !state.confirmed;
      renderChessBoard();
    }
    window.__lvl = {
      state,
      chessSquare(square, ref) { chessSquare(square, ref); },
      applyChessState(next) {
        state.board = next.board;
        state.fen = next.fen;
        state.turn = next.turn;
        state.moveHistory = next.moveHistory || [];
        state.chessMove = next.lastMove || (state.moveHistory.length ? state.moveHistory[state.moveHistory.length - 1] : null);
        state.legalMoves = next.legalMoves || [];
        state.gameStatus = next.gameStatus || 'running';
        if (next.confirmed) state.confirmed = true;
        if (next.clearSelection !== false) {
          state.selectedSquare = null;
          state.proposedMove = null;
        }
        render();
      },
      snapshot() {
        const nodes = Array.from(document.querySelectorAll('[data-lvl-ref]'));
        const elements = nodes.map((el) => ({ ref: Number(el.dataset.lvlRef), role: el.tagName.toLowerCase() === 'button' ? 'button' : 'text', label: el.dataset.label || el.textContent.trim(), state: el.disabled ? 'disabled' : 'enabled' }));
        return {
          title: document.title,
          text: document.body.innerText,
          elementTree: elements.map((el) => '[' + el.ref + '] ' + el.role + ': ' + el.label + ' (' + el.state + ')').join('\\n'),
          elements,
          pageState: JSON.parse(JSON.stringify(state))
        };
      },
      flushEvents() { const out = state.events.slice(); state.events = []; return out; }
    };
    function renderChessBoard() {
      for (const btn of document.querySelectorAll('[data-square]')) {
        const square = btn.dataset.square;
        const piece = state.board[square] || '';
        btn.textContent = piece;
        btn.classList.toggle('selected', state.selectedSquare === square);
        btn.dataset.label = (piece ? pieceNameFor(piece) + ' on ' + square : 'Empty square ' + square) + '.';
      }
      const selected = document.getElementById('selected-square');
      const played = document.getElementById('played-move');
      const history = document.getElementById('move-history');
      if (selected) selected.textContent = state.selectedSquare || 'none';
      if (played) played.textContent = state.chessMove || 'none';
      if (history) history.textContent = state.moveHistory.length ? state.moveHistory.join(' ') : 'none';
    }
    const replay = { frames: [], currentIndex: 0, playing: false, status: 'queued', pollTimer: null, playTimer: null };
    async function loadReplay(keepPosition) {
      if (!matchId) return;
      const panel = document.getElementById('replay-panel');
      if (panel) panel.hidden = false;
      try {
        const response = await fetch('/api/matches/' + encodeURIComponent(matchId) + '/replay?game=' + encodeURIComponent(String(gameIndex)));
        if (!response.ok) throw new Error('Replay failed to load');
        const data = await response.json();
        const wasAtEnd = replay.currentIndex >= Math.max(0, replay.frames.length - 1);
        replay.frames = data.frames || [];
        replay.status = data.match?.status || 'queued';
        renderGamePicker(data.games || []);
        if (!keepPosition || wasAtEnd) replay.currentIndex = Math.max(0, replay.frames.length - 1);
        replay.currentIndex = Math.max(0, Math.min(replay.currentIndex, Math.max(0, replay.frames.length - 1)));
        applyReplayFrame();
      } catch (error) {
        const label = document.getElementById('replay-label');
        if (label) label.textContent = error instanceof Error ? error.message : String(error);
      }
    }
    function applyReplayFrame() {
      const frame = replay.frames[replay.currentIndex];
      if (!frame) return;
      state.board = frame.board || {};
      state.fen = frame.fen || 'start';
      state.turn = frame.turn || 'w';
      state.moveHistory = frame.moveHistory || [];
      state.legalMoves = frame.legalMoves || [];
      state.gameStatus = frame.status || replay.status || 'running';
      const displayMove = frame.san || frame.move || 'none';
      state.chessMove = displayMove;
      state.selectedSquare = null;
      render();
      const slider = document.getElementById('replay-slider');
      const counter = document.getElementById('replay-counter');
      const label = document.getElementById('replay-label');
      const meta = document.getElementById('replay-meta');
      const live = document.getElementById('replay-live');
      if (slider) {
        slider.max = String(Math.max(0, replay.frames.length - 1));
        slider.value = String(replay.currentIndex);
      }
      if (counter) counter.textContent = (replay.currentIndex + 1) + ' / ' + Math.max(1, replay.frames.length);
      if (label) label.textContent = frame.label || 'Position';
      if (meta) meta.textContent = [frame.actor, displayMove !== 'none' ? 'move ' + displayMove : '', frame.result].filter(Boolean).join(' · ');
      renderReplayLog();
      if (live) {
        live.textContent = replay.status === 'running' || replay.status === 'queued' ? 'Live match' : 'Final';
        live.className = replay.status === 'running' || replay.status === 'queued' ? 'live-dot' : '';
      }
    }
    function renderGamePicker(games) {
      const picker = document.getElementById('game-picker');
      const pgn = document.getElementById('pgn-link');
      if (pgn && matchId) pgn.href = '/api/matches/' + encodeURIComponent(matchId) + '/pgn?game=' + encodeURIComponent(String(gameIndex));
      if (!picker || picker.dataset.ready === 'true') return;
      picker.replaceChildren();
      for (const game of games) {
        const option = document.createElement('option');
        option.value = String(game.gameIndex);
        option.textContent = 'Game ' + game.gameIndex + ': ' + game.white + ' vs ' + game.black;
        option.selected = Number(game.gameIndex) === gameIndex;
        picker.appendChild(option);
      }
      picker.dataset.ready = 'true';
    }
    function renderReplayLog() {
      const log = document.getElementById('replay-log');
      if (!log) return;
      log.replaceChildren();
      const frames = replay.frames.slice(1);
      if (!frames.length) {
        const empty = document.createElement('span');
        empty.textContent = 'No moves recorded yet.';
        log.appendChild(empty);
        return;
      }
      for (const frame of frames) {
        const row = document.createElement('button');
        row.type = 'button';
        row.setAttribute('aria-current', String(frame.index === replay.currentIndex));
        row.addEventListener('click', () => {
          replay.playing = false;
          window.clearInterval(replay.playTimer);
          replay.currentIndex = frame.index;
          applyReplayFrame();
        });
        const actor = document.createElement('strong');
        actor.textContent = frame.actor || frame.model || 'Model';
        const move = document.createElement('span');
        move.textContent = [frame.model, frame.san || frame.move || frame.label].filter(Boolean).join(' · ');
        const result = document.createElement('small');
        result.textContent = frame.result || '';
        row.append(actor, move, result);
        log.appendChild(row);
      }
    }
    function stepReplay(delta) {
      replay.playing = false;
      window.clearInterval(replay.playTimer);
      replay.currentIndex = Math.max(0, Math.min(replay.currentIndex + delta, Math.max(0, replay.frames.length - 1)));
      applyReplayFrame();
    }
    function initReplay() {
      if (!matchId) return;
      document.getElementById('replay-start')?.addEventListener('click', () => { replay.currentIndex = 0; applyReplayFrame(); });
      document.getElementById('replay-end')?.addEventListener('click', () => { replay.currentIndex = Math.max(0, replay.frames.length - 1); applyReplayFrame(); });
      document.getElementById('game-picker')?.addEventListener('change', (event) => { gameIndex = Number(event.target.value || 1); replay.frames = []; replay.currentIndex = 0; loadReplay(false); });
      document.getElementById('replay-slider')?.addEventListener('input', (event) => { replay.playing = false; replay.currentIndex = Number(event.target.value); applyReplayFrame(); });
      window.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); stepReplay(-1); }
        if (event.key === 'ArrowRight') { event.preventDefault(); stepReplay(1); }
        if (event.key === 'Home') { event.preventDefault(); replay.currentIndex = 0; applyReplayFrame(); }
        if (event.key === 'End') { event.preventDefault(); replay.currentIndex = Math.max(0, replay.frames.length - 1); applyReplayFrame(); }
      });
      loadReplay(false);
      replay.pollTimer = window.setInterval(() => loadReplay(true), 1500);
    }
    function chessSquare(square, ref) {
      if (state.confirmed) return;
      state.clickedRefs.push(ref);
      const piece = state.board[square];
      if (!state.selectedSquare) {
        if (piece && isTurnPiece(piece)) {
          state.selectedSquare = square;
          event('chess_selected', 'Selected ' + pieceNameFor(piece) + ' on ' + square + '.', ref);
        } else {
          state.wrongClicks++;
          event('chess_illegal', 'Tried to select ' + square + ', but it is not a movable piece for the current turn.', ref);
        }
        render();
        return;
      }
      const move = state.selectedSquare + square;
      state.proposedMove = { from: state.selectedSquare, to: square, promotion: 'q' };
      state.chessMove = move;
      state.selectedSquare = null;
      event('chess_move_proposed', 'Proposed chess move ' + move + '.', ref);
      render();
    }
    function isWhitePiece(piece) {
      return ['♙','♖','♘','♗','♕','♔'].includes(piece);
    }
    function isBlackPiece(piece) {
      return ['♟','♜','♞','♝','♛','♚'].includes(piece);
    }
    function isTurnPiece(piece) {
      return state.turn === 'w' ? isWhitePiece(piece) : isBlackPiece(piece);
    }
    function pieceNameFor(piece) {
      return ({
        '♙': 'White pawn', '♖': 'White rook', '♘': 'White knight', '♗': 'White bishop', '♕': 'White queen', '♔': 'White king',
        '♟': 'Black pawn', '♜': 'Black rook', '♞': 'Black knight', '♝': 'Black bishop', '♛': 'Black queen', '♚': 'Black king'
      })[piece] || 'Empty square';
    }
    render();
    initReplay();
  </script>
</body>
</html>`;
}

function renderChess() {
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const ranks = [8, 7, 6, 5, 4, 3, 2, 1];
  const squares = ranks.flatMap((rank) => files.map((file, fileIndex) => {
    const square = `${file}${rank}`;
    const ref = chessRef(square);
    const color = (rank + fileIndex) % 2 === 0 ? 'dark' : 'light';
    return `<button class="square ${color}" data-lvl-ref="${ref}" data-square="${square}" data-label="Square ${square}" onclick="window.__lvl.chessSquare('${square}', ${ref})"><span class="coord">${square}</span></button>`;
  })).join('');
  return `<div class="chess-wrap">
    <div class="board" aria-label="Chess board">${squares}</div>
    <div class="notation">
      <p>Last move: <code id="played-move">none</code></p>
      <code id="move-history" hidden>none</code>
      <code id="selected-square" hidden>none</code>
      <div class="replay-panel" id="replay-panel" hidden>
        <div class="replay-head">
          <strong>Match replay</strong>
          <span id="replay-live"></span>
          <select id="game-picker" aria-label="Replay game"></select>
          <a id="pgn-link" href="#" download>PGN</a>
        </div>
        <div class="replay-controls">
          <button id="replay-start" type="button">Start</button>
          <button id="replay-end" type="button">Latest</button>
          <input id="replay-slider" type="range" min="0" max="0" value="0" aria-label="Replay move" />
          <span id="replay-counter">0 / 0</span>
        </div>
        <div class="replay-meta">
          <strong id="replay-label">Loading replay...</strong>
          <span id="replay-meta">Use left and right arrow keys to step through moves.</span>
        </div>
        <div class="replay-log" id="replay-log" aria-label="Full move log"></div>
      </div>
    </div>
  </div>`;
}

function chessRef(square: string) {
  const file = square.charCodeAt(0) - 96;
  const rank = Number(square[1]);
  return 200 + ((rank - 1) * 8) + file;
}

function scoreEvent(
  runId: string,
  stepIndex: number,
  dimension: ScoreEvent['dimension'],
  delta: number,
  reason: string,
): ScoreEvent {
  return { id: randomUUID(), runId, stepIndex, dimension, delta, reason };
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

declare global {
  interface Window {
    __lvl: {
      state: ChessPageState;
      chessSquare(square: string, ref: number): void;
      applyChessState(input: {
        board: Record<string, string>;
        fen: string;
        turn: 'w' | 'b';
        moveHistory: string[];
        lastMove?: string | null;
        legalMoves?: string[];
        gameStatus: string;
        confirmed?: boolean;
        clearSelection?: boolean;
      }): void;
      snapshot(): {
        title: string;
        text: string;
        elementTree: string;
        elements: Observation['elements'];
        pageState: ChessPageState;
      };
      flushEvents(): ChessPageState['events'];
    };
  }
}
