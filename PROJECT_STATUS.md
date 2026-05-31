# lvl Project Status

This document captures what has been built so far, what is working, what is intentionally rough, and what should happen next.

## Current State

lvl is now a local-first AI agent evaluation arena focused on model-vs-model chess. It can create chess matches, run model/harness pairs through an owned Chromium board, record traces, score runs, replay moves on a chess board, and compute simple Elo-style standings.

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
npm run parser:test
npm run build
npm run smoke
npm run chess:verify
npm run suite:smoke
npm run benchmark
npm run benchmark:premium
```

## What Is Built

### Local Web App

- Vite + React frontend.
- Express API server.
- Local JSON-file storage under `data/`.
- Match creation UI.
- The main UI is currently chess-only: no task picker, no run mode picker, no hurdle toggle.
- New matches always use `chess-full-match`, sequential turn execution, and no hurdles.
- `Memory mode` selector:
  - `Fresh state`: sends only the current board/observation.
  - `Context dump`: sends the active agent its own previous observations, raw model outputs, tool inputs, executed actions, and score events.
- Match list and active status polling.
- Full-width match table showing match name, winner, competing models, start time, duration, and stored seed details.
- Match detail/replay modal opened by clicking a row.
- Match-level logs with all/Agent A/Agent B filters.
- Model output formatting for fenced code and raw one-line JSON tool calls.
- Chess replay board opened from a match modal.
- Replay board supports Start, Prev, Play, Next, Latest, slider scrubbing, and arrow-key navigation.
- Replay board polls ongoing matches so the latest move appears during live runs.
- Seed-count field for launching simple multi-seed suites.
- Fixed/random seed mode with stored seed metadata for exact reruns.
- Hero-level stats for matches, completed runs, and average score.
- Task page route for viewing chess/replay boards directly.

Important routes:

```text
/api/health
/api/bootstrap
/api/matches
/api/matches/:id
/api/matches/:id/replay
/api/analytics
/task-pages/:taskId?seed=818&matchId=<matchId>
```

### Match Runner

- Background match orchestrator.
- Supports sequential and parallel run modes internally, but the current chess UI always creates sequential matches.
- Runs two agents per match.
- Supports match cancellation.
- Supports launching the same matchup across multiple consecutive seeds from the UI.
- Random seed launches store the generated seed, suite index, and suite count on the match record.
- Stores match memory mode and defaults older matches to `fresh`.
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
- Harness can receive an optional own-turn context dump for pressure-testing models with long context.
- Dummy agents:
  - `Dummy Strong`
  - `Dummy Chaotic`
- OpenRouter adapter.
- OpenRouter key belongs in ignored `.env.local`.
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

The parser now tolerates common model-output messiness:

- JSON embedded in prose.
- JSON in markdown code fences.
- Nested `tool` / `arguments` / `input` wrapper objects.
- Direct browser scripts when the model ignores the JSON-only instruction.
- One-line JSON tool calls in replay are pretty-printed as code blocks.

### Browser Runtime

The project no longer depends on the Ghost browser extension.

Current flow:

```text
agent harness
  -> browser tool mode=state/mode=run
  -> Playwright-backed browser runtime
  -> isolated Chromium context
  -> local task page
  -> indexed DOM actions and optional screenshots
```

Implemented browser actions:

- State/snapshot.
- Click by indexed ref.
- Click chess squares by name, such as `e2` and `e4`.
- Coordinate click parsing.
- Input by indexed ref.
- Select/dropdown parsing.
- Keyboard press.
- Screenshot capture still exists in traces, but normal replay UI hides screenshots and element-tree dumps by default to keep logs focused on model actions.
- Popup interception as scored obstacle behavior.

The browser context is isolated per run and closed after the run completes.

### Browser Tasks

Current tasks:

The main UI currently exposes only `chess-full-match`. Other seeded browser tasks remain useful for scripts/regression work but are hidden from the match form for now.

- `target-grid-duel`
  - Real local browser game rendered in Chromium.
  - Agents click highlighted target tiles.
  - Trap tiles penalize tool quality.
  - Popup and moving-target hurdles can be injected.

- `chess-opening-e4`
  - Real local browser chess board rendered in Chromium.
  - Agents click the source square `e2`, then the destination square `e4`.
  - No hurdles are enabled for this task.
  - Current objective verifies one opening move instead of playing a full game.

- `chess-full-match`
  - Full model-vs-model chess match path.
  - Agent A is White; Agent B is Black.
  - Agents alternate on one shared Chromium board.
  - Legal move validation uses `chess.js`.
  - No CPU/Stockfish opponent is involved.
  - Thinking time is recorded through run latency, but there is no chess clock flag/forfeit.
  - Illegal moves do not immediately stop the game. The same side gets feedback and must retry a legal move.
  - The match can end by checkmate, draw, or material adjudication at the move cap.

- `simple-checkout-popup`
  - Local checkout flow.
  - Agents add item to cart, handle popup, and confirm checkout.

- `confirm-button-decoy`
  - Simple confirmation/decoy target task.

Task pages can be opened directly:

```text
http://localhost:5173/task-pages/chess-full-match?seed=818&matchId=<matchId>
```

### Traces And Replay

Each run records:

- Observation shown to the agent.
- Raw model output.
- Parsed browser tool call.
- Browser actions.
- Chromium screenshot, stored but hidden in the standard replay log.
- Score events.
- Failure labels.
- Final scorecard.

The replay UI shows:

- Compact per-step action rows.
- Agent/model, attempt, action type, score/result line, and formatted model output.
- Filters for all actions, Agent A only, or Agent B only.
- No element-tree dump or screenshot banner in the normal trace view.
- Chess board replay with move controls and live polling.

Replay is not designed as a side-by-side comparison view. The intended workflow is: create a chess match, watch the row update while it runs, click the row for trace logs, and open the replay board to scrub through moves like a chess.com-style game replay.

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
npm run parser:test
npm run build
npm run smoke
npm run chess:verify
npm run chess:match
npm run suite:smoke
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
5. Expand multi-seed suite runs beyond the current simple runner.
6. Add trace export/import.

### Product/UI

1. Add live step streaming instead of polling-only updates.
2. Add task detail pages.
3. Add leaderboard page.
4. Add model/harness management UI.
5. Add failed-run inspection and retry controls.
6. Replace polling with streaming once runs get longer.

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

1. Keep hardening the browser action parser and repair loop.
2. Add scroll/select/hover/wait to the Playwright runner.
3. Create three new browser game tasks.
4. Expand the multi-seed suite runner with UI summaries.
5. Tune scoring after inspecting traces.

That would turn the current proof-of-loop into a much more credible local evaluation tool.
