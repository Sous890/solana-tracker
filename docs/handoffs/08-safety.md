# Handoff 08 — Safety screener

Files added: `src/adapters/safety.ts`, `scripts/record-mints.ts`,
`tests/safety.test.ts`, six real mint captures in `tests/fixtures/mints/` with
an independently decoded `EXPECTED.json`. `paperBroker.ts` gained an injectable
`canSell`; the Prompt 5 tripwire test was deleted, deliberately, as it
instructed. **`guards.ts` is unchanged.** 371 tests green, typecheck and build
clean.

## Surface

```ts
screenMint(mint, { sizeSol })        -> Promise<ScreenResult>
screenHeldPosition(mint, { sizeSol })-> Promise<ScreenResult>  // alerting only
canSellFromScreener(screener, opts)  -> Broker['canSell']

ScreenResult = { verdict: 'pass' | 'fail' | 'unknown',
                 failedChecks: string[], unknownChecks: string[],
                 details: Record<string, unknown>, screenedAt: number }
```

Three verdicts, not two. `fail` means a check ran and the token is bad;
`unknown` means a check could not run. Both refuse a buy, but they carry
different reasons — `SCREEN_FAILED:<codes>` versus `SCREEN_UNKNOWN:<codes>` —
so an adversarial market and a broken data provider stay distinguishable in
logs and in the ledger's `rejection_code`.

Ports are injected: `SafetyRpc` (parsed mint account, signatures, epoch),
`QuoteSource` (reused unchanged from Prompt 6), `DexScreenerClient`, plus
clock, sleep and logger. No network client is constructed inside the module.

Checks run cheapest-first and short-circuit on the first hard fail —
deliberately not the brief's 1–5 numbering. The reverse quote is two network
round trips and runs **last**, after one RPC call for the mint account, a free
read of the extensions already in that response, one RPC call for age, and one
HTTP call for liquidity.

Caching: keyed on `mint|sizeSol`, `pass` and `fail` for 60s, `unknown` never.
Single-flight per key, concurrency capped at 3, and a 250ms floor between
DexScreener calls holds the module to 240 req/min against their published 300.

## What the RPC and Jupiter actually returned vs what the brief assumed

### `guards.ts` did not need wiring

The brief says to wire the screener into `guards.ts`. It was already wired:
`guards.ts:293` calls `inner.canSell(intent.mint)` inside `guardBuy` at gate 7,
and the sell path never touches it. The seam is the broker's stub, which now
takes an injected implementation and still defaults to fail-closed. Editing a
frozen file would have added a second call site for no behavioural gain — and
mutation 5 shows exactly what that costs.

### A full signature page does **not** establish mint age

The brief: *"If a full page comes back, the mint is older than the oldest
entry, which satisfies the floor without further paging."*

Measured otherwise. A live mint returned a **full 1,000-signature page spanning
0.4 minutes** — it is a hot mint, and 1,000 signatures is 24 seconds of its
history. A full page bounds age only from *below*. Treating it as clearing a
2-minute floor admits a 24-second-old mint, which is the thing the floor
exists to stop.

Implemented: a **short** page means the oldest entry really is the first
signature, giving exact age. A **full** page is conclusive only when its own
oldest entry already clears the floor; otherwise it pages back, to a cap of
four pages, then returns `unknown`.

### `priceImpactPct` is not a usable honeypot signal

Measured across live routes at 0.05 SOL:

| mint | fwd impact | rev impact | round-trip retention |
| --- | --- | --- | --- |
| USDC | 0.000061 | **0** | 1.0000 |
| BONK | 0.000831 | 0.000105 | 0.9990 |
| JUP | **0** | 0.000404 | 0.9996 |
| PYUSD (Token-2022) | 0.000082 | 0.000011 | 0.9999 |
| pump.fun, fresh | 0.023619 | 0.005590 | 0.9730 |
| pump.fun, fresh | **0** | 0.022956 | 0.9640 |
| unroutable | — no quote at all — | | |

Jupiter reported impact of exactly **0 on 3 of 7 real routes**, including one
whose reverse leg simultaneously reported 2.3%. It cannot separate anything.

Round-trip retention separated the sample cleanly and monotonically, so it is
**primary**, at a floor of **0.80** — far below the thinnest legitimate mint
measured (0.964) and far above a honeypot or an extractive fee. Retention
absorbs two price impacts and two sets of route fees, so it runs at roughly
twice the one-way cost; 0.80 is deliberately loose because this check catches
catastrophe, not slippage. `priceImpactPct` is kept as a secondary check at
2500 bps, where a spurious `0` can only cause a false pass, never a false fail.

### Checks 4 and 5 conflict, but not in the predicted way

The prediction was that a mint old enough to clear the age floor would not yet
be indexed by DexScreener, leaving liquidity permanently `unknown`.

Measured: DexScreener indexed **every** fresh pump.fun mint sampled — ages 1.2,
2.4, 4.0 and 9.4 minutes, one pair each. Indexing lag is not the problem.

The problem is one level down: every one of those pairs reported
**`liquidity.usd = 0`**. Pre-graduation pump.fun tokens trade on a bonding
curve, not an AMM pool, so there is no depth to report. Against a
`minLiquidityUsd` of 15,000 that is a hard **`fail`**, not `unknown` — worse
than predicted in that it is a confident wrong answer, better in that it is a
signal rather than silence.

I did not relax the floor. `minLiquidityUsd` is injected and applied as
written. The options, with costs:

- **Keep 15,000.** Pre-graduation mints never pass. Correct if the strategy
  buys graduated tokens; disables the bot entirely if it snipes launches.
- **Use Jupiter route depth as the proxy** below some age. The round-trip check
  already exercises real routable depth at the real size, which measures what
  an exit can draw on better than a third party's USD figure. Cost: loses the
  independent second opinion, so one manipulated route fools both checks.
- **Widen the age floor** so only graduated tokens qualify. Cost: gives up the
  launch window, which is most of the edge.

Recommendation is the second, gated on age — but it is a strategy decision and
is not made in code.

### The Token-2022 extension list was incomplete

Confirmed against the extension guide rather than assumed. Sell-blocking, now
rejected:

| Extension | Why |
| --- | --- |
| `nonTransferable` | Blocks every transfer outright |
| `pausable` | **Not in the brief.** Aborts all transfers when the authority flips the flag |
| `defaultAccountState = frozen` | New accounts arrive frozen; a buyer cannot move what they buy |
| `permanentDelegate` | Does not block a transfer — lets the delegate take the position |
| `transferHook` with non-null `programId` | Arbitrary code on every transfer |
| `transferFeeConfig` above 500 bps | Extractive |

Rejected as **not** sell-blocking and deliberately allowed: `mintCloseAuthority`,
`interestBearingConfig`, `metadataPointer`, `groupPointer`,
`confidentialTransferMint`, `tokenMetadata`.

Two notes. `transferHook` exists with `programId: null` on benign mints —
PYUSD is one — so the extension's presence is not the signal, the program id
is. And **fresh pump.fun mints are now Token-2022**, carrying `metadataPointer`
and `tokenMetadata` with both authorities revoked, so this branch runs on the
target universe rather than only on exotic tokens.

### `transferFeeConfig` epoch selection, from source

```rust
pub fn get_epoch_fee(&self, epoch: u64) -> &TransferFee {
    if epoch >= self.newer_transfer_fee.epoch.into() { &self.newer_transfer_fee }
    else { &self.older_transfer_fee }
}
```

`newer` governs once its epoch arrives; `older` governs until then. The trap
the brief names is real — a fee scheduled for a future epoch sits in `newer`
while `older` still reads clean.

Implemented both: the governing fee per the source rule, and a *scheduled* fee
above the ceiling rejected separately as `T22_TRANSFER_FEE_SCHEDULED_HIGH`. An
epoch is roughly two days; a position held across the boundary pays the new
rate, so a scheduled 90% fee is a rug with a timer, not a clean token.

### A revoked authority is JSON `null` with the key present

Verified on three live mints. Not an absent key, not the string `"null"`. The
check is explicit rather than truthy — and probing that mutation found a real
defect in my own code; see below.

## Fixtures: real vs hand-authored

**Real captures** (`tests/fixtures/mints/`, via `scripts/record-mints.ts`,
stored as `jsonParsed` **and** `base64` plus the epoch at capture, replayed
through a fake RPC so a later authority revocation cannot change a test):

| Fixture | Proves |
| --- | --- |
| `clean-spl-bonk`, `clean-spl-jup` | both authorities revoked |
| `live-authorities-usdc` | live mint **and** freeze authority |
| `token2022-extensions-pyusd` | 8 real extensions, incl. `permanentDelegate`, `transferFeeConfig`, and `transferHook` with a null programId |
| `fresh-pump-mint` | a real Token-2022 pump.fun mint, both authorities revoked |
| `no-jupiter-route` | the real `TOKEN_NOT_TRADABLE` body |
| `dexscreener-deep-bonk` | a 30-pair token, for the sum-vs-deepest question |

**Hand-authored, and plainly so** — constructed `ParsedMintAccount` objects
inside `tests/safety.test.ts`, not files pretending to be captures: every
Token-2022 extension case (`nonTransferable`, `pausable`, `permanentDelegate`,
`defaultAccountState`, `transferHook` with a real programId, and all the
`transferFeeConfig` epoch permutations), the ten-decoy-pool liquidity array,
and the size-dependent quote stub.

**Not obtained, and not faked:**

- **A mint that routes in but not out** — the one the brief specifically asked
  for. Not found in the sampled window. Covered by a stubbed reverse
  `NO_ROUTE`, which is honest about being a stub.
- A Token-2022 mint with a **non-zero** transfer fee (PYUSD's is 0 bps).
- A Token-2022 mint with a **real** transfer hook programId.
- A mint with a live *freeze* authority but a revoked *mint* authority — USDC
  has both, which is what the fixture shows.

**The TLV cross-check found a real offset bug.** An independent Python decoder
first read the extension TLV from byte 83, immediately after the 82-byte base
Mint. Wrong: Token-2022 pads a mint to the 165-byte Account length, writes the
account-type byte at 165, and starts the TLV at 166. With the correction the
independent decode agrees with `jsonParsed` on all five mints, including
PYUSD's eight extensions and both epoch-keyed fee slots. This is precisely the
failure the brief predicted, and it is why the screener reads `jsonParsed` —
the RPC's own decoder — instead of parsing TLV itself.

## Liquidity: deepest pair, and the attack it does not stop

**Deepest single routable pair**, not the sum, restricted to pairs quoted in
SOL or USDC. Summing rewards an attacker for creating many shallow decoys and
counts pools Jupiter may never route through; a test pins this, with ten decoys
at $5,000 summing to $50,000 and passing a $15,000 floor while the
deepest-pair rule correctly fails.

**Still vulnerable to:** one genuinely deep pool Jupiter will not route
through — on an unsupported program, or one whose USD valuation DexScreener
derives from a manipulated quote-token price. That inflates a single pair,
which is exactly what this reads. The round-trip check is the backstop, since
it uses a real route at the real size; the liquidity floor is the cheap
pre-filter, not the authority.

## Mutation results — which tests kill which

| # | Mutation | Killed by |
| --- | --- | --- |
| 1 | authority check uses truthiness | `authorityIsLive > treats the STRING "null" as revoked, which truthiness would not` |
| 2 | `transferFeeConfig` reads the wrong epoch's fee | `governingTransferFee > uses newer when currentEpoch >= newer.epoch (the source rule)`; `> uses older when currentEpoch < newer.epoch, and reports the scheduled one`; `> is exact at the boundary epoch`; `transferFeeConfig epochs > reads the newer fee once its epoch has arrived`; `> reads the older fee while the newer one is still scheduled` |
| 3 | `unknown` verdicts cached like passes | `cache > NEVER caches an unknown`; `cache > lets a recovered provider through immediately, not after a stale minute` |
| 4 | cache key drops `sizeSol` | `cache > keys on size, so a verdict for one trade is not reused for another`; `cache > returns a DIFFERENT verdict for a size the mint cannot absorb` |
| 5 | a screener failure on the sell path blocks the sell | `canSell boundary > SELLS a held mint while the screener fails EVERY check` (asserts `canSell` was never called); `sells are never blocked by risk limits > never consults risk state on the sell path` (guards.test.ts) |

Three mutations initially died to a single test each and were probed.

**Mutation 1 exposed a defect in my own code.** Enumerating where truthiness
and the explicit test diverge gave `'null'`, `{}` and `[]`. On the object cases
my original `typeof value === 'string'` test returned **false — "revoked",
which admits the mint** — while the truthy mutant returned "live" and refused
it. My version was the *less* safe one on unexpected shapes. `authorityIsLive`
now treats only JSON `null` and an absent key as revoked, and anything
unrecognised as **live**, refusing the buy; four new cases pin it. The mutation
was worth more than the test it was meant to check.

**Mutation 3** was killed only by an assertion that two `unknown` screens make
two calls. Added the operational property: a provider that recovers must be
visible on the very next screen, not after a stale minute.

**Mutation 4** was killed only by a call-count assertion. Added a behavioural
one: a thin pool round-trips fine at 0.05 SOL and collapses at 5 SOL, so a
mint-only key would serve the small-size pass to the large-size question.

**Mutation 5** is killed by two direct assertions, as required — not
indirectly. `emergencyExitAll` survives this mutation *by design*, because it
bypasses the guard layer entirely; that path has its own test asserting it
completes while the screener throws on every call.

## A latent ordering hazard found in the ledger

Not fixed here — outside this module, and `ledger.ts` was not in scope — but it
should be addressed deliberately.

`rebuildProjections()` replays fills ordered by `(at, id)`. When two fills for
one mint share a millisecond the tie-break is **alphabetical intent id**, which
carries no causal meaning. My first version of the held-position test used a
constant clock, so a buy `seed:MINT` and a sell `exit:MINT` shared `at` and
replayed sell-first, leaving the position `open` after a completed exit.

In production `at` comes from a real clock and the bot cannot round-trip a mint
inside one millisecond, so this is latent rather than active. The fix is a
tie-break with causal meaning — SQLite `rowid`, i.e. insertion order — rather
than the primary key's alphabet.

## Notes for whatever consumes this

- `canSellFromScreener(screener, { sizeSol })` returns the `Broker['canSell']`
  shape and is injected via `PaperBrokerDeps.canSell`. Absent it, the broker
  still refuses every buy with `SCREENER_NOT_IMPLEMENTED` — the fail-closed
  default is unchanged, only now overridable.
- `screenHeldPosition()` emits `sellability-degraded` on a transition into
  `fail` or `unknown` for a mint already held. It creates no intent and blocks
  nothing. Strategy decides.
- The screener must never be consulted on a sell. Two tests enforce it and one
  mutation proves they bite; anything that adds a sell-path call site is a bug
  regardless of how sound the reasoning looks.
- `minLiquidityUsd` is a required dependency with no default, so the
  bonding-curve conflict above has to be decided explicitly rather than
  inherited.
