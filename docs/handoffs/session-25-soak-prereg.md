# Session 25 soak — pre-registration

Written **before** the run starts. A soak read after the fact confirms whatever
you hoped, so the predictions below are committed first and graded honestly
afterwards, including the ones that turn out wrong.

Commit at time of writing: `a64422e`. Duration target: **> 113.9 min** (longest
clean run on record, `20260806T152610Z-000`). Paper mode, under `caffeinate`.

## What would falsify each fix

| Fix | Commit | Falsified by |
|---|---|---|
| Unparsed alarm split | `2b7ca41` | `unhandledTotal > 0` on a run where the parser is behaving, i.e. a code appearing that is neither in the allowlist nor a genuine new parser state. Also falsified if `classifiedShareBps` is *absent* or the digest still prints `unparsedShareBps`. |
| Cursor barrier | `6644c45` | Any wallet's exit cursor naming a slot with an unhandled predecessor. Also falsified if `barrier.heldNow > 0` at exit (leaked hold → frozen cursor), or if a restart replays entries it already emitted **and** the ledger shows duplicate positions. |
| Lost wakeup | `6ae46b0` | A `socketDeath` with no subsequent `reconnected` and no live socket, i.e. an interval where the feed is quiet and the socket is dead. This is the failure that was invisible before this session. |
| Recorder attribution | `e84497d` | Any `fetch-window` record without `slot`, or any `swap-unparsed` without `wallet`. |
| Disconnect split | `667457c` | `socketDeaths` counting a connect-attempt failure, or `deathEchoesCollapsed` staying 0 while raw `error`/`close` pairs occur. |
| Barrier precondition | `a64422e` | The `already held` throw firing at all — it would mean two wallet loops ran, which the current code should make impossible. |

## Predicted numbers

Stated as point estimates with reasoning, so a miss is visible rather than
retro-fitted.

| Quantity | Prediction | Basis |
|---|---|---|
| Real socket deaths | **0–3** over ~2h | 39 deaths across ~890 min of prior sessions ≈ 0.044/min → ~5 expected in 115 min, but most prior deaths clustered in the degraded 2026-08-05 runs. Wide interval on purpose. |
| Every death recovers to a live subscribed socket | **yes, 100%** | This is the fix. Any miss falsifies `6ae46b0`. |
| Quiet-and-dead intervals | **0** | Same. |
| `connectAttemptFailures` | **0–200** | Dominated by whether Helius has an outage. Uninformative if 0. |
| Exit cursors naming an unhandled predecessor | **0** | Falsifies `6644c45` otherwise. |
| `barrier.heldNow` at exit | **0** | Non-zero is a leaked hold. |
| `barrier.peakDeferred` | **< 200** | Deferral only accumulates while a live delivery lands during a gap fill. Measured at 0 occurrences over the observable corpus, so I expect this near 0. **If it exceeds 4,096 the bound is biting and the constant needs re-deriving.** |
| `barrier.peakOutstanding` | **100–3,500** | This is gap-fill length, not a defect. Cold fills cap at `MAX_COLD_FILL`=100; the largest warm fill on record is 3,142. |
| `unhandledTotal` | **0** | 0 across n=16,474 prior records. |
| `classifiedShareBps` | **4,000–9,800** | Ranged 16%–97% across 11 sessions; it is traffic mix, not health. |
| Startup blind time, per wallet | **6–13 min for the last wallet** | Baseline is 10.57 min (`20260807T025234Z-000`). Nothing this session touched the serial drain, so I expect **no improvement**. This number exists to be the pre-round-robin baseline, measured post-fix. |
| Live-parsed swaps | **≥ 90** | Soak gate. |
| Guard rejections | **undercounted** | Task 1 is unfixed: gates 7/8 throw non-`GuardRejection` errors recorded as `failed` with `QuoteUnavailableError`. Expect `failed` rows to exceed `guardRejectionsByCode` totals. Not a finding — a known hole. |
| `paperBalanceDrift` | **0** | Invariant. |

## What a green run will and will not prove

Committed in advance, because this is the part that gets fudged afterwards.

A quiet run **exercises**: the barrier's `hold`/`reserve`/`release` path on every
startup and reconnect gap fill; the disconnect split; the recorder fields; the
unparsed predicate against real traffic mix.

A quiet run **does not prove**: the lost-wakeup fix, unless a socket actually
dies *during* a gap fill — the observable corpus contains **one** reconnect with
source attribution, so the base rate is unknown. If zero deaths occur, the
correct statement is "not contradicted", not "verified", and the deterministic
tests in `tests/deathInjection.test.ts` remain the only evidence.

## Environment integrity

The host slept 434 times between 2026-08-07 and 2026-08-08 and enters Deep Idle
aggressively, which is what voided session 23. The run must be under
`caffeinate`, and the report must show the PID alive at both ends plus a
sleep-log check across the window. A run that cannot prove it was awake reports
its numbers **void**.
