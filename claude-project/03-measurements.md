# Measurements — every load-bearing number and its basis

This file exists because this project has been damaged more than once by a
number quoted without its provenance. **A figure without `n` and a window is not
reportable.** If you cannot find a number here or in the source comments, say so
rather than reconstructing it.

## Corpus

Twelve session files, `sessions/*.jsonl`. Not all carry the same events:

| Sessions | Window | Note |
|---|---|---|
| 4 files, 2026-08-04/05 | 616.3 min | **No `stream-fetch-window` event** — predates it. 55 of the 56 reconnects on record live here and cannot be attributed to live vs gap fill. |
| 7 files, 2026-08-06/07 | 275.2 min | Full attribution. Contains **one** reconnect. |
| 1 file, 2026-08-09 | 132.3 min | Session 25 soak. Full attribution, 0 live traffic. |

This asymmetry matters constantly: almost every reconnect ever recorded is in
the sessions that cannot say what happened during it.

## Tuning constants and their basis

| Constant | Value | Basis |
|---|---|---|
| `SILENCE_TIMEOUT_MS` | 180,000 | p50 2.6s / p90 14.8s / p99 29.7s / max 57.5s healthy gaps, n=356, after excluding every gap overlapping a host sleep. 180s is ~3.1× the worst healthy gap. Derived session 24. |
| `SEEN_CAPACITY` | 5,000 | Distinct `(wallet, signature)` pairs to distinct signatures = 1.0000 over n=2,788 fetch-window records. Busiest run consumed 1,800 slots. Kept as one global LRU. |
| `MAX_COLD_FILL` | 100 | No recorded basis. Applies only when `cursor === undefined`. |
| `MAX_IN_FLIGHT` | 20 | No recorded basis. Do not raise as a fix for throughput — depth is the wrong lever. |
| `FETCH_ATTEMPTS` | 3 | Reasoned, not measured: the retry budget must stay well inside `maxSignalAgeMs` (15s) or a stale signal gets resurrected. |
| `MAX_DEFERRED` | 4,096 | Next power of two above the largest single gap fill on record (3,142 entries, H8sMJS in `20260807T025234Z-000`). Backstop, not an expected limit. |
| `DEATH_DEDUPE_MS` | 1,000 | Two non-overlapping populations: error/close pairs 0ms min / 1ms p90 / **34ms max** (n=56) vs closest distinct deaths **9,946ms** (n=35). Separation factor 292. |
| `UNHANDLED_THRESHOLD` | 0 (any occurrence) | Genuine unhandled rate is **0 of n=7,184** across the 3 soaks of 2026-08-06/07 (195.7 min combined). Corroborated at 0 across n=16,474 all sessions — corroboration only, same parser produced both. |
| `paperLatencyPenaltyBps` | 30 | **Cannot be validated.** Recalibration needs seven fields captured at fill time; the migration was never signed off. |

## The guard-rejection undercount

51 intents resolved `failed` with `QuoteUnavailableError` against 13 typed
rejections total, n=64 non-filled intents over the whole ledger file. That is
~80% of refusals filed under a word that means "we tried and something went
wrong on chain" — none of these reached the chain. This is the evidence for
Task 1.

## Socket lifecycle, all sessions

| Quantity | Value |
|---|---|
| `stream-disconnected` emissions | 25,878 |
| …of which connect-**attempt** failures (no socket existed) | **25,783** |
| …of which socket-death emissions | 95 |
| …of which are echo pairs (`error`+`close`, 0–34ms apart) | 56 |
| **Real distinct socket deaths** | **~39** |
| `stream-reconnected` | 56 |

An earlier reading of 25,878-vs-56 concluded the stream had been dead for most
of every session. **That inference is withdrawn** — the ratio is a retry
artifact.

## The cursor overlap window

| Quantity | Value |
|---|---|
| Reconnect gap-fill loops | n=56, p50 0.40s, p90 5.89s |
| Live deliveries observed inside one | **0** |
| …but observable base | **1 reconnect** |

The window is **unmeasured, not unhit**. Do not quote "never observed" as
evidence.

## Startup blind time

The baseline round-robin will be judged against, and the session 25 result:

| Run | Last wallet blind until | n |
|---|---|---|
| `20260806T152610Z-000` | 4.36 min | 1,668 fetches |
| `20260807T025234Z-000` | 10.57 min | 3,701 fetches |
| `20260807T023620Z-000` | never (15.4 min window) | 4,694 fetches |
| **`20260809T030115Z-000`** | **never (132.0 min window)** | **35,940 fetches** |

Per-wallet on the 2026-08-09 run: 7.3, 7.5, 10.9, 12.0, 13.0, 13.2, 14.1, 16.5,
26.8, 52.9, 53.0 min, then two that never completed.

## Barrier cost — a defect measured and fixed in session 25

`flush` recomputed `Math.min(...outstanding)` per completion. Against the soak's
real 77,236-slot reservation:

| Outstanding | Before | After |
|---|---|---|
| 1,000 | 0.012 ms | 0.002 ms |
| 10,000 | 0.155 ms | 0.002 ms |
| 77,236 | **1.611 ms** (~124s CPU to drain one wallet) | **0.002 ms** |

Quadratic before, flat after. RPC still dominated the soak's wall clock —
20,045 serial fetches at ~150ms ≈ 50 min against ~2 min of barrier CPU — so this
was **not** why the run went blind.

## Traffic composition

`classifiedShareBps` has ranged **16.0% – 97.05%** across sessions. It is
traffic mix, not health, which is why it is printed and never alarmed. The
2026-08-09 soak: 84.70%, with `TX_FAILED` 26,684 of 30,444 unparsed.

`venue: 'unknown'`: 1,913 of 2,879 tracked swaps (66.4%) across the three
2026-08-06/07 soaks. These parse correctly.

## Environment integrity, 2026-08-09 soak

0 sleep events across the 132.3-min window, against 32 in the 3h control window
immediately before. `caffeinate` held. **Numbers valid.**

For contrast: 434 sleep transitions in the preceding 24 hours without
`caffeinate`, and session 23's soak was ~75% suspended and is void.
