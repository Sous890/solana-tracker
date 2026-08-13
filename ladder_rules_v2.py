"""Scale-out ladders, stop-free, against the phase-27 conventions.

Offline. No RPC. Reads scratch/replay-out/paths.json.

    python3 ladder_rules_v2.py --paths scratch/replay-out/paths.json

WHAT CHANGED FROM v1, AND WHY
  v1 embedded a hard -40% stop in every ladder while the phase-27 mirror
  baseline has no early exit at all -- it truncates loss MAGNITUDE in the
  estimator only. That confound was worth ~24pp, larger than every other
  effect measured. Here no rule exits early. Truncation lives in one place
  (`truncate_loss`) and no rule may call anything else.

  Timestamps are taken from `entryTargetTs` / `mirrorTargetTs`, which the
  file already carries. Nothing is recomputed from signalTs, so the
  seconds-vs-millis hazard cannot recur.

R ACCOUNTING
  R was 17. The five ladders here are CORRECTED IMPLEMENTATIONS of the five
  already counted -- a bug fix is not a new search, so they add nothing. That
  holds only because v1's ladder numbers are DISCARDED rather than compared
  against; selecting the better of the two implementations would be a search
  over ten, not five.

  The full-exit probes are +20%, +40% and +75%. Part B ran +25/+50/+100, so
  the overlap is empty and all THREE are new -- the header previously said two
  and forgot +40%. R goes 17 -> 20. Band 43 .. 860.

  Corrected before the run, not after seeing a table.

CONVENTIONS, unchanged
  trim 10% each end; loss truncated at 0.40 in the estimator;
  breakeven (l + c) / (g + l); p~ = p - Phi^-1(1 - 1/(M+1)) * sqrt(p(1-p)/n);
  basis floor +5.19pp; split by entry ts, first half fits, second half scores.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from dataclasses import dataclass
from statistics import NormalDist

NORMAL = NormalDist()

STOP_TRUNCATION = 0.40      # estimator truncation ONLY. Never an exit.
TRIM_SHARE = 0.10
COSTS = (0.0, 0.0111)
BASIS_FLOOR_PP = 5.19
R_TOTAL = 20
M_BAND = (43, 43 * R_TOTAL)

# Committed out-of-sample reference, 27-stop-family.md. The gate.
EXPECTED_REF = {"n": 33, "win": 0.485, "g": 0.166, "l": 0.125, "margin_pp": -15.7}
GATE_TOL = {"win": 0.006, "g": 0.006, "l": 0.006, "margin_pp": 0.6}


# ---------------------------------------------------------------------------
# Rules. Enumerated before running. Nothing is added after a result.
# ---------------------------------------------------------------------------

LADDERS = (
    ("ladder A   5/10 @ 20/40",        ((0.20, 0.05), (0.40, 0.10))),
    ("ladder B   10/20/30 @ 20/40/75", ((0.20, 0.10), (0.40, 0.20), (0.75, 0.30))),
    ("ladder C   20/30/50 @ 20/40/75", ((0.20, 0.20), (0.40, 0.30), (0.75, 0.50))),
    ("flat       1/3 @ 20/40/75",      ((0.20, 1 / 3), (0.40, 1 / 3), (0.75, 1 / 3))),
    ("front      50/30/20 @ 20/40/75", ((0.20, 0.50), (0.40, 0.30), (0.75, 0.20))),
)

# Boundedness probe: full exit at one level, mirror otherwise. A ladder is a
# weighted blend of these plus the mirror, so if none beats the best of these,
# the family is bounded and closed.
FULL_EXITS = (0.20, 0.40, 0.75)


# ---------------------------------------------------------------------------
# Loading -- schema as confirmed in the 30-wallet report
# ---------------------------------------------------------------------------

@dataclass
class Path:
    mint: str
    entry_ts: float
    entry_price: float
    mirror_price: float
    prints: list[tuple[float, float]]   # (ts_ms, price), strictly after entry


def load_paths(blob: object) -> list[Path]:
    rows = blob["paths"] if isinstance(blob, dict) else blob
    out: list[Path] = []

    for row in rows:
        # path entries are [blockTime_ms, priceSol]; every ts here is millis
        series = sorted(((float(t), float(p)) for t, p in row["path"]),
                        key=lambda x: x[0])
        entry = first_at_or_after(series, float(row["entryTargetTs"]))
        mirror = first_at_or_after(series, float(row["mirrorTargetTs"]))
        if entry is None or mirror is None:
            continue

        entry_ts, entry_price = entry
        if entry_price <= 0:
            continue

        # STRICTLY later. A rule able to transact at the entry print cannot
        # lose -- the defect that produced a +73.8pp ceiling proving nothing.
        later = [(t, p) for t, p in series if t > entry_ts]
        if not later:
            continue

        out.append(Path(str(row.get("mint", "?")), entry_ts,
                        entry_price, mirror[1], later))

    return sorted(out, key=lambda p: p.entry_ts)


def first_at_or_after(series: list[tuple[float, float]], target_ms: float):
    for ts, price in series:
        if ts >= target_ms:
            return (ts, price)
    return None


# ---------------------------------------------------------------------------
# Rules. None of these exits early on a loss.
# ---------------------------------------------------------------------------

def mirror_return(path: Path) -> float:
    return path.mirror_price / path.entry_price - 1.0


def ladder_return(path: Path, rungs) -> float:
    remaining, proceeds = 1.0, 0.0
    unfired = list(rungs)

    for _, price in path.prints:
        ret = price / path.entry_price - 1.0
        still = []
        for level, frac in unfired:
            if ret >= level and remaining > 1e-12:
                take = min(frac, remaining)
                proceeds += take * ret
                remaining -= take
            else:
                still.append((level, frac))
        unfired = still
        if remaining <= 1e-12:
            return proceeds

    return proceeds + remaining * mirror_return(path)


def full_exit_return(path: Path, level: float) -> float:
    for _, price in path.prints:
        ret = price / path.entry_price - 1.0
        if ret >= level:
            return ret
    return mirror_return(path)


# ---------------------------------------------------------------------------
# Estimators
# ---------------------------------------------------------------------------

def truncate_loss(ret: float) -> float:
    """The ONLY place -0.40 appears. Magnitude cap, never an exit."""
    return min(abs(ret), STOP_TRUNCATION)


def trimmed_mean(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    k = int(len(ordered) * TRIM_SHARE)
    return statistics.fmean(ordered[k:len(ordered) - k] or ordered)


def selection_z(m: int) -> float:
    return NORMAL.inv_cdf(1.0 - 1.0 / (m + 1))


def top1_share(wins: list[float]) -> float:
    total = sum(wins)
    return max(wins) / total if wins and total > 0 else 0.0


def score(returns: list[float], m_eff: int, cost: float) -> dict:
    n = len(returns)
    if n == 0:
        return {"n": 0, "win": 0.0, "g": 0.0, "l": 0.0, "top1": 0.0, "margin_pp": 0.0}

    wins = [r for r in returns if r > 0]
    losses = [truncate_loss(r) for r in returns if r <= 0]

    p = len(wins) / n
    g, l = trimmed_mean(wins), trimmed_mean(losses)

    se = math.sqrt(max(p * (1.0 - p), 0.0) / n)
    p_defl = max(0.0, min(1.0, p - selection_z(m_eff) * se))
    breakeven = 1.0 if g + l <= 0 else (l + cost) / (g + l)

    return {"n": n, "win": p, "g": g, "l": l, "top1": top1_share(wins),
            "margin_pp": (p_defl - breakeven) * 100.0}


def verdict(worst_pp: float) -> str:
    if worst_pp <= 0:
        return "fails"
    if worst_pp <= BASIS_FLOOR_PP:
        return "INSIDE BASIS BIAS"
    return "clears"


# ---------------------------------------------------------------------------
# The gate
# ---------------------------------------------------------------------------

def gate(test: list[Path]) -> None:
    """Abort unless the mirror reference reproduces the committed handoff."""
    got = score([mirror_return(p) for p in test], M_BAND[0], 0.0111)
    problems = [
        f"{k}: expected {EXPECTED_REF[k]}, got {got[k]:.4f}"
        for k in ("win", "g", "l", "margin_pp")
        if abs(got[k] - EXPECTED_REF[k]) > GATE_TOL[k]
    ]
    if got["n"] != EXPECTED_REF["n"]:
        problems.append(f"n: expected {EXPECTED_REF['n']}, got {got['n']}")

    if problems:
        print("BASIS GATE FAILED -- no rule table printed.", file=sys.stderr)
        print("The mirror reference does not reproduce 27-stop-family.md, so "
              "nothing downstream is readable.", file=sys.stderr)
        for problem in problems:
            print("  " + problem, file=sys.stderr)
        sys.exit(1)

    print(f"basis gate PASSED -- mirror reference reproduces "
          f"{got['win']:.1%}/{got['g']:.1%}/{got['l']:.1%}, "
          f"{got['margin_pp']:+.1f}pp\n")


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def report(paths: list[Path]) -> None:
    half = len(paths) // 2
    train, test = paths[:half], paths[half:]

    gate(test)
    print(f"paths {len(paths)}  train {len(train)}  test {len(test)}")
    print(f"R = {R_TOTAL}, M_eff band {M_BAND[0]}..{M_BAND[1]}, "
          f"basis floor +{BASIS_FLOOR_PP}pp, no rule exits early\n")

    rules = [("mirror + 0.364s (ref)", mirror_return)]
    rules += [(f"full exit @ +{int(lv * 100)}%",
               (lambda p, L=lv: full_exit_return(p, L))) for lv in FULL_EXITS]
    rules += [(name, (lambda p, R=rungs: ladder_return(p, R)))
              for name, rungs in LADDERS]

    for split_name, split in (("IN-SAMPLE (record only)", train),
                              ("OUT-OF-SAMPLE", test)):
        print(f"== {split_name} ==")
        head = f"{'rule':<32}{'n':>4}{'win':>8}{'g_trim':>9}{'l_trim':>9}{'top1':>7}"
        for m in M_BAND:
            for c in COSTS:
                head += f"{'M' + str(m) + ' c=' + format(c * 100, '.2f'):>14}"
        print(head)

        best_ladder, best_full = None, None
        for name, fn in rules:
            rets = [fn(p) for p in split]
            base = score(rets, M_BAND[0], 0.0)
            line = (f"{name:<32}{base['n']:>4}{base['win']:>7.1%}"
                    f"{base['g']:>9.1%}{base['l']:>9.1%}{base['top1']:>7.0%}")
            worst = None
            for m in M_BAND:
                for c in COSTS:
                    pp = score(rets, m, c)["margin_pp"]
                    worst = pp if worst is None else min(worst, pp)
                    line += f"{pp:>+13.1f}pp"
            print(line + "   " + verdict(worst))

            headline = score(rets, M_BAND[0], 0.0111)["margin_pp"]
            if name.startswith(("ladder", "flat", "front")):
                best_ladder = headline if best_ladder is None else max(best_ladder, headline)
            elif name.startswith("full exit"):
                best_full = headline if best_full is None else max(best_full, headline)

        if split_name.startswith("OUT") and best_ladder is not None:
            print(f"\nboundedness, out-of-sample at M43 c=1.11%: "
                  f"best ladder {best_ladder:+.1f}pp vs best full exit "
                  f"{best_full:+.1f}pp -> "
                  f"{'BOUNDED (family closes)' if best_ladder <= best_full else 'NOT BOUNDED -- investigate'}")
        print()

    print("A verdict differing between band ends is REFUSED, not read.")
    print("A top1 share above ~50% means g_trim rests on one path.")
    print("Nothing here is sized. src/core/sizing.ts stays unwired.")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--paths", default="scratch/replay-out/paths.json")
    args = ap.parse_args()
    with open(args.paths) as fh:
        report(load_paths(json.load(fh)))


if __name__ == "__main__":
    main()
