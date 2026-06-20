# Stockfish Scoring Notes

This file explains the chess-engine words in plain English.

## FEN

FEN means "Forsyth-Edwards Notation".

It is just a compact text snapshot of a chess board.

Example idea:

```text
White pieces here, black pieces there, whose turn it is, castling rights, etc.
```

In lvl, each move creates a new board position, so each move creates a new FEN.

When we rate a move, we usually care about two FENs:

- `beforeFen`: the board before the agent moved.
- `afterFen`: the board after the agent moved.

Stockfish compares those positions to judge how much the move helped or hurt.

## Stockfish

Stockfish is a very strong chess engine.

It is not an LLM judge. It does not read vibes. It calculates chess positions.

For lvl, Stockfish is the objective scorer:

- Was the move good?
- Did it lose advantage?
- Did it blunder?
- Who is winning if the game hits the move cap?

## Depth

Depth means how many half-moves Stockfish searches ahead.

A half-move is called a ply.

Example:

```text
White moves = 1 ply
Black replies = 2 plies
White replies = 3 plies
Black replies = 4 plies
```

So `STOCKFISH_DEPTH=8` means Stockfish searches around 8 plies deep.

Higher depth is smarter but slower.

Good starting values:

- `8`: fast and decent.
- `10`: stronger, still usually okay.
- `12+`: better but slower for tournaments.

## Movetime

`STOCKFISH_MOVETIME_MS` means "let Stockfish think for this many milliseconds".

If this is `0`, lvl uses depth instead.

Example:

```env
STOCKFISH_DEPTH=8
STOCKFISH_MOVETIME_MS=0
```

This means "search to depth 8".

Example:

```env
STOCKFISH_MOVETIME_MS=200
```

This means "think for 200ms per position".

Depth is easier to understand. Movetime is sometimes better when you want predictable tournament speed.

## Centipawns

A centipawn is 1/100 of a pawn.

Examples:

```text
+100cp means White is about 1 pawn better.
+250cp means White is about 2.5 pawns better.
-100cp means Black is about 1 pawn better.
0cp means roughly equal.
```

Positive usually means White is better.

Negative usually means Black is better.

## Centipawn Loss

Centipawn loss, or CPL, means how much worse the played move was compared to Stockfish's best move.

Lower is better.

Simple example:

```text
Before the move, Stockfish's best line gives the agent +200cp.
The agent's actual move leads to only +80cp.
CPL = 120.
```

That move lost 120 centipawns of value.

Another example:

```text
Best move keeps equality: 0cp.
Agent hangs a queen and becomes -900cp.
CPL = 900.
```

That is a huge mistake.

## Average Centipawn Loss

Average CPL is the average centipawn loss across all legal moves by an agent.

Example:

```text
Move CPLs: 20, 40, 100, 0
Average CPL = 40
```

Lower average CPL means cleaner chess.

This is one of the best long-term quality metrics for model chess.

## Advantage Swing

Advantage swing means how much the position changed because of the move, from the moving agent's perspective.

Example:

```text
Agent was equal before move: 0cp.
After move, agent is losing: -300cp.
Advantage swing = -300cp.
```

Negative swing means the move made things worse.

Positive swing means the move improved the agent's position.

## Average Advantage Swing

Average advantage swing is the average position change across the agent's moves.

If it is usually negative, the agent is slowly making the position worse.

If it is usually positive, the agent is improving its position.

## Worst Advantage Swing

Worst advantage swing is the single biggest drop from one move.

Example:

```text
Most moves are okay.
Then one move hangs the queen.
Worst swing catches that disaster.
```

This is useful because average numbers can hide one massive blunder.

## Move Cap

The move cap is the maximum number of plies lvl allows before ending a game.

Without a move cap, bad agents could shuffle forever.

Example:

```env
MATCH_DEFAULT_MAX_STEPS=40
```

That means the match stops after 40 model turns/plies unless the game already ended by checkmate or draw.

## Move-Cap Adjudication

If a game reaches the move cap, there may be no checkmate yet.

Old simple method:

```text
Count material.
More material wins.
Equal material draws.
```

That is crude.

New Stockfish method:

```text
Ask Stockfish who is winning the final position.
If White is clearly better, White wins.
If Black is clearly better, Black wins.
If it is close, draw.
```

The threshold is controlled by:

```env
STOCKFISH_ADJUDICATION_THRESHOLD_CP=150
```

So if Stockfish says White is `+180cp`, White wins at the cap.

If Stockfish says `+40cp`, that is too close, so lvl calls it a draw.

## Score Out Of 100

lvl still stores a simple move quality score out of 100.

The score comes from centipawn loss:

```text
Low CPL = high score.
High CPL = low score.
```

Rough idea:

```text
0 CPL      -> 100/100
40 CPL     -> 90/100
120 CPL    -> 70/100
250+ CPL   -> bad
```

The labels like excellent/good/mistake/blunder are just human-readable helpers.

The important raw number is CPL.

## Required Stockfish

New lvl chess scoring is Stockfish-only.

That means:

- If Stockfish works, moves get scored.
- If Stockfish is missing, the match fails.
- If Stockfish times out, the match fails.
- There is no heuristic fallback for new scoring.

Install Stockfish locally or set:

```env
STOCKFISH_PATH=/path/to/stockfish
```

On many machines, if `stockfish` is on your shell path, this is enough:

```env
STOCKFISH_PATH=stockfish
```

