# Context handoff — end of the 2026-08-10/11 working session

Head: `0a078be`. **960 tests, 23 files, all passing.** Typecheck clean. Working
tree clean. Paper mode throughout; no keys, no `liveBroker`, no live trading.

Ledger: **0 pending intents**, 2 open positions, 0 unacknowledged orphans.

Read `claude-project/00-START-HERE.md` and `01-architecture-and-invariants.md`
first if you have no context at all. This file is what changed since that bundle
was written (`39054b2`) and what to do next.

---

## The one-paragraph version

Startup used to gap-fill before connecting, so a long backlog meant the bot saw
nothing — a 132-minute soak captured **zero** live swaps. That is fixed: the
socket now connects first (0.00s) and the first live swap arrives at 0.50s. Two
soaks ran; the second passed its gate with 144 live-parsed swaps. Along the way
the runs surfaced that one tracked wallet floods the feed with failed
transactions, that 92.5% of all fetches were confirming failures already known
from the notification, and that the wallet set contains a wallet whose round
trips close faster than this process can enter them. All three are now handled.

---

## What landed, in order

| Commit | What |
|---|---|
| `6ae46b0` | Lost wakeup: a socket death during post-reconnect gap fill was dropped |
| `e84497d` | Recorder attribution — `slot` on fetch-window, `wallet`/`slot`/`source` on unparsed |
| `667457c` | Split `disconnects` into socket deaths vs connect-attempt failures |
| `a64422e` | Death-injection tests, barrier precondition enforced, `deferred` bounded |
| `804724b` | Barrier was quadratic (mine); recorder stats latched |
| `d40fc56` | Price loop scheduled before the feed, so a slow fill cannot strand positions |
| `6a2e680` | Warm gap fill bounded; truncation announced as an acknowledged gap |
| `462fd87` | `running` bound to a live socket, not to `start()` returning |
| `e32038e` | **Connect before filling** — a swap during startup can now become a trade |
| `1157723` | Serialized wallet-loop passes; bounded warm *paging*, not just handling |
| `ab23577` | Classify a failed transaction at ingress instead of fetching to confirm it |
| `4cee1ed` | Instrument the delay budget — queue residency and depth |
| `5ac8793` | Latch an exit that arrives while its entry is in flight; `UPSTREAM_UNAVAILABLE` decision lines |
| `0a078be` | Per-wallet admission gate — refuse a wallet we cannot copy |

---

## The two soaks

**First (2026-08-10, 22:54Z): CRASHED at 37 min.** `reserve without hold`. Cause
was mine: `start()` calls `gapFillAll()` directly so `reconnecting` never guarded
it, and once the socket was live during the fill, a death inside it began a
second concurrent pass whose `finally` released the first pass's barriers. Fixed
in `1157723`.

**Second (2026-08-11, 01:15Z): 132.0 min, gate PASSED.**

| Prediction | Actual | |
|---|---|---|
| Socket connected < 10s | **0.00s** | ✓ |
| First live swap < 2 min | **0.50s** | ✓ |
| Startup fill 4–6 min | **4.33 min, 13/13** | ✓ |
| Live parsed swaps ≥ 90 | **144** | ✓ gate |
| `unhandledTotal` 0 | 0 | ✓ |
| `peakOutstanding` ≤ 100 | 99 | ✓ |
| `barrier.heldNow` final 0 | 0 | ✓ |
| `paperBalanceDrift` 0 | 0 | ✓ |
| `history-skipped` 10–13 | **4** | missed |
| `peakDeferred` < 50 | **474** | missed 9.5× |
| `STALE_SIGNAL` 200–700 | 137 | under |

**Environment verified**: 0 sleep events across the window against 36 in a 3h
control. Numbers are valid.

205 entry intents, **1 fill** — the first end-to-end trade this system has ever
completed.

---

## Findings that changed the picture

### One wallet floods the feed with failures

`BCagckXe` emitted ~250 failed transactions/minute. **92.5% of all fetched
transactions were `TX_FAILED`** (5,931 of 6,409); that wallet ran 99.7% and
produced **zero** parsed swaps from 5,965 fetches. 242,924 signatures were shed
to a queue capped at `MAX_IN_FLIGHT = 20`, of which **0.17% were ever
recovered** — shed means lost. Productive wallets lost up to **42.6%** of their
own traffic to eviction.

`ab23577` stops fetching to confirm what `err` already says, on both paths.

### The one completed trade was uncopyable

`C86oRMyU` bought at slot 438520900 and **sold at 438520901** — the next slot.
The exit arrived 316ms after the entry signal and 1,022ms *before* our own buy
filled, so `mirror` saw no position, correctly returned null, and the signal
vanished. `5ac8793` latches it.

### Hold-time analysis: the wallet set is 83% copyable

n=147 paired round trips (session 26), against a 5,479ms chain-to-fill: **17.0%
of round trips close before we could enter**. Per wallet it is bimodal —
`popo3Rj6` is **100% uncopyable** (every round trip exactly 3 slots, median
−49.1%), everything else ≤ 35%.

Re-measured over the whole post-routing-fix corpus (n=3,520): `popo3Rj6` 100.0%,
**`C86oRMyU` 45.2%** (not the 19% the small sample showed), `AgiGpUAF` 20.1%,
rest ≤ 10.3%.

`0a078be` gates on this. `popo3Rj6` is refused; `C86oRMyU` is admitted and only
just.

### Numbers withdrawn

- **1.40 live swaps/min** — measured from `fetch-window`, which only exists for
  signatures that were *fetched*, so it cannot see anything shed. Replaced by
  1.09/min live-parsed over 132 min.
- **25,878 disconnects vs 56 reconnects** — 99.6% were connect-attempt retries.
  Real socket deaths ≈ 39. The inference drawn from that ratio is withdrawn.
- **`fit_alpha_half_life` returns `inf`, r² = 0.000** on the replay export
  (n=104). No measurable alpha decay. **Do not quote a half-life.**

---

## Open work, in priority order

1. **Re-soak** against `b03594e`'s pre-registration. Same thirteen wallets — the
   thirty candidates stay parked because removing `BCagckXe` would drop fetch
   load ~92% by itself and make `ab23577`'s ~92.5% prediction untestable. One
   variable.
2. **Task 1 — guard exception containment.** Gates 7/8 in `core/guards.ts` still
   `await` into the broker with no `try`. 49 of 205 entry intents (24% of
   non-filling) were `QuoteUnavailableError`. They now get a decision line
   (`5ac8793`) but the guard contract is still not held.
3. **Round-robin the gap-fill drain.** Blocked: the cursor barrier is **not
   reentrant** and `hold()` throws on a double hold. Make it counted first.
4. **Prompt 17's slow loop.** `scripts/score-wallets.ts` is a stand-in. The
   artifact shape is the seam; moving the producer changes nothing for the fast
   loop.
5. Remaining four Task 4 thresholds; the 66.4% `venue: 'unknown'` population.
6. **Task 5 is off the list** — `db/ledger.ts` sign-off was requested three times
   and never given, so fill-time capture for the 30 bps recalibration does not
   exist and every soak still produces unusable fills.

---

## Things that will bite you

- **`config.json` and `data/` are gitignored.** The `popo3Rj6` removal and
  `data/wallet-scores.json` are local only. Regenerate scores with
  `npx tsx scripts/score-wallets.ts`.
- **Absence is a refusal.** A wallet with no score is refused `WALLET_UNSCORED`.
  Every test harness supplies `copyableScores` from `tests/fixtures/scores.ts`.
  The thirty candidate wallets will all be refused until scored — intended.
- **The admission gate and the exit latch sit behind `driver === null`.** A
  tracker with no strategy is a pure observer; tests need a stub driver.
- **The recorder rotates.** Always read *both* session files. A first pass over
  file one alone produced a wrong reading twice this session.
- **`intent-created` and `fill` are excluded from the recorder by name**, so the
  trading path reconciles only against the ledger. This is deliberate and the
  reasoning is written where the exclusion list lives.
- **A quiet soak is not evidence.** The lost-wakeup fix and the silence detector
  still have no live confirmation — 0 socket deaths in both runs. `not
  contradicted` ≠ `verified`.

---

## Standing conventions

Red before green. Every number carries `n` and its window. A broken existing
test is a finding — say what it asserted and why it is *stale*. Report what you
could not prove, by name. Commits are long-form and explain reasoning. `rm -rf`
only under `scratch/`. Soaks run under `caffeinate` or their numbers are void.
