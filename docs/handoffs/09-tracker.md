# Handoff 09 — Tracker, composition root, and the local API

Files added: `src/services/tracker.ts`, `src/services/api.ts`,
`src/cli/serve.ts`, `src/db/runtimeState.ts`, `src/db/fillsView.ts`,
`src/adapters/rpcClient.ts`, `src/adapters/dexscreener.ts`,
`src/adapters/streamSocket.ts`, `tests/tracker.test.ts`, `tests/api.test.ts`,
`tests/adapters.test.ts`, `tests/fixtures/stop-child.ts`, and eight real wire
captures in `tests/fixtures/rpc/`. `ledger.ts` changed in exactly one respect
(the tie-break). **Nothing in `src/core/` was touched.** `fastify` added as a
dependency. 499 tests green, typecheck and build clean.

## Task 0 — the tie-break

`rebuildProjections()` now orders `(at, rowid)` instead of `(at, id)`.

`id` is content-derived — `intentId:mint` for a paper fill — so ties fell to an
alphabet with no causal meaning. `rowid` is insertion order, which is causal: a
fill cannot be inserted before the fill it follows. `fills` is a plain rowid
table and rows are never deleted, so the value is stable, and `INSERT OR IGNORE`
means a post-crash re-record keeps its original position rather than moving to
the end.

Four tests. Three kill the mutation back to `id ASC`:

- `replays buy-then-sell when the sell intent id sorts first` — `exit:MINT` vs
  `seed:MINT`, sharing `at` on a constant clock.
- `excludes the closed position from a reconcile report` — the operational
  consequence: sell-first replay left the position `open`, so a restart reports
  a holding the bot had already exited, and guard gate 5 then refuses to
  re-enter that mint as a duplicate.
- `books the realized P&L of the round trip, not of a phantom short` —
  sell-first books **+79,000,000** lamports against the correct **+28,000,000**,
  because the basis relief is zero against a flat position.

The fourth, `orders on 'at' first — rowid only breaks ties`, deliberately does
*not* die to that mutation. It guards the opposite direction: that the tie-break
never quietly becomes the whole ordering.

**One extra site, disclosed.** `fillsByIntent` had *no* tie-break at all, so its
ties fell to whatever the `fills_intent` index yielded. `reconcileTx` reads
`fills.at(-1)` from it to date a recovered intent, which made that read
unspecified. It now carries the same `, rowid ASC`. That is a second edit to
`ledger.ts` beyond the literal instruction — same defect, zero risk, and it
would be strange to fix one and leave the other.

## The lifecycle asymmetry, and why it is not symmetric

`guards.ts` gates entries hard and exits not at all. The commands inherit that
shape:

| Command | Behaviour | Why |
| --- | --- | --- |
| `start()` | **Throws** `TrackerStateError` if not idle | A second start opens a second subscription against one cursor. That is a caller bug and should say so. |
| `stop()` | **Converges.** Idle is a no-op; stopping joins the stop already running | Asking a stopped bot to stop is a request already being satisfied. |
| `flatten()` | Runs from **any** state, bypasses every gate | The only command that sells. Never reached by stopping. |
| `killSwitch()` | Instant, in memory before disk, persisted | Memory first so an entry racing the disk write is already refused. |

`POST /start` answers 409; `POST /stop` answers 200 whatever the state.

## Three places the instructions and reality disagreed

### 1. "stop() … return to idle" versus "open positions stay monitored"

Taken literally these conflict: returning to idle tears down the loops, and
then nothing is monitoring anything.

Implemented so both hold. `stop()` closes the wallet subscriptions and the
status returns to `idle`, but the **price loop and the held-position screen keep
running while anything is held**. They are torn down only when idle *and* flat,
or by `shutdown()`.

This is the safer reading and it costs nothing. `stop()` deliberately did not
sell, so an operator who stops the bot is sitting on a book with no strategy
watching it — which is exactly when a position going unexitable must not happen
in silence. `still detects a lost route on what it left behind` pins the
behaviour rather than the timer count: fire the price loop's own handler after a
stop and the alert still arrives.

### 2. A held mint's `NO_ROUTE` is an alert, so it fires on the edge

Prompt 6 required `NO_ROUTE` on a held mint to be an alert rather than a log
line. An alert that repeats every 2 seconds *is* a log line, so `route-lost` is
**transition-triggered**: it fires when a mint enters no-route and re-arms when
the route returns.

The operational cost of the latch-free version is not hypothetical.
`does not flood the replay buffer a late client will read` runs 300 ticks: at
one alert per tick the 200-entry SSE replay buffer is full of nothing but that
alarm inside seven minutes, so a client attaching later sees no reconcile, no
state changes, nothing else.

Also: **only `NO_ROUTE` counts.** `TIMEOUT` and `UPSTREAM_ERROR` are facts about
us, not about the token, and each has its own test. Crying wolf devalues the one
alert that means "trapped".

### 3. The exit probe is the whole position, not a sample

The price loop quotes `position.tokens → WSOL`, the real exit at the real size,
not `priceProbeLamports`. It is the number that matters, and a `NO_ROUTE` on it
is the literal statement "this position cannot be sold right now". A probe-sized
quote can succeed while the actual holding has no route at all.

## Cadences, and the arithmetic behind 30s

Price loop **2s**; held-position screen **30s**, as specified. The screen
cadence is chosen against the `unknown` case specifically:

- `pass` and `fail` are cached 60s, so at 30s every second screen of a healthy
  mint is a cache hit and costs nothing.
- `unknown` is **never** cached, by design (handoff 08, mutation 3). A broken
  provider therefore makes every tick a real round trip.
- Positions are screened **sequentially**, with a per-mint in-flight latch and a
  whole-tick latch, so a slow provider cannot make one tick overlap the next.

Worst case is `maxConcurrentPositions` screens per 30s — 3, i.e. **0.1 req/s**
against DexScreener's 300/min. At the 2s price cadence the same outage would sit
at 1.5 req/s indefinitely, which is how a transient failure becomes a rate-limit
ban and then a permanent one. No extra backoff was added: the position cap
already bounds it, and backing off would hide a degradation the operator needs
to see. `is registered on the slower cadence` reads the cadences back off the
scheduler the tracker actually used, rather than asserting the constants.

## Rejection codes reach the ledger, not just the log

Handoff 08 requires `SCREEN_FAILED:<codes>` and `SCREEN_UNKNOWN:<codes>` to stay
distinguishable "in logs **and in the ledger's `rejection_code`**". Both arrive
at the guard layer as the same `CANNOT_SELL`, so `rejectionCodeOf()` composes:

```
CANNOT_SELL:SCREEN_FAILED:T22_PAUSABLE,T22_TRANSFER_HOOK
CANNOT_SELL:SCREEN_UNKNOWN:LIQUIDITY_UNAVAILABLE
```

Every other `GuardCode` is written unchanged, including a `CANNOT_SELL` that did
not come from the screener. The guard layer never reaches the broker on a
rejection, so nothing else would resolve that intent row — the tracker does it.
`writes the screener verdict into the ledger row` reads the column straight out
of SQLite rather than trusting the event.

## What the wire actually returned

All eight fixtures in `tests/fixtures/rpc/` are real captures taken this
session. Three of them corrected an assumption.

**A token account passes an owner check and is not a mint.** A real BONK-era
USDC token account under `jsonParsed`:

```json
{"data":{"parsed":{"info":{"mint":"EPjFW…","tokenAmount":{…}},"type":"account"},
 "program":"spl-token","space":165},
 "owner":"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"}
```

The owner **is** the Token program, so an owner-based check waves it through.
Then `parsed.info.decimals` is `undefined` and `mintAuthority` is absent — which
`authorityIsLive` reads as *revoked*. That is a clean screener pass on an
account that is not a mint. `getParsedMintAccount` checks `parsed.type === 'mint'`
and throws.

**`null` and "unparseable" are different.** `getAccountInfo` on a genuinely
nonexistent address returns `result.value: null`. On an account it cannot parse
it returns `data: ["", "base64"]` — an array, not an object. Both were captured.
Only the first maps to `null` here; the second throws, because "account does not
exist" and "we could not read it" are different claims and the screener records
them differently.

**DexScreener's not-indexed answer is `pairs: null`.** Confirmed on both sides:
`{"schemaVersion":"1.0.0","pairs":null}` for an unknown mint, a populated array
with `liquidity.usd`, `quoteToken.address` and `dexId` for BONK. That `null` is
why `getPairs` is typed nullable — not indexed is **unknown**, never zero. An
HTTP failure throws instead, so an outage cannot be reported as "not indexed".

`getEpochInfo` → `result.epoch` (1011 at capture, which happens to match the
default in `safety.test.ts`). `getSignaturesForAddress` returns `signature`,
`slot`, `err`, `blockTime` and `transactionIndex`, a superset of both frozen
port shapes — so one method serves the screener's age check and the stream's gap
fill, and they cannot drift apart.

**Node 24 ships a global `WebSocket`**, verified in this runtime, and text
frames arrive with `event.data` already a `string`. No `ws` dependency.

## Two structural costs, stated rather than hidden

### `src/db/fillsView.ts` splits ownership of the `fills` table

`GET /fills?limit=50` needs a "most recent N fills" query. `Ledger` has none,
and `ledger.ts` was restricted to the tie-break, so the query lives in a
separate module on its own **read-only** connection — the precedent `cursors.ts`
set in handoff 07.

This is a cost. `ledger.ts` owns the schema, the writes and the projections;
this module duplicates the row-to-`Fill` mapping because sharing it would have
meant editing that file. The connection is opened `readonly` so the split cannot
become a second writer even by accident. **Fold it into
`Ledger.getRecentFills()` the next time `ledger.ts` is open for edit, and delete
the module.**

One incidental constraint it imposes: `better-sqlite3` refuses
`{readonly: true}` on `:memory:`, so the runtime rejects an in-memory `dbPath`
outright — four connections to an in-memory database would be four different
databases anyway.

### Protocol code went to `adapters/`, not `services/`

The instruction is that `tracker.ts` is where the real implementations get
**constructed**. It is — `createTrackerRuntime()` is the only function in the
codebase that opens a database, an HTTP client or a socket. But the *definitions*
of the JSON-RPC, DexScreener and websocket clients are in `src/adapters/`,
because the README's layering says services "must not embed protocol details
(that's `adapters`)". Construction and definition are different things, and
splitting them that way satisfies both.

## What was deliberately not done

- **The README TODO "engage `killSwitchEngaged` at startup when unacknowledged
  orphans exist"** is still open, and should stay open. The kill switch is now
  persisted, so auto-engaging it on orphans would leave it engaged *after* the
  orphan was acknowledged — an operator would sign off, expect trading to
  resume, and find it silently still dead. The DB-backed orphan gate already
  blocks every buy and lifts the moment the orphan is acked, which is the
  correct mechanism. A separate in-memory-only flag would be needed to do this
  safely, and that is a design decision, not a chore.
- **Releasing the kill switch is not on the HTTP API.** `BotState` says it "can
  only be cleared by an explicit operator action"; a POST from anything that can
  reach localhost is not that. `Tracker.releaseKillSwitch()` exists for the
  console. A test asserts no route reaches it.
- **Live mode refuses to build.** `createTrackerRuntime` throws on
  `mode: "live"` because only `paperBroker.ts` implements `Broker`. Without that
  check, `acknowledgeLiveRisk: true` would produce a process that simulates every
  fill while reporting `mode: live`.
- **`src/ui/` is still empty.** The API is the read surface it was going to use.

## Mutation results — which tests kill which

| # | Mutation | Killed by |
| --- | --- | --- |
| 1 | `stop()` also calls `emergencyExitAll` | **8** — `stop() sells nothing > never calls the broker at all`, `> leaves every open position untouched`, `> records no sell fill`, `> keeps monitoring what it did not sell`, `POST /stop > stops, and says plainly that it sold nothing`, `POST /flatten > is not reachable through /stop`, +2 |
| 2 | kill switch kept in memory only | **2** — `SURVIVES A RESTART`; `reaches disk immediately, not only on the next restart` |
| 3 | `rejectionCodeOf` returns the bare `GuardCode` | **2** — `keeps SCREEN_FAILED distinguishable from SCREEN_UNKNOWN`; `writes the screener verdict into the ledger row, not just the log` |
| 4 | `route-lost` fires every tick | **2** — `fires route-lost on the EDGE, not every two seconds`; `does not flood the replay buffer a late client will read` |
| 5 | loops torn down on idle regardless of holdings | **2** — `keeps monitoring what it did not sell`; `still detects a lost route on what it left behind` |
| 6 | `TIMEOUT` treated as a lost route | **1** — `does NOT call a timeout a lost route` |
| 7 | subscribe before reconciling | **4** — `goes idle -> running on start, reconciling before subscribing`, `REFUSES a double start…`, +2 |
| 8 | a corrupt persisted flag reads as released | **1** — `reads an unrecognised persisted value as ENGAGED` |
| 9 | `stop()` abandons in-flight intents | **2** — `WAITS for an in-flight intent before going idle`; `has written the fill by the time stop() returns` (real child process) |
| 10 | `flatten()` gated on status and kill switch | **9** — the whole `flatten()` block plus three API tests |
| 11 | `POST /flatten` drops the confirmation check | **1** — `REFUSES without an explicit confirmation` (four payload shapes) |
| 12 | double start allowed | **3** — `POST /start > answers 409 on a double start`, +2 |

Six mutations initially died to a single test each and were probed. Three
produced real additions; one produced a finding worth recording.

**Mutation 9 could not be killed in-process, and the first test I wrote for it
was wrong.** Abandoning the `await` inside `stop()` does not abandon the
intent's promise — it runs to completion anyway, and the ledger ends up
identical either way. My in-process test asserting "an orderly stop invents no
crash orphan" passed against both versions and proved nothing. The property only
exists across a process boundary, so it is now a real child process
(`tests/fixtures/stop-child.ts`, following the SIGKILL precedent in
`ledger.test.ts`): the child submits a gated intent, calls `stop()`, and exits
the instant it returns. Correct code has written the fill; the mutant strands the
intent as `pending`, which the parent's reconcile then files as a crash orphan
that blocks every buy until a human checks the wallet against chain.

**Mutation 2** was killed only by the restart test. Added a direct assertion
that the flag reaches the store immediately, so the durable write is asserted
rather than inferred from a later process happening to see it.

**Mutation 4** was killed only by the edge-trigger test. Added the buffer-flood
property above, which is the operational cost rather than the mechanism.

**Mutation 5** was killed only by a timer count. Added the behavioural version:
fire the loop's own handler after a stop and the alert still arrives.

Mutations 6 and 8 remain at one test each, and both are direct, named assertions
against the only thing that can catch them. Mutation 6 was nonetheless
strengthened sideways by a second test covering `UPSTREAM_ERROR`.

## Notes for whatever consumes this

- **The strategy slot is `null` and is not injectable.** Wiring a strategy is
  the change that turns an observer into a trader; it should be a visible edit
  to `tracker.ts` with the guard layer in view, not a value someone passes in.
  `creates NO intent and touches no broker` pins the current behaviour.
- `TrackerDeps.screener` is typed `HeldPositionScreener`, **not**
  `SafetyScreener` — `screenHeldPosition` plus the event, and nothing else. The
  tracker cannot reach `screenMint`, which belongs to `canSell` at buy gate 7.
  Handoff 08's standing rule ("the screener must never be consulted on a sell")
  is a property of the type here, not of anyone's memory. Three tests enforce it,
  including one covering `flatten()`.
- `TrackerDeps.broker` is the **unguarded** broker. The tracker wraps it, because
  `guarded()` needs `getState()` and the tracker owns state. Nothing else is
  given a handle to the inner broker.
- Every `bigint` crosses the HTTP boundary as a **decimal string**. A 9-decimal
  mint with 1e9 supply has 1e18 base units and float64 holds exact integers only
  to ~9e15; emitting numbers would round a position at the last hop after eight
  prompts of keeping it exact. `toJsonSafe` is applied per route rather than
  installed globally, so a route that forgets it throws instead of silently
  rounding.
- `GET /events` writes a `: connected` comment frame immediately. Without it a
  client attaching to a quiet tracker gets no response at all until the first
  event, because the headers sit in the socket buffer — the connection looks
  hung exactly when the bot is behaving. Found by a test that timed out.
- `API_HOST` is the literal `127.0.0.1` with no option to change it. This API has
  no authentication and exposes `POST /flatten`; a `host` option would be one
  config typo away from putting that on a LAN.
- `npm run serve` boots **idle**. Starting the process and starting the bot are
  two decisions — otherwise a restart for an unrelated reason silently resumes
  trading. SIGINT and SIGTERM run `stop()`, which sells nothing.

## Not verified live

`.env` does not exist in this checkout, so there are **no provider credentials**.
Every wire *shape* below was captured from public endpoints
(`api.mainnet-beta.solana.com`, `api.dexscreener.com`) and is replayed in tests,
but three things have never run against a real endpoint end to end:

- `WalletStream` against a real `logsSubscribe` websocket. The socket adapter is
  tested against a fake `WebSocketImpl`; the handshake, the subscription
  confirmation frame and the reconnect path are unexercised on a live provider.
- The Jupiter adapter under a real API key (the paid host swap in
  `createJupiterQuoteSource`).
- Any RPC call from the assembled runtime against a real provider.

`createTrackerRuntime()` **was** booted end to end, with unreachable RPC URLs
and a real SQLite file. It came up in `mode=paper, status=idle`, served
`/state`, `/fills` and `/kill`, refused `/flatten` without a confirmation,
persisted the kill switch, refused a connection on the machine's LAN address,
and shut down cleanly on SIGINT. What that run does *not* prove is anything past
`POST /start`, since nothing was reachable.

The first live run should be `npm run serve` with `trackedWallets: []`, then
`POST /start`, watching `GET /events`, before any wallet is added.
