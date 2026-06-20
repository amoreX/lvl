# lvl

lvl is a local-first AI agent evaluation arena focused only on model-vs-model chess.

The current loop is:

```text
Create chess match -> Run both models through the harness -> Execute moves on Chromium chess board -> Record trace -> Score game -> Replay board
```

## Current MVP

- Vite + React local dashboard.
- Express API server.
- SQLite storage under `data/`, with one-time migration from the old JSON state file when present.
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
- Match table with paired-match score, models, time, duration, and cost.
- Trace modal with aggregate scoreboard, per-game result cards, quality average, illegal count, PGN links, and game/model filters.
- Chess replay board with game selector, `Start`, `Latest`, slider, arrow-key stepping, live polling, PGN link, and scrollable move log.
- PGN export for full paired matches or one game at a time.
- Searchable OpenRouter model picker in the match form.
- Live OpenRouter catalog search, with starred and recent model picks stored locally.
- CLI tournament runner for repeated paired matches and aggregate leaderboard/Elo output.

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
npm run stockfish:test
npm run chess:match
npm run tournament:run
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
STOCKFISH_REQUIRED=true
STOCKFISH_PATH=stockfish
STOCKFISH_DEPTH=8
STOCKFISH_MOVETIME_MS=0
STOCKFISH_TIMEOUT_MS=2500
STOCKFISH_ADJUDICATION_THRESHOLD_CP=150
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
src/server/stockfish.ts     Required Stockfish UCI evaluator
src/server/chromiumEnvironment.ts  Chromium chess board + replay page
src/server/modelAdapters.ts Model adapters
src/server/browserActionParser.ts Browser script/action parser
src/server/contextCompaction.ts Harness-side context dump compaction
src/server/openRouterModels.ts Live OpenRouter catalog search
src/server/storage.ts       SQLite storage and analytics
src/server/seeds.ts         Seeded chess task/models/harness
src/shared/types.ts         Shared protocol types
scripts/run-chess-match.ts  CLI chess match runner
scripts/run-tournament.ts   CLI tournament/batch runner
```

## API Routes

```text
GET  /api/health
GET  /api/bootstrap
GET  /api/models/openrouter?q=<query>
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
- Stockfish centipawn-loss move quality for every legal move.
- Stockfish final-position adjudication when a game reaches the move cap.
- Structured chess metrics on scorecards: moves analyzed, average centipawn loss, average and worst advantage swing, inaccuracies, mistakes, blunders, and illegal moves.
- Legal move progress.
- Illegal/incomplete move penalties.
- Tool call count and rough efficiency.
- Cost and latency metadata.

## Tournament Runs

Run every model pair for repeated paired chess matches:

```bash
npm run tournament:run
```

Useful variables:

```env
TOURNAMENT_MODELS=openrouter-gpt-4o-mini,openrouter-gemini-flash,openrouter-qwen-9b
TOURNAMENT_ROUNDS=1
TOURNAMENT_MAX_PLIES=24
TOURNAMENT_MEMORY_MODE=fresh
TOURNAMENT_RESET_STATE=false
```

The runner prints aggregate match points, Elo, average score, average quality, average CPL, illegal moves, and cost.

## Remaining Work

The detailed live roadmap is in `PROJECT_STATUS.md`.

Current major remaining pieces:

- Web UI tournament scheduler, so batch runs do not require the CLI.
- Better chess move extraction from messy model text, SAN, and UCI before falling back to browser clicks.
- Bundled Stockfish WASM/binary option so engine scoring works without local setup.
- Better move-cap adjudication beyond simple material balance.
- PGN import and replay for external games.
- Storage compaction/archival once match volume grows.

## Data

Local data is intentionally ignored by git:

```text
data/
artifacts/
dist/
node_modules/
```

