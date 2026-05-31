# Agent Guide

This file is the operating guide for AI agents working on lvl.

## Project Summary

lvl is a local-first AI agent evaluation arena. It runs head-to-head matches between model + harness combinations inside reproducible browser tasks, records traces, scores runs, shows replays, and computes simple Elo standings.

Core loop:

```text
Create match
  -> run model through harness
  -> execute browser tool in isolated Chromium
  -> record trace and screenshot
  -> score run
  -> compare runs
  -> update analytics/Elo
```

Do not treat this as a normal chatbot app. The important product surface is evidence: traces, screenshots, tool calls, score events, and replay.

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
npm run smoke
```

Benchmarks:

```bash
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
POST /api/matches
POST /api/matches/:id/cancel
GET  /api/analytics
GET  /task-pages/:taskId?seed=818
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
- Execute model/harness/browser steps.
- Persist trace steps.
- Score runs.
- Finish matches and choose winner.

Do not put scoring policy inside the orchestrator. Keep scoring in `src/server/scoring.ts`.

### Harness

The current harness is:

```text
src/server/harness.ts
```

It:

- Builds model input.
- Sends observation to model adapter.
- Normalizes a browser tool call.

It is intentionally simple. Future harness improvements should remain versioned and measurable.

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
```

The project owns its browser runtime through Playwright/Chromium. Do not reintroduce Ghost browser extension coupling.

Current flow:

```text
browser tool
  -> Playwright-backed runtime
  -> isolated Chromium context
  -> local task page
  -> indexed DOM actions and screenshots
```

Current browser actions:

- Snapshot/state.
- Click indexed element.
- Input indexed element.
- Keyboard press.
- Screenshot.

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
2. Update script extraction/execution in `chromiumEnvironment.ts`.
3. Add score event behavior if action affects scoring.
4. Run `npm run smoke`.

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
- `simple-checkout-popup`
- `confirm-button-decoy`

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
4. Add multi-seed benchmark suites.
5. Add side-by-side run comparison.
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
