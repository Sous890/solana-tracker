# Handoff 11 — Well-formedness, ledger integrity, and the `closing` decision

Files changed, all under the lifted freeze and nothing else: `src/core/guards.ts`
(gate 0, the oversell clamp, `GuardNotice`), `src/core/types.ts`
(`PositionState`), `src/db/ledger.ts` (two INSERT statements),
`src/services/tracker.ts` (persistence before emission), `src/strategies/mirror.ts`
and `src/core/strategy.ts` (the removed state). No refactors. 655 tests green,
typecheck and build clean.

## The ten-case matrix, before and after

Before is what Prompt 10 measured on 2026-08-03. After is measured now.

| # | Case | Before | After |
| --- | --- | --- | --- |
| 1 | negative buy amount | `RangeError` (broker), intent `failed` | **`MALFORMED_INTENT`** |
| 2 | zero buy amount | `RangeError` (broker) | **`MALFORMED_INTENT`** |
| 3 | NaN buy amount | `TypeError` "Cannot mix BigInt" inside gate 3, **nothing written** | **`MALFORMED_INTENT`** |
| 4 | Infinity buy amount | *(not in the original matrix)* | **`MALFORMED_INTENT`** |
| 5 | absent buy amount | `RangeError` (broker) | **`MALFORMED_INTENT`** |
| 6 | non-base58 mint | `NO_ROUTE` (quote adapter) | **`MALFORMED_INTENT`** |
| 7 | null mint | `NO_ROUTE` (quote adapter) | **`MALFORMED_INTENT`** |
| 8 | negative sell amount | `RangeError` (broker) | **`MALFORMED_INTENT`** |
| 9 | NaN sell amount | **"FILLED"** — Fill returned, events emitted, nothing in the ledger | **`MALFORMED_INTENT`** |
| 10 | sell with no position | `GuardRejection NO_OPEN_POSITION` | unchanged |
| — | **oversell by 1000×** | **FILLED**, `tokens_delta` -999,999,999,999, +0.997 SOL conjured | **clamped and filled**, `tokens_delta` -1,000,000,000 |

Nine of the ten now terminate in a typed `GuardRejection`; the tenth was already
right. A test asserts the negative: no case terminates in `RangeError`,
`TypeError`, `QuoteUnavailableError` or `NO_ROUTE`. Those three were accidents of
the layers below — none carried a code Prompt 12 could count, and `NO_ROUTE` was
indistinguishable from a real token that briefly had no route.

## Fix 1 — gate 0

`malformedIntentReason(intent)` is pure, total, and **exported**, because it has
two call sites that must not drift: `guarded().execute` runs it ahead of every
other gate on both sides, and `Tracker.submit` runs it before the ledger write.

The tracker needs it first for a concrete reason. A malformed amount may not be
*representable*: `NaN` binds as NULL against `amount INTEGER NOT NULL`, so
"record the intent, then let the gate refuse it" is not available — the record is
what would fail. Refusing before the write reports the rejection under its own
code instead of disguising it as a storage failure. The consequence, stated
plainly and tested: **a malformed intent leaves no `intents` row.** The rejection
is still emitted and logged with `persisted: false`.

### Why this does not violate "sells are never blocked"

Because it is not a risk gate. "Is this a coherent instruction" is a different
question from "is this a trade we want", and the entry/exit asymmetry is about
the second. A sell of `NaN` tokens of `null` is not an exit being blocked; it is
not an exit.

The existing test is green and untouched — a well-formed sell executes with the
kill switch engaged and the daily loss cap breached — and there is now the same
assertion against gate 0 specifically, with every entry control tripped at once
(orphans outstanding, kill switch on, status `idle`, loss cap breached).

### The root cause, removed

`spendLamports` used `max(requested, positionSizeSol)`. That `max` exists so an
intent asking for **more** cannot slip past the gas reserve — correct, and kept.
It was also, accidentally, the only thing looking at the low end, and
`max(-1n, 50_000_000n)` is `50_000_000n`: a negative amount was silently widened
into a legal one, passed every remaining gate, and died three layers down.

Clamp high and validate low are now separate steps in separate places, with the
precondition written down. A mutation replacing the clamp with `return requested`
is caught by the compiler (`noUnusedLocals`), which is a cheap extra tripwire.

### Oversell clamps, and clamps early

The one case that must not reject. Rejecting would strand a holder whose ledger
and chain disagree — the exact situation the crash-orphan gate exists for.

Clamped in `guarded().execute`, **before** `inner.execute`, so the quote, the
fill row and the position delta all describe the same quantity. The ledger's
replay already did `min(requested, tokens)`, which is why the *position* looked
right before this fix while the fill row asserted a sale that never happened and
the paper wallet was credited for it.

- The fill row records what **settled**: `-1,000,000,000`.
- The intent row still records what was **asked**: `999,999,999,999`.

Both numbers survive, in the two places that mean different things, so the
discrepancy stays visible. A test reads both straight out of SQLite.

The clamp is logged as `SELL_CLAMPED`, a new `GuardNotice` — deliberately **not**
a `GuardCode`. That type is the set of reasons an intent did not execute and
Prompt 12 counts it; this one executed, and filing it there would inflate the
refusal count with a success.

## Fix 2 — the ledger stops swallowing

`INSERT OR IGNORE` → `INSERT … ON CONFLICT(id) DO NOTHING`, on both `intents` and
`fills`.

The idempotency needed is narrow: the tracker writes an intent and the broker
writes it again defensively, and a fill is re-recorded after a crash-retry. `OR
IGNORE` bought that by suppressing **every** constraint failure. Targeting the
conflict at `id` keeps the retry-safety and lets NOT NULL and CHECK do their
jobs. Three tests: a NOT NULL violation throws, a CHECK violation throws, and a
genuine primary-key conflict is still ignored without resetting a resolved row.

### Persistence is now the precondition for emission

`Tracker.submit` verifies by **reading the row back**, not by trusting that the
write did not throw — the measured failure was a write that returned normally and
stored nothing.

- After `recordIntent`: `getIntentStatus(id)` must be defined, or the intent is
  resolved `rejected` with `LEDGER_WRITE_FAILED` and that rejection is emitted
  instead of `intent-created`.
- After `broker.execute` returns: the fill must be findable in
  `getFillsForIntent(id)`, or the same, instead of `fill`.

`LEDGER_WRITE_FAILED` is deliberately not a `GuardCode`. Nothing was refused on
its merits; the intent may have been perfectly good and the storage underneath it
was not, and an operator seeing a run of these should be looking at the disk
rather than at the market.

## Fix 3 — `PositionState.closing` is deleted

Chosen over implementing it, for three reasons in the order they decided it:

1. **It is not derivable from fills.** `ledger.ts` rule 2 is that positions are
   derived, never asserted — that is what makes a position disagreeing with the
   fills impossible by construction. "A sell is in flight" is not a fact about
   any fill, so persisting it would have to be an assertion, and the first
   assertion is the one that ends the guarantee.
2. **A crash would strand it.** In-flight is per-process runtime state; the
   positions table is durable. A process dying between setting `closing` and
   clearing it leaves a holding that reads as un-exitable forever, with nothing
   running to fix it. That is the failure this codebase is arranged to prevent,
   introduced by a field meant to help.
3. **The information already exists, authoritatively.** `guards.ts` holds
   `sellsInFlight` and enforces it synchronously before any await. A persisted
   flag would be strictly weaker — stale by the time it was read — and would
   invite the assumption that checking it is sufficient.

It would also have needed a `positions.state` CHECK change, hence a schema
version bump, hence refusing to open every existing ledger file — for a column
that duplicates something the guard layer already knows better.

Done completely: removed from `types.ts` (with the reasoning in place), from
Mirror's branch, from `Context`'s documentation and Equation's read-list, and the
`ledger.ts` comment that promised it now says what actually happens. The type
change caught four test sites; each was rewritten to the situation it was really
describing, with the old form and its date in a comment. `mirror.ts` now says
what actually prevents a buy-back during an exit: `SELL_IN_FLIGHT` and
`ALREADY_HOLDING`, both claimed before any await.

## What the conservation property caught that the matrix missed

**The SOL identity caught nothing, and could not have.**

`balance - Σ(lamportsDelta) + Σ(fees) == paperStartingSol` holds *by
construction*: `getBalanceLamports` is computed from `SUM(lamports_delta -
fees_lamports)` over the same rows the property sums. It is a tautology over the
fills table. It would catch a future balance implementation that drifted from the
fills — worth having for that — but on 2026-08-03 the oversell wrote a fill row
crediting 0.997 SOL for tokens never held, the balance moved to match, and this
identity was satisfied throughout.

**Token conservation is the property that catches it**, and it is the one the
brief did not name:

```
for each mint: running Σ(tokensDelta) never goes negative,
               and the final total equals position.tokens
```

Tokens are the independent check because nothing derives them from the same
place. Under the pre-fix behaviour the running total went to
`-999,998,999,999` on the oversell; the position still read `0` because the
replay clamped, which is exactly why the defect was invisible for a prompt.

Two more properties, both green and both trivially false before this prompt:
every `fill` event has a `fills` row, and every `intent-created` has an `intents`
row. Generated from the malformed matrix interleaved with well-formed intents,
not from well-formed ones alone — a system that conserves value only when used
correctly is not conserving value.

## Mutation results — whole files, not just the new lines

33 mutations across `guards.ts`, `ledger.ts` and the tracker's new precondition.
**32 killed, 1 survivor, and the survivor is a real finding.**

Highlights, and what the whole-file sweep turned up beyond the new code:

| Mutation | Killed by |
| --- | --- |
| gate 0 removed / buys-only / moved after the in-flight claim | 13, 13, 12 |
| zero allowed · NaN allowed · mint unchecked | 5 · 9 · 5 |
| clamp removed · clamp rejects instead · clamp always applied | 4 · 4 · 7 |
| `ON CONFLICT` reverted to `OR IGNORE` (intents · fills) | 25 · 5 |
| `INSERT OR REPLACE` on intents · on fills | 2 · 2 |
| replay tie-break back to `id` | 3 |
| ledger's own oversell clamp removed | 1 |
| emit without an intents row · without a fills row | 1 · 1 |
| gas reserve inverted · orphan gate off · kill switch off · canSell ignored | 37 · 6 · 8 · 7 |

Six survived the first sweep. Five were genuine test gaps and are now closed:

- **empty mint** and **absent amount** were each caught only *incidentally* by
  the next check down, so removing them changed nothing observable. Fixed by
  asserting the reason **text**: three different mistakes that all end in
  `MALFORMED_INTENT` must not read identically, or the message is noise and the
  code is the only information.
- **`isLive` ignoring `tokens`** — pre-existing, not introduced here. The
  ledger's own invariant makes state and tokens agree, so the check is belt and
  braces; the belt is what stops a hand-built or future `{state:'open',
  tokens:0n}` occupying a concurrency slot forever. Now pinned from both sides.
- **`INSERT OR REPLACE` on `fills`** — a real gap. A crash-retry would have
  *rewritten* the recorded `at`, which decides the UTC day a realized P&L lands
  in and is the primary sort key of the projection replay. Nothing tested it.
  (My first attempt at this mutation was invalid — leaving the `ON CONFLICT`
  clause in place makes `OR REPLACE` a no-op, since the clause wins. Re-run
  properly, it survived.)
- **the ledger's own oversell clamp** — now unreachable through `execute`,
  because guards clamps upstream. It is still the ledger's `tokens >= 0n`
  invariant against any other write path (an orphan acknowledgement, a future
  live broker, a repair script), and is now tested directly.

**One genuine survivor, reported rather than papered over:**
`if (tokens === 0n) costLamports = 0n;` in `replayMint` is dead code. At a full
exit `sold === tokens`, so `relieved = costLamports * tokens / tokens` is exactly
`costLamports` and the subtraction already lands on zero; floor-division
remainders only arise on partial sells, where `tokens !== 0n`. It is harmless
defensive code and was left alone — the freeze is lifted for two defects, and
deleting a line because a mutation survived is a refactor.

## Notes for whatever consumes this

- `malformedIntentReason` is the single definition of "is this an instruction".
  Any new execution entry point must call it, and calling it is cheap: pure,
  synchronous, no I/O.
- A malformed intent has **no ledger row** by design. If Prompt 12 wants to count
  them, the source is the `rejection` event stream, not the `intents` table.
  Everything else that is refused does have a row.
- `SELL_CLAMPED` is a `GuardNotice`, not a `GuardCode`. Reports that count
  refusals must not include it.
- The oversell clamp reads `position.tokens` from `inner.getPositions()`, which
  is the ledger's projection. If the ledger and the chain disagree — the case
  this exists for — the clamp trusts the ledger. That is correct in paper mode,
  where the ledger *is* the world, and will need revisiting when a live broker
  can see a real balance.

## Not verified live

Unchanged and now three prompts old: there is no `.env` in this checkout, so no
provider credentials. `createTrackerRuntime()` was booted again after these core
changes — `Strategy "mirror" attached`, `mode=paper status=idle`, `/state`
served, clean SIGINT — but nothing past `POST /start` has ever run against a real
RPC, and no intent produced by a strategy has been executed against a real route.

Every measurement in this handoff is against the paper broker and the real
SQLite ledger, which is what the two defects lived in.
