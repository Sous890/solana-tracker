"""Prompt 17 Part 1 — decide the wallets at MEASURED delay.

NOT a zero-latency result. `Latency(delay_s=0)` is passed deliberately so that
`surviving_alpha == 1`: the decay is already baked into p~, g and l, which are
read from the empirical delay bucket. Passing a non-zero delay here would apply
2^(-dt/T) on top and double-count it — and that form is misspecified for this
wallet anyway (mean return goes negative between 0s and 1s; no T represents a
sign flip). See CLAUDE.md gap 1.
"""
import os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
from calibrate import realised_stats
from master_equation import (EdgeParams, PoolState, Latency, TradeProfile,
                             size_position, breakeven_win_rate)

# Read from the screener's store so the UI and this script cannot disagree.
# Falls back to prompt 17's locked values if the file is absent.
def _params():
    import json
    try:
        with open("data/analysis-params.json", encoding="utf8") as fh:
            p = json.load(fh)
        return int(p["wallets_screened"]), float(p["ev_threshold"]), p.get("lockedAt")
    except Exception:
        return 50, 0.005, None

M, TAU, _LOCKED_AT = _params()
MIN_SOL_IN = 0.05
SOL_USD = 180.0
BASE_PRIORITY_SOL = 200_000 * 400_000 / 1e6 / 1e9   # config.json
DEPTH_SOL = 15_000 / SOL_USD / 2                    # minLiquidityUsd, SOL side
EQUITY_SOL = 5.0                                    # paperStartingSol

HS = "HSsJjkHrxezZ1SdhgdivhDGXbxANicWbKvKsVtrMrJvG"
PO = "popo3Rj6arKNttyUFpWfbkv2gG8uS13TGtmH6JPMuHz"
DELAYS = {HS: f"exports/{HS}.delays.2026-08-05T17-13-57.csv"}
FEE_MULT = {HS: 1.0252, PO: 2.2344}

def stats_of(ret):
    ret = np.asarray(ret, float); ret = ret[np.isfinite(ret)]
    if ret.size == 0: return None
    w, lo = ret[ret > 0], ret[ret <= 0]
    g = float(w.mean()) if w.size else 0.0
    l = abs(float(lo.mean())) if lo.size else 0.0
    return dict(n=int(ret.size), wins=int((ret > 0).sum()), win=float((ret > 0).mean()),
                g=g, l=l, payoff=(g / l if l else float("inf")), med=float(np.median(ret)))

def show(label, s):
    if s is None: print(f"  {label:<36} (empty)"); return
    print(f"  {label:<36} n={s['n']:>4}  win={s['win']:7.2%}  g={s['g']:+7.2%}  "
          f"l={-s['l']:7.2%}  payoff={s['payoff']:6.2f}  med={s['med']:+7.2%}")

import datetime as _dt
_when = (_dt.datetime.utcfromtimestamp(_LOCKED_AT / 1000).isoformat() + "Z") if _LOCKED_AT else "defaults"
print(f"params: M={M}  TAU={TAU}  (locked {_when})")
print("=" * 78); print("PART 1a — population reconciliation"); print("=" * 78)

dec = pd.read_csv(f"exports/{HS}.decisions.csv")
dec = dec.loc[dec["sol_in"] >= MIN_SOL_IN].copy()
dec["ret"] = dec["sol_out"] / dec["sol_in"] - 1.0

d = pd.read_csv(DELAYS[HS])
d = d.loc[d["signature"].isin(set(dec["entry_signature"]))]

b0 = d.loc[(d["delay_s"] == 0) & (d["fill_status"] == "FILLED")]
bucket0 = stats_of(b0["forward_return"].to_numpy())
mints = set(b0["token"])
restricted = stats_of(dec.loc[dec["token"].isin(mints), "ret"].to_numpy())
full = stats_of(dec["ret"].to_numpy())

show("delay-0 bucket (pool replay)", bucket0)
show("decisions, SAME mints", restricted)
show("decisions, ALL mints", full)

gap = abs(bucket0["win"] - restricted["win"])
print(f"\n  bucket mints {len(mints)}  |  win gap bucket vs same-mint decisions: {gap*100:.2f}pp"
      f"  |  payoff gap: {abs(bucket0['payoff']-restricted['payoff']):.2f}")
print(f"  dedupe reweighting (same-mint vs ALL decisions): "
      f"{abs(restricted['win']-full['win'])*100:.2f}pp")
REPRESENTATIVE = gap <= 0.05
print()
if not REPRESENTATIVE:
    print("  *** NOT REPRESENTATIVE — gap exceeds the 5pp bar ***")
    print("  The bucket sample is small and liquidity-selected. Part 1 magnitudes below")
    print("  are UNRELIABLE and must not be read as this wallet's properties.")
else:
    print("  Representative within 5pp. Magnitudes usable.")

print(); print("=" * 78)
print(f"PART 1b/1c — size_position at MEASURED delay   (M={M}, TAU={TAU})")
print("Latency(delay_s=0) is INTENTIONAL: decay is already inside p~/g/l.")
print("=" * 78)

def run(label, s, fee_mult, note=""):
    if s is None or s["n"] == 0:
        print(f"\n-- {label}: NO DATA {note}"); return None
    pool = PoolState(depth_sol=DEPTH_SOL, dex_fee=0.0025,
                     priority_fee_sol=BASE_PRIORITY_SOL * fee_mult,
                     tip_sol=0.0, exit_depth_ratio=0.7)
    if s["g"] <= 0 or s["l"] <= 0:
        print(f"\n-- {label}: cannot build TradeProfile (g={s['g']:+.2%}, l={-s['l']:.2%}) {note}")
        return None
    trade = TradeProfile(gross_win=s["g"], gross_loss=s["l"])
    print(f"\n-- {label}  n={s['n']} wins={s['wins']} raw_win={s['win']:.2%} "
          f"g={s['g']:+.2%} l={-s['l']:.2%} payoff={s['payoff']:.2f} {note}")
    out = {}
    for mm in (1, M):
        e = EdgeParams(wins=s["wins"], trades=s["n"], wallets_screened=mm)
        dd = size_position(e, trade, pool, Latency(delay_s=0.0, half_life_s=30.0),
                           equity_sol=EQUITY_SOL, kelly_fraction=0.25, ev_threshold=TAU)
        print(f"   M={mm:<4} take={str(dd.take):<5} size={dd.size_sol:.4f}  p~={dd.win_prob:.2%}  "
              f"surviving_alpha={dd.surviving_alpha:.3f}  cost={dd.cost:.2%}")
        print(f"          net_gain={dd.net_gain:+.2%}  net_loss={dd.net_loss:+.2%}  "
              f"EV={dd.expected_value:+.3%}  kelly_full={dd.kelly_full:+.4f}")
        print(f"          breakeven={dd.breakeven_win_rate:.2%}  edge_over_breakeven="
              f"{dd.edge_over_breakeven:+.2%}  binding='{dd.binding_constraint}'  "
              f"converged={dd.converged}")
        out[mm] = dd
    return out

results = {}
for delay in (1, 2, 5):
    bd = d.loc[(d["delay_s"] == delay) & (d["fill_status"] == "FILLED")]
    results[delay] = run(f"HSsJjkHr @ delay {delay}s", stats_of(bd["forward_return"].to_numpy()),
                         FEE_MULT[HS])

print("\n-- popo3Rj6 @ measured delay: NOT EVALUABLE")
print("   No delay buckets exist for this wallet — the replay harness was only ever")
print("   run against HSsJjkHr. Producing them is new RPC, which this prompt forbids")
print("   outside Part 3. Its previous zero-latency result (EV +0.09% at M=1, NO TAKE")
print("   at M>=20) is an UPPER BOUND and cannot be spliced with a copier's win rate.")

print(); print("=" * 78); print("PART 1d — VERDICT"); print("=" * 78)
for delay in (1, 2, 5):
    r = results.get(delay)
    if r is None:
        print(f"  HSsJjkHr @ {delay}s : NO TAKE — bucket unusable"); continue
    dd = r[M]
    print(f"  HSsJjkHr @ {delay}s : {'TAKE' if dd.take else 'NO TAKE'} at (M={M}, TAU={TAU})"
          f" — closed by: {dd.binding_constraint}  (EV {dd.expected_value:+.3%})")
print(f"  popo3Rj6         : NO TAKE at (M={M}, TAU={TAU}) — not evaluable at measured delay")
