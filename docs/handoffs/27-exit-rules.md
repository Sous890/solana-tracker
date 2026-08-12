# 27 — Part B: the mirror-OR-take-profit family fails

Scored against `27-exit-rule-prereg.md` and its amendment, both written before
any Part B RPC call.

**R = 3, and 3 is where the search stops.** M_eff band 43 to 129. All three
searched rules fail at **both** ends of the band and at **both** costs. No
verdict flips, so nothing is refused-as-undecided — they fail cleanly.

---

## 1. The result

n = 66 priced paths, entry at exactly 5.479 s, exit rules varying and nothing
else. Margins in pp.

| rule | n | win | g_trim | l_trim | M43 c=0 | M43 c=1.11% | M129 c=0 | M129 c=1.11% | |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| mirror + 0.364 s *(reference)* | 66 | 37.9% | 14.3% | 11.4% | −18.5 | −22.8 | −21.0 | −25.3 | ref |
| mirror OR TP +25% | 66 | 39.4% | 18.6% | 11.5% | −10.9 | −14.6 | −13.5 | −17.2 | **fails** |
| **mirror OR TP +50%** | 66 | 39.4% | **20.0%** | 11.5% | **−9.2** | **−12.7** | −11.7 | −15.2 | **fails** |
| mirror OR TP +100% | 66 | 37.9% | 14.3% | 11.4% | −18.5 | −22.8 | −21.0 | −25.3 | **fails** |
| perfect foresight *(ceiling)* | 59 | 86.4% | 15.7% | 5.6% | +51.2 | +46.0 | +49.3 | +44.1 | bound |
| worst later print *(floor)* | 59 | 10.2% | 2.3% | 16.2% | −85.4 | −91.4 | −86.7 | −92.7 | bound |

The best searched rule recovers **10.1pp** against the mirror (−22.8 → −12.7 at
M=43, c=1.11%) and is still 12.7pp short.

## 2. What the bounds say

The window is not short of opportunity. Exit timing inside the mirror window
spans **−91.4pp to +46.0pp** of margin. The mirror sits at −22.8pp and the best
take-profit at −12.7pp, both far below a ceiling that is comfortably positive.

**So the headroom is real and take-profit rules do not reach it.** The gap
between perfect foresight and the best implementable rule is ~59pp. Perfect
foresight is not a strategy — it requires knowing the window maximum in advance
— and that is precisely the information a causal rule does not have.

**`mirror OR TP +100%` is byte-identical to the mirror.** The take-profit never
fires on any of the 66 paths: from a 5.479 s-late entry, the wallet's own
holding period never contains a +100% move. That is a fact about this wallet, and
it bounds what any high take-profit can do here.

### A correction to the ceiling as first computed

The first version filtered `t >= entry[0]`, which includes the entry print
itself. "Sell at the window maximum" can then always sell at the entry price, so
the return is ≥ 0 by construction, `l_trim` came out at exactly 0.0% and the
bound reported +73.8pp while proving nothing. Requiring a strictly later print
gives the +46.0pp above. Recorded because a ceiling that cannot lose is not a
ceiling.

## 3. Scoring the predictions

- **P1 — best rule is `mirror OR TP` at +25% or +50%.** Within the family
  tested, **+50% is best**, as predicted. The broader claim — that this family
  beats the other ten — is **not testable at R = 3** and is not claimed.
- **P2 — best rule between −5pp and +5pp at M=43, c=1.11%. FALSIFIED.** Actual
  **−12.7pp**, ~8pp worse than the bottom of the predicted range.
- **P3 — nothing clears at full search deflation.** Consistent so far: nothing
  clears at M_eff = 129 either. Not fully tested, since R = 3.
- **P4 — trailing stops do worst.** Untested. Rules 1–10 were not run.

The A3 amendment predicted the gain would be loss-avoidance rather than
winner-capture. **That is what happened**: `l_trim` is essentially unmoved
(11.4% → 11.5%) while `g_trim` rises 14.3% → 20.0%. So the take-profit did the
opposite of what A3 expected — it captured winners and did nothing about losses
— and it was the loss side that needed fixing. This is the strongest single
argument that the untested stop and trailing families are where any remaining
headroom would be, and it is also why P4 remains genuinely open.

## 4. Why the full sweep is not being bought

The stated condition for the ~9.3 h sweep was that rules 11–13 come back **near
the line**. They came back at **−12.7pp**. They are not near the line.

The price is also worse than costed. The estimate for this batch was 17,998
calls; the actual was **62,217** — **3.5× over**, because the ±30 s window
margin, the per-mint pool-resolution `getTransaction`, and retried calls all
count and none were in the estimate. Scaling the same factor, the p90 horizon
sweep is nearer **480,000 calls and ~30 hours** than the 137,562 and 9.3 h in
the amendment. That correction belongs on the record whether or not the sweep is
ever run.

## 5. What this does and does not retire

**Does:** the mirror exit, and the mirror-OR-take-profit family, on this wallet.
The best of them is 12.7pp short at the most favourable deflation and cost.

**Does not:** mirror-copying as an architecture. The retirement criterion in the
pre-registration was written for the full thirteen rules, and ten were not run —
including every stop and trailing variant, which §3 now identifies as the more
promising family. Claiming retirement on three rules would be exactly the
over-reach the amendment's A2 was written to prevent, in the opposite direction.

The honest statement is narrower and still substantial:

> On HSsJjkHr, at a 5.479 s entry, no take-profit level tested rescues the
> mirror exit. Exit timing inside the window spans 137pp of margin, so the
> variance is there; a causal take-profit rule captures ~10pp of it and needs
> ~23pp. The loss side, which take-profits do not touch, is where the remaining
> ~59pp of ceiling lives.

## 6. Standing

Nothing is sized. `src/core/sizing.ts` stays unwired and `tests/sizing.test.ts`
still asserts it.

`scratch/replay-out/paths.json` holds the 66 priced paths. Every further exit
rule on this wallet is now **offline and free** — the 62,217 calls buy an asset,
not one answer, which is the one thing this batch got right that the earlier
replay did not.
