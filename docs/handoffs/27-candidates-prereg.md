# Pre-registration — screening the thirty parked candidates

Written before any history export. Under the amended template, which now
requires a recorded direction of prior miss and an explicit shading statement.

## What this is and is not

Realised outcomes only — the same zero-latency upper bound step 0 used. **No
replay.** Replay is ~62k calls per wallet and this step exists to rank, not to
decide.

## First, a finding that had to be resolved to start

**The thirty did not exist as a list anywhere in the project.** Checked:
`config.json`, `config.example.json`, the SQLite database, all of `docs/`, the
Claude-project bundle, `exports/`, `scratch/`, and git history including deleted
files. Exactly **13** wallet addresses were recorded anywhere. The thirty
appeared in three handoffs as a *count* and never as addresses.

`M = 43` — the deflation parameter behind every verdict in phase 6 — was
therefore 13 recorded plus 30 that existed only as a number in prose. The
operator supplied the list on request; all 30 are valid base58, unique, and
**none overlaps the 13**, so `M_recorded` is now exactly 43 and the figure used
all phase is retroactively correct.

It would not have mattered either way. No phase-6 verdict depends on it:

| | M=13 | M=43 | M=516 |
| --- | ---: | ---: | ---: |
| HSsJjkHr replay, entry 5 s, c=1.11% | −24.2pp | −27.4pp | −32.7pp |
| best Part B rule | −20.6pp | −23.8pp | −29.2pp |
| best stop-family rule, out-of-sample | −12.1pp | −16.7pp | −24.4pp |

**From this campaign on, M is a count in a committed file rather than an argument
in a handoff.** That is the durable output here and it outlasts any wallet's
score.

## Cost, priced from a probe rather than extrapolated

One `getSignaturesForAddress` page per wallet — **30 calls** — gives signature
density at the tip.

The naive projection (30 × HSsJjkHr = 108,690 calls / 3.1 h) is wrong in both
directions. **22 of 30 wallets project under 1,000 signatures in ten days**, far
quieter than HSsJjkHr's 2,174. Three are far busier: `VJSDW6S7`, `Hw5UKBU5` and
`8MaVa9kd` each returned a full 1,000-signature page spanning **under 0.01
days** — roughly a thousand transactions per quarter-hour, which is not a
discretionary trader's cadence and may not be a trading wallet at all.

Campaign design: **cap at 3,000 signatures per wallet.** Seven of thirty hit the
cap. The window then varies per wallet — a dense wallet gets its most recent
3,000 transactions rather than ten days — and **the achieved window is reported
with every wallet's row**, as required.

**ESTIMATE: 58,863 calls, 1.7 hours.** Derived at 1.667 calls/signature and
9.86 calls/s, both measured on HSsJjkHr's export.

On the 3.5× multiplier: it came from estimating a *replay* fetch by counting
cached signature pages, and it does not transfer here. This estimate is built
from a direct probe of the actual population against two measured constants, and
it is scored afterwards against the real number. The multiplier stands or falls
on its own next test, not on this one.

## The bar, and why clearing it means little

`HSsJjkHr` cleared own-outcome breakeven at every swept cost — margin **+19.5pp**
at c = 1.11% — and then failed the replay by **−27.4pp**. **The measured copy tax
on the one wallet where it has been measured is ~47pp.**

So a candidate needs an own-outcome margin **above ~47pp** to survive what
HSsJjkHr did not. No tracked wallet came close; the best was +19.5pp. **Clearing
own-outcome breakeven is the bar HSsJjkHr passed on its way to failing by 27
points**, and any wallet clearing it here is a candidate for a replay, not a
result.

## Predictions

**Direction of the last comparable miss: optimistic, four consecutive times.**
P2 (~8pp), P5 (sign of the effect), P6 (~14pp), P8 (~20pp) all missed
optimistically in phase 6, and P3 of the replay prereg missed by ~28pp.

**Shading, stated explicitly: yes, shaded down.** The tracked twelve clear at
33% (4/12) at c = 0 and 17% (2/12) at c = 1.11%. Unshaded that projects **10 and
5** of thirty. I am shading down by ~40%, for two reasons: the four consecutive
optimistic misses, and the structural point that the tracked twelve were
*selected into* tracking while these thirty were not, so the parked population
should be worse, not equal.

- **C1 — at c = 0, 4 to 8 of 30 clear own-outcome breakeven.** (Unshaded: 10.)
- **C2 — at c = 1.11%, 1 to 3 of 30 clear.** (Unshaded: 5.)
- **C3 — no candidate has an own-outcome margin above 47pp**, so none survives
  the measured copy tax.
- **C4 — the median candidate margin is negative**, between −5pp and −25pp at
  c = 1.11%.
- **C5 — at least 3 of 30 produce too few paired round trips to score at all**
  (fewer than 20), including at least one of the three ultra-dense wallets, whose
  transactions are unlikely to be discretionary swaps.

## What would say the population is exhausted

**If C3 holds — no candidate above ~47pp of own-outcome margin — then no wallet
in the recorded population of 43 survives the copy tax measured on HSsJjkHr.**
Combined with the phase-6 retirement that is a decisive result: copy-trading as a
genus fails on this evidence, not merely one wallet and not merely one exit rule.

The weaker but still meaningful version: if C1 and C2 land at or below their
shaded ranges, the parked thirty are no better than the tracked twelve, and the
retirement is correctly scoped to the genus rather than to `HSsJjkHr`.

## What would NOT say that

Any candidate above 47pp. That would mean the retirement is correctly scoped to
one wallet, the thirty were not screened on the dimension that matters, and a
replay is warranted — at ~62k calls, priced and pre-registered separately.

## On picking a winner

**The temptation at the end of this is to pick the best and replay it.** That is
the selection that cost −14.0pp on HSsJjkHr at M = 43, and it would now be made
at **M = 43 with a 30-wallet search on top**, so the honest deflation is the same
band discipline as everywhere else: 43 to 43 × 30 = 1,290.

**If a pick is made, the M it was made at is stated and the deflation applied
BEFORE deciding whether it is worth 62k calls** — not after the replay comes
back. Written here so it cannot be skipped there.

## Standing

Nothing is sized. `src/core/sizing.ts` stays unwired and `tests/sizing.test.ts`
still asserts it. Estimators are exactly those fixed by `27-loss-side.md`:
token-quantity-matched FIFO, per entry decision, trimmed win/g/l, losses
truncated at the 40% stop, matched estimators only — never a measured `g`
against a configured `l`.
