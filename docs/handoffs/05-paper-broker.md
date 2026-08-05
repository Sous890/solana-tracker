# Handoff 05 — Paper broker

Files added: `src/core/quoteSource.ts`, `src/adapters/mintMetadata.ts`,
`src/adapters/paperBroker.ts`. 175 tests green, typecheck and build clean.

## Interfaces now exposed, and who implements them

**`QuoteSource`** (`src/core/quoteSource.ts`) — **Prompt 6 implements this.**
One method: `getQuote(request) => Promise<Quote | QuoteError>`. `Quote` is
imported from `core/types.ts`, not redefined. `QuoteError` is a returned value
carrying `NO_ROUTE | UPSTREAM_ERROR | TIMEOUT`; an absent route is a result, not
a rejection, so callers must handle it to compile. `isQuoteError()` narrows;
`QuoteUnavailableError` is provided for callers that need a `Quote` and must
throw.

**`DecimalsSource`** (`src/adapters/mintMetadata.ts`) — **Prompt 8's screener
implements this.** `lookup(mint) => Promise<number | undefined>`. Wrap it in
`createDecimalsResolver()` for caching. Today it is fed by
`fixtureDecimalsSource({ mint: decimals })`.

**`PaperBrokerDeps`** — everything injected, no module-level state, no network
client. `latencyMs`, `now` and `sleep` are injectable so the suite runs without
a 400ms wait per fill.

## Decisions this prompt did not specify

- **Compute budget.** `computeUnitLimit` added to config, default 400,000.
  `txFeeLamports = ceil(priorityFeeMicroLamports × computeUnitLimit / 1e6) +
  5000`. At defaults that is **85,000 lamports per side**. This is the second
  recalibration knob alongside the penalty: the live broker should set the CU
  limit explicitly from simulation, and paper should then track whatever it
  sets.
- **Route fees are not subtracted.** `Quote.outAmount` is treated as already net
  of per-hop AMM fees (Jupiter v6 semantics). Subtracting `routePlan[].feeAmount`
  on top would double count and bias paper P&L pessimistic in a direction live
  fills could never correct. **If Prompt 6's adapter returns a gross
  `outAmount`, this is wrong — say so and it gets revised.**
- **Slippage is measured, not restated.** `Fill.slippageBps` is computed from the
  two integers, `(quoted − received) × 10000 / quoted`. It comes out at or just
  above the configured penalty because flooring the received side makes the
  realized shortfall marginally worse than the knob — which is the rounding rule
  working.
- **`recordIntent` is now `INSERT OR IGNORE`,** not `OR REPLACE`. An intent id is
  immutable and two layers legitimately write it. `REPLACE` would reset an
  already-resolved row to `pending`, which the next reconcile would report as a
  crash orphan that never happened.
- **`emergencyExitAll` attempts every position** even after one fails, then
  throws `EmergencyExitIncompleteError` carrying the fills that landed and the
  mints that did not. One unroutable mint must not trap the rest of the book,
  and a position that could not be exited is the single most important thing to
  surface.
- **`getNetLamportsFlow({ simulated })`** added to the ledger. Summed as
  integers in SQLite, returned as a bigint, filtered by `simulated` so a live
  fill can never move the paper wallet.
- **`ceilDiv`, `reduceByBpsFloor`, `shortfallBps`, `WRAPPED_SOL_MINT`,
  `SOL_DECIMALS`** added to `core/units.ts`, which owns conversions.

## What contradicted the prompt

Six things, all confirmed against the code before writing anything:

1. **`getBalanceSol()` does not exist** — the Broker method is
   `getBalanceLamports(): Promise<Lamports>`, renamed in the bigint conversion.
2. **`priorityFeeMicroLamports` is per compute unit,** not a flat lamport
   amount, so "priority fee (config, lamports)" had no defined value. Resolved
   by adding `computeUnitLimit`.
3. **Nothing called `ledger.recordIntent`** — there was no existing path to
   route through. The broker is the first writer.
4. **`canSell` failing closed blocks every buy through guards,** so round-trip
   tests drive the broker directly.
5. **No ledger accessor existed for a paper balance** — added.
6. **`RouteStep.feeAmount` is ambiguously denominated,** which is what led to the
   "outAmount is already net" decision above.

## What Prompt 6 must know

Implement `QuoteSource` from `src/core/quoteSource.ts` and nothing else — the
paper broker depends only on that interface and must not change when a real
client lands. Return `{ error: 'NO_ROUTE', message }` rather than throwing when
Jupiter reports no route, map timeouts to `TIMEOUT` and everything else to
`UPSTREAM_ERROR`, and populate `Quote.outAmount` as a `bigint` of `outMint` base
units **net of route fees**; if the API you use returns it gross, flag that
before wiring it up, because the paper cost model assumes net and would
double-charge. `inAmount`/`outAmount` must be parsed from the API's decimal
strings straight to `BigInt` with no `Number()` in between. The adapter also
needs to decide whether an integrator `platformFee` exists — `Quote` currently
has no field for it, so surfacing one requires a `core/types.ts` change, which
is frozen and needs sign-off.

## Still stubbed, and how it fails

| Stub | Location | Fails |
| --- | --- | --- |
| `canSell()` | `paperBroker.ts` | **Closed.** Returns `{ ok: false, reason: 'SCREENER_NOT_IMPLEMENTED' }`, so the guard layer's gate 7 rejects every buy with `CANNOT_SELL`. **The paper broker cannot complete a buy end-to-end until Prompt 8 lands.** That is intended: the bot must not enter a position nothing has confirmed it can leave. |
| Decimals lookup | `mintMetadata.ts` | **Closed.** Unknown mint raises `UnknownMintError`; there is no default of 9. |

`tests/paperBroker.test.ts` carries a test named
`TRIPWIRE: still the stub — delete this test when the screener lands`. It exists
so the stub cannot be silently replaced by something that fails open; whoever
lands Prompt 8 has to delete it deliberately.

## Mutation results

Reported as asked, including the one that initially came out badly.

| Mutation | Result |
| --- | --- |
| Flip the penalty sign (`10000 − bps` → `10000 + bps`) | **Killed**, 6 tests |
| Change the default penalty 30 → 300 | **Survived all but 2** on the first run — and both survivors only caught it incidentally, by hardcoding `9970` in decimals tests. Every dedicated cost-model test passed the penalty explicitly, so the *default* was unasserted. Added `defaults to a 30 bps penalty and applies exactly that` plus the equivalent for `computeUnitLimit`. **Now killed, 3 tests, one of them for the right reason.** |
| Floor → ceil on the received side | **Killed**, 7 tests |

The second row is the useful one: the suite was asserting the shape of the cost
model while leaving its default magnitude free to drift.
