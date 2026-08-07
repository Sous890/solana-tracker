# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A wallet-mirroring execution engine for Solana. TypeScript, Node 24, vitest,
SQLite (`better-sqlite3`).

**Paper mode only.** `createTrackerRuntime` throws `RuntimeConfigError` on
`mode: "live"` — only `paperBroker.ts` implements `Broker`, so a live run would
simulate every fill while claiming not to. Do not create or load a keypair path.

## Read before changing anything

- `README.md` — layering, the control API, and the recorded decisions behind
  the integer money model, the orphan gate, and disk-not-chain reconciliation.
  It is current and detailed; do not re-derive it, and do not duplicate it here.
- `docs/handoffs/` — one file per session, numbered. **`24-liveness-and-non-trades.md`
  is the most recent.** Read the latest two before starting. They record what
  was verified from code and the database versus what was recalled, which is the
  distinction that matters most in this repo.

## Commands

Node 24 is keg-only Homebrew here, so it may need to be on `PATH`:
`export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`.

| Command | What it does |
| --- | --- |
| `npm test` | Full vitest suite — currently **900 tests across 22 files** |
| `npx vitest run tests/soak.test.ts` | One test file |
| `npx vitest run tests/soak.test.ts -t "SIGKILL"` | One test by name substring |
| `npm run typecheck` | `tsc -p tsconfig.test.json` — types `src` **and** `tests` |
| `npm run build` | `tsc -p tsconfig.json` — compiles `src` to `dist` |
| `npm run serve` | Process + control API on `127.0.0.1:8787`. Boots **idle** |
| `npm run replay -- <session.jsonl>` | Replay a session through the real guards and broker |
| `npm run orphans` | The only supported way to lift the crash-orphan gate |
| `npm run soak` | Long-running soak driver |

`npm run typecheck` and `npm run build` cover different file sets — a change to
`tests/` is only checked by the former. Run both.

## Architecture worth knowing before you read files

`README.md` has the folder boundaries and the one-way dependency chain. What it
does not spell out, and what costs the most time to reconstruct:

**The intent pipeline is the spine.** A strategy returns an `IntentDraft` with
no id and no authority. `StrategyRunner` assigns the id, stamps provenance,
writes the intent, and puts it through the same `guarded()` layer and the same
broker an operator command uses. Fields a strategy must not be able to forge —
`signalAgeMs` among them — are **overwritten, not merged**, by the runner
(`services/strategyRunner.ts`). A strategy is untrusted: a throw or a call over
500ms becomes a `strategy-error`, is treated as "do nothing", and cannot stop a
loop or change bot state.

**Rejections are the measurement surface.** Guards write `rejection_code` onto
the intent row, so `STALE_SIGNAL` firing 272 times is a fact you can query. This
is why strategies deliberately do *not* pre-filter on things the guards check —
filtering in the strategy makes the drop invisible, because no row is ever
written. See the long comment in `strategies/mirror.ts` before adding a check.

**Recorder and replay are a matched pair.** `services/recorder.ts` writes
sessions as JSONL and records **inputs only** — swaps, quotes, screens, price
ticks — never fills, intents or positions, because replay regenerates those
through the real broker and guards. A session that carried outputs could be
replayed into agreement with itself. `seq` is monotonic across the whole run
including rotations; the replay loader **refuses a session with a `seq` gap**,
so anything that drops or loses a line makes the session unfit for replay. The
fifth line kind, `unmodeled`, exists so the schema is falsifiable — a nonzero
count is the finding, not a nuisance, and the fix is never to widen one of the
other four until the tag disappears.

**A replay resolves recorded inputs by `seq`, never by identity alone.** Both
`quotes` and `screens` on `LoadedSession` are identity-keyed maps that collapse
repeats — a mint bought twice at the same size, or screened twice with different
verdicts — and resolving against either silently prices a trade off the wrong
market or authorises an entry the live run refused. Use `resolveQuoteAt` and
`resolveScreenAt`. Handoff 19 has the arithmetic; the short version is that the
first real session ever put through the harness was not replayable at all, while
the synthetic fixture had passed for months because it repeats nothing.

**Adapters are wrapped, not modified, for recording.** `wrapQuotes`,
`wrapScreener` and `wrapDriver` are installed at the composition root, so
`jupiter.ts` and `safety.ts` have never heard of recording. `wrapDriver` is a
`Proxy` on purpose — `StrategyDriver` is an `EventEmitter`, and a plain object
literal or `Object.create` would silently break `strategy-error` delivery.

**Two SQLite modules share one file.** `db/ledger.ts` (the books) and
`db/runtimeState.ts` (kill switch, cursors) open the same path on separate
connections, both with a busy timeout. `db/fillsView.ts` is a third, read-only
connection that exists only because `ledger.ts` was frozen.

**Strategy purity is enforced mechanically.** `tests/strategy.test.ts` greps
`src/strategies/` for `Date.now()`, `Math.random()` and `fetch`, and checks the
import boundary. It fails the build on a hit, because byte-identical replay is
only enforceable there.

## Hard constraints

These are repeated in every session prompt. They are not style preferences.

- **The sell path is never gated by a risk limit.** No kill switch, daily loss
  cap, concurrency cap or orphan gate may ever block an exit. If a change would
  add any condition that can block a sell, stop and report instead.
- **Never loosen a config floor, a guard check, a test assertion, or a timeout
  to make something pass.** Not once, not temporarily. Fix the mechanism.
  Tightening an assertion is fine; weakening one is not.
- **`src/core/` does no I/O and no network.** `config.ts`'s `readFileSync` is
  the one deliberate exception. `zod` is an accepted dependency — the invariant
  is no I/O, not zero dependencies.
- **`db/ledger.ts` is off-limits** unless a session prompt carries an explicit,
  *signed* sign-off. An unsigned placeholder is not a sign-off; ask.
- **Do not change the status-flip ordering in `Tracker.start()` / `stop()`.**
  `setStatus('stopping')` happens first and before any await, because that is
  what guard gate 2 reads; an entry racing the call is already refused.
- **Do not touch TAU, `kelly_fraction`, or M.** A rejection is a valid output.
  The wallet rejection in handoff 17 is settled and is not to be re-litigated.
- Paper mode only. Nothing in ordinary work should need the network; if you find
  yourself hitting RPC, you have wandered off task.

## Known gaps

Every item here biases the same direction: **toward making a wallet look more
copyable than it is.** Items marked FIXED are kept because the mechanism cost a
session to find and the wrong explanations are worth not re-deriving.

### 1. `fit_alpha_half_life` is misspecified for these wallets, not under-fed

`surviving_alpha = 2**(-dt/T)` is strictly positive and monotone decreasing. The
measured forward return for `HSsJjkHr…` goes from +0.40% at delay 0 to **−0.92%
at delay 1s** and stays negative. No value of `T` represents a sign flip, so the
parametric decay cannot describe this wallet at any half-life.

Do not force a fit. Use `Latency(delay_s=0, half_life_s=<anything>)` and supply
`EdgeParams` / `TradeProfile` measured **at your actual delay**; the equation
does not need the parametric form if `p̃`, `g` and `l` already carry it. The
empirical table in handoff 16 is the calibration artifact.

### 2. Two optimistic biases land in the same parameter

- `fit_alpha_half_life` keeps only positive returns (the log requires it), which
  its own docstring says biases `T` **upward**.
- Fill rate falls 100% → 37.5% across the delay range (measured, 62.5pp drop,
  with NO_DATA flat at 54.29% so it is genuine illiquidity). Long-delay buckets
  shed their least liquid — worst — trades, so the measured curve is **too
  shallow** and any fitted `T` is **too long**.

Both point the same way. `T` is also the input `master_equation.py` warns you
least about guessing.

### 3. The raw export counts EXITS, not DECISIONS

`export-wallet-history.ts` emits one row per FIFO tranche, so a mint scaled out
of five times contributes five observations. Measured on `HSsJjkHr…`:

| | per tranche | per decision |
| --- | --- | --- |
| n | 3197 | 1429 |
| win rate | 55.0% | **48.7%** |
| payoff ratio | 1.68 | **1.20** |
| median return | +2.8% | **−0.4%** |

The 50% line falls between them. **Feed `{wallet}.decisions.csv` to
`realised_stats` and `EdgeParams`, never `{wallet}.csv`** — `trades` must mean
decisions. Generate it with `scripts/aggregate-decisions.ts`.

### 4. Timestamps are MILLIS in the export, SECONDS in `calibrate.py`

`calibrate.py`'s docstring specifies unix seconds. The exporter writes
milliseconds. `realised_stats` and `latency_adjusted_outcomes` never read a
timestamp so they are unaffected, but **`insider_share` would be wrong by 1000×**
and silently return 0.0. Convert before calling it.

### 5. `insider_share` has no `launch_ts` source

Nothing local supplies it. Do not substitute first-seen-in-session.

### 6. Our own delay is only partly measured

**The detection leg is measured** (handoffs 21-22). From `stream-fetch-window`,
live socket path, n=500: **p50 171 ms, p90 272 ms, p99 364 ms, max 652 ms**, with
99.8% fetchable on the first attempt. Consistent across sessions (198 ms at n=71)
and with the standalone `getTransaction` round trip of ~201 ms.

**That is a LOWER BOUND on copy delay, not the delay.** It covers only the gap
between the socket announcing a signature and this process being able to read it.
Quote, guard and fill time remain unmeasured; `example.py`'s 1.2 s assumption
covers the whole path. Do not substitute one for the other.

Re-measure with `npx tsx scripts/detection-window.ts <session.jsonl>`, and read
the `live` rows only — gap-fill signatures are minutes to hours old and were
always fetchable, so mixing them in drags every percentile toward the round trip.

The `getTransaction` null window is real but rare: it opened **once in 500 live
samples**, and the retry added in session 21 recovered it. Before that retry it
was silent — a `null` produced no record at all.

### 7. Pre-graduation pump.fun mints break `PoolState`

`PoolState` models a constant-product pool. A pre-graduation bonding curve is
not one, so `price_impact` and `exit_depth_ratio` do not describe its shape.
Many tracked mints end in `pump`. Unflagged in the current exports.

### 8. `signalAgeMs` is checked but not stored

272 of 290 intents on 2026-08-05 were rejected `STALE_SIGNAL`. The rejection
code is persisted; the age is not, so `maxSignalAgeMs` cannot be tuned from the
ledger. Fixing it needs an additive nullable `signal_age_ms` column on
`intents`, which means `db/ledger.ts`, which needs a signed sign-off. Do not
backfill and do not infer an age from timestamps — a wrong number is worse than
a missing one.

### 9. FIXED — live notifications were attributed to the wrong wallet

Kept as a record because it was the most expensive bug in this repo's history and
it was invisible to a green suite for three sessions.

`walletStream.onMessage` discarded the `logsSubscribe` subscription id and
enqueued every notification for **every** tracked wallet. One notification became
13 entries; the queue capped at `MAX_IN_FLIGHT` and shed **from the front**, so
the last wallet in the config list survived, fetched, was not in the transaction,
yielded `WALLET_NOT_IN_TX`, and was admitted to the seen set anyway — deduping out
the wallet that actually traded.

**Fixed in handoff 22.** Notifications now route by `params.subscription` through
a subscription-id → wallet map, rebuilt from empty on every connect; an
unattributable notification emits `unknown-subscription` rather than fanning out.

Measured after the fix, on live-sourced signatures only: **`WALLET_NOT_IN_TX`
went from 42.9% of the unparsed set to zero**, 0/30 sampled live unparsed
re-parse as swaps, and live parsed swaps rose from ~18/hour to ~86/hour.

**Two superseded explanations, recorded so they are not re-derived.** Handoff 19
blamed nothing; handoff 20 blamed unknown venue program ids (wrong — the parser
works from balance deltas and does not gate on program id); handoff 21 blamed the
RPC null window (wrong — a `null` produced no record at all, so it cannot have
generated the records the rate was computed from). Each was disproved by
measurement, not argument.

**CLOSED in session 23.** The seen set and `inFlight` are both keyed on
`(wallet, signature)` via `seenKey()`, and `WALLET_NOT_IN_TX` is no longer
admitted. One transaction naming two tracked wallets now yields two
`TrackedSwap`s. The capacity worry that deferred this was **arithmetic left over
from the fan-out**: a notification routes to exactly one wallet, so one delivery
costs one slot however the set is keyed. Measured over 2,788 `fetch-window`
records across both post-fix sessions, distinct pairs ÷ distinct signatures =
**1.0000**; the busiest whole run consumed 1,800 of 5,000 slots. `SEEN_CAPACITY`
stays at 5,000 and stays **one global LRU** — a fixed 385/wallet would be worse
than the status quo, since the busiest wallet alone took 581 slots in 13 minutes.

Not admitting `WALLET_NOT_IN_TX` matters for a reason handoff 22 did not name:
**two of `parseSwap`'s three routes to that code are degraded RPC responses**
(`meta === null`, and an account key list that does not match `preBalances`), not
a genuine absence. Admitting those is the same permanent-loss shape session 21
removed from the null window. Note the limit — `dispatch` still advances the
cursor, so the signature stays re-deliverable over the **socket**, not through
gap fill.

### 10. Queue shedding is a single-wallet arrival burst, not backpressure

Diagnosed in session 23, and the shed *policy* is not the first problem.

- **Sheds do not cluster in the startup gap fill.** 0 of 37 in session 22 fell in
  the gapfill burst — 0 in the first 12 minutes, while the burst runs minutes 0-4.
- **They arrive in synchronized bursts belonging to ONE wallet.** 26 of the 37
  landed inside 40 ms, all for `BCagckXe…`; the other 11 were all `H8sMJSCQ…`.
- **The drain is healthy throughout.** `fetch-window` in the 60 s before every
  burst: p50 128 ms, max 295 ms, **0 retries, 0 unresolved**. Nothing is stalling.

So the mechanism is a spam-ish wallet emitting tens of notifications in one slot
against a **global** `MAX_IN_FLIGHT = 20` drained serially at ~130 ms each.

**The telemetry misattributes the shed.** `enqueue` emits `queue-overflow` with
the wallet being *enqueued*, while `splice(0, n)` removes the **oldest** entries,
which may belong to any wallet. Every shed count broken down by wallet — including
the two above — names the arriving wallet, not the losing one. Fix this before
trusting a per-wallet shed number.

**Capacity, not policy, is the live arithmetic.** 20 entries × ~130 ms ≈ 2.6 s to
drain, against a `maxSignalAgeMs` of 15,000 ms. The queue could hold roughly 115
and still deliver inside the freshness gate; 20 is about 5× tighter than the
latency budget requires. Changing it is a measured re-derivation, not a loosened
limit — but it was not changed in session 23, and it needs its own tests.

**On shed direction**, if it is changed at all: shed from the **back**. Not
because the newest entry is worth less — it is worth more — but because of
`gapFill`'s `until:` anchor. Dropping the front leaves only newer entries to
dispatch, the cursor advances past the dropped one, and `until: <newer>` can
never walk back to it: **permanently lost**. Dropping the back leaves the cursor
behind the dropped entry, so the next gap fill re-offers it. The alpha-decay
argument for dropping the oldest is correct about the *value of the entry* and
silent about *whether it comes back*, and across a 2.6 s queue the decay
difference is small while the recoverability difference is total. Note the
recovered entry arrives minutes later and will be `STALE_SIGNAL`-rejected, so
this is a **corpus-completeness** argument, not a trading one.

### 11. FIXED — the stream's liveness check is now driven

`WalletStream.heartbeat()` had no caller anywhere, so `SILENCE_TIMEOUT_MS` was
dead and a socket that stopped delivering *without erroring* was undetectable.
It now runs on its own scheduler interval (`HEARTBEAT_INTERVAL_MS`, 30s) beside
the price and screen loops.

**`healthy` is passed as `true` and that limb is still inert.** The
`missedHeartbeats >= 2` path wants an independent liveness signal and this
process has none that is free — anything that could contradict the socket is
another network call, against a ~10 rps provider. The silence limb is the
detector.

Also fixed, both found while wiring it and both real:

- **One socket death started two reconnect chains.** A real WebSocket emits
  `error` then `close`; both reached `onDisconnect`, and `connect()` routed its
  own failure back through it too, so live chains only ever accumulated.
  `connectOnce()` now never starts a chain, `reconnect()` is a loop that owns
  retrying, and `beginReconnect()` admits one at a time.
- **A heartbeat during an outage would have multiplied chains.**
  `lastMessageAt` only advances on a delivered frame, so every tick still looks
  silent; `heartbeat()` now returns early when there is no socket.

`SILENCE_TIMEOUT_MS` is **180s**, from the measured healthy-gap distribution with
host sleep excluded (p50 2.6s, p90 14.8s, max 57.5s over 356 samples) — ~3.1x the
worst healthy gap. The margin guards against a **reconnect storm** on a quiet
market, not against a missed teardown.

### 11a. Session 23's soak ran on a sleeping laptop — always use `caffeinate`

**The host slept for 84.9 of that soak's 113.9 minutes.** All three long
"reconnect gaps" match `pmset` sleep windows to within seconds, and the session
file stops one second after a sleep entry.

Two numbers from handoff 23 are void: the "largest healthy gap was 4.5 minutes"
(a sleep artifact — it is 57.5s) and "51 live-parsed swaps in 113.9 minutes"
(measured across a window that was 75% suspended). The conclusion that the
reconnect path is broken is **not established**; fault injection did not
reproduce a failure.

Run every soak under `caffeinate -dimsu`, and check `pmset -g log` before
believing any long gap in a session file.

### 12. FIXED — intents could be recorded and never resolved

Guard gates 7 and 8 `await inner.getQuote()` and `inner.canSell()` with **no
`try`**, so a quote outage throws a `QuoteUnavailableError` — not a
`GuardRejection` — out of `guarded().execute` *before the inner broker runs*. The
broker resolves its own failures but was never reached; the guard layer resolves
its own rejections but this was not one; the tracker only logged it. The row
stayed `pending` for ever and became a `CRASH_ORPHAN` that shut gate 0.

Timing from the session file: first `UPSTREAM_ERROR` quote at 15:51:36.011, first
unresolvable intent at 15:51:50.911 — 14.9s later. Quote errors went 5.9% → 70.3%
across that boundary, and **all 8 fills are intents <=00014 while all 6 orphans
are >=00015.** A state transition, not a race.

The tracker now resolves any non-`GuardRejection` failure as `failed`, but only
when the status is still `pending`, so a resolution the broker already made is
never relabelled. Gates 7 and 8 themselves are unchanged.

### 13. Not every token movement is a trade — `INFRASTRUCTURE_ONLY`

Confirmed against chain in session 24. Transactions whose SOL leg was exactly
`SPL_TOKEN_ACCOUNT_RENT_LAMPORTS` invoke **no venue program at all** — only ATA,
token, system and compute budget. They are create-an-ATA-and-send-tokens.

The balance evidence is worse than a wrong label: on the buy side the tracked
wallet's own lamport delta is **0** (the sender paid the rent), and on the sell
side it is **-2,245,780** — the parser recorded SOL arriving while the wallet was
paying it out. 271 across the corpus, split 138 buys / 133 sells; an ATA opening
pays rent and a closing refunds it, which is why the split is near-even.

`parseSwap` now returns `INFRASTRUCTURE_ONLY` when **every program invoked** is
infrastructure. This is a **denylist, not an allowlist** — requiring a known
venue would repeat handoff 20's disproved mistake and discard every new DEX,
whereas "no market was touched by anyone" is safe under any venue. It reads
instructions rather than account keys, and **fails open** when the encoding does
not say what ran.

It matters because `mirror.ts` sizes from `positionSizeSol`, not from the
observed swap: a 0.002 SOL transfer and a 5 SOL buy produced the same entry.

### 14. Telemetry that named the wrong thing — all three fixed

- **`queue-overflow` reported the arriving wallet, not the one that lost
  entries.** The queue is global and `splice(0, n)` drops the oldest. **Every
  shed-by-wallet figure in this repo's history is void**, including handoff 23's
  "26 of 37 sheds belong to `BCagckXe…`". The field is now `arrivingWallet`, and
  `droppedFor` / `droppedSignatures` carry the real answer. Shed *timing*
  findings still stand — they never used the wallet field.
- **Guard rejections now reach session files** as a new `decision` kind, carrying
  `signalAgeMs`. It is a distinct kind rather than an `unmodeled` tag because the
  unmodeled count is a falsifiability signal and must not be diluted; the replay
  loader carries it and drives nothing from it, so "inputs only" still holds.
  **This closes gap 8** in the only way available without a ledger sign-off.
- **`PAPER BALANCE DRIFT` compared a per-process counter to a cumulative
  ledger**, so it fired on every healthy run against a non-empty file. The digest
  now latches the opening flow and compares delta to delta.

## Environment traps

- **`data/` is the application's database directory, not scratch space.**
  `DEFAULT_DB` is `./data/tracker.db`, and `data/wallets.json` holds watchlist
  labels and notes. It is gitignored, which makes it a tempting place to drop a
  diagnostic script — and session 22 did exactly that and then deleted the
  ledger, the cursors and the runtime state with `rm -rf data`. Put scratch files
  outside the repo. Never `rm -rf` a path under `data/`.

- **The ledger now has a backstop, and it is not a substitute for the rule
  above.** `services/ledgerDurability.ts` snapshots the ledger on start, every 15
  minutes, on bot-idle and on shutdown, to `~/.solana-tracker/snapshots`
  (`LEDGER_SNAPSHOT_DIR`), keeping the newest 24. It uses **`VACUUM INTO`, never
  a file copy**: the ledger runs WAL with `synchronous = FULL`, so `cp
  tracker.db` alone can yield a file that opens perfectly and has no `fills`
  table at all — measured, not theorised, in `tests/ledgerDurability.test.ts`.

- **Startup refuses an empty ledger beside a non-empty `sessions/`.** That
  pairing means the database was removed rather than never created.
  `ALLOW_EMPTY_LEDGER=1` is the documented override for a genuine first run. The
  check lives at the composition root and runs **before `openLedger`**, which
  creates the file it is given — inside `reconcileOnStartup` it would be
  reporting on a database it had just made, and `db/ledger.ts` is off-limits
  anyway.

- **What a session file cannot give back.** Session 23 established this against
  the real corpus: `price-tick` payloads carry mint, exact holdings and decimals,
  and a buy fill is reproducible from its recorded entry quote via
  `floor(outAmount × (10000 − paperLatencyPenaltyBps) / 10000)` — verified
  matching on 20 of 20 held mints. **Intents are not recoverable at all.** Guard
  gate 3 runs before the broker's first quote, so a `STALE_SIGNAL` rejection
  produces no quote, no screen and no tick — only the originating swap, which is
  indistinguishable from one the strategy declined to act on. Do not attempt to
  reconstruct intents from a session; a ledger with invented rows is worse than a
  missing one.

- **Paper `slippage_bps` carries no information.** `received =
  reduceByBpsFloor(quoted, paperLatencyPenaltyBps)` and `slippageBps =
  shortfallBps(quoted, received)`, so every paper fill records the config
  constant back to you — computed over every priced entry quote in the last
  session, the only value that occurs is **30**. Paper fills therefore **cannot**
  recalibrate the 30 bps penalty against live quotes; that needs live fills,
  which paper mode has never produced. The replay harness reads **sessions**, not
  fills, so it is unaffected by a lost ledger.

Each of these has already cost a session.

- **The working directory has a trailing space**:
  `/Volumes/LaCie/Operation grootenstine /solana-tracker`. A path written
  without it does not exist, and the error looks like a missing repo.
- **exFAT sprays `._*` AppleDouble sidecars.** They are binary and blow up the
  vitest transform (hence the `**/._*` exclude in `vitest.config.ts`). Filter
  them out of every `find`, `ls` and `grep`.
- **`pkill -f "tsx src/cli/serve.ts"` does not match**, because of the space in
  the path. Killing the `npx` wrapper orphans the `node` process beneath it,
  which keeps SQLite open and produces a `SQLITE_BUSY` that looks exactly like a
  production defect. Kill by PID from `ps aux | grep serve.ts`, then verify with
  `ps`.
- **Helius rate-limits at ~10 rps** and returns `Service overloaded` as a
  JSON-RPC error with **HTTP 200** — a naive client reads that as success.
- **zsh aborts the entire command line** when a glob matches nothing
  (`rm -f /tmp/x.*.log` on an empty directory). A measurement loop written that
  way silently never runs and reports zero failures, which reads exactly like a
  passing baseline.
- **Piping a long loop through `tail` buffers all of it**, so progress is
  invisible until it exits. Write per-run logs instead.
- **A gitignore secrets rule can swallow a required fixture, invisibly.** Fixed
  in handoff 19 for `wallet*.json`, but the shape recurs: an ignored file never
  shows as untracked, so `git status` stays clean while the working copy holds
  the only copy. If the suite passes here and fails in a clone, suspect this
  before suspecting the test. The check is `git clone . /tmp/x && cd /tmp/x`.
- On a fresh `npm ci`, install scripts may be gated, leaving `better-sqlite3`
  with no native binding. `npm approve-scripts better-sqlite3 esbuild fsevents`
  then re-run `npm ci` — and revert the `allowScripts` block it writes into
  `package.json` before committing.

## Testing notes

`tests/soak.test.ts` contains a real crash drill: it spawns an `npx tsx` child,
SIGKILLs it as a **process group** (`process.kill(-pid)`), and replays the
session it left behind. Both of its historical flakes were mechanism bugs, fixed
in handoff 18 — if either returns, it is a regression, not noise.

When a test is flaky, measure the rate before and after, isolated and under
load, and name the race you removed. `it.skip`, vitest `retry:`, `--no-threads`,
a longer sleep as the only change, and weakening the assertion are all
forbidden. 30 consecutive passes only bounds the true failure rate below roughly
10% at 95% confidence — the run count corroborates a fix, the named mechanism
justifies it.

## Handoff convention

Every session ends with `docs/handoffs/<n>-<slug>.md` and one commit whose
message describes the **mechanism, not the symptom**. Write the handoff in the
style of 17 and 18: what was verified from the code and the database rather than
recalled, what remains unknown, and what the next session should do first.
Update the "most recent" pointer at the top of this file when you add one.
