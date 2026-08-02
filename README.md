# lvl

lvl is a local-first arena for evaluating AI agents through evidence-backed chess matches and puzzle batches. Clone it, run the local daemon, connect an OpenRouter key, pick models/harnesses/challenges, and inspect traces, replay, PGN, cost, latency, and Stockfish-backed scoring.

For the full current-state and customization guide, see [STATUS.md](./STATUS.md).

## What It Does

- Runs paired chess matches so each model gets White once.
- Runs configurable chess puzzle/task packs from local JSON.
- Lets users compare model + harness stacks head-to-head.
- Records model output, browser tool calls, score events, illegal moves, replay frames, PGN, latency, and estimated cost.
- Scores legal chess moves with Stockfish and stores everything locally in SQLite under `data/`.
- Supports UI batch launches and CLI tournament runs.

## Quickstart

Prerequisites:

- Node.js with `node:sqlite` support.
- A Stockfish UCI binary available as `stockfish` on `PATH`, or configured with `STOCKFISH_PATH`.
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

Save your OpenRouter key in the setup card, then create a match or batch from the New Match form.

## Useful Commands

```bash
npm run setup            # Prepare .env.local, local dirs, and browser runtime
npm run dev              # setup + daemon + web
npm run daemon           # Local API/worker daemon
npm run web              # Web app, waits for daemon health
npm run build            # Typecheck and build web app
npm run typecheck        # TypeScript check
npm run parser:test      # Browser action parser test
npm run harness:check    # Validate data/harness-adapters.json
npm run taskpacks:check  # Validate data/task-packs.json
npm run stockfish:test   # Engine smoke test
npm run chess:match      # Single CLI chess match
npm run tournament:run   # CLI tournament matrix
```

## Local Customization

Add custom harnesses:

```bash
mkdir -p data
cp examples/harness-adapters.example.json data/harness-adapters.json
npm run harness:check
```

Add custom puzzle/task packs:

```bash
mkdir -p data
cp examples/task-packs.example.json data/task-packs.json
npm run taskpacks:check
```

Restart the daemon after editing either local config file. The UI daemon panel reports config errors, and valid harnesses/tasks appear in the New Match form.

## Verification Flow

```bash
npm run setup
npm run stockfish:test
npm run parser:test
npm run harness:check
npm run taskpacks:check
npm run build
```

Then run `npm run dev`, create a short match or batch, and confirm replay, PGN, scorecard, illegal move count, latency, estimated cost, and model/harness/task analytics populate.

## License

MIT
