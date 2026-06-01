# Agent Guide

This is the operating guide for AI agents working on lvl.

## Project Summary

lvl is currently a chess-only, local-first AI agent evaluation arena. Do not add target-grid, checkout, popup, decoy, or other browser mini-games back unless the user explicitly asks.

Core loop:

```text
Create chess match
  -> run model through harness
  -> execute browser tool on Chromium chess board
  -> validate move with chess.js
  -> record trace
  -> score chess result
  -> replay board
```

## Commands

```bash
npm install
npm run dev
npm run typecheck
npm run build
npm run parser:test
npm run chess:match
```

## Important Paths

```text
src/client/                  React UI
src/server/index.ts          Express API
src/server/orchestrator.ts   Chess match runner, cancellation, scoring
src/server/chromiumEnvironment.ts  Chess board runtime and replay page
src/server/modelAdapters.ts  Dummy/OpenRouter model adapters
src/server/browserActionParser.ts Browser action parser
src/server/contextCompaction.ts Context dump compaction tracker
src/server/storage.ts        JSON storage and analytics
src/server/seeds.ts          Chess-only seed data
src/shared/types.ts          Shared protocol types
scripts/run-chess-match.ts   CLI chess match runner
README.md                    Product/build overview
PROJECT_STATUS.md            Current state and roadmap
```

## Current Product Rules

- Only `chess-full-match` should be available as a task.
- Agent A is White.
- Agent B is Black.
- Chess is always turn-based/sequential.
- Do not show run mode in the UI.
- Do not show task selection in the UI.
- Do not show seed controls in the UI; match randomness is assigned internally when a match starts.
- Keep runtime seed/randomness backend-owned. It can support replay/environment randomness and future hurdles, but should not reappear as a normal match-creation choice.
- Do not show non-chess games in docs, scripts, seeds, or runtime code.
- Keep the normal replay focused on model actions, score events, output, and board moves.
- Deleting a match log should remove the match, both runs, and their trace steps; if it is active, cancel it first.
- Do not show screenshot banners or huge element-tree dumps by default.

## Match Memory

Match memory mode is stored on the match:

- `fresh`: only the current board/observation is sent to the active model.
- `context_dump`: the active agent also receives its own previous observations, raw outputs, tool inputs, executed actions, and score events. Screenshots are excluded.

Long context dumps are auto-compacted by `src/server/contextCompaction.ts`.

The compaction policy mirrors Ghost's Pi session compaction shape:

- Estimate tokens with `char/3`.
- Use `CONTEXT_WINDOW_TOKENS` as the model context window, default `200000`.
- Trigger at `CONTEXT_COMPACTION_TRIGGER_RATIO`, default `0.70`.
- Respect `CONTEXT_COMPACTION_COOLDOWN_MS`, default `30000`, unless the dump is near the hard limit.
- Produce a compact prior-turn summary and keep raw turns after the latest compaction.
- Treat compaction as harness work and exclude compaction elapsed time from match/run latency.

## Cancellation

Cancellation should:

- Remove queued jobs for the match.
- Abort active model requests through `AbortController`.
- Mark match/runs cancelled.
- Let Chromium cleanup run in `finally`.

If you touch cancellation, run:

```bash
npm run typecheck
npm run build
```

## API Routes

```text
GET  /api/health
GET  /api/bootstrap
GET  /api/matches
GET  /api/matches/:id
GET  /api/matches/:id/replay
POST /api/matches
POST /api/matches/:id/cancel
DELETE /api/matches/:id
GET  /api/analytics
GET  /task-pages/chess-full-match?matchId=<matchId>
```

## Browser Tool Contract

The harness expects one browser tool call per step:

```json
{"mode":"run","script":"const tab = await browser.currentTab(); await tab.click(213); await tab.click(229); return await tab.snapshot();"}
```

The parser should continue accepting:

- Fenced JSON.
- Raw one-line JSON.
- JSON embedded in prose.
- Nested wrapper objects.
- Direct scripts.
- Chess square references when possible.

## Scoring

Chess scorecards are built in `src/server/orchestrator.ts`.

They should remain explainable from:

- Game result.
- Material balance.
- Illegal/incomplete move counts.
- Step/tool efficiency.
- Cost and latency metadata.

Do not add opaque LLM-judge scoring until objective chess scoring is solid.

## Testing Expectations

For code changes:

```bash
npm run typecheck
npm run build
```

For parser changes:

```bash
npm run parser:test
```

For runtime chess checks:

```bash
npm run chess:match
```

