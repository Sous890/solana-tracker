# Handoff 17 — both wallets REJECTED

**Verdict: NO TAKE for both, at M=50 and TAU=0.005. Parts 2 and 3 were not
run, per the prompt's own gate.**

Suite: 836/837 passing. The single failure is the known crash-drill SIGKILL
flake (~25%, pre-existing since handoff 14, unrelated). Typecheck clean, no
stray processes.

Full output: `exports/part1-decision.2026-08-05T17-47-19.txt`.
Reproduce with `python3 analysis/part1_decide.py`.

---

## Part 1a — the bucket sample is NOT representative

| | n | win | g | l | payoff | median |
| --- | --- | --- | --- | --- | --- | --- |
| delay-0 bucket (pool replay) | 29 | 58.62% | +8.59% | −15.28% | **0.56** | +0.32% |
| decisions, SAME 29 mints | 48 | 35.42% | +21.31% | −20.73% | 1.03 | −4.00% |
| decisions, ALL mints | 1429 | 48.71% | +24.46% | −20.43% | 1.20 | −0.39% |

**Win-rate gap, bucket vs same-mint decisions: 23.20pp.** Far past the 5pp bar.
The dedupe reweighting accounts for another 13.29pp on its own (same-mint vs all
decisions).

So Part 1's *magnitudes* are unreliable and must not be read as this wallet's
properties. The *verdict* survives anyway, because it fails by 30-60pp rather
than by a margin the unreliability could close — see below.

---

## Part 1b/1c — `size_position` at measured delay

`Latency(delay_s=0)` passed deliberately: `surviving_alpha == 1`, because the
decay is already inside `p̃`, `g` and `l`, which come from the empirical delay
bucket. **This is not a zero-latency result.** Passing a real delay would apply
`2^(-dt/T)` on top and double-count it, and that form is misspecified for this
wallet anyway (CLAUDE.md gap 1).

### HSsJjkHr…

| delay | n | raw win | g | l | payoff | breakeven | p̃ @ M=50 | EV @ M=50 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1s | 29 | 37.93% | +7.08% | −11.77% | **0.60** | 78.00% | 19.35% | **−11.06%** |
| 2s | 29 | 31.03% | +8.05% | −11.53% | 0.70 | 73.91% | 13.32% | −11.86% |
| 5s | 29 | 31.03% | +10.26% | −9.94% | 1.03 | 63.75% | 13.32% | −10.19% |

Cost 2.94%, `net_gain` +4.15%, `net_loss` +14.71% at 1s. `kelly_full` is 0.0000
at every row — the EV gate closes before Kelly is ever consulted.

**It is NO TAKE even at M=1**, with selection deflation entirely disabled:
EV −7.56% / −8.40% / −6.61% at 1s / 2s / 5s. M=50 is not what rejects this
wallet; it only widens an already-decisive rejection.

### popo3Rj6… — NOT EVALUABLE

No delay buckets exist. The replay harness was only ever run against
`HSsJjkHr…`, and producing them is new RPC, which this prompt forbids outside
Part 3 — and Part 3 is gated on surviving Part 1. Its previous zero-latency
result (EV +0.09% at M=1, NO TAKE at M≥20) is an **upper bound** on a quantity
that cannot be spliced with a copier's win rate. Recorded as NO TAKE for want of
evidence, not as a measured rejection.

---

## Why it fails: the payoff ratio inverts under latency

The wallet's own decisions have payoff 1.20 (g +24.46%, l −20.43%) and clear a
45.51% breakeven by 3.19pp. A copier's do not.

**At delay 1s the payoff ratio is 0.60** — the average loss is nearly twice the
average win. `breakeven_win_rate = l/(g+l)` is then **78.00%**, against a raw win
rate of 37.93%. That is a 40pp shortfall before any selection deflation.

The mechanism is visible already at delay 0: the bucket's payoff is **0.56**
while its win rate is 58.62%. A copier buying at the pool's realised price does
not get the wallet's fill — the wallet's entry is the good print, and the
copier's is the one after it. The wins shrink, the losses do not.

Note this cuts against the earlier framing that a fat payoff ratio would carry a
sub-50% win rate. It does for the wallet. It does not for a copier.

---

## Two biases still point the same way

Both were measured earlier and neither is corrected in the numbers above:

- **Fill-rate survivorship.** 100% → 37.5% across the delay range (62.5pp drop,
  NO_DATA flat at 54.29%, so genuinely illiquidity). Long-delay buckets shed
  their worst trades, so the real curve is steeper than measured and these EVs
  are **optimistic**.
- **Bucket non-representativeness (Part 1a).** The 29-mint bucket is
  liquidity-selected — it is the subset whose pools we could reconstruct.

Correcting either makes the rejection deeper, not shallower.

---

## What was NOT done, and why

- **Part 2 (predation check on popo3Rj6)** — gated on popo3Rj6 surviving Part 1.
  It did not.
- **Part 3 (detection leg)** — gated on at least one wallet surviving. None did.
  So the detection latency remains unmeasured: we still have only the
  `getTransaction` round trip at **p50 201ms**, and the null-window floor is
  still unquantified. That gap now costs nothing, because the wallets are
  rejected at delays of 1-5s while the unmeasured leg is sub-second.

**TAU, kelly_fraction and M were not adjusted.** The rejection is the output.

---

## If you want to revisit

The honest next step is not to re-tune the gate. It is either:

1. **Different wallets.** Both of these were rejected on copier economics, not on
   a modelling artifact. `popo3Rj6`'s 2-second median hold and 55% landing
   failure were never plausible to mirror.
2. **Fix the bucket sample first.** Part 1a says the current one cannot support
   magnitudes. A run covering enough mints to close the 23pp gap would cost
   real RPC and would still have to clear a 78% breakeven.

Nothing in `src/core/` or `master_equation.py` was modified.
