# 27 — The stop family fails, and the offline phase closes

Scored against `27-stop-family-prereg.md`, written and committed before
`scratch/stop-rules.ts` existed.

**Verdict: every rule fails out-of-sample.** Best is **−19.2pp** at the wide band
with cost — **24pp below the +5.19pp basis floor**. Nothing is near the line,
nothing is inside the bias, nothing is refused-as-ambiguous. R = 12, band 43 to
516, and Part B is re-scored here because A2 triggered.

---

## 1. Out-of-sample — the verdict table

n = 33 test paths (08-05 → 08-11). Margins in pp.

| rule | fired | win | g_trim | l_trim | M43 c=1.11% | **M516 c=1.11%** | |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| mirror + 0.364 s *(ref)* | 0 | 48.5% | 16.6% | 12.5% | −15.7 | −23.4 | ref |
| fixed stop 5% | 21 | 21.2% | 27.1% | 6.8% | −16.4 | −22.4 | fails |
| fixed stop 10% | 16 | 30.3% | 12.0% | 10.4% | −37.0 | −44.1 | fails |
| fixed stop 25% | 7 | 42.4% | 12.6% | 15.8% | −34.3 | −41.9 | fails |
| trailing 10% | 23 | 36.4% | 15.4% | 8.8% | −21.4 | −28.9 | fails |
| trailing 25% | 10 | 36.4% | 11.8% | 13.4% | −38.0 | −45.4 | fails |
| trailing 40% | 7 | 39.4% | 11.8% | 15.2% | −38.0 | −45.6 | fails |
| stop 5% OR TP+50% | 23 | 24.2% | 25.1% | 6.9% | −15.6 | −22.2 | fails |
| stop 10% OR TP+50% | 19 | 30.3% | 18.7% | 10.4% | −25.2 | −32.3 | fails |
| stop 25% OR TP+50% | 10 | 42.4% | 17.1% | 15.8% | −26.2 | −33.8 | fails |
| [B] mirror OR TP +25% | 7 | 48.5% | 17.9% | 12.5% | −13.7 | −21.4 | fails |
| **[B] mirror OR TP +50%** | 4 | 48.5% | 19.5% | 12.5% | **−11.5** | **−19.2** | fails |
| [B] mirror OR TP +100% | 2 | 48.5% | 19.0% | 12.5% | −12.1 | −19.8 | fails — **noise, fired 2** |
| perfect foresight *(ceiling)* | 30 | 83.3% | 19.4% | **2.5%** | +53.1 | **+47.0** | bound |
| worst later print *(floor)* | 30 | 13.3% | 2.7% | 16.6% | −90.7 | −90.7 | bound |

## 2. Stops do not just fail — they make it worse

This is the finding, and it was not predicted.

| | out-of-sample, M516 c=1.11% |
| --- | ---: |
| mirror (no stop at all) | **−23.4pp** |
| fixed stop 10% | −44.1pp |
| fixed stop 25% | −41.9pp |
| trailing 25% | −45.4pp |
| trailing 40% | −45.6pp |

**Every stop at a level the training drawdown distribution suggested is 18–22pp
WORSE than not stopping.** Only the 5% levels, which fire on 21–23 of 33 paths
and are effectively "exit almost immediately", come close to the mirror — and
they get there by trading the position away, not by improving it.

The loss side of these paths is not a bleed that can be cut. It is noise around a
drift: a stop placed anywhere the drawdown distribution suggests fires at the
bottom of the noise and forgoes the recovery. `fixed stop 25%` takes `l_trim`
from 12.5% **up** to 15.8% — it makes the losses *bigger*, because it converts
recoverable dips into realised losses at the worst price.

Perfect foresight still shows `l_trim` at **2.5%** against the mirror's 12.5%. The
loss side is where the ceiling lives, and no causal rule tested reaches it.

## 3. The fitting penalty is 1.0pp, and that is the strongest evidence here

| | |
| --- | --- |
| best in-sample rule | `stop 5% OR TP+50%`, −21.2pp |
| same rule out-of-sample | −22.2pp |
| **drop** | **1.0pp** |

**P8 predicted 10–25pp and is falsified.** The reason matters more than the miss:
a fitting penalty appears when a rule has been tuned to noise it cannot
reproduce. There was nothing to overfit *to*. The in-sample "best" is not a
fitted peak, it is the least-bad member of a uniformly failing set, and it stays
the least-bad out-of-sample.

**A near-zero fitting penalty across a 12-rule search on 33/33 paths is evidence
that the failure is structural rather than a small-sample artefact.** It is the
one piece of reusable evidence this run produces regardless of verdict, and it
argues that more paths would not change the answer.

## 4. In-sample, for the record only

Never the result. n = 33 (08-01 → 08-05).

The two halves are not alike: the mirror baseline is −35.1pp in-sample and
−15.7pp out-of-sample (win rate 27.3% against 48.5%). **The out-of-sample half is
the more favourable regime**, and everything still fails in it. Had the split run
the other way the verdict would be more negative, not less.

## 5. Scoring the predictions

- **P5 — best out-of-sample rule is a fixed stop at 10% or 25%. FALSIFIED.**
  Those two are the *worst* rules tested (−44.1pp, −41.9pp). The best is a Part B
  take-profit; the best of the new family is `stop 5% OR TP+50%` at −22.2pp.
- **P6 — best rule between −5pp and +8pp. FALSIFIED.** Actual −19.2pp, ~14pp
  worse than the bottom of the range. Optimistic again, the fourth prediction in
  this phase to miss in that direction.
- **P7 — nothing clears at M_eff = 516 by more than +5.19pp. CONFIRMED**,
  though trivially: nothing clears at all, at either band end.
- **P8 — fitting penalty of 10–25pp. FALSIFIED**, and informatively. See §3.

## 6. A2, settled visibly

Part B's three rules are re-scored at the wide band in the same table. At R = 3
they read −12.7pp to −25.3pp; at R = 12 they read −19.2pp to −21.4pp. **No
verdict moves** — they failed at both ends before and they fail at both ends now.
The clause cost nothing to honour, which was the point of honouring it rather
than arguing it was immaterial.

## 7. The phase result

Take-profits were tested and fell short. Stops and trailing stops were tested,
pre-registered, split out-of-sample, and fell further short — several of them
worse than no rule at all. The bounds say 137pp of variance sits inside the
mirror window and a causal rule reaches essentially none of it.

**The loss side is not reachable by a causal exit rule on this wallet.**

On this evidence, mirror-copying is retired as an architecture. That is stated
plainly and it is earned rather than over-reached: two whole rule families,
twelve rules, pre-registered levels from a training split, scored out-of-sample
at the wide band against a stated basis floor, with the fitting penalty measured
at 1.0pp to show the failure is structural.

What this rests on, stated with it:

- **One wallet.** `HSsJjkHr` was chosen as the most favourable of twelve — best
  copyability, widest apparent margin, the only one with a delays export.
- **n = 33 out-of-sample**, 36% pool coverage, and a replay basis that Audit 1
  measured as ~5pp optimistic.
- **`c` has still never met a fill.** It is not what decides this — the margins
  are negative at c = 0 throughout — but it remains unmeasured, and the
  `db/ledger.ts` sign-off that would settle it has been requested four times.

The other eleven wallets were already refused on their own outcomes at zero
cost, before any of this. Nothing here suggests revisiting them; every
correction applied to this wallet would apply to them in the same direction.

## 8. Standing

Nothing is sized. `src/core/sizing.ts` stays unwired and `tests/sizing.test.ts`
still asserts it. The offline phase closes here.
