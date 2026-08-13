# 28 — The copy gap is not constant, and the 47pp reference was an artefact

`c` has never met a fill. Every margin here is computed at an assumed `c = 1.11%`
and inherits that.

Task 2, first wallet. Scored against `28-prereg.md` and its amendment.

---

## 1. The basis gate fired twice, and both catches were real

### Catch 1 — 479 milliseconds is worth 4.5pp

The gate expected the published **−27.4pp** and got **−22.8pp**. Diagnosed on the
same 66 paths:

| entry instant | margin |
| --- | ---: |
| +5.000 s — the delays-grid bucket, and the published figure | **−27.3pp** |
| +5.479 s — what the prereg specifies | **−22.8pp** |

The published headline is the 5.000 s bucket; every session-28 convention says
5.479 s. **The gate was comparing two different quantities and correctly
refused.** The expectation was corrected to the prereg's own convention — the
tolerance stayed at 0.6pp, and the 5.000 s figure still fails against it.

**The 4.5pp is itself a finding.** 5.479 s lands *better* than 5.000 s, so this
is not decay — at n=66 the entry-instant curve is dominated by which specific
print you land on. Audit 2 measured entry 0→5 s at −4.3pp of margin; here a
479 ms shift moves it 4.5pp the other way. **Single-point entry-delay
comparisons at this sample size are not reliable**, and that applies backwards to
every entry-delay figure in phase 27.

### Catch 2 — the 47pp reference compared two different populations

The first scored run reported HSsJjkHr's gap as 47pp. It was pairing:

- **own-outcome margin +19.5pp** — the *session corpus*, n=83 decisions
- **replay margin −27.4pp** — the *RPC export subset*, n=67 mints

Different populations. A gap is a difference of two margins and is meaningless
unless both come from the same trips. **On identical trips HSsJjkHr's own margin
is −9.7pp and its gap is 13.1pp.**

This is the sixth instance of one error class in this phase: take-profit target
against realised win; configured stop against realised loss; replay win rate
against realised breakeven; delayed entry against undelayed exit; session-corpus
`n` against RPC-export `n`; and now this. The matched-population filter is
enforced in `gap-score.ts` with the count reported.

## 2. The result

Entry +5.479 s, mirror +0.364 s, `MIN_SOL_IN` 0.05, c = 1.11%, M = 43.

| wallet | n | own | replay | **gap** | displacement/SOL | window |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| HSsJjkHr | 66 | −9.7pp | −22.8pp | **13.1pp** | **5.77%** (n=61) | 9.9 d |
| BNnN2Mqf | 57 | +17.3pp | −39.2pp | **56.5pp** | **51.20%** (n=36) | 9.1 d |

**The gap is not constant. 13.1pp against 56.5pp — a range of 43.4pp on n=2.**

## 3. The finding that matters most

**`BNnN2Mqf` was the best-looking candidate of the thirty and it is the least
copyable thing measured.**

The 30-wallet screen called it "the only robust profile in the set" — n=176,
`g_trim/g_med` 2.2×, top-1 mass 24%, own margin +19.5pp. It was the wallet
flagged as most worth replaying.

Its measured price displacement is **51.20%/SOL**: a one-SOL entry moves the
price it is entering at by about half. A copier arriving 5.479 s later buys into
a price the wallet itself created. Its replay margin is **−39.2pp**, the worst
measured anywhere in two phases.

**Own-outcome screening actively selected for the wallet that is hardest to
copy.** That is the session's thesis, confirmed in the sharpest available form:
the screen is not merely level-wrong, it is *anti-correlated* with the thing that
decides the outcome, at least on these two.

## 4. Displacement is the first measurable mechanism candidate

| | gap | displacement/SOL |
| --- | ---: | ---: |
| HSsJjkHr | 13.1pp | 5.77% |
| BNnN2Mqf | 56.5pp | 51.20% |
| ratio | 4.3× | **8.9×** |

Both order the same way. **On n=2 that is a direction, not a correlation**, and
it is reported as one — P4 was retired as untestable at n=3 and nothing here
resurrects it at n=2.

It is measurable, it is derivable from any priced path at no extra RPC, and it
is the first candidate this project has for a *copyability* statistic that is
distinct from performance. Whether it predicts is unanswered.

Caveat carried from A3: `blockTime` is second-resolution, so other trades in the
wallet's own second contaminate the bracket. Unfixable, reported not corrected.

## 5. The A4 decision rule depends on which reference, and the consistent one says NOT redundant

| reference | value | `|56.5 − ref|` | fires? |
| --- | ---: | ---: | --- |
| published (mismatched populations, 5.000 s) | 47.0pp | 9.5pp | **yes** |
| half-corrected (mismatched populations, 5.479 s) | 42.3pp | 14.2pp | no |
| **matched trips, matched entry** | **13.1pp** | **43.4pp** | **no** |

Only the third is internally consistent, and it says **Task 2 is not redundant**.
The stability question is live: two wallets, gaps 4.3× apart.

## 6. Scoring

| | prediction | actual | |
| --- | --- | --- | --- |
| P2 | gap positive for all, range > 20pp | +13.1 and +56.5, **range 43.4pp** | **CONFIRMED** |
| P3 | no wallet's gap under 15pp | **HSsJjkHr 13.1pp** | **FALSIFIED** |
| P4 | gap vs pool depth | **RETIRED** — depth unmeasurable, n=3 | — |

**P3's own escape clause applies**: a gap under 15pp "is the most important row
in the phase and needs the same scrutiny as any pass." It gets it, and the
scrutiny kills it — **HSsJjkHr's own margin on this population is −9.7pp.**

A small gap on a wallet that loses money is not cheap copyability. The gap is a
transformation *cost*; what decides anything is `own − gap`, and −9.7 − 13.1
leaves −22.8pp. **Low gap and low value are not the same property**, and ranking
on gap alone would have promoted the worse of these two wallets.

### The shading is now unambiguously overcorrected

P1, P3, P5-magnitude and P6 all missed pessimistically this session. **Phase
tally 5 optimistic : 5 pessimistic**, from 5:1 before session 28. The ~40%
shading applied since the loss-side prereg has cancelled the original bias and
begun overshooting it. The next pre-registration shades **not at all**, and says
so.

## 7. Not proved

- **n=2.** Everything in §3 and §4 is two wallets. The three-wallet run is a
  stability check and cannot become a correlation.
- **Sampling.** `BNnN2Mqf` is 70 mints sampled evenly from 146 to match
  `HSsJjkHr`'s n; the cost is calendar coverage inside a 9.1-day window.
- **`HSsJjkHr`'s own margin is population-dependent**: +19.5pp on the session
  corpus, −9.7pp on the replayed subset. Neither is wrong; they answer different
  questions, and any future quote of either must name the population.
- **Displacement is contaminated** by same-second trades and is a median over
  36–61 trips.
