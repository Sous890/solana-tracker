# 29 — Task 2: displacement screens eleven wallets, and drops the ones that matter

Scored against `29-prereg.md`. `c` has never met a fill; every margin here is at
an assumed `c = 1.11%` and inherits that.

**6,181 RPC calls against a 17,059 estimate and a 25,000 budget guard.** 13
minutes. The estimate was 2.8× high, in the safe direction, because most trips
resolved on the first fetch wave rather than the modelled three.

---

## The basis gate passed on all three constants

| gate | expected | got | |
| --- | ---: | ---: | --- |
| `HSsJjkHr` replay margin, 5.479 s | −22.8pp | **−22.8pp** | PASS |
| `HSsJjkHr` displacement | 5.77%/SOL (n=61) | **5.77%/SOL (n=61)** | PASS |
| `BNnN2Mqf` displacement | 51.20%/SOL (n=36) | **51.20%/SOL (n=36)** | PASS |

Nothing was moved to make them pass. One thing the gate work turned up and it is
worth recording because it nearly became the seventh population error *of this
session*: `HSsJjkHr`'s own outcomes do **not** come from
`exports/HSsJjkHr….csv`, which covers only **33 of the 66** evaluable mints and
reproduces neither figure — own margin −34.0pp, gap −11.1pp. They come from
`scratch/replay-out/HSsJjkHr….csv`, which covers all 66. That file is
**gitignored**, so the only artefact that reproduces session 28's headline gap
exists on this volume and nowhere else.

## The result

Entry +5.479 s, `MIN_SOL_IN` 0.05, c = 1.11%, M = 43, M_eff = 473. `att` is trips
attempted after `sampleEvenly`; `n` is trips that produced a bracket.

| wallet | att | **n** | **disp/SOL** | raw disp | med `sol_in` | own margin | window |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| G3gZWqrY | 12 | 5 | **2.67%** | 33.03% | 10.110 | −12.0pp | 7.7 d |
| FsG3BaPm | 70 | **45** | **4.33%** | 19.00% | 5.051 | −33.9pp | 6.1 d |
| 8deJ9xeU | 70 | **42** | **4.43%** | 9.87% | 3.030 | −28.8pp | 2.9 d |
| 5dd3zjBQ | 70 | **45** | **6.47%** | 14.79% | 1.654 | −31.2pp | 9.9 d |
| CAPn1yH4 | 29 | 10 | 6.79% | 53.64% | 7.578 | −21.3pp | 0.5 d |
| E7gozEiA | 14 | 8 | 7.01% | 10.52% | 2.000 | −70.3pp | 2.2 d |
| J6TDXvar | 70 | **40** | **9.04%** | 51.17% | 5.083 | −29.1pp | 9.8 d |
| 8yJFWmVT | 70 | **50** | **9.54%** | 7.66% | 0.913 | −7.1pp | 7.5 d |
| 4Be9Cvxq | 19 | 4 | 9.63% | 80.44% | 3.000 | **+27.3pp** | 3.1 d |
| 87rRdssF | 38 | 13 | 9.70% | 31.28% | 4.000 | −49.4pp | 9.1 d |
| BNnN2Mqf | 70 | **42** | **47.84%** | 52.29% | 1.078 | **+8.6pp** | 9.7 d |

Bold `n` marks the **six** wallets at or above the pre-registered 20-trip
selection floor. Five are excluded and reported anyway, as pre-registered.

`BNnN2Mqf` reads **47.84%/SOL (n=42)** here against **51.20%/SOL (n=36)** in
session 28. Different populations — session 28 required the trip to be evaluable
in a full replay, this requires only a bracket — and the two agree to within the
population difference. Its own margin reads **+8.6pp (bracketed trips, n=42)**
against **+17.3pp (matched trips, n=57)**; same caveat, name the population.

---

## Scoring

### P2 — CONFIRMED

**2.67% to 47.84%, a spread of 17.9×** across the eleven, and **11.0×** across
the six selection-eligible. Both clear one order of magnitude. Displacement/SOL
is not a near-constant, which is the premise everything else needed.

### P3 — INDETERMINATE, and it landed exactly in the gap the prereg left

**Spearman ρ against median `sol_in` = −0.518** across the eleven, **−0.600**
across the six eligible. The prereg confirms under 0.5 and falsifies above 0.7.
0.518 is neither, and there is no honest way to round it into one.

What the pre-registered test could not see, and it is the more interesting half:

| | spread | ρ vs median `sol_in` |
| --- | ---: | ---: |
| **raw** displacement | 10.5× | **+0.409** |
| median `sol_in` | 11.1× | — |
| **displacement/SOL** | **17.9×** | **−0.518** |

Raw displacement rises with position size, which is what a price-impact
quantity must do. Dividing it by size flips the association to −0.518 and
*widens* the spread from 10.5× to 17.9×. **A denominator that removes a real
effect should narrow the spread, not widen it.** So displacement/SOL is not the
size proxy P3 was aimed at — it is over-corrected in the other direction, and
part of its 17.9× range is the 11.1× range of the sizes it is divided by.

P3 as written is not falsified and §4 of `28-copy-gap.md` is not downgraded.
But "size-normalised" is doing less work than the name implies, and the honest
statement is that **displacement/SOL and position size are entangled at |ρ| ≈
0.5 in a direction the pre-registered test was not shaped to catch.** That is a
finding about the statistic, recorded before it gets used to select anything.

### P4 — CONFIRMED on the letter, unusable in fact

Pre-registered: *at least one wallet has displacement under 10%/SOL and own
margin above +5pp*. One does — **`4Be9Cvxq`, 9.63%/SOL and +27.3pp**.

**It has n=4.** The same pre-registration excludes anything under 20 contributing
trips from selection. So the configuration the 30-wallet screen was structurally
incapable of finding exists in the table and cannot be acted on, and P4 is
reported CONFIRMED with that stated in the same breath rather than as a
footnote.

Among the six wallets that *are* selection-eligible:

- exactly one has a positive own margin — **`BNnN2Mqf`, +8.6pp** — and it carries
  the **highest** displacement in the set, 47.84%/SOL. It is also already
  replayed, at −39.2pp.
- the other five run from −7.1pp to −33.9pp.

**The informative configuration — low displacement *and* positive own margin —
does not exist among wallets this screen can select from.**

---

## The defect that decides how much of this to believe

**181 of 532 sampled trips produced no bracket.** Classified against the cached
pages:

| cause | trips | |
| --- | ---: | --- |
| pool hit `DEFAULT_MAX_SIGNATURES = 20,000` before the walk reached the entry | **108** | measurement failure |
| wallet was genuinely the first print in the 24.5 s before its own entry | 65 | real property |
| cached page set predates the window and was reused | 9 | stale cache |

The 108 are the problem, and not because they are 20% of the sample. **The
signature walk fails on exactly the busiest pools** — a pool has to trade more
than 20,000 times between the entry and now to hit the cap. Pool throughput is
what displacement measures. So the screen systematically cannot see the pools
where a copier's order is smallest relative to flow, which is to say **the drop
is selective on the measured axis, in the direction that biases displacement
upward.**

Every number in the table above is therefore a displacement estimate **on the
subset of pools quiet enough to be paged**, and that subset is not a random
sample of the wallet's trips. It is stated here rather than in "not proved"
because it is not a caveat on the result, it is a property of the result.

**Not fixed, and the reason is the abort rule.** Reaching back ten days on a pool
doing >2,000 transactions a day needs 100–500 pages per mint; on 108 mints that
is 20,000–50,000 further calls, on top of the 6,181 spent. That lands in the
25,000–60,000 band the pre-registration reserves — *"the spend is mine to
authorise, not yours to assume."* So it is reported, not spent.

`blockTime` second-resolution contamination is carried unchanged from A3.

---

## The free bound: the cap cannot move P4, so the 20–50k is not spent

`scratch/cap-bound.ts`, offline. The 20,000-signature repage was gated on whether
it could plausibly deliver P4's configuration. **It cannot**, and the reason is
arithmetic rather than judgement.

`cap` is trips dropped at the walk cap; `ceiling` is `n` if **every one** were
recovered.

| wallet | avail | n | cap | ceiling | disp/SOL | own (bracketed) | own (all trips) | can recovery reach P4? |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 4Be9Cvxq | 19 | 4 | 9 | **13** | 9.63% | +27.3pp | +36.2pp | **no — ceiling below the 20 floor** |
| E7gozEiA | 14 | 8 | 0 | **8** | 7.01% | −70.3pp | +12.7pp | **no — ceiling below the floor** |
| G3gZWqrY | 12 | 5 | 3 | **8** | 2.67% | −12.0pp | +1.8pp | **no — ceiling below the floor** |
| BNnN2Mqf | 70 | 42 | **1** | 43 | 47.84% | +8.6pp | +16.4pp | **no — needs disp to fall 4.8× on 1 recoverable trip** |
| 8yJFWmVT | 70 | 50 | 9 | 59 | **9.54%** | −7.1pp | −2.7pp | the only near-miss; see below |
| 8deJ9xeU | 70 | 42 | 5 | 47 | 4.43% | −28.8pp | −11.4pp | no — own margin negative on both populations |
| 5dd3zjBQ | 70 | 45 | 14 | 59 | 6.47% | −31.2pp | −29.1pp | no |
| CAPn1yH4 | 29 | 10 | 11 | 21 | 6.79% | −21.3pp | −10.5pp | no |
| FsG3BaPm | 70 | 45 | 18 | 63 | 4.33% | −33.9pp | −30.2pp | no |
| J6TDXvar | 70 | 40 | 21 | 61 | 9.04% | −29.1pp | −20.1pp | no |
| 87rRdssF | 38 | 13 | 18 | 31 | 9.70% | −49.4pp | −40.4pp | no |

**The two requirements are met by different wallets and the cap cannot move
either across.** The wallets with real recovery potential — `J6TDXvar` 21,
`FsG3BaPm` 18, `87rRdssF` 18, `5dd3zjBQ` 14 — are 20–40pp underwater on their own
outcomes on *both* populations, and recovering trips moves **displacement**, not
own margin. The only wallet with a positive own margin above the floor,
`BNnN2Mqf`, has **exactly one** cap-dropped trip, and one trip cannot move a
median of 42 by the required 4.8×. `4Be9Cvxq`, which confirms P4 on the letter,
has **19 trips in existence** — it is below the selection floor at perfect
recovery of everything, forever, at any spend.

`8yJFWmVT` is the single honest near-miss: displacement **9.54%, already under the
10% line**, n=50, and own margin −2.7pp on all trips. It needs **+7.7pp**. The
measured sensitivity of own margin to population is the right yardstick and it is
in the table: adding 20 trips (bracketed 50 → all 70) moved it **+4.4pp**. Nine
recoverable trips buy roughly **+2pp** against the +7.7pp needed. Not impossible;
not plausible.

### And recovery would push displacement the wrong way for P4

Within wallets, displacement against local pool flow — signatures in the ±30 s
bracket, which is what the cap selects on:

| | median displacement | n |
| --- | ---: | ---: |
| top-quartile flow (≥346 prints/60 s) | **3.94%/SOL** | 76 |
| the rest | **11.12%/SOL** | 224 |

**2.82×**, pooled ρ = **−0.320**, and negative in 7 of the 10 wallets with enough
trips to compute it. This confirms the bias direction claimed above — the
measurable subset is the quieter pools, so **every displacement figure in the
main table is biased upward** — and it settles the spend question from the other
side: recovery lowers displacement, which is useless when the binding constraint
on every recoverable wallet is a **negative own margin**.

### P3 is not indeterminate, it is unresolvable at n=11

ρ = −0.518, two-sided permutation **p = 0.105** on 20,000 shuffles. At n=11 the
null band on ρ is roughly ±0.60. **The observed value is distinguishable neither
from 0 nor from 0.7** — so the pre-registered thresholds could not have resolved
P3 whatever number came back. That is a defect in the test, not in the result, and
it is worth carrying forward: a ρ threshold pre-registered on eleven points is
not a test.

---

## Task 3 — selected, costed, and not run

The pre-registered rule: *select the wallet with the lowest displacement among
those with positive own margin.* Applied literally that is `BNnN2Mqf`, which is
already measured, or `4Be9Cvxq` at n=4, which the same document excludes. **The
informative configuration was not available**, which is the case the prereg names,
and its fallback applies: *select the lowest-displacement wallet outright.*

**That is `FsG3BaPm` — 4.33%/SOL, n=45, own margin −33.9pp.**

It is not run, for two reasons stated together:

1. **~62,000 calls, ~1.7 h.** No branch of this session's abort rule authorises
   that. 6,181 have been spent of 25,000.
2. **The result is arithmetically foreclosed.** §6 of `28-copy-gap.md` fixed
   `own − gap` as the decision quantity. `FsG3BaPm` starts at **−33.9pp own**, so
   no gap in the 13.1–56.5pp range it is predicted to land in produces a positive
   replay margin. **P6 predicts a negative margin and cannot fail.** The replay
   would answer the stability question — does the gap order with displacement at
   n=3 — and nothing else.

Both are worth the user's call rather than mine, so the three predictions are
left open and stated as they stand:

- **P5** — `FsG3BaPm`'s displacement of 4.33% is the lowest of the three, so P5
  predicts the **smallest gap of the three, below 13.1pp** — which is *outside*
  P5's own pre-registered 13.1–56.5pp band. P5 is self-contradicting on the
  wallet its own selection rule picks, and that was not visible until the screen
  ran.
- **P6** — cannot fail, per above.
- **R** — stands at **29**. No cells were evaluated this session; the screen is
  one pre-registered statistic on eleven wallets, not a search over rules. A
  selection made from it carries **R = 11 retroactively**, and M_eff 473 is the
  independent end of the band, as fixed.

---

## The phase result: P4 is empty where it counts, and no spend changes that

Stated plainly because it is the session's output and it is easy to soften.

**No wallet this screen can select from has the configuration P4 describes**, and
the free bound above shows that is not a sampling accident that money fixes. The
configuration the 30-wallet screen was "structurally incapable of finding" is
also absent from the eleven, at a ceiling of perfect recovery. `4Be9Cvxq` carries
it and has nineteen trips in existence.

P4 is recorded **CONFIRMED on the letter and empty in fact**, and the second half
is the one that decides anything.

**P5 is unsatisfiable on `FsG3BaPm`, and this is recorded before any number
exists.** P5 predicts a gap in **13.1–56.5pp** and an ordering by displacement.
`FsG3BaPm` has the lowest displacement of the three at 4.33%, so the ordering
clause predicts the **smallest** gap of the three — below 13.1pp, outside P5's own
band. **The two clauses of P5 cannot both hold on the wallet P5's own selection
rule picks.** No replay is needed to know that, and running one would produce a
number that scores against a self-contradicting prediction.

## What this does and does not say about the phase

**It does not retire own-outcome screening.** The prereg's condition for that was
P2 confirmed, P3 clean, and no wallet with a positive replay margin. P2 is
confirmed; **P3 turned out to be unresolvable at n=11 rather than clean or
dirty**; the third clause is untested because no replay ran. One of three is not
the finding, and the retirement is not claimed.

**It does say the screen and the outcome are close to orthogonal here.** ρ between
displacement/SOL and own margin is **+0.264** across the eleven — the two
statistics are nearly independent, so displacement is at least measuring
something own-outcome screening does not. On n=11 that is a direction, not a
correlation, and it is reported as one.

**The strongest single row remains `BNnN2Mqf`**: the best-looking of thirty,
highest displacement of eleven, worst replay margin measured anywhere. Nothing
here weakens §3 of `28-copy-gap.md`.

## Not proved

- **The 20,000-signature cap**, above. The largest single reservation on the table.
- **n per wallet is 4 to 50**, and five of eleven are below the selection floor.
  Medians on n=4 (`4Be9Cvxq`) and n=5 (`G3gZWqrY`) are reported because the prereg
  requires it, not because they are estimates.
- **`CAPn1yH4`'s window is 0.5 days**, `8deJ9xeU`'s 2.9. Windows are not comparable
  and are printed per wallet for that reason.
- **Displacement/SOL is entangled with position size at |ρ| ≈ 0.5**, per P3.
- **No replay margin was measured for any of the nine unreplayed wallets.** Every
  own margin here is a zero-latency upper bound, the same one `HSsJjkHr` cleared
  before failing.

## Standing

Nothing sized. `src/core/sizing.ts` unwired. `c` still has never met a fill;
sign-off on `db/ledger.ts` fill-time capture is outstanding for the sixth time.
