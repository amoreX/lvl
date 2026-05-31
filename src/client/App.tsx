import { useEffect, useMemo, useState } from 'react';
import type {
  AnalyticsSummary,
  AppState,
  CreateMatchInput,
  HarnessConfig,
  MatchDetail,
  MatchRecord,
  ModelConfig,
  RunRecord,
  TaskConfig,
} from '../shared/types.js';

type Bootstrap = Pick<AppState, 'models' | 'harnesses' | 'tasks' | 'matches' | 'runs'>;

const api = {
  async bootstrap(): Promise<Bootstrap> {
    return request('/api/bootstrap');
  },
  async analytics(): Promise<AnalyticsSummary> {
    return request('/api/analytics');
  },
  async createMatch(input: CreateMatchInput): Promise<MatchRecord> {
    return request('/api/matches', { method: 'POST', body: JSON.stringify(input) });
  },
  async match(id: string): Promise<MatchDetail> {
    return request(`/api/matches/${id}`);
  },
  async cancel(id: string): Promise<MatchDetail> {
    return request(`/api/matches/${id}/cancel`, { method: 'POST' });
  },
};

export function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null);
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MatchDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const [boot, summary] = await Promise.all([api.bootstrap(), api.analytics()]);
      setData(boot);
      setAnalytics(summary);
      if (!selectedMatchId && boot.matches[0]) setSelectedMatchId(boot.matches[0].id);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 1600);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!selectedMatchId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const next = await api.match(selectedMatchId!);
        if (!cancelled) setDetail(next);
      } catch {
        if (!cancelled) setDetail(null);
      }
    }
    void load();
    const interval = window.setInterval(() => void load(), 1200);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [selectedMatchId]);

  if (!data) {
    return <Shell error={error}><div className="loading">Starting the arena...</div></Shell>;
  }

  return (
    <Shell error={error}>
      <section className="hero">
        <div>
          <p className="eyebrow">Local evidence-first agent evals</p>
          <h1>Run the match. Watch the trace. Score the proof.</h1>
        </div>
        <div className="heroStats">
          <Metric label="matches" value={analytics?.totals.matches ?? 0} />
          <Metric label="completed runs" value={analytics?.totals.completedRuns ?? 0} />
          <Metric label="avg score" value={analytics?.totals.avgScore ?? 0} />
        </div>
      </section>

      <main className="layout">
        <section className="panel compose">
          <h2>New Match</h2>
          <MatchForm
            models={data.models}
            harnesses={data.harnesses}
            tasks={data.tasks}
            onCreated={(match) => {
              setSelectedMatchId(match.id);
              void refresh();
            }}
          />
        </section>

        <section className="panel matches">
          <div className="panelHead">
            <h2>Matches</h2>
            <button className="subtle" onClick={() => void refresh()}>Refresh</button>
          </div>
          <MatchList
            matches={data.matches}
            runs={data.runs}
            selected={selectedMatchId}
            onSelect={setSelectedMatchId}
          />
        </section>

        <section className="panel replay">
          {detail ? (
            <MatchReplay
              detail={detail}
              onCancel={async () => {
                await api.cancel(detail.match.id);
                await refresh();
              }}
            />
          ) : (
            <EmptyReplay />
          )}
        </section>

        <section className="panel analytics">
          <h2>Analytics</h2>
          <Analytics analytics={analytics} />
        </section>
      </main>
    </Shell>
  );
}

function Shell({ children, error }: { children: React.ReactNode; error?: string | null }) {
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="mark">lvl</span>
          <span>lvl</span>
        </div>
        <span className="status">local arena</span>
      </header>
      {error ? <div className="error">{error}</div> : null}
      {children}
    </div>
  );
}

function MatchForm({
  models,
  harnesses,
  tasks,
  onCreated,
}: {
  models: ModelConfig[];
  harnesses: HarnessConfig[];
  tasks: TaskConfig[];
  onCreated: (match: MatchRecord) => void;
}) {
  const defaultHarness = harnesses[0]?.id ?? '';
  const defaultTask = tasks.find((task) => task.id === 'target-grid-duel') ?? tasks[0];
  const [form, setForm] = useState<CreateMatchInput>({
    name: 'Target grid duel',
    taskId: defaultTask?.id ?? '',
    agentA: { modelId: models[0]?.id ?? '', harnessId: defaultHarness },
    agentB: { modelId: models[1]?.id ?? models[0]?.id ?? '', harnessId: defaultHarness },
    seed: 818,
    runMode: 'parallel',
    hurdlesEnabled: true,
    maxSteps: defaultTask?.maxSteps ?? 10,
    maxToolCalls: defaultTask?.maxToolCalls ?? 30,
  });
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const match = await api.createMatch(form);
      onCreated(match);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="form">
      <label>
        Match name
        <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </label>
      <label>
        Task
        <select value={form.taskId} onChange={(event) => setForm({ ...form, taskId: event.target.value })}>
          {tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
        </select>
      </label>
      <div className="duo">
        <AgentSelect label="Agent A" models={models} harnesses={harnesses} value={form.agentA} onChange={(agentA) => setForm({ ...form, agentA })} />
        <AgentSelect label="Agent B" models={models} harnesses={harnesses} value={form.agentB} onChange={(agentB) => setForm({ ...form, agentB })} />
      </div>
      <div className="duo compact">
        <label>
          Seed
          <input type="number" value={form.seed ?? ''} onChange={(event) => setForm({ ...form, seed: Number(event.target.value) })} />
        </label>
        <label>
          Run mode
          <select value={form.runMode} onChange={(event) => setForm({ ...form, runMode: event.target.value as CreateMatchInput['runMode'] })}>
            <option value="parallel">Parallel</option>
            <option value="sequential">Sequential</option>
          </select>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={form.hurdlesEnabled} onChange={(event) => setForm({ ...form, hurdlesEnabled: event.target.checked })} />
        Enable deterministic hurdles
      </label>
      <button disabled={submitting}>{submitting ? 'Launching...' : 'Create and Run Match'}</button>
    </form>
  );
}

function AgentSelect({
  label,
  models,
  harnesses,
  value,
  onChange,
}: {
  label: string;
  models: ModelConfig[];
  harnesses: HarnessConfig[];
  value: { modelId: string; harnessId: string };
  onChange: (value: { modelId: string; harnessId: string }) => void;
}) {
  return (
    <fieldset>
      <legend>{label}</legend>
      <select value={value.modelId} onChange={(event) => onChange({ ...value, modelId: event.target.value })}>
        {models.map((model) => (
          <option key={model.id} value={model.id}>{model.name}{model.enabled ? '' : ' (needs key)'}</option>
        ))}
      </select>
      <select value={value.harnessId} onChange={(event) => onChange({ ...value, harnessId: event.target.value })}>
        {harnesses.map((harness) => <option key={harness.id} value={harness.id}>{harness.name}</option>)}
      </select>
    </fieldset>
  );
}

function MatchList({
  matches,
  runs,
  selected,
  onSelect,
}: {
  matches: MatchRecord[];
  runs: RunRecord[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  if (!matches.length) return <p className="muted">No matches yet. Launch the first match.</p>;
  return (
    <div className="matchList">
      {matches.map((match) => {
        const matchRuns = runs.filter((run) => run.matchId === match.id);
        const best = Math.max(0, ...matchRuns.map((run) => run.scorecard?.total ?? 0));
        return (
          <button key={match.id} className={`matchRow ${selected === match.id ? 'active' : ''}`} onClick={() => onSelect(match.id)}>
            <span>
              <strong>{match.name}</strong>
              <small>{match.runMode} · seed {match.seed}</small>
            </span>
            <span className={`pill ${match.status}`}>{match.status}</span>
            <span className="score">{best.toFixed(1)}</span>
          </button>
        );
      })}
    </div>
  );
}

function MatchReplay({ detail, onCancel }: { detail: MatchDetail; onCancel: () => Promise<void> }) {
  const [runId, setRunId] = useState(detail.runs[0]?.id ?? '');
  const run = useMemo(() => detail.runs.find((item) => item.id === runId) ?? detail.runs[0], [detail, runId]);

  useEffect(() => {
    if (detail.runs[0] && !detail.runs.some((item) => item.id === runId)) {
      setRunId(detail.runs[0].id);
    }
  }, [detail, runId]);

  return (
    <div>
      <div className="panelHead">
        <div>
          <h2>{detail.match.name}</h2>
          <p className="muted">
            {detail.task.title} · seed {detail.match.seed} ·{' '}
            <a href={`/task-pages/${detail.task.id}?seed=${detail.match.seed}`} target="_blank" rel="noreferrer">open game page</a>
          </p>
        </div>
        {detail.match.status === 'running' || detail.match.status === 'queued'
          ? <button className="danger" onClick={() => window.confirm('Cancel this match and preserve the partial trace?') && void onCancel()}>Cancel</button>
          : <span className={`pill ${detail.match.status}`}>{detail.match.status}</span>}
      </div>

      <div className="runTabs">
        {detail.runs.map((item) => (
          <button key={item.id} className={item.id === run?.id ? 'active' : ''} onClick={() => setRunId(item.id)}>
            {item.role === 'agentA' ? 'Agent A' : 'Agent B'} · {item.model?.name}
          </button>
        ))}
      </div>

      {run ? <RunTrace run={run} /> : <p className="muted">No run selected.</p>}
    </div>
  );
}

function RunTrace({ run }: { run: MatchDetail['runs'][number] }) {
  return (
    <div className="traceGrid">
      <aside className="scorecard">
        <span className={`pill ${run.status}`}>{run.status}</span>
        <Metric label="score" value={run.scorecard?.total ?? 0} />
        <Metric label="steps" value={run.stepCount} />
        <Metric label="tool calls" value={run.toolCallCount} />
        <Metric label="cost" value={`$${run.costUsd.toFixed(4)}`} />
        {run.scorecard ? (
          <div className="breakdown">
            <Bar label="success" value={run.scorecard.taskSuccess} />
            <Bar label="efficiency" value={run.scorecard.efficiency} />
            <Bar label="robustness" value={run.scorecard.robustness} />
            <Bar label="progress" value={run.scorecard.progress} />
            <Bar label="tool use" value={run.scorecard.toolUseQuality} />
          </div>
        ) : null}
        {run.failureLabels.length ? <p className="labels">{run.failureLabels.join(', ')}</p> : null}
      </aside>
      <div className="timeline">
        {run.steps.length ? run.steps.map((step) => (
          <article key={step.id} className="step">
            <header>
              <strong>Step {step.stepIndex + 1}</strong>
              <span>{step.toolCall?.actions.map((action) => action.action).join(', ') || 'state'}</span>
            </header>
            {step.observation.screenshotDataUrl ? (
              <img className="screenshot" src={step.observation.screenshotDataUrl} alt={`Browser screenshot for step ${step.stepIndex + 1}`} />
            ) : null}
            <pre>{step.observation.elementTree}</pre>
            <details>
              <summary>Model output</summary>
              <code>{step.modelOutput.rawText}</code>
            </details>
            {step.scoreEvents.map((event) => (
              <p key={event.id} className={event.delta >= 0 ? 'event good' : 'event bad'}>
                {event.delta >= 0 ? '+' : ''}{event.delta} {event.dimension}: {event.reason}
              </p>
            ))}
          </article>
        )) : <p className="muted">Trace will appear as soon as the first step completes.</p>}
      </div>
    </div>
  );
}

function Analytics({ analytics }: { analytics: AnalyticsSummary | null }) {
  if (!analytics) return <p className="muted">Analytics loading...</p>;
  return (
    <div className="analyticsList">
      <div className="chartGrid">
        <ChartCard title="Score distribution">
          {analytics.scoreDistribution.map((bucket) => (
            <Bar key={bucket.bucket} label={bucket.bucket} value={analytics.totals.completedRuns ? (bucket.runs / analytics.totals.completedRuns) * 100 : 0} suffix={`${bucket.runs}`} />
          ))}
        </ChartCard>
        <ChartCard title="Failure labels">
          {Object.entries(analytics.failureLabels).length ? Object.entries(analytics.failureLabels).map(([label, count]) => (
            <Bar key={label} label={label} value={analytics.totals.completedRuns ? (count / analytics.totals.completedRuns) * 100 : 0} suffix={`${count}`} />
          )) : <p className="muted">No failures yet.</p>}
        </ChartCard>
      </div>
      {analytics.byModel.filter((model) => model.runs > 0).map((model) => (
        <div key={model.modelId} className="analyticsRow">
          <div>
            <strong>{model.name}</strong>
            <small>{model.runs} runs · {model.wins} wins · Elo {model.elo} · ${model.avgCostUsd.toFixed(4)} avg cost</small>
          </div>
          <Bar label="avg score" value={model.avgScore} />
        </div>
      ))}
      <div className="chartGrid">
        <ChartCard title="Task success">
          {analytics.byTask.filter((task) => task.runs > 0).map((task) => (
            <Bar key={task.taskId} label={task.title} value={task.successRate} suffix={`${task.successRate}%`} />
          ))}
        </ChartCard>
        <ChartCard title="Model Elo">
          {analytics.byModel.filter((model) => model.runs > 0).map((model) => (
            <Bar key={model.modelId} label={model.name} value={Math.max(0, Math.min(100, (model.elo - 900) / 2))} suffix={`${model.elo}`} />
          ))}
        </ChartCard>
      </div>
      {!analytics.byModel.some((model) => model.runs > 0) ? <p className="muted">Run a match to populate charts.</p> : null}
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="chartCard">
      <h3>{title}</h3>
      <div className="breakdown">{children}</div>
    </section>
  );
}

function EmptyReplay() {
  return (
    <div className="emptyReplay">
      <h2>No match selected</h2>
      <p>Create a match or pick one from the list to inspect the trace.</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div className="metric"><strong>{value}</strong><span>{label}</span></div>;
}

function Bar({ label, value, suffix }: { label: string; value: number; suffix?: string }) {
  return (
    <div className="bar">
      <span>{label}</span>
      <div><i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>
      <b>{suffix ?? value.toFixed(0)}</b>
    </div>
  );
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}
