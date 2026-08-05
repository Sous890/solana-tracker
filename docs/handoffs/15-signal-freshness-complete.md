# Handoff 15 — item 1 complete: signal freshness

**Status: item 1 is DONE. Typecheck clean, build clean, 806 passing.**
Items 2-5 from the original prompt are untouched and remain the next work.

---

## Stop here first

The tree is healthy. The one failure you may see is **not yours**:

```
tests/soak.test.ts > crash drill > survives a real SIGKILL
```

Pre-existing timing race on whether the child opens a position before the
SIGKILL lands. Measured across this session: **2/5 full-suite runs**, matching
handoff 14's ~25%. It failed at the same rate before any of this work existed
(5/8 on the untouched tree). **Do not chase it. Do not widen a timeout without
saying so out loud.** Everything else is green on every run.

Baseline moved: **769 → 806 passing** (+37).

Process table was clean at start and at finish (`0` matches for
`serve.ts|soak-child`). The tracker that had been running on 127.0.0.1:8787 was
killed by PID at the start of this session and **was not restarted** — port 8787
is free.

---

## What was built

The rule: **a buy whose originating swap is older than `maxSignalAgeMs` is
refused as `STALE_SIGNAL`.** Sells are never age-gated.

| File | Change |
| --- | --- |
| `core/types.ts` | `SwapSource`; `source` + `observedAt` required on `TrackedSwap`; `signalAt?` + `signalAgeMs?` optional on `OrderIntent` |
| `core/config.ts` | `maxSignalAgeMs` (default 15 000); `LIMITS.MAX_SIGNAL_AGE_MS = 300_000`, `LIMITS.MIN_SIGNAL_AGE_MS = 5_000`, both in `superRefine` |
| `core/guards.ts` | `STALE_SIGNAL` code; **gate 3** in `guardBuy`; gates 3-8 renumbered 4-9; module header updated |
| `adapters/swapParser.ts` | optional `SwapStamp` third parameter, fail-closed defaults. Still pure, still no clock |
| `adapters/walletStream.ts` | `source` threaded through `enqueue`/`drain`/`handle` (live) and `gapFill` (gapfill); `observedAt` stamped from the injected clock |
| `services/strategyRunner.ts` | exported `signalOf()`; stamps provenance in `onTrackedSwap`, spread **after** `...draft` so a strategy cannot forge it |
| `services/tracker.ts` | `intent-created` event now carries `signalAt`/`signalAgeMs` |
| `strategies/mirror.ts` | comment only — no filter. See "decisions" below |
| `config.example.json` | documents the new field |

Tests: `tests/signalFreshness.test.ts` (new, 14), plus additions to
`guards.test.ts` (+7), `config.test.ts` (+7), `walletStream.test.ts` (+4),
`swapParser.test.ts` (+3), `replay.test.ts` (+2).

The one that matters, and it passes: **50 backfilled swaps carrying
20-minute-old `blockTime`s, fed while status is already `running`, produce zero
fills and zero positions — and 50 visible `STALE_SIGNAL` rejections.** It is
paired with a counterweight test asserting the *same 50 swaps do fill* when
their `blockTime`s are fresh, so the zero can never be mistaken for an inert
stack.

---

## Decisions a fresh session should not silently reverse

### 1. The age check lives in `guards.ts` ALONE

Handoff 14 proposed also filtering in `mirror.ts`. That was corrected and the
correction is load-bearing: if the strategy filters first, no intent is created,
no `intents.rejection_code` row is written, and the `STALE_SIGNAL` counter reads
zero forever while the bot quietly declines to trade. The only evidence would be
a debug line.

`mirror.ts` now carries a comment block explaining this. **Adding a `return
null` there would look like a tidy optimisation and would blind item 5's UI
counter.**

### 2. `maxSignalAgeMs` has a FLOOR, not just a ceiling

`MIN_SIGNAL_AGE_MS = 5_000`. `blockTime` is a stake-weighted median of validator
claims, not a clock — it drifts seconds from wall time in normal operation. A
value like 2000 would reject genuinely live signal, intermittently, with no
error, surfacing only as a bot that stopped trading. Refusing the config is the
loud version of that failure.

### 3. Expiring on `blockTime` contradicts its own docstring

`TrackedSwap.blockTime` says *"never order or expire on it"*. Carried over from
handoff 14 and still the position: that warning is about **ordering** —
`blockTime` is non-monotonic across slots — and expiry only needs it roughly
right in absolute terms. `signalOf` clamps a future `blockTime` to age 0 so a
validator running ahead cannot produce a negative age.

### 4. Null `blockTime` fails closed on gap fill, open on live

This is why `observedAt` exists.

- `live` → `observedAt` is a sound proxy; we watched it arrive.
- `gapfill` → `observedAt` says only when *we fetched it*, which for a backlog
  is "just now" regardless of the transaction's real age. Trusting it would hand
  the gate a stale swap wearing a fresh timestamp — the exact bug. So
  `signalAt = 0`, the age is enormous, and the gate refuses.

### 5. Unstamped means stale, everywhere

`parseSwap` defaults to `source: 'gapfill', observedAt: 0`. `decodeSwap` does
the same for payloads missing the fields. A caller that forgets to stamp loses
trades; the opposite default would silently buy on a backlog.

### 6. `signalAgeMs === undefined` PASSES the gate

An operator's manual buy and every `onPriceTick` exit have no originating swap,
so there is no age that could be wrong. Rejecting them would turn a freshness
gate into a bar on manual trading. Every strategy-originated buy is stamped by
`StrategyRunner`, so nothing reaches the gate unstamped by accident.

---

## Known consequences, flagged rather than fixed

### The age is on the event stream, NOT in the ledger

`intents.rejection_code` records *that* a `STALE_SIGNAL` refusal happened — that
is existing ledger behaviour and works. But `signalAgeMs` itself has no column,
and **`db/ledger.ts` was out of scope**. So "how stale were the rejected
signals?" is answerable from `GET /events` and from a recorded session, and not
from a SQL query after the fact. If that matters, it needs a ledger migration
and explicit authorisation.

### Replaying the two existing session files will now produce ZERO buys

Both `sessions/*.jsonl` were recorded hours ago. Their swaps carry real
`blockTime`s, so `signalOf` will compute ages in the hours and every buy will be
refused as `STALE_SIGNAL`.

**This is expected and is exactly what item 2 already plans for** — "add a
replay flag that overrides `blockTime` freshness so recorded swaps are treated
as live at their recorded offsets (replay only — never reachable from the
running tracker)". Do not discover this as a bug and do not fix it by loosening
the gate.

### Test-fixture construction sites now assert `source: 'live'`

Six fixture files were updated with `source: 'live'` and a coherent
`observedAt`. Their `blockTime`s are 2023-era constants against a `NOW` of
`1_700_000_000_000`, so they are fresh *relative to their own harness clock*. A
fixture that later gets a real `Date.now()` clock will start failing the gate —
that would be correct behaviour, not a regression.

---

## Item 1 exit criteria, verbatim from the original prompt

| Criterion | |
| --- | --- |
| gapfill swap 10 min old produces no intent | **PASS** — and no fill; the intent is created deliberately so the refusal is countable |
| live swap 2s old produces an intent | **PASS** |
| intent with stale `signalAgeMs` rejected by guards directly | **PASS** — `guards.test.ts`, gate 3 |
| a SELL with a stale signal is NOT rejected | **PASS** — two tests, one under a tightened window |
| reconnect: 20-min drop, 50 backfilled swaps while `running`, zero buy intents | **PASS** — zero *fills* and zero positions; 50 intents exist by design, all refused |

Note the deliberate deviation on the first and last rows: the prompt said "no
intent" / "zero buy intents". Under correction 1 the intent **is** created and
then refused, because that is what makes the rejection countable. What the
criterion was protecting — no exposure — holds: zero fills, zero positions.

---

## Constraints still in force

- `Broker` interface unchanged. Verified.
- `TrackedSwap` / `OrderIntent` additions are additive only. No field removed.
- `Tracker.start()` status-flip ordering **unchanged**. Verified.
- Paper mode only. No keypair path created or loaded.
- `core/` authorisation covered `types.ts`, `config.ts`, `guards.ts` only. It
  did **not** extend to `ledger.ts` — and `ledger.ts` was not touched.
- Strategies stayed pure. `tests/strategy.test.ts` greps `src/strategies/` for
  `Date.now`, `Math.random`, `fetch` and passes.

## Next: items 2-5, unchanged from handoff 14

2. Exercise the buy path from the recorded sessions (needs the replay freshness
   override described above).
3. Wallet copyability statistics — **still blocked, `calibrate.py` does not
   exist anywhere in this project.** Decide with the user: implement the three
   statistics fresh and label them as new, or locate the real file.
4. Venue identification — `VENUE_PROGRAMS` has only 3 entries; `whirlpool` and
   `meteora-dlmm` are declared in `SwapVenue` with no program ids at all. Check
   the Jupiter aggregator first.
5. UI counter — live vs gap-filled split, plus `maxSignalAgeMs` and the
   `STALE_SIGNAL` count. The event payload now carries what this needs.

## Verify

```bash
cd "/Volumes/LaCie/Operation grootenstine /solana-tracker" && npm run typecheck && npm test && npm run build
```

806 expected. A lone crash-drill failure is the known flake; anything else is new.
