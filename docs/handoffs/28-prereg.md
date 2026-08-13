# Pre-registration — session 28: measure copyability, not performance

Written before any code for this session exists. Scored the same way as
`27-exit-rules.md`, `27-stop-family.md` and the ladder run.

## Why this session is not another exit rule

Twenty rules have been evaluated in this phase. **Every one of them is an exit
rule.** The entry side has exactly one variable ever tested — delay — and the
audit put that at ~4.3pp of margin. Meanwhile the ladder run closed the exit
family *by construction*: a ladder is a convex combination of full exits, so
`max(ladders) ≤ max(full exits, mirror)`, and the best full exit is refused for
flipping inside the band.

There is nothing left to search on the exit side of this wallet. Rule 21 would
be bounded above by a rule already refused.

The structural fact this session addresses instead: at entry delay **zero**, the
wallet's payoff is 1.20 and a copier's is 0.60. The wallet's own entry print is
better than any print available to something reacting to that entry. That is not
latency and not exit timing. It is the shape of the transformation, and nothing
measured so far quantifies it across wallets.

## The quantity this session introduces

**Copy gap**, per wallet:

    gap_w = own_outcome_margin_w − replay_margin_w

Both at matched trimmed estimators, losses truncated at 0.40, entry at 5.479 s,
mirror exit + 0.364 s, `c = 1.11%`, `M = 43`. One wallet is measured:

| | HSsJjkHr |
| --- | ---: |
| own-outcome margin | +19.5pp |
| replay margin | −27.4pp |
| **gap** | **47.0pp** |

**The claim under test: the screen currently in use measures the wrong
quantity.** Candidates are ranked on own-outcome margin. If the gap is roughly
constant, own-outcome margin is a rank-preserving but level-wrong statistic and
the bar is ~+47pp, not ~0. If the gap varies with something observable, its
variance is the screening dimension and no one is using it.

Either result is worth more than any remaining exit rule.

## Tasks, in this order. Free work first.

### Task 0 — retroactive top-1 mass share. FREE, NO RPC.

The 30-wallet screen established that `g_trim/g_med` detects a *shifted*
distribution and misses a *concentrated* one, and that top-1 winner mass share
is the right detector. That standard has never been applied to the original
twelve.

It is already known to fire: the largest single winner holds **83%** of winner
mass pooled and **98%** for `CT9dekyf`.

Emit, per wallet, over the n=4,501 corpus: `n`, win rate, `g_trim`, `g_med`,
**top-1 winner mass share**, top-3 share, and the `sol_in` of the top winner.
Apply `MIN_SOL_IN = 0.05` from `analysis/part1_decide.py:29` — the floor the
30-wallet screen forgot.

**Any wallet with top-1 share above 50% has its `g_trim` restated as
unreliable**, and every table in this phase that used it is annotated. This runs
first because it can change which wallets are eligible for Task 2.

### Task 1 — confluence. FREE, NO RPC.

Every signal is currently treated identically. The one piece of information the
architecture discards entirely is that two tracked wallets sometimes buy the
same mint close together.

Over the same corpus, partition entry decisions by how many *other* tracked
wallets bought the same mint within a window, and report the outcome
distribution for each bucket.

**Windows fixed now, from the observed hold distribution, not tuned after:**
130 s, 470 s, 1355 s — the p25/p50/p75 already used for the time exits.
**Buckets: 1 wallet (solo), 2, 3+.** Nine cells, `R += 9`.

This is a search and it is counted. **R goes 20 → 29. Band 43 .. 1247.**

### Task 2 — the copy gap on three wallets. EXPENSIVE.

Not eleven. The HSsJjkHr replay cost **62,217 calls and ~1.6 h**; eleven would
be ~680k calls, which is not a measurement, it is a budget.

**Three wallets, chosen on pool-depth spread, not on performance.** Take the
median pool depth at entry across each wallet's trips and pick the highest,
median, and lowest of the eligible set (eligible = survives Task 0, has ≥ 40
closed round trips). Chosen this way because depth is the mechanism the gap is
hypothesised to run through, and choosing on performance would rebuild the
selection problem this session exists to expose.

Same harness, same basis gate discipline: **the run aborts unless HSsJjkHr
reproduces −27.4pp** before any new wallet is priced.

Emit per wallet: own-outcome margin, replay margin, gap, median pool depth at
entry, median seconds since pool creation, and the wallet's own median price
impact.

**n=3 fits nothing.** This is a stability check, not a regression, and must be
reported as one.

## Predictions

Phase tally is **five optimistic misses to one pessimistic**. These are shaded
down accordingly, and that shading is stated so it can be scored too.

- **P1 — Task 0 fires on at least four of twelve** at the 50% threshold, and
  `CT9dekyf` is among them. At least one wallet that previously looked
  acceptable is restated as unreliable.
- **P2 — the copy gap is positive for all three wallets**, and its range across
  them is **wider than 20pp**. Constant-gap is the null and I expect it to fail;
  if the range comes back under 10pp the gap is a constant and own-outcome
  screening is simply level-wrong.
- **P3 — no wallet's gap is under 15pp.** No wallet in this set is cheaply
  copyable. If one comes back under 15pp it is the most important row in the
  phase and needs the same top-1 and basis-floor scrutiny as any pass.
- **P4 — the gap correlates negatively with pool depth at entry**, in sign.
  Deeper pools leave a print a copier can hit. Sign only; n=3 cannot support
  a magnitude.
- **P5 — confluence buckets 2 and 3+ have higher win rates than solo**, and the
  lift is **under 8pp at every window**, so nothing clears the deflated bar at
  R=29. I expect the direction to hold and the magnitude to disappoint.
- **P6 — the 3+ bucket is too thin to score** at the 130 s window, n < 30.

## Standing constraints

- **Nothing is sized.** `src/core/sizing.ts` stays unwired and
  `tests/sizing.test.ts` keeps asserting it.
- **No exit rule is written.** The ladder proof closed the family.
- **No new candidates are scraped.** With the gap unmeasured, a larger pool adds
  M to a screen that may be measuring the wrong quantity.
- **Basis floor +5.19pp.** Any margin in `(0, +5.19]` prints
  `INSIDE BASIS BIAS` and is not a pass.
- **A verdict differing between band ends is REFUSED, not read.**
- **`c` has still never met a fill.** Every margin here inherits that, and the
  handoff says so in its first paragraph, not its last.
- **No task is added after seeing a result.** Tasks 0 and 1 are free, and free
  compute is the exact condition under which a three-task session becomes a
  nine-task session.

## What each outcome retires

**Gap roughly constant near 47pp.** Own-outcome margin is a level-wrong screen
and the true bar is ~+47pp. No candidate measured to date clears it —
`BNnN2Mqf`'s +19.5pp is HSsJjkHr's own figure, which already produced a −27.4pp
replay. Mirror-copying is retired across the genus, not on one wallet, and that
is a materially stronger result than `27-stop-family.md` currently claims.

**Gap varies widely and tracks depth.** Copyability is a measurable property
distinct from performance. The screen is rebuilt on it and the eleven usable
candidates are re-ranked. This is the only branch in which the architecture
survives, and it survives as a *different* strategy: select on copyability
first, performance second.

**Gap varies with nothing observable.** Copyability is real but unpredictable
from what is in the corpus, which means it cannot be screened for in advance.
Report and stop.
