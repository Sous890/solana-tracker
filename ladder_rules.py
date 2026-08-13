"""Scale-out ladder exit rules, scored against the phase-27 conventions.

Offline. No RPC. Reads scratch/replay-out/paths.json.

    python3 ladder_rules.py --inspect            # print the JSON shape first
    python3 ladder_rules.py --paths PATH_TO_JSON

CONVENTIONS, carried unchanged from 27-exit-rules.md / 27-stop-family.md:
  entry        5.479 s after signalTs, firstAtOrAfter
  trim         10% from each end
  loss         truncated at the -40% mirror.ts stop
  breakeven    (l + c) / (g + l)      -- equals master_equation's form
  deflation    p~ = p - selectionZ(M_eff) * sqrt(p(1-p)/n)
  band         M_eff 43 (rules correlated) .. 43*R (independent)
  basis floor  +5.19pp; any margin in (0, +5.19] is INSIDE BASIS BIAS
  split        paths ordered by entry ts, first half fits, second half scores

R = 17 here: 12 already evaluated in this phase, plus the 5 ladders below.
A2 triggers, so the Part B and stop-family rules are re-scored at the wider
band alongside. No rule is added after seeing a result.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
from dataclasses import dataclass
from statistics import NormalDist

NORMAL = NormalDist()

ENTRY_DELAY_S = 5.479
EXIT_DELAY_S = 0.364
STOP = 0.40
TRIM_SHARE = 0.10
COSTS = (0.0, 0.0111)
BASIS_FLOOR_PP = 5.19
R_TOTAL = 17
M_BAND = (43, 43 * R_TOTAL)


# ---------------------------------------------------------------------------
# Rule definitions -- ENUMERATED BEFORE RUNNING. Do not extend after a result.
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Ladder:
    """Rungs are (gain_level, fraction_of_original_position_sold)."""
    name: str
    rungs: tuple[tuple[float, float], ...]

    def __post_init__(self) -> None:
        total = sum(f for _, f in self.rungs)
        if total > 1.0 + 1e-9:
            raise ValueError(f"{self.name}: rungs sell {total:.3f} of the position")


LADDERS = (
    # As specified: sells 15%, leaves 85% riding to the mirror.
    Ladder("ladder A  5/10 @ 20/40", ((0.20, 0.05), (0.40, 0.10))),
    # Same ascending shape, materially deeper.
    Ladder("ladder B  10/20/30 @ 20/40/75", ((0.20, 0.10), (0.40, 0.20), (0.75, 0.30))),
    # Ascending, fully out by +75%.
    Ladder("ladder C  20/30/50 @ 20/40/75", ((0.20, 0.20), (0.40, 0.30), (0.75, 0.50))),
    # CONTROL: same levels, flat weights. Isolates whether the shape matters.
    Ladder("control flat 1/3 @ 20/40/75", ((0.20, 1 / 3), (0.40, 1 / 3), (0.75, 1 / 3))),
    # CONTROL: front-loaded, the opposite of "less at the start".
    Ladder("control front 50/30/20 @ 20/40/75", ((0.20, 0.50), (0.40, 0.30), (0.75, 0.20))),
)


# ---------------------------------------------------------------------------
# Path loading
# ---------------------------------------------------------------------------

@dataclass
class Path:
    mint: str
    entry_price: float
    entry_ts: float
    prints: list[tuple[float, float]]   # (ts, price), strictly after entry
    mirror_price: float                 # wallet exit + EXIT_DELAY_S


def load_paths(blob: object) -> list[Path]:
    """Adapt scratch/replay-out/paths.json into Path records.

    SCHEMA, verified against the emitter (scratch/price-paths.ts) rather than
    guessed. The original guesses were wrong in three ways and only two of them
    were loud:

      row["swaps"]                 -> row["path"]            KeyError, loud
      s["blockTime"], s["priceSol"] -> s[0], s[1] (a 2-list)  TypeError, loud
      blockTime in SECONDS          -> MILLISECONDS           SILENT

    The third is the dangerous one. signalTs is 1786477337000 and path[0][0] is
    1786477313000 -- both millis. Dividing signalTs by 1000 and leaving
    blockTime alone compares millis against seconds, so EVERY print satisfies
    `ts >= target`, entry and mirror both resolve to the first print in the
    window, mirror_price == entry_price, and the mirror return is identically
    zero. Nothing is skipped and nothing crashes; all 66 paths are priced from
    an instant 29.5s before the true entry, because paths.json carries a +/-30s
    margin around the window it fetched.

    So the timestamps are not recomputed here at all. `entryTargetTs` and
    `mirrorTargetTs` are already in the file, written by the emitter at
    signalTs + 5479ms and exitTs + 364ms. Using them removes the unit hazard
    instead of patching it, and guarantees this agrees with the TypeScript
    evaluators by construction rather than by two constants staying in step.
    """
    rows = blob["paths"] if isinstance(blob, dict) else blob
    out: list[Path] = []

    for row in rows:
        prints = sorted(
            ((float(t), float(price)) for t, price in row["path"]),
            key=lambda p: p[0],
        )

        entry = first_at_or_after(prints, float(row["entryTargetTs"]))
        mirror = first_at_or_after(prints, float(row["mirrorTargetTs"]))
        if entry is None or mirror is None:
            continue

        entry_ts, entry_price = entry
        if not entry_price > 0:
            continue
        # Strictly later than the entry print. A ladder that can sell at the
        # entry print cannot lose, which is the defect 27-exit-rules.md found
        # in the first perfect-foresight ceiling.
        later = [(t, p) for t, p in prints if t > entry_ts]
        if not later:
            continue

        out.append(
            Path(
                mint=str(row.get("mint", "?")),
                entry_price=entry_price,
                entry_ts=entry_ts,
                prints=later,
                mirror_price=mirror[1],
            )
        )

    return sorted(out, key=lambda p: p.entry_ts)


def first_at_or_after(swaps: list[tuple[float, float]], target: float):
    for ts, price in swaps:
        if ts >= target:
            return (ts, price)
    return None


# ---------------------------------------------------------------------------
# Rule evaluation
# ---------------------------------------------------------------------------

def ladder_return(path: Path, ladder: Ladder) -> float:
    """Gross return for one path. Cost is applied later, in breakeven."""
    remaining = 1.0
    proceeds = 0.0
    unfired = list(ladder.rungs)

    for _, price in path.prints:
        ret = price / path.entry_price - 1.0

        # Stop first: it governs the whole remainder, matching mirror.ts.
        if ret <= -STOP:
            return proceeds + remaining * (-STOP)

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

    return proceeds + remaining * (path.mirror_price / path.entry_price - 1.0)


def mirror_return_stopped(path: Path) -> float:
    """Mirror, but exiting at the -40% stop if the path reaches it first.

    NOT the phase-27 baseline. The handoffs truncate the loss MAGNITUDE in the
    estimator (min(|r|, 0.40)) and never exit early, so a position that dipped
    past -40% and recovered still books the recovery. This one sells there and
    forgoes it. Both are defensible; they are different rules and only the
    other one reconciles with the -22.8pp / -23.4pp already published.
    """
    for _, price in path.prints:
        if price / path.entry_price - 1.0 <= -STOP:
            return -STOP
    return path.mirror_price / path.entry_price - 1.0


def mirror_return(path: Path) -> float:
    """The phase-27 baseline exactly: hold to the mirror, no early stop.

    Loss truncation happens in `score`, not here. This row is what reconciles
    against 27-exit-rules.md and 27-stop-family.md; if it does not reproduce
    them the loader is wrong and nothing below is worth reading.
    """
    return path.mirror_price / path.entry_price - 1.0


def trimmed_mean(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    k = int(len(ordered) * TRIM_SHARE)
    kept = ordered[k:len(ordered) - k] or ordered
    return statistics.fmean(kept)


def selection_z(m: int) -> float:
    return NORMAL.inv_cdf(1.0 - 1.0 / (m + 1))


def score(returns: list[float], m_eff: int, cost: float) -> tuple:
    n = len(returns)
    if n == 0:
        return (0, 0.0, 0.0, 0.0, 0.0, 0.0)

    wins = [r for r in returns if r > 0]
    losses = [min(abs(r), STOP) for r in returns if r <= 0]

    p = len(wins) / n
    g = trimmed_mean(wins)
    l = trimmed_mean(losses)

    se = math.sqrt(max(p * (1.0 - p), 0.0) / n)
    p_defl = max(0.0, min(1.0, p - selection_z(m_eff) * se))

    denom = g + l
    breakeven = 1.0 if denom <= 0 else (l + cost) / denom
    return (n, p, g, l, breakeven, (p_defl - breakeven) * 100.0)


def label(margin_pp: float) -> str:
    if margin_pp <= 0:
        return "fails"
    if margin_pp <= BASIS_FLOOR_PP:
        return "INSIDE BASIS BIAS"
    return "clears"


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def report(paths: list[Path]) -> None:
    half = len(paths) // 2
    train, test = paths[:half], paths[half:]
    print(f"paths {len(paths)}  train {len(train)}  test {len(test)}")
    print(f"R = {R_TOTAL}, M_eff band {M_BAND[0]}..{M_BAND[1]}, "
          f"basis floor +{BASIS_FLOOR_PP}pp\n")

    rules: list[tuple[str, callable]] = [
        ("mirror + 0.364s (ref)", mirror_return),
        ("mirror + hard stop (ref)", mirror_return_stopped),
    ]
    rules += [(lad.name, (lambda p, L=lad: ladder_return(p, L))) for lad in LADDERS]

    for split_name, split in (("IN-SAMPLE (record only)", train), ("OUT-OF-SAMPLE", test)):
        print(f"== {split_name} ==")
        header = f"{'rule':<34}{'n':>4}{'win':>8}{'g_trim':>9}{'l_trim':>9}"
        for m in M_BAND:
            for c in COSTS:
                header += f"{'M' + str(m) + ' c=' + format(c * 100, '.2f'):>15}"
        print(header)

        for name, fn in rules:
            returns = [fn(p) for p in split]
            n, win, g, l, _, _ = score(returns, M_BAND[0], COSTS[0])
            line = f"{name:<34}{n:>4}{win:>7.1%}{g:>9.1%}{l:>9.1%}"
            worst = None
            for m in M_BAND:
                for c in COSTS:
                    margin = score(returns, m, c)[5]
                    worst = margin if worst is None else min(worst, margin)
                    line += f"{margin:>+14.1f}pp"
            print(line + "   " + label(worst))
        print()

    print("A verdict that differs between the two band ends is REFUSED, not read.")
    print("Nothing here is sized. src/core/sizing.ts stays unwired.")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--paths", default="scratch/replay-out/paths.json")
    ap.add_argument("--inspect", action="store_true")
    args = ap.parse_args()

    with open(args.paths) as fh:
        blob = json.load(fh)

    if args.inspect:
        rows = blob["paths"] if isinstance(blob, dict) else blob
        print("top level:", type(blob).__name__,
              list(blob)[:10] if isinstance(blob, dict) else f"list[{len(blob)}]")
        print("row keys:", list(rows[0]))
        for key, value in rows[0].items():
            if isinstance(value, list) and value and isinstance(value[0], dict):
                print(f"  {key}[0] keys:", list(value[0]))
        return

    report(load_paths(blob))


if __name__ == "__main__":
    main()
