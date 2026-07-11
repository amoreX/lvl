# lvl

lvl is a local-first arena for evaluating AI agents in model-vs-model chess matches.

The goal is simple: clone the repo, start the local runner, open the site, connect your model provider key, and run battles with traceable evidence.

## What It Does

- Runs paired chess matches between two AI models.
- Plays two games per match so each model gets White once.
- Uses a browser-based chess board and validates moves with `chess.js`.
- Scores legal moves with Stockfish-backed chess evaluation.
- Records traces, model outputs, costs, latency, illegal moves, PGN, and replay data.
- Stores everything locally by default in SQLite under `data/`.
- Supports CLI tournament matrices for repeated model-vs-model runs.

## Quickstart

```bash
git clone https://github.com/amoreX/lvl.git
cd lvl
npm install
npm run dev
```

Open:

```text
http://localhost:5173
```

`npm run dev` runs setup, starts the local daemon, and starts the web app.

OpenRouter is bring-your-own-key. You can configure it from the setup card in the site after the daemon connects.

You can also set it manually in `.env.local`:

```env
OPENROUTER_API_KEY=your_key_here
```

The intended hosted/self-serve flow is that provider keys and runtime settings are configured from the site itself, not by editing files manually.

The top of the site shows daemon health:

- daemon connected/disconnected
- Stockfish readiness
- browser runtime readiness
- OpenRouter key configured/missing
- worker idle/running and queue depth

## Useful Commands

```bash
npm run setup            # Prepare .env.local, local dirs, and browser runtime
npm run daemon           # Local API/worker daemon
npm run web              # Web app, waits for daemon health
npm run dev              # setup + daemon + web
npm run start            # API server only, no watcher
npm run build            # Typecheck and build web app
npm run typecheck        # TypeScript check
npm run parser:test      # Browser action parser test
npm run stockfish:test   # Engine smoke test
npm run chess:match      # Single CLI chess match
npm run tournament:run   # CLI tournament matrix
```

## Environment

Copy `.env.example` to `.env.local` for local secrets.

Required today:

```env
OPENROUTER_API_KEY=
```

Common local settings:

```env
PORT=4321
VITE_API_URL=http://localhost:4321
DATABASE_URL=file:./data/lvl-state.sqlite
TOURNAMENT_MAX_COST_USD_PER_RUN=20
```

Future packaged builds should bundle the runtime dependencies and expose configuration in the site UI.

## Architecture

```text
src/client/                 React UI
src/server/index.ts         Express API
src/server/orchestrator.ts  Chess match runner, cancellation, scoring
src/server/stockfish.ts     Stockfish UCI evaluator
src/server/chromiumEnvironment.ts  Browser chess board + replay page
src/server/modelAdapters.ts Model adapters
src/server/browserActionParser.ts Browser action parser
src/server/contextCompaction.ts Context dump compaction
src/server/openRouterModels.ts OpenRouter catalog search
src/server/storage.ts       SQLite storage and analytics
src/server/seeds.ts         Seeded chess task/models/harness
src/shared/types.ts         Shared protocol types
scripts/run-chess-match.ts  CLI chess match runner
scripts/run-tournament.ts   CLI tournament runner
```

## API Routes

```text
GET    /api/health
GET    /api/bootstrap
GET    /api/models/openrouter?q=<query>
GET    /api/matches
GET    /api/matches/:id
GET    /api/matches/:id/replay
GET    /api/matches/:id/pgn
POST   /api/matches
POST   /api/matches/:id/cancel
DELETE /api/matches/:id
GET    /api/analytics
GET    /task-pages/chess-full-match?matchId=<matchId>&game=1
```

## Tournament Runs

Run a small matrix from the CLI:

```bash
TOURNAMENT_MODELS=openrouter-gpt-4o-mini,openrouter-google-gemini-flash-latest,openrouter-qwen-9b \
TOURNAMENT_ROUNDS=1 \
TOURNAMENT_MAX_PLIES=120 \
TOURNAMENT_MAX_COST_USD_PER_RUN=20 \
npm run tournament:run
```

The runner prints match points, Elo, average score, average chess quality, average centipawn loss, illegal moves, and cost.

## Local Files

These are intentionally ignored and should not be committed:

```text
.env.local
data/
artifacts/
report/
dist/
node_modules/
```

`data/` contains local SQLite state. `report/` is for generated local experiment reports.

## Near-Term Open Source Goals

- Add a local daemon command that starts the API, worker, engine, and browser runtime.
- Show daemon connection health in the site.
- Move provider key and runtime configuration into the web UI.
- Add web tournament setup and progress views.
- Bundle runtime dependencies for normal users.
- Add exportable JSON/CSV/PGN reports.

## License

MIT
