# 29 — Tasks 0 and 1: the documentation debt, and what the screen actually costs

Scored against `29-prereg.md`. **No RPC was made in either task.**

`c` has never met a fill. Nothing here is a margin, so nothing here inherits it —
but Task 2 will.

---

## Task 0 — the 47pp purge

**P0 CONFIRMED.** The figure appears **21 times across 6 distinct files**; the
band was 4–7 inclusive.

| file | occurrences | treatment |
| --- | ---: | --- |
| `27-candidates-prereg.md` | 5 | banner, left unedited |
| `27-candidates.md` | 4 | banner + corrected inline |
| `28-prereg.md` | 5 | banner, left unedited |
| `28-copy-gap.md` | 4 | none — this is the document that withdrew it |
| `28-context-handoff.md` | 2 | none — already labelled as withdrawn |
| `28-tasks-0-1.md` | 1 | corrected inline |

`29-prereg.md`'s own two occurrences are excluded; it names the figure in order
to purge it.

### The prereg was wrong about CLAUDE.md, and wrong in the more interesting direction

`CLAUDE.md` contains **no occurrence of 47pp** — the string `47` does not appear
in it at all. What it contained instead was the *pairing that generates it*, one
sentence in "Settled findings":

> `HSsJjkHr` at +19.5pp, and that is the exact margin it carried into a replay
> that returned −27.4pp.

Two populations (session corpus n=83; RPC export subset n=67) and two entry
conventions (5.479 s implied; 5.000 s actual), presented as a single wallet's
before-and-after. Any reader differencing them reconstructs 47pp exactly, and the
project's most-read file was the one place inviting it. Corrected in place, with
both populations named and an explicit instruction never to difference them.

### Two deviations from the instruction, both stated rather than taken quietly

1. **Pre-registrations are annotated, not rewritten.** The instruction says every
   occurrence is "replaced". A pre-registration whose numbers are corrected after
   the fact is no longer a pre-registration, and `27-candidates-prereg.md` and
   `28-prereg.md` are the two documents whose entire evidential value is that
   they were fixed before the result. Both now carry a correction banner at the
   top giving the matched-trip figure and naming the populations; the predictions
   below them are untouched. C3 was scored against a bar that does not exist as a
   scalar, and the banner says so — the *scoring* stands, the *interpretation* of
   the falsification does not.
2. **The two documents that record the withdrawal keep the figure verbatim.**
   Rewriting 47pp inside `28-copy-gap.md` — whose title is "the 47pp reference
   was an artefact" — would delete the correction rather than apply it.

### The copy gap had never reached CLAUDE.md at all

Session 28's central result — the gap is not constant, 13.1pp against 56.5pp, and
own-outcome screening is anti-correlated with copyability — was in the handoff and
in `28-copy-gap.md`, and **nowhere in the file every session is told to read**.
The handoff asserts CLAUDE.md's "Settled findings" is "where this phase's durable
results live"; for the phase's largest result that was not true. Now added, along
with the population-naming lint and the entry-delay reliability note.

This is documentation debt of the same class as the 47pp itself and it was found
only because the purge required reading CLAUDE.md for a string that was not there.

## Task 0.2 — the entry-delay flags

An **ENTRY-DELAY RELIABILITY FLAG** banner now sits at the top of every phase-27
document carrying a single-point entry-delay figure:

- `27-audits.md` — including **Audit 2's own −4.3pp**, as instructed
- `27-hssjjkhr-replay.md` — the delay 0 / 5 / 15 s table in §3
- `27-exit-rule-prereg.md` — the −31.9pp win-rate figure and its ~4.3pp correction
- `27-candidates-prereg.md` — the "entry 5 s" deflation table
- `27-loss-side.md` — the +19.5pp / −27.4pp pairing in its own banner

Each states what survives (directions; the delay-0 rung is unachievable because
it prices the wallet's own fill) and what does not (levels, and delay-to-delay
differences read to a decimal).

**Annotated, not deleted, and one document was deliberately left alone.**
`27-sizing-step0.md` sweeps `delay ∈ {0, 5.479, 15} s` as one of five dimensions
but reports no per-delay margin — its result is "58 of 1,620 combinations open,
all on `g_mean`". There is no single-point entry-delay comparison in it to flag.

## Task 0.3 — the lint

Recorded in CLAUDE.md next to the copy-gap finding: any margin quoted without a
named population is a defect. `gap-score.ts` enforces the matched-trip filter in
code; nothing enforces it in prose. **No seventh instance was introduced.**

---

## Task 1 — the campaign costs whatever the word "bracket" turns out to mean

`scratch/cost-displacement.ts`, offline, from the cached signature pages.

### What the narrowing does and does not save

`getPoolSwaps` has three cost stages and only one of them is helped:

| stage | cached? | helped by narrowing? |
| --- | --- | --- |
| 1. `getTransaction(entry_signature)` to resolve the pool, 1/trip | no | no |
| 2. `getSignaturesForAddress` paging, 1000/page | **yes**, per mint | **no** |
| 3. `getTransaction` per signature inside the intervals | no | **yes, entirely** |

Stage 2 is the one worth stating, because it is counter-intuitive and it was
about to be assumed away: **paging is not made cheaper by a narrower window.** The
walk backwards stops when a page's oldest `blockTime` precedes the earliest
interval, and the earliest interval is the entry either way — `signalTs − 30 s`
here against `signalTs − 24.5 s` for the full replay. The screen is cheaper than
the replay for exactly one reason: it does not fetch the hold window.

### Two readings of "a bracket of prints", and they straddle the abort rule

`gap-score.ts:95` uses precisely **two** entries of the priced path: the last
print strictly before `signalTs` and the first strictly after. Nothing between
them is ever read. So:

| | per trip | naive | **×3.5** | wall clock |
| --- | --- | ---: | ---: | ---: |
| **A** price the ±30 s interval, `getPoolSwaps` unchanged | 1 + pages + **81.8** | 45,180 | **158,130** | 254 min |
| **B** select the two prints from the pages, 3 candidates each side | 1 + pages + **6** | 4,874 | **17,059** | 27 min |

A costs 9× what B costs, and the entire difference is transactions fetched,
priced, and then not looked at. The mean is 81.8 signatures inside a 60-second
bracket because these are memecoin pools; the median is 47 and one cached mint
has 1,123.

**B is the reading taken**, on the prereg's own words — "a bracket of prints
around each entry, **not** a path to exit". A 60-second interval is still a path;
it is just a short one. B is also the only one of the two that is engineered
rather than inherited: it fetches what the statistic consumes.

### The estimate, and P1

**P1 CONFIRMED. 17,059 calls, inside the 8,000–20,000 band**, and the naive
figure it corrects is 4,874.

### On the ×3.5 multiplier, which the phase had retired

`27-candidates.md §1` retires it: 58,863 estimated against 60,473 actual, +2.7%.
Reinstating a retired correction is the kind of move that needs a reason, and
there is one — in the retirement itself:

> It was never a general correction — it came from estimating a *replay* fetch by
> counting cached signature pages, a different estimator against a different
> quantity.

**Counting cached signature pages is exactly the estimator used above.** The
+2.7% estimate was a probe of the live population against two measured constants;
this is not that. The multiplier is retired as a *general* correction and is
correctly applied to *this* one, and the prereg was right to insist. Both numbers
are reported regardless.

### The abort rule, and what it says

**Under 25,000 → proceed to Task 2 without asking.** 17,059 is under it.

**Under reading A it would have been 158,130 and Task 2 would not run in this
form** — the third branch, "the screen is not cheaper than the thing it was meant
to make cheap." Worth recording that the branch was decided by an implementation
choice rather than by a measurement, because the prereg's abort rule reads as
though a number decides it.

### The sensitivity that could still move it, stated before the run

The page estimate — **2.60 pages per uncached mint** — rests on 89 cached trips,
**70 of which are one wallet**, `BNnN2Mqf`. `DEFAULT_MAX_SIGNATURES` permits 20
pages. Scaling only that term:

| pages/mint | B naive | B ×3.5 | abort branch |
| ---: | ---: | ---: | --- |
| **2.60** (measured) | 4,874 | **17,059** | proceed |
| 5.00 | 5,939 | 20,787 | proceed (outside P1's band) |
| 10.00 | 8,154 | 28,539 | **stop and report** |
| 20.00 | 12,584 | 44,044 | **stop and report** |

So the run carries a **hard budget guard at 25,000 calls** that stops and reports
rather than spending into the band the prereg reserved. That is the abort rule
enforced in code instead of in a paragraph.

### Free finding: three of the eleven cannot clear the selection floor

The prereg excludes from selection any wallet with **fewer than 20 contributing
trips**. Trips available *before a single bracket is attempted* — one per mint,
earliest, `MIN_SOL_IN` 0.05, sampled to 70:

| wallet | trips | |
| --- | ---: | --- |
| BNnN2Mqf, 8deJ9xeU, 8yJFWmVT, 5dd3zjBQ, FsG3BaPm, J6TDXvar | 70 | capped by `sampleEvenly` |
| 87rRdssF | 38 | |
| CAPn1yH4 | 29 | |
| 4Be9Cvxq | **19** | **below the floor already** |
| E7gozEiA | **14** | **below the floor already** |
| G3gZWqrY | **12** | **below the floor already** |

Contributing trips can only fall from here — a bracket needs a priceable print on
each side of `signalTs`, and session 28 lost 5 of 66 on `HSsJjkHr` and 21 of 57 on
`BNnN2Mqf` to exactly that. **The screen selects from at most 8, not 11.**

These counts are lower than `27-candidates.md §2` (`4Be9Cvxq` 22, `87rRdssF` 86,
`G3gZWqrY` 48) because that table counts *decisions* and this one counts *mints* —
one trip per mint, earliest. Different populations, named.

**`M_eff = 43 × 11 = 473` is kept as pre-registered.** Selecting from 8 would put
it at 344; the prereg fixed 473 before the numbers existed, and revising a
deflation term downward after seeing that the population shrank is the move the
deflation exists to prevent. It is carried as the conservative end.

---

## Standing

Nothing sized. `src/core/sizing.ts` unwired. Task 2 proceeds under the abort rule
with a 25,000-call guard, and the basis gate runs first.
