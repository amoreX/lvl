import { randomUUID } from 'node:crypto';
import type {
  BrowserActionLog,
  BrowserToolInput,
  HurdleConfig,
  Observation,
  ScoreEvent,
  TaskConfig,
  ToolCallRecord,
} from '../shared/types.js';

type PageState = {
  popupOpen: boolean;
  cart: boolean;
  confirmed: boolean;
  decoyClicked: boolean;
  wrongClicks: number;
  toolFailures: number;
  clickedRefs: number[];
};

export class SimpleBrowserEnvironment {
  private state: PageState = {
    popupOpen: false,
    cart: false,
    confirmed: false,
    decoyClicked: false,
    wrongClicks: 0,
    toolFailures: 0,
    clickedRefs: [],
  };

  constructor(
    private readonly task: TaskConfig,
    private readonly seed: number,
    private readonly hurdlesEnabled: boolean,
  ) {}

  reset(): Observation {
    this.state = {
      popupOpen: false,
      cart: false,
      confirmed: false,
      decoyClicked: false,
      wrongClicks: 0,
      toolFailures: 0,
      clickedRefs: [],
    };
    return this.observe(0);
  }

  async executeBrowserTool(input: BrowserToolInput, runId: string, stepIndex: number): Promise<{
    toolCall: ToolCallRecord;
    observation: Observation;
    scoreEvents: ScoreEvent[];
    done: boolean;
  }> {
    const started = Date.now();
    const actions: BrowserActionLog[] = [];
    const scoreEvents: ScoreEvent[] = [];
    let success = true;
    let error: string | null = null;

    try {
      this.applyHurdle(stepIndex, scoreEvents, runId);
      if (input.mode === 'state') {
        actions.push({ action: 'get_content', successful: true, tab_id: 'simulated' });
      } else {
        const maxActions = Math.min(Math.max(input.max_actions || 3, 1), 12);
        const refs = extractClickRefs(input.script).slice(0, maxActions);
        if (!refs.length && /snapshot|currentTab|tabs/.test(input.script)) {
          actions.push({ action: 'get_content', successful: true, tab_id: 'simulated' });
        }
        for (const ref of refs) {
          const result = this.click(ref, stepIndex, runId);
          actions.push(result.action);
          scoreEvents.push(...result.scoreEvents);
        }
      }
    } catch (caught) {
      success = false;
      error = caught instanceof Error ? caught.message : String(caught);
      actions.push({ action: 'browser_runtime', successful: false, error, tab_id: 'simulated' });
      scoreEvents.push(scoreEvent(runId, stepIndex, 'failure', -8, error));
    }

    const observation = this.observe(stepIndex + 1);
    const done = this.state.confirmed || stepIndex + 1 >= this.task.maxSteps;
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

  currentState() {
    return {
      ...this.state,
      clickedRefs: [...this.state.clickedRefs],
    };
  }

  private applyHurdle(stepIndex: number, events: ScoreEvent[], runId: string) {
    if (!this.hurdlesEnabled) return;
    const hurdle = this.task.hurdles.find((item) => item.stepIndex === stepIndex);
    if (!hurdle) return;
    if (hurdle.type === 'popup') {
      this.state.popupOpen = true;
      events.push(scoreEvent(runId, stepIndex, 'robustness', 0, `Hurdle injected: ${hurdle.id}`));
    }
  }

  private click(ref: number, stepIndex: number, runId: string) {
    const scoreEvents: ScoreEvent[] = [];
    this.state.clickedRefs.push(ref);

    if (this.state.popupOpen && ref !== 7) {
      this.state.wrongClicks += 1;
      scoreEvents.push(scoreEvent(runId, stepIndex, 'robustness', -12, 'Clicked behind popup instead of closing it.'));
      return {
        action: { action: 'click', tab_id: 'simulated', successful: true },
        scoreEvents,
      };
    }

    if (ref === 7 && this.state.popupOpen) {
      this.state.popupOpen = false;
      scoreEvents.push(scoreEvent(runId, stepIndex, 'robustness', 12, 'Closed injected popup.'));
      return {
        action: { action: 'click', tab_id: 'simulated', successful: true },
        scoreEvents,
      };
    }

    if (ref === 1) {
      this.state.cart = true;
      scoreEvents.push(scoreEvent(runId, stepIndex, 'progress', 20, 'Added item to cart.'));
    } else if (ref === 2 && this.state.cart) {
      this.state.confirmed = true;
      scoreEvents.push(scoreEvent(runId, stepIndex, 'task_success', 100, 'Checkout confirmed.'));
    } else if (ref === 3 || ref === 9) {
      this.state.decoyClicked = true;
      this.state.wrongClicks += 1;
      scoreEvents.push(scoreEvent(runId, stepIndex, 'toolUseQuality', -15, 'Clicked a decoy target.'));
    } else {
      this.state.wrongClicks += 1;
      scoreEvents.push(scoreEvent(runId, stepIndex, 'toolUseQuality', -8, `Clicked non-progress ref ${ref}.`));
    }

    return {
      action: { action: 'click', tab_id: 'simulated', successful: true },
      scoreEvents,
    };
  }

  private observe(stepIndex: number): Observation {
    const hurdle = this.hurdlesEnabled
      ? this.task.hurdles.find((item) => item.stepIndex === stepIndex) ?? null
      : null;
    const elements = [
      { ref: 1, role: 'button', label: this.state.cart ? 'Added to cart' : 'Add to cart', state: this.state.cart ? 'disabled' : 'enabled' },
      { ref: 2, role: 'button', label: this.task.id === 'confirm-button-decoy' ? 'Confirm' : 'Confirm Checkout', state: this.state.cart ? 'enabled' : 'disabled' },
      { ref: 3, role: 'button', label: 'Cancel order decoy', state: 'enabled' },
      { ref: 4, role: 'text', label: this.state.confirmed ? 'Order confirmed' : 'Checkout pending' },
    ];
    if (this.state.popupOpen) {
      elements.unshift(
        { ref: 7, role: 'button', label: 'Close newsletter popup', state: 'enabled' },
        { ref: 9, role: 'button', label: 'Newsletter decoy: Claim discount', state: 'enabled' },
      );
    }
    const text = [
      'AgentGauntlet simulated shop',
      this.task.instructions,
      this.state.popupOpen ? 'Newsletter popup is blocking the page.' : 'No popup is blocking the page.',
      this.state.cart ? 'Cart contains the benchmark item.' : 'Cart is empty.',
      this.state.confirmed ? 'Order confirmed.' : 'Order not confirmed.',
    ].join('\n');

    return {
      url: `agentgauntlet://task/${this.task.id}`,
      title: this.task.title,
      stepIndex,
      instructions: this.task.instructions,
      text,
      elementTree: elements.map((el) => `[${el.ref}] ${el.role}: ${el.label} (${el.state ?? 'visible'})`).join('\n'),
      elements,
      hurdle,
      pageState: this.currentState(),
    };
  }
}

function extractClickRefs(script: string): number[] {
  const refs: number[] = [];
  for (const match of script.matchAll(/\.click(?:AndSnapshot)?\(\s*(\d+)/g)) {
    refs.push(Number(match[1]));
  }
  return refs;
}

function scoreEvent(
  runId: string,
  stepIndex: number,
  dimension: ScoreEvent['dimension'],
  delta: number,
  reason: string,
): ScoreEvent {
  return {
    id: randomUUID(),
    runId,
    stepIndex,
    dimension,
    delta,
    reason,
  };
}
