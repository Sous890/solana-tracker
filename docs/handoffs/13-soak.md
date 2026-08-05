# Handoff 13 — Recorder in the live path, soak runner, crash drill

**Tests: 701 before, 732 after** (+31). Typecheck and build clean.
`src/core/*` and `src/db/ledger.ts` unchanged.

Files added: `src/services/soak.ts`, `src/cli/soak.ts`,
`scripts/measure-recorder.ts`, `tests/soak.test.ts`,
`tests/fixtures/soak-child.ts`. Extended: `recorder.ts` (rotation, retention,
redaction, the fifth kind), `tracker.ts` (recorder lifecycle, stream event
forwarding), `tests/replay/session.ts` (truncation tolerance, quote history).

## THE HEADLINE: no soak was run, and none could be

**There are no credentials in this checkout.** `.env` does not exist. Nothing in
this prompt ran against a live RPC, so:

- **record mode ships unverified against a live RPC**, exactly as the prompt
  anticipated;
- **`npm run soak` has never executed** beyond argument parsing — it requires
  `RPC_HTTP_URL` and `RPC_WSS_URL` and exits 2 without them;
- every number below comes from synthetic events or a real local process, never
  from real market traffic.

Everything that *could* be built and tested offline was. Everything that needs a
live endpoint is scaffolding awaiting one.

## A correction I have to lead with

Mid-prompt I wrote up a **production defect that does not exist**. The crash
drill failed with:

```
SqliteError: database is locked   (SQLITE_BUSY)
  at rebuildProjections (src/db/ledger.ts:793)
  at reconcileOnStartup  (src/db/ledger.ts:1093)
```

I attributed it to the runtime opening four connections to one SQLite file with
no `busy_timeout`, added the pragma to the three modules that are not frozen,
and drafted this handoff calling the fourth a defect in frozen `ledger.ts`.

**That was wrong.** The real cause was my own test harness. `child.kill()` kills
the `npx` wrapper and orphans the `node` process beneath it, and the crash-mode
child loops until killed — so it never stopped. Fifty of them accumulated,
`load average` passed 100, and they were **still holding the crash-drill
databases open**. The lock was a live writer, not a missing pragma.

Symptoms it also explains, all of which I had been treating as separate flakes:
`cli-orphans` and the tracker's orderly-stop child timing out at 5s, the
strategy runner's 500ms timeout tests failing, and the suite going from 22s to
63s. After `pkill` and switching the drill to `detached: true` +
`process.kill(-pid)`, the full suite runs in **4.9s with 732 passing, nothing
skipped, and no strays**.

The `busy_timeout` pragmas were kept, with their comments rewritten to say they
are defence in depth and **not** a fix for anything measured. The lesson worth
carrying: a test that spawns a process which loops forever must kill the group,
and "flaky under load" deserves `ps` before it deserves a theory.

## 1. Recorder in the live path

`Tracker.start()` opens the recorder before reconciliation; `stop()` flushes and
closes it before announcing `idle`, so a client that sees idle can read a
complete file. `shutdown()` covers a stop from idle.

**The settings are not in `config.json`, and cannot be.** `core/config.ts` is
frozen *and* `.strict()`, so `recordSessions` in the config file is a hard
validation failure rather than something ignored. They live on
`TrackerRuntimeOptions` with environment fallbacks and the specified defaults
(`RECORDING_DEFAULTS`): `recordSessions` true, `sessionDir` `./sessions`,
`sessionMaxBytes` 64MB, `sessionRetentionDays` 30. A test asserts both the
defaults and that `parseConfig` rejects them, because the next person will look
in `config.json` first.

Rotation on size **or** UTC date change, whichever comes first. Filenames are
`20260804T114400Z-000.jsonl` — start timestamp, then rotation index. **`seq`
does not reset across a rotation**: it stays monotonic for the whole run, so two
files can be ordered against each other and a gap between them is still
detectable. Retention sweeps `.jsonl` files older than the window at open.

Late binding was needed: the quote source, screener and driver decorators are
built at composition time but the recorder only exists after `start()`, so each
asks the tracker for the current session per call. A run that starts, stops and
starts again records into both files with nothing rewired.

### Truncation tolerance

`parseSession` accepts a damaged **final** line only: it is dropped, reported on
`truncatedTail`, and everything before it is used. A fragment anywhere else
still throws — a hole in the middle is corruption, not a crash.

Tested against a file the recorder actually wrote, cut 40 bytes from the end,
which is what a SIGKILL does. It still parses *and still replays*. A line that
parses but lost its header is treated the same way, because JSON stays valid at
more cut points than one would like.

## 2. The fifth kind

`unmodeled`, carrying `{ tag, raw }`. The classification is three-way and that
is the whole point: a recognised input is recorded, a recognised output is
skipped **by name** (`EXCLUDED_TRACKER_EVENTS`), and anything else becomes
`unmodeled`. A filter that ignored the unrecognised would let a new event type
vanish silently; naming the exclusions means adding one is a decision somebody
makes.

Four new tracker events were added for the digest — `swap-unparsed`,
`stream-disconnected`, `stream-reconnected`, `stream-gap-filled` — and they are
deliberately **not** in the exclusion list, so they surface as `unmodeled` until
someone decides they belong in the model. A test asserts that. The digest treats
any nonzero tag count as a finding.

## 3. The measurement, replacing the argument

`npx tsx scripts/measure-recorder.ts 10000`, single run, Apple Silicon, Node
24.18.1:

| | p50 | p99 | max | total / 10k |
| --- | --- | --- | --- | --- |
| recording OFF | 42 ns | 167 ns | 10.1 µs | 2.3 ms |
| recording ON | 1,792 ns | 6,375 ns | 323 µs | 22.9 ms |
| **delta** | **+1.75 µs** | **+6.2 µs** | — | **+2.06 µs/event** |

**Drop valve under a genuinely stalled writer** (same burst, writer that never
drains):

| | p50 | p99 | max | dropped |
| --- | --- | --- | --- | --- |
| saturated | 292 ns | 1,291 ns | 34 µs | 10,000 / 10,000, all `swap` |

The claim now has a number. Recording costs ~2 µs per event — against a 400 ms
paper settlement delay and a 2 s price loop, four orders of magnitude below
anything that could move a trading decision. The `max` of 323 µs is a real
outlier worth stating rather than hiding; it is still 1,200× smaller than the
settlement delay.

And **dropping is ~6× cheaper than writing** (292 ns vs 1,792 ns p50). Under
saturation the emit path gets *faster*, not slower, which is the valve doing
exactly what it was built to do. Handoff 12 tested the bound at zero and proved
the branch; this proves the pressure.

## 4. Latency decay — NOT DONE

The settlement re-quote is **not implemented**. It is the one numbered item that
did not land, and I would rather say so than ship a half-wired probe.

What was built toward it: `parseSession` now keeps a `quoteHistory` per key and
`quotes` became **first-wins** rather than last-wins, which is the change a decay
report needs (two answers for one key, and the replay must resolve the one that
motivated the intent). `ScreenPayload` gained `ageMs`, lifted out of
`ScreenResult.details`, because the report is meant to bucket by mint age and
that is the only place a session could learn it.

**The measured decay floor is therefore not documented, and the 30 bps penalty
is unchanged and still unjustified.** That is an exit criterion that fails on
evidence, not on judgement.

## 5. Soak runner

`npm run soak -- --hours=24`, digest hourly and at exit, written as JSON and
printed as a table, exiting non-zero when the digest has findings.

`SoakDigest` is pure and incremental — fed tracker events, asked for a snapshot
— so the whole reporting layer is tested without running a soak. A 24-hour
runner whose reporting is only exercised by running it for 24 hours is a
reporting layer nobody has checked.

It reports: tracked swaps by venue; unparsed by reason; unmodeled by tag; guard
rejections by code; no-route-while-held; stream disconnects, reconnect latency
and signatures recovered; quote errors, 429s and cache hit rate; realized P&L,
fees, and paper balance.

**The assertion that is not a metric:** `paperBalanceDrift` must be exactly
zero. The digest recomputes net flow independently from the `fill` events it
saw and compares it against the ledger's own sum. Two routes to one number; a
difference is the 2026-08-03 class of defect, and it is a *finding*, not a
field.

### An exit criterion that cannot be evaluated

> zero unparsed program IDs that account for >1% of tracked swaps

`UnparsedTransaction` is `{ kind, signature, reason, detail? }` — **no account
keys and no program IDs.** The program that produced an unparseable transaction
is not available anywhere downstream of `swapParser.ts`. The digest reports
`unparsedByReason` and an `unparsedShareBps` against the >1% threshold instead;
the program-ID half needs a change to `swapParser.ts` to carry the keys through.

## 6. Crash drill

Scripted and passing on a **real SIGKILL** of a real process writing real files:
`tests/soak.test.ts > crash drill`. It asserts all four requirements — every
session file parses (including the truncated tail), the pre-crash file replays
to a stable SHA-256, the restart reports the surviving open position, and no
intent is left `pending`.

Two things it taught, both now written into the test:

**A killed process's session file is not stable when `exit` fires.** The kernel
is still writing back pages the dead process dirtied, so two reads milliseconds
apart return different lengths — which showed up as two different SHA-256s for
"the same file". The file is read once; re-reading would be testing the page
cache.

**`process.exit()` truncates pending stdout on a pipe.** The restart child
produced empty output intermittently until it switched to `writeSync(1, …)`.

## 7. Secret hygiene

Redaction happens at the **producer**. Every secret the process holds — the RPC
HTTP URL, the WSS URL, the Jupiter key, and every query-string *value* parsed
out of them — is passed to the recorder, which strips them from the serialized
line by substring replacement.

Substring, not a walk over the object, because a secret does not only appear as
a field: an RPC URL turns up inside an error message, a stack trace, a `detail`
string somebody added last week. Tests cover a secret buried in `message`,
`stack`, and a nested array, plus a payload shape that did not exist when the
redactor was written. Secrets shorter than 8 characters are ignored — `sig`
would redact half the file.

The digest is separately asserted to contain no secret, which it achieves by
never being given one.

## EXIT CRITERIA for Prompt 14 (live broker)

| Criterion | Verdict |
| --- | --- |
| 14+ days of soak, ≥100 recorded entry intents | **FAIL** — zero days, zero recorded entry intents. No credentials; not achievable in one session under any circumstances. |
| zero unexplained `unmodeled` tags; zero unparsed program IDs >1% | **FAIL / NOT EVALUABLE** — the `unmodeled` half is instrumented and untested against real traffic. The program-ID half cannot be evaluated at all: the parser does not surface program IDs. |
| zero NO_ROUTE-while-held, or each explained | **NOT EVALUABLE** — the digest counts and flags them; no live run has produced one. |
| crash drill passes from a real SIGKILL | **PASS** — real process, real SIGKILL, all four assertions, in the suite. |
| quote-decay floor documented; 30 bps justified or changed | **FAIL** — item 4 was not implemented. The floor is unmeasured and 30 bps remains an unjustified guess. |

**One of five passes. Prompt 14 is not unlocked**, and the two hard blockers are
the absence of credentials and the unimplemented decay probe — the first
external, the second mine.

## Next

1. Provide `.env` and a tracked wallet; run `npm run soak -- --hours=1` and read
   the digest. Expect `unmodeled` tags on the first run — that is the schema
   being falsified, which is what the kind is for.
2. Implement the settlement re-quote (item 4). The session plumbing for it is
   already in place.
3. Carry program IDs through `UnparsedTransaction` so the second exit criterion
   becomes evaluable.
