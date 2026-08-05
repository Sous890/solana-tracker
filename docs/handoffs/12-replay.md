# Handoff 12 — Record and replay

Files added: `src/services/recorder.ts`, `tests/replay/{run,session,invariants,report,synthetic}.ts`,
`tests/replay.test.ts`, `tests/replay/fixtures/synthetic-mirror.jsonl`.
`tracker.ts` gained an optional `sessionDir`; `adapters/safety.ts` had one
parameter type widened. **`src/core/*` and `src/db/ledger.ts` are unchanged** —
the harness needed one thing from `core/` and it was already exported.

**Tests: 655 before, 701 after** (+46). Typecheck and build clean.

## Record mode

Four kinds, all **inputs**: `swap`, `quote`, `screen`, `price-tick`. Fills,
intents and positions are deliberately absent — replay regenerates those through
the real broker and the real guards, and a session carrying them could be
replayed into agreement with itself. The point of a replay is that it can
disagree.

```json
{"seq":8,"simClockMs":1700000007000,"kind":"quote","payload":{...}}
```

### No call sites inside adapters

Two of the four are already on the tracker's emitter, so those are a
subscription. The other two are not, and rather than editing `jupiter.ts` or
`safety.ts` the recorder hands back **decorators** — `wrapQuotes`,
`wrapScreener`, `wrapDriver` — installed once at the composition root. No
recorder, no wrappers, and an adapter that has never heard of recording stays
that way.

`wrapDriver` is a `Proxy`, and that is load-bearing rather than clever.
`StrategyDriver` is an `EventEmitter` and the tracker subscribes to
`strategy-error` on whatever it is handed. An object literal drops that;
`Object.create(inner)` is worse, because `EventEmitter` writes its listener map
onto `this`, so subscriptions would land on the wrapper while emits fired on the
inner and nothing would ever be delivered. A test pins it.

### `seq` is the tie-break, and it is not decoration

A test writes two lines through a clock stuck on one millisecond and asserts
both carry the same `simClockMs` and distinct `seq`. This is the same lesson the
ledger learned in handoff 09 — `(at, id)` sorted by an alphabet with no causal
meaning — except a session file has no `rowid` to fall back on.

### Recording never gates the live path

Writes are fire-and-forget onto a stream with a bounded buffer; past the bound a
line is **dropped and counted**. A bot that hesitated on a trade because a log
file was slow would be worse than one with an incomplete log — and an incomplete
log announces itself, because `parseSession` **refuses a session with a gap in
`seq`**. A missing quote would be a loud miss, but a missing *swap* would be a
trade that simply never happens, which is silent. So the gap is caught up front.

### One type widened

`canSellFromScreener(screener: SafetyScreener, …)` became
`canSellFromScreener(screener: MintScreener, …)`, a structural interface holding
the one method it actually calls. That is what lets a decorator sit in front of
it without a recording call site inside `safety.ts`. Type-only; no behaviour
changed.

## Replay mode

`npm run replay -- <session.jsonl> [--slippage-bps 0,30,100,250] [--json out]`

Nothing reimplements execution. `guarded()` and `createPaperBroker()` are the
functions the live process runs and the ledger is a real SQLite file in a fresh
temp dir, asserted to reconcile clean at the end. Swapped out is only the
outside world: a simulated clock, a `fetch` that throws, quotes resolved from the
recording by `(inMint, outMint, amount)`, and sellability resolved from the
recorded screen verdicts. A miss in either is a hard error naming the miss.

`replaySession`'s `submit` mirrors `Tracker.submit` **in order**, including
running gate 0 before the ledger write. That ordering is copied deliberately: an
amount gate 0 rejects may not be representable in `amount INTEGER NOT NULL`, so
getting it wrong makes a malformed intent die as a SQLite constraint error
instead of a counted `MALFORMED_INTENT`. The first version of the harness had it
wrong and the regression test caught it.

### The strategy runner nearly swallowed the whole harness

`StrategyRunner` catches everything `submit` throws — that is how a broker
failure does not stop the price loop, and it is correct. It also caught quote
misses and invariant violations, so a replay against a session missing its exit
quote **completed successfully and reported a profit**. Three tests passed that
should not have.

Fixed with an explicit stash: `InvariantViolation` and `ReplayError` are
remembered as they pass the runner and re-thrown the moment the drive loop
regains control. Everything else stays swallowed, as intended.

## Invariants

Checked at every step, aborting with the `seq` and the offending fill:

1. **Token conservation per mint.** A running Σ(`tokensDelta`) maintained
   *independently of the ledger*, never negative, and compared against
   `position.tokens` after every fill and again at the end. Independent on
   purpose: the ledger derives the position by replaying the same fills, so
   asking it whether the fills add up is asking a question it cannot answer
   wrongly.
2. **No fill without a resolved intent row.** Missing, `pending` or `orphaned`
   all abort.
3. **No clamp fires**, checked *before* the intent is submitted, because
   `guards.clampSellToPosition` reduces an oversell to the holding and executes
   it. That is correct behaviour and it is exactly what makes the condition
   invisible downstream.

## The 2026-08-03 regression, and a contradiction in the brief

**The harness would have caught it.** `OVERSELL_FILLS` is the fill sequence the
ledger actually held that day: a 1,000,000,000-unit position, then a fill row
saying `-999,999,999,999`. Replayed through the checker it aborts at seq 2 with
`heldBefore: 1000000000`, `tokensDelta: -999999999999`,
`wouldLeave: -998999999999`. Every end-of-run check agreed at the time, because
`replayMint` clamps `sold` — which is why this needed a per-step check and not a
summary.

**The brief asked for something current guards do not do.** It says to "assert
the same session under current guards is rejected as `MALFORMED_INTENT` and
never reaches the broker". They are not. Handoff 11 made the opposite decision
deliberately, on this prompt series' own instruction: an exit for more than is
held is *the one malformed-looking case that must still execute*, because
refusing it strands exactly the holder whose ledger and chain already disagree.
`malformedIntentReason` returns `null` for an oversell, and a test asserts that.

What is implemented, and tested, is the honest split:

| Case | Outcome |
| --- | --- |
| the recorded 2026-08-03 fill sequence | **invariant 1** aborts at the offending seq |
| an oversell intent through current guards | **invariant 3** aborts *before* the clamp absorbs it |
| a genuinely malformed sell (`NaN` tokens) | **`MALFORMED_INTENT`**, never reaches the broker, counted by code |

The third is the assertion the brief wanted; it just belongs to a different
input than the oversell.

## Slippage sensitivity, and a limit worth knowing about

The synthetic session, at the four ladder points:

```
   0 bps   pnl         130000 lamports   1 round trips
  30 bps   pnl        -171348 lamports   1 round trips
 100 bps   pnl        -870970 lamports   1 round trips
 250 bps   pnl       -2353563 lamports   1 round trips

 PROFITABLE ONLY AT OR BELOW 0 bps — turns negative by 30 bps.
 The 30 bps default is a guess; this strategy is a bet on that guess.
```

That verdict is a summary line, not a footnote, exactly as asked.

Two things this exposed:

**The penalty compounds across both legs.** A buy receives fewer tokens *and* the
exit for those fewer tokens is discounted again. Hand-derived expectations for
100 and 250 bps were out by a factor of ~1.7; the committed numbers are measured.

**A ladder point can be unreplayable, and that is not a bug.** Changing
`paperLatencyPenaltyBps` changes how many tokens a buy receives, which changes
the size of the exit the strategy asks for, which changes the quote key. A
session recorded at 30 bps contains `MINT->WSOL at 997000000` and nothing else;
replaying it at 0 bps asks for `1000000000` — a miss.

The miss stays a miss. Interpolating between recorded sizes would be
synthesising a quote, price impact is not linear in size, and the resulting P&L
would be a number nobody could defend. `sweepSlippage` reports the point as
unreplayable with the miss that stopped it and carries on. **The consequence:
the sweep is only complete over a session that happens to contain quotes at
every size the sweep produces.** A synthetic session can be generated that way —
`buildSyntheticSession` takes the ladder and emits an exit quote per size, and
says so in its header. A real recording generally cannot, and the honest reading
of a real sweep is "these are the points the recording can answer for". A test
pins this by building a session at a single ladder point and asserting the other
three come back unreplayable.

## Determinism

Same session + same strategy + same config = byte-identical. Proven three ways:
in-process, by writing two files and `Buffer.compare`, and from the CLI —

```
22977cf12ec2a49cb855e218542fb6a214d5037a6baf604c119d667a2996fd14  /tmp/r1.json
22977cf12ec2a49cb855e218542fb6a214d5037a6baf604c119d667a2996fd14  /tmp/r2.json
```

A fourth test replays at a different slippage and asserts the file **differs**,
so the check is not vacuous.

How it is achieved, rather than hoped for:

- **No floats in the report.** Money is lamport strings, ratios are integer bps
  (`winRate.bps`), config floats are stringified. A test walks the whole report
  recursively and fails on any non-integer `number`.
- **No wall clock.** A test greps the serialized report for anything shaped like
  a millisecond timestamp. Durations come from the session's own clock.
- **Stable key order.** Every map goes through `sortedRecord`; object literals
  are written in fixed order.
- **`SimClock` never stands still.** `advanceTo` forces at least +1, so two
  fills never share a millisecond and fall back to the ledger's `rowid`
  tie-break — which is correct but would make ordering a property of insertion
  rather than of the recording.

## Not verified live — stated plainly

**Record mode has never run against a live RPC.** There are no credentials in
this checkout, there are no recorded sessions, and there is no evidence in this
repository that a session captured from a real run would replay. Specifically
unproven:

- that the four kinds are **sufficient** — a real run may make a quote the
  recorder does not see, and the first symptom would be a `QUOTE MISS` on
  replay, which is at least loud;
- that the drop valve behaves under real backpressure. It is tested by setting
  the bound to zero, which proves the branch, not the pressure;
- that a real session's `seq` stays gap-free under load. If it does not,
  `parseSession` refuses it — the failure mode is a refusal, not a wrong answer;
- that recording does not measurably slow the live path. It cannot block by
  construction, but "cannot block" is an argument, not a measurement.

What *is* verified is that the recorder's own output is readable by the harness:
a test drives every kind through `SessionRecorder` and then through
`parseSession`, so producer and consumer cannot drift into agreeing only with a
hand-written fixture.

The smoke test is MirrorStrategy over a synthetic session — one round trip, one
position that loses its route while held, and EquationStrategy over the same
session trading nothing. `tests/replay/fixtures/synthetic-mirror.jsonl` is
committed and a test replays it, so the example the CLI documentation points at
cannot rot.

## Notes for whatever consumes this

- `sessions/` is gitignored. Real sessions are market data and get large; the
  committed example lives in `tests/replay/fixtures/`.
- Turning recording on is one option at the composition root:
  `createTrackerRuntime({ …, sessionDir: 'sessions' })`. It is off by default.
- `recorder.stats.dropped > 0` means the session is unfit for replay. The
  harness enforces this indirectly, by refusing a `seq` gap.
- The harness's `submit` is a copy of `Tracker.submit`'s ordering. If that
  ordering changes, this copy has to change with it — the two are not shared,
  because sharing would mean the harness importing the tracker's I/O.
- `strategyOverride` on `ReplayOptions` exists only so a test can force garbage
  through the real guard layer. No registered strategy can emit what the
  regression fixture needs.
