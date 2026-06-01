# lvl

lvl is a local-first AI agent evaluation arena focused only on model-vs-model chess.

The current loop is:

```text
Create chess match -> Run both models through the harness -> Execute moves on Chromium chess board -> Record trace -> Score game -> Replay board
```

## Current MVP

- Vite + React local dashboard.
- Express API server.
- JSON-file storage under `data/`.
- Playwright/Chromium chess board runtime.
- `chess.js` legal move validation.
- Paired two-game chess matches: both selected models get one game as White.
- No CPU opponent, no other browser games.
- Illegal or incomplete moves are penalized and the same agent retries.
- Match randomness is assigned internally when a match starts; there are no user-facing seed controls.
- Match memory mode:
  - `Fresh state`: only current board/observation is sent.
  - `Context dump`: the active agent also receives its own prior observations, outputs, tool inputs, actions, and score events.
- Ghost-style harness compaction for long context dumps: token estimates use a conservative `char/3` ratio and compact near 70% of usable context.
- Match table with winner, models, time, duration, and cost.
- Trace modal with game and agent filters.
- Chess replay board with game selector, `Start`, `Latest`, slider, arrow-key stepping, live polling, PGN link, and scrollable move log.
- PGN export for full paired matches or one game at a time.
- OpenRouter and dummy model adapters.

## Run Locally

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
npm run typecheck
npm run build
npm run parser:test
npm run chess:match
```

## Environment

Secrets belong in ignored local env files:

```text
.env.local
.env
```

Useful variables:

```env
OPENROUTER_API_KEY=
OPENROUTER_MODEL=openai/gpt-4o-mini
MODEL_MAX_TOKENS=4096
MODEL_REQUEST_TIMEOUT_MS=120000
CONTEXT_WINDOW_TOKENS=200000
CONTEXT_COMPACTION_TRIGGER_RATIO=0.70
CONTEXT_COMPACTION_COOLDOWN_MS=30000
MATCH_DEFAULT_TIMEOUT_MS=300000
MATCH_DEFAULT_MAX_STEPS=40
MATCH_DEFAULT_MAX_TOOL_CALLS=160
BROWSER_MAX_ACTIONS_PER_CALL=50
```

## Architecture

```text
src/client/                 React UI
src/server/index.ts         Express API
src/server/orchestrator.ts  Chess match runner and scoring
src/server/chromiumEnvironment.ts  Chromium chess board + replay page
src/server/modelAdapters.ts Model adapters
src/server/browserActionParser.ts Browser script/action parser
src/server/contextCompaction.ts Harness-side context dump compaction
src/server/storage.ts       JSON storage and analytics
src/server/seeds.ts         Seeded chess task/models/harness
src/shared/types.ts         Shared protocol types
scripts/run-chess-match.ts  CLI chess match runner
```

## API Routes

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

## Chess Task

Only one task is seeded:

```text
chess-full-match
```

Behavior:

- Each created match runs two games in parallel.
- Game 1: Model 1 is White, Model 2 is Black.
- Game 2: Model 2 is White, Model 1 is Black.
- Models click source square, then destination square.
- Promotions default to queen.
- Legal moves are validated server-side with `chess.js`.
- The match ends by checkmate, draw, or move cap adjudication.
- Thinking time is tracked as latency/cost but there is no chess clock forfeit.
- Runtime randomness is generated server-side at match start. It is kept as internal metadata for the Chromium environment and future randomized hurdles.

## Scoring

Chess match scoring happens in `src/server/orchestrator.ts`.

It considers:

- Win/loss/draw result.
- Material balance at move cap.
- Heuristic chess move quality: captures, checks, material swing, and obvious hanging-piece risk.
- Legal move progress.
- Illegal/incomplete move penalties.
- Tool call count and rough efficiency.
- Cost and latency metadata.

## Data

Local data is intentionally ignored by git:

```text
data/
artifacts/
dist/
node_modules/
```

