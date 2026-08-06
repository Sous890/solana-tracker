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
- `docs/handoffs/` — one file per session, numbered. **`21-null-window.md`
  is the most recent.** Read the latest two before starting. They record what
  was verified from code and the database versus what was recalled, which is the
  distinction that matters most in this repo.

## Commands

Node 24 is keg-only Homebrew here, so it may need to be on `PATH`:
`export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`.

| Command | What it does |
| --- | --- |
| `npm test` | Full vitest suite — currently **858 tests across 21 files** |
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
copyable than it is.** None is fixed.

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

**The detection leg is now measured** (handoff 21). From `stream-fetch-window`,
recorded per signature: live socket path, n=71, **p50 198 ms, p90 299 ms, p99
and max 353 ms**, and 100% fetchable on the first attempt. Consistent with the
earlier `getTransaction` round trip of p50 201 ms (n=20).

**That is a LOWER BOUND on copy delay, not the delay.** It covers only the gap
between the socket announcing a signature and this process being able to read
it. Quote, guard and fill time are all still unmeasured, and `example.py`'s
1.2 s assumption covers the whole path. Do not substitute one for the other.

Re-measure with `npx tsx scripts/detection-window.ts <session.jsonl>`. Read the
`live` rows only — gap-fill signatures are minutes to hours old and were always
fetchable, so mixing them in drags every percentile toward the round trip.

The `getTransaction` null window it was feared to be is real but did not open
once in those 71 samples. It is now retried (`FETCH_ATTEMPTS = 3`) and a
signature is no longer admitted to the seen-set until it has actually been
fetched.

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

### 9. Live socket notifications are attributed to the WRONG wallet

`walletStream.onMessage` discards the `logsSubscribe` subscription id and
enqueues every notification for **every tracked wallet**. One notification
becomes 13 queue entries, 12 of them for wallets with nothing to do with the
transaction. `enqueue` then caps at `MAX_IN_FLIGHT = 20` and sheds **from the
front**, so the last wallet in the config list survives, fetches, is not in the
transaction, yields `WALLET_NOT_IN_TX` — and is admitted to the seen-set anyway,
so the real swapper is deduped out and the swap is lost.

**Verified** (handoff 21): all 7 residual failures in the post-fix session were
attributed to `H8sMJSCQ…`, index 12 of 13 — the last wallet — while the
transactions were swaps by `popo3Rj6…` and `HSsJjkHr…`, with `meta` present, key
lists matching, and the attributed wallet appearing nowhere in the transaction.

**This supersedes the null-window explanation** given in handoff 20. That was
wrong: a `null` fetch produced no record at all pre-fix, so it cannot have
produced the 1,929 `WALLET_NOT_IN_TX` records the rate was computed from.

Scale, from the pre-fix session: swap-like unparsed rate **34.2%**, ~965 swaps.
The post-fix figure of 1.6% is **not** evidence the problem is solved — that
window had almost no live traffic. Re-measure after fixing the attribution, with
`npx tsx scripts/classify-unparsed.ts <session.jsonl>`.

**The fix is to map subscription id → wallet** from the `logsSubscribe` reply and
use `params.subscription` in `onMessage`. Consider also keying the seen-set by
`(wallet, signature)`: even with correct attribution, one transaction genuinely
involving two tracked wallets needs parsing once per wallet.

Related, now visible: `queue-overflow` is recorded under its own tag
(`tracker:stream-queue-overflow`) rather than as an `error` the recorder excludes
by name. It fired **30 times in one hour** on a quiet feed — the front-shedding
step of the mechanism above.

**Handoff 17 is untouched by all of this.** The wallet decision was computed from
`calibrate-delays.ts` and `export-wallet-history.ts`, which page signatures
themselves and call `parseSwap` directly, never through `walletStream`.

## Environment traps

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
