# Handoff 18 — the suite is trustworthy again, and why

**Both soak flakes were mechanism bugs, not timing noise. One of them was in
product code.** Task B was not done: the SIGN-OFF line was present but unsigned,
the operator confirmed it was not a sign-off, and `db/ledger.ts` was not touched.

Suite: **851/851 passing**, typecheck clean, build clean. Test count unchanged.
No `TODO`, `FIXME`, `it.skip`, `describe.skip` or `.only(` in `src`, `tests` or
`scripts`.

All measurement was done on the APFS clone at `~/dev/solana-tracker`, which is
the git `origin` of the exFAT working copy and was at the same commit.

---

## Measured rates, per test, before and after

30 isolated runs and 30 contended runs in each condition. Contention was two
concurrent full-suite loops plus four CPU spinners; load average is stated
because it is the variable that moves these numbers.

| test | isolated before | contended before | isolated after | contended after |
| --- | --- | --- | --- | --- |
| `crash drill > survives a real SIGKILL` | **9/30 (30%)** | **19/30 (63%)** | 0/30 | 0/30 |
| `rotation > does NOT reset seq across a rotation` | 0/30 | **2/30 (6.7%)** | 0/30 | 0/30 |

Contended-before ran at load average 82–96. Contended-after ran as two batches
of 15: the first ramped 10→62, the second 78→**155**, so the second batch was
harsher than the baseline rather than easier. Both were clean.

**What 30 consecutive passes is worth: it bounds the true failure rate below
roughly 10% at 95% confidence, and no lower.** For the crash drill that is
already below the 30% baseline, but it is the named mechanism below — not the
run count — that justifies the fix. Both mechanisms were reproduced directly and
independently of vitest before anything was changed.

---

## Mechanism 1 — the crash drill asserted against an oscillating position

**The child traded one mint, alternating buy and sell every 5ms, so that mint's
position oscillated open↔flat with a ~10ms period; the parent killed at an
unsynchronised random offset, making "a position survived the crash" a coin flip
on the phase of that oscillation.**

Measured, not inferred. Sampling the `positions` table every 1ms while the child
ran gave a median half-period of 5ms and **49.3% of samples flat inside the
parent's 50–300ms kill window**. (A first pass sampling every 11ms showed the
position stably open and was wrong — 11ms aliases almost exactly onto a ~10ms
oscillation. The finer trace is what settled it.)

The 49.3% flat rate against a 30% observed failure rate is a real gap. The
restart report is rebuilt from `fills` by `reconcileOnStartup` rather than read
from the `positions` cache, and the two need not agree at the instant of a
SIGKILL, so some kills that caught the cache flat still reconciled to open. The
direction does not matter to the conclusion: the assertion was sampling a
coin flip either way.

The old comment claimed READY was printed "only once a complete round trip is on
disk". It was actually printed after three fixed 60ms sleeps, which under load
is not the same claim.

**Fix.** The child now buys a second mint, `ANCHOR_MINT`, that nothing in the
system can sell — the fake wallet never sells it and `noScheduler` means no
price ticks — and **polls `ledger.getOpenPositions()` until that row actually
exists** before printing READY. The churn loop keeps hammering the original mint,
so the SIGKILL still lands mid-write, which is the whole drill. The kill delay is
still random on purpose.

The assertion is now **stronger**, not weaker: it names the anchor mint and its
exact token amount instead of counting rows, so it can no longer pass on the
churn position happening to be open.

---

## Mechanism 2 — `SessionRecorder.close()` did not flush rotated-away files

This one is **product code**, in `src/services/recorder.ts`.

`maybeRotate` called `previous.end()` with no completion callback and dropped the
reference. `close()` awaited only `this.stream`. So `close()` could resolve while
an earlier session file still held unflushed bytes — usually zero bytes on disk
when the rotation had just happened.

Reproduced outside vitest, 300 iterations of the rotation scenario:
**51/300 (17%) lost lines after `close()` resolved.** The short file was always
one that had been rotated away from, never the last one. In the test this
surfaced as `SyntaxError: Unexpected end of JSON input` — `JSON.parse('')` on an
empty file — which is why it never looked like what its name says.

**It is not a `seq` reset.** `this.seq` is assigned once in the constructor and
only ever incremented; `maybeRotate` does not touch it. The test name is about a
property that holds. The gate in the prompt — stop and ask if seq can actually
reset — was therefore not triggered.

**It is still a genuine defect, and it is worse than a flaky test.** A clean
shutdown that rotated could leave a session with a `seq` gap, and the replay
loader refuses a session with a gap. The failure mode is a session that is
silently unfit for replay — which is exactly the artifact this project's
calibration work depends on.

**Fix.** A `flushing` set holds one promise per stream `end()` has been called
on; `close()` awaits all of them. Rotation itself still does not await anything,
so the live path is unchanged — recording must never gate trading. The promise
also resolves on `error`, because a failed stream never emits `finish` and
waiting for it would turn a write failure into a hang.

After: **0/400 iterations lost lines.**

---

## The fixes were checked against a real regression, not just against green

Two mutations, each reverted immediately:

1. Mirror strategy stops emitting buys → the child does not silently hang or
   pass. It exits 3 with
   `SOAK-CHILD GAVE UP: a position in EPjF… opened did not happen within 30000ms`,
   and the parent surfaces it as `child exited (3) before READY` in ~31s rather
   than waiting out the 45s READY timeout.
2. Test's `ANCHOR_MINT` pointed at a mint the child never buys → the new
   assertion fails, so it is load-bearing rather than vacuous.

Nothing was skipped, retried, serialised, or given a longer sleep. No assertion
was weakened; one was tightened. No guard, threshold, config floor or timeout was
changed. The sell path was not touched.

---

## Finding that is NOT fixed, and needs an operator decision

**A clean clone of this repo cannot pass its own test suite.**

`tests/fixtures/transactions/wallet-key-from-lookup-table.json` is matched by
`.gitignore:8`, the secrets rule `wallet*.json`. It has never been committed. It
exists only in the exFAT working copy, where — because it is ignored — it does
not show up as untracked, so `git status` is clean and nothing signals the gap.

On the fresh APFS clone this cost **7 failures in `tests/swapParser.test.ts`**,
including `covers all five venues plus the hard cases`. I copied the file across
from the exFAT copy (left untracked, exactly as it is there) to reproduce the
operator's real environment; that is how the 851/851 above was obtained.

I did not change `.gitignore`. Loosening a secrets rule is not a call to make
unilaterally, even when the specific file is plainly public data — the capture
holds a mainnet signature and a public address, no key material. The narrow fix,
if wanted:

```
wallet*.json
!tests/fixtures/transactions/wallet*.json
```

That un-ignores nothing outside that one fixtures directory. Until it is applied,
"the suite is green" is a statement about a working copy, not about the repo, and
this session's whole premise says that distinction matters.

---

## What the next session should do first

1. **Decide the `.gitignore` question above.** It is cheap and it is the
   remaining reason a green run is not reproducible from the commit alone.
2. **Task B — persist `signalAgeMs`** — still not done and still blocked on a
   signed sign-off for `db/ledger.ts`. The gap is unchanged: 272 of 290 intents
   rejected `STALE_SIGNAL` on 2026-08-05, with the code stored and the age not,
   so `maxSignalAgeMs` cannot be tuned from the ledger. Scope as previously
   specified: additive nullable `signal_age_ms` on `intents`, no backfill and no
   inferring an age from timestamps, idempotent migration, a test that reconciles
   a pre-migration fixture DB clean, a test that a strategy cannot forge the
   value (`StrategyRunner` overwrites it — see `strategyRunner.ts:383`), and a
   histogram read path for executed vs `STALE_SIGNAL`. Do not change
   `maxSignalAgeMs` while collecting.
3. **The replay-determinism test on a real session file**, which was already
   named as next session's #1 and is untouched.

Unchanged and unexamined this session: TAU, `kelly_fraction`, M, the wallet
rejection in handoff 17, the delay-bucket representativeness gap, and everything
in `src/core/`.

---

## Environment notes worth keeping

- **The primary working directory has a trailing space**:
  `/Volumes/LaCie/Operation grootenstine /solana-tracker`. A path written without
  it does not exist and the error looks like a missing repo.
- The APFS clone had no `node_modules`. This npm gates install scripts, so a
  plain `npm ci` leaves `better-sqlite3` with no native binding and `esbuild`
  with no binary. `npm approve-scripts better-sqlite3 esbuild fsevents` then a
  clean `npm ci` fixes it — and it writes an `allowScripts` block into
  `package.json` that should not be committed. It was reverted here.
- In zsh, a glob that matches nothing (`rm -f /tmp/soak.*.log` on an empty
  directory) aborts the **entire** command line, not just that command. A
  measurement loop written that way silently does not run and reports zero
  failures, which reads exactly like a passing baseline.
- Piping a long-running loop through `tail` buffers all of it, so progress is
  invisible until it finishes. Write per-run logs instead.
- Three `serve.ts` processes from 13:58 were running on the exFAT copy for the
  whole session. They were left alone — they hold only the exFAT database and the
  tests here use temp DBs — but they are still there.
