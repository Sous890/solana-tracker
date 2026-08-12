# 27 — HSsJjkHr latency replay: does not clear

> **AUDIT CORRECTION — see `27-audits.md`.**
>
> The entry selector did not exclude the tracked wallet's own swap, and its
> entry signature was in the pool path for 64 of 67 trips, all at exactly
> `signalTs`. The **delay-0 rung is therefore priced at their fill or at a print
> ahead of it** and is not achievable.
>
> §3's "even at entry delay 0 the margin is −3.8pp at M=43" understates it.
> Corrected, entry delay 0 is **≈ −23.0pp at c=1.11%** — the same as delay 1 s,
> as it must be at second resolution. The conclusion strengthens.
>
> Every figure at entry delay 5 s and 15 s is **unaffected**: those targets are
> past `signalTs`, so the wallet's own print was never a candidate. The verdict,
> the −27.4pp margin and all five scored conditions stand.

Scored against `27-hssjjkhr-replay-prereg.md`, written before any RPC call.

**Verdict: DOES NOT CLEAR.** Pre-registered non-clearing condition 1 fires by
−22.4pp at M=43 and c=0, widening to −27.4pp at c=1.11%. Not the marginal
"undecided at this n" case: n=67 is ample and the margin is twenty-plus points.

Cost: 46,023 RPC calls (3,623 export + 42,400 replay), ~3 hours.

---

## 1. Check 1 — the exit was not delayed

`replayDelays.ts:95` computed `nearestTo(swaps, trip.exitTs)` **outside** the
`delays.map`, so it never varied with `delayS`. The entry was delayed at
`:116-117`; `:126` then divided the wallet's own exit price by our delayed entry
price. Their exit at our entry — the mismatched pairing for the fourth time.

A second defect in the same line: `nearestTo` minimises `|blockTime − exitTs|`
and resolves ties to the **earlier** swap, so it could price our exit at a spike
that occurred before the wallet sold. `firstAtOrAfter` fixes both.

`exitDelayS` is now REQUIRED, with no default: zero is never correct, and
mirroring `delayS` asserts a symmetry nothing has measured. Swept at 0 (the
artefact), 0.364 s (the detection leg alone, p99 of n=500 — the measured floor)
and 5.479 s (the entry delay, itself n=1 — the symmetric ceiling).

### How much of the edge was the artefact

At entry delay 5 s, on the same 56–67 reconstructed trips:

| exit delay | raw win | g_trim | l_trim | breakeven c=0 | deflated M=43 | margin c=1.11% |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **0 — artefact** | **48.2%** | 10.7% | **7.6%** | 41.7% | 34.9% | **−12.9pp** |
| 0.364 s — floor | 40.3% | 11.1% | 11.4% | 50.7% | 28.3% | −27.4pp |
| 5.479 s — ceiling | 36.4% | 12.6% | 11.9% | 48.6% | 24.5% | −28.6pp |

**The undelayed exit was worth 7.9pp of raw win rate at the floor and 11.8pp at
the ceiling.** At entry delay 0 it was worth ~16pp (69.6% against 53.7%).

It inflated **both** sides. Booking the wallet's own exit made losses look
smaller too — `l_trim` 7.6% against a true 11.4% — so the breakeven it produced
was 9pp too low as well. Total effect on the decision quantity: **14.5pp of
margin**.

### The artefact was also the sanity-check failure

| run | delay-0 reconciliation | verdict |
| --- | --- | --- |
| exit 0 | replay 3.27% vs wallet −2.20%, gap **5.47pp** | **FAIL** (5pp tolerance) |
| exit 0.364 s | replay 0.68% vs wallet −2.15%, gap 2.83pp | PASS |
| exit 5.479 s | replay 0.79% vs wallet −2.18%, gap 2.98pp | PASS |

`checkDelayZeroMatchesRealised` was detecting the bug. With the exit correctly
delayed the replay reconciles with the wallet's own realised median. Pre-registered
condition 4 therefore **does not fire** — the failure belonged to the artefact
run, which is discarded.

## 2. Check 2 — coverage bias, and it inverts the hypothesis

Coverage: **56 of 157 mints reconstructed (35.7%)** at exit 0, 67 at exit
0.364 s. The wallet's OWN realised outcomes, one trip per mint, same estimators
as `27-loss-side.md`:

| population | n | win | g_trim | l_trim | breakeven | margin |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| all mints | 157 | 48.4% | 18.8% | 10.7% | 36.4% | +12.0pp |
| **replayable** | 56 | **41.1%** | 22.3% | **7.8%** | **25.8%** | **+15.3pp** |
| not replayable | 101 | 52.5% | 17.3% | 13.5% | 43.9% | +8.6pp |

The predicted channel — *the replay measures the wallet's good mints* — is **not
supported**: the replayable subset's win rate is **7.3pp worse**, not better.

But it is not clean. The subset's losses are smaller and its wins larger, so its
breakeven is **10.5pp lower**, and on win-minus-breakeven the subset is **+3.3pp
better** than the whole. A mild upward bias arriving through the payoff ratio
rather than the win rate. Reporting only the win-rate gap would understate the
bias in the direction that decides the question.

**The replay is therefore biased UP by roughly 3pp of margin.** The verdict below
fails by 22–27pp, so the bias does not change it.

## 3. The result

Operative configuration: exit delay **0.364 s** (the measured floor — the most
favourable defensible choice), entry delay 5 s.

| | delay 0 s | **delay 5 s** | delay 15 s |
| --- | ---: | ---: | ---: |
| FILLED n | 67 | **67** | 58 |
| raw win rate | 53.7% | **40.3%** | 44.8% |
| g_trim | 14.6% | 11.1% | 11.1% |
| l_trim | 12.1% | 11.4% | 10.2% |
| breakeven, c=0 | 45.3% | **50.7%** | 48.0% |
| breakeven, c=1.11% | 49.5% | 55.7% | 53.2% |
| deflated M=12 | 45.0% | 31.8% | 35.5% |
| deflated M=43 | 41.5% | **28.3%** | 31.8% |
| deflated M=200 | 38.0% | 24.9% | 28.0% |
| **margin, M=43, c=1.11%** | **−7.9pp** | **−27.4pp** | **−21.4pp** |

At the symmetric-ceiling exit delay of 5.479 s it is worse still: 36.4% raw,
24.5% deflated at M=43, −28.6pp.

**Even at entry delay 0** — an infinitely fast copier, paying only the detection
leg on the exit — the margin at M=43 is **−3.8pp** at c=0 and −7.9pp at c=1.11%.
The wallet's edge does not survive our exit path at any entry latency.

## 4. Scoring the five conditions, as written

| # | condition | result |
| --- | --- | --- |
| 1 | deflated ≤ replay breakeven at M=43 | **FIRES.** 28.3% vs 50.7% at c=0 |
| 2 | FILLED n < 18 | does not fire — n=67 |
| 3 | genuine NO_FILL > 25% at 5.479 s | does not fire — **0 of 67** |
| 4 | delay-0 fails `checkDelayZeroMatchesRealised` | does not fire — passes at 2.83pp |
| 5 | `g_trim` carried by one trade | does not fire — `g_trim/g_med` = 1.59 |

One condition fires and it is the load-bearing one. **HSsJjkHr does not clear.**

## 5. Scoring the predictions

- **P1 — FILLED n of 25–45. MISS.** Actual 67. Already flagged before the run:
  the ceiling was 157 on-chain mints, not the 54 I took from the session corpus.
- **P2 — `NO_DATA` dominates, true `NO_FILL` under 10%. CONFIRMED**, decisively.
  At 5 s: 83 `NO_DATA`, **0** `NO_FILL`. Coverage, not illiquidity, is what
  bounds this replay — as the audit of the old export predicted.
- **P3 — deflated 39–42% at M=12, margin +8 to +11pp. FALSIFIED.** Actual
  deflated 31.8%, margin **−19.0pp**. Wrong by ~28pp of margin, in the direction
  of optimism, because the prediction was anchored on a 53.0% win rate that was
  itself produced by the undelayed exit.
- **P4 — replay breakeven above the realised 30.5%. CONFIRMED.** 50.7% at c=0.

## 6. What is not proved

- **Coverage is 36%.** 78 of 134 trips never reconstructed; 23 pools failed
  outright, 36 truncated at the signature cap, 5 clipped at the fetch cap. The
  bias check bounds the damage at ~3pp of margin, but it bounds it using the
  wallet's own outcomes, not ours.
- **Survivorship, flagged by the harness itself.** Fill rate falls 100% → 25% by
  120 s, so long delays drop their worst trades and any fitted half-life is too
  long. The 5 s and 15 s buckets used above are at 100% and 87% fill, so they are
  much less affected — but not unaffected.
- **`NO_EXIT_PRICE` is excluded, and that is optimistic.** 6–8 trips per run had
  no pool print at or after our delayed exit: positions we held and could not
  sell. They carry no return, so they are absent from the win rate rather than
  counted as the bad outcomes they are.
- **The monotonicity acceptance criterion failed** (3 inversions across 8
  buckets) in every run. No half-life is fitted here and none should be.
- **`c` still has never met a fill.** 1.111% remains the model's own arithmetic
  over `minLiquidityUsd`, an unmeasured `exit_depth_ratio` of 0.7, and a
  180 USD/SOL constant. It is not what decides this verdict — the margin is
  negative at c=0 — but it is still the number a positive result would rest on.

## 7. Defects found and fixed getting here

- **`export-wallet-history.ts` had no backoff for "Service overloaded".** Died at
  fetch 136 of 2,174. `calibrate-delays.ts` already handled it and its comment
  records the same error killing a 40-pool run — Helius returns transients as
  JSON-RPC errors with HTTP **200**, so the status check never sees them. Now
  shares the classification.
- **`scripts/` was in neither tsconfig's `include`.** Which is why changing
  `replayRoundTrip`'s signature silently broke `calibrate-delays.ts:322` with no
  error. Now typechecked. It cost one real fix: `measure-recorder.ts`'s
  `TrackedSwap` fixture was missing `source` and `observedAt`, so every
  recorder-throughput number it has produced was measured on a payload two
  fields short of the one actually written. Plus two pieces of dead code.

## 8. Where this leaves the phase

The one wallet where the answer was cheap has been answered, and the answer is
no. `HSsJjkHr` was chosen because it had the delays export, the best
copyability, the widest apparent margin and clearance at every swept cost — and
19.5pp of that margin was the wallet's own outcomes standing in for ours, plus
an undelayed exit worth another 8–12pp.

The remaining eleven were already refused on their own outcomes at zero cost.
Nothing here suggests re-examining them; the correction applied to this wallet
would apply to each of them in the same direction.

Nothing is sized. `src/core/sizing.ts` stays unwired and `tests/sizing.test.ts`
still asserts it.
