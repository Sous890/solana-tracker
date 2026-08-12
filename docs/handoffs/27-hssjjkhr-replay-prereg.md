# Pre-registration — the HSsJjkHr one-wallet delay replay

Written **before** any RPC call. Head `4c473c1` plus uncommitted session-27 work.

Target: convert `HSsJjkHr`'s 53.0% *own* realised win rate into **our**
latency-adjusted rate at 5.479 s and 15.0 s, and decide whether it still clears
breakeven after selection deflation.

---

## Two corrections to the framing, before predicting anything

### 1. The corrected-corpus exclusion does not apply to this export

The existing `exports/HSsJjkHr….delays.csv` must indeed be regenerated, but not
for the stated reason. The routing bug (`fae02b9`) was in **our subscription
fan-out**: one socket notification was delivered to every tracked wallet, so
*session* records carry wrong per-wallet attribution. `export-wallet-history.ts`
does not read sessions. It pages `getSignaturesForAddress` **for the wallet's own
address** and parses each transaction. There is no attribution step, so there is
no attribution bug to exclude.

The real reasons it cannot be reused are worse, and all three are visible in the
file:

| | |
| --- | --- |
| It predates the `NO_DATA` status | Only `FILLED`/`NO_FILL` appear; the enum has four values |
| It was not deduplicated per mint | 120 round trips collapse onto **14 distinct mints** |
| It sampled evenly across ~20 days | Out of `getSignaturesForAddress` reach |

### 2. `NO_FILL` is already split in the code, and the existing export fails it

The question is answered at `src/calibration/replayDelays.ts:47-58`, which draws
exactly the distinction asked for:

- **`NO_DATA`** — no swaps in the window at all. *"A statement about our fetching,
  not about the market."* Must not be scored.
- **`NO_FILL`** — the path **had** swaps and none landed at or after the delayed
  target. *"A real market fact: a copier arriving that late had nothing to buy."*
  Belongs in the win rate.

Audited against the existing export:

| status | `n_pool_swaps_in_window` | rows |
| --- | --- | ---: |
| FILLED | > 0 | 104 |
| NO_FILL | **= 0** | **840** |
| NO_FILL | > 0 | 16 |

**840 of 856 `NO_FILL` rows — 98.1% — have zero swaps in the window** and would
be `NO_DATA` under the current code. The 87.5% `NO_FILL` rate is not a market
fact; it is a coverage gap. The code says so in its own words at
`calibrate-delays.ts:160`: *"82 of 119 round trips as NO_FILL at delay 0, every
one of them an empty window, which reads as 'the token stopped trading' and
actually means 'we never fetched that far back'."*

Excluding zero-swap rows, the honest fill rate in that export is:

| delay | 0 s | 1 s | 2 s | 5 s | 15 s | 30 s | 60 s | 120 s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| FILLED / (FILLED + NO_FILL) | 100% | 100% | 100% | 100% | 93.3% | 86.7% | 73.3% | 40.0% |

So the premise that "the existing export ran 87.5% `NO_FILL`, so the sample will
be small" is **inverted**: fill rate is not the binding constraint at the delays
in question. **Pool coverage is.**

## What actually bounds n

`oneTripPerMint` keeps one round trip per mint. `HSsJjkHr` traded **54 distinct
mints** in the corrected corpus (83 entry decisions, 255 tranches). So:

**FILLED n ≤ 54, before any coverage loss.** 8 of those 54 mints are already in
`cache/pools`. This is the number that decides the run, and it is small.

## Predictions

### P1 — FILLED n

**Predict 25–45 FILLED at 5.479 s, from a 54-mint ceiling.**

Basis: the honest fill rate is 93–100% between 5 s and 15 s, so almost every mint
with a reconstructable path fills. The loss is coverage, not fills. With
`--recent` keeping windows inside signature reach, I expect 50–85% of the 54
mints to reconstruct.

**Falsified below 15.** That would mean coverage, not fill rate, is still the
dominant failure after `--recent`, and the answer is *"still undecidable, and
here is why"* — reported as such, not papered over.

### P2 — how `NO_FILL` resolves

**Predict `NO_DATA` dominates at 5.479 s and true `NO_FILL` is under 10%.**

Evidence that would show **artefact**: rows with `fill_status = NO_DATA`, i.e.
`n_pool_swaps_in_window = 0`. Evidence that would show **strategy**: rows with
`NO_FILL` and `n_pool_swaps_in_window > 0` — the pool was alive and a late
arriver still could not buy. Only the second is scored, and it is scored as the
worst outcome rather than dropped, per the module header.

At 120 s I expect genuine `NO_FILL` to be material (the existing export already
shows 9 of 15 at that delay), which is the decay the harness exists to measure.

### P3 — deflated margin at M=12

`selectionZ` by M, from the ported implementation: M=12 → **1.4261**, M=43 →
2.0004, M=200 → 2.5776.

At a raw 53.0% and the realised-corpus breakeven of 30.5%:

| n | deflated, M=12 | margin | deflated, M=43 | margin |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 27.5% | −3.0 | 18.4% | −12.1 |
| 15 | 35.0% | +4.5 | 27.6% | −2.9 |
| 20 | 39.1% | +8.6 | 32.7% | +2.2 |
| 30 | 40.3% | +9.8 | 35.1% | +4.6 |
| 40 | 41.2% | +10.7 | 36.7% | +6.2 |
| 54 | 44.0% | +13.5 | 40.1% | +9.6 |

**Predict a deflated rate of 39–42% at M=12 and n in the predicted 25–45 range,
for a margin of +8 to +11pp.**

Threshold, computed not guessed: the deflated rate exceeds 30.5% from
**n ≥ 9 at M=12**, **n ≥ 18 at M=43**, **n ≥ 34 at M=200**.

**M=12 is a floor and I do not believe it.** Thirty candidate wallets are parked,
which puts the honest M at ≥ 42 and the threshold at n ≥ 18. The 19.5pp margin
survives M=43 only if n ≥ 18.

### P4 — the breakeven must be recomputed, not reused

The 30.5% above comes from the **realised** corpus. Pairing it against a **replay**
win rate would be a measured `p` against a breakeven built from different data —
the same mismatched pairing as the take-profit leak and the configured-stop leak,
for a third time.

So: breakeven is recomputed from the replay's **own** `forward_return`
distribution at the same delay, matched estimators, `g_trim` against `l_trim`.
The 30.5% is carried only as the prior these predictions were written against.

**Predict the replay's breakeven at 5.479 s comes out ABOVE 30.5%**, because
forward returns at delay are worse than the wallet's own realised returns on both
sides and the loss side has no stop truncation in the replay.

## What would make me say HSsJjkHr does not clear

Any one of these, and the wallet does not clear:

1. **Deflated rate ≤ replay breakeven at M=43.** M=12 is a floor, not the answer.
2. **FILLED n < 18**, which puts it under the M=43 threshold regardless of the
   point estimate.
3. **Genuine `NO_FILL` (swaps > 0) above ~25% at 5.479 s.** Those are real
   worst-case outcomes; a fifth of entries unable to buy is not a strategy that
   clears anything.
4. **The delay-0 bucket failing `checkDelayZeroMatchesRealised`.** If the replay's
   own zero-delay rate does not reconcile with the 53.0% realised rate, the
   replay is not measuring this wallet and no number from it counts.
5. **A `g_trim` at delay carried by one trade**, as `CT9dekyf`'s was. Checked
   against `g_median` before anything is reported.

"But the raw number cleared" is not on this list and will not be used.

## Constraints

- Nothing is sized. `src/core/sizing.ts` stays unwired; `tests/sizing.test.ts`
  keeps asserting it.
- Both delays reported. 5.479 s is **n=1** — `scratch/measure-holdtime.ts:11`
  says so — and is treated as one point in a range, never as a measurement. The
  replay grid is `{0,1,2,5,15,30,60,120}`, so 5.479 s is read from the 5 s bucket
  and bracketed by 15 s rather than interpolated.
- Raw and deflated rates reported together, always, with n and M.
- The result stays an estimate of **our** rate for **one** wallet. It says nothing
  about the other eleven.
