# Pre-registration — the stop and trailing family

Written before `scratch/stop-rules.ts` existed. Offline against
`scratch/replay-out/paths.json`. No RPC.

## Why this family

Part B: `mirror OR TP +50%` moved `g_trim` 14.3% → 20.0% and left `l_trim` flat
at 11.4% → 11.5%. The +46.0pp ceiling comes the other way — `l_trim` 5.6%
against 11.4%. **The unreached ceiling is on the loss side and no take-profit
reaches it.**

## THE BASIS FLOOR — +5.19pp

Audit 1 measured the replay basis as **+5.19pp of median return optimistic**
against the wallet's own realised outcomes over the same 56 trips, with 0/56
identical and 32% disagreeing in sign. Every replay number in this phase
inherits that bias.

**A rule landing within +5.19pp of breakeven is inside the known bias and is not
a result.** A stop returning +4pp out-of-sample is reported as *"inside the basis
bias, not a pass"*, and there is no reading under which it is anything else.

The evaluator prints the floor beside every margin and labels any margin in
`(0, +5.19pp]` as `INSIDE BASIS BIAS`, the same way it prints `REFUSED (flips)`
for band inversions. Written here, with the number, before any rule exists.

## A2 triggers, and it is free

Running these makes R the count for the **whole** search. Part B's three rules
are re-scored at the wider band and printed in the same table. They already fail
at both ends so no verdict moves — which is why doing it visibly costs nothing
and settles the clause instead of leaving it looking sidestepped.

## The rule count, final

**R = 12.** Three from Part B (`mirror OR TP` at +25% / +50% / +100%) plus nine
here. **M_eff band 43 to 43 × 12 = 516.**

Rules 8–10 of the original enumeration (time exits) are **not run**. R counts
rules actually evaluated — a candidate never evaluated cannot have been selected
— so dropping them lowers R rather than inflating it.

**No rule is added after seeing a result.** `paths.json` makes every further rule
free, and free compute is the exact condition under which a 12-rule search
becomes a 40-rule search. If the nine below all fail, that is the answer.

### Levels, from the TRAINING SPLIT ONLY

Training half, n=29 paths with a post-entry segment. Max drawdown reached before
the mirror exit: p75 −4.4%, p50 −9.5%, p25 −25.3%.

| # | rule |
| --- | --- |
| 1–3 | fixed stop at **5% / 10% / 25%**, mirror otherwise |
| 4–6 | trailing stop at **10% / 25% / 40%**, mirror otherwise |
| 7–9 | stop at **5% / 10% / 25%** OR TP +50%, mirror otherwise |

Fixed-stop levels are the training drawdown p75/p50/p25 rounded. TP +50% is
Part B's best, carried unchanged rather than re-searched. Trailing levels span a
wider range because a trailing stop measures from the running peak, not from
entry, and the training drawdown distribution does not speak to it.

## The split

66 paths ordered by entry timestamp, first half fits, second half scores.

| | n | span |
| --- | ---: | --- |
| train | 33 | 08-01 20:57 → 08-05 01:14 |
| test | 33 | 08-05 01:46 → 08-11 19:42 |

**The verdict is the out-of-sample number and nothing else.** In-sample figures
appear in the doc labelled in-sample and are never the result.

The bounds span 137pp. A stop tuned and scored on the same 66 paths will look
extraordinary and mean nothing. **The in-sample-to-out-of-sample drop is reported
explicitly** — it is the fitting penalty on this dataset and it is reusable
evidence whatever the verdict.

## Fire counts

Every rule reports how many test paths it **fired** on, as distinct from falling
through to the mirror. `mirror OR TP +100%` came back byte-identical to the
mirror because the take-profit never fired on any of 66 paths. **A rule firing on
two paths is noise and the table says so at the point of reporting**, not in a
footnote.

## Predictions

**P5 — the best out-of-sample rule is a fixed stop at 10% or 25%, not a
trailing stop.** Trailing stops on memecoin paths exit on ordinary volatility;
the training drawdown p50 of −9.5% says half these positions dip 10% before the
mirror fires, so a 10% trailing stop exits nearly everything at the cost.

**P6 — the best rule lands between −5pp and +8pp out-of-sample at M=43,
c=1.11%.** Straddling the basis floor deliberately: I expect something that looks
like a pass at the narrow band and is inside the bias.

**P7 — nothing clears at M_eff = 516 out-of-sample by more than +5.19pp.**

**P8 — the in-sample-to-out-of-sample drop is 10–25pp of margin** on the best
in-sample rule.

## What a pass means, stated now

A stop clearing **out-of-sample**, at the **wide** band (M_eff = 516), with
**c = 1.11%**, and by **more than the +5.19pp basis floor**, is a **CANDIDATE on
one wallet at n=33 test paths and 36% coverage**. Before it is anything more it
needs cross-wallet replication (~62k calls each) and a measured `c`. This
paragraph is written now so it cannot be written more generously later.

## What a fail means

Take-profits and stops both tested and both short means **the loss side is not
reachable by a causal rule on this wallet**. At that point retiring
mirror-copying on this evidence is earned rather than over-reached, and the
offline phase closes.

## Standing

Nothing is sized. `src/core/sizing.ts` stays unwired and `tests/sizing.test.ts`
still asserts it. Estimators, entry (5.479 s), exit-delay treatment, costs and
band ends are unchanged from Part B.
