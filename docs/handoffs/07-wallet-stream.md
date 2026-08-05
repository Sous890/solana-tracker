# Handoff 07 — Wallet stream and swap parser

Files added: `src/adapters/swapParser.ts`, `src/adapters/walletStream.ts`,
`src/db/cursors.ts`, `scripts/record-transactions.ts`, seven real captures in
`tests/fixtures/transactions/`, five labelled synthetics. `TrackedSwap` and
`SwapVenue` appended to `core/types.ts`; nothing else in `core/` touched.
301 tests green, typecheck and build clean.

## The invariant as stated, and three amendments reality forced

The delta rule itself held exactly as written and needed no change:

> `tokenDelta(mint)` = sum over **all** token accounts owned by W with that
> mint of `post - pre`. Exactly one non-WSOL mint with a nonzero delta is a
> swap; zero or two or more is not, and is never resolved by picking the
> largest.

The `solAmount` derivation needed three corrections, each found against a real
capture.

**1. `meta.fee` must be added back, not subtracted.** `postBalances` is already
net of the fee, so `post - pre` has the fee baked in. Recovering the trade flow
means removing that effect — `+fee` — where the brief said subtract, which
double-counts it.

**2. Rent refunded by accounts closed in-transaction must be subtracted.** The
brief handles only the created direction. `meteora-dlmm-buy.json` is a real
capture where the wallet's WSOL account is closed inside the transaction:

```
raw lamport delta      +2,033,621   (looks like 2.03 SOL RECEIVED)
brief's formula        +2,028,619   (delta - fee)
correct                   -657      (delta + fee - rentRefund) — 657 lamports SPENT
```

Wrong sign, and 3,088× the magnitude, on an ordinary Meteora buy.

**3. Path 1 must not be negated.** The brief says "use the negated WSOL
tokenDelta". A buy *drains* the wallet's WSOL, so the raw delta is already
negative-for-spent — the same convention as the lamport path. Negating inverts
path 1 against path 2. This is invisible in `solAmount`, which is a magnitude
with `side` carrying direction, but it makes every cross-path comparison read
as a 200% disagreement, i.e. the disagreement check would have been useless.

Final formula, both paths on one sign convention (negative = wallet spent):

```
path 1  wsolTokenDelta
path 2  (post - pre) + (isFeePayer ? fee : 0)
                     + created * RENT
                     - closed  * RENT
```

Path 1 wins when nonzero; a >0.5% gap is recorded on the result as
`pathDisagreement` rather than swallowed.

## What the live RPC told us that the brief got wrong

**`jsonParsed` already merges lookup-table keys; concatenating doubles them.**
The brief says to concatenate `accountKeys ++ loadedAddresses.writable ++
readonly` and types the input as `ParsedTransactionWithMeta`, which implies
`jsonParsed`. Measured on a live v0 transaction:

```
json:       accountKeys=15  loadedAddresses w=19 r=19   preBalances=53
jsonParsed: accountKeys=53  sources={transaction:15, lookupTable:38}
            loadedAddresses=ABSENT
concat(json) === jsonParsed order?  true
```

So the rule is right for `encoding=json` and actively harmful for
`jsonParsed`. `accountKeyList()` detects which shape it has (string elements
vs objects), assembles accordingly, and — the real safety net — returns
`undefined` unless the assembled list length equals `meta.preBalances.length`.
That check catches either mistake instead of silently mis-attributing
balances.

Both encodings are captured for the same transaction so both paths are tested:
`lookup-table-json-encoding.json` (7 static + 50 loaded = 57) and
`wallet-key-from-lookup-table.json` (57 pre-merged).

Two smaller notes: `getSignaturesForAddress` returns `transactionIndex`, which
is what the ordering uses; and `ParsedTransactionWithMeta` does not exist here,
since `@solana/web3.js` is not a dependency — the wire shapes are declared
structurally in `swapParser.ts`.

`encodeBase58` from `mintInfo.ts` turned out **not to be needed**: every
account key and owner arrives from the RPC already base58-encoded. It was not
re-implemented, and it was not imported for the sake of it.

## Fixtures: real vs synthetic

**Real** (`tests/fixtures/transactions/`, captured by
`scripts/record-transactions.ts`, expectations cross-checked by an independent
Python decode committed as `EXPECTED.json`):

| Fixture | Why it matters |
| --- | --- |
| `raydium-v4-buy` | venue, fee payer, lamport path |
| `raydium-clmm-buy` | venue, 41 lookup-table keys |
| `pumpfun-sell` | the sell direction |
| `whirlpool-buy` | venue |
| `meteora-dlmm-buy` | **WSOL account closed in-tx** — the rent-refund case |
| `failed-swap` | `meta.err != null` with all-zero deltas |
| `wallet-key-from-lookup-table` | **real** — tracked key at index 37 of 57, inside the lookup-table portion |
| `lookup-table-json-encoding` | same tx under `encoding=json`, the concatenation path |

Both hard cases the brief expected to need synthesising were found for real.
One caveat stated plainly: the address in `wallet-key-from-lookup-table` is a
market-maker account rather than a retail wallet. It exercises the index path
identically, but it is not a copy-trade target.

**Synthetic** (`tests/fixtures/synthetic/`, each carrying `derivedFrom`,
`whyNotReal` and a literal `edits` list; generated mechanically):

- `split-token-accounts` — one mint across two accounts. Not present in any
  capture; it is uncommon per-transaction and is the whole point of summing.
  Records `largestAccountOnlyWouldGive: 400000000000` against the true
  `460106833473`, so the test asserts the shortcut answer would be wrong.
- `multi-mint-delta` — pins `MULTI_MINT_DELTA`.
- `both-sol-paths-agree` / `-disagree` — no capture had both paths nonzero, so
  the agreement check had nothing real to run against.
- `non-fee-payer-lamport-path` — hand-authored. Added *because of* a weak
  mutation result; see below.

## Confirmed commitment: reorg exposure

`logsSubscribe` runs at `confirmed`. A confirmed slot can still be rolled back,
and this module does **not** retract an emitted swap. That is deliberate:
waiting for `finalized` costs roughly 13 seconds, which is an eternity for a
copy-trade signal.

The consequence must be respected downstream: **a `swap` event is provisional
and is about someone else's wallet.** It is a hint, never a record. The ledger
remains the sole authority on what this bot holds, and nothing in Prompt 9
should write a position from a stream event without its own fill.

## What the rent constant assumes, and how it breaks

`SPL_TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280` is the rent-exempt minimum for a
**165-byte classic SPL Token account**. It is exact for that layout and is the
weakest number in the parser.

A Token-2022 account carrying extensions (transfer fees, transfer hooks,
confidential transfers, metadata pointers) is larger, so its rent is higher —
often materially. Creating or closing one under-corrects path 2 by the
difference, and the parser has no way to know the extension set from
transaction meta alone.

Three mitigations, in order of strength: path 1 is immune and is preferred; the
0.5% cross-path check surfaces the error whenever both paths are computable;
and the constant is a single named export, so a size-aware version is a local
change. The parser accepts Token-2022 balances everywhere else — `programId` is
not filtered — so only this arithmetic is affected.

## Mutation results

| # | Mutation | Killed by |
| --- | --- | --- |
| 1 | `tokenDelta` uses only the first matching account | **19 tests** |
| 2 | key list omits `loadedAddresses` | **2 tests** — both in the `json`-encoding fixture, which is the only thing that can catch it; the `jsonParsed` captures are unaffected by construction |
| 3 | `meta.fee` applied unconditionally | **1 test, then 2** — see below |
| 4 | `MULTI_MINT_DELTA` picks the largest | **1 test, then 4** — see below |
| 5 | gap fill uses `before:` instead of `until:` | **4 tests** |

Two mutations died to a single test each, and probing both was worthwhile:

**Mutation 3** was killed only by *"reports no path disagreement"* — an
indirect catch, not an assertion about `solAmount`. The cause: no fixture was
both non-fee-payer *and* resolved through the lamport path (the one real
non-fee-payer capture holds WSOL and takes path 1). So the fee rule's actual
output was unasserted. Added `non-fee-payer-lamport-path`, a hand-authored
transaction that also creates a token account, pinning
`-(250000000+2039280) + 0 fee + 2039280 rent = -250000000` and explicitly
rejecting both `249995000` (fee wrongly applied) and `252039280` (rent
ignored). Now killed by 2, one of them directly.

**Mutation 4** was killed only by the single `MULTI_MINT_DELTA` test. The kill
was genuine, not accidental, but thin for a rule whose purpose is refusing to
guess. Added three cases: two mints where the impostor dwarfs the real one, two
where the real one is largest (so ordering would accidentally be *right* — and
must still refuse), and three mints. Now killed by 4.

## Notes for whatever consumes this

- `wallet_cursors` lives in `src/db/cursors.ts` with its own connection to the
  same SQLite file, because this prompt forbade touching `ledger.ts`. It is
  independent of the ledger's schema-version gate, which keys off the `fills`
  table. If the two ever want one connection, that is a deliberate merge, not
  a bug.
- The cursor advances **after** a successful emit. A crash between receipt and
  emit re-delivers; it never skips.
- Backpressure drops the **oldest** pending entry and emits `error` with a
  `dropped` count. A stale swap signal is worthless; an unbounded queue during
  a burst is worse.
- `blockTime` is carried through as nullable **unix seconds**, not the
  project's `UnixMillis`. Ordering uses `(slot, transactionIndex)` only.
