# Synthetic fixtures

**Nothing in this directory was observed.** Every file here is hand-authored,
and each says why it could not be captured. Recorded responses live in
`tests/fixtures/jupiter/` — never mix the two.

- `quote-outamount-over-2p53.json` — no live mint produced one. pump.fun-style
  6-decimal mints hold 1e9 supply = 1e15 base units *in total*, structurally
  below 2^53, and their pools saturate (probing 1000 and 3000 SOL against the
  same mint returned an identical `outAmount`). Reaching 2^53 needs a
  9-decimal mint priced under ~1.1e-8 SOL. The value here is the boundary this
  parser must survive, not a market observation.
- `error-429-rate-limited.json` — provoking a real 429 means hammering a public
  API. Not done.

## Prompt 7 — wallet stream and swap parser

Each of these is a real capture with named edits, listed in the file's own
`edits` field alongside `derivedFrom` and `whyNotReal`. Generated
mechanically, not by hand.

- `split-token-accounts.json` — one mint held across two token accounts. No
  captured transaction had this; it is uncommon in a single sample and is
  exactly what the summing invariant exists for. The file records what a
  largest-account-only reading would have returned, so the test can assert
  that answer would have been wrong.
- `multi-mint-delta.json` — two non-WSOL mints moving for one wallet, to pin
  `MULTI_MINT_DELTA`.
- `both-sol-paths-agree.json` / `both-sol-paths-disagree.json` — no captured
  transaction had a nonzero WSOL delta *and* a nonzero corrected lamport
  delta, so the cross-path agreement check had nothing real to run against.
  The WSOL balance is added at the same index in both pre and post, leaving
  created/closed counts and therefore the lamport path untouched.

Real captures, including the two hard cases, live in
`tests/fixtures/transactions/`:

- `wallet-key-from-lookup-table.json` — **real**. The tracked address's key is
  at index 37 of 57, inside the lookup-table portion. Note the address is a
  market-maker account rather than a retail wallet; it exercises the index
  path identically.
- `lookup-table-json-encoding.json` — **real**. The same transaction captured
  with `encoding=json`, where `accountKeys` holds only the 7 static keys and
  `loadedAddresses` carries the other 50. This is the fixture that exercises
  the concatenation; the `jsonParsed` captures cannot, because the RPC has
  already merged them.
- `meteora-dlmm-buy.json` — **real**. The wallet's WSOL account is closed
  in-transaction, refunding rent. Its raw lamport delta is +2,033,621 on what
  is actually a 657-lamport purchase.
