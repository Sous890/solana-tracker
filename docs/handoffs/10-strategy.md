# Handoff 10 — Strategy interface, runner, and MirrorStrategy

Files added: `src/core/strategy.ts`, `src/services/strategyRunner.ts`,
`src/services/strategyRegistry.ts`, `src/strategies/mirror.ts`,
`src/strategies/equation.ts`, `tests/strategy.test.ts`. `tracker.ts` gained
`useStrategy()`, the `running`-only swap gate, an `onPriceTick` call in the
price loop, and a `strategy-error` event. `config.ts` gained one optional field.
**No other file in `src/core/` was touched, and `ledger.ts` is unchanged.**
612 tests green, typecheck and build clean.

## The interface, as built

```ts
type IntentDraft = Omit<OrderIntent, 'id'>

interface Strategy {
  readonly name: string
  onTrackedSwap(swap, ctx): Promise<IntentDraft | null>
  onPriceTick(position, priceSol, ctx): Promise<IntentDraft | null>
}

interface Context {
  readonly positions: readonly Position[]   // frozen, incl. every held state
  readonly balanceSol: number               // derived, heuristics only
  readonly config: Config                   // frozen shallow copy
  getPriceSol(mint): Promise<number | QuoteError>
  now(): UnixMillis                         // injected clock
  readonly log: StrategyLogger              // info / warn, no error
}
```

Two deviations from the brief's sketch, both small:

- **`StrategyLogger`, not `Logger`.** A bare `Logger` exported from `core/` is a
  name collision waiting to happen. It has no `error` method: a strategy does
  not get to declare an emergency — it returns `null`, and the runner is what
  reports a genuine failure.
- `core/strategy.ts` has **zero runtime imports** (every import is
  `import type`, erased at compile time), so the interface cannot drag I/O into
  `core/` even by accident. A test asserts it.

## Three findings, in order of how much they matter

### 1. Garbage from a strategy is NOT caught by guards

The brief says: *"Garbage from a strategy is caught by GUARDS ... Assert the
specific GuardRejection code each time."* Measured against the real stack, of
ten malformed intents **one** produces a `GuardRejection`:

| Malformed intent | What actually stops it | Ledger record |
| --- | --- | --- |
| sell with no position | **`GuardRejection` `NO_OPEN_POSITION`** | `rejected` |
| negative `amountLamports` | paper broker `RangeError` | `failed`, code `RangeError` |
| zero `amountLamports` | paper broker `RangeError` | `failed` |
| absent `amountLamports` | paper broker `RangeError` | `failed` |
| negative `amountTokens` | paper broker `RangeError` | `failed` |
| non-base58 mint | quote adapter `NO_ROUTE` | `failed`, code `NO_ROUTE` |
| null mint | quote adapter `NO_ROUTE` | `failed` |
| `NaN` `amountLamports` | `TypeError` inside guard gate 3 | **nothing written** |
| **`amountTokens` above the position** | **nothing** | `filled` |
| **`NaN` `amountTokens`** | **nothing** | **nothing written** |

The cause is structural rather than a bug: **`guards.ts` validates risk, not
well-formedness.** `spendLamports` takes `max(requested, config.positionSizeSol)`
— written so an intent asking for *more* could not slip past the gas reserve —
so an intent asking for less than nothing sails through every gate. `guardSell`
checks that a position exists and never compares the amount to it.

The last two rows are the dangerous ones and were reproduced against a real
ledger on disk:

**Overselling fills, and mints paper SOL.** A sell of 999,999,999,999 base units
against a position holding 1,000,000,000 executes. `replayMint` clamps
`sold = min(requested, tokens)`, so the *position* correctly lands at zero — but
the fill row keeps `tokens_delta = -999999999999` and the simulated wallet is
credited the full proceeds. Measured: balance 4.95 SOL → 5.947 SOL, +0.997 SOL
conjured from tokens that were never held. Status `filled`, `rejection_code`
NULL. Paper P&L is fiction from that point on, silently.

**A `NaN` amount "fills" in the events while the ledger drops it.**
`intents.amount` and `fills.tokens_delta` are `INTEGER NOT NULL`; a `NaN` binds
as NULL; and **both inserts are `INSERT OR IGNORE`**, which swallows the
constraint violation. `Tracker.submit` returns a `Fill`, emits `intent-created`
and `fill` — and the ledger has no row for either. The event stream says a trade
happened; the source of truth says it did not.

**Not fixed here, deliberately.** The rules of engagement say to stop and report
if the work seems to require changing `guards.ts`, `broker.ts` or `types.ts`,
and `ledger.ts` is frozen. Both fixes live in exactly those files:

- A `MALFORMED_INTENT` gate in `guards.ts`, ahead of gate 0, rejecting a
  non-`bigint` or non-positive amount and a sell exceeding
  `position.tokens`. That is the one place it can produce a `GuardCode` and
  therefore a countable `rejection_code`, which is what Prompt 12 reads.
- `INSERT OR IGNORE` on `fills` and `intents` is right for idempotency and
  wrong for integrity. It should ignore *primary-key* conflicts only; a
  `NOT NULL` violation must raise.

`tests/strategy.test.ts > malformed intents: what actually stops them` pins the
measured behaviour so both gaps are documented rather than hypothetical, and so
those fixes have tests that visibly flip. **MirrorStrategy cannot reach any of
them** — a sell is always exactly `position.tokens` read from the frozen
context, a buy is always `solToLamports(config.positionSizeSol)` — and a test
asserts that too.

### 2. `PositionState.closing` is never produced by anything

`types.ts` declares `'open' | 'closing' | 'closed'`. `replayMint` writes
`tokens > 0n ? 'open' : 'closed'` and its comment says `closing` is "transient
runtime state owned by services" — but no service sets it either. Confirmed by
grep: the only references are the type, that comment, and the two strategy files
handling it.

So mirror's `closing` branch is future-proofing, not live behaviour. **What
actually prevents a double exit today is guard exit gate 2**, `SELL_IN_FLIGHT`,
claimed synchronously before any await. A test asserts both halves: that the
ledger only ever reports `open`, and that two concurrent sells for one mint
produce one fill and one `SELL_IN_FLIGHT`.

Worth deciding deliberately later: either the tracker starts projecting
`closing` from the guard layer's in-flight set, or the state is removed from
`types.ts`. Leaving a declared state that nothing produces invites exactly the
wrong assumption — that checking it is sufficient.

### 3. A restart would have collided intent ids, silently

Not a finding about the brief; a hazard the design ran into.

The obvious id scheme is a per-run counter. The ledger keys a simulated fill on
`intentId:mint`, and `recordIntent` is `INSERT OR IGNORE`. A counter restarting
at 1 each boot writes, on the second run, an id that already exists: the insert
no-ops, and the fill collides with the previous run's fill and is dropped. No
error anywhere; the position simply never moves.

Ids are therefore `<strategy>-<runId>-<seq>`, where `runId` defaults to the
injected clock read once at construction. Unique per run, and still fully
deterministic — a replay that injects the same clock reproduces the same ids
byte for byte. A test asserts both properties.

## The 500ms timeout was harder than it looks

Two bugs, in the same three lines, both found by tests rather than by reading.

**The lock must not be what the caller awaits.** The first implementation held
the per-mint lock by `await`ing the wedged strategy call before returning — so
`onPriceTick` never resolved for a strategy that never answered. The tracker
`await`s that hook inside the price loop, so a hung strategy would have hung the
loop: precisely the "neither may stop a loop" rule, broken by the code meant to
enforce the lock. The test hit the 5-second vitest timeout, which is how it
surfaced.

`execute` now *returns* the still-running promise and `run` releases the lock
when it lands, after having already returned to the caller.

**`await` flattens nested promises.** Returning that promise bare from an
`async` method makes the signature `Promise<Promise<T>>`, and `await` on it
waits for the inner one too — silently reintroducing the identical hang.
TypeScript caught this (`Type 'unknown' is not assignable`). The promise is
returned in a box, `{ pending }`, and the comment says why so nobody unwraps it
back.

Net behaviour: the hook resolves at 500ms at the latest; the mint stays locked
until the wedged call actually finishes; whatever it eventually returns is
discarded, because we already answered `null` against a context that has since
moved on. A permanently wedged strategy costs one locked mint, visible in
`stats.timeouts` — the alternative was one leaked live invocation per tick,
forever.

## Behaviour by bot state

| State | `onTrackedSwap` | `onPriceTick` |
| --- | --- | --- |
| `running` | yes | yes |
| `stopping` | **no** | yes |
| `idle`, positions open | **no** | yes |
| kill switch engaged | **yes** | yes |

The swap gate lives in `tracker.ts` because the tracker owns `BotState`, and it
is asserted from both sides. `stop()` means "no new exposure"; a swap that could
still open a position afterwards would make stop a suggestion. It is not enough
that guards would then reject the buy — it would reject it as `NOT_RUNNING`,
filling the intents table with entries the operator never wanted and that Prompt
12 would count as risk-limit activity.

The kill switch is **not** pre-filtered, exactly as specified. The strategy is
asked, the intent is written, guards reject it, and
`intents.rejection_code = 'KILL_SWITCH_ENGAGED'` — verified by reading the
column out of SQLite, not by trusting the event.

Both required end-to-end cases pass: a -40% stop fires, executes and settles
**after `stop()` has returned the bot to idle**, and again with the kill switch
engaged **and persisted across a restart** (two `Tracker` instances over one
database file).

## MirrorStrategy

Entries mirror somebody else; exits do not. A wallet that stops trading — or
that we stop seeing, at `confirmed` commitment over a websocket that can drop —
must not mean we hold forever, so the band is the second exit trigger.

- tracked buy of a mint we do not hold → buy `config.positionSizeSol`
  (**not** their size; mirroring it would let a whale set our position sizing)
- tracked sell of a mint we hold → sell 100%, whatever fraction they sold
- `onPriceTick` → sell 100% at **≤ -40%** or **≥ +150%** from `avgEntrySol`,
  both bounds inclusive, pinned at -39.9 / -40.0 / -40.1 and 149.9 / 150.0 /
  150.1

Reason strings name the trigger and the numbers:
`mirror: 7xKX..sU sold 0.41 SOL`, `stop: -41.2% from 0.00000123`. Prices are
formatted through `formatPriceSol`, which never emits exponent notation —
`String(0.000000123)` is `"1.23e-7"`, unreadable in an audit log and impossible
to eyeball against the ledger.

The four explicit no-ops, each tested at the unit level and end to end:

| Case | Why `null` rather than "let guards reject it" |
| --- | --- |
| tracked wallet sells a mint we never held | would be `NO_OPEN_POSITION` |
| second wallet buys a mint we already hold | would be `ALREADY_HOLDING` |
| swap for a position in `closing` | would be `SELL_IN_FLIGHT` |
| unusable price on a tick | **hold, do not panic-sell** |

The distinction the runner's header states and mirror obeys: *the strategy does
not emit what it already knows is wrong; the runner does not second-guess what
the strategy emitted.* A guard rejection is a **record** — Prompt 12 counts
`rejection_code` to say how often the risk limits actually bit — and a strategy
that knowingly emits rejects fills that table with self-inflicted noise until
the report describes the strategy's sloppiness instead of the market.

On the last row: a missing or nonsensical price is a fact about our data, not
about the token, and selling on it converts a plumbing failure into a realized
loss. A genuinely unroutable position is already surfaced by the tracker's
`route-lost` latch — an alert for a human, not a signal for a strategy. In
practice the strategy is not even consulted: the price loop skips `onPriceTick`
when the exit quote fails, so `stats.ticks` stays at 0.

## The price handed to `onPriceTick`

`lamportsToSol(quote.outAmount) / wholeTokens`, **not** `lamportsToSol(perToken)`
where `perToken` is the bigint mark. `perToken` is floored to whole lamports, so
a sub-lamport token marks at zero — and a strategy comparing that against
`avgEntrySol` would read a total loss on a token that had not moved.

The float is the same ratio `avgEntrySol` is (SOL over whole tokens), so the two
are directly comparable, and both are fee-inclusive in their own direction:
entry cost includes what was paid, the exit price is net of what the route would
take on the way out.

The tick **awaits** the strategy rather than firing and forgetting. The tick
already awaits a network quote per position and the 500ms ceiling bounds this to
less; awaiting is what makes the order of intents a function of the order of
positions, which is what the replay promise needs. A tick that overruns its 2s
interval is skipped by the existing `priceTickRunning` latch and shows up in
`stats.priceTicks`.

## Determinism

`src/strategies/` is grepped for `Date.now`, `new Date`, `Math.random` and
`fetch`, with comments stripped first — the module headers *name* all four in
prose explaining why they are banned, and a check that fails on its own
documentation is a check people delete. A separate test asserts the grep is not
vacuous (the directory exists and contains the files it expects), and another
asserts every import in `src/strategies/` resolves to `../core/`: a strategy
that can reach `adapters/` can reach a broker, and the guard layer is only total
because `Broker` is the one door to funds.

The replay test runs the same four-swap sequence twice and compares ids, reasons
and ordering, plus a literal expectation of the whole sequence so a change to it
is visible in review rather than only as a diff of two runs.

## `config.strategy` — the one additive edit

`z.string().min(1).default('mirror')`. A plain string, **not** an enum:
validating the set in `core/config.ts` would mean `core/` importing the registry
from `services/`, an import pointing the wrong way down the dependency chain.
The cost is that a typo fails when the runtime is built rather than at config
parse — `createStrategy` throws by name and lists what it knows, and
`npm run serve` exits 2 with that message, verified.

An empty string is rejected rather than defaulting: it is a mistake, not an
instruction to use mirror, and silently defaulting would run a strategy the
operator did not ask for.

Tested against the verbatim pre-strategy `config.json`: it loads, gets `mirror`,
every other value is unchanged, and every floor still applies.

## Mutation results — which tests kill which

All 21 killed.

| # | Mutation | Killed by |
| --- | --- | --- |
| 1 | no timeout at all | **3** |
| 2 | timeout awaits the wedged call (the bug above) | **2** |
| 3 | timeout counted but not reported | **2** — `TIMES OUT…`; `makes a wedged strategy distinguishable from a quiet one` |
| 4 | no per-mint lock | **4** |
| 5 | one global lock instead of per-mint | **2** — incl. `does NOT serialize across different mints` |
| 6 | lock released before the submit | **2** |
| 7 | stop boundary exclusive (`<` not `<=`) | **1** — `SELLS at exactly -40.0%` |
| 8 | take boundary exclusive | **2** |
| 9 | stop moved to -45% | **5** |
| 10 | panic-sell on an unusable price | **2** |
| 11 | duplicate buy emitted | **2** |
| 12 | sells a mint never held | **3** |
| 13 | ignores `closing` | **1** |
| 14 | mirrors their fraction instead of 100% | **4** |
| 15 | `onTrackedSwap` called in any state | **2** |
| 16 | `onPriceTick` only while running | **5** |
| 17 | `runId` dropped from intent ids | **2** |
| 18 | ids made nondeterministic | **4** |
| 19 | positions not frozen | **2** — `refuses a write to a Position`; `a strategy cannot act on a position it edited under itself` |
| 20 | config shared rather than frozen | **2** — incl. `a strategy cannot widen the risk limits the guard layer enforces` |
| 21 | guard rejection reported as a strategy error | **2** — incl. `counts a rejection ONCE, under one heading` |

Six died to a single test and were probed. Four produced a real addition; the
added tests are the operational property rather than the mechanism:

- **3** — a timeout and a quiet strategy both produce no intent. The only thing
  that tells them apart is the event, so the added test asserts a healthy
  strategy emits none and a wedged one emits exactly one, tagged `timeout`.
- **19** — the first replacement did not discriminate: with the freeze removed
  the runner still hands out fresh copies per call, so the mutation was
  invisible. Rewritten as the failure it actually causes — a strategy that
  writes a miscalculation onto a `Position` and then sizes an order from it
  would exit 1 base unit of a 1,000,000,000-unit holding, leaving the position
  open on a signal that has already fired.
- **20** — a strategy raising `positionSizeSol` on a shared config would move
  the gas reserve that guard gate 3 computes against. The added test tampers,
  then asserts the fill is still for the configured size.
- **21** — the added test runs three rejections and asserts three `rejection`
  events, zero `strategy-error`, and stats that separate them.

**7 and 13 remain at one test each, and inherently so.** A boundary is only
observable at the boundary, and `closing` is only observable in a state nothing
currently produces (finding 2). Both are direct, named assertions rather than
incidental catches. Note also that the end-to-end -40% test does *not* pin the
boundary: its price arrives via a different float path
(`lamportsToSol(30_000_000n)/1000`) that lands a hair beyond -40%, so only the
unit test sits exactly on it.

## Notes for whatever consumes this

- **`useStrategy()` is the wiring point.** One visible call at the composition
  root, not a constructor field — it is the change that turns an observer into a
  trader. `useStrategy(null)` returns the tracker to a pure observer: marks,
  screens and alerts keep working and nothing creates an intent.
- The runner reaches `tracker.submit`, **never** `broker.execute`. The strategy
  replaces what to do, never how — the id, the ledger write, guards, the broker
  and the events are the same path an operator uses.
- `StrategyHost` is four methods. The runner cannot start, stop, flatten, or
  touch the kill switch.
- A strategy returns **at most one** draft per call. Wanting two things means
  doing the more urgent one; the next tick is 2 seconds away, and one-at-a-time
  is what makes the per-mint lock meaningful.
- `ctx` is rebuilt per call and frozen all the way down, including a frozen
  shallow copy of `Config`. A strategy that stashes one reads a stale snapshot
  rather than corrupting anything.
- `strategy-error` carries `kind: 'throw' | 'timeout'`. They are counted
  separately because they need different fixes: a strategy that raises is broken
  logic, one that hangs is doing I/O it was told not to do.

## Not verified live

Unchanged from handoff 09, and now the more conspicuous gap: `.env` does not
exist in this checkout, so there are still **no provider credentials**.

- **The strategy path has never seen a real tracked swap.** Every
  `onTrackedSwap` test drives `WalletStream`'s `swap` event directly or through
  a fake feed. The parser is tested against seven real captures (handoff 07) and
  the tracker against a fake feed, but the seam from a live `logsSubscribe`
  frame through to an intent has never run end to end.
- No `onPriceTick` has ever been driven by a real Jupiter quote.
- No intent this strategy produced has been executed against a real route, even
  in paper mode.

`createTrackerRuntime()` **was** booted end to end again this session, with
unreachable RPC URLs: it logged `Strategy "mirror" attached`, came up
`mode=paper, status=idle`, served `/state`, and exited cleanly on SIGINT. An
unknown `strategy` name exits 2 with the registry's message. What that does not
prove is anything past `POST /start`.

First live run: `npm run serve` with `trackedWallets: []` and
`strategy: "equation"` — a strategy that observes and never trades — watching
`GET /events` until the stream, the marks and the screens look right. Only then
switch to `mirror`, and only then add a wallet.
