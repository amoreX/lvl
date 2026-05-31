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

type BrowserGameState = {
  popupOpen: boolean;
  cart: boolean;
  confirmed: boolean;
  score: number;
  targetScore: number;
  targetRef: number;
  wrongClicks: number;
  decoyClicked: boolean;
  toolFailures: number;
  clickedRefs: number[];
  events: Array<{ type: string; ref?: number; message: string; delta?: number }>;
  selectedSquare?: string | null;
  chessMove?: string | null;
  proposedMove?: { from: string; to: string; promotion?: string } | null;
  fen?: string;
  turn?: 'w' | 'b';
  moveHistory?: string[];
  legalMoves?: string[];
  gameStatus?: string;
};

export class ChromiumGameEnvironment {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(
    private readonly task: TaskConfig,
    private readonly seed: number,
    private readonly hurdlesEnabled: boolean,
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
      await this.applyHurdle(stepIndex, runId, scoreEvents);
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
          const blockedByPopup = await page.evaluate((targetRef) => {
            if (window.__lvl.state.popupOpen && targetRef !== 7 && targetRef !== 9) {
              window.__lvl.blockedClick(targetRef);
              return true;
            }
            return false;
          }, ref);
          if (blockedByPopup) {
            actions.push({ action: 'click', tab_id: 'chromium', successful: true });
            continue;
          }
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
    const pageState = observation.pageState as Partial<BrowserGameState>;
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

  private async applyHurdle(stepIndex: number, runId: string, events: ScoreEvent[]) {
    if (!this.hurdlesEnabled) return;
    const hurdle = this.task.hurdles.find((item) => item.stepIndex === stepIndex);
    if (!hurdle) return;
    if (hurdle.type === 'popup') {
      await this.requirePage().evaluate(() => window.__lvl.showPopup());
      events.push(scoreEvent(runId, stepIndex, 'robustness', 0, `Hurdle injected: ${hurdle.id}`));
    }
    if (hurdle.type === 'moving_target') {
      await this.requirePage().evaluate(() => window.__lvl.moveTarget());
      events.push(scoreEvent(runId, stepIndex, 'robustness', 0, `Hurdle injected: ${hurdle.id}`));
    }
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
      hurdle: this.hurdlesEnabled ? this.task.hurdles.find((item) => item.stepIndex === stepIndex) ?? null : null,
      screenshotDataUrl: screenshot ? `data:image/png;base64,${screenshot.toString('base64')}` : undefined,
      pageState: data.pageState,
    };
  }

  private async flushPageEvents(runId: string, stepIndex: number) {
    const events = await this.requirePage().evaluate(() => window.__lvl.flushEvents());
    return events.map((event) => {
      if (event.type === 'target_hit') return scoreEvent(runId, stepIndex, 'progress', 22, event.message);
      if (event.type === 'game_won') return scoreEvent(runId, stepIndex, 'task_success', 100, event.message);
      if (event.type === 'chess_move_success') return scoreEvent(runId, stepIndex, 'task_success', 100, event.message);
      if (event.type === 'chess_selected') return scoreEvent(runId, stepIndex, 'progress', 5, event.message);
      if (event.type === 'chess_move_proposed') return scoreEvent(runId, stepIndex, 'progress', 0, event.message);
      if (event.type === 'checkout_confirmed') return scoreEvent(runId, stepIndex, 'task_success', 100, event.message);
      if (event.type === 'cart_added') return scoreEvent(runId, stepIndex, 'progress', 20, event.message);
      if (event.type === 'popup_closed') return scoreEvent(runId, stepIndex, 'robustness', 12, event.message);
      if (event.type === 'blocked_by_popup') return scoreEvent(runId, stepIndex, 'robustness', -12, event.message);
      if (event.type === 'chess_illegal') return scoreEvent(runId, stepIndex, 'toolUseQuality', -18, event.message);
      if (event.type === 'decoy_clicked') return scoreEvent(runId, stepIndex, 'toolUseQuality', -16, event.message);
      return scoreEvent(runId, stepIndex, 'toolUseQuality', -8, event.message);
    });
  }

  private requirePage() {
    if (!this.page) throw new Error('Chromium page is not initialized.');
    return this.page;
  }
}

export function renderTaskPage(task: TaskConfig, seed: number) {
  const targetScore = task.objective.targetScore ?? 3;
  const objective = task.objective.kind;
  const targetMove = task.objective.targetMove ?? 'e2e4';
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
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 16px; }
    .tile { height: 92px; }
    .target { background: #fef3c7; border-color: #d97706; }
    .decoy { background: #fee2e2; border-color: #ef4444; }
    .shop { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 20px; }
    .primary { background: #111827; color: #f9fafb; border-color: #111827; }
    .disabled { opacity: 0.55; }
    .popup { position: fixed; inset: 0; display: none; place-items: center; background: rgba(15, 23, 42, 0.38); padding: 24px; }
    .popup[data-open="true"] { display: grid; }
    .modal { width: min(420px, 100%); background: white; border-radius: 22px; border: 1px solid #cbd5e1; padding: 22px; box-shadow: 0 24px 60px rgba(15, 23, 42, 0.24); }
    .result { margin-top: 18px; padding: 14px; border-radius: 16px; background: #ecfdf5; color: #065f46; font-weight: 800; }
    .chess-wrap { display: grid; grid-template-columns: minmax(320px, 520px) minmax(220px, 1fr); gap: 20px; align-items: start; margin-top: 20px; }
    .board { display: grid; grid-template-columns: repeat(8, 1fr); border: 2px solid #334155; border-radius: 18px; overflow: hidden; aspect-ratio: 1; }
    .square { min-height: 44px; border: 0; border-radius: 0; font-size: clamp(24px, 5vw, 48px); display: grid; place-items: center; position: relative; }
    .light { background: #f1e3c4; }
    .dark { background: #8b5e34; color: #fff7ed; }
    .selected { outline: 4px solid #2563eb; outline-offset: -4px; }
    .target-square { box-shadow: inset 0 0 0 4px #16a34a; }
    .coord { position: absolute; left: 6px; bottom: 4px; font-size: 11px; font-weight: 800; opacity: 0.78; }
    .notation { border: 1px solid #cbd5e1; border-radius: 16px; padding: 14px; background: #f8fafc; }
    .replay-panel { grid-column: 1 / -1; border: 1px solid #cbd5e1; border-radius: 18px; padding: 16px; background: #fff7ed; }
    .replay-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; align-items: center; margin-bottom: 12px; }
    .replay-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .replay-controls button { min-height: 38px; padding: 8px 12px; }
    .replay-controls input { flex: 1 1 240px; accent-color: #d97706; }
    .replay-meta { display: grid; gap: 4px; margin-top: 10px; }
    .replay-meta strong { font-size: 18px; }
    .replay-meta span { color: #475569; }
    .live-dot { display: inline-flex; align-items: center; gap: 6px; color: #166534; font-weight: 800; }
    .live-dot::before { content: ""; width: 9px; height: 9px; border-radius: 999px; background: #22c55e; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(task.title)}</h1>
    <p>${escapeHtml(task.instructions)}</p>
    <div class="hud">
      <span class="chip" id="score-chip">Score: 0/${targetScore}</span>
      <span class="chip" id="status-chip">Status: running</span>
    </div>
    ${objective === 'target_game' ? renderTargetGame(targetScore) : objective === 'chess_move' || objective === 'chess_match' ? renderChess(targetMove, objective) : renderCheckout()}
    <div id="result" class="result" hidden>Objective complete.</div>
  </main>
  <div id="popup" class="popup" data-open="false">
    <div class="modal">
      <h2>Obstacle popup</h2>
      <p>This popup blocks the task until it is closed.</p>
      <button data-lvl-ref="7" data-label="Close obstacle popup" onclick="window.__lvl.closePopup()">Close obstacle popup</button>
      <button data-lvl-ref="9" data-label="Popup decoy trap" onclick="window.__lvl.decoy(9)">Popup decoy trap</button>
    </div>
  </div>
  <script>
    const refs = [11, 12, 13, 14, 15, 16, 17, 18, 19];
    const seed = ${JSON.stringify(seed)};
    const targetScore = ${JSON.stringify(targetScore)};
    const objective = ${JSON.stringify(objective)};
    const targetMove = ${JSON.stringify(targetMove)};
    const matchId = new URLSearchParams(window.location.search).get('matchId');
    const initialBoard = {
      a1: '♖', b1: '♘', c1: '♗', d1: '♕', e1: '♔', f1: '♗', g1: '♘', h1: '♖',
      a2: '♙', b2: '♙', c2: '♙', d2: '♙', e2: '♙', f2: '♙', g2: '♙', h2: '♙',
      a7: '♟', b7: '♟', c7: '♟', d7: '♟', e7: '♟', f7: '♟', g7: '♟', h7: '♟',
      a8: '♜', b8: '♞', c8: '♝', d8: '♛', e8: '♚', f8: '♝', g8: '♞', h8: '♜'
    };
    const state = {
      popupOpen: false,
      cart: false,
      confirmed: false,
      score: 0,
      targetScore,
      targetRef: refs[Math.abs(seed) % refs.length],
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
      decoyClicked: false,
      toolFailures: 0,
      clickedRefs: [],
      events: []
    };
    function event(type, message, ref) { state.events.push({ type, message, ref }); }
    function render() {
      document.getElementById('score-chip').textContent = objective === 'target_game'
        ? 'Score: ' + state.score + '/' + targetScore
        : objective === 'chess_match' || objective === 'chess_move'
          ? 'Turn: ' + (state.turn === 'w' ? 'White' : 'Black')
          : (state.cart ? 'Cart ready' : 'Cart empty');
      document.getElementById('status-chip').textContent = state.confirmed ? 'Status: complete' : 'Status: ' + state.gameStatus;
      document.getElementById('result').hidden = !state.confirmed;
      const popup = document.getElementById('popup');
      popup.dataset.open = String(state.popupOpen);
      for (const btn of document.querySelectorAll('[data-kind="tile"]')) {
        const ref = Number(btn.dataset.lvlRef);
        const isTarget = ref === state.targetRef;
        btn.className = 'tile ' + (isTarget ? 'target' : 'decoy');
        btn.textContent = isTarget ? 'Highlighted target tile' : 'Trap tile';
        btn.dataset.label = isTarget ? 'Highlighted target tile' : 'Trap tile';
      }
      const confirm = document.querySelector('[data-lvl-ref="2"]');
      if (confirm) {
        confirm.classList.toggle('disabled', !state.cart);
        confirm.dataset.label = state.cart ? 'Confirm Checkout' : 'Confirm Checkout disabled';
      }
      renderChessBoard();
    }
    function moveTarget() {
      const current = refs.indexOf(state.targetRef);
      state.targetRef = refs[(current + 4) % refs.length];
      render();
    }
    function guardPopup(ref) {
      if (state.popupOpen && ref !== 7 && ref !== 9) {
        state.wrongClicks++;
        state.clickedRefs.push(ref);
        event('blocked_by_popup', 'Clicked behind the active popup.', ref);
        return true;
      }
      return false;
    }
    window.__lvl = {
      state,
      showPopup() { state.popupOpen = true; render(); },
      moveTarget,
      closePopup() { state.popupOpen = false; event('popup_closed', 'Closed the obstacle popup.', 7); render(); },
      blockedClick(ref) { state.wrongClicks++; state.clickedRefs.push(ref); event('blocked_by_popup', 'Clicked behind the active popup.', ref); },
      addCart(ref) { if (guardPopup(ref)) return; state.cart = true; state.clickedRefs.push(ref); event('cart_added', 'Added item to cart.', ref); render(); },
      confirm(ref) { if (guardPopup(ref)) return; state.clickedRefs.push(ref); if (state.cart) { state.confirmed = true; event('checkout_confirmed', 'Checkout confirmed.', ref); } else { state.wrongClicks++; event('wrong_click', 'Tried to confirm before cart was ready.', ref); } render(); },
      decoy(ref) { state.decoyClicked = true; state.wrongClicks++; state.clickedRefs.push(ref); event('decoy_clicked', 'Clicked a decoy target.', ref); render(); },
      tile(ref) { if (guardPopup(ref)) return; state.clickedRefs.push(ref); if (ref === state.targetRef) { state.score++; event('target_hit', 'Clicked the highlighted target tile.', ref); if (state.score >= targetScore) { state.confirmed = true; event('game_won', 'Reached the target score.', ref); } moveTarget(); } else { state.wrongClicks++; state.decoyClicked = true; event('decoy_clicked', 'Clicked a trap tile instead of the target.', ref); render(); } },
      chessSquare(square, ref) { chessSquare(square, ref); },
      applyChessState(next) {
        state.board = next.board;
        state.fen = next.fen;
        state.turn = next.turn;
        state.moveHistory = next.moveHistory || [];
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
        const nodes = Array.from(document.querySelectorAll('[data-lvl-ref]')).filter((node) => {
          const el = node;
          if (state.popupOpen) return el.closest('#popup') || el.id === 'popup';
          return !el.closest('#popup');
        });
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
      if (objective !== 'chess_move' && objective !== 'chess_match') return;
      for (const btn of document.querySelectorAll('[data-square]')) {
        const square = btn.dataset.square;
        const piece = state.board[square] || '';
        btn.textContent = piece;
        btn.classList.toggle('selected', state.selectedSquare === square);
        btn.classList.toggle('target-square', objective === 'chess_move' && targetMove.slice(2) === square);
        const squareName = square;
        const pieceName = pieceNameFor(piece);
        const targetHint = squareName === targetMove.slice(0, 2)
          ? ' Source square for target move ' + targetMove + '.'
          : squareName === targetMove.slice(2)
            ? ' Destination square for target move ' + targetMove + '.'
            : '';
        btn.dataset.label = (piece ? pieceName + ' on ' + squareName : 'Empty square ' + squareName) + '.' + targetHint;
      }
      const selected = document.getElementById('selected-square');
      const played = document.getElementById('played-move');
      const history = document.getElementById('move-history');
      const legal = document.getElementById('legal-moves');
      if (selected) selected.textContent = state.selectedSquare || 'none';
      if (played) played.textContent = state.chessMove || 'none';
      if (history) history.textContent = state.moveHistory.length ? state.moveHistory.join(' ') : 'none';
      if (legal) legal.textContent = state.legalMoves.length ? state.legalMoves.join(', ') : 'none';
    }
    const replay = { frames: [], currentIndex: 0, playing: false, status: 'queued', pollTimer: null, playTimer: null };
    async function loadReplay(keepPosition) {
      if (!matchId || objective !== 'chess_match') return;
      const panel = document.getElementById('replay-panel');
      if (panel) panel.hidden = false;
      try {
        const response = await fetch('/api/matches/' + encodeURIComponent(matchId) + '/replay');
        if (!response.ok) throw new Error('Replay failed to load');
        const data = await response.json();
        const wasAtEnd = replay.currentIndex >= Math.max(0, replay.frames.length - 1);
        replay.frames = data.frames || [];
        replay.status = data.match?.status || 'queued';
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
      state.chessMove = frame.move || 'none';
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
      if (meta) meta.textContent = [frame.actor, frame.model, frame.move ? 'move ' + frame.move : '', frame.result].filter(Boolean).join(' · ');
      if (live) {
        live.textContent = replay.status === 'running' || replay.status === 'queued' ? 'Live match' : 'Final';
        live.className = replay.status === 'running' || replay.status === 'queued' ? 'live-dot' : '';
      }
    }
    function stepReplay(delta) {
      replay.playing = false;
      window.clearInterval(replay.playTimer);
      replay.currentIndex = Math.max(0, Math.min(replay.currentIndex + delta, Math.max(0, replay.frames.length - 1)));
      applyReplayFrame();
    }
    function toggleReplayPlayback() {
      replay.playing = !replay.playing;
      window.clearInterval(replay.playTimer);
      if (!replay.playing) return;
      replay.playTimer = window.setInterval(() => {
        if (replay.currentIndex >= replay.frames.length - 1) {
          replay.playing = false;
          window.clearInterval(replay.playTimer);
          return;
        }
        replay.currentIndex += 1;
        applyReplayFrame();
      }, 900);
    }
    function initReplay() {
      if (!matchId || objective !== 'chess_match') return;
      document.getElementById('replay-prev')?.addEventListener('click', () => stepReplay(-1));
      document.getElementById('replay-next')?.addEventListener('click', () => stepReplay(1));
      document.getElementById('replay-play')?.addEventListener('click', toggleReplayPlayback);
      document.getElementById('replay-start')?.addEventListener('click', () => { replay.currentIndex = 0; applyReplayFrame(); });
      document.getElementById('replay-end')?.addEventListener('click', () => { replay.currentIndex = Math.max(0, replay.frames.length - 1); applyReplayFrame(); });
      document.getElementById('replay-slider')?.addEventListener('input', (event) => { replay.playing = false; replay.currentIndex = Number(event.target.value); applyReplayFrame(); });
      window.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); stepReplay(-1); }
        if (event.key === 'ArrowRight') { event.preventDefault(); stepReplay(1); }
        if (event.key === 'Home') { event.preventDefault(); replay.currentIndex = 0; applyReplayFrame(); }
        if (event.key === 'End') { event.preventDefault(); replay.currentIndex = Math.max(0, replay.frames.length - 1); applyReplayFrame(); }
        if (event.key === ' ') { event.preventDefault(); toggleReplayPlayback(); }
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
      if (objective === 'chess_match') {
        state.proposedMove = { from: state.selectedSquare, to: square, promotion: 'q' };
        state.chessMove = move;
        state.selectedSquare = null;
        event('chess_move_proposed', 'Proposed chess move ' + move + '.', ref);
        render();
        return;
      }
      if (move === targetMove && isLegalOpeningMove(state.selectedSquare, square)) {
        state.board[square] = state.board[state.selectedSquare];
        delete state.board[state.selectedSquare];
        state.chessMove = move;
        state.selectedSquare = null;
        state.confirmed = true;
        event('chess_move_success', 'Played the requested chess move ' + move + '.', ref);
        render();
        return;
      }
      state.wrongClicks++;
      event('chess_illegal', 'Illegal or incorrect chess move ' + move + '; expected ' + targetMove + '.', ref);
      state.selectedSquare = piece && isTurnPiece(piece) ? square : null;
      render();
    }
    function isLegalOpeningMove(from, to) {
      return from === 'e2' && to === 'e4' && state.board.e2 === '♙' && !state.board.e3 && !state.board.e4;
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

function renderTargetGame(_targetScore: number) {
  return `<div class="grid">
    ${[11, 12, 13, 14, 15, 16, 17, 18, 19].map((ref) => `<button class="tile" data-kind="tile" data-lvl-ref="${ref}" data-label="Trap tile" onclick="window.__lvl.tile(${ref})">Tile</button>`).join('')}
  </div>`;
}

function renderCheckout() {
  return `<div class="shop">
    <button class="primary" data-lvl-ref="1" data-label="Add to cart" onclick="window.__lvl.addCart(1)">Add to cart</button>
    <button data-lvl-ref="2" data-label="Confirm Checkout disabled" onclick="window.__lvl.confirm(2)">Confirm Checkout</button>
    <button data-lvl-ref="3" data-label="Cancel order decoy" onclick="window.__lvl.decoy(3)">Cancel order decoy</button>
  </div>`;
}

function renderChess(targetMove: string, objective: TaskConfig['objective']['kind']) {
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
      <strong>Chess objective</strong>
      ${objective === 'chess_match'
        ? '<p>Choose a legal move from the displayed legal moves. Click the source square first, then the destination square.</p>'
        : `<p>Play <code>${escapeHtml(targetMove)}</code>: click the piece square first, then the destination square.</p>`}
      <p>Selected square: <code id="selected-square">none</code></p>
      <p>Played move: <code id="played-move">none</code></p>
      <p>Move history: <code id="move-history">none</code></p>
      <p>Legal moves: <code id="legal-moves">none</code></p>
    </div>
    <div class="replay-panel" id="replay-panel" hidden>
      <div class="replay-head">
        <strong>Match replay</strong>
        <span id="replay-live"></span>
      </div>
      <div class="replay-controls">
        <button id="replay-start" type="button">Start</button>
        <button id="replay-prev" type="button">← Prev</button>
        <button id="replay-play" type="button">Play</button>
        <button id="replay-next" type="button">Next →</button>
        <button id="replay-end" type="button">Latest</button>
        <input id="replay-slider" type="range" min="0" max="0" value="0" aria-label="Replay move" />
        <span id="replay-counter">0 / 0</span>
      </div>
      <div class="replay-meta">
        <strong id="replay-label">Loading replay...</strong>
        <span id="replay-meta">Use left and right arrow keys to step through moves.</span>
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
      state: BrowserGameState;
      showPopup(): void;
      moveTarget(): void;
      closePopup(): void;
      blockedClick(ref: number): void;
      addCart(ref: number): void;
      confirm(ref: number): void;
      decoy(ref: number): void;
      tile(ref: number): void;
      chessSquare(square: string, ref: number): void;
      applyChessState(input: {
        board: Record<string, string>;
        fen: string;
        turn: 'w' | 'b';
        moveHistory: string[];
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
        pageState: BrowserGameState;
      };
      flushEvents(): BrowserGameState['events'];
    };
  }
}
