# 27 — Two audits, one defect, and a withdrawn reading

Both audits ran offline against `scratch/replay-out/paths.json`. No RPC. They
converged on the same defect at opposite ends of the analysis.

---

## Audit 2 — the entry was priced at the wallet's own fill

**Confirmed. It was not excluded.**

`replayDelays.ts` selected the entry with a bare
`firstAtOrAfter(swaps, targetTs)`. `getPoolSwaps` prices every transaction
against the pool; `resolvePoolAccounts` uses the taker only to *identify* the
pool (`poolHistory.ts:181`), never to filter. Measured on HSsJjkHr:

| | |
| --- | --- |
| wallet's entry signature present in the pool path | **64 of 67 (95.5%)** |
| …at exactly `signalTs` | **64 of 64** |
| wallet's exit signature present | **67 of 67 (100%)** |

At delay 0, `targetTs === signalTs`, so `t >= targetTs` includes the wallet's own
buy. From delay 1 s on, `targetTs > signalTs` excludes it — `blockTime` is
second-resolution — so the artefact is confined to the delay-0 rung, which is
exactly where the reported cliff was.

It is worse than "prices at their fill". Several prints share the signal's
second and `orderPoolSwaps` returns whichever sorts first, which is routinely a
trade **ahead of** the wallet's own. The replay was buying before the signal
existed.

### The corrected entry ladder

Exit held at the wallet's exit + 0.364 s. c = 1.11%, M = 43, n = 66.

| entry delay | wallet's print INCLUDED | EXCLUDED |
| --- | ---: | ---: |
| 0 s | **−8.3pp** | **−23.0pp** |
| 1 s | −23.0pp | −23.0pp |
| 2 s | −24.3pp | −24.3pp |
| 5 s | −27.3pp | −27.3pp |

With the wallet's own print excluded, **delay 0 and delay 1 s are identical**, as
they must be at second resolution.

**Withdrawn: the −13.9pp first-second cliff.** It was entirely this artefact. The
corrected entry-delay cost from 0 s to 5 s is **−4.3pp**, not −18.9pp.

**Strengthened: the zero-entry-delay result.** The replay report said the margin
at entry delay 0 was −3.8pp (c=0) / −7.9pp (c=1.11%). Corrected, it is
**≈ −23.0pp at c=1.11%**. "The edge does not survive our exit path at any entry
latency" survives the audit and gets considerably stronger.

**Unaffected: Part B.** Its rules enter at `signalTs + 5479 ms`, so the wallet's
print at `signalTs` was never a candidate. The −27.4pp mirror baseline, the
−12.7pp best rule and the +46.0pp ceiling all stand.

### Fixed in code

Entry candidates now start strictly **after** the wallet's own transaction in
path order, not merely at or after a timestamp. Three tests, one red first — the
other two passed on arrival because the fixture ordering made them trivially
true, which is worth recording rather than claiming three reds.

When the wallet's print is absent from the path (3 of 67, a pool the signature
walk did not reach), there is nothing to slice from and the delay alone governs.
Left as-is: the alternative is discarding a trip over a coverage gap.

---

## Audit 1 — rung 1 is a basis change, not friction

**The "c is far too small" reading is withdrawn.**

### What each side computes

| | numerator | denominator |
| --- | --- | --- |
| **realised** (`export-wallet-history.ts`) | SOL received on the sell tranche, from the wallet's own lamport deltas | SOL paid on the buy tranche, same source |
| **replay** (`replayDelays.ts:156`) | `exit.priceSol` — SOL-per-token of *some* pool print at/after `exitTs` | `entry.priceSol` — same, at/after `signalTs` |

The realised side is a ratio of the wallet's own SOL amounts for one FIFO
tranche. The replay side is a ratio of two observed prices at chosen timestamps,
selected by ordering within a second. Different denominators, different
definition of the trade.

### The paired comparison

Replay(entry 0, exit 0) minus realised, same trips, n = 56:

| | |
| --- | --- |
| median | **+5.19pp** |
| mean | +4.19pp |
| identical to 1e-9 | **0 / 56** |
| within 1pp | 6 / 56 (11%) |
| **sign disagreements** | **18 / 56 (32%)** |
| win rate, replay vs realised | 69.6% vs 41.1% |

If the replay were pricing the wallet's own trade on both legs, these would be
identical. **None of them are.** The within-second ordering is picking different
trades, and it does so with a systematic bias in the replay's favour — buying
below and selling above what the wallet got, because it is filled ahead of the
wallet's own market impact.

### Friction, isolated, with its n

The comparison the audit proposed does **not** isolate friction, precisely
because the print at the wallet's timestamp is not reliably the wallet's trade.
Isolating it needs the two matched by **signature**. The corrected session corpus
carries the wallet's own `solAmount`/`tokenAmount`, so this is computable
offline for the overlap:

**n = 10.** Replay's delay-0 entry print against the wallet's own fill price on
the *same* transaction:

| | |
| --- | --- |
| median | **−3.12%** |
| mean | −3.54% |
| p10 / p90 | −9.57% / +0.38% |
| replay print **cheaper** than the wallet's fill | **8 / 10** |

Positive would mean a copier taking that print paid more than the wallet did.
It is negative: the replay entry is **cheaper**, confirming the ordering bias
above.

### Consequences

- **Withdrawn**: "the +9.8pp rung-0→rung-1 gap shows c = 1.11% is far too small."
  That gap is a basis change plus an ordering bias, and the isolated friction
  estimate runs the other way.
- **Not established**: that c is right either. n = 10 settles nothing, and the
  measurement is of the *replay's* entry price, not of what our broker would
  fill at. **`db/ledger.ts` sign-off remains the only thing that would settle c**
  — requested four times now.
- **New caveat, in the pessimistic direction**: the replay basis is optimistic by
  ~5pp of median return against the wallet's own outcomes. Every replay number in
  this phase inherits that, which makes the negative verdicts stronger and would
  have made a positive one suspect.

---

## What this changes about Part A

The ladder's rung 1 and rung 2 both price the entry at delay 0 and are therefore
affected. **Rung 3's −18.9pp "entry delay" component is mostly the artefact** and
should be read as ≈ −4.3pp. The cost (−4.7pp) and deflation (−14.0pp) components
are unaffected — neither touches entry selection — and the +1.0pp interaction
result stands.

Restated: **deflation, not entry latency, is the largest single component of the
copy tax**, and the entry-latency lever is smaller than the first pass claimed.
That does not rescue anything; it relocates where the loss comes from.
