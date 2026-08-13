# 29 — Pre-registration: displacement as a screen, not an observation

Written and saved **before any code is written and before any RPC call**. Scored
against this document and nothing else.

`c` has never met a fill. Every margin below is at an assumed `c`, swept 0 to
1.11%, and any conclusion whose sign changes inside that range is labelled where
it appears. **Sign-off on `db/ledger.ts` fill-time capture is requested for the
sixth time**; until it is given, no margin in this session converts to a
decision.

## Shading policy, stated first

Phase tally entering this session is **5 optimistic : 5 pessimistic**, from 5:1
before session 28. The ~40% shading applied since the loss-side prereg has
cancelled the original bias and overshot it. **This pre-registration shades not
at all.** Every number below is the honest central estimate. If that produces a
worse hit rate than shading did, that is the finding and it gets reported.

## Why the amended Task 2 selection is not being run

The swap-frequency proxy was adopted because pool depth was unmeasurable and
**P4 was the depth hypothesis**. P4 is retired. Running a ~3,238-call proxy to
select on an axis whose hypothesis no longer exists, while the variable that
actually emerged — **displacement/SOL** — sits at n=2, is spending on the dead
question. The proxy campaign is **withdrawn**, not deferred, and the reason is
recorded here so it cannot be reinstated after seeing a number.

---

## Task 0 — Documentation debt. Free, no RPC, run first.

1. **Purge the 47pp reference.** It pairs own-margin +19.5pp (session corpus,
   n=83) against replay −27.4pp (RPC export subset, n=67). Every occurrence in
   `CLAUDE.md`, phase-27 docs and handoffs is replaced by **13.1pp (matched
   trips, n=66)** with the population named inline. Report the occurrence count.
2. **Flag every phase-27 entry-delay figure.** A 479 ms shift moved margin 4.5pp
   in the *favourable* direction on the same 66 paths. Single-point entry-delay
   comparisons at this n are not reliable, and that applies backwards — including
   Audit 2's −4.3pp. Annotate, do not delete.
3. **Population naming is now a lint, not a habit.** `gap-score.ts` already
   enforces the matched-trip filter. Any margin quoted in a doc without a named
   population is a defect; this is the **seventh** instance of that error class
   if it recurs.

**P0 — the 47pp figure appears in 4 or more distinct files.** Falsified by 3 or
fewer, or by 8 or more.

---

## Task 1 — Cost the displacement-only campaign. Free, offline.

Displacement needs a bracket of prints around each entry, **not** a path to
exit. Cost it from the cached signature pages for the 11 eligible wallets, and
report calls and wall-clock separately from the full-replay figure.

**Costing correction that must be applied**: session 27 estimated 17,998 calls
and spent **62,217 — 3.5× over**, because the ±30 s window margin, per-mint pool
resolution and retries were all outside the estimate. **Multiply the naive
estimate by 3.5 and report both numbers.**

### Abort rule, fixed now

- Estimate (×3.5) **under 25,000 calls / ~45 min** → proceed to Task 2 without
  asking.
- Between 25,000 and 60,000 → **stop and report**; the spend is mine to
  authorise, not yours to assume.
- Over 60,000 → the screen is not cheaper than the thing it was meant to make
  cheap. Report that, and Task 2 does not run in this form.

**P1 — the ×3.5-corrected estimate lands between 8,000 and 20,000 calls.**
Falsified outside that band.

---

## Task 2 — Displacement screen across all 11 eligible wallets.

Same bracket definition as `28-copy-gap.md`. Per wallet emit: median
displacement/SOL, n trips contributing, median entry `sol_in`, and the achieved
calendar window.

### Fixed before the numbers exist

- **`MIN_SOL_IN = 0.05`.** Session 28 established the unfloored concentration
  figures were a dust artefact; nothing here runs unfloored.
- **A wallet with fewer than 20 contributing trips is excluded from selection
  and reported anyway**, with its n. Silent dropping is what produced the
  population errors this phase has now caught six times.
- **`blockTime` is second-resolution**, so same-second trades by the wallet
  contaminate the bracket. Unfixable. Carried, not corrected.

### The tautology check, pre-registered because it could kill the statistic

Displacement/SOL is size-normalised. If it nonetheless ranks the wallets in the
same order as their median entry `sol_in`, it is measuring position size and not
copyability, and it adds nothing over data already held. **Report Spearman ρ
between displacement/SOL and median `sol_in` across the 11.**

**P2 — displacement/SOL spans at least one order of magnitude across the 11.**
The two measured points are 5.77% and 51.20%, so the range is already 8.9× on
n=2; the honest central estimate is that 11 wallets widen it.

**P3 — |ρ| against median `sol_in` is under 0.5.** If it comes back above 0.7,
displacement is a size proxy and §4 of `28-copy-gap.md` is downgraded from
"first measurable mechanism candidate" to "restatement of trade size."

**P4 — at least one wallet has displacement under 10%/SOL *and* own margin above
+5pp on its matched population.** This is the configuration the 30-wallet screen
was structurally incapable of finding, and it is the only configuration in which
a positive replay margin is plausible. Falsified if zero wallets qualify.

---

## Task 3 — Third replay, selected on the screen. Only if P4's configuration exists.

Select the wallet with the **lowest displacement among those with positive own
margin**. If P4 came back empty, select the lowest-displacement wallet outright
and say plainly that the informative configuration was not available.

### Selection deflation — this is a search and it is scored as one

Picking 1 of 11 on a screen is the same order statistic the model already
deflates for wallet selection. Both ends reported for every result:

| assumption | M_eff |
| --- | ---: |
| wallets perfectly correlated — the screen adds nothing | 43 |
| independent — full penalty | 43 × 11 = **473** |

**A verdict that flips inside that band is refused.** And if this wallet fails
and a second is then drawn from the same screen, **R for the selection is 11,
not 2, retroactively** — staging does not launder it, exactly as A2 held in
phase 27.

Task-level `R` stands at **29** entering this session and rises only if
additional cells are evaluated. Report the value actually reached.

### Fixed conventions

Entry **+5.479 s** (not the 5.000 s delays-grid bucket), mirror +0.364 s,
`MIN_SOL_IN` 0.05, `c` swept 0 → 1.11%, M = 43 and M_eff = 473 both reported.
Basis gate runs **first** and against the 5.479 s convention. `n` matched to
~66–70 by `sampleEvenly` if the wallet's mint count exceeds it; the achieved
window is reported.

**P5 — the third wallet's gap lands between 13.1pp and 56.5pp**, and its
ordering against the other two matches its displacement ordering. Correct
ordering by chance is 1/6. This is a direction at n=3 and **cannot be reported
as a correlation** — P4 stays retired and nothing in this task resurrects it.

**P6 — the third wallet's replay margin is negative at c=1.11%, M=43.** No
hedging: I expect it to fail even in the favourable configuration.

---

## What a pass would mean, stated now

A positive replay margin at **M_eff = 473 and c = 1.11%** on n≈66 is a
**CANDIDATE, not a green light.** Before it becomes anything else it needs, all
three:

1. `c` measured against real fills — never once done;
2. the same selection rule pre-registered and run on wallets outside the eleven;
3. `own − gap` reported as the decision quantity, never `gap` alone. Low gap and
   low value are not the same property, and ranking on gap alone would have
   promoted the worse of the two wallets already measured.

This paragraph exists so it cannot be written more generously after a number
arrives.

## What would retire own-outcome screening entirely

If displacement spans an order of magnitude (P2), is not a size proxy (P3), and
still fails to produce any wallet with a positive replay margin, then the finding
is that **the screen is anti-correlated with what decides the outcome** — already
demonstrated on `BNnN2Mqf`, the best-looking of thirty and the least copyable
thing measured — and that no reordering of the existing thirty rescues it. That
is a phase result and should be reported as one, not as "three wallets failed."

## Standing

Nothing is sized. `src/core/sizing.ts` stays unwired. Every quantity in this
session is an estimate on a replay basis already known to be optimistic against
the wallets' own realised outcomes, at a cost term that has never met a fill.
