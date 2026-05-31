# lvl Project Status

This document captures what has been built so far, what is working, what is intentionally rough, and what should happen next.

## Current State

lvl is now a local-first AI agent evaluation arena. It can create head-to-head matches, run model/harness pairs against browser tasks, record traces, score runs, show replays, and compute simple Elo-style standings.

The app is usable locally:

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:5173
```

Useful checks:

```bash
npm run build
npm run smoke
npm run benchmark
npm run benchmark:premium
```

## What Is Built

### Local Web App

- Vite + React frontend.
- Express API server.
- Local JSON-file storage under `data/`.
- Match creation UI.
- Match list and active status polling.
- Match detail/replay page.
- Analytics panel.
- Task page route for viewing browser games directly.

Important routes:

```text
/api/health
/api/bootstrap
/api/matches
/api/matches/:id
/api/analytics
/task-pages/:taskId?seed=818
```

### Match Runner

- Background match orchestrator.
- Supports sequential and parallel run modes.
- Runs two agents per match.
- Supports match cancellation.
- Preserves partial traces for failed/cancelled runs.
- Stores match/run state transitions.

Current states include:

```text
queued
running
waiting_for_model
executing_tool
scoring
completed
failed
cancelled
```

### Harness And Models

- Barebones shared harness.
- Dummy agents:
  - `Dummy Strong`
  - `Dummy Chaotic`
- OpenRouter adapter.
- OpenRouter key is copied into ignored `.env.local`.
- Named OpenRouter model configs:
  - GPT-4o Mini
  - Gemini Flash
  - Llama 3.1 8B
  - Qwen 3.5 9B
  - Claude Sonnet 4.6
  - Claude Opus 4.6
  - GPT-5.4

The model adapter normalizes provider output into a browser tool call:

```ts
{ mode: "state" }
{ mode: "run", script: "const tab = await browser.currentTab(); await tab.click(11);" }
```

### Browser Runtime

The project no longer depends on the Ghost browser extension.

Current flow:

```text
agent harness
  -> browser tool mode=state/mode=run
  -> Playwright-backed browser runtime
  -> isolated Chromium context
  -> local task page
  -> indexed DOM actions and screenshots
```

Implemented browser actions:

- State/snapshot.
- Click by indexed ref.
- Input by indexed ref.
- Keyboard press.
- Screenshot capture.
- Popup interception as scored obstacle behavior.

The browser context is isolated per run and closed after the run completes.

### Browser Tasks

Current tasks:

- `target-grid-duel`
  - Real local browser game rendered in Chromium.
  - Agents click highlighted target tiles.
  - Trap tiles penalize tool quality.
  - Popup and moving-target hurdles can be injected.

- `simple-checkout-popup`
  - Local checkout flow.
  - Agents add item to cart, handle popup, and confirm checkout.

- `confirm-button-decoy`
  - Simple confirmation/decoy target task.

Task pages can be opened directly:

```text
http://localhost:5173/task-pages/target-grid-duel?seed=818
```

### Traces And Replay

Each run records:

- Observation shown to the agent.
- Raw model output.
- Parsed browser tool call.
- Browser actions.
- Chromium screenshot.
- Score events.
- Failure labels.
- Final scorecard.

The replay UI shows:

- Per-run scorecard.
- Browser screenshots.
- Element tree.
- Model output.
- Score event deltas.
- Failure labels.

### Scoring

Current score formula:

```text
35% task success
20% efficiency
15% robustness
10% progress
10% tool-use quality
10% consistency placeholder
```

Current dimensions:

- `taskSuccess`: objective completion.
- `efficiency`: fewer steps/tool calls.
- `robustness`: handling popup/moving target events.
- `progress`: partial progress such as target hits or adding cart item.
- `toolUseQuality`: avoiding trap/decoy/wrong actions.
- `consistency`: placeholder baseline until multi-seed suites are first-class.

Failure labels include:

```text
task_incomplete
wrong_target
missed_popup
budget_exceeded
tool_error
looping
```

### Analytics

Analytics currently includes:

- Total matches/runs.
- Average score.
- Average cost.
- Model-level average score.
- Model-level average cost.
- Model-level latency.
- Model Elo.
- Task success rate.
- Score distribution buckets.
- Failure-label counts.

### Elo

Elo starts at `1000` and updates from completed head-to-head match winners.

This is intentionally simple for now. It is good enough for early local comparison, not yet a public benchmark rating system.

## Benchmark Results So Far

### Standard Benchmark

Last full standard batch:

```text
GPT-4o Mini: Elo 1033, avg 83.35, wins 2/2
Qwen 3.5 9B: Elo 1000, avg 58.25, wins 1/2
Dummy Chaotic: Elo 984, avg 78.15, wins 0/1
Dummy Strong: Elo 983, avg 81.75, wins 1/3
```

Notable result:

- GPT-4o Mini beat Qwen 3.5 9B hard on checkout.
- Qwen 3.5 9B beat Dummy Strong on the target grid.
- Gemini Flash hit OpenRouter `429`, so Qwen became the default third real-model benchmark.

### Premium Benchmark

After relaxing tight caps:

```text
Claude Sonnet 4.6: Elo 1028, avg 88.7, wins 3/4
GPT-5.4: Elo 1002, avg 61.65, wins 1/2
Claude Opus 4.6: Elo 970, avg 83.55, wins 0/2
```

Match details:

```text
Grid: Sonnet 4.6 beat GPT-5.4
Grid: Sonnet 4.6 beat Opus 4.6
Checkout: GPT-5.4 beat Sonnet 4.6
Checkout: Sonnet 4.6 beat Opus 4.6
```

Important caveat:

These results reflect the current simple harness, parser, tasks, and scoring formula. They are useful for proving the platform loop, not yet for public benchmark claims.

## Verification Status

These have passed after the latest changes:

```bash
npm run build
npm run smoke
```

The premium benchmark also completed successfully:

```bash
npm run benchmark:premium
```

## Known Limitations

### Harness Is Still Barebones

The current harness asks for one browser tool call per step and expects JSON. It does not yet do robust repair when models return malformed JSON or natural language around tool calls.

Needed improvements:

- Better action parsing.
- Retry/repair invalid JSON.
- Better prompt variants.
- Harness versioning in UI.
- Harness-vs-harness comparisons.

### Browser Runtime Is Minimal

The Chromium runner is real, but the exposed action surface is still narrow.

Currently implemented:

- Snapshot.
- Click.
- Input.
- Keyboard press.
- Screenshot.

Needed next:

- Scroll.
- Select/dropdown.
- Hover/focus.
- Drag/drop.
- File upload.
- Accessibility tree extraction.
- Network-idle wait.
- Dialog handling.
- Safer runtime script validation.

### Tasks Are Too Simple

Current tasks prove the loop, but they are not enough for serious evaluation.

Needed next:

- More browser games.
- Multi-step browser workflows.
- Harder decoy patterns.
- Multi-page tasks.
- Hidden state tasks.
- Randomized but reproducible task generators.
- Control vs chaos variants.
- Multi-seed suites.

### Scoring Needs Calibration

The scorecard works, but the weights and event deltas are early guesses.

Needed next:

- Per-task scoring rubrics.
- Better tie-breakers.
- Confidence intervals.
- Multi-seed consistency scoring.
- Human-reviewed calibration traces.
- Separate absolute score and head-to-head rating views.

### Data Storage Is Local JSON

Local JSON is good for speed, but not enough long-term.

Needed next:

- Postgres or SQLite-backed schema.
- Artifact directory management.
- Trace export/import.
- Run deletion/cleanup UI.
- Object storage later.

### Provider Reliability

OpenRouter models can rate-limit or fail.

Needed next:

- Retry with exponential backoff.
- Per-provider rate-limit handling.
- Better error labels.
- Provider availability status in UI.
- Cost estimation before run.

## What Is Left To Do

### Highest Priority

1. Improve the harness parser and repair loop.
2. Add more real browser actions to the Playwright runtime.
3. Build 5-10 better browser tasks.
4. Make scoring per-task instead of one generic formula.
5. Add multi-seed suite runs.
6. Add trace export/import.

### Product/UI

1. Add live step streaming instead of polling-only updates.
2. Add task detail pages.
3. Add run comparison view side-by-side.
4. Add leaderboard page.
5. Add model/harness management UI.
6. Add failed-run inspection and retry controls.

### Benchmark Credibility

1. Store exact model versions and provider metadata returned by APIs.
2. Store full prompt/tool schema hashes for every run.
3. Add control runs without hurdles.
4. Add hidden seeds/tasks.
5. Add reproducibility report for every match.
6. Move Elo to Glicko/TrueSkill later.

### Engineering

1. Move storage from JSON to SQLite/Postgres.
2. Add unit tests around scoring, Elo, parser, and browser runner.
3. Add golden trace fixtures.
4. Add CI.
5. Add lint/format tooling.
6. Add artifact cleanup.

## Next Best Sprint

The next sprint should focus on depth, not breadth:

1. Add a stronger browser action parser.
2. Add scroll/select/hover/wait to the Playwright runner.
3. Create three new browser game tasks.
4. Add multi-seed suite runner.
5. Make the replay compare two runs side-by-side.
6. Tune scoring after inspecting traces.

That would turn the current proof-of-loop into a much more credible local evaluation tool.
