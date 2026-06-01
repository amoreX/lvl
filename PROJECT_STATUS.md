# lvl Project Status

## Current State

lvl is a local-first AI agent evaluation arena focused only on chess. The old target-grid, checkout, popup, decoy, one-move chess verification, benchmark, and multi-seed smoke game paths have been removed from the codebase.

The app currently supports:

- Creating model-vs-model chess matches.
- Running paired two-game matches so each agent plays White once.
- Executing moves on an owned Playwright/Chromium chess board.
- Validating moves with `chess.js`.
- Retrying after illegal or incomplete moves instead of immediately forfeiting.
- Recording model outputs, browser tool calls, actions, score events, cost, and latency.
- Auto-compacting long `Context dump` histories at harness time using the Ghost/Pi-style 70% context-window policy.
- Replaying a match on a chess board with arrow keys, `Start`, `Latest`, a slider, and live polling.
- Exporting PGN for a full paired match or a single game.
- Scoring legal moves with Stockfish centipawn loss when a local UCI binary is available, with heuristic fallback otherwise.
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
- Model selectors for Model 1 and Model 2.
- `Memory mode` selector:
  - `Fresh state`
  - `Context dump`
- No user-facing seed controls; each match gets its runtime randomness internally when it starts.
- Full-width match table with paired-match score, models, start time, duration, and cost.
- Delete action for removing an old match log, its runs, and its trace steps.
- Match modal with filtered logs, aggregate paired scoreboard, per-game result cards, quality average, illegal count, and PGN links.
- Formatted model output, including fenced code blocks and raw JSON tool calls.

### Chess Runtime

- Only `chess-full-match` is seeded.
- The old non-chess task renderer code has been removed.
- The old simulated browser environment has been removed.
- The Chromium page now renders only the chess board and replay UI.
- The backend still keeps screenshots in trace observations, but the normal UI hides screenshot and element-tree dumps.

### Orchestrator

- Chess is the only active match runner path.
- Each user-created match launches two turn-based games in parallel: A-White/B-Black and B-White/A-Black.
- Context dump compaction is treated as harness work and excluded from run latency/timer accounting.
- Cancellation removes queued jobs, aborts the active model request, marks match/runs cancelled, and lets Chromium cleanup run in `finally`.
- Scorecards are generated from game result, material, illegal move counts, tool efficiency, and Stockfish-backed move quality when available.

### Storage

- SQLite-backed storage lives in `data/lvl-state.sqlite` by default.
- Existing JSON state from `data/lvl-state.json` is imported automatically when the SQLite database is empty.
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
GET  /api/matches/:id/pgn
POST /api/matches
POST /api/matches/:id/cancel
DELETE /api/matches/:id
GET  /api/analytics
GET  /task-pages/chess-full-match?matchId=<matchId>&game=1
```

### Stockfish

- `src/server/stockfish.ts` talks to a UCI-compatible Stockfish binary.
- Configure it with `STOCKFISH_PATH`, `STOCKFISH_DEPTH`, and `STOCKFISH_TIMEOUT_MS`.
- If no binary is installed, move quality falls back to the local heuristic so matches still run.

## Known Limitations

- No tournament scheduler yet.
- Stockfish is optional and depends on a local binary; there is no bundled WASM engine yet.
- Context dump is compacted automatically, but compact summaries are still approximate and should be tuned with real long-match traces.
- Cost estimates depend on provider usage metadata where available.

## Next Useful Work

- Bundle a Stockfish WASM/binary option so engine scoring works out of the box.
- Add PGN import.
- Add tournament batches when chess evaluation needs repeated randomized runs.
- Add UI controls for context compaction window/threshold if needed.
- Add better adjudication policy at move cap.
- Add storage compaction/archival once match volume grows.

