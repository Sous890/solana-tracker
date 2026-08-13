# 28 — Tasks 0 and 1: the concentration was dust, and confluence is real but short

`c` has never met a fill. Every margin below is computed at an assumed `c`, and
the swept range 0 to 1.11% is reported for each. Per the standing constraint,
conclusions whose sign changes inside that range are labelled where they appear.

Scored against `28-prereg.md`. Both tasks free, no RPC.

---

## Correction to the prereg's motivating figures

The prereg says *"at entry delay zero, the wallet's payoff is 1.20 and a
copier's is 0.60."* On the matched 67-mint population:

| | payoff `g_trim/l_trim` |
| --- | ---: |
| wallet's own | **1.65** |
| copier, entry 0 s | **1.21** |
| copier, entry 5.479 s | 0.97 |

**1.20 is the copier's figure at entry zero, attributed to the wallet.** 0.60
appears nowhere. The premise survives — the wallet's own entry print is better
than anything reacting to it, 1.65 → 1.21 at *zero* delay — but the effect is a
27% relative drop, not the 50% stated.

## Task 0 — P1 falsified, and the mechanism is the finding

**Zero of twelve fire at the 50% threshold.** `CT9dekyf` comes back at **2%**,
not the 98% the prereg cites.

| wallet | n | dropped | top1 | top3 | top1 `sol_in` | ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2JptG7VJ | 455 | 4 | 17% | 41% | 1.3714 | 1.5× |
| 2nHsHJpk | 299 | 10 | 13% | 24% | 1.0020 | 1.3× |
| Dhaee3Pz | 95 | 2 | 12% | 33% | 2.0040 | 1.7× |
| HSsJjkHr | 83 | 0 | 11% | 27% | 1.0015 | 1.4× |
| BCagckXe | 845 | 3 | 11% | 25% | 1.0364 | 1.5× |
| C86oRMyU | 557 | 1 | 9% | 24% | 0.4251 | 1.2× |
| CT9dekyf | 615 | 22 | **2%** | 6% | 0.9506 | 1.1× |

**The 98% concentration was two dust trades.** Before the size floor,
`CT9dekyf`'s top winner was a **0.004 SOL entry returning +297,236%**, holding
97.7% of winner mass. Applying `MIN_SOL_IN = 0.05` — `positionSizeSol`, from
`analysis/part1_decide.py:29` — removes two such trades and the top winner
becomes a real 0.95 SOL trade at +145% holding 2.1%.

`yVrqX84d` behaves the same way: 31.6% → 4.7%, driven by a 0.002 SOL entry.

**So the concentration every phase-27 table showed was an artefact of the missing
size floor, not a distributional property of these wallets.** P1 predicted at
least four unreliable; the correct answer is none, once the repo's own floor is
applied.

### What the floor changes

| | no floor | MIN 0.05 |
| --- | ---: | ---: |
| clear at c=0 | 4 | **6** |
| clear at c=1.11% | 2 | **4** |
| **above the +5.19pp basis floor at c=1.11%** | — | **1** |

`yVrqX84d` swings **+16.3pp** (−13.6 → +2.7). `AgiGpUAF` +4.1pp, `2nHsHJpk`
+2.7pp, `CT9dekyf` +1.3pp.

**The decisive line is the last one.** Raw "clears" counts rise, but only
`HSsJjkHr` at +19.5pp is outside the basis bias — and `HSsJjkHr` carried exactly
that into the replay and came out at −27.4pp. The other three sit at +0.3pp,
+2.0pp and +2.7pp, all `INSIDE BASIS BIAS`.

**Annotation owed**: `27-loss-side.md` and the CLAUDE.md provisional-conclusions
list both quote the no-floor counts (four at c=0, two at c=1.11%). Both are
updated to the floored figures with the basis-floor line added, because "four
clear" and "one clears the bias floor" are different claims.

## Task 1 — confluence is real, and short by ~35pp

**Causal by construction.** A decision is bucketed by how many other tracked
wallets bought that mint in the window **before** it, never after. A symmetric
window counts buys that had not happened yet — the same lookahead defect as a
ceiling that could sell at its own entry print. The symmetric variant was
deliberately **not** computed: nine more cells would take R from 29 to 38 for a
statistic nothing can trade.

n=4,193 decisions at the size floor.

| window | bucket | n | win | g_trim | l_trim | M43 c=1.11% | M1247 c=1.11% | lift |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 130 s | solo | 3863 | 40.3% | 14.9% | 21.8% | −23.7 | −24.7 | — |
| | 2 | 266 | 45.1% | 13.6% | 19.7% | −23.4 | −27.1 | +4.8 |
| | **3+** | 64 | **53.1%** | 15.3% | **15.0%** | **−12.5** | −19.9 | **+12.8** |
| 470 s | solo | 3627 | 39.4% | 14.6% | 21.9% | −25.2 | −26.1 | — |
| | **2** | 424 | **50.9%** | 15.0% | 19.0% | **−13.1** | −16.0 | **+11.5** |
| | 3+ | 142 | 45.8% | 17.7% | 19.2% | −17.6 | −22.6 | +6.3 |
| 1355 s | solo | 3434 | 39.3% | 15.1% | 22.0% | −24.8 | −25.8 | — |
| | 2 | 503 | 50.7% | 12.7% | 17.5% | −15.4 | −18.0 | +11.4 |
| | 3+ | 256 | 42.2% | 17.8% | 22.0% | −22.1 | −25.8 | +2.9 |

**Every bucket beats solo, and the effect is not only in the win rate.** The
best cell — 3+ at 130 s — has `l_trim` of 15.0% against solo's 21.8%. Confluence
improves both sides of the ratio.

**Nothing clears.** Best cell is −12.5pp at M43 c=1.11%, −19.9pp at the wide
band. Every cell fails at both ends, so no verdict is refused for flipping.

**The lift is not monotone in bucket size.** 3+ beats 2 at 130 s but loses to it
at 470 s and 1355 s. With n of 64–256 in the 3+ buckets that is consistent with
noise, and it is a reason not to read the ordering as a dose-response.

### The framing that matters

This is measured on the **wallets' own outcomes**. Session 27 measured the copy
gap at **47pp** on the one wallet where it has been measured. A +12.8pp
own-outcome lift is therefore roughly **35pp short before a copier touches it** —
which is the whole thesis of this session restated from the other direction.

Confluence is a real property of the corpus and it is the first entry-side
variable this project has found that moves anything. It is not a tradeable edge
at this magnitude.

## Scoring, and the shading has overcorrected

| | prediction | actual | direction |
| --- | --- | --- | --- |
| P1 | ≥4 of 12 fire, `CT9dekyf` among them | **0 fire**, `CT9dekyf` at 2% | **pessimistic** |
| P5 direction | buckets 2 and 3+ beat solo | confirmed, all six cells | ✓ |
| P5 magnitude | lift under 8pp at every window | **12.8 / 11.5 / 11.4** in three cells | **pessimistic** |
| P5 conclusion | nothing clears at R=29 | confirmed | ✓ |
| P6 | 3+ at 130 s too thin, n<30 | **n=64** | **pessimistic** |

**Phase tally moves from 5 optimistic : 1 pessimistic to 5 : 4.**

That is the instrumentation earning its place a second time, and it now says
something actionable: **the ~40% shading applied in the last two
pre-registrations has overcorrected.** Three of the last four misses are
pessimistic. The next pre-registration should shade less, and say so.

Note the asymmetry in what the misses cost: every pessimistic miss here left the
*conclusion* intact — nothing cleared in either task. Over-shading has been
producing predictions that are wrong in a direction that does not change any
verdict, which is cheap but is still miscalibration.
