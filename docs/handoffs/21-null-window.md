# Handoff 21 — the null window is closed, and it was not the bug

**The fix works and should stay. It is not what was causing the corpus loss.**
Session 20 concluded the loss came from an RPC null window; the instrumentation
added this session to measure that window instead found the real mechanism, and
it is a different one. Session 20's conclusion is retracted below, with the
evidence.

Suite: **858 tests** (854 + 4), typecheck and build clean.

## Precondition — not met, and the session ran anyway

`git remote -v` is empty and `main` has no upstream. The prompt said to stop and
report; I did, and the operator directed the session to run regardless.

**Definition-of-done item 7 ("Pushed") is unmet.** There are now seven commits in
exactly one place, on an exFAT volume, and this session modified
`walletStream.ts` — the fetch path every downstream number depends on. The remote
was not created here: session 19 reserved that for the operator.

---

## Task A1 — the fix, and the design decision

### What was wrong

`handle()` called `seen.admit(signature)` **before** fetching. A `getTransaction`
returning `null` was handled with a bare `return`, and `rpcClient` retries
transport failures but not a *successful* response carrying `result: null`. So an
early fetch dropped the signature, and because it was already admitted, gap fill
could never re-deliver it.

That hole is real. **It is silent** — a `null` produced no record of any kind —
which matters a great deal for what follows.

### Design decision: a separate in-flight set

Admitting later means a signature can be in flight twice, and two parses of one
trade would be two intents. **The risk is concrete here:** `gapFill` awaits
`this.handle()` directly while the socket path goes through `enqueue`/`drain`, so
the `draining` guard does not serialise them against each other.

I chose a separate `inFlight` set over admit-then-roll-back-on-failure, because
it keeps `seen` meaning exactly one thing — *successfully fetched and
dispatched*. The whole fix rests on "an unresolved signature stays
re-deliverable", and that is only legible if `seen` has a single meaning.
Rollback would make it mean "processed, or in progress, or briefly-but-no-longer
failed", and the interaction with `SEEN_CAPACITY` eviction becomes something to
reason about rather than read.

`handle()` now returns if `seen`, returns if `inFlight`, adds to `inFlight`,
fetches with bounded retry, emits the measurement, and admits to `seen` **only**
on a transaction. `inFlight` is cleared in a `finally`.

### Retry policy

`FETCH_ATTEMPTS = 3`, `FETCH_RETRY_BASE_MS = 150` — 150ms then 300ms, under half
a second added worst case. Far inside `maxSignalAgeMs` (15s, untouched): a
signature needing longer *should* trip `STALE_SIGNAL`. It cannot amplify into
Helius's ~10 rps ceiling because `drain` awaits each `handle`, so fetches are
strictly serial — retries widen latency, never concurrency. Retries fire only on
`null`, never on a throw, since `rpcClient` has already exhausted its own
attempts on anything transport-shaped.

### The four required tests

`tests/walletStream.test.ts`, `describe('null window')`:

1. a null fetch is retried and the signature parses exactly once — **red before,
   green after**
2. a signature that never resolves is not admitted, and a later gap fill
   re-delivers it — **red before, green after** (uses `start()`, the real
   gap-fill trigger, not a test-only API)
3. socket and gap fill racing the same signature parse once — **green before and
   after**
4. the measured window is reported — **red before, green after**

**Honest note on #3.** The prompt asked for four tests all red before the fix.
Test 3 cannot be: before the fix, admit-before-fetch already prevented the
double-parse. It is a regression guard for the risk the fix *introduces* — it is
the test that fails if anyone removes `inFlight` — not a demonstration of the
bug. Reporting it as red would have been false.

**No existing test was modified.** All 17 pre-existing `walletStream` tests pass
unchanged. Two nearly needed it: the backpressure test asserts on the `error`
carrying `fetch queue overflow`, so Task B's event was added *alongside* that
emit rather than replacing it; and `does not advance past a transaction that
could not be fetched` throws rather than returning null, and throws are
deliberately not retried.

---

## Task A2 — the detection leg, measured

From a fresh session recorded after the fix (2,019 lines), split by source
because mixing them hides the thing being measured — gap-fill signatures are
minutes to hours old and were always fetchable.

| | live (socket) | gapfill | combined |
| --- | --- | --- | --- |
| n | 71 | 916 | 987 |
| resolved on first attempt | **100%** | 100% | 100% |
| needed a retry | 0 | 0 | 0 |
| never resolved | 0 | 0 | 0 |
| p50 | **198 ms** | 175 ms | 176 ms |
| p90 | **299 ms** | 238 ms | 240 ms |
| p99 | **353 ms** | 280 ms | 344 ms |
| max | **353 ms** | 1,378 ms | 1,378 ms |

**This is the detection leg only, and therefore a LOWER BOUND on copy delay.** It
measures the gap between the socket announcing a signature and this process being
able to read it. It excludes the quote, the guard layer and the fill entirely.
`example.py` assumes 1.2 s for the whole path; this says one component of it is
~200 ms at p50. The rest of CLAUDE.md gap 6 remains unmeasured.

The live p50 of 198 ms is consistent with the previously recorded `getTransaction`
round trip of p50 201 ms (n=20), which is a useful sanity check: what is being
measured here is mostly the round trip itself.

**The headline result is the zero.** In 71 live samples the null window did not
open once — every transaction was fetchable on the first attempt. The retry
budget was never consumed. That is a real measurement of the window's frequency
in this hour, and it is the first evidence that the window is not the dominant
loss mechanism.

---

## Task A3 — the rate moved, but not for the reason session 20 gave

| | pre-fix (session 20 fixture) | post-fix (fresh) |
| --- | --- | --- |
| parsed swaps | 1,857 (1,777 gapfill / 80 live) | 306 (306 gapfill / 0 live) |
| unparsed | 4,501 | 641 |
| raw unparsed share | 70.8% | 67.8% |
| **swap-like unparsed rate** | **34.2%** | **1.6%** |
| `WALLET_NOT_IN_TX` | 1,929 (42.9% of unparsed) | 7 (1.1%) |

On the face of it the fix worked: 34.2% → 1.6%, a 21× reduction.

**Do not read it that way.** The comparison is confounded and the mechanism is
not what it appears:

1. The post-fix window is one hour with almost no live socket traffic (0 live
   parsed swaps against 80 pre-fix). The pre-fix session ran 4.5 hours.
2. **A `null` fetch never produced a `WALLET_NOT_IN_TX` record in the first
   place.** Pre-fix, `tx === null` returned silently with no record at all. So
   the 1,929 `WALLET_NOT_IN_TX` cannot have been null-window failures — by
   construction they were transactions that *were* returned and that the parser
   then rejected.

Session 20 inferred the null window from the fact that those signatures re-parse
correctly on a later fetch. That inference was wrong, and the reason is below.

---

## The actual mechanism — a socket fan-out, not a null window

`onMessage` **discards the subscription id** and enqueues every notification for
**every tracked wallet**:

```ts
for (const wallet of this.deps.wallets) {
  this.enqueue(wallet, { signature: value.signature, ... }, 'live');
}
```

One notification becomes 13 queue entries, 12 of which are for wallets that have
nothing to do with the transaction. Then:

- `enqueue` caps at `MAX_IN_FLIGHT = 20` and sheds **from the front**
  (`splice(0, dropped)`), so the earliest wallets in the list are dropped and the
  **last** one survives;
- the surviving wallet fetches, is not in the transaction, and yields
  `WALLET_NOT_IN_TX`;
- it is admitted to `seen` anyway, so the real swapper's entry — if it was not
  already shed — is deduped out;
- the swap is lost, and what the session records is a `WALLET_NOT_IN_TX` for the
  wrong wallet.

**Verified, not inferred.** All 7 residual `WALLET_NOT_IN_TX` in the post-fix
session were attributed to the same wallet, `H8sMJSCQ…`, which is **index 12 of
13 — the last in the config list**, exactly as front-shedding predicts. Fetching
those transactions back:

| signature | attributed to | actually involves | swaps for |
| --- | --- | --- | --- |
| `3Ay6sErUbV…` | H8sMJSCQ… | popo3Rj6… | popo3Rj6… |
| `26hTMAuu2o…` | H8sMJSCQ… | HSsJjkHr… | HSsJjkHr… |
| `63MKwNFCvE…` | H8sMJSCQ… | popo3Rj6… | popo3Rj6… |

In every case `meta` is present, the account-key list matches `preBalances`, and
the attributed wallet **does not appear in the transaction at all**. Nothing was
early or incomplete. The fetch was fine; the attribution was wrong.

### Retracting session 20's reasoning

Session 20 tested "two tracked wallets collide in one transaction" and found all
30 sampled transactions involve exactly one tracked wallet — and read that as
refuting the collision hypothesis, leaving the null window. **That test was
aimed at the wrong hypothesis.** The fan-out does not require two wallets in one
transaction; it attributes every notification to all thirteen regardless of
involvement. The observation "exactly one tracked wallet involved" is not
evidence against the real mechanism — it is exactly what the real mechanism
predicts.

The 50% swap-like rate session 20 measured is also what this predicts: about half
the fan-out victims are genuine swaps by whichever wallet actually traded.

### Why the fix still belongs

The null window is a real hole even though it was not this one, and it was
**invisible** — a `null` left no record. The fix closes it and, more importantly,
the instrumentation added to measure it is what exposed the fan-out. Reverting it
would remove both.

### What the fix does NOT do

It does not stop the misattribution, and it may slightly *increase* the recorded
`WALLET_NOT_IN_TX` count, because a signature is now admitted only after a
successful fetch — so more of the fan-out's twelve wrong wallets can reach the
parser. The count is a symptom either way.

---

## Task B — the two holes

**1. Queue overflow is now visible.** `enqueue` emits `queue-overflow`
(`{wallet, dropped, capacity}`) alongside the `error` it always raised. `error`
is excluded from sessions by name, so this number never reached a file before.

**It found something immediately: 30 overflow events, 30 signatures shed, in one
hour on an idle-ish feed.** That is not incidental — it is the front-shedding
step of the mechanism above. `MAX_IN_FLIGHT` was not changed, as instructed.

**2. Cold-fill truncation was already recorded — the prompt's premise is wrong.**
`GapFilledEvent` already carries `truncated`, the tracker already records it as
`stream-gap-filled`, and session 20 read all 11 truncation events out of a
session file. Nothing was added; a second event would have duplicated an existing
one. What is genuinely missing is *how many* signatures were skipped, which
cannot be obtained without paging past `MAX_COLD_FILL` — a behaviour change, and
the cap was out of scope. Recorded as a v2 item instead.

---

## Task C — recorder v2 specification (prose; build is session 22)

Add a version marker and the fields below. **Per-line `v: 2`, not a header
line** — sessions are routinely read after a crash truncated them, and a format
that puts essential information only at the start loses it exactly when the file
matters most.

**The v1 read path stays.** `parseSession` must keep loading a line with no `v`
as v1 and replaying it byte-identically, and
`tests/replay/fixtures/real-mirror-20260805.jsonl` must keep passing the
determinism test unchanged — that fixture is the regression test for v1.

**1. `parseSwap`'s `detail` on `swap-unparsed`.** Three distinct paths reach
`WALLET_NOT_IN_TX` — `meta === null`, an account-key list not matching
`preBalances`, and the wallet genuinely absent — and a session cannot tell them
apart. *Would have answered:* session 20 spent 100 RPC fetches distinguishing
them and still got it wrong; session 21 needed another 40 to settle it. With
`detail` it is a `grep`, and the fan-out would have been obvious in session 20.

**2. The wallet a signature was attributed to.** *Would have answered:* this is
the single field that would have exposed the fan-out immediately — seven records
all naming a wallet not in the transaction. It cost two sessions to recover by
re-fetching.

**3. Queue-overflow and cold-fill truncation** — Task B's tags, now emitted. v2
should add *how many* signatures a truncated cold fill skipped.

**4. Null-window attempts and elapsed time** — Task A2's `fetch-window`, now
emitted as `unmodeled`. In v2 make it a **first-class kind**: it is an input a
replay could use to model detection latency instead of assuming zero, and
`unmodeled` is the bucket for things nobody has decided about. This is now
decided.

**5. A reason tag on the quote line.** Session 19 resolves quotes by grouping
into bursts and taking the last member, because one entry decision produces
several quotes for the same key and the recorder does not say which is which.
The call sites that would supply it: `safety.ts:621` and `:642` (screening, both
directions), `guards.ts:413` via the broker (price-impact gate), and
`paperBroker.ts:137` (execution). So the real values are `screen`,
`price-impact`, `execution`. **`decay-probe` is speculative** — no such re-quote
appears anywhere in the 2026-08-05 session and the code for it was never found.

**6. A `seq` discriminator on the quote line.** With a reason tag this is
belt-and-braces, but it makes resolution total and retires the burst heuristic
rather than merely constraining it.

Order: fields 1, 2 and 5 first — they retire measurement work already done by
hand twice. The version marker and v1 read path land with them or the archive is
invalidated.

---

## Still deferred: `signal_age_ms`

**Deferred for the third consecutive session** — 18, 19 and 20 each recorded it
as blocked on a signed sign-off for `db/ledger.ts`, and session 21 listed it out
of scope. Evidence keeps accumulating: the replayed session shows 920
`STALE_SIGNAL` rejections against 11 round trips, and it is still impossible to
say whether the 15 s window is right.

---

## What the next session should do first

1. **Fix the fan-out. Attribute a notification to the subscription that produced
   it.** `logsSubscribe` returns a subscription id per request; the reply must be
   mapped id → wallet, and `onMessage` must use `params.subscription` instead of
   looping over every wallet. **Not done here deliberately** — the prompt scoped
   Task A to the null window and said to report rather than reach for a second
   fix, and this needs its own tests.
2. **Then re-measure.** The swap-like unparsed rate is the metric; 1.6% in this
   session is not trustworthy because the post-fix window had almost no live
   traffic.
3. **Consider keying `seen` by `(wallet, signature)`.** Even with correct
   attribution, one transaction legitimately involving two tracked wallets needs
   parsing once per wallet. This is the hypothesis session 20 tested and did not
   find — rare, but not impossible, and currently unhandled.
4. Recorder v2, per Task C.

---

## Verified vs assumed

**Verified this session:** that `gapFill` calls `handle` directly while the
socket path goes through the queue, so `inFlight` is load-bearing; that all 17
pre-existing `walletStream` tests pass unmodified; that `GapFilledEvent.truncated`
was already recorded before this session; that both new events reach a session
file; the detection-leg distribution above; that `onMessage` discards the
subscription id and fans out to all wallets; that all 7 residual failures were
attributed to the last wallet in the config list and that the attributed wallet
appears nowhere in those transactions, with `meta` present and key lists matching.

**Assumed:** that the fan-out accounts for most of session 20's 1,929
`WALLET_NOT_IN_TX`. It is proven for the 7 observed post-fix and it explains the
50% swap-like rate and the "exactly one tracked wallet" observation, but the
pre-fix records do not carry the attributed wallet, so the pre-fix population was
not measured directly. Item 1 above will settle it.

**Not established:** the frequency of the null window under real load. Zero of 71
live samples opened it, in one quiet hour. That bounds it loosely and no more —
session 20's session was recorded during a far busier period.
