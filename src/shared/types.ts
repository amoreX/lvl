export type EntityStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_model'
  | 'executing_tool'
  | 'scoring'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type RunMode = 'sequential' | 'parallel';

export type ModelProvider = 'dummy' | 'openrouter' | 'manual';

export type BrowserToolInput =
  | {
      mode: 'state';
      tab_id?: number | string;
      include_text?: boolean;
      include_screenshot?: boolean;
      max_length?: number;
      max_elements?: number;
      group_title?: string;
    }
  | {
      mode: 'run';
      tab_id?: number | string;
      max_actions?: number;
      script: string;
    };

export type BrowserActionLog = {
  action: string;
  tab_id?: number | string | null;
  successful: boolean;
  error?: string | null;
};

export type ModelConfig = {
  id: string;
  provider: ModelProvider;
  name: string;
  version: string;
  description: string;
  defaultModel?: string;
  enabled: boolean;
};

export type HarnessConfig = {
  id: string;
  name: string;
  version: string;
  description: string;
  systemPromptHash: string;
  toolSchemaHash: string;
};

export type HurdleConfig = {
  id: string;
  type: 'popup' | 'moving_target' | 'tool_failure';
  stepIndex: number;
  payload: Record<string, unknown>;
};

export type TaskConfig = {
  id: string;
  title: string;
  version: string;
  environment: 'chromium_game';
  instructions: string;
  maxSteps: number;
  maxToolCalls: number;
  difficulty: 'easy' | 'medium' | 'hard';
  allowedTools: string[];
  hurdles: HurdleConfig[];
  objective: {
    kind: 'checkout' | 'target_game';
    targetScore?: number;
  };
};

export type CreateMatchInput = {
  name: string;
  taskId: string;
  agentA: { modelId: string; harnessId: string };
  agentB: { modelId: string; harnessId: string };
  seed?: number;
  runMode: RunMode;
  maxSteps?: number;
  maxToolCalls?: number;
  hurdlesEnabled: boolean;
};

export type MatchRecord = {
  id: string;
  name: string;
  taskId: string;
  seed: number;
  runMode: RunMode;
  status: EntityStatus;
  maxSteps: number;
  maxToolCalls: number;
  hurdlesEnabled: boolean;
  runIds: string[];
  winnerRunId?: string | null;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  error?: string;
};

export type RunRecord = {
  id: string;
  matchId: string;
  role: 'agentA' | 'agentB';
  modelId: string;
  harnessId: string;
  taskId: string;
  seed: number;
  status: RunStatus;
  stepCount: number;
  toolCallCount: number;
  costUsd: number;
  latencyMs: number;
  scorecard?: Scorecard;
  failureLabels: string[];
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  error?: string;
};

export type Observation = {
  url: string;
  title: string;
  stepIndex: number;
  instructions: string;
  text: string;
  elementTree: string;
  elements: Array<{
    ref: number;
    role: string;
    label: string;
    state?: string;
  }>;
  hurdle?: HurdleConfig | null;
  screenshotDataUrl?: string;
  pageState: Record<string, unknown>;
};

export type ModelInput = {
  system: string;
  observation: Observation;
  budget: {
    maxTokens: number;
    maxToolCalls: number;
    timeoutMs: number;
  };
  metadata: {
    runId: string;
    seed: number;
    stepIndex: number;
    modelId: string;
    harnessId: string;
  };
};

export type ModelOutput = {
  rawText: string;
  browserTool?: BrowserToolInput;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  latencyMs: number;
  costUsd: number;
};

export type ToolCallRecord = {
  id: string;
  runId: string;
  stepIndex: number;
  toolName: 'browser';
  input: BrowserToolInput;
  actions: BrowserActionLog[];
  success: boolean;
  latencyMs: number;
  error?: string | null;
};

export type ScoreEvent = {
  id: string;
  runId: string;
  stepIndex: number;
  dimension: keyof ScorecardBreakdown | 'task_success' | 'failure';
  delta: number;
  reason: string;
};

export type TraceStep = {
  id: string;
  runId: string;
  stepIndex: number;
  observation: Observation;
  modelOutput: ModelOutput;
  toolCall?: ToolCallRecord;
  scoreEvents: ScoreEvent[];
  createdAt: string;
};

export type ScorecardBreakdown = {
  taskSuccess: number;
  efficiency: number;
  robustness: number;
  progress: number;
  toolUseQuality: number;
  consistency: number | null;
};

export type Scorecard = ScorecardBreakdown & {
  total: number;
  costUsd: number;
  latencyMs: number;
  failureLabels: string[];
  rubricVersion: string;
};

export type AppState = {
  models: ModelConfig[];
  harnesses: HarnessConfig[];
  tasks: TaskConfig[];
  matches: MatchRecord[];
  runs: RunRecord[];
  steps: TraceStep[];
};

export type RatingRecord = {
  entityId: string;
  ratingType: 'model_elo';
  value: number;
  games: number;
  updatedAt: string;
};

export type MatchDetail = {
  match: MatchRecord;
  task: TaskConfig;
  runs: Array<RunRecord & {
    model?: ModelConfig;
    harness?: HarnessConfig;
    steps: TraceStep[];
  }>;
};

export type AnalyticsSummary = {
  totals: {
    matches: number;
    runs: number;
    completedRuns: number;
    avgScore: number;
    avgCostUsd: number;
  };
  byModel: Array<{
    modelId: string;
    name: string;
    runs: number;
    wins: number;
    avgScore: number;
    elo: number;
    avgCostUsd: number;
    avgLatencyMs: number;
    failureLabels: Record<string, number>;
  }>;
  byTask: Array<{
    taskId: string;
    title: string;
    runs: number;
    avgScore: number;
    successRate: number;
  }>;
  scoreDistribution: Array<{
    bucket: string;
    runs: number;
  }>;
  failureLabels: Record<string, number>;
};
