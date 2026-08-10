# Architecture and invariants

## Shape

```
  Solana RPC (Helius)
     │  logsSubscribe (WebSocket)          getSignaturesForAddress / getTransaction
     ▼                                     ▼
  ┌──────────────────────────────────────────────────┐
  │ adapters/walletStream.ts                         │
  │   socket · gap fill · dedupe · reconnect chain   │
  │   emits: swap, unparsed, fetch-window,           │
  │          gap-filled, disconnected, reconnected   │
  └───────────────┬──────────────────────────────────┘
                  │ TrackedSwap
                  ▼
  ┌──────────────────────────────────────────────────┐
  │ services/tracker.ts   the orchestrator           │
  │   owns lifecycle, loops, the event stream,       │
  │   and the guard-rejection backstop               │
  └───┬──────────────┬───────────────┬───────────────┘
      │              │               │
      ▼              ▼               ▼
  strategies/    core/guards.ts   services/recorder.ts
  mirror.ts      (the protection   (session .jsonl —
      │           layer)            every measurement
      │              │              comes from these)
      │              ▼
      │      adapters/paperBroker.ts
      │              │
      └──────────────┴──► db/ledger.ts   (intents, fills, positions)
                          db/cursors.ts  (per-wallet stream cursors + barrier)
```

Dependency rule: `core/` depends on nothing but itself. `adapters/` and `db/`
implement ports `core/` defines. `services/` wires them. Nothing in `core/` does
I/O — that is what makes the guard layer and the parser testable without a
network, and what lets the replay harness re-derive a swap from a recorded
transaction.

## The invariants

These are load-bearing. Each one exists because it was violated and the
violation cost something.

### 1. Entries are gated; exits are never gated

`core/guards.ts` is the whole point of the repo. Entries pass every risk limit —
crash orphans, kill switch, run status, signal freshness, gas reserve,
concurrency cap, duplicate holdings, price impact, sellability, daily loss cap.

**Exits are gated only by "is there something to sell, and is a sell already
running."** No risk limit may ever block a sell. A risk limit exists to stop the
bot acquiring more exposure; applying one to an exit traps the bot in exactly
the position the limit was warning about.

The one case that looks malformed and is not: an exit for more than is held is
**clamped and executed**, never refused — the holder it would strand is
precisely the one whose books already disagree with the chain.

Well-formedness (`MALFORMED_INTENT`) is checked on both sides ahead of
everything, and is not a risk limit. A sell of `NaN` tokens of `null` is not an
exit being blocked; it is not an exit.

### 2. The cursor means "delivered", never "received"

`db/cursors.ts` records the last signature **successfully emitted**. A crash
between receiving and emitting must re-deliver, not skip. Re-delivery is the
safe direction; the dedupe set absorbs it.

### 3. A cursor never names a position whose predecessors are unhandled

Added session 25. Both producers — the live socket and gap fill — write through
the same cursor, and a live delivery could advance it past gap-fill entries not
yet handled. `until:` returns only what is *newer*, so those entries became
permanently unreachable.

The barrier is a contiguous-prefix watermark: `hold` / `reserve` / `release`.
Ordering is by **slot only** — it is the one key present on both delivery paths.
Intra-block position is not (`transactionIndex` rides on the signature entry from
`getSignaturesForAddress`; a live notification has no index), so same-slot ties
are resolved by refusing to move.

Barrier state is in memory and deliberately not persisted: a crash must lose it,
because nothing above the barrier ever reached the table.

**The barrier is not reentrant.** `hold` throws if the wallet is already held.
Two concurrent wallet loops would defeat it silently.

### 4. Dedupe is keyed on `(wallet, signature)`

One transaction can legitimately belong to two tracked wallets. A signature-only
key deduped the second away before it was ever fetched.

### 5. The parser fails towards being noticed

`parseSwap` works from balance deltas, so a venue it has never heard of still
produces a swap with `venue: 'unknown'` — metadata, not a verdict. An earlier
session blamed unrecognised venue programs for missing swaps and was disproved.
Likewise `isInfrastructureOnly` returns false for a program set it does not
recognise: an unknown program is admitted as a trade rather than filtered away.

The digest mirrors this in the opposite direction: an unrecognised *reason code*
is `unhandled` and alarms on first occurrence. Unknown venue → admitted as a
trade. Unknown code → treated as a defect. Both fail towards being seen.

### 6. Orphans shut the entry gate

An intent left `pending` by a crash becomes a `CRASH_ORPHAN` on the next start
and blocks every buy until an operator clears it by hand (`npm run orphans`).
There is deliberately no clear-all.

### 7. `reconnected` means the feed is live

Added session 25. It used to fire after the post-reconnect gap fill regardless of
whether the socket had died during it. Every reconnect-latency figure measured
before that is an interval that may have ended with no socket.

## Threshold discipline

Every alarm threshold in `services/soak.ts` must name its basis: the value, how
it was derived, the run and `n` it came from, and when it was last validated. A
threshold that cannot name its basis is re-derived from recent data or removed —
not carried forward.

This exists because **six counters have now cried wolf**: paper balance drift,
queue-overflow attribution, decision-record classification, the unparsed rate,
the disconnect count, and the recorder stats. The measure of success is not that
those six are fixed; it is that the seventh announces itself.

Findings print their threshold and basis alongside the value, so a stale one is
visible the moment it fires rather than a session later.

## Environment hazard

The development host enters Deep Idle sleep aggressively — 434 sleep transitions
in one 24-hour period, 32 in a 3-hour control window. A soak that is not run
under `caffeinate` measures a machine that was asleep. **Session 23's entire soak
was invalidated after the fact for exactly this.** Every soak now asserts its own
environment integrity and labels its numbers void if it cannot prove it was
awake.
