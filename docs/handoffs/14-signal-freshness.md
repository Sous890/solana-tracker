# Handoff 14 — signal freshness, replay, wallet diagnosis

**Status: item 1 is HALF DONE AND THE TREE DOES NOT TYPECHECK.** Read the
"stop here first" section before touching anything.

---

## Stop here first

`npm run typecheck` currently fails with **8 errors**. This is expected and is
mid-edit state, not a mystery to debug. `source` and `observedAt` were added as
**required** fields on `TrackedSwap`, and the construction sites have not been
updated yet. The failing files are:

```
src/adapters/swapParser.ts:407      the real producer
src/services/recorder.ts:162        replay reconstruction
tests/fixtures/soak-child.ts:64
tests/replay.test.ts:45
tests/replay/synthetic.ts:47
tests/soak.test.ts:39
tests/strategy.test.ts:186
tests/tracker.test.ts:899
```

Before the edits began the suite was **769 passing, typecheck and build clean**.
Any failure you see that is not in the list above is new and is yours.

A second, separate thing that is NOT a bug: `tests/soak.test.ts > crash drill >
survives a real SIGKILL` is **intermittently failing at roughly 25%**. Measured
this session: 2/8 failures on the current tree, 5/8 on the tree without any of
these changes. It is a pre-existing timing race on whether the child opens a
position before the SIGKILL lands. Do not chase it. Do not "fix" it by widening
a timeout without saying so.

---

## Live environment

- A tracker is **running right now** on `http://127.0.0.1:8787`, paper mode,
  status `running`, watching two live wallets. It has been up for hours.
  - `HSsJjkHrxezZ1SdhgdivhDGXbxANicWbKvKsVtrMrJvG`
  - `popo3Rj6arKNttyUFpWfbkv2gG8uS13TGtmH6JPMuHz`
- Kill it with `kill <pid>` where pid is from `ps aux | grep serve.ts`.
  `pkill -f "tsx src/cli/serve.ts"` does **not** match — the path contains a
  space (`/Volumes/LaCie/Operation grootenstine /solana-tracker`, note the
  trailing space in the directory name). Killing the `npx`/`tsx` wrapper
  orphans the `node` beneath it; that mistake cost an earlier session hours by
  leaving ~50 spinning children that held SQLite open and produced a
  `SQLITE_BUSY` that was misdiagnosed as a production defect. Kill by PID and
  verify with `ps`.
- `.env` lives in `solana-tracker/`, not the parent. Helius RPC works
  (`getHealth` → ok). Jupiter and DexScreener both answer.
- Two recorded session files exist and are the raw material for item 2:
  `sessions/20260804T213640Z-000.jsonl` (101 lines)
  `sessions/20260804T213731Z-000.jsonl` (106 lines)
  Combined: **129 parsed swaps (52 buys / 77 sells), 80 unmodeled.**
  Verified: the Helius API key appears **0 times** in either file.

---

## The problem this work exists to fix

129 swaps parsed, **0 intents created, 0 positions, 0 fills**. Root cause,
established from the event sequence numbers and not inferred:

`WalletStream.start()` runs the gap fill *inside* `Tracker.start()`, before
`setStatus('running')`. `Tracker.onSwap` drops every swap unless status is
already `running`. So 100% of startup gap-fill signal is discarded.

```
seq 127-212   gap fill (100, truncated)  -> status idle -> all dropped
seq 213       status = running
seq 219-319   gap fill (100, truncated)  -> status idle -> all dropped
seq 320       status = running
seq 321-326   6 events, zero swap-detected
```

**Discarding stale startup swaps is correct.** The defect is that it is an
accident of initialisation order rather than a rule — and on *reconnect*
mid-run, status is already `running`, so an arbitrarily old backlog replays
straight into the strategy at full position size. That is the case that is
broken today and the reconnect test below is the one that matters.

**Do NOT change the status-flip ordering in `Tracker.start()`.**

---

## Item 1 — what is done and what is not

### Done

| File | Change |
| --- | --- |
| `core/types.ts` | `SwapSource = 'live' \| 'gapfill'`; `source` + `observedAt` **required** on `TrackedSwap`; `signalAt?` + `signalAgeMs?` optional on `OrderIntent` |
| `core/config.ts` | `maxSignalAgeMs` (int, positive, default 15000); `LIMITS.MAX_SIGNAL_AGE_MS = 300_000` + a `superRefine` check |
| `core/guards.ts` | `STALE_SIGNAL` added to `GuardCode`; gate inserted as **gate 3** in `guardBuy`; gates 3-8 renumbered to 4-9 |

### Not done

1. **`guards.ts` module header** — the entry-gate list at the top still omits
   signal freshness. One-line edit, was interrupted mid-apply.
2. **Every `TrackedSwap` construction site** (the 8 typecheck errors).
   Recommended: give `parseSwap` an optional stamp parameter defaulting
   fail-closed (`source: 'gapfill'`, `observedAt: 0`), so parser tests need no
   change, and have `WalletStream` override both with real values. `parseSwap`
   is pure and has no clock; `WalletStream` is the only component that knows
   the delivery path.
3. **`adapters/walletStream.ts`** — thread `source` through
   `enqueue`/`drain`/`handle` (live) and `gapFill` (gapfill). `handle()` is
   shared by both paths and currently takes `(wallet, entry)`.
4. **`strategies/mirror.ts`** — return `null` for a buy where
   `(now - blockTime) > maxSignalAgeMs`, log at debug with the age. **Sells are
   never age-gated.** Note the strategy must stay pure — `ctx.now()`, never
   `Date.now()`; `tests/strategy.test.ts` greps this directory for `Date.now`,
   `Math.random` and `fetch` and fails on a hit.
5. **`services/strategyRunner.ts`** — stamp `signalAt`/`signalAgeMs`
   authoritatively in `onTrackedSwap`. The runner overwrites whatever the
   strategy set, because the strategy is untrusted code (see that file's
   header) and one that could declare its own signal fresh could walk a backlog
   past the gate. The swap metadata needs threading from `onTrackedSwap`
   through `run()` and `execute()` to the `{ ...draft, id }` construction at
   roughly line 332.
6. **All five tests**, listed verbatim in the original prompt. The reconnect
   one is the point: simulate a 20-minute drop, feed 50 backfilled swaps with
   old `blockTime`s **while status is `running`**, assert zero buy intents.

### The `blockTime` decision you need to know about

`TrackedSwap.blockTime` is `number | null`, in **seconds**, and its own
docstring says *"never order or expire on it"*. This work expires on it anyway.
The reasoning, already written into `types.ts`: that warning is about
*ordering* — `blockTime` is non-monotonic across slots — and expiry only needs
it roughly right in absolute terms. If you disagree, say so rather than
silently reverting; the alternative is having no notion of signal age at all.

Null `blockTime` policy, implemented via `observedAt`:
- `live` → `observedAt` is a sound proxy, age ≈ 0.
- `gapfill` → not a proxy for anything; **fail closed** at the gate.

`signalAgeMs === undefined` passes the gate deliberately: it means the intent
did not come from an observed swap (operator manual buy, every `onPriceTick`
exit). Rejecting those would turn the gate into a bar on manual entry.

---

## Items 2-5 — not started

### 2. Exercise the buy path from the recorded sessions

Nothing in the buy path has ever executed: guards, safety screener, paper
broker, price loop, exits. Replay infrastructure **already exists and is
substantial** — `tests/replay/{run,report,session,invariants,synthetic}.ts`,
~52 KB total, plus `npm run replay`. This is finish-and-wire, not build.

Needs: a replay-only flag overriding `blockTime` freshness so recorded swaps
count as live at their recorded offsets — **never reachable from the running
tracker**. Stub Jupiter and DexScreener from recorded responses; where a quote
was not recorded, **fail loudly rather than synthesising one**.

Report: intents created, guard rejections by code, fills, realised PnL, fees,
max drawdown, positions that hit `NO_ROUTE` while held. Then state which
components actually executed and which are still cold.

### 3. Are these wallets copyable at all

**BLOCKER: `calibrate.py` does not exist.** There is no Python anywhere in this
project — verified with `find`. `realised_stats`, `insider_share` and
`latency_adjusted_outcomes` cannot be run because they have not been written.

Options, pick one with the user: (a) implement those three statistics fresh and
label them clearly as a new implementation, not `calibrate.py`'s; (b) locate
`calibrate.py` if it exists outside this repo. Do not silently invent a
`calibrate.py`-shaped thing and report numbers as though they came from it.

`launch_ts` in the requested schema also has no local source — it needs an
external lookup or a per-mint earliest-transaction RPC walk. Say which you used.

Independently derivable from the session files right now, no blocker:
failed-tx rate per wallet, and whether failures cluster by mint or time.
Baseline already measured: **58 of 80 unmodeled records are `TX_FAILED`**
(16 `NO_MINT_DELTA`, 3 `WALLET_NOT_IN_TX`, 3 gap-fill notices).

Report numbers, do not interpret. If `insider_share` is high or
`top_trade_share` > 0.5, say so plainly.

### 4. Venue identification

122/129 swaps are `venue: 'unknown'`; only 7 resolved (`raydium-clmm`).
`VENUE_PROGRAMS` in `swapParser.ts:51` has **only three entries** —
`raydium-v4`, `raydium-clmm`, `pumpfun` — while `SwapVenue` also declares
`whirlpool` and `meteora-dlmm` with no program ids at all. That alone explains
part of the gap before you reach the aggregator hypothesis.

Check Jupiter aggregator `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` as the
top-level program first, add aggregator detection, re-run the parser over the
session files, report the new breakdown.

Separately: flag which parsed mints are pre-graduation pump.fun bonding curves
(at least one mint ends in `pump`). A bonding curve is not constant-product;
`PoolState` / `exit_depth_ratio` do not describe its shape. **Flag only — do
not model the curve.**

### 5. UI counter (last)

`src/ui/index.html`, served per-request at `/` and `/ui`. Split the event feed
counters into live vs gap-filled; surface `maxSignalAgeMs` and the
`STALE_SIGNAL` rejection count in the status area.

---

## Constraints, carried forward

- `Broker` interface does not change.
- Additions to `TrackedSwap` / `OrderIntent` / Decision-shaped types are
  **additive only** — never remove a field, downstream logging depends on the
  audit trail.
- Paper mode only. Do not create or load any live keypair path.
- Do not change the status-flip ordering in `Tracker.start()`.
- `src/core/*` and `db/ledger.ts` were frozen for most of this project's life.
  The user explicitly authorised the `types.ts` / `config.ts` / `guards.ts`
  edits above. That authorisation does **not** extend to `ledger.ts` or to
  anything else in `core/` — ask first.

## Still open from earlier handoffs

- No 14-day soak has run. Record mode is unverified against a live RPC over time.
- Latency decay (handoff 13 item 4) is unimplemented; the 30 bps
  `paperLatencyPenaltyBps` remains unjustified.
- No live broker exists — `createTrackerRuntime` throws on `mode: 'live'`, by
  design.

## Verify before you report done

```bash
cd "/Volumes/LaCie/Operation grootenstine /solana-tracker" && npm run typecheck && npm test && npm run build
```

Baseline to beat: 769 passing. Then confirm no orphaned processes:

```bash
ps aux | grep -E "serve\.ts|soak-child" | grep -v grep
```
