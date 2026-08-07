# Handoff 24 — the host was asleep, and three counters were lying

**The single most important finding is that session 23's soak ran on a laptop
that was asleep for 84.9 of its 113.9 minutes.** Most of what that soak appeared
to show about the socket was the machine, not the code. Two real defects survive
the correction and are fixed; a third — the one this brief was most confident
about — does not survive, and I could not reproduce it.

Suite **900** (861 → 888 → 900), typecheck and build clean.

## Broken, deviated from, not done — first

**Three existing tests had to change.** The brief says that is a finding rather
than a step, so each is named here rather than left in a diff:

1. `tracker.test.ts` — "starts the price and screen loops", "keeps monitoring
   what it did not sell", and "is registered on the slower cadence" all pinned
   the tracker to exactly **two** scheduler intervals. Wiring `heartbeat()` adds
   a third. The assertions were exact statements about the old behaviour; they
   are now exact statements about the new one (`toBe(3)`, and the interval list
   gains `HEARTBEAT_INTERVAL_MS`). Nothing was weakened.
2. `replay.test.ts` — "subscribes to the tracker emitter" asserted the recorder's
   three-way classification with `rejection` in the *skipped output* limb.
   Rejections are now recorded as a `decision` line, so the count went 2 → 3. I
   added `intent-created` to the same test so the "skipped by name" limb still
   has a witness, which makes the assertion stronger than it was.
3. `soak.test.ts` — `digestOf()` handed the digest a **constant** ledger flow.
   That models a ledger which never moves, which is only indistinguishable from
   a real one while the file starts empty. It now starts at zero and moves,
   which is what production does.

**Two helpers were extended**, flagged for the same reason: `FakeStream` gained
`heartbeat()` (it is optional on `WalletFeed`, so no other fake broke), and
`fakeRpc`'s history is now mutated in place by one new test to simulate
signatures arriving while a socket is down.

**Task A's second defect is NOT established, and I think this brief is wrong
about it.** See below. I fixed what I could prove and said so.

**One thing I did not do:** guard gates 7 and 8 still `await` into the broker
with no `try`. I put the backstop in the tracker instead — see Task B for why
that is the right layer — but the guard layer's own exception behaviour is
unchanged and could still surprise a future caller.

---

## The correction that reframes session 23

Session 23 reported: the socket went quiet at +48.9 min, nothing noticed for 21.6
minutes, then 23 disconnects and 0 reconnects over 43 minutes. It concluded the
silence detector was dead (true) and this brief concluded the reconnect path was
broken (not established).

**`pmset -g log` says the host was asleep for 84.9 of the soak's 113.9 minutes.**
The three long "reconnect gaps" line up with sleep windows to within seconds:

| reconnect gap (UTC) | duration | machine state (local −0400) |
| --- | --- | --- |
| 16:40:50 → 16:58:07 | 1037 s | Sleep 12:41:05 → DarkWake 12:58:16 |
| 16:58:07 → 17:14:16 | 969 s | Sleep 12:58:18 → DarkWake 13:14:25 |
| 17:14:16 → 17:19:51 | 335 s | Sleep 13:14:27 → DarkWake 13:20:01 |

The session file stops entirely at 16:41:06 — one second after the 12:41:05 sleep
— and the price loop stops with it. `BACKOFF_MAX_MS` is 30 s and the connect
timeout is 15 s, so a 17-minute gap was never explicable by the code; that was
the tell I should have followed in session 23 and did not.

**Two numbers from session 23 are void as a result:**

- The "largest healthy gap between live deliveries was 4.5 minutes" was itself a
  sleep artifact. Excluding every gap that overlaps a sleep window, over 356
  samples: **p50 2.6 s, p90 14.8 s, p99 29.7 s, max 57.5 s**.
- "51 live-parsed swaps in 113.9 minutes" was measured across a window that was
  75% suspended.

This session's soak runs under `caffeinate -dimsu`. That is now the standing
requirement for any measurement on this host.

---

## Task A — two defects, only one of which was real

### A1. Nothing noticed — real, fixed

`WalletStream.heartbeat()` was called from **nowhere**: not `tracker.ts`, not
`serve.ts`, not `soak.ts`, not any test. `SILENCE_TIMEOUT_MS` and the
`missedHeartbeats >= 2` teardown were dead from the day the file was written.

Now driven by its own scheduler interval at `HEARTBEAT_INTERVAL_MS` (30 s),
alongside the price and screen loops, torn down with them.

**`healthy` is passed as `true`, and that is a partial.** The `missedHeartbeats`
limb wants an independent liveness signal, and this process has none that is
free — the only thing that could contradict the socket is another network call,
against a provider that rate-limits at ~10 rps. So the silence limb is the
detector and the other limb is inert. Stated rather than papered over with a
signal that always agrees.

**`SILENCE_TIMEOUT_MS` raised 90 s → 180 s**, from the cleaned distribution above:
~3.1× the worst genuinely-healthy gap (57.5 s), where 90 s was only 1.57×. The
margin protects against a **reconnect storm**, not a missed teardown: on a quiet
market a too-tight timeout tears down, gap fills, finds nothing, goes silent and
tears down again — 13 wallets of `getSignaturesForAddress` every 90 seconds. This
is a value chosen at the moment a dead constant became live, not a limit relaxed
to make something pass.

### A2. Nothing recovered — NOT established

The brief states this is "not an unmonitored outage — it's a broken reconnect
path", and asks which of five mechanisms. **None of them, on the evidence I have.**
21 of the 23 disconnects were `WebSocket connect failed: errored before opening`
during a window when the host was asleep or waking, with WiFi cycling
(`E_CONNECTION_LOSS`, `E_PFN_NET_FOUND` in the sleep log). A socket cannot open
while the interface is down. That is an environment failure wearing the costume
of a reconnect bug.

I could not reproduce a reconnect failure under fault injection. Reconnect
re-subscribes and backfills, and there is now a test that says so.

### A3. What I did find, and it is real

Two structural defects, both visible in the session file rather than inferred:

**One socket death started two reconnect chains.** `websocket error` at
16:36:43.037 and `closed` at 16:36:43.038 — a real WebSocket emits both on the
way down, and both reached `onDisconnect`, which started a chain each. That is
why reconnect attempts arrive in *pairs* for the rest of the run. Worse,
`connect()` routed its own failure back through `onDisconnect`, so the number of
live chains was set by how many ways a connection had failed and never came back
down.

Fixed structurally: `connectOnce()` never starts a chain, `reconnect()` is a
**loop** that owns retrying, and `beginReconnect()` admits one at a time.
`onDisconnect` uses `this.socket` as the flag, so the second event for the same
socket is a no-op.

**Wiring the heartbeat would have multiplied chains on a quiet feed.**
`lastMessageAt` only advances on a delivered frame, so during an outage every
tick still looks silent — and the old `heartbeat()` called `onDisconnect`
unconditionally. It now returns early when there is no socket. This defect did
not exist while the detector was dead; it would have arrived with the fix.

### Tests — fault injection, not soak observation

Five in `walletStream.test.ts`, plus three in `tracker.test.ts`.

| test | before | after |
| --- | --- | --- |
| silent socket past the timeout is torn down | **red** | green |
| no teardown inside the timeout | green | green |
| reconnect re-subscribes **and backfills** the missed window | **red** | green |
| one socket death → one reconnect, not one per event | **red** | green |
| heartbeat while disconnected starts no extra chain | **red** | green |
| tracker drives the heartbeat from a loop it registered | **red** | green |
| a teardown is reported as an error | **red** | green |
| liveness stops when the loops do | green | green |

Two were green throughout and are guards, not achievements: "no teardown inside
the timeout" (the false-positive bound) and "liveness stops when the loops do".

The backfill test is the one that matters — it asserts signatures that arrived
*while the socket was down* are delivered after reconnect, which is the
difference between "reconnected" and "recovered".

---

## Task B — intents that could never resolve

**Found, and it is a leak, not a legitimate state.**

Guard gates 7 and 8 do `await inner.getQuote(intent)` and
`await inner.canSell(intent.mint)` with no `try`. A quote outage therefore throws
a `QuoteUnavailableError` — **not** a `GuardRejection` — out of
`guarded().execute`, *before the inner broker runs at all*. So:

- the broker resolves its own failures, but it was never reached;
- the guard layer resolves its own rejections, but this was not one;
- the tracker's catch recognised only `GuardRejection` and otherwise just logged.

Nobody owned the row. It stayed `pending` for ever and `reconcileOnStartup`
turned it into a `CRASH_ORPHAN`, which shut guard gate 0 on the next boot.

**The timing is unambiguous, from the session file:**

| | |
| --- | --- |
| first `UPSTREAM_ERROR` quote | 15:51:36.011 |
| first intent that never resolved | 15:51:50.911 — **14.9 s later** |
| quote error rate before that boundary | 16 / 269 = **5.9%** |
| quote error rate after | 773 / 1100 = **70.3%** |

And the ledger splits cleanly: **all 8 fills are intents ≤ 00014; all 6 orphans
are ≥ 00015.** Not sporadic — a state transition at the moment the quote provider
degraded, after which every buy hung.

**Fixed in the tracker**, not in the guards: the tracker is what recorded the
row, so it is what owes a resolution. On any non-`GuardRejection` error it now
resolves `failed` — but **conditionally**, only when the status is still
`pending`, so a resolution the broker already made is never relabelled by
whoever unwinds last.

Audited the same shape elsewhere per the standing rule: `recordIntent` has three
call sites and the broker's two both resolve in a `catch`. The tracker's was the
only unpaired one.

An operator no longer needs `npm run orphans` to reopen the gate after a provider
outage. Genuine crash orphans still require sign-off, and that is deliberate —
that gate is a safety property, not a nuisance.

---

## Task C — confirmed against chain, and it is worse than "mislabelled"

**Confirmed.** Six transactions fetched and inspected. Every one ran only
`ATokenGPvbdG…` (associated token account), `Tokenkeg…`/`Tokenz…` (SPL Token and
Token-2022), the system program, and sometimes compute budget. **No DEX program
participated in any of them.** The instruction types are `create`,
`transfer`/`transferChecked`, `getAccountDataSize`, `createAccount`,
`initializeImmutableOwner`, `initializeAccount3` — create-an-ATA-and-send-tokens.

The balance evidence is worse than a wrong label:

| | wallet's own lamport delta | parser recorded |
| --- | --- | --- |
| "buy" side | **0** — the sender paid the rent | 2,039,280 lamports spent |
| "sell" side | **−2,245,780** — the wallet paid | 2,039,280 lamports received |

On the sell side **the SOL direction is inverted**. The wallet paid rent and the
parser recorded it as proceeds.

Corpus-wide: **271 of these across all sessions**, split 138 buys / 133 sells.
That near-balance is itself the giveaway — an ATA opening pays rent, an ATA
closing refunds it, and neither is a trade.

### The predicate, and why not the magic number

I did not filter on `solAmount === 2_039_280`. Rent depends on account size,
Token-2022 accounts with extensions cost more, two ATAs in one transaction cost
double, and the constant is a network parameter.

I also did not require a *known* venue. Handoff 20 blamed unrecognised program
ids and was disproved; the parser works from balance deltas precisely so an
unknown DEX still produces a swap.

**The predicate is the opposite question, and it is safe:** if the only programs
invoked are infrastructure — system, token, ATA, compute budget, memo — then no
market was touched by anyone, under any venue, known or not. A new DEX cannot
look like this, because a new DEX is a program and would be in the invoked set
and absent from the list. That is a denylist, and it cannot discard a venue
nobody has added yet.

Implementation notes that matter:

- `programsInvoked()` reads **instructions**, top-level and inner, not the
  account key list — a venue's program id appears in the keys of any transaction
  that merely references it, and an ATA transfer's keys are mostly mints.
- It **fails open**: an empty program set means the encoding did not say, and a
  real trade silently discarded is far worse than a transfer admitted and counted.
- Filtered transactions emit `INFRASTRUCTURE_ONLY`, a normal unparsed reason, so
  they land in session files and are countable by the existing machinery.

A real ATA-transfer is now a committed fixture
(`tests/fixtures/transactions/ata-transfer-buy-side.json`), and the guard test
asserts all five venue captures still parse as swaps.

**Why this was the item that costs money:** `mirror.ts` sizes from
`positionSizeSol`, not from the observed swap. A 0.002 SOL token transfer and a
5 SOL buy produced the same 0.05 SOL entry.

---

## Task D — three counters that named the wrong thing

**1. `queue-overflow` attribution — fixed, and prior numbers are void.**

The queue is global and `splice(0, n)` removes the **oldest** entries, which
belong to whoever queued first. The event reported the wallet that was
*arriving*. The field is renamed `arrivingWallet` so it cannot be misread again,
and the event now carries `droppedFor` (per-wallet counts of who actually lost
entries) and `droppedSignatures` (exactly what was shed).

**Every shed-by-wallet figure in this repo's history names the wrong wallet.**
That includes session 23's "26 of 37 sheds belong to `BCagckXe…`" — that is the
wallet whose notification triggered the overflow, and the conclusion drawn from
it is withdrawn. The *timing* findings (0 sheds in the gapfill burst; sheds
arrive in tight bursts) stand, because they do not depend on the wallet field.

**2. Guard rejections now reach session files — a new `decision` kind.**

This is the fix for session 23's A1: a `STALE_SIGNAL` rejection was
indistinguishable from a signal the strategy ignored, because gate 3 runs before
the first quote and only the originating swap survived.

It is a new `SessionKind` rather than an `unmodeled` tag, because the unmodeled
count is a falsifiability signal — "the four kinds were argued sufficient and
nothing measured it" — and filling it with refusals the recorder fully
understands would destroy the one number that can contradict the schema. The
replay loader carries `decision` and drives nothing from it, exactly as it does
`unmodeled`, so the "a session carrying outputs could be replayed into agreement
with itself" argument still holds: the replay regenerates its own rejections
through the real guard layer.

`signalAgeMs` rides along, which **closes CLAUDE.md gap 8 in the only way
available without a ledger sign-off.** `intents` has no column for it and
`db/ledger.ts` is out of scope; this is the value the gate actually read, at the
moment it read it — not a backfill and not inferred from timestamps, both of
which that gap explicitly forbids.

**3. `PAPER BALANCE DRIFT` — made correct rather than removed.**

It compared `eventNetFlow` (fills **this process** saw) against
`ledgerNetFlowLamports()` (cumulative on disk, every run the file has ever had).
Identical only while the ledger starts empty. Session 23's first-ever final
digest reported `-106789862 lamports` of "drift", which was exactly the two open
positions it had legitimately inherited.

The digest now latches the ledger's opening flow at construction and compares
delta against delta. Verified against the real number: the warm-up soak this
session, started before the fix, reproduced `-106789862` with zero fills of its
own — which is the diagnosis confirmed rather than argued.

---

## Two decisions, no code

### 1. `MAX_IN_FLIGHT` — recommend **256**, and the cap was never the binding constraint

The question the brief asked — *what is the cap actually protecting against* —
turns out to be the whole answer: **nothing that binds.**

- **Memory.** A queue entry is `{wallet, entry, source}`, ~200 bytes with the
  signature string. 256 entries is ~51 KB. This was never a memory bound.
- **RPC rate.** `drain()` is serial — `while (queue.length) await handle()` — so
  request rate is set by the drain, not by depth. Measured drain cost per entry
  (n=1,668): **p50 158 ms, p90 229 ms**, i.e. ~6.3 req/s against a ~10 rps
  provider ceiling. Adding depth does not add one request per second.
- **Freshness.** This is the only real cost, and it is asymmetric in a way that
  favours depth: an entry that waits too long produces a `STALE_SIGNAL`
  rejection, which is **counted, correct, and still parsed into the corpus**. An
  entry that is shed produces nothing at all. A late observation beats a missing
  one.

Measured demand, for calibration: the largest contiguous shed burst across three
sessions implies a peak queue demand of **25, 46 and 41** entries. 14 s of
freshness budget drains **88** entries at p50 and **61** at p90.

So anything in 64–512 is defensible on the same reasoning and the exact number
matters much less than the finding. **256** covers the worst observed burst 5.5×,
costs 51 KB, and changes no request rate.

**But depth is the wrong fix for the actual pathology.** Every shed burst
measured was *one wallet* arriving at once, and a global FIFO makes every other
wallet queue behind it. The structural answer is a round-robin drain across
wallets — fairness, not depth. Depth only buys time.

Not changed this session, per instruction. It needs a cursor-monotonicity test
under out-of-order arrival before it moves.

### 2. The 30 bps penalty — the minimum live evidence bar

Paper `slippageBps` is `shortfallBps(quoted, reduceByBpsFloor(quoted, 30))`,
which is the config constant handed back. Paper can never calibrate it. Live can,
and this is what it would take.

**What must be captured at the moment of each live fill.** None of it exists
today, and most of it has nowhere to live:

| field | why |
| --- | --- |
| `quote_out_amount`, `quote_in_amount`, `quote_price_impact_pct` | the offer actually acted on |
| `quote_at_ms`, `quote_slot` | the start of the interval the penalty models |
| `submitted_at_ms`, `landed_slot`, `landed_at_ms` | the end of it — the penalty is a proxy for this delay |
| `actual_out_amount` | from the confirmed transaction's balance deltas, never from the quote |
| `venue`, `mint`, route hash | impact shape differs per venue |
| `priority_fee_lamports`, `compute_units_consumed` | they change landing time, so they change shortfall |
| retry / rebroadcast count | a rebroadcast fill is a different population |

Realised shortfall is then
`(quote_out_amount − actual_out_amount) / quote_out_amount × 10_000`, regressed
against `landed_at_ms − quote_at_ms`. **The penalty should be replaced by that
regression, not by a new constant** — a single number cannot describe a quantity
that depends on delay, and the current one is applied identically to a 200 ms
fill and a 2 s one.

**How many fills.** This is distribution estimation on a heavy-tailed quantity.
Taking σ ≈ 200 bps for memecoin execution, `n = (1.96σ/E)²`:

| target precision | fills needed |
| --- | --- |
| ±50 bps | ~62 |
| ±25 bps | ~246 |
| ±10 bps | ~1,537 |

**≥250 fills per venue class**, stratified — pump.fun and Raydium must be
separate, because CLAUDE.md gap 7 says a pre-graduation bonding curve is not a
constant-product pool and `price_impact` does not describe its shape. And **no
single mint above ~5% of the sample**, or the number describes one pool rather
than a market.

**The prerequisite nobody can route around:** `fills.slippage_bps` is the only
execution-quality column and it is a `REAL` that paper fills fill with a
constant. Collecting the table above needs either new columns on `fills` or a
separate live-fill journal. The first is `db/ledger.ts` and needs a **signed
sign-off**. Writing that down now, as asked, so it is a scheduled decision rather
than an improvised one at the live-readiness gate.

---

## A new finding, surfaced by this session's own soak

**The socket does not connect until every wallet's gap fill has finished, and a
gap fill is unbounded once a cursor exists.**

```
async start(): Promise<void> {
  this.running = true;
  for (const wallet of this.deps.wallets) await this.gapFill(wallet);
  if (!(await this.connectOnce())) this.beginReconnect();   // <- only now
}
```

`MAX_COLD_FILL` caps the backlog only when there is **no** cursor — both cap
checks are gated on `cursor === undefined`. With a cursor, `gapFill` pages until
it reaches it, however far back that is.

Observed live this session: one wallet (`H8sMJSCQ…`) accounted for **2,098 of
2,131** gap-fill fetches on startup and was still draining nine minutes in, at
~5 fetches/second, roughly 7,000 slots behind the other twelve. The bot is
**blind to live traffic for that entire period** — no subscription exists yet.

Every previous session hid this: session 22 and 23 both ran on a destroyed or
fresh cursor store, so every wallet cold-filled and was capped at 100. This is
the first run with real cursors and a real backlog.

It is not a correctness bug — nothing is skipped, and the cursor is what
guarantees that. It is an availability one, and it scales with downtime: the
longer the process is off, the longer it stays blind after coming back. The
obvious shape of a fix is to connect the socket **first** and gap-fill behind it,
which is safe because the seen set already dedupes the overlap — but that
reorders `start()` and deserves its own session and its own tests.

## Task E — soak

See the appended results section.

---

## Verified vs assumed

**Verified from files this session:** that `heartbeat()` has no caller anywhere
in `src`, `tests` or the CLIs; that the host slept for 84.9 of session 23's 113.9
soak minutes and that all three long reconnect gaps coincide with sleep windows;
that the sleep-excluded healthy gap distribution maxes at 57.5 s over 356
samples; that `websocket error` and `closed` arrived 1 ms apart; that the first
`UPSTREAM_ERROR` preceded the first unresolvable intent by 14.9 s and that quote
errors went 5.9% → 70.3% across that boundary; that all 8 fills are intents
≤00014 and all 6 orphans ≥00015; that six sampled rent-sized transactions invoke
no venue program and that the sell side's wallet lamport delta is negative; that
peak queue demand was 25/46/41 and drain cost is p50 158 ms / p90 229 ms.

**Assumed:** that σ ≈ 200 bps for live execution on these mints. It is an
order-of-magnitude judgement, not a measurement — nothing in this repo has ever
observed a live fill. Every fill count in the table above scales with σ², so if
the true σ is 400 bps the requirement quadruples. Treat the *shape* of that table
as the deliverable and the absolute numbers as provisional.

**Not established:** whether the reconnect path has any real defect beyond the
double-chain one. The evidence that suggested it was environmental, and fault
injection did not reproduce a failure. It is *unproven-good*, not proven-good.

**Confound named:** the `INFRASTRUCTURE_ONLY` rate this session is measured on a
soak that ran *with* the filter, so it counts what was filtered. The 271 figure
from earlier sessions is a `solAmount === 2039280` proxy on unfiltered data and
is a **lower bound** — it cannot see an infrastructure-only transfer whose rent
was a different size, e.g. a Token-2022 account or two ATAs in one transaction.
