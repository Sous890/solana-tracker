# Context handoff — end of the session-29 window

Head `eb90018`. **1044 tests, 24 files, all passing.** Typecheck clean
including `scripts/`. Working tree clean, 0 unpushed. Paper mode; no keys, no
live trading. Ledger unchanged: 0 pending intents, 2 open positions.

**`c` has never met a fill.** Every margin in this document is at an assumed
`c = 1.11%`. Sign-off on `db/ledger.ts` fill-time capture is outstanding for the
**sixth** session.

Read `claude-project/00-START-HERE.md` and `01-architecture-and-invariants.md` if
you have no context, then CLAUDE.md's **"Settled findings — do not re-derive"**.

---

## The one-paragraph version

Session 28 measured the copy gap and found it is not constant. Session 29 built
the screen that was supposed to exploit that — **displacement per SOL, across all
eleven eligible wallets** — and the screen works: displacement spans **17.9×**,
it is measurable at **6,181 RPC calls** against ~682,000 for eleven replays, and
it is nearly orthogonal to own-outcome margin (ρ = +0.264). **And it has nothing
to select.** Low displacement and a positive own margin never co-occur on a
wallet with enough trips to select, and an offline ceiling calculation shows no
amount of further spending changes that. **No third replay was run**, on the
argument that its result was arithmetically foreclosed before it started.

---

## What landed this session

| commit | what |
| --- | --- |
| `7121ad2` | pre-registration 29 — displacement as a screen, not an observation |
| `6f19851` | Task 0 — the 47pp purge and the entry-delay flags |
| `a552802` | Task 1 — the screen costs 17,059 calls |
| `f9d85e1` | Task 2 — the screen, and the pools it cannot see |
| *(this)* | the free bound, the handoff, CLAUDE.md |

### Every scored prediction

| | prediction | actual | |
| --- | --- | --- | --- |
| P0 | 47pp in 4–7 distinct files | **21 occurrences, 6 files** | CONFIRMED |
| P1 | estimate 8,000–20,000 calls | **17,059** (spent 6,181) | CONFIRMED |
| P2 | disp spans ≥1 order of magnitude | **17.9×**, 11.0× on the eligible six | CONFIRMED |
| P3 | \|ρ\| vs `sol_in` under 0.5 | **−0.518, p = 0.105** | **UNRESOLVABLE at n=11** |
| P4 | ≥1 wallet, disp <10% and own >+5pp | letter yes, **empty in fact** | see below |
| P5 | gap 13.1–56.5pp, ordered by disp | **self-contradicting** — not run | withdrawn |
| P6 | third replay negative at c=1.11% | **cannot fail** — not run | withdrawn |

**Shading: none, as session 28 required. Tally 6 optimistic : 5 pessimistic.**
The next pre-registration also shades not at all.

---

## The result, and it is a negative one

| wallet | n | **disp/SOL** | own margin (bracketed) | selectable? |
| --- | ---: | ---: | ---: | --- |
| FsG3BaPm | 45 | **4.33%** | −33.9pp | yes |
| 8deJ9xeU | 42 | 4.43% | −28.8pp | yes |
| 5dd3zjBQ | 45 | 6.47% | −31.2pp | yes |
| J6TDXvar | 40 | 9.04% | −29.1pp | yes |
| 8yJFWmVT | 50 | 9.54% | −7.1pp | yes |
| BNnN2Mqf | 42 | **47.84%** | **+8.6pp** | yes |
| 4Be9Cvxq | 4 | 9.63% | **+27.3pp** | **no — 19 trips exist** |
| G3gZWqrY / CAPn1yH4 / E7gozEiA / 87rRdssF | 5–13 | 2.67–9.70% | −12 to −70pp | no |

**The two properties never co-occur where they can be acted on.** The only
selectable wallet with a positive own margin has the highest displacement in the
set and is already replayed at −39.2pp. The one wallet carrying the wanted
configuration has nineteen trips in existence and can never clear the 20-trip
floor.

`BNnN2Mqf` reproduces session 28 to within its population difference: **47.84%
(bracketed, n=42)** against **51.20% (matched trips, n=36)**.

---

## Numbers to quote carefully

- **Every displacement figure here is biased upward.** `DEFAULT_MAX_SIGNATURES =
  20,000` drops trips whose pool traded more than that since the entry — **108 of
  532** — and the drop selects on pool throughput. Top-quartile-flow trips show
  **3.94%/SOL against 11.12%** for the rest, 2.82×. The measurable subset is the
  quiet pools.
- **`BNnN2Mqf`'s own margin is population-dependent**: +17.3pp (matched trips,
  n=57), +8.6pp (bracketed, n=42), +16.4pp (all sampled trips, n=70). Name it.
- **`HSsJjkHr`'s own outcomes do not come from `exports/HSsJjkHr….csv`**, which
  covers 33 of the 66 evaluable mints and reproduces neither the gap nor the
  displacement. They come from `scratch/replay-out/HSsJjkHr….csv`, which is
  **gitignored**. Session 28's headline 13.1pp reproduces only from that file.
- **P4 "CONFIRMED"** without "and empty in fact" is a misquote of this session.

---

## Do this next

The displacement screen is finished as a question. It answered, and the answer is
that the eleven do not contain a copyable wallet by this criterion.

1. **Decide whether the population is the problem.** Every result in this phase
   rests on eleven scorable wallets drawn from thirty, and five of the eleven
   cannot reach the 20-trip floor. `27-candidates.md §4` already noted the usable
   pool is a third of what the handoffs assumed. A larger scrape now has an
   argument it did not have in session 28: **the screen exists, it is cheap
   (~560 calls/wallet), and it is nearly orthogonal to own-outcome margin.** It
   would add to `M`, and `docs/screening-log.json` is the ledger for that.
2. **Or measure `c` against real fills.** It is the sixth request. Every margin in
   two phases is provisional on a cost term that has never met a fill, and no
   further screening changes that.
3. **Raise `DEFAULT_MAX_SIGNATURES` only with a cost estimate attached.**
   Recovering the 108 dropped trips is 20,000–50,000 calls and the free bound in
   `29-displacement-screen.md` shows it moves no verdict. It is worth doing only
   as part of a *new* measurement, not to revisit this one.

### Explicitly NOT next

- **No third replay of `FsG3BaPm`.** ~62k calls, and both scoring predictions are
  dead on arrival: P6 cannot fail at −33.9pp own margin, and P5's two clauses
  contradict each other on the wallet P5's own rule selects. Recorded before any
  number existed, which is the only time that record is worth anything.
- **No exit rules.** The ladder proof closed the family by construction.
- **Nothing sized.** `src/core/sizing.ts` stays unwired; `tests/sizing.test.ts`
  asserts it.
- **No re-run of the displacement screen to look for a better answer.** The
  ceiling under perfect recovery was computed and no wallet crosses.

---

## Things that will bite you

- **`scratch/`, `exports/`, `cache/` and `data/` are gitignored.** `cache/pools`
  is now **1.9 GB**, up from 905 MB — this session's paging roughly doubled it.
  This session's scripts —
  `cost-displacement.ts`, `displacement-screen.ts`, `cap-bound.ts`,
  `check-gap-population.ts` — and every priced path live only on this volume.
  `scratch/displacement-out/` holds the per-trip records behind the whole result.
- **`docs/screening-log.json` is committed and append-only.** M = 43. A wallet
  examined and rejected still counts.
- **Two entry conventions differ by 4.5pp**: the delays-grid integer buckets and
  the 5.479 s exact entry. Say which.
- **`src/adapters/rpcClient.ts` still does not retry JSON-RPC errors at HTTP
  200** — the live path, deliberate, two commit messages record why.
- **The socket work is untouched since phase 26.** No live confirmation.
  `not contradicted` ≠ `verified`.
- **`R = 29`** across the phase. This session evaluated no cells — one
  pre-registered statistic on eleven wallets is not a search. **A selection made
  from this screen carries R = 11 retroactively.** M_eff 473 is the independent
  end of the band and was fixed before the numbers existed; it was **not** revised
  down to 43 × 8 when the selectable population turned out to be eight.

---

## Standing conventions

Red before green. Every number carries `n` and its window. **Both margins in a
difference must come from the same trips.** A broken existing test is a finding.
Report what you could not prove, by name. `rm -rf` only under `scratch/`. Soaks
run under `caffeinate`.

**Pre-registrations state whether they are shaded.** Tally **6 optimistic : 5
pessimistic**; the next one shades not at all and says so.

**New this session: do not pre-register a correlation threshold without computing
the null band at the n you will have.** P3 fixed 0.5 and 0.7, arrived at −0.518
with p = 0.105 and a ±0.60 null band, and could not have been resolved by any
outcome. Pre-register a difference of medians, a larger n, or nothing.
