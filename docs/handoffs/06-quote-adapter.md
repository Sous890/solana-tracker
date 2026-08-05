# Handoff 06 — Jupiter quote adapter

Files added: `src/adapters/jupiter.ts`, `src/adapters/mintInfo.ts`,
`scripts/record-fixtures.ts`, `tests/setup.ts`, recorded fixtures under
`tests/fixtures/jupiter/`, labelled synthetics under `tests/fixtures/synthetic/`.
250 tests green, typecheck and build clean.

## The endpoint actually found live

`https://lite-api.jup.ag/swap/v1/quote` — path and parameter names as specified,
no drift. Verified by calling it while writing this.

Three things the live API contradicted or added:

- **`restrictIntermediateTokens=false` is rejected on the free tier**:
  `{"error":"Setting restrict_intermediate_tokens to false is not supported for
  free tier users","errorCode":"NOT_SUPPORTED"}`, HTTP 400. The config flag
  exists, but **the Prompt 12 harness cannot A/B it without `JUPITER_API_KEY`**.
  Recorded as `error-not-supported-restrict-false.json` so the
  `NOT_SUPPORTED → UPSTREAM_ERROR` mapping is pinned to a real body.
- **Two distinct no-route codes**, both captured, both mapped to `NO_ROUTE`:
  `NO_ROUTES_FOUND` (a real mint with no route at that size) and
  `TOKEN_NOT_TRADABLE` (not a tradable token at all). Matched on `errorCode`,
  never on message text.
- **`swapInfo` no longer carries `feeAmount`/`feeMint`** — absent from both the
  live response and the current swagger.

Amounts are JSON **strings** (`"outAmount":"258472072271"`), confirmed from raw
bytes. `slippageBps` and `contextSlot` are bare numbers.

## The priceImpactPct unit decision

The prompt's conversion table was anchored one stage too late and would have
been a **100× error**. `Quote.priceImpactPct` is documented as a *percent*
(`types.ts:93`) and `guards.ts:282` recovers bps with `percent * 100`. Writing
bps into that field means guards multiplies again, and every quote trips
`PRICE_IMPACT_EXCEEDED` — safe direction, but the bot never trades.

Resolved as two pinned stages:

```
"0.0000358961947259951525246234"   API: decimal fraction string, up to 28 places
        -> fractionStringToBps()   exact string math, rounded AWAY from zero
   1 bps                           the prompt's table lives here
        -> bpsToPercent()          / 100
   0.01 percent                    what the frozen field holds
        -> guards.ts * 100
   1 bps                           the decision
```

The conversion is exact string arithmetic — no `Number` on the path — because
the API returns 28 decimal places and `Number(...) * 10000` is not the value we
want to round.

**On the float residue you raised:** `bps / 100 * 100` is not identity in
IEEE754. The residue is ~1e-13 against 1 bps of granularity, so it cannot move a
decision across an integer threshold, and at exactly the limit `>` already
permits. Asserted, not argued: a test walks 295→305 bps at a 300 bps limit
through the full `string → bps → percent → guards` path and pins the
accept/reject decision at every step, plus `|recovered − true| < 1e-9`.

## What closing (a)/(b)/(c) changed in paperBroker

- **(a)** The hedged comment is gone. It now states that `outAmount` is net of
  route fees, cites the live verification, and points at the `ROUTE_FEE_PRESENT`
  anomaly that fires if one ever reappears. **The invariant test uses a better
  rule than the prompt specified**: `outAmount == sum(legs where
  swapInfo.outputMint == outputMint)`, not "the final hop's outAmount". The
  recorded `quote-high-impact-thin` fixture is 4 hops of which only 3 produce
  the output mint — a split with one two-hop branch — where the final-hop rule
  is simply wrong. The sum rule holds on all three recorded shapes.
- **(b)** No change to paperBroker. Under the anomaly rule a platform fee is
  counted, logged, and the quote returned.
- **(c)** No change to paperBroker; it already refused to default. `mintInfo.ts`
  now supplies decimals through the *existing* `createDecimalsResolver`.

## The anomaly rule

Nothing about an odd route shape may withhold a quote — sells need quotes, and
an adapter that refuses one is a path to a stranded position. So each of these
logs at error, increments a counter, and returns the quote anyway:

`PLATFORM_FEE_PRESENT`, `ROUTE_FEE_PRESENT`, `OUT_AMOUNT_MISMATCH`,
`ROUTE_PERCENT_MISSING`, `PRICE_IMPACT_UNPARSEABLE`.

Exposed via `anomalyStats()` beside `cacheStats()` for the Prompt 12 harness.

The one asymmetry: an unparseable `priceImpactPct` becomes **100 percent**, not
0. That blocks entries at the guard layer while leaving exits — which never
check impact — fully available. Failing safe in the direction that still lets
you out.

`label` and `percent` were called out specifically. **`label` is cosmetic**:
falls back to `'unknown'`, no anomaly, nothing computes on it. **`percent` is
not actually load-bearing for the out-amount invariant** — that rule sums by
output mint and is percent-free by construction, which is why it survives
sequential, split and mixed routes alike. `percent` is needed only to populate
the frozen `RouteStep.percent`; it falls back to `bps / 100`, then to `0` with
`ROUTE_PERCENT_MISSING`.

## What Prompt 8 inherits from mintInfo.ts

`readMintInfo(mint) → { mint, decimals, supply, mintAuthority, freezeAuthority,
programId, isInitialized }`, decoded from the 82-byte base Mint layout, which
Token-2022 shares (extensions follow it and are ignored). `programId` comes from
the account owner, so Token-2022 mints are distinguishable —
`TOKEN_2022_PROGRAM_ID` is exported.

**`readMintInfo` always hits RPC. Do not add a cache to it.** `mintAuthority`
and `freezeAuthority` are revocable, and they are exactly what a honeypot check
turns on; a stale "authority revoked" is worse than no answer. A test asserts
three reads make three RPC calls. Decimals *are* cached, but by
`createDecimalsResolver` in `mintMetadata.ts` — use `client.decimalsSource()`
rather than forking a second cache. Failures are deliberately not cached, so a
transient outage does not poison a mint for the process lifetime.

`encodeBase58` is exported and had a real bug caught by test: the digit
accumulator seeded at `[0]` emitted one spurious leading `'1'`, which would
corrupt any pubkey starting with a zero byte. Values are now cross-checked
against an independent decoder (USDC's real authorities are pinned literally,
not by regex).

## Fixtures

Recorded (`tests/fixtures/jupiter/`): single-hop, split route, high-impact
mixed route, both no-route errors, the free-tier `NOT_SUPPORTED` body, and one
mint account each for SPL (USDC) and Token-2022 (PYUSD).

Synthetic (`tests/fixtures/synthetic/`, with a README stating why):

- **429** — provoking a real one means hammering a public API. Not done.
- **`outAmount` > 2^53** — hunted for and not found. pump.fun-style 6-decimal
  mints carry 1e9 supply = 1e15 base units *in total*, structurally below 2^53,
  and their pools saturate (1000 SOL and 3000 SOL probes against the same mint
  returned an identical `outAmount`). The regime that exceeds 2^53 is a
  9-decimal mint under ~1.1e-8 SOL. The fixture uses `10000000000000001`,
  chosen so `Number()` visibly drops the trailing 1.

`tests/setup.ts` replaces global `fetch` with a rejecting stub, so any
un-mocked call fails loudly and names the URL. It rejects rather than throwing
synchronously, matching real `fetch` semantics.

## Mutation results

All five specified mutations were killed. Three died to a single test each, so
I probed two further encodings of the same conversion factor to check the kills
weren't accidental.

| # | Mutation | Result |
| --- | --- | --- |
| 1 | conversion factor 10000 → 100 | killed, 1 test |
| 1b | *the other encoding*: 4-digit decimal shift → 2-digit | killed, 6 tests |
| 1c | `bpsToPercent` divides by 1 instead of 100 | killed, 7 tests |
| 2 | away-from-zero → toward-zero rounding | killed, 7 tests |
| 3 | cache TTL 1500 → 15000 | killed, 1 test (the 1499/1501 boundary — precisely targeted) |
| 4 | NO_ROUTE mapped to QuoteError | killed, 6 tests |
| 5 | `BigInt(s)` → `Number(s)` on outAmount | killed, 1 test (the >2^53 fixture — the only place it can be caught) |

Mutation 1 is worth a note: the scaling factor is encoded in *two* places — the
whole-number multiplier and the decimal-shift width — and mutating only the
first is caught by a single case. 1b mutates the more dangerous half.
