# 27 — Sizing, step 0: the equation refuses every wallet

> **SUPERSEDED IN PART — read `27-loss-side.md` alongside this.**
>
> The breakeven column in §2 and the sweep in §3 pair a **measured** `g` against
> the **configured** 40% stop as `l`. That is the take-profit leak this document
> identifies, mirrored: `breakeven = l/(g+l)` with `l` pinned at 0.40 and `g` at
> a few percent is very nearly just `0.40/0.438`, so the constant is doing the
> work. Recomputed on matched estimators the range is **30.5% – 68.5%**, not the
> seventies-plus reported below.
>
> **The refusal survives** — eight of twelve wallets still fail on their own
> outcomes at zero cost — but the reason below is not the reason. The
> configured-stop table is kept as the worst case, which is what it always was.
>
> Also corrected there: §4's claim that the stop "rarely binds" is wrong. It
> binds for 25%+ of losers on six of twelve wallets.

Prompt 19 asks for the fixed `positionSizeSol` on the entry path to be replaced
by the gated fractional-Kelly size from `analysis/master_equation.py`, and puts a
measurement step ahead of any code. This is that step.

**Result: the required input does not exist, and on every input that does exist
the equation opens nothing.** `src/core/sizing.ts` is ported and tested; the buy
path is deliberately not wired, and `tests/sizing.test.ts` asserts that it is not.

Everything below is measured on the **corrected corpus** — the same 11 of 15
session files `scripts/score-wallets.ts` uses, with the four pre-routing-fix
sessions excluded because their per-wallet attribution is wrong rather than
noisy.

---

## 1. `edge.wins / edge.trades` cannot be produced

The prompt is specific and correct that this must be **our** latency-adjusted win
rate, not the tracked wallet's: we do not get their fills. The only machinery
that produces it is `scripts/calibrate-delays.ts` → `exports/{wallet}.delays.csv`,
via a pool-price replay at eight candidate delays.

| | |
| --- | --- |
| Wallets with a delays export | **1** of 12 (`HSsJjkHr…`) |
| Its usable rows | **15 FILLED of 120** at each delay — 87.5% `NO_FILL` |
| Its date | 2026-08-05 — **pre-routing-fix**, so it fails the prompt's own exclusion rule |
| Mints in the corrected corpus | 1,459 |
| Mints with cached pool history | **37** (2.5%) |
| Wallets with zero cached mints | 4 of 13 |

Producing it for the tracked set is a new RPC campaign over roughly 1,400 mints,
not an analysis pass. `calibrate-delays.ts`'s own header puts a single wallet at
"six figures of RPC calls and hours of wall time".

**`5479` ms is n=1.** `scratch/measure-holdtime.ts:11` says so in the source:
*"This process's measured chain-to-fill on the one completed trade."* It is
evaluated at 5.479 s and 15.0 s throughout, per the prompt.

## 2. What the corpus can measure

`scratch/measure-outcomes.ts` — the tracked wallets' **own** realised returns,
FIFO-paired **by token quantity** and rolled up to one row per entry decision.
n=4,501 decisions from 7,545 tranches.

Two departures from `scratch/measure-holdtime.ts`, both deliberate:

- It pairs by token quantity, not whole-swap to whole-swap. Pairing a single buy
  against only the first of three scale-out sells reports a 70% loss on a winning
  trade. `measure-holdtime.ts` does that; its `sol_in`/`sol_out` columns are
  unsafe for returns because of it. Hold time, which is all it claimed, is fine.
- It reports per **decision** as well as per tranche, because `EdgeParams.trades`
  means decisions. CLAUDE.md gap 3 measured a 6.3pp gap between the two on
  `HSsJjkHr`; across the full set it reaches **19.5pp** (`AgiGpUAF`, 55.1% per
  tranche against 35.6% per decision).

This is the tracked wallet's rate, which the prompt rightly forbids feeding to
`EdgeParams`. It is used here only as an explicit **upper bound**: we enter after
them and exit after them, so our rate cannot exceed theirs. A refusal at the
upper bound is a refusal.

| wallet | n | win | g mean | g trimmed | g median | breakeven @ 40% stop |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BCagckXe | 848 | 12.6% | 81.1% | 51.3% | 35.1% | 43.8% |
| CT9dekyf | 637 | 37.0% | 1289.4% | 26.6% | 24.6% | 60.1% |
| C86oRMyU | 558 | 61.5% | 12.3% | 3.8% | 3.2% | **91.4%** |
| popo3Rj6 | 465 | 58.1% | 4.5% | 3.5% | 3.0% | **91.9%** |
| 2JptG7VJ | 459 | 30.1% | 90.5% | 39.6% | 27.2% | 50.2% |
| AgiGpUAF | 407 | 35.6% | 21.4% | 14.1% | 8.5% | 73.9% |
| 2nHsHJpk | 309 | 48.2% | 50.2% | 13.5% | 10.4% | 74.7% |
| 6ww5Lc3u | 235 | 45.1% | 64.2% | 37.5% | 34.6% | 51.6% |
| yVrqX84d | 230 | 52.2% | 37.6% | 10.6% | 7.7% | 79.0% |
| CbpnbXAD | 173 | 44.5% | 21.4% | 17.8% | 14.8% | 69.2% |
| Dhaee3Pz | 97 | 30.9% | 69.4% | 57.9% | 38.7% | 40.8% |
| HSsJjkHr | 83 | 53.0% | 33.2% | 26.1% | 18.9% | 60.5% |

Pooled: **n=4,501, win 39.2%**, median return −4.0%.

**The mean payoff is one trade.** The single largest winner holds 98% of all
winner mass for `CT9dekyf`, 58% for `2nHsHJpk`, 83% pooled. The prompt's
instruction to size off a trimmed estimate is not a refinement; a two-outcome
Kelly with `g = g_mean` on these distributions is sizing off one observation.

## 3. The equation, run

`scratch/step0_equation.py`. 1,620 combinations: g ∈ {mean, trimmed, median} ×
delay ∈ {0, 5.479, 15} s × half-life ∈ {10, 30, 120} s × M ∈ {1, 13, 43, 200,
10000}, at λ=0.25, τ=0.005, κ=0.01, depth 41.67 SOL, equity 5 SOL, stop 40%.

**58 of 1,620 open. All 58 use `g_mean`.** On trimmed or median payoff, nothing
opens anywhere in the space. 45 of the 58 are `CT9dekyf`, whose `g_mean` is the
single winner above.

## 4. The pre-registration was inverted, and why

Prompt 19 pre-registered that the equation "will very likely OPEN", that
breakeven "sits near 20%", and that a cap rather than Kelly would bind. All three
came from sourcing `gross_win` as the **+150% take-profit target** — the sourcing
the same prompt forbids two paragraphs earlier, because the mirror exit fires
when the tracked wallet sells and that is usually long before the target.

Run with the target as `gross_win`, breakeven is **24.9%** and **10 of 12 wallets
open**. That single substitution is the whole of the apparent edge.

All three of the prompt's own alarm checks fire:

1. **"`Kelly` binding at a win rate under 50% means g is wrong."** It does —
   `6ww5Lc3u` (45.1%) and `2nHsHJpk` (48.2%) bind on Kelly. The diagnosis is
   right; the leak is in the pre-registration rather than the implementation.
2. **"A size above what the one fill executed at means the depth term is
   untested."** Sizes land at **0.4167 SOL** against the 0.05 SOL of the only
   real fill — 8×.
3. **"Report the win rate the model runs on next to the 47.6% it replaced."**
   Pooled it is **39.2%** (n=4,501); per wallet it spans 12.6% to 61.5%. The
   47.6%/50.3% pair from session 26 appears nowhere in the repo and could not be
   reproduced.

## 5. Two corrections to the prompt's framing

**The half-life band has no dependence on n.** The prompt gives the M range and
the half-life band the same caveat — that at large n they pass almost always and
so prove nothing. That is true of M, whose haircut is `selectionZ × standardError`
and shrinks as `1/√n` (at M=43, n=558 it is 4.2pp, confirmed). It is not true of
the half-life, which acts through `surviving_alpha = 2^(−dt/T)` — a quantity in
which `trades` does not appear. Sample size cannot swamp it. Pinned in
`tests/sizing.test.ts`.

**The gas reserve is gate 4, not gate 3, and the bug runs the other way.**
`spendLamports` already read `intent.amountLamports`; it took
`max(requested, positionSizeSol)`, which clamps **high only**. An oversized
intent was therefore always checked at its own amount, and variable sizing does
not create the failure the prompt describes. What the `max` did do is answer the
reserve question against a constant the intent does not spend whenever the intent
was **smaller** — refusing a 0.02 SOL buy for breaching a reserve only 0.05 SOL
would have breached. One-directional: it can only over-reject, never admit an
unaffordable buy. Fixed here, red first, at `tests/guards.test.ts` *"4. sizes the
check on the intent when it is BELOW positionSizeSol"*.

## 6. What landed

- `src/core/sizing.ts` — pure port of `size_position`, `breakeven_win_rate` and
  `portfolio_heat_cap`, plus `normalInvCdf` (Wichura AS241, transcribed from
  CPython) and `decide`, which refuses a non-converged fixed point. No imports,
  no clock, no I/O; a test greps the file to keep it that way.
- `analysis/conformance.py` + `tests/fixtures/sizing-conformance.json` — 17
  vectors reaching every binding constraint and both convergence outcomes, 16
  pinned `inv_cdf` points, 5 heat-cap vectors. Written **from** the reference;
  regenerating is a claim that the reference changed on purpose. Checked by both
  suites at 1e-9.
- The gate-4 fix above.

`decide` is the one deliberate divergence from the reference: the Python returns
whatever the damped iteration reached, and forcing `take` false would also force
`sizeSol` to zero, which would make the port incomparable field-for-field. So
`sizePosition` stays faithful and the refusal lives one layer up.

## 7. Not proved

- **That the port is right where the reference is wrong.** Conformance proves
  agreement, not correctness. The reference's own modelling gaps — CLAUDE.md gap
  7, pre-graduation bonding curves breaking `PoolState` — are inherited whole.
- **The conformance tolerance is absolute at 1e-9**, so it catches a
  transcription error from about the ninth significant digit onward (verified by
  flipping one AS241 exponent: `invCdf(0.9)` failed by 0.446) and not a slip in
  the last two digits.
- **Our win rate.** Everything above is the wallets' own, used as an upper bound.
  The real number is lower by an unknown amount, and nothing here bounds it from
  below.
- **`exit_depth_ratio = 0.7`** is inherited from `analysis/part1_decide.py` and
  has never been measured.
- **The cost term.** Prompt 20's 30 bps has still never been compared to a fill.
  With breakeven in the seventies this is no longer the marginal input it was.

## 8. Also found, not part of this work

- `config.json` tracks **12** wallets, not the thirteen named in
  `session-27-soak-prereg.md`. One of the 12, `H8sMJSCQ…`, has **no score** — 5
  mints, no paired round trips — so `0a078be` refuses it `WALLET_UNSCORED`.
  Eleven wallets are admissible, and prediction 1 of the prereg derives a fetch
  rate from that population.
- The suite emits one **unhandled rejection**: `this.driver.onPriceTick is not a
  function` at `src/services/tracker.ts:1424`, from `tests/tracker.test.ts` near
  *"leaves exits on a refused wallet completely alone"* — a stub driver missing
  the hook. Green, but it is in the fixture area prompt 19's HARNESS COST section
  wants consolidated.
- `main` is 21 commits ahead of `origin/main`.
