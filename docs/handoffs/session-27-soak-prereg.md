# Session 27 soak — pre-registration

Written before the run. Commit `4cee1ed`. Target 2.2h under `caffeinate`.
**Same thirteen wallets.** The thirty candidates are held back deliberately:
session 26's standing prediction is that `ab23577` drops fetch load ~92.5%, and
removing BCagck would drop it ~92% by itself. Two explanations for one number is
no explanation. One variable.

## Predictions

### 1. Ingress fetch rate after the `err` filter

**Predict 3–6 fetches/sec sustained, from ~65/sec of arrivals.**

Basis: 92.5% of fetched transactions were TX_FAILED (5,931 of 6,409, session 26),
and the filter removes exactly those. Capacity is ~5/sec at the measured 194ms
serial fetch.

**Falsified if materially above ~8/sec.** That would mean the shed population was
less failure-heavy than the fetched one — the inference Part A flagged as an
inference, since `droppedSignatures` carries strings only and the `err` of shed
signatures is not knowable retroactively.

### 2. Queue depth p95 and residency p95

**Predict depth p95 ≤ 3, residency p95 < 600ms.**

Basis: ~92.5% of arrivals no longer take a slot. Residency is depth × ~194ms, so
depth 3 is ~580ms. Session 26 had no measurement at all — this is the first run
that can report it.

**Falsified if depth p95 is at or near 20.** That means the remaining 7.5% alone
saturates a 20-slot queue, and the arrival rate, not the failure share, is the
constraint.

### 3. Live-sourced STALE_SIGNAL

**Predict 0, as in session 26.**

Session 26's 137 STALE_SIGNALs had **minimum age 45.6s** — 3× the gate — with
p50 39.3 min and max 130 min. Zero fell in the 15–30s band where a queue-delayed
live swap would land. Every one was gap-fill by construction.

**This is the decisive test of where the delay lives.** If load falls 92.5% and
live staleness stays 0, the queue was never manufacturing staleness — it was
manufacturing *loss*, which is what the 0.17% shed-recovery rate already
suggests. If live-sourced STALE_SIGNALs appear now that fewer things are shed,
then the queue was converting arrivals into stale-but-fetched rather than
dropping them, and the serial drain is the constraint.

### 4. `peakDeferred`, re-derived

**Predict 20–120.**

The old prediction (<50, actual 474) was modelled on the 1.40 swaps/min figure
now withdrawn, so it is not carried forward. New basis: deferral happens when a
completion lands above an outstanding barrier slot during a fill. `ab23577`
changed the dynamics again — failures are reserved and removed as *classified*,
on a synchronous timeline rather than a 194ms fetch, so they clear the barrier
far faster than before and spend less time deferring anything behind them. Two
effects push opposite ways: ~92.5% fewer fetches means fewer live completions to
defer, but failures now clear in microseconds instead of blocking for 194ms.

Range is deliberately wide because both terms are newly changed. **Anything above
~500 means the model is still wrong** and I should stop predicting this number
until it is derived from a run rather than from reasoning.

### 5. Entry intents, fills, rejection mix

**Predict 150–350 entry intents, 1–6 fills.** First run with a prediction on the
trading path at all.

Expected mix, from session 26's 205:

| | s26 | predicted |
|---|---|---|
| `STALE_SIGNAL` | 137 (67%) | **30–80** — cursors are ~2h old, not 38h, so less stale backlog |
| `QuoteUnavailableError` (failed) | 49 (24%) | **20–60** — unchanged, Task 1 is not fixed |
| `CANNOT_SELL:*` | 15 (7%) | 10–30 |
| `MAX_POSITIONS_REACHED` | 2 | 0–10 |
| `PRICE_IMPACT_EXCEEDED` | 1 | 0–5 |

## What would make me conclude the gate is mis-set rather than the latency real

Decided now, before the number exists.

**The gate is mis-set only if live-sourced STALE_SIGNALs cluster just above 15s
while the delay budget shows the time was spent in legs that are not market
latency** — queue residency and fetch, not time-to-reach-us. Concretely: ≥20
live-sourced STALE_SIGNALs with ages in 15–25s, **and** `queuedMs` + `fetchMs`
accounting for more than half of each one's age.

That would mean the bot is refusing signals it made stale itself, and the fix is
the drain, not the gate.

**Everything else means the latency is real and the gate is right.** In
particular, live-sourced STALE_SIGNALs whose age is dominated by
`observedAt - blockTime` are the market being faster than this process, and
widening the gate would convert them into stale trades — worse, and harder to
see. I will not propose raising `maxSignalAgeMs` on this run's evidence unless
the clustering condition above is met.

## Standing limits, unchanged

A socket death is needed to exercise the lost-wakeup path; ~0 deaths in the last
two runs, so "not contradicted" remains the likely verdict there. Environment
integrity must show 0 sleeps or the numbers are void.
