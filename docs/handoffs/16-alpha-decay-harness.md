# Handoff 16 — alpha-decay replay harness

**Status: built, tested, and run end to end against real pools. 835 tests
(834 passing + the known crash-drill flake). Typecheck and build clean.**

The harness works. The first full run produced a **contaminated NO_FILL rate**,
diagnosed below, with the fix implemented but not yet re-run to completion.

---

## Stop here first

1. **`tests/soak.test.ts > crash drill > survives a real SIGKILL` flakes at
   ~25%.** Pre-existing, measured across handoffs 14-16. Not yours. Leave it.

2. **`calibrate.py` is still not readable.** `~/Downloads` is TCC-protected
   against this process — `ls` works, `cat` returns `Operation not permitted`,
   and neither a sandbox override nor a granted directory lifts it. **Every
   column name in `{wallet}.delays.csv` came from the prompt's spec, not from
   reading `fit_alpha_half_life`.** Verify the schema against the real function
   before trusting a fit. Copy it onto the LaCie drive to unblock:
   ```
   mkdir -p "/Volumes/LaCie/Operation grootenstine /solana-tracker/analysis" && cp "/Users/turnerschnee/Downloads/calibrate (1).py" "/Volumes/LaCie/Operation grootenstine /solana-tracker/analysis/calibrate.py"
   ```

3. **Do not run two RPC-heavy scripts at once.** Helius rate-limits at ~10 rps
   and a second job makes the first die. One export or one calibration at a time.

---

## What was built

| File | |
| --- | --- |
| `src/calibration/poolHistory.ts` | pool resolution, price-path reconstruction, disk cache |
| `src/calibration/replayDelays.ts` | delayed-entry replay, diagnostics, sanity checks, Part 4 |
| `scripts/calibrate-delays.ts` | CLI runner, writes `exports/{wallet}.delays.csv` |
| `tests/calibration.test.ts` | 29 tests |

`scripts/export-wallet-history.ts` gained `entry_signature` and
`exit_signature` as the **last two columns** — the six `calibrate.py` asks for
keep their indices. This was forced: pool resolution needs one real swap per
mint to inspect, and the original export carried no signature at all.

`cache/` and `exports/` are gitignored.

---

## Results — wallet HSsJjkHr…, 120 round trips sampled across 20 days

```
delay_s        n   filled     median       mean   win_rate   no_fill
      0      119       37      8.78%     16.24%     62.16%     68.91%
      1      119       36      7.91%     12.70%     61.11%     69.75%
      2      119       36      7.91%     12.31%     61.11%     69.75%
      5      119       36      7.91%     11.76%     58.33%     69.75%
     15      119       36      5.11%     10.70%     55.56%     69.75%
     30      119       33      5.88%      9.08%     60.61%     72.27%
     60      119       32      3.25%      6.45%     53.13%     73.11%
    120      119       24      4.88%      5.82%     54.17%     79.83%

PASS  delay-0 median ≈ wallet realised median
      replay 8.78% vs wallet 7.24% (gap 1.55pp, tolerance 5pp)
PASS  every FILLED row has n_pool_swaps_in_window > 0
      270 filled rows, all with swaps

pool resolution: 86/86 resolved, 0 ambiguous, 0 unresolved
952 rows, 12,651 RPC calls, ~27 minutes
```

**Decay is visible.** Median 8.78% → 3.25% by 60s; mean falls monotonically
16.24% → 5.82%. The delay-0 check passing at 1.55pp is the strong result: it
says the pool reconstruction genuinely reproduces what the wallet got.

### But the NO_FILL rate is an artifact, not a market fact

Of 82 NO_FILLs at delay 0, **all 82 had `n_pool_swaps_in_window = 0`** — an
empty window, not a window where the token had stopped trading. Cause: pools
cached at exactly 20,000 signatures, the `maxSignatures` cap.
`getSignaturesForAddress` only pages backwards from the tip, so reaching a
window three weeks old on a hot pool costs more signatures than the cap allows.
The walk stops short and every old window comes back empty.

So the ~70% NO_FILL rate says *"we did not fetch that far back"*, not *"a copier
could not have filled"*. **Do not report it as a liquidity result.** The 24-37
rows that did fill are the recent trips, inside signature reach.

Consequences: `n_filled` of 24-37 is at or below the ~30 threshold where these
numbers stop being noise, and the surviving sample is biased toward recent
trades.

### CORRECTION — run 2's "FAIL" was a bug in the check, not the price path

The delay-0 check compared the replay's **filled subset** against the wallet's
median over **everything sampled**. Two different populations, and NO_FILL is
not random — it selects for illiquid windows, which are the losing trades, so
the unfilled remainder is systematically better. That manufactured an 18.48pp
gap out of nothing.

Recomputed like-for-like on the identical data:

```
replay -2.03%  vs  wallet -3.75%   over the SAME 15 filled trips
gap 1.72pp, tolerance 5pp  ->  PASS
```

Per-trip the replay tracks the wallet closely: −19.4 vs −22.7, +8.1 vs +6.3,
−39.1 vs −44.9, −42.8 vs −40.8. **The pool reconstruction was correct in both
runs.** `checkDelayZeroMatchesRealised` now takes the rows and a per-trip
wallet-return lookup and restricts to filled trips itself; a regression test
pins it.

Second defect found while checking: **`signature` alone does not identify a
round trip.** A FIFO scale-out produces several round trips from one entry, so
one entry signature appears many times at the same delay — `E14Zh2nA8G…`
appeared 5 times at delay 0. The tuple `(signature, exit_ts, delay_s)` is
unique; the schema was left as specified, but anything grouping the delays CSV
by `signature` will silently merge distinct trips.

### Run 2 — `--recent`, and what it actually shows

`--recent` samples the most recent N round trips instead of spreading evenly,
keeping windows inside signature reach. It was run. It is **worse**, and the
sanity check caught it:

```
delay_s        n   filled     median       mean   win_rate   no_fill
      0      120       15     -2.03%     -6.25%     46.67%     87.50%
      1      120       15     -1.73%     -7.80%     40.00%     87.50%
      5      120       15     -2.20%     -8.70%     40.00%     87.50%
     30      120       13     -3.63%     -5.54%     30.77%     89.17%
    120      120        6     -1.04%      0.47%     16.67%     95.00%

FAIL  delay-0 median ≈ wallet realised median
      replay -2.03% vs wallet 16.46% (gap 18.48pp, tolerance 5pp)
PASS  every FILLED row has n_pool_swaps_in_window > 0

pools truncated 2, fetch-capped 3, failed 0. 960 rows, 3,360 RPC calls.
```

**Still do not use these numbers, but for a different reason.** The
reconstruction is sound (see the correction above). The problem is **n**: 15
filled at delay 0, falling to 6 at 120s, across only 14 distinct mints. At that
sample size the medians are noise, and the apparent flatness is not evidence of
anything. NO_FILL at 87.5% is still driven by fetch-capped pools, not by
illiquidity.

**Net: neither run is yet a trustworthy decay measurement, and neither is
broken.** Run 1 (even sample) passed the check and showed clean monotonic decay
on n=24-37, but its NO_FILL rate was contaminated by signature truncation. Run 2
(recent sample) is also correct but has n=6-15, too few to read.

What a third run needs: **one round trip per mint** (dedupe, so scale-outs stop
consuming the sample), a raised `maxFetches` so no path is clipped, and a
sample spread across mints rather than across time. That should land n in the
low hundreds with complete paths.

**`exports/{wallet}.delays.csv` currently holds RUN 2**, the failing one. Run 1
was overwritten. Re-run without `--recent` to reproduce the passing table above.

---

## Run 3 — deduped, and the answer is DO NOT FIT

70 mints, one round trip each (earliest entry), `--recent`, `maxFetches` 400.
70/70 pools resolved. 560 rows, ~12,000 RPC calls, 26 minutes.

```
delay_s        n   filled      pos     median       mean   win_rate  fill_rate   no_fill   no_data
      0       70       32       19      0.40%     14.23%     59.38%    100.00%     0.00%    54.29%
      1       70       32       13     -0.92%     -4.88%     40.63%    100.00%     0.00%    54.29%
      2       70       32       11     -1.10%     -5.64%     34.38%    100.00%     0.00%    54.29%
      5       70       32       11     -0.80%     -4.03%     34.38%    100.00%     0.00%    54.29%
     15       70       29       13     -0.47%     -1.67%     44.83%     90.63%     4.29%    54.29%
     30       70       22        6     -1.44%     -5.05%     27.27%     68.75%    14.29%    54.29%
     60       70       17        5     -1.21%     -4.53%     29.41%     53.13%    21.43%    54.29%
    120       70       12        4     -1.24%     -6.23%     33.33%     37.50%    28.57%    54.29%

PASS  delay-0 median ≈ wallet realised median (same population)
      replay 0.40% vs wallet -3.59% over the SAME 32 filled trips (gap 3.99pp)
PASS  every FILLED row has n_pool_swaps_in_window > 0

WARN  fill rate 100.0% at 0s -> 37.5% at 120s (drop 62.5pp)

PASS  >= 20 positive-return points survive the log mask   (82 of 208 filled)
PASS  positive points across the range                    (15 at >=30s; 8/8 buckets >=3)
FAIL  median is monotone-ish                              (3 inversions across 8 buckets)
```

**`fit_alpha_half_life` must not be run on this.** The median collapses from
+0.40% at delay 0 to about −1% and then stays flat — no decay, and three
inversions. A log-linear fit through that has a non-negative slope and returns
`inf`, which reads as "alpha never decays" and is actually "there is no
measurable curve here". That is precisely the failure mode the acceptance
criteria were written to catch before anyone saw a number.

**The survivorship warning fired, hard.** Fill rate falls 100% → 37.5% across
the delay range, a 62.5pp drop, while NO_DATA stays flat at 54.29% (so the drop
is genuine illiquidity, not coverage). Long-delay buckets are shedding their
least liquid — i.e. worst — trades, so whatever curve exists is measured
increasingly cleanly as delay grows: the true decay is **steeper** than the
table shows and any fitted half-life would be **too long**. Compounding with
`fit_alpha_half_life`'s positive-returns-only log mask, two optimistic biases
land in the same parameter.

Substantively: at delay 0 the copier is the wallet and wins 59% of the time; by
1 second the win rate is 40.6% and the median is negative, and it never
recovers. If that survives a larger sample, the edge does not have a half-life
so much as a cliff inside the first second — which is not a latency budget any
copier can meet.

## Part 4 — failure-rate cost adjustment

```
HSsJjkHr…   failed 83     successes 3297   rate  2.46%   multiplier 1.0252
popo3Rj6…   failed 2296   successes 1860   rate 55.24%   multiplier 2.2344
```

`popo3Rj6` costs **2.23× the priority fee per successful entry**. Derived and
printed, never hardcoded — `failureAdjustment()` returns it and the CLI prints
it. `Infinity` when nothing succeeded, deliberately, so the sizing layer sees
"no measurable cost basis" rather than a plausible 1.0.

---

## Decisions a fresh session should not silently reverse

**Pool resolution reads balance ownership, not instruction data.** In a swap the
taker's mint balance moves one way and the pool vault the other; the opposite-
signed `owner` is the pool. This resolved 86/86 real pools with zero ambiguity
and works identically for Raydium, Whirlpool and pump.fun bonding curves, none
of whose instruction layouts are stable.

**`PoolWindow.intervals` is a union of narrow windows, never `min..max`.** A
mint traded Monday and Friday expressed as one span pulls the whole gap.
Measured: that stalled a 150-trip run for nine minutes before it was killed. A
test pins it (`interval union > fetches only inside the intervals`).

**`orderPoolSwaps` tie-breaks on signature.** Every transaction in a block
shares one `blockTime`, so without a stable final tie-break "the first swap at
or after target_ts" would depend on RPC page order and entry prices would drift
between runs.

**The half-life solve lives in the test file only.** `src/calibration/` fits
nothing — the two-point log solve in `tests/calibration.test.ts` is an assertion
that the emitted curve has the shape it claims. **It must not migrate into
`src/`.** Fitting stays in Python.

**NO_FILL rows are emitted, never dropped.** At long delays that is where the
worst outcomes live; deleting them would flatten the very curve being measured.

**`signal_ts == entry_ts` in the wallet export.** There is no bot in that
history, so the signal is the entry. Every statistic from it is a zero-latency
upper bound — a real copier is strictly worse.

---

## The FIFO row-weighting bias in `realised_stats` — confirmed, and material

`export-wallet-history.ts` emits one row per FIFO round trip, so a mint the
wallet scaled out of in five tranches contributes five observations. Measured
on HSsJjkHr…'s 3,297 rows:

```
                    n      win_rate    mean_ret   median_ret
per FIFO row     3297        55.11%      23.42%       2.89%   <- what realised_stats sees
per DECISION     1433        48.78%      34.36%      -0.39%   <- SOL-aggregated per entry
per MINT          305        50.49%       2.73%       0.25%   <- SOL-aggregated per mint
```

Rows per mint: max 231, p90 28, median 4. Rows per entry decision: max 11,
median 2.

**The win rate crosses 50% depending only on how you count**: 55.11% per exit
versus 48.78% per decision. Median return flips sign, +2.89% → −0.39%. So
`EdgeParams(wins, trades)` fed from the raw export is measuring exits, not
decisions, and `p̃` is biased upward by roughly 6pp — before anything multiplies
against it.

The fix belongs on the consumer side, not in the exporter: the per-tranche rows
are the truth about what happened and should stay. Aggregate by
`entry_signature` (summing `sol_in` and `sol_out`) before computing win rate or
`EdgeParams`. `scripts/calibrate-delays.ts` already does the equivalent via
`oneTripPerMint`.

## Still blocked

- **`insider_share`** — needs `launch_ts`. No local source. Do not substitute
  first-seen-in-session.
- **`latency_adjusted_outcomes`** — needs `half_life_s` from
  `fit_alpha_half_life`. The dataset for that now exists; run the Python once
  `calibrate.py` is readable. Carry its docstring's caveat: it fits on positive
  returns only because of the log transform, which biases the half-life
  **upward** — treat any number as an optimistic bound.
- **Failure clustering by mint** — `{wallet}.failures.csv` now records
  `intended_mint` (read from `preTokenBalances`, not decoded). It exists for
  HSsJjkHr… only; popo3Rj6…'s was written by the run before that column landed.

## Verify

```bash
cd "/Volumes/LaCie/Operation grootenstine /solana-tracker" && npm run typecheck && npm test && npm run build
```

835 tests. A lone crash-drill failure is the known flake.
