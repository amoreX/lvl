# Full-Game Tournament Matrix Report - 2026-06-20

## Summary

Ran a full-length 3-model matrix from the CLI using fresh memory mode and Stockfish-only chess scoring.

This was the proper run after the earlier 24-ply smoke test. The cap was raised to the app's full chess task limit:

- 3 paired matches
- 6 total chess games
- 120 model-turn/attempt cap per game
- $20 max cost per agent run, per game
- Fresh memory mode
- Stockfish move scoring and move-cap adjudication

All three paired matches completed.

The strongest model in this run was `openrouter-google-gemini-flash-latest`.

## Command

```bash
TOURNAMENT_MODELS=openrouter-gpt-4o-mini,openrouter-google-gemini-flash-latest,openrouter-qwen-9b \
TOURNAMENT_ROUNDS=1 \
TOURNAMENT_MAX_PLIES=120 \
TOURNAMENT_MAX_COST_USD_PER_RUN=20 \
TOURNAMENT_MEMORY_MODE=fresh \
TOURNAMENT_WAIT_MS=10800000 \
npm run tournament:run
```

## Runtime

The run took about 66.5 minutes.

```text
elapsed_ms: 3992593
```

## Completion Semantics

Not every game ended by checkmate.

In the current lvl runner, the `120` limit counts model turn attempts, including illegal or incomplete move attempts. So a model that repeatedly fails to make legal moves can hit the cap without producing 120 legal chess plies.

The completed games ended as follows:

- `openrouter-google-gemini-flash-latest` vs `openrouter-qwen-9b`, Game 1: checkmate.
- `openrouter-google-gemini-flash-latest` vs `openrouter-qwen-9b`, Game 2: Stockfish adjudication at the cap.
- `openrouter-gpt-4o-mini` vs `openrouter-google-gemini-flash-latest`: both games were Stockfish-adjudicated draws at the cap.
- `openrouter-gpt-4o-mini` vs `openrouter-qwen-9b`: both games were Stockfish-adjudicated draws at the cap.

## Budget Guardrail

This run used a `$20` cap per agent run per game.

That means each model's individual run inside each game had its own `$20` ceiling. If a run reached the cap, lvl would stop that match instead of continuing to spend.

No run came close to the cap in this matrix.

## Completed Matches

```text
COMPLETED Tournament R1: openrouter-gpt-4o-mini vs openrouter-qwen-9b
COMPLETED Tournament R1: openrouter-gpt-4o-mini vs openrouter-google-gemini-flash-latest
COMPLETED Tournament R1: openrouter-google-gemini-flash-latest vs openrouter-qwen-9b
```

## Leaderboard

| Rank | Model | Played | Points | Elo | Avg Score | Avg Quality | Avg CPL | Illegal Moves | Cost |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | `openrouter-google-gemini-flash-latest` | 2 | 3 | 1016 | 69.4 | 89.4 | 28.1 | 128 | $1.8179 |
| 2 | `openrouter-gpt-4o-mini` | 2 | 2 | 1000 | 49.0 | 67.8 | 55.8 | 471 | $4.6450 |
| 3 | `openrouter-qwen-9b` | 2 | 1 | 984 | 51.3 | 70.3 | 1702.1 | 26 | $0.8066 |

## Per-Match Details

### `openrouter-gpt-4o-mini` vs `openrouter-google-gemini-flash-latest`

Overall result: 1-1 by paired points. Both games were draws.

| Game | Color | Model | Result Points | Score | Quality | Avg CPL | Illegal | Cost |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | White | `openrouter-gpt-4o-mini` | 0.5 | 51.15 | 89.00 | 44.00 | 118 | $1.1719 |
| 1 | Black | `openrouter-google-gemini-flash-latest` | 0.5 | 71.65 | 96.00 | 17.00 | 0 | $0.0195 |
| 2 | White | `openrouter-google-gemini-flash-latest` | 0.5 | 70.15 | 98.67 | 5.67 | 1 | $0.0500 |
| 2 | Black | `openrouter-gpt-4o-mini` | 0.5 | 50.45 | 82.00 | 67.50 | 114 | $1.1467 |

### `openrouter-gpt-4o-mini` vs `openrouter-qwen-9b`

Overall result: 1-1 by paired points. Both games were draws.

| Game | Color | Model | Result Points | Score | Quality | Avg CPL | Illegal | Cost |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | White | `openrouter-gpt-4o-mini` | 0.5 | 47.25 | 50.00 | - | 120 | $1.1626 |
| 1 | Black | `openrouter-qwen-9b` | 0.5 | 66.75 | 50.00 | - | 0 | $0.0000 |
| 2 | White | `openrouter-qwen-9b` | 0.5 | 72.05 | 100.00 | 1.00 | 0 | $0.0201 |
| 2 | Black | `openrouter-gpt-4o-mini` | 0.5 | 47.25 | 50.00 | - | 119 | $1.1638 |

### `openrouter-google-gemini-flash-latest` vs `openrouter-qwen-9b`

Overall result: `openrouter-google-gemini-flash-latest` won 2-0 by paired points.

| Game | Color | Model | Result Points | Score | Quality | Avg CPL | Illegal | Cost |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | White | `openrouter-google-gemini-flash-latest` | 1.0 | 67.44 | 76.90 | 52.62 | 66 | $0.9201 |
| 1 | Black | `openrouter-qwen-9b` | 0.0 | 35.30 | 55.65 | 5041.20 | 9 | $0.3359 |
| 2 | White | `openrouter-qwen-9b` | 0.0 | 31.07 | 75.48 | 64.10 | 17 | $0.4506 |
| 2 | Black | `openrouter-google-gemini-flash-latest` | 1.0 | 68.34 | 85.95 | 36.95 | 61 | $0.8283 |

## Interpretation

`openrouter-google-gemini-flash-latest` was the clear winner. It scored 3 points out of 4 possible game points, had the best average score, best average quality, and lowest average CPL.

`openrouter-gpt-4o-mini` was expensive relative to the other two and produced a very high number of illegal or incomplete moves. Its result points were okay only because its games against Qwen and Gemini were adjudicated as draws, but the illegal count is a major weakness.

`openrouter-qwen-9b` was the cheapest and had the lowest illegal move count, but it lost both games against Gemini Flash latest. One Qwen run had an extremely high average CPL, which likely means one or more catastrophic Stockfish-evaluated position losses.

## Important Notes

This was much more meaningful than the 24-attempt smoke test, but it is still only one round.

For a serious leaderboard:

- Run at least 3-5 rounds.
- Keep the 120-ply cap.
- Keep the $20 per-run cap.
- Add a total tournament budget cap before scaling further.
- Fix/replace stale seeded model IDs before running larger matrices.
- Consider exporting CSV/JSON reports directly from the tournament runner.

