# Session 26 soak — pre-registration

Written **before** the run. Commit `e32038e`. Target **2.2h** (>113.9 min, and
the same duration as the 2026-08-09 run so the two are comparable). Paper mode,
under `caffeinate`.

Pre-flight: 0 pending intents, 2 open positions, 6 acknowledged orphans (entry
gate open), clean tree, 942 tests passing.

## What is being validated

Five commits have changed startup and none has run against a live feed:

| Commit | Claim |
|---|---|
| `6a2e680` | Warm fill bounded at 100/wallet; truncation announced as an acknowledged gap |
| `d40fc56` | Price loop scheduled before the feed |
| `462fd87` | `running` means a socket is live and subscribed |
| `e32038e` | A swap during the startup fill can become a trade |
| `804724b` | Barrier linear, recorder stats latched |

## Starting condition

Cursors are **38 hours** old for twelve wallets and **63 hours** old for
`H8sMJSCQ`. Backlogs are therefore far larger than 100, so **truncation should
fire on most or all wallets**. That is the point: this is the first run where
the warm bound is exercised on real data rather than a fixture.

## Predictions

| Quantity | Prediction | Falsified by |
|---|---|---|
| Time to socket connected | **< 10s** | Anything minute-scale means connect is not actually first |
| Time to first live parsed swap | **< 2 min** | The 2026-08-09 baseline was *never*; 2026-08-07 was 10.57 min. Minute-scale-plus means fill length still dominates |
| Startup fill duration | **4–6 min** | 13 × 100 × 194ms ≈ 4.2 min. Much more means the bound is not biting |
| `history-skipped` events | **10–13** | Zero means the bound never fired against 38h backlogs — i.e. it is broken |
| `signaturesSkipped` | large, 10k–100k+ | — |
| Live parsed swaps | **≥ 90** (gate); expect ~150–200 | At 1.40/min over ~130 min. Below 90 fails the gate |
| `unhandledTotal` | **0** | Any value >0 |
| `peakOutstanding` | **≤ 100** | >100 means `reserve` is not taking the bounded set |
| `peakDeferred` | **< 50** | Near 4,096 means the deferral model is wrong |
| `barrier.heldNow` at final digest | **0** | 13 during the fill is now *correct*; 13 at the end means a leaked hold |
| Socket deaths | **0–3** | — |
| `paperBalanceDrift` | **0** | Invariant |
| Pending intents at exit | **0** | Invariant |

## The prediction I am least sure of, and why it matters

**`STALE_SIGNAL` rejections during startup.** This is new and is a direct
consequence of `462fd87` + `e32038e` together: `connected` now fires before the
fill, so `status` is `running` **during** the startup backfill, so gap-filled
swaps reach `onSwap`, reach the strategy, become intents, and are refused at gate
3 on age.

That is correct behaviour by design — `mirror.ts` argues explicitly that a risk
limit biting is a measurement rather than noise, and the alternative (filtering
in the strategy) makes the drop invisible. But that argument was written when a
cold fill was 100 entries total, not 1,300.

Prediction: **200–700 `STALE_SIGNAL` rows on startup**, being the buy-side share
of ~1,300 replayed swaps for mints not already held.

**If it exceeds ~1,000, I will call it a finding rather than a success.** A
startup that writes four figures of rejected intents every time is a ledger
noise problem even when each row is individually correct, and it would distort
every guard-rejection count the digest reports.

## What a green run will and will not show

**Will exercise:** the warm bound and its truncation path against real backlogs;
the connect-first ordering; `running` bound to the socket; the barrier under
live-during-fill interleaving for the first time ever; entry intents actually
being created, which no prior soak produced.

**Will not prove, unless the trigger occurs:** the lost-wakeup fix and the
death-during-startup-fill handling. Those need a socket death, and the base rate
is ~39 deaths across ~890 minutes of prior sessions. If zero occur, the correct
statement is "not contradicted", and `tests/deathInjection.test.ts` remains the
only evidence — the same limit as last time.

**Cannot be detected by the silence detector:** a socket dying silently *inside*
the startup fill. `ensureLoops()` is bound to `stream.start()` returning, so the
heartbeat interval does not exist during the fill. Detection falls to the
post-fill `socket === undefined` check.

## Environment integrity

Host slept 32 times in a 3h control window without `caffeinate`. Run under it,
verify 0 sleeps across the window, and report numbers **void** if that cannot be
shown.
