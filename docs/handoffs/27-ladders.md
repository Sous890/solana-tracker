# 27 — Scale-out ladders: the family is bounded, and it closes

`ladder_rules_v2.py`, offline against the 66 priced paths. R = 20, band 43..860.

**Verdict: nothing clears.** Best out-of-sample is **full exit @ +20% at −2.9pp**
(M43, c=1.11%), which is not a ladder. **The ladder family is bounded by the
full-exit probes and therefore closed** — not empirically, analytically.

---

## 1. The stop confound was worth ~24pp, as diagnosed

v1 embedded a hard −40% stop in every ladder while the phase-27 mirror baseline
has no early exit at all. Removing it, same rules, same paths, out-of-sample:

| rule | v1 (stop embedded) | v2 (stop-free) | |
| --- | ---: | ---: | ---: |
| ladder A | −38.0pp | **−13.8pp** | +24.2 |
| ladder B | −36.0pp | −11.4pp | +24.6 |
| ladder C | −33.7pp | −8.8pp | +24.9 |
| flat | −31.3pp | −7.1pp | +24.2 |
| front | −28.8pp | −5.7pp | +23.1 |

A uniform ~24pp across all five, which is the signature of a confound rather
than an effect. It also independently reproduces the CLAUDE.md finding that a
stop at a data-suggested level costs 18–22pp on this wallet.

**The basis gate is why this is trustworthy.** v2 refuses to print a rule table
unless the mirror reference reproduces `27-stop-family.md` to within 0.6pp. It
passed at 48.5% / 16.6% / 12.5%, −15.7pp — exact.

## 2. The family is bounded, analytically

A ladder's return is `Σ fᵢ·r(Lᵢ) + (1 − Σfᵢ)·mirror` — a convex combination of
the full-exit outcomes and the mirror, because a rung at level L fires at the
same print a full exit at L would. So `max(ladders) ≤ max(full exits, mirror)`
by construction, and the probe confirms it:

> best ladder **−5.7pp** vs best full exit **−2.9pp** → **BOUNDED**

**No weighting of these levels can beat exiting fully at the best single one.**
That closes the ladder family without testing more weightings, which is the
result worth keeping: further ladder search on this wallet is provably
unnecessary, not merely unpromising.

## 3. Out-of-sample, n=33

| rule | win | g_trim | l_trim | top1 | M43 c=0 | M43 c=1.11% | M860 c=1.11% |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mirror (ref) | 48.5% | 16.6% | 12.5% | 31% | −11.9 | −15.7 | −24.8 |
| **full exit @ +20%** | **57.6%** | 19.9% | 13.2% | **10%** | **+0.5** | **−2.9** | **−11.9** |
| full exit @ +40% | 48.5% | 22.9% | 12.5% | 15% | −4.2 | −7.4 | −16.5 |
| full exit @ +75% | 48.5% | 17.8% | 12.5% | 26% | −10.1 | −13.8 | −22.9 |
| ladder A 5/10 | 48.5% | 17.4% | 12.2% | 28% | −10.1 | −13.8 | −22.9 |
| ladder B 10/20/30 | 48.5% | 18.6% | 11.8% | 24% | −7.8 | −11.4 | −20.5 |
| ladder C 20/30/50 | 51.5% | 18.6% | 12.1% | 19% | −5.2 | −8.8 | −17.9 |
| flat 1/3 | 54.5% | 18.1% | 12.5% | 17% | −3.5 | −7.1 | −16.2 |
| front 50/30/20 | 57.6% | 17.8% | 13.2% | 14% | −2.1 | −5.7 | −14.7 |

**Every `top1` is 10–31%**, so no rule here rests on one path — unlike the
candidate screen, where two wallets had a single trade carrying 50–91% of winner
mass. The estimators are sound on this dataset.

`full exit @ +20%` is **+0.5pp at M43 c=0** and negative everywhere else. It
flips inside the band, so it is **REFUSED**, not read — and +0.5pp is inside the
+5.19pp basis floor regardless, so it would not have been a result even if the
band had held.

## 4. The ordering is monotone, and it points away from laddering

Sorted by out-of-sample margin: **front (−5.7) > flat (−7.1) > C (−8.8) >
B (−11.4) > A (−13.8)**. The more of the position taken off at the first rung,
the better — and the limit of that progression is *not a ladder at all* but a
full exit at +20%, which is the best rule tested.

**The "less at the start" thesis is falsified in the direction of its opposite.**
Ladder A, which sells 15% and leaves 85% riding to the mirror, is the worst of
the five and is indistinguishable from the mirror it mostly is.

## 5. The fitting penalty is negative again

Best in-sample rule is `full exit @ +20%` at −12.2pp; the same rule
out-of-sample is **−2.9pp**, an *improvement* of 9.3pp.

That is not a rule generalising well. It is the same regime asymmetry
`27-stop-family.md` recorded: the out-of-sample half is the more favourable
period (mirror −15.7pp against −35.1pp in-sample). Two independent rule families
have now shown ~zero or negative fitting penalty on this dataset, which is the
evidence that the failure is structural rather than small-sample.

## 6. R accounting, corrected before the run

The header claimed R 17 → 19 on the grounds that "+20% and +75% are genuinely
new levels". It forgot **+40%**. Part B ran +25/+50/+100, so the overlap with
20/40/75 is empty and all three are new: **R = 20, band 43..860.** Corrected
before running, not after seeing a table.

The five ladders add nothing to R as corrected implementations of five already
counted — but that holds *only because v1's ladder numbers are discarded rather
than compared against*. Selecting the better of the two implementations would
have been a search over ten.

Under A2 this makes R = 20 for the whole phase. Part B and the stop family were
scored at M516; M860 is strictly harsher and both already failed at both ends,
so no verdict moves.

## 7. Where this leaves it

Three exit families have now been tested on this wallet — take-profits, stops
and trailing, and scale-out ladders — pre-registered, split out-of-sample, and
scored against a stated basis floor. All fail. The ladder family additionally
**closes**: its best member is bounded by a single-level full exit, and that
full exit does not clear either.

The `27-stop-family.md` retirement stands and is now better supported: it was
argued on two families and a near-zero fitting penalty, and a third family has
since failed and proved itself bounded while doing so.
