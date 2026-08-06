# Handoff 23 — what a session can give back, and what it cannot

**The ledger was not rebuilt, because most of it is not rebuildable. The two open
positions are recoverable exactly; the intents are gone in a way no amount of
care recovers.** Snapshots now run off-volume, startup refuses a silently empty
ledger, and the seen set is keyed on `(wallet, signature)`.

## Broken, deviated from, or not done — first

**Nothing regressed.** Suite green throughout; no existing test was modified and
the shared `fakeSocket` needed no further change (last session's upgrade already
speaks enough of the protocol for the collision case).

**I did not implement `rebuildFromSessions()`, and the brief's own wording is
why.** Recovery is partial — see Task A1 — and the brief says that where it is
partial, "the precise list of what is unrecoverable and why is the more valuable
output". A rebuild covering entries but not exits would put positions on the
books that were opened and never closed, and a realised P&L of zero, which is a
more confident lie than an empty database. What exists instead is
`scripts/session-forensics.ts`, which reports the evidence and writes nothing.

**A3 is not inside `reconcileOnStartup()`, which is what the brief asked for.**
That function lives in `db/ledger.ts`, which CLAUDE.md puts off-limits without a
signed sign-off, and this brief carries none. The check runs at the composition
root instead, in `createTrackerRuntime`, **before `openLedger`**. That is also
the only place it can work: `openLedger` creates the file it is given, so by the
time `reconcileOnStartup` runs the evidence of absence is already gone — it would
be reporting on a database it had just made. The behaviour asked for is
unchanged: the process refuses to start.

**`TrackerRuntime` gained a public field**, `snapshots: LedgerSnapshotter`. Named
here rather than left in a diff.

**Task C is diagnosis only, no policy change** — as instructed, and the diagnosis
says the policy is not the first problem anyway.

---

## Task A1 — the boundary, which is sharper than expected

### Recoverable, and verified rather than argued

`price-tick` payloads carry a live `Position`: mint, exact `tokens`, `decimals`,
and the mark. And the paper broker's buy is a **pure function of the recorded
quote** — `tokensDelta = floor(outAmount × (10000 − 30) / 10000)`, `lamportsDelta
= −50,000,000` exactly, fees deterministic from config.

Tested against every held mint in the corpus: **20 of 20 held sizes are
reproduced exactly** by a recorded entry quote through that arithmetic. Not one
approximate match; integer-identical.

**The two open positions the final `/stop` reported are identified, with direct
evidence rather than inference.** A held position is probed for an exit
continuously; a closed one stops being probed. In
`sessions/20260806T041217Z-000.jsonl`:

| mint | holdings (base units) | last exit quote | verdict |
| --- | --- | --- | --- |
| `DPtTxUz6…BitFR` | 40,798,390,040 | seq 7341, the second-to-last line | **open** |
| `3GmZ4eoz…ywtpump` | 33,072,221,306 | seq 7342, the last line | **open** |
| `5whR534G…FXCAMzi` | 40,265,854,179 | seq 2789, then 56 min of silence | closed |

Two open. That matches what `/stop` reported, and it was derived from the file
rather than from the recollection.

Both entries reconstruct: `DPtTxUz6` from the quote at seq 2690 (50,000,000
lamports in, 40,921,153,501 quoted), `3GmZ4eoz` from seq 5359 (33,171,736,516
quoted). Price ticks stopped at 04:51:58 for both — not because the positions
closed, but because 730 consecutive exit quotes returned `UPSTREAM_ERROR` and
there was no price to mark with.

### Not recoverable, and the reason is structural

**Intents, entirely.** Not "hard" — absent. `EXCLUDED_TRACKER_EVENTS` omits
`intent-created`, `fill` and `rejection` by name, and `mirror.ts` never calls
`getQuote`, so every quote in a session comes from the broker, which sits
**behind** `guarded()`. Gate 3 (`STALE_SIGNAL`) fires before the broker's first
quote. A rejected intent therefore produces no quote, no screen and no tick — it
leaves the originating swap and nothing else, and that swap is byte-for-byte
indistinguishable from one the strategy declined to act on. The 272 `STALE_SIGNAL`
rejections of 2026-08-05 cannot be separated from the swaps that never became
intents at all.

Also gone: fill ids and the intent↔fill linkage (freshly minted UUIDs, nothing to
reconcile to), realised P&L and `daily_pnl` (needs the complete sell sequence),
the cursors, the runtime state, and `data/wallets.json`. And everything before
**2026-08-04T21:36:40Z**, where the corpus begins — the ledger predates it.

Replay is not a route back either. `replaySession` builds a **fresh temp ledger
from zero** with `parseConfig({ trackedWallets: [] })` defaults, so it neither
starts from the state a run began in nor uses the config that run had. It is a
counterfactual generator, which is what it is for, and it is not a restore.

### Two corrections to the brief's account of the cost

Both were checked in the code, and both cut the same way — the loss was smaller
than stated.

**1. The paper fills could never have recalibrated the 30 bps penalty.** The
brief calls them "the only material for recalibrating the 30 bps latency penalty
against live quotes". They are not material for it at all. `received =
reduceByBpsFloor(quoted, 30)` and then `slippageBps = shortfallBps(quoted,
received)` — the column is the config constant handed back. Computed over every
priced entry quote in the last session, the only value a paper buy could ever
record is **30**. The relationship is circular by construction; recalibrating
against live quotes needs **live** fills, which paper mode has never produced.

**2. The replay harness lost nothing.** The brief calls the fills "the only input
the replay harness has". `loadSession()` reads a **session file**, and
`replaySession` creates its own ledger in a temp directory. All six session files
survived with **zero `seq` gaps and zero duplicates** across all five runs, so
every one of them is still replayable. The harness's input was never the ledger.

What the loss did cost, stated plainly: the two open positions (recoverable, as
above), the cursors (visible as 13 truncated cold fills), the runtime state, and
the watchlist labels.

---

## Task A2 — snapshots

`src/services/ledgerDurability.ts`. On start, every 15 minutes, on bot-idle, and
on shutdown, to `~/.solana-tracker/snapshots` (`LEDGER_SNAPSHOT_DIR`), keeping
the newest 24.

**`VACUUM INTO`, not a file copy, and the test proves why it matters.** The
ledger runs WAL with `synchronous = FULL`. Copying `tracker.db` on its own gets
whatever was last checkpointed — and on a fresh ledger that is worse than a
missing row: the naive copy **has no `fills` table at all**, because the schema
itself is still in the WAL. It opens without complaint. That is the worst shape a
backup can take, and it is now a test rather than a warning.

Snapshots are written to `.partial` and renamed, so an interrupted one is never
left looking usable. `snapshot()` never throws — a backup that can stop the bot
from starting has inverted its own purpose; failures are counted on
`stats.failed` and exposed on `lastError`.

Wired via a `state-change` **listener**, not by editing `Tracker.start()` /
`stop()`, whose status-flip ordering is load-bearing for guard gate 2.

**Restore-verified**: `integrity_check: ok`, `user_version: 2`, all four tables
present. The end-to-end restore with live positions is Task D.

---

## Task A3 — the refusal

`assertLedgerPresent()` throws `LedgerLostError` when `data/tracker.db` is absent
while `sessions/` holds session files. The pairing is what makes it a signal: a
missing database alone is a first run.

Verified live — the first soak attempt of this session was refused, which is how
it was tested rather than asserted. `ALLOW_EMPTY_LEDGER=1` is the override, named
in the error text alongside the snapshot directory and a `cp` line. `serve.ts` and
`soak.ts` print the message on its own and exit 2, because the message is the
remedy and a stack trace above it buries the part anybody needs.

`._*` AppleDouble sidecars are excluded from the session count — on this exFAT
volume, counting one would refuse a genuine first run.

---

## Task B — the coupled change

`seenKey(wallet, signature)`; **both** `seen` and `inFlight` re-keyed — `inFlight`
matters because `gapFill` awaits `handle` directly while the socket path goes
through `drain`, so the two interleave for real and a signature-keyed `inFlight`
would have suppressed the second wallet even with `seen` fixed.

### The capacity arithmetic was wrong, and in a specific way

Handoff 22 and this brief both carried "5,000 over 13 wallets ≈ 385/wallet". That
is a **fan-out artifact**. Since handoff 22 a notification routes to exactly one
wallet, so one delivery costs one slot however the set is keyed. A signature
costs k slots only when a transaction genuinely names k tracked wallets.

Measured over 2,788 `fetch-window` records (which carry the pair) across both
post-fix sessions: distinct pairs ÷ distinct signatures = **1.0000**. Busiest
whole run: **1,800** slots against a cap of 5,000.

**That measurement is confounded, and it must not be quoted as if it were not.**
The old signature-only key returned inside `handle` *before* `fetch-window` was
emitted, so a collision could not have been recorded even where one happened. It
bounds the multiplier for traffic the old key admitted — no more.

**Verdict: `SEEN_CAPACITY` stays 5,000, and stays one global LRU.** A fixed
385/wallet would be *worse* than the status quo: the busiest wallet alone
consumed 581 slots in a 13-minute run and would evict its own entries mid-run
while quiet wallets sat near zero. A global LRU spends capacity where the traffic
is, and its eviction failure mode is a duplicate emit — caught by guard gate 6 —
not a lost swap.

### Why not admitting `WALLET_NOT_IN_TX` is a real fix

For a reason handoff 22 did not name. `parseSwap` reaches that code three ways,
and **two are degraded RPC responses**: `meta === null`, and an account key list
that does not match `preBalances`. Those are retryable, and admitting them is the
same permanent-loss shape session 21 removed from the null window. Only the third
— a genuine mentions-only match — is deterministic, and it was measured at zero
occurrences across 833 post-fix unparsed records.

**The limit, stated because it is easy to overestimate this:** `dispatch` still
advances the cursor, so a non-admitted signature stays re-deliverable over the
**socket**, not through gap fill. Making the degraded cases genuinely replayable
means holding the cursor back too — a separate change with its own monotonicity
risk, and not taken here.

### Tests

Four added to `tests/walletStream.test.ts`. The collision case uses a **real**
capture, not a synthetic one: `raydium-v4-buy.json` has two genuine balance
participants — the trader, who buys, and the pool vault `4DjZjwnQ…`, which sells
the same token amount back. Nothing was fabricated to make the test work.

| test | before | after |
| --- | --- | --- |
| one swap per tracked wallet named in one transaction | **red** | green |
| same `(wallet, signature)` socket → gap fill dedupes | green | green |
| second wallet not suppressed by the first's admission | **red** | green |
| a wallet not in the transaction is not admitted | **red** | green |

Three red before, as the brief required. **The dedupe test was green before and
after, and I am not going to dress that up as a failure**: it is a regression
guard on the behaviour the re-key could most plausibly have broken, which is why
it is worth having.

`fakeSocket` needed **no** changes this session — `deliver(signature, slot,
wallet)` already selects a subscription, which is exactly what the collision case
needs.

---

## Task C — the shed diagnosis defeats the hypothesis, and my own proposal

### Sheds do not cluster in the gapfill burst

Measured on session 22's run (37 sheds, 64.3 min):

- **0 of 37** fell in the startup gapfill burst. **0** in the first 12 minutes.
  The burst runs minutes 0–4 and produces no sheds at all.
- So **backpressure on gap fill is not the fix**, and the brief's own parenthetical
  ("0 overflows during that window") already pointed there.

### What they actually are: one wallet, one instant

- **26 of the 37 landed within 40 ms of each other, all for `BCagckXe…`.** The
  remaining 11 were all `H8sMJSCQ…`, in four smaller bursts.
- Immediately after the big burst, that same wallet's signatures fetch at ~130 ms
  each and are overwhelmingly `TX_FAILED`.
- **The drain is healthy throughout.** `fetch-window` in the 60 s before every
  burst: p50 128 ms, max 295 ms, **0 retries, 0 unresolved**. Nothing stalls.

The mechanism is a spam-ish wallet emitting tens of notifications in one slot
against a **global** `MAX_IN_FLIGHT = 20` drained serially. Session 21's run shows
the other shape — 30 sheds in **13.2 minutes**, five wallets per instant.

**A correction to handoff 22:** it reported those 30 as "session 21's hour". The
run was 13.2 minutes. So the rate went from 2.28/min to 0.58/min — shedding fell
about **4×**, it did not "barely move". The count was compared across unequal
windows.

### The telemetry names the wrong wallet

`enqueue` emits `queue-overflow` with the wallet being **enqueued**, while
`splice(0, n)` removes the **oldest** entries, which may belong to anyone. Every
per-wallet shed number — including the two above — names the arriving wallet, not
the losing one. This should be fixed before any per-wallet shed figure is trusted.

### The direction argument, restated and then defended

**Handoff 22 proposed shedding from the back. The brief argues the opposite:
alpha decays, so the oldest queued entry is the most decayed and the cheapest to
drop.**

**The brief is right about the entry and wrong about the consequence, and I think
back-shedding still wins — on a mechanism the alpha argument does not address.**

`gapFill` anchors on `until: cursor.lastSignature` — everything *newer* than what
we have.

- **Shed the front (oldest):** the entries left are all newer. They dispatch, the
  cursor advances past the shed one, and `until: <newer>` can never walk back to
  it. **Permanently lost.**
- **Shed the back (newest):** the entries left are all older. The cursor ends up
  *behind* the shed entry, so the next gap fill re-offers it. **Recoverable.**

Across a 20-deep queue draining at ~130 ms the head-to-tail spread is ~2.6
seconds. Alpha decay over 2.6 s is a second-order difference in value; permanent
loss versus recovery is a total one.

**Where the brief's instinct does hold:** the recovered entry arrives minutes
later and will be `STALE_SIGNAL`-rejected at gate 3, so it is never traded. So
back-shedding buys **corpus completeness, not alpha** — which is the thing this
repo is currently optimising, since it is paper mode and every open question is a
measurement. If the goal were live trading P&L, the two policies would be much
closer and the brief's reasoning would carry more weight.

### But the policy is not the first problem — the cap is

20 entries × ~130 ms ≈ **2.6 s** to drain, against `maxSignalAgeMs` of
**15,000 ms**. The queue could hold roughly **115** and still deliver everything
inside the freshness gate. `MAX_IN_FLIGHT = 20` is about **5× tighter than the
latency budget requires**, and that — not the discard end — is what turns a
single wallet's burst into 26 dropped notifications.

Not changed this session. It is a measured re-derivation rather than a loosened
limit, but it deserves its own tests (cursor monotonicity under out-of-order
arrival) and its own session, which is what the brief asked for.

---

## Task D — soak and restart

`sessions/20260806T152610Z-000.jsonl`, 15:26–17:20 UTC, **113.9 min**, 5,285
lines, 0 dropped, no rotation.

### The gate was NOT met on swap count

**51 live-parsed swaps, not 80.** The gate was "≥80 or 2 hours, whichever comes
first" and the 2-hour bound came first, so the soak ran as specified — but the
count is 51 and should not be reported as a pass.

**The reason is a dead websocket, not a quiet market.** The last live socket
delivery was at **+48.9 min**; the run continued to +113.9. The largest gap
during healthy operation was 4.5 min, so a 65-minute gap is not market quiet:

| minutes | live swaps |
| --- | --- |
| 0–10 / 10–20 / 20–30 / 30–40 / 40–50 | 7 / 12 / 12 / 13 / 7 |
| 50–60 through 110–120 | **0, every bucket** |

Over the ~49 minutes the socket was actually up the rate was **~63/hour**, which
is in the same range as session 22's ~86/hour and consistent with time-of-day
variation rather than with a regression.

**Two mechanism findings fall out of this, and both are pre-existing.**

1. **`WalletStream.heartbeat()` is never called.** Not from `tracker.ts`, not
   from `serve.ts`, not from `soak.ts`, not from any test. `SILENCE_TIMEOUT_MS =
   90_000` and the `missedHeartbeats >= 2` teardown are dead code. So a socket
   that goes silent *without erroring* is never detected: this run sat silent
   from +48.9 to +70.5 min — **21.6 minutes** — before the underlying TCP finally
   errored and `onDisconnect` fired. The check that exists to catch exactly this
   has never run.
2. **Reconnect then failed for the remaining 43 minutes.** 23 `disconnected`
   events, **0 `reconnected`** — 21 consecutive
   `WebSocket connect failed: errored before opening`, thinning out as the
   backoff grew. Whether the endpoint was rate-limiting or the host's network
   dropped is not established.

### The five baselines

| measure | session 22 | this session |
| --- | --- | --- |
| live-sourced `WALLET_NOT_IN_TX` | 0 | **0 — held** |
| detection leg, live | p50 171 / p90 272 / p99 364, max 652 | **p50 171 / p90 278 / p99 369, max 694** (n=368) |
| null window | 1 in 500, retry recovered | **1 in 368**, retry recovered, 0 unresolved |
| sheds | 37 in 64.3 min (0.58/min) | **25 in 113.9 min (0.22/min)** |
| multi-wallet transactions | not counted | **1** (and it is not a swap — see below) |

The detection leg reproduces session 22 almost exactly — p50 identical to the
millisecond across two runs eleven hours apart. That is the most stable number in
this repo.

**Sheds confirm the diagnosis rather than merely repeating it.** 0 of 25 in the
startup gapfill burst (which ends at +255 s); all 25 in steady state, in three
instants: 3 at +740 s (one wallet), **21 at +2132 s**, 1 at +2382 s. The +2132 s
burst spans three wallets, which the shed-attribution defect above makes
unreadable — `queue-overflow` names the arriving wallet, not the dropped one, so
"three wallets" may mean one wallet's burst evicting two others' queued entries.
That is precisely the confusion the misattribution creates.

### Multi-wallet transactions: exactly one, and it is not a trade

One signature in 1,667 reached two tracked wallets — pair/signature ratio
**1.0006**, so the capacity finding holds. It is `QundP2HR…`, and both legs are
`solAmount = 2039280` with `venue = unknown`, which is ATA rent rather than a
swap. See the section above; this is the lead the re-key bought.

The old key would have deduped that second leg away silently. It is now visible,
which is the point, even though the thing it made visible turned out to be a
parser question rather than a copy signal.

### Stop / restart with open positions — PASSES

1. Soak ended on its deadline with **2 open positions** in the ledger.
2. `bot-idle` and `shutdown` snapshots both fired; **all nine snapshots**
   (start + 6 intervals + bot-idle + shutdown) report `integrity_check: ok`, and
   every one from +30 min onward carries both open positions with identical
   token amounts and cost bases.
3. Restarted **without** `ALLOW_EMPTY_LEDGER` — the ledger now exists, so A3
   correctly does not fire.
4. `Reconciled ledger: 2 open position(s)`. **The positions came back.**

That is session 22's failure mode tested rather than asserted.

### Two things the restart exposed, both pre-existing

**Every soak this repo has ever run has died before printing its findings.**
`finish()` calls `runtime.close()` — which closes the ledger — and then the final
digest reads `getNetLamportsFlow()` from it, throwing `TypeError: The database
connection is not open`. `sessions/digests/` contained one hourly file and no
`final-*` file at all, and `soak.ts` is unmodified since the initial commit. The
hourly digests work, because the ledger is still open then; that is what hid it.
Fixed by latching the one ledger-derived number before the close, rather than
reordering the close and losing the guarantee it exists for. This session
produced **the first `final-*` digest in the repo's history**.

**Six buy intents hung and are now unacknowledged crash orphans, so the entry
gate is shut.** They were created between 15:51 and 16:10 — an hour before
shutdown — and never resolved, so this is not a shutdown race. The broker
resolves its own failures (`resolveIntent(…, 'failed', …)`) and the guard layer
resolves rejections, so a `pending` intent an hour old means something never
settled: most likely a quote or a screener call with no timeout, during the
window when `UPSTREAM_ERROR` was frequent. Not diagnosed further.

**This blocks the next session's soak.** Guard gate 0 refuses every buy while
unacknowledged orphans exist. Run `npm run orphans` and acknowledge them — after
checking, since `no-tx-on-chain` is the right resolution for a paper run — or the
next soak will observe traffic and open nothing.

The final digest also reports `PAPER BALANCE DRIFT of -106789862 lamports`.
**That is a digest artifact, not a ledger fault:** `SoakDigest` accumulates fills
observed by *this process* against a starting balance, while
`ledgerNetFlowLamports` is *cumulative on disk*. Running a soak against a
non-empty ledger makes them disagree by exactly the prior run's net flow, and
−0.1068 SOL is very close to the two open positions' 0.1002 SOL of cost plus
fees. It has never been visible before because the final digest has never run.

---

## Verified vs assumed

**Verified from code or data this session:** that `EXCLUDED_TRACKER_EVENTS` omits
intents, fills and rejections by name; that `mirror.ts` never calls `getQuote`, so
gate 3 precedes every recorded quote; that all six session files have zero `seq`
gaps and zero duplicates; that 20 of 20 held sizes reproduce exactly from a
recorded entry quote; that two positions were still being exit-probed on the final
two lines of the last session and a third stopped 56 minutes earlier; that paper
`slippage_bps` can only ever be 30; that a naive `cp` of a fresh WAL ledger yields
a file with no `fills` table; that the startup refusal fires against the real
repo state; that the pair/signature ratio is 1.0000 over 2,788 records; that 26 of
37 sheds belong to one wallet in one 40 ms window with fetch latency flat.

**Assumed:** that `4DjZjwnQ…` being a genuine balance participant in the test
capture generalises — it is a pool vault, and a pool vault is not a wallet anyone
would track. It is a faithful *shape* for the two-participant case, which is what
the test needs, but the live multi-wallet count is the real evidence and it is in
Task D.

**Not established:** whether the degraded-response half of `WALLET_NOT_IN_TX`
actually occurs in the wild. Post-fix it is zero across 833 records, so the
not-admitting change is currently a no-op in practice and is justified by
mechanism rather than by measurement.

**Unexplained:** why 730 consecutive exit quotes returned `UPSTREAM_ERROR` in the
last 25 minutes of session 22's run, killing the price loop while the socket path
kept working. It is Jupiter-side and it silently stops position marking, which
means a stop-loss would not have fired. Worth a look.

---

## A new finding, surfaced by the re-key: ~5% of "swaps" may be rent, not trades

The very first multi-wallet transaction the re-keyed build admitted is not a
trade. Signature `QundP2HR…`, slot 437585714, one mint, two tracked wallets
(`HSsJjkHr` and `2nHsHJpk`) both recorded as **buys** — with
`solAmount = 2039280` on each and `venue = unknown`.

2,039,280 lamports is exactly the rent-exempt minimum for a 165-byte SPL token
account. Two wallets receiving different token amounts in one transaction, whose
only SOL movement is account rent, is a **distribution**, not a swap. The parser
works from balance deltas, sees a mint delta and a lamport delta, and calls it a
buy.

Prevalence, measured across both post-fix sessions:

| | session 22 run | this session's soak |
| --- | --- | --- |
| parsed swaps | 967 | 815 |
| `solAmount == 2039280` | 51 (5.3%) | 46 (5.6%) |
| `venue == unknown` | 647 (67%) | 543 (67%) |
| rent-sized ∩ unknown-venue | 51 (all) | 46 (all) |

Every rent-sized "swap" has an unrecognised venue, in both sessions, which is
what you would expect if they are not venue interactions at all.

**Why this matters more than 5% sounds:** `mirror.ts` sizes from
`positionSizeSol`, not from the observed swap. A 0.00204 SOL rent event and a 5
SOL buy generate the same 0.05 SOL entry. So these are full-weight false entry
signals, and they bias the same direction as every other known gap — toward
making a wallet look more copyable than it is.

**Not yet established:** that 2,039,280 is *always* rent here (it is the
canonical ATA figure, but it was not confirmed against the raw transactions), or
what the other ~62% of unknown-venue swaps are. This is a lead with a measurement
attached, not a settled defect. It is the first thing the re-key bought that
nobody was looking for.

---

## What the next session should do first

1. **`MAX_IN_FLIGHT`.** The arithmetic above says 20 is ~5× tighter than the
   freshness budget requires, and it is the actual cause of the sheds. Needs a
   cursor-monotonicity test under out-of-order arrival.
2. **Fix `queue-overflow`'s wallet attribution** before anyone reads another
   per-wallet shed number.
3. **The `UPSTREAM_ERROR` storm** that stops the price loop. A position that
   cannot be marked cannot be exited on a rule.
4. **Recorder v2** (handoff 21 §Task C) — still the cheapest diagnostic win.
5. `signal_age_ms` — deferred for the fifth consecutive session.
