# Agent Guide

This file is the operating guide for AI agents working on lvl.

## Project Summary

lvl is a local-first AI agent evaluation arena. The current product surface is model-vs-model chess: two model + harness combinations play on a reproducible Chromium chess board, traces are recorded, runs are scored, moves can be replayed, and simple Elo standings are computed.

Core loop:

```text
Create match
  -> run model through harness
  -> execute browser tool in isolated Chromium chess board
  -> record trace
  -> score run
  -> replay moves
  -> update analytics/Elo
```

Do not treat this as a normal chatbot app. The important product surface is evidence: traces, tool calls, score events, and chess replay. Screenshots and element trees may exist in trace data, but the normal UI intentionally hides them unless a future debugging surface needs them.

## Current Stack

- TypeScript.
- Vite + React frontend.
- Express API server.
- Playwright/Chromium browser runner.
- Local JSON-file storage.
- OpenRouter adapter for real model calls.
- Dummy agents for deterministic tests.

Important paths:

```text
src/client/                  React UI
src/server/                  API, orchestrator, scoring, browser runtime
src/shared/types.ts          Shared protocol and data types
scripts/smoke-test.ts        Fast local end-to-end test
scripts/test-browser-parser.ts  Parser-only regression checks
scripts/run-chess-verify.ts  Cheap real-model chess verification
scripts/run-chess-match.ts  Full chess model-vs-model verification
scripts/run-multiseed-suite.ts  Multi-seed suite smoke check
scripts/run-benchmark.ts     Standard benchmark batch
scripts/run-premium-benchmark.ts  Premium model benchmark batch
README.md                    Product/build overview
PROJECT_STATUS.md            Current status and roadmap
```

## Commands

Install:

```bash
npm install
```

Run local app:

```bash
npm run dev
```

Open:

```text
http://localhost:5173
```

Checks:

```bash
npm run typecheck
npm run build
npm run parser:test
npm run smoke
npm run chess:verify
npm run chess:match
npm run suite:smoke
```

Benchmarks:

```bash
npm run suite:smoke
npm run benchmark
npm run benchmark:premium
```

## Environment

Secrets belong in `.env.local`, which is ignored by git.

Do not commit:

```text
.env
.env.local
data/
artifacts/
dist/
node_modules/
```

Important environment variables:

```env
OPENROUTER_API_KEY=
OPENROUTER_MODEL=openai/gpt-4o-mini
MODEL_MAX_TOKENS=4096
MODEL_REQUEST_TIMEOUT_MS=120000
MATCH_DEFAULT_TIMEOUT_MS=300000
MATCH_DEFAULT_MAX_STEPS=40
MATCH_DEFAULT_MAX_TOOL_CALLS=160
BROWSER_MAX_ACTIONS_PER_CALL=50
```

## Architecture

### API

The API lives in:

```text
src/server/index.ts
```

Main routes:

```text
GET  /api/health
GET  /api/bootstrap
GET  /api/matches
GET  /api/matches/:id
GET  /api/matches/:id/replay
POST /api/matches
POST /api/matches/:id/cancel
GET  /api/analytics
GET  /task-pages/:taskId?seed=818&matchId=<matchId>
```

### Storage

Storage is currently JSON-backed:

```text
src/server/storage.ts
data/lvl-state.json
```

The store owns:

- Models.
- Harnesses.
- Tasks.
- Matches.
- Runs.
- Trace steps.
- Analytics aggregation.
- Elo calculation.

When adding new persistent fields, update:

1. `src/shared/types.ts`
2. seed/creation logic
3. storage merge/default behavior
4. UI rendering if needed

### Orchestrator

The orchestrator lives in:

```text
src/server/orchestrator.ts
```

Responsibilities:

- Create matches.
- Create runs.
- Queue matches.
- Run agents sequentially or in parallel.
- For `chess-full-match`, run agents sequentially in turn order.
- Execute model/harness/browser steps.
- Persist trace steps.
- Score runs.
- Finish matches and choose winner.
- Build chess replay frames for `/api/matches/:id/replay`.

Do not put scoring policy inside the orchestrator. Keep scoring in `src/server/scoring.ts`.

### Harness

The current harness is:

```text
src/server/harness.ts
```

It:

- Builds model input.
- Sends observation to model adapter.
- Optionally includes an own-turn context dump when match `memoryMode` is `context_dump`.
- Normalizes a browser tool call.
- Uses the shared browser action parser for messy model responses.

Memory modes:

- `fresh`: send only the current observation/board state.
- `context_dump`: also send that agent's own previous observations, raw model outputs, tool inputs, executed actions, and score events. Screenshots are excluded from the dump to avoid base64 bloat.

It is intentionally simple, but now handles common model-output messiness such as JSON inside prose, fenced JSON, nested `arguments` objects, and script-only responses. Future harness improvements should remain versioned and measurable.

Do not make the orchestrator depend on one harness implementation forever.

### Model Adapters

Model adapter code:

```text
src/server/modelAdapters.ts
```

Current adapters:

- Dummy adapter.
- OpenRouter adapter.

Current named models are seeded in:

```text
src/server/seeds.ts
```

If adding a model:

1. Add model config in `seedModels`.
2. Set `provider: "openrouter"` if using OpenRouter.
3. Set exact `defaultModel` slug.
4. Keep `enabled: Boolean(process.env.OPENROUTER_API_KEY)`.
5. Run `npm run typecheck`.

### Browser Runtime

Browser runtime:

```text
src/server/chromiumEnvironment.ts
src/server/browserActionParser.ts
```

The project owns its browser runtime through Playwright/Chromium. Do not reintroduce Ghost browser extension coupling.

Current flow:

```text
browser tool
  -> Playwright-backed runtime
  -> isolated Chromium context
  -> local task page
  -> indexed DOM actions
```

Current browser actions:

- Snapshot/state.
- Click indexed element.
- Click chess squares by name, such as `e2` then `e4`.
- Coordinate click parsing.
- Input indexed element.
- Select/dropdown parsing.
- Keyboard press.
- Screenshot.

Normal replay UX hides screenshots and element-tree dumps. Keep the UI centered on what the model did, model output, score events, and board replay.

Planned actions:

- Scroll.
- Select/dropdown.
- Hover/focus.
- Drag/drop.
- File upload.
- Accessibility snapshot.
- Network idle.
- Dialog handling.

When extending browser actions:

1. Update `BrowserToolInput` if the tool contract changes.
2. Update script extraction in `src/server/browserActionParser.ts`.
3. Update execution in `chromiumEnvironment.ts`.
4. Add score event behavior if action affects scoring.
5. Run `npm run parser:test` and `npm run smoke`.

Parser expectations:

- Accept JSON embedded in prose.
- Accept JSON in markdown code fences.
- Accept nested shapes like `{ "tool": "browser", "arguments": { ... } }`.
- Accept direct browser scripts when a model ignores the JSON-only instruction.
- Prefer parser expansion over adding brittle one-off regexes in the environment runner.

### Tasks

Seed tasks live in:

```text
src/server/seeds.ts
```

Task pages are rendered by:

```text
renderTaskPage()` in `src/server/chromiumEnvironment.ts`
```

Current tasks:

- `target-grid-duel`
- `chess-opening-e4`
- `chess-full-match`
- `simple-checkout-popup`
- `confirm-button-decoy`

The main UI currently exposes only `chess-full-match`. Keep the other seeded tasks available for scripts/regression work unless the user asks to remove them.

Chess task notes:

- `chess-opening-e4` verifies one move, not a full game.
- It renders a full board in Chromium.
- Agents must click source square `e2`, then destination square `e4`.
- Square buttons use `data-lvl-ref` and labels like `White pawn on e2` / `Empty square e4`.
- No hurdles should be enabled for chess verification runs unless explicitly requested.

Full chess match notes:

- Use `chess-full-match` for model-vs-model chess games.
- Agent A is White; Agent B is Black.
- The orchestrator alternates turns on one shared board, not two independent runs.
- Legal move validation is handled by `chess.js`.
- No CPU opponent is used.
- Thinking time is recorded as run latency, but there is no chess clock flag/forfeit.
- Illegal moves do not immediately stop the game. The same side receives feedback and must retry with a legal move.
- End states: checkmate, draw, or material adjudication at the move cap.

Replay behavior:

- The selected match detail polls and updates while a match is running.
- The match history/log is a full-width table with match name, winner, competing models, start time, duration, and stored seed details.
- Clicking a match opens the full trace/log modal for that match.
- The trace log shows model actions, score/result lines, and formatted model output. Do not show the huge element tree or screenshot banner by default.
- `open replay board` launches the chess board replay page with Start, Prev, Play, Next, Latest, slider, and arrow-key navigation.
- Ongoing chess replay boards poll `/api/matches/:id/replay` so the latest move appears while the match runs.
- Replay uses filters for `All logs`, `Agent A`, and `Agent B`; do not reintroduce agent POV tabs unless requested.
- Users can create new matches while previous matches continue running.
- Users can reopen previous matches from the match list.
- Do not prioritize side-by-side comparison unless explicitly requested; replay means live/current inspection plus historical trace browsing.

Task design rules:

- Must be deterministic from seed.
- Must expose indexed elements through `data-lvl-ref`.
- Must write events through `window.__lvl.events`.
- Must expose `window.__lvl.snapshot()`.
- Must be inspectable through `/task-pages/:taskId?seed=...`.

## Scoring

Scoring lives in:

```text
src/server/scoring.ts
```

Current formula:

```text
35% task success
20% efficiency
15% robustness
10% progress
10% tool-use quality
10% consistency placeholder
```

Keep scorecards explainable. Every score should be traceable back to:

- objective completion
- number of steps/tool calls
- score events
- failure labels
- replay trace

Do not add opaque LLM-judge scoring until objective scoring and trace replay are solid.

## UI Rules

UI code lives in:

```text
src/client/App.tsx
src/client/styles.css
```

Current UI is plain React/CSS, not Tailwind.

Follow these rules:

- Keep the New Match form chess-focused until the user asks to reintroduce other task types.
- Do not show a separate top navbar; the `lvl` logo lives in the hero.
- Do not show run mode for chess. Chess is sequential by design.
- Keep match details out of the table until a row is clicked; detailed logs belong in the modal.
- Maintain visible focus states.
- Keep body text readable on mobile.
- No emoji icons as UI controls.
- Buttons must have clear labels.
- Destructive actions must confirm before running.
- Empty states should tell the user what to do next.
- Charts must remain legible and not rely on color alone.
- Avoid decorative animation unless explicitly needed.
- Do not introduce a large UI dependency unless there is a clear reason.

If adding icon-only buttons, add `aria-label`.

## Testing Expectations

Before handing work back, run:

```bash
npm run typecheck
npm run build
npm run smoke
```

If model/provider code changed, also run one of:

```bash
npm run benchmark
npm run benchmark:premium
```

If OpenRouter rate-limits or a model fails, report it clearly. Do not hide provider failures.

## Current Benchmarks

Standard benchmark:

```bash
npm run benchmark
```

Premium benchmark:

```bash
npm run benchmark:premium
```

Latest relaxed premium result:

```text
Claude Sonnet 4.6: Elo 1028, avg 88.7, wins 3/4
GPT-5.4: Elo 1002, avg 61.65, wins 1/2
Claude Opus 4.6: Elo 970, avg 83.55, wins 0/2
```

Remember: these are local early-platform results, not public benchmark claims.

## Development Principles

1. Keep the trace/replay path central.
2. Prefer objective scoring over LLM judges.
3. Keep model, harness, browser runtime, environment, and scoring separate.
4. Version anything that affects benchmark comparability.
5. Do not commit secrets or local benchmark data.
6. Do not overbuild infra before tasks/scoring/replay are credible.
7. Favor small, inspectable changes and then run the smoke test.

## High-Priority Next Work

1. Improve model output parsing and repair.
2. Add more Playwright browser actions.
3. Add more real browser tasks.
4. Expand multi-seed benchmark suite summaries beyond the current seed-count launcher and smoke script.
5. Improve live replay/streaming for longer runs beyond polling.
6. Move storage from JSON to SQLite/Postgres.
7. Add golden trace tests.
8. Tune scoring from inspected traces.

## Common Pitfalls

- Do not confuse model quality with harness quality.
- Do not change score weights without documenting it.
- Do not treat one seed as a robust benchmark.
- Do not trust a score without opening the replay.
- Do not expose raw secrets in traces.
- Do not let provider errors become silent failed scores.
- Do not reintroduce the Ghost extension dependency.

## If You Are Unsure

Read these first:

```text
README.md
PROJECT_STATUS.md
src/shared/types.ts
src/server/orchestrator.ts
src/server/chromiumEnvironment.ts
src/server/scoring.ts
```

Then run:

```bash
npm run smoke
```

The smoke test is the fastest way to confirm the core loop still works.
