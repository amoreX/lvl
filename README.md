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
- Lets users link their own local harness adapters and compare harnesses head-to-head.

## Quickstart

Prerequisites:

- Node.js with `node:sqlite` support.
- A Stockfish UCI binary available as `stockfish` on `PATH`, or configured with `STOCKFISH_PATH`.
- Playwright Chromium, installed by `npm run setup`.
- An OpenRouter API key for real model matches.

```bash
git clone https://github.com/amoreX/lvl.git
cd lvl
npm install
npm run setup
npm run stockfish:test
npm run dev
```

Open:

```text
http://localhost:5173
```

`npm run dev` runs setup, starts the local daemon, and starts the web app. `npm run stockfish:test` is the fastest way to verify objective chess scoring before running matches.

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
npm run harness:check    # Validate local harness adapter config/modules
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
STOCKFISH_PATH=stockfish
TOURNAMENT_MAX_COST_USD_PER_RUN=20
```

On macOS, `brew install stockfish` usually makes `stockfish` available at `/opt/homebrew/bin/stockfish` or `/usr/local/bin/stockfish`. On Linux, install the distro package or download a UCI binary and set `STOCKFISH_PATH`.

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
GET    /api/daemon/status
GET    /api/bootstrap
GET    /api/settings/local
PUT    /api/settings/local
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

## Bring Your Own Harness

lvl does not need to know your harness prompt or internal strategy.

To link a harness, create an ignored local file:

```text
data/harness-adapters.json
```

Start from the tracked example:

```bash
mkdir -p data
cp examples/harness-adapters.example.json data/harness-adapters.json
npm run harness:check
```

Example:

```json
[
  {
    "id": "my-company-harness",
    "name": "My Company Harness",
    "version": "0.1.0",
    "description": "Local harness adapter for lvl.",
    "modulePath": "./examples/harnesses/cautious-harness.js",
    "exportName": "createHarness"
  }
]
```

The module should export a factory:

```js
export function createHarness({ harness, model, callModel, normalizeBrowserTool }) {
  return {
    async runStep(input) {
      const output = await callModel({
        system: "Your harness system prompt goes here.",
        observation: input.observation,
        contextDump: input.contextDump,
        abortSignal: input.abortSignal,
        budget: {
          maxTokens: 4096,
          maxToolCalls: input.maxToolCalls,
          timeoutMs: input.timeoutMs
        },
        metadata: {
          runId: input.runId,
          seed: input.seed,
          stepIndex: input.stepIndex,
          modelId: model.id,
          harnessId: harness.id
        }
      });

      return {
        ...output,
        browserTool: normalizeBrowserTool(output.browserTool)
      };
    }
  };
}
```

Run `npm run harness:check` after editing `data/harness-adapters.json`. It validates JSON shape, imports each module, and confirms the factory export exists. Restart the daemon after changes. Linked harnesses appear in the New Match form, so users can run:

- same model vs same model with different harnesses
- different models with the same harness
- different model + harness stacks against each other

Harness config errors also appear in the local daemon panel.

## Measurement Notes

lvl stores trace evidence and aggregate measurements locally:

- model output, parsed browser tool calls, and score events
- PGN and replay frames for each game
- Stockfish move quality, average centipawn loss, inaccuracies, mistakes, blunders, and illegal moves
- active latency, model-call latency, wall-clock duration, token usage, and estimated cost
- model, task, and harness aggregate analytics

OpenRouter costs are estimated from token counts unless provider-specific pricing is added. Use them for rough budgeting, not billing-grade comparisons.

## Golden Smoke Flow

Use this flow after setup changes or before opening a PR:

```bash
npm run setup
npm run stockfish:test
npm run parser:test
npm run harness:check
npm run build
```

Then start the app:

```bash
npm run dev
```

In the site, confirm daemon health is green, save an OpenRouter key if needed, create a short match, open the match detail, and verify replay, PGN, scorecard, illegal move count, latency, estimated cost, and harness analytics populate.

## Troubleshooting

- `Stockfish is required for lvl chess scoring`: install Stockfish or set `STOCKFISH_PATH` in `.env.local`, then run `npm run stockfish:test`.
- `chromium runtime missing`: run `npm run setup` so Playwright installs Chromium.
- `OpenRouter API key is not configured`: save the key in the setup panel or set `OPENROUTER_API_KEY` in `.env.local`.
- Custom harness does not appear: run `npm run harness:check`, fix any JSON/module/export errors, then restart the daemon.
- Matches fail immediately after selecting a custom harness: check that the module exports `createHarness()` or the configured `exportName`, and that it returns an object with `runStep(input)`.

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

- Add web tournament setup and progress views.
- Bundle runtime dependencies for normal users.
- Add exportable JSON/CSV/PGN reports.
- Add billing-grade provider cost metadata.
- Add in-app harness creation/editing instead of local JSON only.

## License

MIT
