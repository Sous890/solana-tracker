# Pre-registration — the loss side of the breakeven table

Written **before** `scratch/measure-outcomes.ts` was extended and before the
recomputed table was produced. Head `4c473c1` plus the uncommitted step-0 work.

## The defect this corrects

`docs/handoffs/27-sizing-step0.md` paired a **realised** gross win against a
**configured** gross loss:

| | source | range |
| --- | --- | --- |
| `g_trim` | measured, realised, trimmed, per decision | 3.5% – 51.3% |
| `l` | `mirror.ts` `STOP_LOSS_PCT` | constant 0.40 |

`breakeven = l / (g + l)`. With `l` pinned at 0.40 and `g` at 0.038,
`C86oRMyU`'s 91.4% is very nearly just `0.40 / 0.438` — the stop is doing almost
all the work, and the stop is a constant in a file.

This is the take-profit leak mirrored. Step 0 caught the +150% target leaking
into `g` and did not notice the −40% stop sitting in `l`.

**Why the stop is the wrong `l` here.** The exit is a mirror exit: the position
closes when the tracked wallet sells, plus the session-26 latch, plus a −40% stop
that binds only when the wallet holds through a 40% drawdown. If `g_trim` is a
few percent, the wallet is not holding through 40% drawdowns often, so the stop
rarely binds and `l` should be the realised loss distribution truncated at the
stop — same corpus, same token-quantity-matched FIFO pairing, same estimators.

## What is already known, and why this is not blind

**`l_mean` per decision is already on screen** from the step-0 run. Stating
otherwise would be dressing this up, so it is written down here instead:

| wallet | l_mean | | wallet | l_mean |
| --- | ---: | --- | --- | ---: |
| BCagckXe | 45.4% | | 2nHsHJpk | 17.4% |
| CT9dekyf | 28.4% | | 6ww5Lc3u | 35.7% |
| C86oRMyU | 11.9% | | yVrqX84d | 24.5% |
| popo3Rj6 | 2.9% | | CbpnbXAD | 28.3% |
| 2JptG7VJ | 31.9% | | Dhaee3Pz | 26.9% |
| AgiGpUAF | 14.9% | | HSsJjkHr | 13.4% |

Not yet known, and what this run produces: `l_trim`, `l_median`, the
stop-binding fraction, and the recomputed table. Predictions below are
conditioned on the means above, which is weaker than a blind prediction and is
labelled as such.

## Method, fixed before the run

- Same corpus: 11 post-routing-fix session files, n=4,501 entry decisions.
- Same pairing: FIFO by token quantity, rolled up per entry decision.
- **`l` is truncated at the stop**: `l_i = min(|ret_i|, 0.40)` over `ret_i ≤ 0`.
  We would have stopped out; the wallet's deeper loss is not ours to record.
- **Matched estimators only.** `g_trim` against `l_trim`, `g_median` against
  `l_median`, `g_mean` against `l_mean`. Never a measured one against a
  configured one, in either direction.
- The configured-stop table is **kept alongside**, labelled worst-case `l`. It
  is the honest bound if the mirror exit fails to fire, and deleting it would
  trade one leak for another.
- Trim share stays 10%, as in step 0. Not tuned after seeing the answer.
- Cost enters as `breakeven = (l + c) / (g·α + l)`, which is what
  `master_equation` computes; `c` is swept, never assumed.

`c` is swept at 0, 0.5%, 1.11%, 1.71%, 2.94%. The 1.11% is the model's own
round-trip cost at the **actual** 0.05 SOL position size — `2 × dexFee` +
price impact against depth 41.67 with `exitDepthRatio` 0.7 + amortised priority
fee — not the 2.94% step 0 reported at the 0.4167 SOL cap. 1.71% adds the 60 bps
round trip implied by `paperLatencyPenaltyBps`. None of these has met a fill.

## Pre-registered outcomes

Three, and **the second is not a win**.

**A — losses are large, near the stop.** `l_trim` in the twenties or higher for
most wallets. Breakeven stays in the seventies-plus, the refusal stands, and the
strategy has no edge at this exit. Report and stop.

**B — losses are small and symmetric with wins.** Breakeven lands near 50%, and
`C86oRMyU` (61.5%), `popo3Rj6` (58.1%) and `HSsJjkHr` (53.0%) clear it **on the
wallets' own outcomes, which are an upper bound on ours**. The answer is
*undecidable until `c` is measured* — not *there is an edge*. Anyone reporting B
as a green light is reporting a cost term that has never met a fill.

**C — losses are small and wins are smaller.** Breakeven above 50% on a
table that looks symmetric. The refusal stands, for a sturdier reason than
before.

### Classification rule, fixed now

Per wallet, on matched trimmed estimators, at `c = 0`:

- **A** if gross breakeven ≥ 0.70
- **B** if gross breakeven < 0.60 **and** the wallet's own win rate exceeds it
- **C** otherwise

The set verdict is whichever class holds for the majority of the twelve, with
the per-wallet split reported in full either way.

### Specific predictions

1. **Split, not uniform.** Given the means above, `popo3Rj6` (2.9%) and
   `C86oRMyU` (11.9%) land in B or C and `BCagckXe` (45.4%) and `6ww5Lc3u`
   (35.7%) stay in A. A single verdict for all twelve would be the surprise.

2. **The stop-binding fraction is small for the low-`l` wallets and material for
   the high-`l` ones.** Concretely: under 5% of losers reach −40% for
   `popo3Rj6`, over 25% for `BCagckXe`. If it is near zero across the board, the
   stop is **not a risk control on this path** and the handoff must say so
   plainly — a stop that never binds is documentation, not protection.

3. **`C86oRMyU` lands closest to the line and still fails once `c` is applied.**
   At `g_trim` 3.8% and a plausible `l_trim` near 6%, gross breakeven is ≈61%
   against a 61.5% win rate — a dead heat. At `c` = 1.11% it moves to ≈73% and
   fails. **At `g` of a few percent, roughly one point of cost buys ten points of
   breakeven**, so B collapses onto `c` entirely. This is the prediction that
   matters and the one most likely to be wrong.

4. **Nothing clears at `c` = 1.11% on matched trimmed estimators.** If something
   does, it will be a wallet with a large `g_trim` and a small `l_trim`, and the
   first thing to check is whether its `g_trim` is still carrying a tail.

### What would falsify the framing rather than the numbers

If `l_trim` comes back **larger** than `l_mean` for several wallets, the loss
distribution is left-skewed against the truncation and the 10% trim is cutting
the wrong side; the estimator would need re-deriving before the table means
anything.

## Standing constraints

- **Nothing is sized on this result.** `src/core/sizing.ts` stays unwired and
  `tests/sizing.test.ts` keeps asserting that it is.
- The measured quantities remain the **wallets' own**, an upper bound on ours.
  No outcome here produces the latency-adjusted win rate that step 0 established
  does not exist.
- No parameter gets moved to reach a preferred class.
