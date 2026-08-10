# Current state — end of session 25 (2026-08-09)

Head: `804724b`. 923 tests passing, 23 files. Typecheck clean. Paper mode.
Ledger: 0 pending intents, 2 open positions, 6 acknowledged orphans.

## What session 25 changed

| Commit | Change |
|---|---|
| `2b7ca41` | Split the unparsed alarm into `classifiedShare` (printed) and `unhandledShare` (alarmed) |
| `6644c45` | Cursor barrier — a cursor cannot name a position whose predecessors are unhandled |
| `6ae46b0` | Lost wakeup — a socket death during post-reconnect gap fill was dropped |
| `e84497d` | Recorder attribution — `slot` on fetch-window, `wallet`/`slot`/`source` on unparsed |
| `667457c` | Split `disconnects` into socket deaths vs connect-attempt failures |
| `a64422e` | Death-injection tests, barrier precondition enforcement, `deferred` bound |
| `a7e1265` | Soak pre-registration |
| `804724b` | Fixed the quadratic barrier (self-inflicted) and the recorder-stats counter |

## The two most important things to know

### 1. The soak failed its gate

Ran 132.3 min under `caffeinate` with **0 host sleeps** (verified against 32 in a
3h control window, so the numbers are valid). It produced **0 live swaps**
against a gate of ≥90.

Cause: `start()` gap fills before it connects, and the gap fill never finished.
11 of 13 wallets completed; wallet 12 was still fetching at shutdown with
20,045 fetches and 77,236 slots reserved; wallet 13 never began. ~51 hours of
downtime had built an enormous warm backlog, and **warm fill is unbounded**.

So: none of the reconnect machinery was exercised. Zero socket deaths, zero
connect failures, zero reconnects — because the socket never connected at all.

### 2. What is verified and what is merely not contradicted

**Exercised by the soak:** the barrier's `hold`/`reserve`/`set` path, hard —
35,940 gap-fill completions, 15,895 signatures recovered, 12 of 13 cursors
advancing incrementally. The unparsed predicate against real traffic
(n=30,444, unhandled 0). The recorder attribution fields.

**Not contradicted, not verified:** the lost-wakeup fix, the disconnect split,
`reconnected`-means-live. Their triggers never occurred. The deterministic tests
in `tests/deathInjection.test.ts` are the only evidence for those.

Do not let anyone — including yourself — describe the reconnect path as
validated. It is not.

## Open problems, in priority order

### Unbounded warm gap fill — now the top item

`MAX_COLD_FILL` (100) is gated on `cursor === undefined`, so it only applies to
cold fills. A warm fill replays everything since the cursor, serially, with no
bound. After a long downtime this makes startup blindness effectively unbounded:
132 minutes and still not connected.

This has to land before another soak, or the next soak spends its whole window
in gap fill again and answers nothing. It is now **ahead of** round-robin rather
than beside it.

### Task 1 — guard layer exception containment (untouched)

Gates 7 (`inner.getQuote`) and 8 (`inner.canSell`) in `core/guards.ts` `await`
into the broker with no `try`. A quote outage or screener throw exits
`guarded().execute` as something that is not a `GuardRejection`.

The tracker has a backstop, so no intent is orphaned — but the guard layer's
contract (every rejection returns a typed code) is not held, and rejection
counters undercount. **Evidence: 51 intents resolved `failed` with
`QuoteUnavailableError` against 13 typed rejections total.**

The fail direction must differ per side: buy + quote error → reject;
buy + `canSell` error → reject; **sell + `canSell` error must not block the
sell** — a held position must always be exitable, and an upstream screener
failure is exactly when that matters.

### Round-robin drain (queued)

One wallet monopolises the serial gap-fill loop. Must not be landed before the
barrier is made **counted** — `hold` currently throws on a double hold, which is
what will catch this.

### Remaining Task 4 thresholds

Four zero-threshold findings in the digest still lack recorded provenance:
`drift != 0`, `recorder.dropped > 0`, `unmodeled.size > 0`, any `NO_ROUTE`.

### The 66.4% `venue: 'unknown'` population

1,913 of 2,879 tracked swaps carry `venue: 'unknown'`. They parse correctly and
nothing is lost, but no alarm covers that population. Parser-layer question,
deliberately not addressed.

### Task 5 — fill-time capture for the 30 bps recalibration

**Off the list.** Sign-off for touching `db/ledger.ts` was requested across three
handoffs and never given, so it was dropped. Consequence: every soak continues to
produce fills that cannot support recalibrating the 30 bps paper latency penalty.
Needs an explicit decision to come back.

## Known-invalid figures

Do not compare these to anything current. Recorded in `docs/digest-schema.md`.

- **All four digests in `sessions/digests/` from before 2026-08-08** are schema 0.
- `stream.disconnects` summed connect-attempt failures with socket deaths and
  double-counted the deaths. 25,783 attempt failures vs ~39 real deaths, reported
  as one number.
- `stream.reconnectLatencyMs` was measured to a `reconnected` that could fire for
  an already-dead socket. The `p50 36113ms` in `digest-001-final-SIGTERM.json` is
  one of these.
- `unparsedShareBps` measured every unparsed transaction including correctly
  declined ones. Fired at 97.05% on a healthy run.
- **Session 22 and 23 soak numbers** were measured across a window that was ~75%
  suspended. Void.

## Sequencing for the next session

1. Bound the warm gap fill. Nothing else can be measured until startup completes.
2. Re-soak, long enough to reach live traffic and ideally a real socket death.
3. Task 1, before a second `Broker` implementation exists.
4. Round-robin, only after the barrier is counted.
