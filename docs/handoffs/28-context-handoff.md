# Context handoff — end of the session-28 window

Head `f6357ab`. **1044 tests, 24 files, all passing.** Typecheck clean including
`scripts/`. Working tree clean, **0 unpushed**. Paper mode; no keys, no live
trading. Ledger: 0 pending intents, 2 open positions.

**`c` has never met a fill.** Every margin in this document is computed at an
assumed `c = 1.11%` and inherits that. This is now a standing constraint in
CLAUDE.md, not a request repeated per handoff.

Read `claude-project/00-START-HERE.md` and `01-architecture-and-invariants.md`
if you have no context. Then CLAUDE.md's **"Settled findings — do not
re-derive"** section, which is where this phase's durable results live.

---

## The one-paragraph version

Phase 27 retired mirror-copying as an exit architecture after twenty exit rules
failed across three families, with a **1.0pp fitting penalty** proving the
failure structural rather than small-sample. Session 28 stopped searching exits
and measured the thing that actually decides the outcome: the **copy gap**,
`own_outcome_margin − replay_margin`. It is **not constant** — 13.1pp on
`HSsJjkHr` against 56.5pp on `BNnN2Mqf` — and the best-looking candidate of
thirty turned out to be the least copyable thing measured. Own-outcome
screening, which is what every candidate has ever been ranked on, is
**anti-correlated** with copyability on the two wallets where both are known.

---

## What landed this session

| commit | what |
| --- | --- |
| `e551dc6` | pre-registration: measure copyability, not performance |
| `d6cc654` | Tasks 0 and 1 — the concentration was dust; confluence is short |
| `ebbe0a2` | amendment, written before any Task 2 RPC call |
| `f6357ab` | the copy gap, and the 47pp reference was an artefact |

### Task 0 — the concentration was a missing size floor

**P1 falsified: zero of twelve fire** on top-1 winner mass share. `CT9dekyf`'s
much-quoted 98% concentration was **two dust trades** — a 0.004 SOL entry
returning +297,236%. Applying `MIN_SOL_IN = 0.05` (`positionSizeSol`,
`analysis/part1_decide.py:29`) leaves a real 0.95 SOL trade at +145% holding
2.1%.

Consequences, now annotated into `27-loss-side.md` and CLAUDE.md: floored counts
are **6 clear at c=0 and 4 at c=1.11%** (not 4 and 2), `yVrqX84d` swings
**+16.3pp**, and **only one of twelve clears the +5.19pp basis floor** —
`HSsJjkHr`, whose margin then produced a negative replay.

### Task 1 — confluence is real and ~35pp short

Causal by construction: bucketed on other tracked wallets buying the same mint
*before* the entry. The symmetric variant was deliberately not computed —
lookahead, and nine more cells.

Best cell is 3+ within 130 s: win **53.1%** against solo's 40.3%, `l_trim`
**15.0%** against 21.8%. It improves both sides of the ratio. **Nothing clears**:
−12.5pp at M43, −19.9pp at the wide band. Measured on the wallets' own outcomes,
so against a copy gap of 13–56pp it is not tradeable at this magnitude.

**It is the first entry-side variable this project has found that moves
anything.**

### Task 2 — the copy gap, two wallets

| wallet | n | own | replay | **gap** | displacement/SOL |
| --- | ---: | ---: | ---: | ---: | ---: |
| HSsJjkHr | 66 | −9.7pp | −22.8pp | **13.1pp** | 5.77% |
| BNnN2Mqf | 57 | +17.3pp | −39.2pp | **56.5pp** | **51.20%** |

`BNnN2Mqf` was the 30-wallet screen's "only robust profile" and has the worst
copyability measured anywhere. A one-SOL entry moves its own entry price ~51%.

---

## Numbers withdrawn or corrected — do not re-quote the old ones

- **47.0pp copy gap.** Compared own-outcome margin from the *session corpus*
  (n=83) against replay margin from the *RPC export subset* (n=67). On matched
  trips it is **13.1pp**. Sixth instance of this error class in the phase.
- **−27.4pp is the entry +5.000 s bucket**, not the +5.479 s the session-28
  conventions specify. At 5.479 s it is **−22.8pp**. A 479 ms shift is worth
  4.5pp *in the favourable direction*, so the entry-instant curve is
  noise-dominated at n=66 — **every single-point entry-delay figure in phase 27
  is less reliable than it reads**, including Audit 2's −4.3pp.
- **"The wallet's payoff is 1.20 and a copier's is 0.60."** Actual: wallet 1.65,
  copier at entry 0 **1.21**, at 5.479 s 0.97. The 1.20 was the copier's own
  figure attributed to the wallet.
- **`HSsJjkHr`'s own-outcome margin is population-dependent**: +19.5pp on the
  session corpus, **−9.7pp** on the replayed subset. Neither is wrong. Any quote
  of either must name the population.
- **The 3.5× RPC estimate multiplier is retired.** The 30-wallet campaign was
  estimated at 58,863 calls and cost 60,473 — **+2.7%**.

---

## Do this next

1. **The swap-frequency proxy campaign.** ~3,238 calls, ~5 min: one pool resolve
   plus one signature page for each of the 1,619 uncached mints across the
   eligible eleven. Selects the three wallets for the rest of Task 2 by
   highest/median/lowest swap frequency at entry. This is the amended criterion —
   `28-prereg.md` amendment A1 — because **pool depth is measured nowhere** and
   `PoolState.depth_sol` is a config constant identical for every mint.
2. **Run the three replays** (~62k calls each). Emit measured displacement per
   SOL per trip and **report the proxy-vs-displacement correlation as a validity
   check on the proxy**, not as a result about wallets.
3. **The basis gate is mandatory** and is already implemented in
   `scratch/gap-score.ts`: it aborts unless `HSsJjkHr` reproduces **−22.8pp**.
   Do not change that constant to make a run pass.
4. Then decide whether displacement is a screen. **n=3 cannot answer it** — the
   prereg says so and P4 is retired as untestable.

### Explicitly NOT next

- **No exit rules.** The ladder proof closed the family by construction: a ladder
  is a convex combination of full exits, so `max(ladders) ≤ max(full exits,
  mirror)`, and the best full exit is refused for flipping inside the band. Rule
  21 would be bounded above by a rule already refused.
- **No new candidates scraped.** With the gap unmeasured across the population, a
  larger pool adds M to a screen that is measuring the wrong quantity.
- **Nothing sized.** `src/core/sizing.ts` stays unwired and
  `tests/sizing.test.ts` asserts it.

---

## Things that will bite you

- **`scratch/`, `exports/`, `cache/` and `data/` are gitignored.** Every
  measurement script and every priced path lives only on this volume. `cache/`
  is **905 MB**; `scratch/replay-out/` holds `paths.json` (HSsJjkHr, 66) and
  `paths-BNnN2Mqf.json` (57). Losing them costs ~106k RPC calls to rebuild.
- **`docs/screening-log.json` is committed and append-only.** M = 43 (12 tracked,
  1 refused, 30 candidates). A wallet examined and rejected still counts toward
  M — deleting rejections is how M silently shrinks and every deflated win rate
  silently rises.
- **Two entry conventions exist** and differ by 4.5pp: the delays-grid `delay_s`
  buckets (integers) and the 5.479 s exact entry. Say which you mean.
- **The 5.479 s chain-to-fill is n=1**, documented at
  `scratch/measure-holdtime.ts:11`.
- **`src/adapters/rpcClient.ts` still does not retry JSON-RPC errors at HTTP
  200** — the live path, and the only one of three that lacks it. Deliberate:
  its retry budget and `RpcError` contract are load-bearing for the guard and
  quote paths. Two commit messages record it.
- **The socket work is untouched since phase 26.** The lost-wakeup fix and the
  silence detector still have **no live confirmation** — 0 socket deaths across
  both soaks. `not contradicted` ≠ `verified`.
- **`R = 29`** across the phase (20 exit rules + 9 confluence cells), band
  43..1247. Any new search adds to it and re-scores everything.

---

## Standing conventions

Red before green. Every number carries `n` and its window. **Both margins in a
difference must come from the same trips** — this phase got that wrong six
times. A broken existing test is a finding; say what it asserted and why it is
stale. Report what you could not prove, by name. `rm -rf` only under `scratch/`.
Soaks run under `caffeinate` or their numbers are void.

**Pre-registrations record a direction of prior miss and state whether they are
shaded.** The tally is now **5 optimistic : 5 pessimistic**, from 5:1 before this
session — the ~40% shading applied since the loss-side prereg has cancelled the
original bias and started overshooting it. **The next pre-registration shades not
at all, and says so.**
