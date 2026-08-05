# solana-tracker

A Solana token tracker and paper-trading bot. TypeScript, Node 24, SQLite.

**Status: paper-trading, with a strategy.** The ledger, guard layer, quote
adapter, paper broker, wallet stream, safety screener, tracker, local control
API and the strategy layer are all in place. `MirrorStrategy` copies tracked
wallets and exits on a -40% / +150% band; `EquationStrategy` is a working
strategy that never trades. Selected by `strategy` in `config.json`. Every fill
is still simulated — nothing has run against a live RPC.

## Folder boundaries

The layers below form a one-way dependency chain. An arrow means "may import
from"; there are no arrows pointing back up.

```
ui  ──►  services  ──►  adapters  ──►  core
                 └──────────────────►  core
                          db  ────────►  core
```

### `src/core/` — execution interfaces and invariants
Pure domain model: types, the config schema, and (later) the rules that decide
whether a trade is allowed. **No I/O** — no `fetch`, no network, no
`process.env`, no database handle, no clock reads buried in logic (pass
timestamps in). Everything here is deterministic and unit-testable without
mocks. Core imports nothing from the other folders.

The one exception is `config.loadConfig()`, which reads `config.json` from
disk. It is carved out on purpose: config is the process's ground truth, and
having one obvious place it comes from beats routing it through an adapter for
purity's sake. The validation itself (`parseConfig`) stays pure, and it is
what the tests exercise.

### `src/adapters/` — RPC, price feeds, DEX parsing
Everything that talks to the outside world: Solana JSON-RPC and WebSocket
clients, quote/price providers, swap-transaction parsing, metadata lookups.
Adapters own retries, timeouts, and rate limits, and they translate foreign
payloads into `core` types at the boundary — a raw provider response must never
escape this folder. Validate untrusted input here with zod.

### `src/services/` — tracker orchestration
The part that decides what happens: discovery loops, position management, risk
checks, the execution pipeline (`OrderIntent` → `Fill` → `Position`), and the
paper/live mode split. Services compose adapters and `db`; they hold the run
loop and the `BotState`. They must not embed protocol details (that's
`adapters`) or SQL (that's `db`).

### `src/db/` — SQLite schema and queries
Schema, migrations, and typed query functions over `better-sqlite3`. SQL lives
here and nowhere else. Query functions accept and return `core` types, so the
rest of the app never sees a row shape.

### `src/ui/` — static single-page frontend
A dependency-free static page (HTML/CSS/JS) served by the app, reading a
read-only JSON API exposed by `services`. It is excluded from the main
`tsconfig.json` build and has no import path into the backend — it must not be
able to reach the database or an RPC client directly. Kill-switch and
start/stop controls go through the API like any other client.

`index.html` is the **wallet screener**: the watchlist, an add form, start/stop,
and a live event feed over SSE. It is read from disk per request rather than
cached at boot, so editing the page and reloading the browser is one step.
Because `tsc` copies no assets, the path is resolved from the project root
(`src/ui/index.html`, overridable with `UI_PATH`) and not relative to the
compiled module.

### `src/strategies/` — what to trade
Implementations of `core/strategy.ts`. A strategy sees a `Context` and nothing
else: no `Broker`, no ledger, no RPC, no screener. It must be a **pure function**
of its arguments — no `Date.now()` (use `ctx.now()`), no `Math.random()`, no
`fetch`, no module-level mutable state. A test greps this directory for all
three and fails the build on a hit, because Prompt 12 promises byte-identical
replays and this is the only place that promise can be enforced mechanically.
Strategies may import from `core/` and nowhere else; that too is tested.

### `src/cli/` — operator tools
Small standalone commands for things an operator does by hand during an
incident. `orphans.ts` is the only supported way to lift the crash-orphan gate.
These are not part of the bot's run loop and hold no state of their own.

### `tests/replay/`
The replay harness. Feeds a recorded session back through the **real**
`guarded()` and the **real** paper broker — never a reimplementation — on a
simulated clock with a `fetch` that throws. Quotes and screen verdicts resolve
from the recording by exact key; a miss is a hard error naming the miss, never a
synthesized answer. Three invariants are checked at every step and abort with
the `seq` and the offending fill, because the 2026-08-03 oversell stayed
invisible for a whole prompt behind a clamp that made the end state look right.

Same session + same strategy + same config produces a byte-identical report.
Every session is swept at 0 / 30 / 100 / 250 bps of latency penalty, and a
strategy that is only profitable below the 30 bps default says so in the summary
line.

### `tests/`
Vitest. `core` is tested directly with no mocks; `adapters` are tested against
recorded fixtures; `services` are tested with fake adapters.

## Setup

Requires Node 24 (Active LTS). Installed here via Homebrew as the keg-only
`node@24` formula, so it needs to be on `PATH`:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
```

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
cp config.example.json config.json
```

Then fill in `.env` with your RPC endpoints and Helius key. **`.env` and
`config.json` are gitignored — never commit real keys.** Secrets belong in
`.env` only; `config.json` holds tuning parameters and nothing sensitive.

`.env` must sit in this directory (`solana-tracker/`), not the parent:
`import 'dotenv/config'` reads it from the process working directory, and every
npm script runs from here. For Helius, the two URLs are the **RPC endpoints**,
not the dashboard page:

```
RPC_HTTP_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
RPC_WSS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```

`RPC_WSS_URL` is required — `serve.ts` exits with code 2 without it.

You do not need to hand-edit `trackedWallets`: `npm run serve` then
`http://127.0.0.1:8787/` gives you the wallet screener, described below.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run serve` | Start the process and the local control API (boots idle) |
| `npm run orphans` | List crash orphans awaiting sign-off (see below) |
| `npm run replay -- <session.jsonl>` | Replay a recorded session through the real guards and broker |
| `npm run typecheck` | Type-check `src` and `tests` (no emit) |
| `npm run build` | Compile `src` to `dist` |
| `npm test` | Run the vitest suite once |
| `npm run test:watch` | Vitest in watch mode |

## Running it

```bash
npm run serve
```

The process boots **idle** and puts a control API on `http://127.0.0.1:8787`.
Starting the process and starting the bot are two separate decisions — otherwise
a restart for an unrelated reason silently resumes trading.

| Route | What it does |
| --- | --- |
| `GET /state` | `mode`, `status`, `killSwitchEngaged`, open positions, unacknowledged orphans |
| `POST /start` | Reconcile from disk, open wallet subscriptions, begin the price loop. 409 if not idle |
| `POST /stop` | Stop taking entries, finish in-flight intents, close subscriptions. **Sells nothing** |
| `POST /kill` | Engage the kill switch. Persisted; survives a restart |
| `POST /flatten` | Liquidate everything. Requires `{"confirm": true}` |
| `GET /positions` | Open positions with the latest mark |
| `GET /fills?limit=50` | Recent fills, newest first |
| `GET /events` | SSE, replaying the buffered tail so a client attaching mid-run is not blind |
| `GET /` , `GET /ui` | The wallet screener page |
| `GET /wallets` | The watchlist, what the running stream is subscribed to, and whether they differ |
| `POST /wallets` | Add one. `{address, label?, note?}`. 400 malformed, 409 duplicate |
| `PATCH /wallets/:address` | Edit `label`, `note`, or `enabled` (mute without forgetting) |
| `DELETE /wallets/:address` | Untrack. **Sells nothing** — an open position is unaffected |

The API is bound to `127.0.0.1` and that is **not configurable**. It has no
authentication and it exposes `POST /flatten`; a host option would be one config
typo away from putting that on a LAN. Every exact amount crosses as a decimal
**string**, never a JSON number — see the integer decision below.

`stop` and `flatten` are deliberately separate controls, and releasing the kill
switch is deliberately not on the API at all.

### The wallet screener

Open `http://127.0.0.1:8787/` after `npm run serve`. It shows mode, status, the
kill switch and orphan count; it adds, labels, mutes and removes tracked wallets;
and it starts and stops the bot.

The watchlist is stored in two files, and the split is deliberate:

| File | Holds | If you delete it |
| --- | --- | --- |
| `config.json` → `trackedWallets` | the enabled addresses — the authority on what is watched | the bot watches nothing |
| `data/wallets.json` | labels, notes, added-at, and muted wallets | you lose your notes, nothing else |

`core/config.ts` is `.strict()`, so a label cannot live in `config.json` at all.
The two are reconciled by union on every open, so hand-editing either is safe.

**An edit reaches the RPC subscriptions at the next `POST /start`, not mid-run.**
`WalletStream` reads its wallet array at subscribe time and at every gap fill,
and is handed the array the store owns — so a save is picked up by the next start
without a process restart, and is *not* picked up by a run already going.
Applying mid-run would need `logsUnsubscribe`, whose subscription ids this
codebase does not track. `GET /wallets` reports `pendingRestart: true` whenever
the saved watchlist and the subscribed set have diverged, and the page shows it
as a banner, so the gap is never silent.

Removing a wallet stops watching it. It does not sell — `POST /flatten` is the
only route that sells.

## Safety

Strategies decide *what* to trade and never *how*: a strategy returns an
`IntentDraft` with no id, and the runner assigns the id, writes the intent, and
puts it through the same guard layer and broker an operator's command uses. The
runner treats a strategy as untrusted — a throw or a call over 500ms becomes a
`strategy-error` event, is treated as "do nothing", and can never stop a loop or
change bot state. Calls are serialized per mint.

Entries stop the moment `stop()` begins; **exits keep working** in every state,
including idle and with the kill switch engaged.

The bot defaults to `mode: "paper"`, where every `Fill` is simulated
(`simulated: true`) and no transaction is ever submitted. `live` mode is opt-in
via config. The kill switch in `BotState` blocks all new `OrderIntent`s and can
only be cleared by an explicit operator action.

Risk limits gate **entries only**. A bot that is holding must always be able to
exit, so no limit — kill switch, daily loss cap, concurrency cap, or the orphan
gate below — is ever applied to a sell.

Well-formedness is checked on **both** sides, ahead of every risk gate, and is
not a risk limit: an intent with a missing, negative, `NaN` or wrongly-typed
amount, or a mint that is not base58, is rejected as `MALFORMED_INTENT`. The one
exit that looks malformed and is not is a sell for more than is held — that is
**clamped to the position and executed**, because refusing it would strand
exactly the holder whose books already disagree with the chain. The fill records
what settled; the intent records what was asked.

### Crash orphans

If the process dies between writing an intent and recording its fill, that
intent is left `pending`. On the next start `reconcileOnStartup()` marks it
`orphaned`: the transaction may or may not have confirmed on chain, and the
database cannot tell.

**While any orphan is unacknowledged, the guard layer rejects every buy**
(`UNACKNOWLEDGED_ORPHANS`). This is not advisory — the state lives in SQLite, so
restarting does not clear it. Sells and `emergencyExitAll()` stay available.

Clearing it requires a per-orphan sign-off, attributed to a named operator:

```bash
npm run orphans -- list --db ./data/tracker.db
```

```bash
npm run orphans -- ack <intent-id> --operator <name> --resolution no-tx-on-chain
```

Resolutions are `no-tx-on-chain` (checked the chain, nothing landed),
`manually-closed` (dealt with by hand), and `tx-confirmed` (it did land). The
last one *requires* the fill data — signature, token/SOL deltas, fees — and
records it in the same transaction that lifts the gate, so the recovered
position is on the books before trading resumes. Missing values are prompted
for. There is no clear-all: each orphan is a separate unknown.

## Recorded decisions

### Money is exact integers, prices are derived floats

Everything the bot owns or owes is a `bigint` in base units: token amounts in
`10^decimals`, SOL in lamports. All accounting — cost basis, realized P&L, the
gas reserve check, the daily loss cap — runs on those integers.

Anything involving a price ratio (`priceSol`, `avgEntrySol`, `unrealizedSol`) is
a `number`, computed on read from the exact fields, and is **display only**. A
derived value is never the input to an accounting decision.

Two concrete reasons, not style:

- Whole-token floats do not land on zero. Buy 0.1 then 0.2, sell the 0.3 the
  chain says you hold, and you are left with `5.55e-17` tokens — a position that
  stays `open` forever and cannot be sold. The float build needed a
  `DUST_TOKENS = 1e-9` threshold to paper over this; that constant is gone,
  because `tokens === 0n` is now exact.
- A mint with 1e9 supply at 9 decimals has 1e18 base units. Float64 holds exact
  integers only to ~9e15, so those amounts are not representable at all.

A `Fill` carries the mint's `decimals`, because base units are meaningless
without the scale, and a position must be renderable from the ledger alone.

Config stays in human units (whole SOL) and is converted once at the boundary by
`solToLamports`. Conversions live in [`src/core/units.ts`](src/core/units.ts).

**Consequence:** a leftover base unit after a sell keeps the position `open`,
because the wallet genuinely still holds it. That is correct, but it means a
1-unit remainder occupies a concurrency slot until swept — see the TODO.

### Reconciliation is against disk, not chain

`reconcileOnStartup()` rebuilds from the local ledger and never queries chain.
"Reconciles clean" therefore means **no intent was left pending** — not "the
wallet matches the books".

These come apart in one case, and it is the one that matters: the process dies
after a swap confirms but before its fill is written. Disk says `pending`; the
chain says you hold the tokens. The ledger has no position for that mint, and
the guard layer rejects a sell with `NO_OPEN_POSITION` — so the bot is holding
something it cannot exit on its own.

The orphan gate is the deliberate substitute for on-chain reconciliation: a
human checks the wallet, runs `ack --resolution tx-confirmed`, and the fill is
booked so the position becomes exitable. Entries stay blocked until then. This
is human-in-the-loop, not an equivalent — chosen because there is no RPC
adapter yet, and recorded here so it is a decision rather than an oversight.

Two consequences:

- Any future preflight asserting "the ledger reconciles clean" must compare
  against **chain balances**. `ReconcileReport` cannot support that claim.
- **In paper mode this never bites**, because a simulated fill cannot land
  without the ledger writing it. A green paper run says nothing about this gap.

## TODO

- [ ] Engage `killSwitchEngaged` at startup when unacknowledged orphans exist.
      The services layer now owns `BotState`, but this got **harder**, not
      easier: the kill switch is persisted, so auto-engaging it would leave it
      engaged after the orphan was acknowledged — an operator would sign off,
      expect trading to resume, and find it silently still dead. Doing this
      safely needs a separate in-memory-only flag. The DB-backed orphan gate
      already blocks every buy and lifts the moment the orphan is acked.
- [x] ~~A `MALFORMED_INTENT` gate in `guards.ts`~~ — done in handoff 11. Gate 0
      runs ahead of everything on both sides; oversell clamps to the position
      before the quote rather than rejecting.
- [x] ~~Narrow `INSERT OR IGNORE`~~ — done in handoff 11. Idempotency is on the
      primary key only; every other constraint raises, and nothing is emitted
      that is not on disk.
- [x] ~~Decide `PositionState.closing`~~ — deleted in handoff 11. It was not
      derivable from fills, a crash would have stranded it, and `SELL_IN_FLIGHT`
      already holds the information authoritatively.
- [ ] Fold `src/db/fillsView.ts` into `Ledger.getRecentFills()`. It exists as a
      separate read-only connection only because `ledger.ts` was frozen, and it
      splits ownership of the `fills` table across two modules.
- [ ] On-chain reconciliation (see the decision above), once an RPC adapter
      exists. Until then the orphan gate stands in for it.
- [ ] A dust-sweep rule. With exact base units a sell can leave a handful of
      units genuinely held, which keeps the position `open` and consumes a
      concurrency slot. This is a strategy policy ("close out below N units"),
      deliberately not an arithmetic threshold in the ledger.
