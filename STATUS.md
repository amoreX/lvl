# lvl Current State And Customization Guide

This document tracks what lvl can do today, what installers can customize without source edits, and where code changes are still required.

## Current Product Stage

lvl is a local-first chess evaluation runner. It is not a general browser-game marketplace yet. The supported runtime is a browser chess board with objective `chess.js` legality checks and Stockfish scoring.

Current state:

- Real model calls run through OpenRouter.
- Matches run as paired games so both sides get White once.
- Custom harnesses are supported through local JSON and local adapter modules.
- Custom chess puzzle/task packs are supported through local JSON.
- The web UI can launch one match or a batch of matches over selected/filtered challenges.
- Analytics include model, harness, task, score distribution, failure labels, latency, and estimated cost.

## Configurable Without Code Changes

### Models

Users can choose seeded OpenRouter models or search the live OpenRouter catalog from the UI. The OpenRouter key can be saved in the setup panel or set in `.env.local`.

### Harnesses

Users can add custom harnesses by editing:

```text
data/harness-adapters.json
```

Start from:

```text
examples/harness-adapters.example.json
examples/harnesses/cautious-harness.js
```

Validate with:

```bash
npm run harness:check
```

Minimum harness adapter shape:

```js
export function createHarness({ harness, model, callModel, normalizeBrowserTool }) {
  return {
    async runStep(input) {
      const output = await callModel({
        system: "Your harness prompt.",
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

### Chess Puzzle And Task Packs

Users can add local puzzle lists by editing:

```text
data/task-packs.json
```

Start from:

```text
examples/task-packs.example.json
```

Validate with:

```bash
npm run taskpacks:check
```

Minimum puzzle pack shape:

```json
[
  {
    "id": "my-chess-pack",
    "title": "My Chess Pack",
    "description": "Optional description.",
    "puzzles": [
      {
        "id": "opening-mini-match",
        "title": "Opening Mini Match",
        "difficulty": "easy",
        "maxPlies": 16,
        "instructions": "Play a short legal chess game from the start position."
      },
      {
        "id": "endgame-1",
        "title": "King And Pawn Endgame",
        "difficulty": "medium",
        "fen": "8/8/8/8/4k3/8/4K3/4P3 w - - 0 1",
        "maxPlies": 24,
        "instructions": "Play accurately from the supplied FEN."
      }
    ]
  }
]
```

Supported fields:

- `id`: stable local identifier.
- `title`: shown in the UI.
- `difficulty`: `easy`, `medium`, or `hard`.
- `fen`: optional chess FEN. If omitted, the normal starting position is used.
- `maxPlies`: maximum half-moves for the challenge.
- `instructions`: prompt text shown to the model.

After restart, each puzzle becomes a task in the New Match form. Users can filter by difficulty, choose a single challenge, set a batch count, and either repeat the selected challenge or cycle through filtered challenges.

## What Requires Minimal Code Changes

### New Chess Measurement Fields

If users want extra chess metrics beyond the current Stockfish and legality signals, edit:

```text
src/server/orchestrator.ts
src/shared/types.ts
src/server/storage.ts
src/client/App.tsx
```

Typical examples:

- custom success labels
- additional Stockfish depth/movetime display
- per-opening tags
- custom aggregate charts

### New Model Providers

OpenRouter is the implemented real provider. Another provider requires a new adapter in:

```text
src/server/modelAdapters.ts
```

### New Browser Runtime Types

Arbitrary non-chess browser puzzles are not config-only yet. They require code because rendering, action extraction, state validation, and scoring are runtime-specific.

Expected touch points:

```text
src/server/chromiumEnvironment.ts
src/server/orchestrator.ts
src/shared/types.ts
src/client/App.tsx
```

The current JSON task pack layer intentionally keeps third-party additions inside chess so they remain objectively scoreable with Stockfish.

## UI Capabilities

The New Match form supports:

- selecting two models
- selecting a harness per model
- selecting a challenge/task
- filtering tasks by difficulty
- choosing memory mode
- choosing batch count
- repeating one selected challenge or cycling through filtered challenges

The daemon panel reports:

- Stockfish readiness
- Chromium readiness
- OpenRouter key state
- harness config errors
- task pack config errors
- worker activity

## Measurement Semantics

Stored per run:

- raw model output
- parsed browser tool input
- browser actions
- trace steps
- score events
- legal and illegal move signals
- PGN and replay data
- Stockfish move quality
- active latency
- model-call latency
- wall-clock duration
- estimated cost

Cost is estimated from token counts and should not be treated as billing-grade until provider-specific pricing metadata is added.

## Known Limits

- Harness and task pack config files require daemon restart after edits.
- Task packs currently support chess challenges only.
- There is no in-app JSON editor for harnesses or task packs.
- Batch launch exists in the UI, but full tournament matrix setup is still CLI-first.
- Exportable CSV/JSON reports are not implemented yet.
- Provider cost is estimated.

## Local Files

Ignored local customization files:

```text
.env.local
data/harness-adapters.json
data/task-packs.json
data/lvl-state.sqlite
data/lvl-settings.json
local-harnesses/
artifacts/
report/
```
