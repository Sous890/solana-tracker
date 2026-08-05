# solana-tracker — project status

**A standalone brief. Everything here was verified from the code and the
database on 2026-08-05, not recalled from conversation.**

Give this to Claude to write the next session's prompt.

---

## What this is

A wallet-mirroring execution engine for Solana. It watches tracked wallets over
a websocket, parses their swaps, and — in **paper mode only** — mirrors their
entries through a guard layer into a SQLite ledger.

TypeScript. Node 24. `vitest`. **There is no Python package** — the only Python
is `analysis/`, which holds two files the operator supplied (`calibrate.py`,
`master_equation.py`) plus scripts that drive them offline.

- Repo: `/Volumes/LaCie/Operation grootenstine /solana-tracker` (note the
  trailing space in the parent directory name — it breaks naive shell globs)
- Clone: `~/dev/solana-tracker` on APFS
- One commit: `d5e2d09 initial: tracker, guards, ledger, adapters, calibration, UI`, 151 files
- **No remote.** A private remote is the single biggest missing safeguard.

---

## The headline result

**The bot works end to end. The wallets it was pointed at lose money.**

Six complete paper round trips on 2026-08-05, over 2h43m, real Helius mainnet:

```
GvUCjmWSXA…  in 0.0500 SOL  out 0.0494  -1.24%  held 1.6s
E2BLSv4tXo…  in 0.0500 SOL  out 0.0474  -5.18%  held 0.6s
UMGAp8U5dB…  in 0.0500 SOL  out 0.0474  -5.22%  held 1.2s
Agmu8Xgn7r…  in 0.0500 SOL  out 0.0472  -5.56%  held 1.4s
Fd1n1x7E5f…  in 0.0500 SOL  out 0.0480  -3.99%  held 0.5s
9uNefL6Bci…  in 0.0500 SOL  out 0.0487  -2.67%  held 1.4s

n=6   wins=0   mean -3.98%
daily_pnl: -0.0129 SOL realised, 0.00102 SOL fees, 12 trades
```

Detected → intent → guard → fill → position closed, all six. Every stage of the
pipeline has executed against live data.

Intent breakdown, 290 total:

| rejection_code | n |
| --- | --- |
| `STALE_SIGNAL` | **272** |
| *(executed)* | 12 |
| `CANNOT_SELL:SCREEN_FAILED:LIQUIDITY_BELOW_FLOOR` | 3 |
| `PRICE_IMPACT_EXCEEDED` | 2 |
| `CANNOT_SELL:SCREEN_UNKNOWN:MINT_AGE_UNAVAILABLE` | 1 |

94% of signal is discarded as stale. That gate is working as designed — but
whether 15s is the *right* window is unmeasurable today (see gap #2).

---

## Both tracked wallets were formally rejected

Run through the operator's own `master_equation.py` at M=50, TAU=0.005
(handoff 17, `exports/part1-decision.2026-08-05T17-47-19.txt`):

```
HSsJjkHr… @ 1s : NO TAKE — EV -11.06%  (NO TAKE at M=1 too: EV -7.56%)
HSsJjkHr… @ 2s : NO TAKE — EV -11.86%
HSsJjkHr… @ 5s : NO TAKE — EV -10.19%
popo3Rj6…      : NOT EVALUABLE — no delay buckets exist for it
```

**Why: the payoff ratio inverts under latency.** The wallet's own decisions have
payoff 1.20 and clear a 45.51% breakeven. A copier's have payoff **0.60** —
average loss nearly twice average win — putting breakeven at **78.00%** against
a 37.93% win rate. A copier buying at the pool's realised price does not get the
wallet's fill; the wallet's entry is the good print, the copier's is the one
after it. **Wins shrink, losses don't.**

The six live round trips above are that rejection reproduced in practice.

⚠️ **Caveat carried forward:** the delay-bucket sample failed its own
representativeness test — a **23.20pp** win-rate gap against the decision frame
on the same mints. The *verdict* survives (it fails by 30-60pp), but the
*magnitudes* are unreliable.

---

## What is real, verified in code

**36 source `.ts` files, 30 test files, 851 tests, ~5.3s.**
`find src -name "*.ts"` returns 72 — half are exFAT AppleDouble `._*` files.

**Zero TODO / FIXME / it.skip / describe.skip in the entire repo.**

| dir | files | lines | state |
| --- | --- | --- | --- |
| `src/core` | 7 | 1728 | types, config + floors, broker protocol, guards, strategy contract, units |
| `src/adapters` | 10 | 3252 | RPC, wallet stream, swap parser, Jupiter, DexScreener, paper broker, safety screener |
| `src/services` | 8 | 4005 | tracker, strategy runner, recorder, wallet store, control API, params store |
| `src/db` | 4 | 1445 | ledger + reconcile, cursors, runtime flags, fills view |
| `src/strategies` | 2 | 273 | mirror, equation |
| `src/cli` | 3 | 644 | serve, orphans, soak |
| `src/ui` | 1 html | 512 | screener page, M/TAU panel, SSE feed |
| `src/calibration` | 2 | 927 | pool history, delayed-entry replay |

Specifically **not** placeholders:

- **Sellability screener** — `MINT_AUTHORITY_LIVE`, `FREEZE_AUTHORITY_LIVE`,
  Token-2022 extensions incl. transfer hooks, `MINT_TOO_YOUNG`,
  `LIQUIDITY_BELOW_FLOOR`, `NO_ROUTE_IN`, `ROUND_TRIP_RETENTION_LOW` (the
  reverse-quote honeypot test), `PRICE_IMPACT_HIGH`. 71 tests.
- **Crash recovery** — `reconcileOnStartup` at `ledger.ts:1092`, called from
  `tracker.ts:547`. Two real-SIGKILL tests.
- **Wallet stream** — reconnect with full-jitter backoff; `gapFill` pages
  `until: cursor.lastSignature` with a `MAX_COLD_FILL` cap. 17 tests.
- **Signal freshness** — `STALE_SIGNAL` guard gate 3, `source: live|gapfill`,
  `signalAt`/`signalAgeMs` stamped by the runner (a strategy cannot forge them).

---

## Known gaps, all biased the same way

Every one of these makes a wallet look **more** copyable than it is.
Full detail in `CLAUDE.md`.

1. **`fit_alpha_half_life` is misspecified**, not under-fed. Forward return goes
   +0.40% → −0.92% between 0s and 1s. `2^(-dt/T)` is strictly positive; no `T`
   represents a sign flip. Do not force a fit.
2. **`signalAgeMs` is not persisted to the ledger.** The code is stored, the age
   is not. 272 rejections and no way to tell whether the window is right.
3. **The raw export counts EXITS, not DECISIONS.** One row per FIFO tranche, so
   a mint scaled out of five times votes five times. Win rate 55.0% per tranche
   vs **48.7%** per decision — the 50% line falls between them. **Always feed
   `{wallet}.decisions.csv` to `realised_stats`, never `{wallet}.csv`.**
4. **Timestamps are millis in the export, seconds in `calibrate.py`.**
   `realised_stats` never reads them; `insider_share` would be wrong by 1000×
   and silently return 0.0.
5. **`insider_share` has no `launch_ts` source.** Never substitute
   first-seen-in-session.
6. **Own detection latency unmeasured.** `getTransaction` round trip is p50
   201ms (n=20). The detection leg is *not* measured — `getTransaction` returns
   null at the instant the notification arrives, so it needs a retry loop.
   `example.py` assumes 1.2s; the measured cliff sits inside the first second.
7. **Pre-graduation pump.fun mints break `PoolState`.** A bonding curve is not
   constant-product.
8. **No replay-determinism test on a real session file.** The byte-identical
   assertion covers the calibration delays CSV only.
9. **Fill-rate survivorship**: 100% → 37.5% across the delay range. Long-delay
   buckets shed their worst trades, so measured decay is too shallow.

---

## Test suite is NOT reliably green

`tests/soak.test.ts` is flaky. Measured this session: **5 of 6** isolated runs
failed at one point, **1 of 3** later. Two distinct tests:

- `crash drill > survives a real SIGKILL` — `expected 0 to be greater than 0`;
  the child races a fixed delay against opening a position.
- `rotation > does NOT reset seq across a rotation` — rarer.

It is **not** AppleDouble pollution and **not** the live server: the test uses
`mkdtempSync` on APFS. It is load-dependent. Prior handoffs recorded ~25%; it is
noisier than that. **A green run currently proves very little.**

Everything outside `soak.test.ts` has been consistently green.

---

## Environment gotchas that cost real time

- **exFAT.** Case-insensitive, drops file modes, mounts `noowners`, sprays
  `._*` AppleDouble files that inflate every `find`. The APFS clone fixes modes
  but **macOS APFS is also case-insensitive** — only a case-sensitive host
  catches import-case bugs.
- **`~/Downloads` is TCC-blocked.** `ls` works, `cat` returns
  `Operation not permitted`. Neither a sandbox override nor a granted directory
  lifts it. To hand over a file, copy it onto the LaCie volume.
- **Helius rate-limits at ~10 rps.** Two RPC-heavy scripts at once kills both.
  It returns `Service overloaded` as a JSON-RPC error with **HTTP 200**, so a
  status-code-only retry never sees it.
- **`pkill -f "tsx src/cli/serve.ts"` does not match** (the path has a space),
  and killing the wrapper orphans the node process beneath it. Kill by PID from
  `ps aux | grep serve.ts`, verify with `ps`. Leaked children once held SQLite
  open and produced a `SQLITE_BUSY` misdiagnosed as a production defect.
- **Calibration runs cost ~30 min and ~12,000 RPC calls** for 70 mints. 220
  mints was on track for 3.7 hours.

---

## Standing constraints — carry these into every prompt

- **The sell path is never gated by a risk limit.** If a change adds a condition
  that can block an exit, stop. A risk limit that blocked a sell would trap the
  bot in the position it was warning about.
- **Never loosen a config floor, a guard check, or a test assertion** to make
  something pass.
- **`src/core/` may not do I/O or make network calls.** `zod` is an accepted
  dependency; the invariant is no I/O, not zero dependencies. `config.ts`'s
  `readFileSync` is the single deliberate exception.
- **`db/ledger.ts` is off-limits without explicit sign-off.**
- **Paper mode only.** No keypair path may be created or loaded.
  `createTrackerRuntime` throws on `mode: "live"` — there is no live broker.
- **Do not change the status-flip ordering in `Tracker.start()`.**
- **A rejection is a valid output.** Do not adjust TAU, `kelly_fraction` or M to
  open a gate.

---

## Suggested next work, priority order

Ordered by what stands between here and a paper soak worth calibrating on.

**1. Stabilise `tests/soak.test.ts`** — ~half a day.
Unblocks trusting the suite at all. Make the crash drill poll for the position
then kill, rather than sleeping a fixed interval. Skipped: every session
re-litigates whether a red run is real.

**2. Persist `signalAgeMs` to the ledger** — ~half a day. **Needs sign-off:
touches `db/ledger.ts`.**
Unblocks tuning `maxSignalAgeMs` from evidence. 272 rejections are currently
uninterpretable. Skipped: the freshness window stays a guess.

**3. Replay-determinism test on a real session file** — ~half a day.
Unblocks trusting the calibration pipeline. Three real session files exist and
the harness has never been asserted to reproduce one twice. Skipped: a
nondeterminism bug surfaces as a shifted half-life nobody can reproduce.

**Deliberately not listed:** fixing the delay-bucket sampling. It is the most
interesting problem here, but both wallets are already rejected on copier
economics — better sampling refines a number that decides nothing until
different wallets are supplied.

**The strategic question this repo cannot answer for itself:** the engine works;
the two wallets chosen do not survive a copier's economics. The next real
decision is whether to source better wallets or to stop. Nine more addresses
were mentioned but never delivered — `watchlist.html` is still TCC-blocked.

---

## Useful commands

```bash
cd "/Volumes/LaCie/Operation grootenstine /solana-tracker"

npm run typecheck && npm test && npm run build   # 851 tests, ~5s
npm run serve                                    # screener at 127.0.0.1:8787

npx tsx scripts/export-wallet-history.ts --days 30 --max-signatures 5000
npx tsx scripts/aggregate-decisions.ts <wallet>  # -> decisions.csv, USE THIS ONE
npx tsx scripts/calibrate-delays.ts --wallet <w> --sample 70 --recent

python3 analysis/run_stats.py <wallet>           # realised_stats
python3 analysis/part1_decide.py                 # the equation; reads data/analysis-params.json
```

Read `README.md` for architecture, `CLAUDE.md` for the known-gaps list, and
`docs/handoffs/` (05 → 17) for how each decision was reached. Handoff 17 is the
wallet rejection; 16 is the alpha-decay harness.
