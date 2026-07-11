import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnalyticsSummary,
  AppState,
  CreateMatchInput,
  DaemonStatus,
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
  async daemonStatus(): Promise<DaemonStatus> {
    return request('/api/daemon/status');
  },
  async saveLocalSettings(input: { openRouterApiKey: string }): Promise<{ openRouterApiKeyConfigured: boolean }> {
    return request('/api/settings/local', { method: 'PUT', body: JSON.stringify(input) });
  },
  async searchOpenRouterModels(query: string): Promise<ModelConfig[]> {
    return request(`/api/models/openrouter?q=${encodeURIComponent(query)}`);
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
  async deleteMatch(id: string): Promise<void> {
    await request(`/api/matches/${id}`, { method: 'DELETE' });
  },
};

export function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null);
  const [daemonStatus, setDaemonStatus] = useState<DaemonStatus | null>(null);
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MatchDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const [boot, summary, daemon] = await Promise.all([api.bootstrap(), api.analytics(), api.daemonStatus()]);
      setData(boot);
      setAnalytics(summary);
      setDaemonStatus(daemon);
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
      <DaemonPanel
        status={daemonStatus}
        onSaved={async () => {
          await refresh();
        }}
      />
      <section className="hero">
        <div className="heroCopy">
          <div className="heroBrand">
            <span className="mark">lvl</span>
            <div>
              <strong>lvl</strong>
              <p className="eyebrow">Local evidence-first agent evals</p>
            </div>
          </div>
          <h1>Run the match. Watch the trace. Score the proof.</h1>
          <div className="heroStats">
            <Metric label="matches" value={analytics?.totals.matches ?? 0} />
            <Metric label="completed runs" value={analytics?.totals.completedRuns ?? 0} />
            <Metric label="avg score" value={analytics?.totals.avgScore ?? 0} />
          </div>
        </div>
        <div className="heroCompose">
          <h2>New Match</h2>
          <MatchForm
            models={data.models}
            harnesses={data.harnesses}
            tasks={data.tasks}
            onCreated={() => {
              setSelectedMatchId(null);
              void refresh();
            }}
          />
        </div>
      </section>

      <main className="layout">
        <section className="panel matches">
          <div className="panelHead">
            <h2>Matches</h2>
            <button className="subtle" onClick={() => void refresh()}>Refresh</button>
          </div>
          <MatchList
            matches={data.matches}
            runs={data.runs}
            models={data.models}
            selected={selectedMatchId}
            onSelect={setSelectedMatchId}
            onDelete={async (id) => {
              await api.deleteMatch(id);
              if (selectedMatchId === id) setSelectedMatchId(null);
              await refresh();
            }}
          />
        </section>
      </main>
      {detail ? (
        <MatchModal
          detail={detail}
          onClose={() => setSelectedMatchId(null)}
          onCancel={async () => {
            await api.cancel(detail.match.id);
            await refresh();
          }}
          onDelete={async () => {
            await api.deleteMatch(detail.match.id);
            setSelectedMatchId(null);
            await refresh();
          }}
        />
      ) : null}
    </Shell>
  );
}

function Shell({ children, error }: { children: React.ReactNode; error?: string | null }) {
  return (
    <div className="shell">
      {error ? <div className="error">{error}</div> : null}
      {children}
    </div>
  );
}

function DaemonPanel({ status, onSaved }: { status: DaemonStatus | null; onSaved: () => Promise<void> }) {
  const [openRouterApiKey, setOpenRouterApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const openRouterReady = Boolean(status?.openRouter.configured);

  async function saveKey(event: React.FormEvent) {
    event.preventDefault();
    if (!openRouterApiKey.trim()) return;
    setSaving(true);
    try {
      await api.saveLocalSettings({ openRouterApiKey });
      setOpenRouterApiKey('');
      setMessage('OpenRouter key saved locally.');
      await onSaved();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="daemonPanel">
      <div className="daemonHead">
        <div>
          <strong>Local daemon</strong>
          <span>{status?.connected ? 'connected' : 'connecting...'}</span>
        </div>
        <span className={`statusDot ${status?.worker.state === 'running' ? 'running' : 'idle'}`}>
          {status?.worker.state ?? 'unknown'}
        </span>
      </div>
      <div className="daemonGrid">
        <DaemonCheck label="Stockfish" ok={status?.stockfish.ok} detail={status?.stockfish.message ?? 'checking'} />
        <DaemonCheck label="Browser" ok={status?.browser.ok} detail={status?.browser.message ?? 'checking'} />
        <DaemonCheck
          label="OpenRouter"
          ok={openRouterReady}
          detail={openRouterReady ? `configured via ${status?.openRouter.source}` : 'key required'}
        />
        <DaemonCheck
          label="Worker"
          ok={Boolean(status)}
          detail={`${status?.worker.active ?? 0} active, ${status?.worker.queued ?? 0} queued`}
        />
      </div>
      {!openRouterReady ? (
        <form className="setupCard" onSubmit={saveKey}>
          <div>
            <strong>Bring your own OpenRouter key</strong>
            <span>Saved only to local ignored data. It is never committed or shipped with lvl.</span>
          </div>
          <input
            type="password"
            placeholder="sk-or-..."
            value={openRouterApiKey}
            onChange={(event) => setOpenRouterApiKey(event.target.value)}
            autoComplete="off"
          />
          <button disabled={saving || !openRouterApiKey.trim()}>{saving ? 'Saving...' : 'Save key'}</button>
        </form>
      ) : null}
      {message ? <p className="setupMessage">{message}</p> : null}
    </section>
  );
}

function DaemonCheck({ label, ok, detail }: { label: string; ok?: boolean; detail: string }) {
  return (
    <div className={`daemonCheck ${ok ? 'ok' : 'warn'}`}>
      <span>{label}</span>
      <strong>{ok ? 'ok' : 'needs setup'}</strong>
      <small>{detail}</small>
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
  const defaultHarness = harnesses[0]?.id ?? 'ghost-barebones';
  const defaultTask = tasks.find((task) => task.id === 'chess-full-match') ?? tasks[0];
  const selectableModels = models.filter((model) => model.provider === 'openrouter');
  const initialStarredModelIds = loadStoredIds('lvl.starredModels');
  const initialRecentModelIds = loadStoredIds('lvl.recentModels');
  const defaultModelIds = preferredModelIds(selectableModels, initialStarredModelIds, initialRecentModelIds);
  const defaultAgentA = defaultModelIds[0] ?? selectableModels[0]?.id ?? '';
  const defaultAgentB = defaultModelIds.find((id) => id !== defaultAgentA) ?? selectableModels[1]?.id ?? defaultAgentA;
  const [form, setForm] = useState<CreateMatchInput>({
    name: defaultTask?.title ?? 'Chess full match',
    taskId: defaultTask?.id ?? '',
    agentA: { modelId: defaultAgentA, harnessId: defaultHarness },
    agentB: { modelId: defaultAgentB, harnessId: defaultHarness },
    memoryMode: 'fresh',
    runMode: 'sequential',
    maxSteps: defaultTask?.maxSteps ?? 10,
    maxToolCalls: defaultTask?.maxToolCalls ?? 30,
  });
  const [submitting, setSubmitting] = useState(false);
  const [starredModelIds, setStarredModelIds] = useState<string[]>(initialStarredModelIds);
  const [recentModelIds, setRecentModelIds] = useState<string[]>(initialRecentModelIds);

  function toggleStarredModel(modelId: string) {
    setStarredModelIds((current) => {
      const next = current.includes(modelId) ? current.filter((id) => id !== modelId) : [modelId, ...current];
      saveStoredIds('lvl.starredModels', next);
      return next;
    });
  }

  function rememberModel(modelId: string) {
    if (!modelId) return;
    setRecentModelIds((current) => {
      const next = [modelId, ...current.filter((id) => id !== modelId)].slice(0, 8);
      saveStoredIds('lvl.recentModels', next);
      return next;
    });
  }

  function selectAgent(role: 'agentA' | 'agentB', agent: { modelId: string; harnessId: string }) {
    rememberModel(agent.modelId);
    setForm((current) => ({ ...current, [role]: { ...agent, harnessId: defaultHarness } }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      rememberModel(form.agentA.modelId);
      rememberModel(form.agentB.modelId);
      const match = await api.createMatch({
        ...form,
        taskId: defaultTask?.id ?? form.taskId,
        runMode: 'sequential',
        memoryMode: form.memoryMode ?? 'fresh',
      });
      onCreated(match);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="form">
      <div className="formIntro">
        <strong>Choose two OpenRouter models</strong>
        <span>Star favorites, reuse recent picks, or search the live catalog.</span>
      </div>
      <label>
        Match name
        <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </label>
      <div className="duo">
        <ModelSearch
          label="Model 1"
          models={selectableModels}
          starredModelIds={starredModelIds}
          recentModelIds={recentModelIds}
          value={form.agentA}
          onChange={(agentA) => selectAgent('agentA', agentA)}
          onToggleStar={toggleStarredModel}
        />
        <ModelSearch
          label="Model 2"
          models={selectableModels}
          starredModelIds={starredModelIds}
          recentModelIds={recentModelIds}
          value={form.agentB}
          onChange={(agentB) => selectAgent('agentB', agentB)}
          onToggleStar={toggleStarredModel}
        />
      </div>
      <label>
        Memory mode
        <select value={form.memoryMode ?? 'fresh'} onChange={(event) => setForm({ ...form, memoryMode: event.target.value as CreateMatchInput['memoryMode'] })}>
          <option value="fresh">Fresh state</option>
          <option value="context_dump">Context dump</option>
        </select>
      </label>
      <p className="fieldHint">
        Fresh state sends only the current board. Context dump also sends each agent its own previous turns, raw outputs, tool calls, and score events.
      </p>
      <button disabled={submitting || !form.agentA.modelId || !form.agentB.modelId}>{submitting ? 'Launching...' : 'Create and Run Match'}</button>
    </form>
  );
}

function ModelSearch({
  label,
  models,
  starredModelIds,
  recentModelIds,
  value,
  onChange,
  onToggleStar,
}: {
  label: string;
  models: ModelConfig[];
  starredModelIds: string[];
  recentModelIds: string[];
  value: { modelId: string; harnessId: string };
  onChange: (value: { modelId: string; harnessId: string }) => void;
  onToggleStar: (modelId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLFieldSetElement | null>(null);
  const [catalogModels, setCatalogModels] = useState<ModelConfig[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const allModels = useMemo(() => mergeModels(models, catalogModels), [models, catalogModels]);
  const selected = allModels.find((model) => model.id === value.modelId);
  const normalized = query.trim().toLowerCase();

  useEffect(() => {
    if (!open) return;
    function closeOnOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    window.addEventListener('pointerdown', closeOnOutside);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOnOutside);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      setCatalogLoading(true);
      try {
        const remoteModels = await api.searchOpenRouterModels(query);
        if (!cancelled) {
          setCatalogModels(remoteModels);
          setCatalogError(null);
        }
      } catch (caught) {
        if (!cancelled) setCatalogError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) setCatalogLoading(false);
      }
    }, normalized ? 220 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [open, query, normalized]);

  const starredModels = starredModelIds
    .map((id) => allModels.find((model) => model.id === id))
    .filter((model): model is ModelConfig => Boolean(model));
  const recentModels = recentModelIds
    .map((id) => allModels.find((model) => model.id === id))
    .filter((model): model is ModelConfig => Boolean(model));
  const matchingModels = allModels
    .filter((model) => !normalized || `${model.name} ${model.version} ${model.defaultModel ?? ''}`.toLowerCase().includes(normalized));
  const starredResults = (normalized ? starredModels.filter((model) => matchingModels.some((item) => item.id === model.id)) : starredModels).slice(0, 5);
  const starredSet = new Set(starredResults.map((model) => model.id));
  const recentResults = (normalized ? recentModels.filter((model) => matchingModels.some((item) => item.id === model.id)) : recentModels)
    .filter((model) => !starredSet.has(model.id))
    .slice(0, 5);
  const pinnedSet = new Set([...starredResults, ...recentResults].map((model) => model.id));
  const filteredModels = matchingModels
    .filter((model) => !pinnedSet.has(model.id))
    .slice(0, normalized ? 18 : 10);
  const hasAnyResult = Boolean(starredResults.length || recentResults.length || filteredModels.length);
  return (
    <fieldset className="modelSearch" ref={rootRef}>
      <legend>{label}</legend>
      <button type="button" className="modelSelectButton" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        <span>Choose model</span>
        <strong>{selected ? shortModelName(selected.name) : 'No model selected'}</strong>
        {selected ? <small>{selected.defaultModel ?? selected.version}</small> : null}
      </button>
      {open ? (
        <div className="modelPicker">
          <div className="modelPickerHead">
            <strong>OpenRouter catalog</strong>
            <span>Search by model, provider, or ID.</span>
          </div>
          <input
            type="search"
            autoFocus
            placeholder="Search models..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {catalogLoading ? <ModelState title="Searching OpenRouter..." body="Pulling the latest model catalog." tone="loading" /> : null}
          {catalogError ? <ModelState title="OpenRouter search failed" body={catalogError} tone="error" /> : null}
          {starredResults.length ? (
            <ModelSection
              title="Starred"
              models={starredResults}
              selectedId={value.modelId}
              starredModelIds={starredModelIds}
              onToggleStar={onToggleStar}
              onSelect={(modelId) => {
                onChange({ ...value, modelId });
                setQuery('');
                setOpen(false);
              }}
            />
          ) : (
            <ModelState title={normalized ? 'No starred matches' : 'No starred models yet'} body={normalized ? 'Try a broader search or star a matching model.' : 'Use the star button beside any model to pin it here.'} />
          )}
          <ModelSection
            title="Recent"
            models={recentResults}
            selectedId={value.modelId}
            starredModelIds={starredModelIds}
            onToggleStar={onToggleStar}
            onSelect={(modelId) => {
              onChange({ ...value, modelId });
              setQuery('');
              setOpen(false);
            }}
          />
          <ModelSection
            title={normalized ? 'OpenRouter results' : 'Browse OpenRouter'}
            models={filteredModels}
            selectedId={value.modelId}
            starredModelIds={starredModelIds}
            onToggleStar={onToggleStar}
            onSelect={(modelId) => {
              onChange({ ...value, modelId });
              setQuery('');
              setOpen(false);
            }}
          />
          {!catalogLoading && !hasAnyResult ? <ModelState title="No matching models" body="Try searching provider names like anthropic, openai, google, meta, or paste an OpenRouter model ID." /> : null}
        </div>
      ) : null}
    </fieldset>
  );
}

function mergeModels(...groups: ModelConfig[][]) {
  const byId = new Map<string, ModelConfig>();
  for (const group of groups) {
    for (const model of group) {
      byId.set(model.id, { ...(byId.get(model.id) ?? {}), ...model });
    }
  }
  return [...byId.values()];
}

function loadStoredIds(key: string) {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function saveStoredIds(key: string, ids: string[]) {
  window.localStorage.setItem(key, JSON.stringify([...new Set(ids)].slice(0, 12)));
}

function preferredModelIds(models: ModelConfig[], starredIds: string[], recentIds: string[]) {
  const validIds = new Set(models.map((model) => model.id));
  return [...starredIds, ...recentIds, ...models.map((model) => model.id)]
    .filter((id, index, ids) => validIds.has(id) && ids.indexOf(id) === index);
}

function ModelState({ title, body, tone = 'empty' }: { title: string; body: string; tone?: 'empty' | 'loading' | 'error' }) {
  return (
    <div className={`modelState ${tone}`}>
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

function ModelSection({
  title,
  models,
  selectedId,
  starredModelIds,
  onSelect,
  onToggleStar,
}: {
  title: string;
  models: ModelConfig[];
  selectedId: string;
  starredModelIds: string[];
  onSelect: (modelId: string) => void;
  onToggleStar: (modelId: string) => void;
}) {
  if (!models.length) return null;
  return (
    <section className="modelSection">
      <h3>{title}</h3>
      <div className="modelSearchList">
        {models.map((model) => (
          <div key={model.id} className={`modelOption ${model.id === selectedId ? 'active' : ''}`}>
            <button type="button" className="starButton" aria-label={`${starredModelIds.includes(model.id) ? 'Unstar' : 'Star'} ${shortModelName(model.name)}`} onClick={() => onToggleStar(model.id)}>
              {starredModelIds.includes(model.id) ? '★' : '☆'}
            </button>
            <button type="button" className="modelOptionMain" onClick={() => onSelect(model.id)}>
              <strong>{shortModelName(model.name)}</strong>
              <span>{model.defaultModel ?? model.version}{model.enabled ? '' : ' · needs key'}</span>
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function MatchList({
  matches,
  runs,
  models,
  selected,
  onSelect,
  onDelete,
}: {
  matches: MatchRecord[];
  runs: RunRecord[];
  models: ModelConfig[];
  selected: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
}) {
  if (!matches.length) return <p className="muted">No matches yet. Launch the first match.</p>;
  return (
    <div className="matchTable">
      <div className="matchTableHead">
        <span>Match</span>
        <span>Score</span>
        <span>Model 1</span>
        <span>Model 2</span>
        <span>Started</span>
        <span>Duration</span>
        <span>Cost</span>
        <span>Actions</span>
      </div>
      {matches.map((match) => {
        const matchRuns = runs.filter((run) => run.matchId === match.id);
        const agentA = matchRuns.find((run) => run.role === 'agentA');
        const agentB = matchRuns.find((run) => run.role === 'agentB');
        const agentAName = shortModelName(models.find((model) => model.id === agentA?.modelId)?.name ?? agentA?.modelId ?? 'Model 1');
        const agentBName = shortModelName(models.find((model) => model.id === agentB?.modelId)?.name ?? agentB?.modelId ?? 'Model 2');
        return (
          <div key={match.id} className={`matchTableRow ${selected === match.id ? 'active' : ''}`} role="button" tabIndex={0} onClick={() => onSelect(match.id)} onKeyDown={(event) => event.key === 'Enter' && onSelect(match.id)}>
            <strong>{displayMatchName(match.name)}</strong>
            <span>{scoreboardLabel(match, matchRuns, models)}</span>
            <span>{agentAName}</span>
            <span>{agentBName}</span>
            <span>{formatDateTime(match.startedAt ?? match.createdAt)}</span>
            <span>{durationLabel(match)}</span>
            <span>{costLabel(matchRuns)}</span>
            <button
              className="rowDelete"
              onClick={(event) => {
                event.stopPropagation();
                if (window.confirm('Delete this match log and all trace data?')) void onDelete(match.id);
              }}
            >
              Delete
            </button>
          </div>
        );
      })}
    </div>
  );
}

type RunFilter = 'all' | 'agentA' | 'agentB';
type GameFilter = 'all' | number;

function MatchModal({ detail, onClose, onCancel, onDelete }: { detail: MatchDetail; onClose: () => void; onCancel: () => Promise<void>; onDelete: () => Promise<void> }) {
  return (
    <div className="modalOverlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modalPanel" role="dialog" aria-modal="true" aria-label={`${displayMatchName(detail.match.name)} details`}>
        <MatchReplay detail={detail} onCancel={onCancel} onDelete={onDelete} onClose={onClose} />
      </div>
    </div>
  );
}

function MatchReplay({ detail, onCancel, onDelete, onClose }: { detail: MatchDetail; onCancel: () => Promise<void>; onDelete: () => Promise<void>; onClose: () => void }) {
  const [filter, setFilter] = useState<RunFilter>('all');
  const [gameFilter, setGameFilter] = useState<GameFilter>('all');

  return (
    <div>
      <div className="panelHead">
        <div>
          <h2>{displayMatchName(detail.match.name)}</h2>
          <p className="muted">
            {detail.match.status === 'running' ? 'Live replay updating automatically · ' : ''}
            {detail.task.title} · {memoryLabel(detail.match.memoryMode)} · score: {scoreboardLabel(detail.match, detail.runs, detail.runs.map((run) => run.model).filter(Boolean) as ModelConfig[])} · duration {durationLabel(detail.match)} · spent {costLabel(detail.runs)} ·{' '}
            <a href={`/task-pages/${detail.task.id}?matchId=${detail.match.id}&game=${gameFilter === 'all' ? 1 : gameFilter}`} target="_blank" rel="noreferrer">open replay board</a>
            {' · '}
            <a href={`/api/matches/${detail.match.id}/pgn`} target="_blank" rel="noreferrer">download PGN</a>
          </p>
        </div>
        <div className="modalActions">
          {detail.match.status === 'running' || detail.match.status === 'queued'
            ? <button className="danger" onClick={() => window.confirm('Cancel this match and preserve the partial trace?') && void onCancel()}>Cancel</button>
            : <span className={`pill ${detail.match.status}`}>{detail.match.status}</span>}
          <button className="danger secondaryDanger" onClick={() => window.confirm('Delete this match log and all trace data?') && void onDelete()}>Delete</button>
          <button className="subtle" onClick={onClose}>Close</button>
        </div>
      </div>

      <PairedScoreboard detail={detail} activeGame={gameFilter} onGameChange={setGameFilter} />

      <div className="runFilter">
        <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All logs</button>
        <button className={filter === 'agentA' ? 'active' : ''} onClick={() => setFilter('agentA')}>{shortModelName(modelNameForRole(detail.runs, 'agentA'))}</button>
        <button className={filter === 'agentB' ? 'active' : ''} onClick={() => setFilter('agentB')}>{shortModelName(modelNameForRole(detail.runs, 'agentB'))}</button>
      </div>

      <MatchLog detail={detail} filter={filter} gameFilter={gameFilter} />
    </div>
  );
}

function PairedScoreboard({ detail, activeGame, onGameChange }: { detail: MatchDetail; activeGame: GameFilter; onGameChange: (game: GameFilter) => void }) {
  const models = detail.runs.map((run) => run.model).filter(Boolean) as ModelConfig[];
  const score = pairedScore(detail.runs);
  const model1 = shortModelName(modelNameForRole(detail.runs, 'agentA'));
  const model2 = shortModelName(modelNameForRole(detail.runs, 'agentB'));
  const games = gameSummaries(detail.runs);
  return (
    <section className="scoreboard">
      <div className="scoreboardTop">
        <span>{model1}</span>
        <strong>{formatPoints(score.agentA)} - {formatPoints(score.agentB)}</strong>
        <span>{model2}</span>
      </div>
      <div className="runFilter compactFilter">
        <button className={activeGame === 'all' ? 'active' : ''} onClick={() => onGameChange('all')}>Both games</button>
        {games.map((game) => (
          <button key={game.gameIndex} className={activeGame === game.gameIndex ? 'active' : ''} onClick={() => onGameChange(game.gameIndex)}>
            Game {game.gameIndex}: {shortModelName(game.white)} white
          </button>
        ))}
      </div>
      <div className="gameSummary">
        {games.map((game) => {
          const runs = detail.runs.filter((run) => (run.gameIndex ?? 1) === game.gameIndex);
          return (
            <a key={game.gameIndex} href={`/api/matches/${detail.match.id}/pgn?game=${game.gameIndex}`} target="_blank" rel="noreferrer">
              <strong>Game {game.gameIndex}: {gameResultLabel(runs, models)}</strong>
              <span>{shortModelName(game.white)} as White vs {shortModelName(game.black)} as Black</span>
              <small>{chessMetricLabel(runs)} · PGN</small>
            </a>
          );
        })}
      </div>
    </section>
  );
}

function MatchLog({ detail, filter, gameFilter }: { detail: MatchDetail; filter: RunFilter; gameFilter: GameFilter }) {
  const runs = detail.runs
    .filter((run) => filter === 'all' || run.role === filter)
    .filter((run) => gameFilter === 'all' || run.gameIndex === gameFilter);
  const steps = runs
    .flatMap((run) => run.steps.map((step) => ({ step, run })))
    .sort((a, b) => a.step.createdAt.localeCompare(b.step.createdAt));
  return (
    <div className="matchLog">
      {steps.length ? steps.map(({ step, run }) => {
        const actionText = step.toolCall?.actions.map((action) => action.action).join(', ') || 'state';
        const eventText = step.scoreEvents.map((event) => `${event.delta >= 0 ? '+' : ''}${event.delta} ${event.reason}`).join(' · ');
        return (
          <article key={step.id} className="logRow">
            <div className="logLine">
              <strong>{shortModelName(run.model?.name ?? run.modelId)}</strong>
              <span>game {run.gameIndex} · {run.color === 'w' ? 'White' : 'Black'}</span>
              <span>attempt {step.stepIndex + 1}</span>
              <span>{actionText}</span>
            </div>
            <p className="scoreLine">{eventText || 'No score event'}</p>
            <div className="modelOutputBlock">
              <span>Model output</span>
              <ModelOutput text={step.modelOutput.rawText} />
            </div>
          </article>
        );
      }) : <p className="muted">Trace will appear as soon as the first step completes.</p>}
    </div>
  );
}

function ModelOutput({ text }: { text: string }) {
  const content = text.trim();
  if (!content) return <p className="muted">No model output recorded.</p>;

  const wholeJson = prettyJson(content);
  if (wholeJson) {
    return (
      <div className="modelOutput">
        <CodeBlock language="json" code={wholeJson} />
      </div>
    );
  }

  const parts = content.split(/```(\w+)?\n([\s\S]*?)```/g);
  return (
    <div className="modelOutput">
      {parts.map((part, index) => {
        if (index % 3 === 1) return null;
        if (index % 3 === 2) {
          const language = parts[index - 1] || 'code';
          return <CodeBlock key={index} language={language} code={formatCode(language, part)} />;
        }
        return <TextOutput key={index} text={part} />;
      })}
    </div>
  );
}

function TextOutput({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let prose: string[] = [];

  function flushProse(key: string) {
    const content = prose.join('\n').trim();
    if (content) blocks.push(<p key={key}>{content}</p>);
    prose = [];
  }

  text.split('\n').forEach((line, index) => {
    const formatted = prettyJson(line.trim());
    if (formatted) {
      flushProse(`p-${index}`);
      blocks.push(<CodeBlock key={`code-${index}`} language="json" code={formatted} />);
      return;
    }
    prose.push(line);
  });
  flushProse('p-final');

  return <>{blocks}</>;
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  return (
    <pre className="codeBlock">
      <code data-language={language || 'code'}>{code.trim()}</code>
    </pre>
  );
}

function formatCode(language: string, code: string) {
  return language.toLowerCase() === 'json' ? prettyJson(code.trim()) ?? code : code;
}

function prettyJson(value: string) {
  if (!value.startsWith('{') && !value.startsWith('[')) return null;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return null;
  }
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

function memoryLabel(mode: MatchRecord['memoryMode'] | undefined) {
  return mode === 'context_dump' ? 'context dump' : 'fresh state';
}

function costLabel(runs: Pick<RunRecord, 'costUsd'>[]) {
  const total = runs.reduce((sum, run) => sum + (run.costUsd || 0), 0);
  if (total === 0) return '$0';
  if (total < 0.01) return `$${total.toFixed(4)}`;
  return `$${total.toFixed(2)}`;
}

function pairedScore(runs: RunRecord[]) {
  return runs.reduce((score, run) => {
    score[run.role] += runPoints(run);
    return score;
  }, { agentA: 0, agentB: 0 } satisfies Record<RunRecord['role'], number>);
}

function scoreboardLabel(match: Pick<MatchRecord, 'status'>, runs: RunRecord[], models: ModelConfig[]) {
  if (match.status === 'running' || match.status === 'queued') return match.status;
  if (match.status === 'cancelled' || match.status === 'failed') return match.status;
  const score = pairedScore(runs);
  const model1 = shortModelName(models.find((model) => model.id === runs.find((run) => run.role === 'agentA')?.modelId)?.name ?? runs.find((run) => run.role === 'agentA')?.modelId ?? 'Model 1');
  const model2 = shortModelName(models.find((model) => model.id === runs.find((run) => run.role === 'agentB')?.modelId)?.name ?? runs.find((run) => run.role === 'agentB')?.modelId ?? 'Model 2');
  return `${model1} ${formatPoints(score.agentA)} - ${formatPoints(score.agentB)} ${model2}`;
}

function runPoints(run: RunRecord) {
  const success = run.scorecard?.taskSuccess;
  if (success === 100) return 1;
  if (success === 50) return 0.5;
  return 0;
}

function formatPoints(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function gameSummaries(runs: Array<RunRecord & { model?: ModelConfig }>) {
  const indices = [...new Set(runs.map((run) => run.gameIndex ?? 1))].sort((a, b) => a - b);
  return indices.map((gameIndex) => {
    const gameRuns = runs.filter((run) => (run.gameIndex ?? 1) === gameIndex);
    return {
      gameIndex,
      white: gameRuns.find((run) => run.color === 'w')?.model?.name ?? 'White',
      black: gameRuns.find((run) => run.color === 'b')?.model?.name ?? 'Black',
    };
  });
}

function gameResultLabel(runs: RunRecord[], models: ModelConfig[]) {
  const white = runs.find((run) => run.color === 'w');
  const black = runs.find((run) => run.color === 'b');
  if (white?.scorecard?.taskSuccess === 100) return `${shortModelName(models.find((model) => model.id === white.modelId)?.name ?? white.modelId)} won`;
  if (black?.scorecard?.taskSuccess === 100) return `${shortModelName(models.find((model) => model.id === black.modelId)?.name ?? black.modelId)} won`;
  if (white?.scorecard?.taskSuccess === 50 || black?.scorecard?.taskSuccess === 50) return 'Draw';
  if (runs.some((run) => run.status === 'running' || run.status === 'waiting_for_model' || run.status === 'executing_tool')) return 'Running';
  return 'Pending';
}

function avgQualityLabel(runs: RunRecord[]) {
  const values = runs.map((run) => run.scorecard?.chessQuality).filter((value): value is number => typeof value === 'number');
  if (!values.length) return '-';
  return `${Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)}`;
}

function chessMetricLabel(runs: RunRecord[]) {
  const metrics = runs.map((run) => run.scorecard?.chess).filter(Boolean);
  const avgCpl = averageNullable(metrics.map((metric) => metric?.averageCentipawnLoss ?? null));
  const inaccuracies = metrics.reduce((total, metric) => total + (metric?.inaccuracies ?? 0), 0);
  const mistakes = metrics.reduce((total, metric) => total + (metric?.mistakes ?? 0), 0);
  const blunders = metrics.reduce((total, metric) => total + (metric?.blunders ?? 0), 0);
  const illegal = metrics.length
    ? metrics.reduce((total, metric) => total + (metric?.illegalMoves ?? 0), 0)
    : illegalAttemptCount(runs as Array<RunRecord & { steps?: MatchDetail['runs'][number]['steps'] }>);
  return [
    `quality ${avgQualityLabel(runs)}`,
    avgCpl === null ? '' : `CPL ${Math.round(avgCpl)}`,
    `I/M/B ${inaccuracies}/${mistakes}/${blunders}`,
    `illegal ${illegal}`,
  ].filter(Boolean).join(' · ');
}

function averageNullable(values: Array<number | null>) {
  const realValues = values.filter((value): value is number => typeof value === 'number');
  if (!realValues.length) return null;
  return realValues.reduce((sum, value) => sum + value, 0) / realValues.length;
}

function illegalAttemptCount(runs: Array<RunRecord & { steps?: MatchDetail['runs'][number]['steps'] }>) {
  return runs.reduce((total, run) => total + (run.steps ?? []).flatMap((step) => step.scoreEvents).filter((event) => /illegal|No complete/i.test(event.reason)).length, 0);
}

function modelNameForRole(runs: Array<RunRecord & { model?: ModelConfig }>, role: RunRecord['role']) {
  const run = runs.find((item) => item.role === role);
  return run?.model?.name ?? run?.modelId ?? (role === 'agentA' ? 'Model 1' : 'Model 2');
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

function displayMatchName(name: string) {
  const baseName = name.split(':')[0]?.trim() || name;
  return shortModelName(baseName)
    .replace(/\bvs\b/gi, 'vs')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function durationLabel(match: Pick<MatchRecord, 'startedAt' | 'endedAt' | 'createdAt'>) {
  const start = new Date(match.startedAt ?? match.createdAt).getTime();
  const end = match.endedAt ? new Date(match.endedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
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
