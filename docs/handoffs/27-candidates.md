# 27 — The thirty candidates screened, and the dust floor that decides them

Scored against `27-candidates-prereg.md`. Realised outcomes only, no replay.

> **Corrected 2026-08-13, session 29 Task 0. The `~47pp` copy-tax bar used
> throughout this document is withdrawn.** It paired `HSsJjkHr`'s own-outcome
> margin from the *session corpus* (+19.5pp, n=83) against its replay margin from
> the *RPC export subset* (−27.4pp, n=67) — two different populations, and the
> replay figure was additionally the 5.000 s delays-grid bucket rather than the
> 5.479 s entry convention. **On matched trips the copy gap is 13.1pp (matched
> trips, n=66)**; see `28-copy-gap.md`. Occurrences are annotated inline below,
> not deleted — the withdrawn bar is what this screen was actually run against,
> and the scoring in §3 only means anything against the bar as stated at the
> time.

**Result: the population is thin but not empty.** One candidate clears the ~47pp
copy-tax bar — **withdrawn; the matched-trip gap is 13.1pp (matched trips,
n=66)**, against which the population is not thin at all — and it rests on 22
decisions with a single trade carrying half its winner mass. C3 is falsified — **the first prediction in this phase to miss in
the pessimistic direction**, after four consecutive optimistic ones.

---

## 1. The estimate, scored

| | |
| --- | --- |
| estimate | **58,863 calls** |
| actual | **60,473 calls** (4,343 + 56,130) |
| **error** | **+2.7%** |
| wall clock | 1.62 h against 1.7 h estimated |

**The estimate lands inside 20%, so the 3.5× multiplier is retired.** It was
never a general correction — it came from estimating a *replay* fetch by counting
cached signature pages, a different estimator against a different quantity. A
probe of the actual population against two measured constants was accurate to
under 3% on both calls and time.

## 2. The dust floor is what decides this screen

Scored naively, two candidates cleared +47pp (withdrawn bar — see the banner;
against 13.1pp on matched trips, n=66, the count is higher and the dust point
below is what still decides the screen). Their `g_trim` was **679%** and
**30,492%**. The recurring tell was the entry size:

```
Be24Gbf5  top winner: sol_in 0.002039 -> sol_out 52.6127   = +2,579,867%
          that one trade is 91% of all winner mass
4Be9Cvxq  3 of its 4 largest winners are 0.002039 SOL entries
```

A 0.002 SOL entry returning 52 SOL is not a copyable trade. It is an airdrop, a
claim, or a FIFO tranche paired against tokens that arrived some other way.

**The project already had the right floor and this screen failed to apply it**:
`analysis/part1_decide.py:29` sets `MIN_SOL_IN = 0.05` — `positionSizeSol`.
CLAUDE.md gap 3 states the reasoning: a sub-dust entry is a return no copier
could have taken at its own size. Re-scored at that floor:

| wallet | n | dropped | win | g_trim | l_trim | margin c=1.11% | g/g_med | top1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **4Be9Cvxq** | 22 | 14 | 72.7% | 175.5% | 35.4% | **+55.4pp** | 1.3× | **50%** |
| E7gozEiA | 20 | 0 | 50.0% | 105.9% | 23.3% | +31.1pp | 4.9× | **78%** |
| **BNnN2Mqf** | 176 | 5 | 47.7% | 42.6% | 15.2% | **+19.5pp** | 2.2× | 24% |
| 8deJ9xeU | 494 | 3 | 46.4% | 23.7% | 24.4% | −6.7pp | 1.3× | 5% |
| G3gZWqrY | 48 | 30 | 25.0% | 76.5% | 39.4% | −10.0pp | 2.7× | 46% |
| 8yJFWmVT | 184 | 43 | 25.5% | 28.7% | 15.9% | −12.5pp | 1.9× | 16% |
| 5dd3zjBQ | 392 | 66 | 32.4% | 27.3% | 29.9% | −21.8pp | 1.5× | 14% |
| CAPn1yH4 | 152 | 0 | 11.8% | 71.6% | 35.9% | −22.6pp | 1.9× | 31% |
| FsG3BaPm | 257 | 2 | 19.5% | 42.9% | 32.4% | −25.0pp | 1.2× | 8% |
| J6TDXvar | 232 | 2 | 22.0% | 42.9% | 37.1% | −25.8pp | 1.1× | 18% |
| 87rRdssF | 86 | 182 | 17.4% | 34.0% | 29.8% | −31.0pp | 1.5× | 21% |

`Be24Gbf5` falls out entirely — below the 20-decision floor once its dust is
removed. `87rRdssF` loses **182 of 268** decisions to the floor.

### The pre-registered tail check was insufficient

`g_trim / g_med` was the check the prereg named. It **passes `4Be9Cvxq` at
1.3×** while one trade carries 50% of its winner mass, and it passes several
others whose concentration is high. The ratio detects a *shifted* distribution,
not a *concentrated* one.

**Top-1 winner mass share is the check that works here** and it should be
carried into the template alongside the ratio, not instead of it.

## 3. Scoring the predictions

| | prediction | actual | |
| --- | --- | --- | --- |
| C1 | 4–8 clear at c=0 (unshaded 10) | 3–4 | at/below the shaded floor |
| C2 | 1–3 clear at c=1.11% (unshaded 5) | **3** | CONFIRMED, top of range |
| C3 | none above 47pp (bar since withdrawn) | **1** | **FALSIFIED** |
| C4 | median −5 to −25pp | **−12.5pp** | CONFIRMED |
| C5 | at least 3 unscorable | **19 of 30** | CONFIRMED, by 6× |

### The optimism instrumentation earned its place immediately

**C3 is the first pessimistic miss of the phase**, after P2, P5, P6 and P8 all
missed optimistically. The prereg shaded C1 and C2 down ~40% and stated so; C1
came in at or below the shaded floor and C2 at the top of the shaded range,
which suggests the shading was roughly right for those two — while C3, which was
*not* shaded because it was stated as an absolute, is the one that broke.

Running tally now: **4 optimistic, 1 pessimistic.** The next prereg states
whether it shades, and shades absolutes as well as ranges.

## 4. Nineteen of thirty cannot be scored at all

Sixteen produce **zero** closed round trips over ten days, including all three
ultra-dense wallets the probe flagged — `VJSDW6S7`, `Hw5UKBU5`, `8MaVa9kd`, each
of which does ~1,000 transactions per quarter-hour and none of which produces a
single paired swap round trip. They are not discretionary traders. C5 predicted
this for at least three; it is true of sixteen.

**So the screened population is not 30. It is 11.** M as a deflation parameter
is still 43 — every wallet examined counts, which is the whole point of a
selection correction — but the *usable* candidate pool is a third of what the
handoffs assumed.

## 5. What this does and does not say

**Does not retire copy-trading as a genus.** The prereg's exhaustion criterion
was "no candidate above ~47pp" — a bar now withdrawn, the matched-trip gap being
**13.1pp (matched trips, n=66)** — and one is above it either way. The retirement stated in
`27-stop-family.md` stays scoped to `HSsJjkHr` and to mirror-copying as an exit
architecture.

**Does not make `4Be9Cvxq` a candidate worth 62k calls yet.** n=22, one trade is
50% of winner mass, 67% of its losers reached the −40% stop, and its 14 dropped
dust trades say its size profile is not ours. The prereg's pick discipline
applies: any pick is made at **M = 43 × 30 = 1,290**, and at that deflation on
n=22 the margin loses roughly 20pp before anything else is considered.

**The most informative row is `BNnN2Mqf`**: n=176, ratio 2.2×, top1 24%, the
only robust profile in the set — and its margin is **+19.5pp (session corpus,
n=176), which is `HSsJjkHr`'s own-outcome margin on the session corpus (n=83) to
the decimal.** `HSsJjkHr` carried that +19.5pp into the replay and came out at
−27.4pp — **two populations, and the replay figure is the 5.000 s bucket; at the
5.479 s convention on matched trips it is −22.8pp against an own margin of
−9.7pp, a gap of 13.1pp (matched trips, n=66)**. The prediction that follows is
therefore a ~13pp one, not a ~27pp one.

**Session 28 measured `BNnN2Mqf` directly and it failed far worse than either
figure predicted**: own +17.3pp, replay −39.2pp, gap **56.5pp (matched trips,
n=57)**. The "only robust profile in the set" is the least copyable thing
measured anywhere. See `28-copy-gap.md`.

## 6. Not proved

- Ten-day window, one draw. `CAPn1yH4`'s window is **0.5 days**; `E7gozEiA`'s is
  2.8. Windows are reported per wallet because they are not comparable.
- The 3,000-signature cap truncates the busiest wallets to their most recent
  transactions, so their window is "the last 3,000 events", not ten days.
- `uncopyableShare` is computed from `blockTime` deltas at second resolution, as
  `scripts/score-wallets.ts` does; hold-time-in-slots is **derived** at 400 ms
  and is not measured, because the history export carries no slot numbers.
- Every margin here is a **zero-latency upper bound**, the same one `HSsJjkHr`
  cleared by +19.5pp (session corpus, n=83) before failing by −27.4pp (RPC export
  subset, n=67, 5.000 s bucket). Matched-trip figures: −9.7pp own, −22.8pp
  replay, n=66.
- **Every single-point entry-delay figure in this document is less reliable than
  it reads.** A 479 ms shift of the entry instant moved the replay margin 4.5pp
  on the same 66 paths, and in the *favourable* direction, so the entry-instant
  curve is noise-dominated at this n (session 29 Task 0.2).
