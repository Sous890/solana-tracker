# Handoff 20 — gap 9 is not a parser gap

**The 71% unparsed share is real and both of the prompt's two candidate
explanations are wrong. There is no unhandled venue, and it is not mostly noise
either. Half of one reason code is real swaps, lost to an RPC read that is never
retried and a dedupe that makes the loss permanent.**

Suite: 854/854, typecheck and build clean. Tasks A, B and C complete. Task D
deliberately not started — see the end.

**The push gate was not met.** There is still no remote: `git remote -v` is
empty and `main` has no upstream. The prompt said to stop if so; the operator
directed me to run anyway. Session 20's commit is local, like the four before
it, and "push it" in the definition of done is unmet. I did not create the
remote — session 19's prompt reserved that.

---

## Task A — what the unparsed set actually is

### The premise in the prompt does not hold

The prompt says "`unparsed` fires on unknown program IDs" and asks which venues
are missing. **The parser does not look at program IDs to decide whether to
parse.** `swapParser.ts` works from balance deltas, and says so in its header:
"Direction never comes from decoded instruction data. Instruction layouts differ
per venue and change without notice; the balance delta is what the wallet
actually ended up holding." `programId` is explicitly not filtered on. Venue is a
*label* applied afterwards — `venue: venues[0] ?? 'unknown'`.

The consequence is the opposite of what was feared: **an unhandled venue parses
perfectly well and is labelled `unknown`.** Measured on the session, of 1,857
parsed swaps:

| venue label | count |
| --- | --- |
| **unknown** | **1,453** |
| pumpfun | 371 |
| raydium-clmm | 19 |
| raydium-v4 | 12 |
| meteora-dlmm | 2 |

78% of successfully parsed swaps came from a program not in `VENUE_PROGRAMS`.
All three venues the prompt named are present in the sampled transactions and
all of them parse: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` (PumpSwap),
`cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` (Raydium CPMM),
`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` (Jupiter). **Nothing is missing
from the corpus because of a venue.** The venue label is analytic, not gating,
and adding these program IDs would change a string and nothing else.

### The session cannot answer the question the prompt asked

`swap-unparsed` is recorded as `{reason, signature}` and nothing else
(`tracker.ts:481`). There is no program id, and — worse — `parseSwap`'s `detail`
field is dropped, which is the field that separates "the wallet genuinely is not
in this transaction" from "the account key list did not line up with
preBalances". So the classification had to fetch the transactions back.
`scripts/classify-unparsed.ts` does that with the app's own `createRpcClient`
and `parseSwap`, so it reports what production would have done.

### Distribution, and what each reason is

4,501 unparsed against 1,857 parsed in the committed fixture — **raw share
70.8%**. (Handoff 19 said 4,495 and 71%; that count came from a read taken seven
lines earlier than the frozen fixture. The corrected figure is 4,501.)

| reason | count | share | re-parses as a swap | verdict |
| --- | --- | --- | --- | --- |
| WALLET_NOT_IN_TX | 1,929 | 42.9% | **50.0%** | **half are real swaps, lost** |
| TX_FAILED | 1,501 | 33.3% | 0/30 | noise — moved nothing |
| NO_MINT_DELTA | 773 | 17.2% | 0/30 | noise — no token moved |
| NO_SOL_LEG | 298 | 6.6% | 0/30 | token moved, no SOL leg |

Three independent stratified samples of `WALLET_NOT_IN_TX` — 15/30, 20/40, 15/30
— give **50/100 exactly**. 95% CI [40.2%, 59.8%].

### Swap-like unparsed rate

**34.2%**, against a raw 70.8%. CI [29.4%, 38.3%], from ~965 lost swaps
[775, 1153] against 1,857 recorded.

The difference between the two numbers is entirely `TX_FAILED` and
`NO_MINT_DELTA` — 2,274 transactions, 50.5% of the unparsed set, that moved no
tokens at all. Those are failures and infrastructure and the parser is right to
decline them. `NO_SOL_LEG` is excluded from the swap-like figure too: those are
genuine token movements with no SOL leg, which a SOL-denominated copier could
not mirror even if it saw them. Counting them as swap-like would give 40.5%.

### The mechanism — not the parser, the fetch

The same transactions, re-fetched and re-parsed by the same `parseSwap` against
the same wallet, parse as swaps now. So the parser was never wrong; **the data
it was given at the time was incomplete.**

Three things compound:

1. `walletStream.handle()` calls `this.seen.admit(entry.signature)` **before**
   the fetch, and never rolls it back.
2. `getTransaction` returning `null` is handled with a bare `if (tx === null)
   return;`, and an error with `emit('error'); return;`. Neither retries.
   `rpcClient` retries HTTP and network failures but a *successful* response
   carrying `result: null` is not one — it is returned as `null`.
3. `SeenSignatures` is one set per stream keyed by signature alone, so the
   gap-fill that would later re-deliver that signature is dropped before
   `parseSwap` is ever reached.

So a transaction fetched a moment too early is silently and **permanently**
removed from the corpus. This is CLAUDE.md gap 6, which already records that
"`getTransaction` returns null when called at the instant the `logsSubscribe`
notification arrives, so it needs a retry loop". The retry loop was never added,
and the dedupe converts a transient miss into a permanent one.

**A hypothesis I had and disproved, recorded because it is the obvious one:** I
expected the loss to come from two tracked wallets sharing a transaction, where
the first admits the signature and the second is deduped out. It is not that. Of
30 sampled `WALLET_NOT_IN_TX` transactions, **all 30 involve exactly one tracked
wallet** — the histogram is `1 wallet: 30`. The collision story is wrong; the
timing story is what the evidence supports.

Corroborating: across the whole session every signature appears **exactly
once** — 4,501 distinct unparsed, 1,857 distinct parsed, and **zero overlap**
between the two sets. That is the fingerprint of one attempt per signature with
no second chance.

### Which of the prompt's two outcomes holds

Neither, and the prompt's own language should not be stretched to fit.

It is **not** "mostly noise": 50.5% of the unparsed set is noise, but a 34%
swap-like rate is thirty-four times the digest's 1% threshold and is not a
threshold-definition artifact.

It is **not** "an unhandled venue at volume" either: no venue is unhandled,
because the parser does not gate on venue.

It is a third thing — **a read-after-write race against the RPC, made permanent
by a dedupe** — and it is more tractable than either, because it is a retry and
a dedupe key, not a protocol decoder.

### What this implies for handoff 17 — nothing, and that is established, not assumed

The wallet decision was **not** computed on this corpus. See Task C. The
rejection stands untouched by this finding, and the "unestablished rather than
wrong" language the prompt prepared does not apply.

---

## Task B — the disconnect asymmetry is a counting defect, plus a separate real hole

**106 `stream-disconnected` against 19 `stream-reconnected`, and the 106 is
three different events sharing one label:**

| reason | count | what it is |
| --- | --- | --- |
| `WebSocket connect failed: errored before opening` | 86 | a failed **reconnect attempt** |
| `websocket error` | 10 | the socket erroring |
| `closed` | 10 | the same socket then closing |

The 10 and 10 pair up — 15 disconnect events land within 5ms of the previous
one, which is one physical drop emitting both an error and a close. So the
physical disconnect count is about **10**, not 106, and 19 reconnects against
~10 drops is not an asymmetry at all. The other 86 are retry failures during
backoff, which by definition have no matching reconnect.

**Verdict: the counter is wrong, coverage is fine.** This is the prompt's second
branch. `stream-disconnected` should distinguish "the connection dropped" from
"a reconnect attempt failed"; conflating them makes a healthy backoff look like
an outage. Not changed this session — no backoff constant was touched, as
instructed.

Coverage is positively evidenced rather than merely not-disproved: **260 gap-fill
events recovered 13,739 signatures.**

### But gap fill has its own bounded hole, and a third one is invisible

- **11 truncated gap fills, all at exactly `count: 100`, one each for 11 of the
  13 wallets.** `truncated` is only set when `cursor === undefined` — a cold
  start — and `MAX_COLD_FILL` is 100. So at session start, history beyond the
  most recent 100 signatures per wallet was never fetched. Bounded, deliberate
  and documented, but it is a real hole at the head of every cold run.
- **`enqueue` drops the oldest entries past `MAX_IN_FLIGHT` (20) and reports it
  by emitting `error`** — and `error` is in `EXCLUDED_TRACKER_EVENTS`, so the
  recorder never writes it. Confirmed against the session: only four unmodeled
  tags ever appear and `tracker:error` is not among them. **The session cannot
  say how many signatures were dropped this way, because the drop is recorded
  nowhere.** 13,739 signatures were recovered by gap fill while only 6,358
  records exist; most of that difference is the dedupe working as intended, but
  an unknown part of it is this.

---

## Task C — the published numbers were built live over RPC, not through replay

**Established by code path, and the answer is clean: no number in handoff 16 or
17 passed through the replay harness, so the C1 collapse defect never touched
them.**

```
grep -rn "tests/replay|replay/run|replay/session|replaySession|parseSession" src scripts analysis
→ no matches
```

Nothing outside `tests/` imports the session-replay harness at all.

- `scripts/calibrate-delays.ts` imports `dotenv/config` and
  `src/calibration/poolHistory.ts` + `replayDelays.ts`, and fetches pool history
  from RPC itself.
- `src/calibration/poolHistory.ts` imports `parseSwap` and `node:fs`. Nothing
  from `tests/`.
- `src/calibration/replayDelays.ts` imports only `core/types` and
  `poolHistory`.
- `scripts/export-wallet-history.ts`, which produces the `.decisions.csv` that
  `analysis/part1_decide.py` reads, imports `parseSwap` directly. Its single
  textual mention of `walletStream` is a comment about ordering.

**Watch the naming.** `src/calibration/replayDelays.ts` "replays" *pool history
at different delays*. It has nothing to do with `tests/replay/`. The collision is
an easy way to reach the wrong conclusion in a hurry.

The Task A loss mechanism does not reach them either: both calibration inputs do
their own signature paging and call `parseSwap` directly, never through
`walletStream`'s `SeenSignatures` or its bounded queue.

---

## Task D — not started, and not for want of time

Task D wants a `seq` discriminator and a reason tag on the recorded quote line,
behind a format version bump.

**Task A changed what the recorder should record, so designing v2 now would bake
in the wrong schema.** Three fields are currently dropped that this session
needed and could not get:

- `parseSwap`'s `detail` on `swap-unparsed`, which is the difference between a
  benign miss and a systematic account-key failure;
- the wallet a signature was attributed to, without which "which subscription
  delivered this" is unanswerable;
- the queue-overflow drop, which is emitted as `error` and excluded by name.

A format version that adds a quote reason tag but still cannot say why a
transaction failed to parse would spend the version bump on the smaller problem.
Both belong in one v2, specified together.

---

## What the next session should do first

1. **Retry the null fetch, and do not admit a signature until it has been
   fetched.** Moving `seen.admit` after a successful fetch, plus a bounded retry
   on `null`, is the whole of the Task A fix. Then re-run
   `scripts/classify-unparsed.ts` on a fresh session: the swap-like rate should
   collapse toward zero, and that is a measurable before/after.
2. **Recorder v2**, specified with Task A's fields and Task D's together.
3. **Split `stream-disconnected`** into a drop and a failed-attempt event so the
   counter means something. No backoff change.
4. `signal_age_ms` — unchanged, still blocked on a signed sign-off.
5. **The remote.** Five sessions of work exist in one place on an exFAT volume.

---

## Verified vs assumed

**Verified from code or chain this session:** that the parser does not gate on
program id, and that 1,453 parsed swaps carry `venue: 'unknown'`; the four reason
codes and their counts; that 50/100 sampled `WALLET_NOT_IN_TX` re-parse as swaps
against the same single tracked wallet; that all 30 sampled such transactions
involve exactly one tracked wallet; that every signature in the session appears
exactly once with zero overlap between parsed and unparsed; that `seen.admit`
precedes the fetch and neither the `null` nor the error path retries; the
disconnect reason breakdown; that gap fill truncates only on a cold start at 100;
that queue-overflow drops are emitted as `error` and excluded from recording;
that nothing outside `tests/` imports the replay harness.

**Assumed, and worth challenging:** that a transaction which re-parses today
would have parsed at fetch time had the fetch been retried. The inference is
strong — same parser, same wallet, different answer, so the input differed — but
the specific failure mode (`meta: null` versus a short account-key list versus a
`null` result) was **not** observed directly, because `detail` is not recorded
and the moment has passed. The fix in item 1 is right regardless of which of the
three it was, but the *rate* it recovers could differ from 50%.

**Not investigated:** what fraction of the 13,739 gap-filled signatures were
dropped by queue overflow; whether the 298 `NO_SOL_LEG` movements matter to a
strategy that could hold non-SOL pairs; why `9uNefL6…` screened `unknown` on its
first occasion, still open from handoff 19.
