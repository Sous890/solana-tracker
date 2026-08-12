# Pre-registration — sweeping the exit rule on HSsJjkHr

Written before `scratch/exit-rules.ts` existed. No new RPC: the full post-entry
price path for every replayable trip is already in `cache/pools`.


> **AUDIT CORRECTION — see `27-audits.md`.** The "The question" table below
> quotes rungs at entry delay 0, which the audit found were priced at the
> wallet's own fill. "The entry delay costs 31.9pp of win rate" is mostly that
> artefact; the corrected entry cost from 0 s to 5 s is ~4.3pp of margin. The
> rules, the rule count, the deflation band and every prediction are unaffected —
> all of them enter at 5.479 s, past `signalTs`.

## The question

The mirror exit is one rule among many, and it is the one measured at −27.4pp.
Part A shows why that might be a rule problem rather than an edge problem:

| rung | win | g_trim | l_trim | margin |
| --- | ---: | ---: | ---: | ---: |
| replay basis, entry 0, exit 0 | 68.1% | 15.4% | 10.1% | +28.6pp |
| entry 5s, exit 0.364s | 36.2% | 15.3% | 8.3% | +0.9pp |

The entry delay costs **31.9pp of win rate** and leaves `g_trim` almost
untouched (15.4% → 15.3%). It is not shrinking the winners; it is **converting
winners into losers** — same exit price, higher entry. A rule that takes profit
while a trade is still up, instead of waiting for the wallet to sell, attacks
exactly that.

## Fixed before running

**Entry**: 5.479 s for every rule, `firstAtOrAfter(signalTs + 5479)`.
**Cost**: c ∈ {0, 1.11%}. **Stop**: −40%, `mirror.ts` STOP_LOSS_PCT.
**Estimators**: trimmed win/g/l, losses truncated at the stop, exactly as
`27-loss-side.md`. **Population**: the same replayable trips, reported with n.

**Horizon** for the mirror-independent rules: **3416 s**, the p90 observed hold
over 1,353 closed round trips. Time exits at **130 s / 470 s / 1355 s** — the
observed p25 / p50 / p75. Chosen from the distribution, not picked.

### The rules, enumerated now so the count cannot grow

Reference, not searched: **mirror + 0.364 s exit delay**.

Searched, **R = 13**:

| # | rule |
| --- | --- |
| 1–4 | TP/stop, horizon p90, TP at +25% / +50% / +100% / +150% |
| 5–7 | trailing stop, horizon p90, at 15% / 25% / 40% |
| 8–10 | time exit at 130 s / 470 s / 1355 s |
| 11–13 | mirror OR TP, whichever first, TP at +25% / +50% / +100% |

Rules 1–10 never consult the wallet's exit, so they are genuinely independent of
the mirror. Rules 11–13 do.

## The multiple-comparisons problem

Testing thirteen rules on ~47 trips and reporting the best is the same order
statistic the model already deflates for wallet selection. Reporting the winner
without penalising the search is precisely the failure this phase has refused
four times, and it does not get an exception for being my own search.

`selectionZ(M) = Φ⁻¹(1 − 1/(M+1))` is applied with an **effective M**:

| assumption | M_eff | z |
| --- | ---: | ---: |
| rules perfectly correlated — the search adds nothing | 43 | 2.000 |
| rules independent — full penalty | 43 × 13 = **559** | ~2.92 |

The truth is in between: all thirteen are evaluated on the same trips and the
same price paths, so they are strongly correlated and 559 over-penalises. Both
ends are reported for every rule, and **a verdict that flips inside the band is
refused**, exactly as the M band and half-life band are treated.

There is no separate "rule-count deflation constant" invented for this. The
existing machinery is reused because the problem is the same problem.

## Predictions

**P1 — the best rule is `mirror OR TP`, most likely at +25% or +50%.** Reason
above: the damage is winner-to-loser conversion, and this is the only family
that exits a winner early while keeping the mirror for everything else. Fixed
TP/stop without the mirror should do worse because it holds losers to the stop
or the horizon instead of following the wallet out.

**P2 — the best rule lands between −5pp and +5pp at M=43, c=1.11%.** A recovery
of 13–23pp against the mirror's −17.9pp, which would be a large effect and I
expect it to fall short of clearing.

**P3 — nothing clears at M_eff = 559.** The rule-count penalty costs roughly
5–7pp of deflated win rate at n≈47, and I do not expect any rule to have that
much room.

**P4 — trailing stops do worst.** These are memecoin paths; a 15% trailing stop
on a path that routinely moves 15% in a slot exits almost immediately, at the
cost, on nearly every trip.

## What would retire mirror-copying on this evidence

**If no rule clears at M=43 with c=1.11% — the most favourable deflation, giving
the search a free pass entirely — then no rule clears.** The finding is then
that this wallet's returns live in windows we cannot enter and exit inside, and
mirror-copying is retired as an architecture on this evidence. That is a
stronger phase result than "one wallet failed" and it should be reported as one.

## What a pass would mean, stated now

A rule clearing at M_eff = 559, c = 1.11%, on n≈47 is a **CANDIDATE, not a green
light.** Before it could become anything else it needs, all three:

1. the same rule tested on the other eleven wallets, pre-registered;
2. `c` measured against real fills, which has never happened;
3. the coverage gap closed — 36% of mints reconstruct, and the bias check bounds
   the damage at ~3pp of margin using the wallet's own outcomes, not ours.

This paragraph exists so it cannot be written more generously after seeing a
number.

## Standing

Nothing is sized. `src/core/sizing.ts` stays unwired and `tests/sizing.test.ts`
keeps asserting it. Every quantity remains an estimate for one wallet on a
replay basis that Part A shows is already ~9.8pp optimistic against that
wallet's own realised outcomes.

---

# AMENDMENT — written before any Part B RPC call

Three changes, all made before spending anything and none after seeing a rule
result.

## A1. The "no new RPC" premise was wrong

Only `signatures.json` is cached. The *set* of pool swaps in a window is known
offline; every **price** needs a `getTransaction`. Costed from the cached pages,
for the 67 replayable trips:

| scope | calls | ~time |
| --- | ---: | ---: |
| mirror window `[entry, walletExit+0.364s]` — rules 11–13 | 17,998 | ~73 min |
| + p25 horizon 130 s | 35,928 | ~2.4 h |
| + p50 470 s | 73,677 | ~5 h |
| + p75 1355 s | 109,185 | ~7.4 h |
| + p90 3416 s — the full sweep as written | 137,562 | ~9.3 h |

Rules 1–10 need prices **past the wallet's sell**, which was never fetched.

## A2. Sequential testing does not get to relabel itself

Running rules 11–13 first means R = 3 **only if 3 is where the search stops.**

**If rules 11–13 fail and any of rules 1–10 are then run, R for the entire
search is 13, and every result — including the first three — is re-scored at
R = 13 and M_eff = 559.** A twelve-rule search reported as a three-rule search
is the same order-statistic failure this phase has refused five times, and
staging it does not launder it.

The deflation band therefore stands as written: M_eff from 43 (rules perfectly
correlated) to 43 × R (independent), with R the number of rules **actually
evaluated across the whole phase**, not the number in the current batch. A
verdict that flips inside the band is refused.

## A3. The free bound was taken first, and it passed

Prices for a true path maximum are not free either — the same 18k calls. But the
delays CSVs already carry prices at `signalTs + {0,1,2,5,15,30,60,120}s` plus
the exit price: a 9-point sample of each path. Perfect foresight over **those
points**, entry at the 5 s bucket, n=67:

| | raw win | g_trim | l_trim | M=43, c=1.11% | M=559, c=1.11% |
| --- | ---: | ---: | ---: | ---: | ---: |
| mirror + 0.364 s | 40.3% | 11.1% | 11.4% | −27.4pp | −32.8pp |
| perfect foresight, sampled | 59.7% | 10.9% | 6.0% | **+5.6pp** | **+0.1pp** |

**Asymmetry, stated before the result was used**: the true path maximum is ≥ the
sampled maximum, so this is *not* a strict upper bound on the family. A pass is
informative; a failure would not have been conclusive.

It passes at M=43 with cost, so the headroom is real and the 18k calls are
warranted. Two things it changes:

1. **The gain is loss-avoidance, not winner-capture.** `g_trim` is flat
   (11.1% → 10.9%) while `l_trim` nearly halves (11.4% → 6.0%) and the win rate
   rises 19pp. That is a stop/trailing signature, not a take-profit one, and it
   cuts against **P1**. P1 stands as written and will be scored as written.
2. **The family's ceiling is ~breakeven at full search deflation.** +0.1pp at
   M_eff = 559. Every real rule lies below perfect foresight, so if R is near
   13-independent, nothing in the searched family clears. This is recorded now
   so that a rule coming in at, say, +3pp at M=43 cannot later be read as a
   result rather than as noise beneath a ceiling that was already known.

## A4. Population correction, carried into Part B

The Part A ladder ran on the 47-mint three-run intersection, which excludes the
20 mints run 1 lost to a **cold cache**. Those mints have larger losses
(`l_trim` 8.9% in the intersection against 12.1% in the full 67), so the
intersection is selected, not neutral, and its absolute margins are ~9pp
optimistic.

The ladder's **deltas** stand — the intersection existed to keep cache luck out
of them. Its **levels** do not. Part B reports on all 67, where zero entry delay
is **−3.8pp at c=0 and −7.9pp at c=1.11%**, not the +0.8pp the intersection
showed.
