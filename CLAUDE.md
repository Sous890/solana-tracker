# solana-tracker — working notes for Claude

See `README.md` for architecture and `docs/handoffs/` for session history.
`docs/handoffs/18-flake-mechanisms.md` is the most recent.

## Known gaps

Every item here biases the same direction: **toward making a wallet look more
copyable than it is.** None is fixed.

### 1. `fit_alpha_half_life` is misspecified for these wallets, not under-fed

`surviving_alpha = 2**(-dt/T)` is strictly positive and monotone decreasing. The
measured forward return for `HSsJjkHr…` goes from +0.40% at delay 0 to **−0.92%
at delay 1s** and stays negative. No value of `T` represents a sign flip, so the
parametric decay cannot describe this wallet at any half-life.

Do not force a fit. Use `Latency(delay_s=0, half_life_s=<anything>)` and supply
`EdgeParams` / `TradeProfile` measured **at your actual delay**; the equation
does not need the parametric form if `p̃`, `g` and `l` already carry it. The
empirical table in handoff 16 is the calibration artifact.

### 2. Two optimistic biases land in the same parameter

- `fit_alpha_half_life` keeps only positive returns (the log requires it), which
  its own docstring says biases `T` **upward**.
- Fill rate falls 100% → 37.5% across the delay range (measured, 62.5pp drop,
  with NO_DATA flat at 54.29% so it is genuine illiquidity). Long-delay buckets
  shed their least liquid — worst — trades, so the measured curve is **too
  shallow** and any fitted `T` is **too long**.

Both point the same way. `T` is also the input `master_equation.py` warns you
least about guessing.

### 3. The raw export counts EXITS, not DECISIONS

`export-wallet-history.ts` emits one row per FIFO tranche, so a mint scaled out
of five times contributes five observations. Measured on `HSsJjkHr…`:

| | per tranche | per decision |
| --- | --- | --- |
| n | 3197 | 1429 |
| win rate | 55.0% | **48.7%** |
| payoff ratio | 1.68 | **1.20** |
| median return | +2.8% | **−0.4%** |

The 50% line falls between them. **Feed `{wallet}.decisions.csv` to
`realised_stats` and `EdgeParams`, never `{wallet}.csv`** — `trades` must mean
decisions. Generate it with `scripts/aggregate-decisions.ts`.

### 4. Timestamps are MILLIS in the export, SECONDS in `calibrate.py`

`calibrate.py`'s docstring specifies unix seconds. The exporter writes
milliseconds. `realised_stats` and `latency_adjusted_outcomes` never read a
timestamp so they are unaffected, but **`insider_share` would be wrong by 1000×**
and silently return 0.0. Convert before calling it.

### 5. `insider_share` has no `launch_ts` source

Nothing local supplies it. Do not substitute first-seen-in-session.

### 6. Our own delay is still unmeasured

`example.py` assumes 1.2s. The measured cliff for `HSsJjkHr…` sits between 0 and
1 second, so that assumption spans the entire decision. Partial measurement:
`getTransaction` round trip **p50 201ms** (n=20). The detection leg is NOT
measured — `getTransaction` returns null when called at the instant the
`logsSubscribe` notification arrives, so it needs a retry loop. That null is
itself a latency fact worth quantifying.

### 7. Pre-graduation pump.fun mints break `PoolState`

`PoolState` models a constant-product pool. A pre-graduation bonding curve is
not one, so `price_impact` and `exit_depth_ratio` do not describe its shape.
Many tracked mints end in `pump`. Unflagged in the current exports.
