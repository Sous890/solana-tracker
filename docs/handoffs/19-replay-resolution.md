# Handoff 19 — the replay harness could not replay a real session

**C1 failed, and the failure was real. Fixing it took two changes to the session
loader, both the same bug in different clothes. C2 and C3 were not run, for
reasons that are properties of the code rather than of the session.**

Suite: **854/854 passing** (851 + 3 new), typecheck clean, build clean. Fresh
clone verified. Task B not done — the sign-off line was still blank.

Everything below was verified against the code and the recorded session. Where a
number is quoted it came from a script over the session file, not from memory.

---

## Task A — a clean clone passes, and the repo is push-safe

`tests/fixtures/transactions/wallet-key-from-lookup-table.json` was matched by
`.gitignore`'s `wallet*.json` secrets rule and had never been committed. Because
it was *ignored*, it never appeared as untracked either, so `git status` looked
clean while the working copy held the only copy of a file 7 tests depend on.

**Audited before committing.** Top-level keys are `recordedAt, venue, signature,
wallet, walletKeyIndex, staticKeyCount, expected, tx`. No 32- or 64-byte integer
arrays anywhere in the file — that is the shape a Solana keypair takes on disk,
and its absence is the check that matters. No `secretKey`, `privateKey`,
`mnemonic` or `passphrase` keys. Every base58 string of 60+ characters is either
the public transaction signature (87 chars, appearing twice — top level and
`transaction.signatures[0]`) or instruction `data` inside
`meta.innerInstructions`. Every match on "token" is the SPL Token program id
`Tokenkeg…` or a `uiTokenAmount`/`preTokenBalances` field. The "wallet-key" in
the filename is the wallet key resolved from an address lookup table — what the
capture exercises, not what it contains.

The rule was narrowed rather than relaxed:

```
wallet*.json
!tests/fixtures/transactions/wallet*.json
```

Verified both directions: the fixture is no longer ignored (`git check-ignore`
exits 1, `git add` works without `-f`), while `wallet.json`, `wallet-prod.json`,
`keypair.json`, `data/wallet-secret.json` and `src/wallet123.json` are all still
ignored.

**Acceptance met.** `git clone . /tmp/clone-check` → `npm ci` → `npm test` gives
**854 passing in a directory that has never held the working copy.**

### Push-safety: yes, with one caveat that is not about secrets

Across all commits: `.env`, `config.json` and `data/wallets.json` are untracked;
no `api-key=` anywhere in tracked content; no keypair-shaped arrays; no
secret-key field names. Every path that has ever existed in history is benign —
the only files ever added under a secret-shaped name are `.env.example` and the
fixture above.

**Caveat, unrelated to secrets:** a fresh `npm ci` under npm 11.16 stops with
`allow-scripts`, leaving `better-sqlite3` without its native binding and
`esbuild` without its binary, so the suite cannot run until someone runs
`npm approve-scripts better-sqlite3 esbuild fsevents` and reinstalls. That is
npm's install-script gate, not a repo defect, and committing the `allowScripts`
block npm writes into `package.json` would be a security decision nobody has
made. Left alone deliberately; anyone cloning needs that one command.

---

## Task B — not done

The sign-off line was still `— ______________________  ____________`. The prompt
that carried it says an unsigned placeholder is not a sign-off and that refusing
it is correct, so `db/ledger.ts` was not touched. `signal_age_ms` remains
unpersisted and `maxSignalAgeMs` remains untunable from the ledger. **This
session produced new evidence about how much that costs: the replayed session
shows 920 `STALE_SIGNAL` rejections against 11 round trips.**

---

## C1 — the finding

**The harness had never been run against a real session. The first one put
through it was not replayable at all.** Every point of the slippage ladder died
on `QUOTE MISS`, including 30 bps, which is the penalty the run itself used.

Two independent instances of one defect: **the loader indexed recorded inputs by
identity with no time dimension, so a session that met the same input twice
collapsed the two.**

### Instance 1 — quotes, `// First wins`

`LoadedSession.quotes` is `Map<(inMint,outMint,inAmount), QuotePayload>`, first
answer wins. Measured on the session:

| | |
| --- | --- |
| quote lines | 73 |
| distinct keys | 41 |
| keys requested more than once | 17 |
| ...whose answers differ | 10 |
| **recorded quote lines unreachable by the index** | **32 of 73 (44%)** |

`9uNefL6…` was quoted 8 times at 0.05 SOL with 6 distinct answers across a 6.58%
spread. The replay resolved its third buy to the *first* buy's answer, and the
arithmetic is exact: recorded buy at seq 4893 returned `30303026337`, times the
30 bps factor is `30212117257`, which is precisely the amount the failing exit
asked to sell. No live quote ever covered it, so the run stopped.

### Instance 2 — screens, last wins

Fixing the quotes moved the failure, it did not remove it. `screens` is
`Map<mint, ScreenPayload>` holding the **last** verdict. `9uNefL6…` was screened
three times: `unknown` at seq 4898, `pass` at 5046, `pass` at 6280. Live opened
nothing on the first occasion — an `unknown` screen refuses the entry. The
replay, seeing only the last verdict, applied `pass` to all three and **took a
position the live run had declined**, then tried to exit it at a size nothing
had priced.

### Why neither "first" nor a queue is the answer

A key repeats for two unrelated reasons and the loader could not tell them
apart:

- the screener quotes the pair before the guard layer and the broker do, so one
  entry decision produces several quotes for the same key within a second;
- a strategy buys the same mint again an hour later, which is a different
  market.

A consuming queue does not work either, because **the recording contains quotes
the replay never asks for**: `safety.ts` quotes both directions while screening,
and a replay resolves screens from recorded verdicts instead of re-running the
screener. Traced with the harness instrumented, the recording holds three
buy-side quotes per traded occasion where the replay issues two — a queue would
drift by one every trade, silently.

### The fix

Resolution is now by `seq` — the position in the session being replayed — via
`resolveQuoteAt` and `resolveScreenAt` in `tests/replay/session.ts`. Answers are
grouped into **bursts** (same key, consecutive, under 60s of quiet between them)
and a resolution returns the **last member of the first burst at or after the
current seq**.

Last, not first, and that is the part worth remembering: the execution quote is
the one issued *after* the screen passes. Verified on three separate occasions —
the exit amount is always the last burst member's `outAmount` times the slippage
factor, never the first's. For `EM2DQsHn…` the burst is seq 6087 / 6089 / 6092
with the screen at 6091, and live filled on 6092.

The 60s threshold separates two populations that do not overlap: gaps inside a
burst run 0–2,158 ms (26 of 32 under a second), while the shortest gap between
two genuine occasions in the same mint is **747,626 ms — twelve minutes**.

**Known limit, written into the code:** if a settlement probe is ever added that
re-quotes *after* execution, the last burst member stops being the execution
quote and this rule breaks. The fix then is not another heuristic but a reason
tag on the recorded quote line, so a replay selects by intent rather than by
position. The existing comment about a "settlement probe … 400ms later" appears
to describe something never implemented — no such re-quote appears in any burst
in this session.

### What C1 now asserts

`tests/replay/fixtures/real-mirror-20260805.jsonl` is committed: 2.0 MB, 6,839
lines, seq 1..6839 contiguous, no truncated tail. Three tests replay it through
the real guards and the real broker:

1. it replays with no quote miss and no screen miss, and **actually trades** —
   asserted on `roundTrips > 0`, so "replays clean" cannot pass vacuously;
2. two runs are **byte-identical** (`Buffer.compare`, not deep-equal);
3. it carries unmodeled lines and replays anyway.

Replay result at the recorded 30 bps: 11 round trips, ledger reconciles clean,
`UNPROFITABLE AT EVERY SLIPPAGE TESTED`, guard rejections
`STALE_SIGNAL 920, CANNOT_SELL 6, PRICE_IMPACT_EXCEEDED 4`, total fees 1,870,000
lamports, max drawdown 28,559,259 lamports, median time to exit 1,250 ms.

**The synthetic fixture could never have caught this.** It never quotes the same
pair at the same size twice and never screens a mint twice, so it passed against
a loader that collapsed repeats — which is exactly the shape of a test that
proves the harness agrees with itself.

### `unmodeled`, as asked

Nonzero, and large. **4,886 of 6,839 lines (71%).** Broken down:
`tracker:swap-unparsed` 4,495, `tracker:stream-gap-filled` 260,
`tracker:stream-disconnected` 105, `tracker:stream-reconnected` 19.

Two things in there deserve their own look and did not get one here:

- **the parser fails on most transactions it sees.** 4,495 unparsed against
  1,857 parsed swaps is a 71% unparsed share; the soak digest's own threshold
  for a finding is 1%.
- **105 disconnects against 19 reconnects** in under five hours. Either the
  stream is far less stable than assumed or the two events are not recorded
  symmetrically. Both readings are worth knowing and neither was chased.

---

## C2 and C3 — not run, and why

Both were stopped on properties of the code, established before any long run was
started.

**C2 specified the equation strategy.** `EquationStrategy` is a deliberate no-op
stub — both `onTrackedSwap` and `onPriceTick` `return null`, documented as "a
working strategy that never trades". A four-hour soak with it would have
recorded observations and opened nothing, and the sweep in C3 would then have
had zero trades to compare at every equity level.

**C3's subject does not exist in the execution engine.** `equity_sol`,
`binding_constraint`, Kelly and pool-depth caps appear in `analysis/*.py` and in
**zero files under `src/`**. The engine sizes every entry at a fixed
`positionSizeSol` (0.05 SOL) from config, so varying equity would change nothing
about position size — only the gas-reserve and balance interactions at the
margin.

And even if sizing were equity-dependent, the sweep would be unreplayable by
construction: a different size is a different `inAmount`, which is a different
quote key, and a recording can only answer requests that were actually made.
This is visible already — the slippage ladder reports `NOT REPLAYABLE` at 0, 100
and 250 bps on this session for exactly that reason, and only 30 bps, the
recorded value, survives. **The premise "replay holds every input identical, so
equity is the only variable" does not hold for any variable that changes what
gets asked.**

The live mirror soak was left running rather than restarted: it has been up
4.9 hours, `status: running`, still recording, and a frozen copy of its first
6,839 lines is the committed fixture.

---

## Written section: what wiring the sizing bridge would actually take

Folded in here as prose rather than code, deliberately — this is a design note,
not a change.

`master_equation.py` computes a position size from equity, edge, a Kelly
fraction and a set of caps, and reports which cap bound. The engine has none of
that: `mirror.ts` returns `amountLamports: solToLamports(ctx.config.positionSizeSol)`,
a constant. Connecting them is not a port of the Python; it is four separate
decisions, and the order matters.

1. **A strategy has to be allowed to size.** `IntentDraft` already carries
   `amountLamports`, so the interface does not change — but every current
   consumer assumes a fixed size, and the guard layer's concurrency and
   gas-reserve gates were written against a world where one position is always
   0.05 SOL. Variable size makes `MAX_POSITIONS_REACHED` and
   `GAS_RESERVE_BREACH` interact in ways nothing tests today.

2. **The equation needs inputs the engine does not have.** `p̃`, `g` and `l`
   come from calibration over historical decisions, not from anything in
   `Context`. Either they are pinned config the operator sets from an offline
   fit — which makes the strategy a lookup, and honest — or the engine grows a
   calibration store, which is a much larger piece of work and one that can go
   stale silently. **Pinned config first.** A wrong-but-fixed number can be
   audited; a self-updating one cannot.

3. **`binding_constraint` has to be recorded, not just computed.** The whole
   value of the sweep C3 wanted is knowing *which* cap bound at each equity
   level. That is a per-decision output, and the only durable place for it is
   the ledger — which is the same argument as `signal_age_ms`, and blocked on
   the same sign-off. Computing it and logging it would repeat the mistake the
   `STALE_SIGNAL` counter already demonstrates: 920 rejections and no way to
   ask what ages they had.

4. **Only then is a sweep meaningful, and it still cannot come from one
   recorded session.** Quotes are keyed by exact amount, so a size the live run
   never requested has no recorded answer. A real equity sweep needs prices for
   arbitrary sizes, which means pricing from pool state rather than from
   recorded quotes — `src/calibration/poolHistory.ts` and `PoolState` are the
   nearest existing machinery, and CLAUDE.md gap 7 already warns that
   `PoolState` does not describe a pre-graduation bonding curve, which many
   tracked mints are.

The shortest honest path to the number C3 wanted is therefore: pin the equation
inputs in config, let a strategy size from them, persist the binding constraint,
and sweep by **re-running the equation offline over recorded decisions** rather
than by replaying one session at four equity levels. Steps 3 and 4 are each
their own session.

---

## What the next session should do first

1. **The unparsed share.** 71% of observed transactions do not parse. Everything
   downstream — every win rate, every payoff ratio — is computed on the 29% that
   do, and nothing establishes that the two groups look alike. This is a bigger
   threat to every number in this repo than anything in handoff 17, and it is
   cheap to start: the tags are already in the session.
2. **Disconnects.** 105 disconnected against 19 reconnected in five hours.
   Determine whether that is the stream or the recording before trusting any
   soak's coverage.
3. **`signal_age_ms`** — unchanged, still blocked on a signed sign-off, now with
   920 rejections of evidence behind it.
4. Detection-latency measurement (CLAUDE.md gap 6) still has its own session
   reserved and was not touched.

---

## Verified vs assumed

**Verified from code or data this session:** the quote and screen collapse and
their exact arithmetic; the burst structure and its two non-overlapping gap
populations; that the recording holds three buy quotes per occasion where the
replay issues two (harness instrumented, then reverted); that `EquationStrategy`
returns null from both hooks; that no C3 vocabulary exists in `src/`; the fixture
audit; the fresh-clone result; the session's kind and tag counts.

**Assumed, and worth challenging:** that the last member of a burst is always the
execution quote. It held on every occasion in this session and the arithmetic is
exact each time, but it is a positional heuristic standing in for an intent the
recorder does not record. A reason tag on the quote line would replace it with a
fact. If a future session sees a `QUOTE MISS` on a session that should replay,
suspect this first.

**Not investigated:** why `9uNefL6…` screened `unknown` on its first occasion;
whether the 105/19 disconnect asymmetry is real; whether any of the 11 round
trips would have been taken at a different `maxSignalAgeMs`.
