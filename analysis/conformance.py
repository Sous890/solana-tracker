"""Cross-language conformance fixture for the master equation.

`analysis/master_equation.py` is the reference implementation; `src/core/sizing.ts`
is the port that runs in the hot path. This file pins the two together.

    python3 analysis/conformance.py --write   # regenerate from the reference
    python3 analysis/conformance.py           # check the reference still agrees
    npx vitest run tests/sizing.test.ts       # check the port agrees

The fixture is written from the REFERENCE. Regenerating it is therefore a claim
that the reference changed on purpose — never a way to make a failing port pass.
A divergence between the two is a finding about which one is wrong, not a
tolerance to widen: both run IEEE-754 doubles, so identical operations in an
identical order give identical bits.

Field names in the fixture are camelCase, matching the TypeScript, because one
canonical spelling has to win and the consumer that would silently accept a
missing key is the one reading JSON. The mapping to the Python's snake_case is
in `_decision_fields`.

Stdlib only.
"""
from __future__ import annotations

import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from master_equation import (  # noqa: E402
    EdgeParams,
    Latency,
    PoolState,
    TradeProfile,
    portfolio_heat_cap,
    size_position,
)

FIXTURE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..",
    "tests",
    "fixtures",
    "sizing-conformance.json",
)
TOLERANCE = 1e-9

# ---------------------------------------------------------------------------
# Vectors
#
# Chosen to reach every branch of `size_position`, not to look like real
# trades. Each name says which branch it is there for; a vector whose branch
# stops being reachable is a finding about the port, so none of these should be
# quietly deleted when one starts failing.
# ---------------------------------------------------------------------------

VECTORS = [
    {
        "name": "kelly-bound, no shrinkage, no deflation",
        "edge": {"wins": 60, "trades": 100},
        "trade": {"grossWin": 0.5, "grossLoss": 0.4},
        "pool": {"depthSol": 41.666666666666664, "priorityFeeSol": 8e-05,
                 "exitDepthRatio": 0.7},
        "latency": {"delayS": 5.479, "halfLifeS": 30.0},
        "equitySol": 5.0,
        "limits": {"evThreshold": 0.005},
    },
    {
        "name": "deflation at M=43, the screened-population default",
        "edge": {"wins": 343, "trades": 558, "walletsScreened": 43},
        "trade": {"grossWin": 0.038, "grossLoss": 0.4},
        "pool": {"depthSol": 41.666666666666664, "priorityFeeSol": 8e-05,
                 "exitDepthRatio": 0.7},
        "latency": {"delayS": 5.479, "halfLifeS": 30.0},
        "equitySol": 5.0,
        "limits": {"evThreshold": 0.005},
    },
    {
        "name": "deflation at M=10000, where selectionZ is largest",
        "edge": {"wins": 343, "trades": 558, "walletsScreened": 10000},
        "trade": {"grossWin": 1.5, "grossLoss": 0.4},
        "pool": {"depthSol": 41.666666666666664, "priorityFeeSol": 8e-05,
                 "exitDepthRatio": 0.7},
        "latency": {"delayS": 5.479, "halfLifeS": 30.0},
        "equitySol": 5.0,
        "limits": {"evThreshold": 0.005},
    },
    {
        "name": "beta-binomial shrinkage active",
        "edge": {"wins": 9, "trades": 10, "priorStrength": 40.0, "priorMean": 0.45},
        "trade": {"grossWin": 0.8, "grossLoss": 0.4},
        "pool": {"depthSol": 100.0, "priorityFeeSol": 8e-05},
        "latency": {"delayS": 1.0, "halfLifeS": 30.0},
        "equitySol": 5.0,
        "limits": {},
    },
    {
        "name": "p~ clamps at the 0.01 floor",
        "edge": {"wins": 0, "trades": 30, "walletsScreened": 500},
        "trade": {"grossWin": 2.0, "grossLoss": 0.4},
        "pool": {"depthSol": 100.0},
        "latency": {"delayS": 0.0, "halfLifeS": 30.0},
        "equitySol": 5.0,
        "limits": {},
    },
    {
        "name": "p~ clamps at the 0.99 ceiling",
        "edge": {"wins": 400, "trades": 400},
        "trade": {"grossWin": 2.0, "grossLoss": 0.4},
        "pool": {"depthSol": 100.0},
        "latency": {"delayS": 0.0, "halfLifeS": 30.0},
        "equitySol": 5.0,
        "limits": {},
    },
    {
        "name": "costs exceed the decayed gross win",
        "edge": {"wins": 60, "trades": 100},
        "trade": {"grossWin": 0.02, "grossLoss": 0.4},
        "pool": {"depthSol": 0.5, "priorityFeeSol": 0.01, "exitDepthRatio": 0.5},
        "latency": {"delayS": 60.0, "halfLifeS": 10.0},
        "equitySol": 5.0,
        "limits": {},
    },
    {
        "name": "EV gate closed by a raised tau",
        "edge": {"wins": 52, "trades": 100},
        "trade": {"grossWin": 0.5, "grossLoss": 0.4},
        "pool": {"depthSol": 41.666666666666664, "priorityFeeSol": 8e-05},
        "latency": {"delayS": 5.479, "halfLifeS": 30.0},
        "equitySol": 5.0,
        "limits": {"evThreshold": 0.9},
    },
    {
        "name": "pool depth cap binds",
        "edge": {"wins": 90, "trades": 100},
        "trade": {"grossWin": 1.5, "grossLoss": 0.4},
        "pool": {"depthSol": 10.0, "priorityFeeSol": 8e-05},
        "latency": {"delayS": 0.0, "halfLifeS": 30.0},
        "equitySol": 500.0,
        "limits": {},
    },
    {
        "name": "max equity fraction binds",
        "edge": {"wins": 90, "trades": 100},
        "trade": {"grossWin": 1.5, "grossLoss": 0.4},
        "pool": {"depthSol": 100000.0, "priorityFeeSol": 8e-05},
        "latency": {"delayS": 0.0, "halfLifeS": 30.0},
        "equitySol": 1.0,
        "limits": {"maxEquityFraction": 0.05},
    },
    {
        "name": "infinite half-life, surviving alpha exactly 1.0",
        "edge": {"wins": 60, "trades": 100},
        "trade": {"grossWin": 0.5, "grossLoss": 0.4},
        "pool": {"depthSol": 41.666666666666664, "priorityFeeSol": 8e-05},
        "latency": {"delayS": 5.479, "halfLifeS": 1e300},
        "equitySol": 5.0,
        "limits": {},
    },
    {
        "name": "delay far past the half-life",
        "edge": {"wins": 80, "trades": 100},
        "trade": {"grossWin": 3.0, "grossLoss": 0.4},
        "pool": {"depthSol": 41.666666666666664, "priorityFeeSol": 8e-05},
        "latency": {"delayS": 120.0, "halfLifeS": 5.0},
        "equitySol": 5.0,
        "limits": {},
    },
    {
        "name": "fixed fees dominate a tiny size",
        "edge": {"wins": 70, "trades": 100},
        "trade": {"grossWin": 1.5, "grossLoss": 0.4},
        "pool": {"depthSol": 41.666666666666664, "priorityFeeSol": 0.05, "tipSol": 0.01},
        "latency": {"delayS": 1.0, "halfLifeS": 30.0},
        "equitySol": 0.2,
        "limits": {"depthCap": 0.001},
    },
    {
        "name": "single trade, n=1",
        "edge": {"wins": 1, "trades": 1, "walletsScreened": 43},
        "trade": {"grossWin": 1.5, "grossLoss": 0.4},
        "pool": {"depthSol": 41.666666666666664, "priorityFeeSol": 8e-05},
        "latency": {"delayS": 5.479, "halfLifeS": 30.0},
        "equitySol": 5.0,
        "limits": {},
    },
    {
        "name": "lambda at 1.0, full Kelly",
        "edge": {"wins": 65, "trades": 100},
        "trade": {"grossWin": 1.2, "grossLoss": 0.4},
        "pool": {"depthSol": 41.666666666666664, "priorityFeeSol": 8e-05},
        "latency": {"delayS": 2.0, "halfLifeS": 30.0},
        "equitySol": 5.0,
        "limits": {"kellyFraction": 1.0},
    },
    # The fixed point is Kelly-bound and strictly inside the hard cap, so the
    # first damped pass lands short of it and `converged` is genuinely False.
    # A capped vector would converge on pass one and prove nothing.
    {
        "name": "one iteration only, does not converge",
        "edge": {"wins": 9, "trades": 10, "priorStrength": 40.0, "priorMean": 0.45},
        "trade": {"grossWin": 0.8, "grossLoss": 0.4},
        "pool": {"depthSol": 100.0, "priorityFeeSol": 8e-05},
        "latency": {"delayS": 1.0, "halfLifeS": 30.0},
        "equitySol": 5.0,
        "limits": {"maxIterations": 1},
    },
    {
        "name": "two iterations, still short of the fixed point",
        "edge": {"wins": 9, "trades": 10, "priorStrength": 40.0, "priorMean": 0.45},
        "trade": {"grossWin": 0.8, "grossLoss": 0.4},
        "pool": {"depthSol": 100.0, "priorityFeeSol": 8e-05},
        "latency": {"delayS": 1.0, "halfLifeS": 30.0},
        "equitySol": 5.0,
        "limits": {"maxIterations": 2},
    },
]

# `selectionZ` is where the two languages are most likely to drift, because the
# Python reaches CPython's C `_normal_dist_inv_cdf` and the port transcribes
# Wichura AS241 by hand. Pin it directly so a failure names the cause instead of
# surfacing as an unexplained size mismatch three layers up.
INV_CDF_POINTS = [
    0.5,
    0.5000000001,
    0.4999999999,
    1.0 - 1.0 / (1 + 1.0),
    1.0 - 1.0 / (13 + 1.0),
    1.0 - 1.0 / (43 + 1.0),
    1.0 - 1.0 / (200 + 1.0),
    1.0 - 1.0 / (10000 + 1.0),
    0.9,
    0.975,
    0.999999,
    1e-12,
    1.0 - 1e-12,
    0.001,
    0.2,
    0.8,
]

HEAT_VECTORS = [
    {"name": "trimmed by open exposure",
     "openPositionsSol": [0.5, 0.25], "equitySol": 5.0, "proposedSol": 1.0,
     "maxHeat": 0.3, "assumedCorrelation": 1.0},
    {"name": "proposal already inside the limit",
     "openPositionsSol": [0.1], "equitySol": 5.0, "proposedSol": 0.2,
     "maxHeat": 0.3, "assumedCorrelation": 1.0},
    {"name": "no room left, trims to zero",
     "openPositionsSol": [1.5], "equitySol": 5.0, "proposedSol": 0.5,
     "maxHeat": 0.3, "assumedCorrelation": 1.0},
    {"name": "correlation below one loosens the limit",
     "openPositionsSol": [0.8, 0.7], "equitySol": 5.0, "proposedSol": 1.0,
     "maxHeat": 0.3, "assumedCorrelation": 0.4},
    {"name": "nothing open",
     "openPositionsSol": [], "equitySol": 5.0, "proposedSol": 2.0,
     "maxHeat": 0.3, "assumedCorrelation": 1.0},
]

# ---------------------------------------------------------------------------
# Encoding
#
# JSON has no Infinity. Python's json module emits a bare `Infinity` token that
# `JSON.parse` rejects outright, so non-finite values are encoded as strings and
# decoded on both sides. Explicit beats a fixture that fails to load.
# ---------------------------------------------------------------------------


def enc(value: float) -> float | str:
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    return value


def dec(value):
    if isinstance(value, str):
        return {"NaN": math.nan, "Infinity": math.inf, "-Infinity": -math.inf}[value]
    return float(value)


def _decision_fields(d) -> dict:
    return {
        "take": d.take,
        "sizeSol": enc(d.size_sol),
        "winProb": enc(d.win_prob),
        "survivingAlpha": enc(d.surviving_alpha),
        "cost": enc(d.cost),
        "netGain": enc(d.net_gain),
        "netLoss": enc(d.net_loss),
        "expectedValue": enc(d.expected_value),
        "kellyFull": enc(d.kelly_full),
        "breakevenWinRate": enc(d.breakeven_win_rate),
        "bindingConstraint": d.binding_constraint,
        "converged": d.converged,
    }


def evaluate(v: dict) -> dict:
    edge = EdgeParams(
        wins=v["edge"]["wins"],
        trades=v["edge"]["trades"],
        wallets_screened=v["edge"].get("walletsScreened", 1),
        prior_mean=v["edge"].get("priorMean", 0.5),
        prior_strength=v["edge"].get("priorStrength", 0.0),
    )
    trade = TradeProfile(
        gross_win=v["trade"]["grossWin"], gross_loss=v["trade"]["grossLoss"]
    )
    pool = PoolState(
        depth_sol=v["pool"]["depthSol"],
        dex_fee=v["pool"].get("dexFee", 0.0025),
        priority_fee_sol=v["pool"].get("priorityFeeSol", 0.0),
        tip_sol=v["pool"].get("tipSol", 0.0),
        exit_depth_ratio=v["pool"].get("exitDepthRatio", 1.0),
    )
    latency = Latency(
        delay_s=v["latency"]["delayS"], half_life_s=v["latency"]["halfLifeS"]
    )
    lim = v.get("limits", {})
    return _decision_fields(
        size_position(
            edge,
            trade,
            pool,
            latency,
            equity_sol=v["equitySol"],
            kelly_fraction=lim.get("kellyFraction", 0.25),
            depth_cap=lim.get("depthCap", 0.01),
            ev_threshold=lim.get("evThreshold", 0.0),
            max_equity_fraction=lim.get("maxEquityFraction", 0.20),
            max_iterations=lim.get("maxIterations", 60),
            tolerance=lim.get("tolerance", 1e-9),
        )
    )


def build() -> dict:
    from statistics import NormalDist

    normal = NormalDist()
    return {
        "reference": "analysis/master_equation.py",
        "generatedBy": "python3 analysis/conformance.py --write",
        "tolerance": TOLERANCE,
        "note": (
            "Written from the Python reference. Regenerating asserts the "
            "reference changed on purpose; it is never a way to make a failing "
            "port pass. Non-finite numbers are encoded as strings."
        ),
        "normalInvCdf": [
            {"p": p, "expected": enc(normal.inv_cdf(p))} for p in INV_CDF_POINTS
        ],
        "portfolioHeatCap": [
            {**h, "expected": enc(portfolio_heat_cap(
                h["openPositionsSol"], h["equitySol"], h["proposedSol"],
                h["maxHeat"], h["assumedCorrelation"]))}
            for h in HEAT_VECTORS
        ],
        "vectors": [{**v, "expected": evaluate(v)} for v in VECTORS],
    }


def check() -> int:
    with open(FIXTURE, encoding="utf8") as fh:
        fixture = json.load(fh)

    from statistics import NormalDist

    normal = NormalDist()
    failures = []

    # `bindingConstraint` is a string and a non-finite number is ALSO encoded as
    # a string, so the two cannot be told apart by type. Dispatch on the field
    # name instead — guessing from the value is how a fixture starts silently
    # comparing "Infinity" against "pool depth cap".
    exact_fields = {"take", "converged", "bindingConstraint"}

    def compare(label, field, got, want):
        if field in exact_fields:
            if got != want:
                failures.append(f"{label}: {field}: got {got!r}, fixture {want!r}")
            return
        got, want = dec(got), dec(want)
        if math.isnan(want) and math.isnan(got):
            return
        if math.isinf(want) or math.isinf(got):
            if got != want:
                failures.append(f"{label}: {field}: got {got!r}, fixture {want!r}")
            return
        if abs(got - want) > TOLERANCE:
            failures.append(
                f"{label}: {field}: got {got!r}, fixture {want!r}, "
                f"delta {abs(got - want):.3e}"
            )

    for point in fixture["normalInvCdf"]:
        compare(f"invCdf(p={point['p']})", "value",
                normal.inv_cdf(point["p"]), point["expected"])

    for h in fixture["portfolioHeatCap"]:
        compare(f"heatCap[{h['name']}]", "value",
                portfolio_heat_cap(h["openPositionsSol"], h["equitySol"],
                                   h["proposedSol"], h["maxHeat"],
                                   h["assumedCorrelation"]),
                h["expected"])

    for v in fixture["vectors"]:
        got = evaluate(v)
        for field, want in v["expected"].items():
            compare(v["name"], field, got[field], want)

    if failures:
        print(f"CONFORMANCE FAILED — {len(failures)} mismatch(es) at tol {TOLERANCE:g}")
        for f in failures:
            print(f"  {f}")
        return 1

    n = len(fixture["vectors"]) + len(fixture["normalInvCdf"]) + len(
        fixture["portfolioHeatCap"])
    print(f"conformance OK — {n} checks, reference agrees with the fixture "
          f"to {TOLERANCE:g}")
    return 0


if __name__ == "__main__":
    if "--write" in sys.argv:
        os.makedirs(os.path.dirname(FIXTURE), exist_ok=True)
        with open(FIXTURE, "w", encoding="utf8") as fh:
            json.dump(build(), fh, indent=2)
            fh.write("\n")
        print(f"wrote {os.path.normpath(FIXTURE)}")
        sys.exit(0)
    sys.exit(check())
