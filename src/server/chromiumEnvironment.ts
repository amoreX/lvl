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
        const refs = extractClickRefs(input.script).slice(0, maxActions);
        const keyInputs = extractKeys(input.script).slice(0, maxActions);
        const inputs = extractTextInputs(input.script).slice(0, maxActions);

        if (!refs.length && !keyInputs.length && !inputs.length && /snapshot|currentTab|tabs/.test(input.script)) {
          actions.push({ action: 'get_content', successful: true, tab_id: 'chromium' });
        }

        for (const inputAction of inputs) {
          await page.locator(`[data-lvl-ref="${inputAction.ref}"]`).fill(inputAction.text);
          actions.push({ action: 'input', tab_id: 'chromium', successful: true });
        }
        for (const keys of keyInputs) {
          await page.keyboard.press(keys);
          actions.push({ action: 'send_keys', tab_id: 'chromium', successful: true });
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
      if (event.type === 'checkout_confirmed') return scoreEvent(runId, stepIndex, 'task_success', 100, event.message);
      if (event.type === 'cart_added') return scoreEvent(runId, stepIndex, 'progress', 20, event.message);
      if (event.type === 'popup_closed') return scoreEvent(runId, stepIndex, 'robustness', 12, event.message);
      if (event.type === 'blocked_by_popup') return scoreEvent(runId, stepIndex, 'robustness', -12, event.message);
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
    ${task.objective.kind === 'target_game' ? renderTargetGame(targetScore) : renderCheckout()}
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
    const objective = ${JSON.stringify(task.objective.kind)};
    const state = {
      popupOpen: false,
      cart: false,
      confirmed: false,
      score: 0,
      targetScore,
      targetRef: refs[Math.abs(seed) % refs.length],
      wrongClicks: 0,
      decoyClicked: false,
      toolFailures: 0,
      clickedRefs: [],
      events: []
    };
    function event(type, message, ref) { state.events.push({ type, message, ref }); }
    function render() {
      document.getElementById('score-chip').textContent = objective === 'target_game' ? 'Score: ' + state.score + '/' + targetScore : (state.cart ? 'Cart ready' : 'Cart empty');
      document.getElementById('status-chip').textContent = state.confirmed ? 'Status: complete' : 'Status: running';
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
    render();
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

function extractClickRefs(script: string): number[] {
  const refs: number[] = [];
  for (const match of script.matchAll(/\.click(?:AndSnapshot)?\(\s*(\d+)/g)) refs.push(Number(match[1]));
  return refs;
}

function extractKeys(script: string): string[] {
  const keys: string[] = [];
  for (const match of script.matchAll(/\.keys\(\s*["']([^"']+)["']/g)) keys.push(match[1]);
  return keys;
}

function extractTextInputs(script: string): Array<{ ref: number; text: string }> {
  const inputs: Array<{ ref: number; text: string }> = [];
  for (const match of script.matchAll(/\.(?:input|safeInput)\(\s*(\d+)\s*,\s*["']([^"']*)["']/g)) {
    inputs.push({ ref: Number(match[1]), text: match[2] });
  }
  return inputs;
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
