# 27 — The loss side: breakeven recomputed on matched estimators

> **SIZE-FLOOR CORRECTION — see `28-tasks-0-1.md`.**
>
> Every figure below omits `MIN_SOL_IN = 0.05` (`positionSizeSol`,
> `analysis/part1_decide.py:29`). Applying it changes several wallets
> materially — `yVrqX84d` by **+16.3pp** — because sub-dust entries such as a
> 0.004 SOL trade returning +297,236% were being counted as winners.
>
> Floored counts: **6 clear at c=0** (not 4) and **4 at c=1.11%** (not 2). But
> only **one of twelve** is outside the +5.19pp basis floor, and it is
> `HSsJjkHr`, which carried that margin into the replay and came out at
> −27.4pp. The per-wallet ordering is broadly preserved; the levels are not.

Scored against `27-loss-side-prereg.md`, which was written and saved before the
extended `scratch/measure-outcomes.ts` was run.

**Verdict by the pre-registered rule: C. A=0, B=4, C=8.** The refusal stands, and
step 0's version of it was largely an artefact.

---

## 1. The correction was right

Step 0 paired a measured `g` against a configured `l`. Replacing the constant
with the realised loss distribution — same corpus, same token-quantity-matched
FIFO pairing, same estimators, truncated at the stop — moves breakeven a long way:

| wallet | be, configured l=40% | be, matched `l_trim` | move |
| --- | ---: | ---: | ---: |
| C86oRMyU | 91.4% | **68.5%** | −22.9 |
| popo3Rj6 | 91.9% | **38.8%** | −53.1 |
| yVrqX84d | 79.0% | **61.8%** | −17.2 |
| 2nHsHJpk | 74.7% | **49.6%** | −25.1 |
| AgiGpUAF | 73.9% | **43.0%** | −30.9 |
| CbpnbXAD | 69.2% | **57.9%** | −11.3 |
| HSsJjkHr | 60.5% | **30.5%** | −30.0 |
| CT9dekyf | 60.1% | **48.5%** | −11.6 |
| 6ww5Lc3u | 51.6% | **41.3%** | −10.3 |
| 2JptG7VJ | 50.2% | **39.9%** | −10.3 |
| BCagckXe | 43.8% | **41.7%** | −2.1 |
| Dhaee3Pz | 40.8% | **30.5%** | −10.3 |

Step 0's "breakeven in the seventies" was the stop, not the wallets. On matched
estimators the range is 30.5% – 68.5%.

**The refusal survives anyway**, for eight of twelve, and now for the reason a
refusal should have: the wallets' own win rates are below their own breakevens.

## 2. Scoring the predictions

### 1 — "Split, not uniform." Direction right, assignments wrong.

A=0, B=4, C=8, so not uniform. But I predicted `BCagckXe` (l_mean 45.4%) and
`6ww5Lc3u` (35.7%) would stay in class A on the strength of their losses alone.
They came back **C and B**. Their `g_trim` is 51.3% and 37.5% — the losses are
large *and so are the wins*, so the ratio lands in the low forties. Reasoning
from `l` in isolation was the error; breakeven is a ratio and I treated one side
of it as decisive after having just criticised step 0 for exactly that.

### 2 — Stop-binding. Both named predictions hit; the general reading did not.

| | predicted | actual |
| --- | --- | --- |
| `popo3Rj6` reaches −40% | under 5% | **0.0%** |
| `BCagckXe` reaches −40% | over 25% | **63.0%** |

The pre-registered fallback — *if it is near zero across the board the stop is
documentation, not protection* — **does not fire**. The stop binds for 25% or
more of losers on six of twelve wallets and absorbs up to **10.9pp** of mean
loss (`BCagckXe` 45.4% raw → 34.5% truncated). It is a real risk control on this
path, and the step-0 framing that it "almost never binds" was wrong.

### 3 — `C86oRMyU`. Wrong in the detail, right in the mechanism.

Predicted `l_trim` near 6%, a dead heat at c=0 (≈61% against a 61.5% win rate),
failing at ≈73% once c=1.11% applied.

Actual: `l_trim` **8.2%**, breakeven **68.5%** at c=0 — it does not reach a dead
heat, it **fails at zero cost** and clears nowhere. At c=1.11% it is 77.8%.

Nor is it closest to the line. That is **`2nHsHJpk`**: 49.6% breakeven against a
48.2% win rate, 1.4pp short.

The quantitative core of the prediction — *at `g` of a few percent, roughly one
point of cost buys ten points of breakeven* — **holds, and was understated**:

| wallet | g_trim | c=0 | c=1.11% | points per point of c |
| --- | ---: | ---: | ---: | ---: |
| popo3Rj6 | 3.5% | 38.8% | 58.2% | **17.5** |
| C86oRMyU | 3.8% | 68.5% | 77.8% | 8.4 |
| yVrqX84d | 10.6% | 61.8% | 65.8% | 3.6 |
| 6ww5Lc3u | 37.5% | 41.3% | 43.1% | 1.6 |

`popo3Rj6` clears at c=0 and c=0.5% and fails at c=1.11%. Its entire verdict is
the cost term, which is the pre-registered outcome-B trap in one wallet.

### 4 — "Nothing clears at c=1.11% on matched trimmed estimators." **Falsified.**

Two clear:

| wallet | breakeven @ c=1.11% | own win rate | margin |
| --- | ---: | ---: | ---: |
| `6ww5Lc3u` | 43.1% | 45.1% | +2.0pp |
| `HSsJjkHr` | 33.5% | 53.0% | **+19.5pp** |

`HSsJjkHr` clears at every swept cost including 2.94%.

The pre-registration named the check to run on any such wallet — *is its `g_trim`
still carrying a tail?* — and both **survive it**: `6ww5Lc3u` has `g_trim` 37.5%
against `g_med` 34.1%, `HSsJjkHr` 26.1% against 18.8%. Trimmed and median agree,
so this is not one blow-up. (`6ww5Lc3u`'s `g_mean` is 64.2%, which is tail-carried
— but the trimmed figure is not what the mean is doing.)

This is outcome **B for those two**, with everything B implies: their win rates
are the *wallets'* own, an upper bound on ours, and nothing here measures the gap.

### Falsification-of-framing check: fired, and the criterion was wrong

I pre-registered that `l_trim > l_mean` for several wallets would mean the trim
was cutting the wrong side and the estimator needed re-deriving. It happened for
**6 of 12**. The criterion was mis-specified, and the data says why:

| `l_trim > l_mean` | stop-binding fraction |
| --- | --- |
| YES (6 wallets) | 25.7% – 63.0% |
| no (6 wallets) | 0.0% – 23.6% |

Perfect separation at ~25%. Truncating at the stop puts a **point mass at exactly
0.40**; trimming 10% from each end removes some of that mass and a matching count
of small losses, so the mean rises. It is a mechanical consequence of the
truncation, not left-skew. **The estimator is not re-derived.** The right
criterion would have been `l_trim > l_mean` on the *untruncated* losses.

## 3. Where this leaves it

- Step 0's breakeven table is superseded. The refusal is not.
- Eight of twelve fail on their own outcomes at zero cost — a sturdier refusal
  than step 0's, which was mostly `0.40/(g+0.40)`.
- Four clear at c=0 on their own outcomes; two survive to c=1.11%; one to 2.94%.
  None of that is an edge. It is an upper bound clearing a threshold, with the
  gap between their fills and ours unmeasured and `c` never having met a fill.
- `c` is now the whole question for the B wallets, exactly as pre-registered.
  Swept values are confirmed by `scratch/check-cost.ts`: **1.111%** at the real
  0.05 SOL size, 1.711% with the 60 bps paper slippage round trip, 2.937% at the
  0.4167 SOL the equation wanted.

**One thing worth acting on.** `HSsJjkHr` is the only wallet with a delays export
— and it is the one clearing with a 19.5pp margin. It is also the most copyable
of the set (`uncopyableShare` 0.9%). Converting its upper bound into a real
latency-adjusted rate is a **one-wallet** replay campaign, not the 1,400-mint
campaign step 0 priced for the full set, and it would settle whether outcome B is
real for the one wallet where B has any margin at all.

## 4. Still not proved

- **Our win rate**, still. Everything here is the wallets' own.
- **`c` has never met a fill.** 1.111% is the model's own arithmetic over
  `minLiquidityUsd`, an unmeasured `exit_depth_ratio` of 0.7, and a 180 USD/SOL
  constant. The B verdicts rest entirely on it.
- **`exit_depth_ratio = 0.7`** — inherited from `analysis/part1_decide.py`, never
  measured, and it moves `c` directly.
- **Depth**, which is `minLiquidityUsd` restated rather than any pool's actual
  reserve.
- Nothing is sized on any of this. `src/core/sizing.ts` stays unwired and
  `tests/sizing.test.ts` still asserts it.
