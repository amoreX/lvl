# lvl Project Status

## Current State

lvl is a local-first AI agent evaluation arena focused only on chess. The old target-grid, checkout, popup, decoy, one-move chess verification, benchmark, and multi-seed smoke game paths have been removed from the codebase.

The app currently supports:

- Creating model-vs-model chess matches.
- Running Agent A as White and Agent B as Black.
- Executing moves on an owned Playwright/Chromium chess board.
- Validating moves with `chess.js`.
- Retrying after illegal or incomplete moves instead of immediately forfeiting.
- Recording model outputs, browser tool calls, actions, score events, cost, and latency.
- Auto-compacting long `Context dump` histories at harness time using the Ghost/Pi-style 70% context-window policy.
- Replaying a match on a chess board with arrow keys, `Start`, `Latest`, a slider, and live polling.
- Viewing a scrollable move log next to the board.
- Cancelling queued or running matches, including aborting in-flight OpenRouter requests.

## Commands

```bash
npm install
npm run dev
npm run typecheck
npm run build
npm run parser:test
npm run chess:match
```

## What Is Built

### UI

- Hero with embedded `lvl` logo and compact chess-only match form.
- Model selectors for Agent A and Agent B.
- `Memory mode` selector:
  - `Fresh state`
  - `Context dump`
- No user-facing seed controls; each match gets its runtime randomness internally when it starts.
- Full-width match table with winner, models, start time, duration, and cost.
- Delete action for removing an old match log, its runs, and its trace steps.
- Match modal with filtered logs.
- Formatted model output, including fenced code blocks and raw JSON tool calls.

### Chess Runtime

- Only `chess-full-match` is seeded.
- The old non-chess task renderer code has been removed.
- The old simulated browser environment has been removed.
- The Chromium page now renders only the chess board and replay UI.
- The backend still keeps screenshots in trace observations, but the normal UI hides screenshot and element-tree dumps.

### Orchestrator

- Chess is the only active match runner path.
- Runs are turn-based and sequential.
- Context dump compaction is treated as harness work and excluded from run latency/timer accounting.
- Cancellation removes queued jobs, aborts the active model request, marks match/runs cancelled, and lets Chromium cleanup run in `finally`.
- Scorecards are generated directly from chess result/material/illegal move counts.

### Storage

- JSON-backed storage remains in `data/lvl-state.json`.
- Seed tasks are now replaced with the current chess-only seed list on load, so old task definitions are not kept alive by persisted state.
- Match runtime randomness is still stored internally for replay/environment use, but users no longer choose or see seeds in the match form/table.

### Context Compaction

- `src/server/contextCompaction.ts` tracks each agent's own prior turns in `Context dump` mode.
- It estimates token usage with `char/3`, compacts near 70% of usable context, and keeps raw turns after the latest compaction.
- Compaction elapsed time is excluded from run latency so the timer reflects model/tool work, not harness bookkeeping.

## Routes

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

## Known Limitations

- No database yet; storage is JSON-file based.
- No tournament scheduler yet.
- No engine-based chess quality evaluation yet.
- No PGN export yet.
- Context dump is compacted automatically, but compact summaries are still approximate and should be tuned with real long-match traces.
- Cost estimates depend on provider usage metadata where available.

## Next Useful Work

- Add PGN export/import.
- Add chess-specific model quality metrics beyond win/loss/material.
- Add tournament batches when chess evaluation needs repeated randomized runs.
- Add UI controls for context compaction window/threshold if needed.
- Add better adjudication policy at move cap.
- Move storage to SQLite once match volume grows.

