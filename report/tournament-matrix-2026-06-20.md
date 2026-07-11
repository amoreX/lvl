# Tournament Matrix Report - 2026-06-20

## Summary

Ran a 3-model cheap smoke matrix from the CLI using fresh memory mode.

Each pair played one paired lvl match. A paired match contains two color-swapped chess games, so the completed matrix produced:

- 3 paired matches
- 6 total chess games
- 24 ply cap per paired match game
- Stockfish-only move scoring and move-cap adjudication

The strongest performer in this run was `openrouter-google-gemini-flash-latest`.

## Command

```bash
TOURNAMENT_MODELS=openrouter-gpt-4o-mini,openrouter-google-gemini-flash-latest,openrouter-qwen-9b \
TOURNAMENT_ROUNDS=1 \
TOURNAMENT_MAX_PLIES=24 \
TOURNAMENT_MEMORY_MODE=fresh \
TOURNAMENT_WAIT_MS=1800000 \
npm run tournament:run
```

## Initial Failed Attempt

The first attempted matrix used the seeded model ID `openrouter-gemini-flash`.

That failed because OpenRouter returned `404` for the underlying seeded Gemini model. I searched the live OpenRouter catalog and replaced it with:

```text
openrouter-google-gemini-flash-latest
```

After upserting that live catalog model locally, the matrix completed.

## Completed Matches

```text
COMPLETED Tournament R1: openrouter-gpt-4o-mini vs openrouter-google-gemini-flash-latest
COMPLETED Tournament R1: openrouter-gpt-4o-mini vs openrouter-qwen-9b
COMPLETED Tournament R1: openrouter-google-gemini-flash-latest vs openrouter-qwen-9b
```

## Leaderboard

| Rank | Model | Played | Points | Elo | Avg Score | Avg Quality | Avg CPL | Illegal Moves | Cost |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | `openrouter-google-gemini-flash-latest` | 2 | 3 | 1016 | 73.2 | 86.3 | 6.8 | 17 | $0.3441 |
| 2 | `openrouter-gpt-4o-mini` | 2 | 2 | 1000 | 54.0 | 56.8 | 87.0 | 91 | $0.9154 |
| 3 | `openrouter-qwen-9b` | 2 | 1 | 984 | 55.2 | 71.7 | 65.8 | 5 | $0.2680 |

## Interpretation

`openrouter-google-gemini-flash-latest` clearly won this small matrix. It scored the most match points, had the highest average score, had the best Stockfish-backed chess quality, and had the lowest average centipawn loss.

`openrouter-gpt-4o-mini` was the most expensive model in this matrix and produced many illegal moves. The illegal move count is the biggest red flag from this run.

`openrouter-qwen-9b` was cheaper than GPT-4o Mini and had far fewer illegal moves, but it scored fewer match points overall.

## Metric Notes

- `Points`: paired-match chess points accumulated across games. Win = 1, draw = 0.5, loss = 0.
- `Elo`: temporary tournament Elo from this tiny run. Treat it as directional only.
- `Avg Score`: lvl's aggregate run score out of 100.
- `Avg Quality`: Stockfish-backed move quality aggregate.
- `Avg CPL`: average centipawn loss. Lower is better.
- `Illegal Moves`: count of illegal/incomplete move attempts.
- `Cost`: recorded OpenRouter cost for this tournament run.

## Caveats

This was a smoke matrix, not a serious benchmark.

Important limitations:

- Only 1 round was run.
- The move cap was only 24 plies.
- The model pool was only 3 cheap models.
- Results can vary between runs because model outputs are stochastic.
- The seeded `openrouter-gemini-flash` ID should be replaced or removed because it currently 404s.

## Recommended Next Run

Run the same three live models for 3 rounds at 40-60 plies after adding basic budget caps and fixing the stale seeded Gemini ID.

