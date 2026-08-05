"""Run the master equation on measured inputs, per decision.

Latency(delay_s=0) deliberately: `surviving_alpha = 2**(-dt/T)` is strictly
positive and monotone, and the measured forward return goes NEGATIVE between 0
and 1 second. No T represents a sign flip, so the parametric decay is
misspecified for this wallet rather than under-fed. Setting delay 0 makes
surviving_alpha = 1 and puts the whole latency question into the empirical
table instead -- which means these numbers are a ZERO-LATENCY UPPER BOUND.
"""
import os, sys
import pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
from calibrate import realised_stats
from master_equation import EdgeParams, PoolState, Latency, TradeProfile, size_position, breakeven_win_rate

SOL_USD = 180.0
LAMPORTS = 1e9
# config.json: priorityFeeMicroLamports 200000, computeUnitLimit 400000
BASE_PRIORITY_SOL = 200_000 * 400_000 / 1e6 / LAMPORTS

WALLETS = {
    "HSsJjkHr": ("HSsJjkHrxezZ1SdhgdivhDGXbxANicWbKvKsVtrMrJvG", 1.0252),
    "popo3Rj6": ("popo3Rj6arKNttyUFpWfbkv2gG8uS13TGtmH6JPMuHz", 2.2344),
}

# config.json minLiquidityUsd = 15000 -> SOL side is roughly half of TVL
DEPTH_SOL = 15_000 / SOL_USD / 2

for label, (wallet, fee_mult) in WALLETS.items():
    df = pd.read_csv(f"exports/{wallet}.decisions.csv")
    st = realised_stats(df)

    g, l = st.avg_win, abs(st.avg_loss)
    print("=" * 74)
    print(f"{label}   n={st.n_trades}  win={st.win_rate:.1%}  g={g:+.2%}  l={-l:.2%}  payoff={st.payoff_ratio:.2f}")
    print(f"  breakeven at ZERO cost: {breakeven_win_rate(g, l):.2%}   margin {st.win_rate - breakeven_win_rate(g, l):+.2%}")
    print(f"  priority fee {BASE_PRIORITY_SOL:.6f} SOL x {fee_mult:.4f} landing multiplier")
    print()
    print("  M      p~      cost    net_g    net_l  breakeven       EV   size_sol  take  binding")

    pool = PoolState(depth_sol=DEPTH_SOL, dex_fee=0.0025,
                     priority_fee_sol=BASE_PRIORITY_SOL * fee_mult,
                     tip_sol=0.0, exit_depth_ratio=0.7)
    trade = TradeProfile(gross_win=g, gross_loss=l)

    for M in (1, 5, 20, 100, 500):
        edge = EdgeParams(wins=round(st.win_rate * st.n_trades), trades=st.n_trades, wallets_screened=M)
        d = size_position(edge, trade, pool, Latency(delay_s=0.0, half_life_s=30.0),
                          equity_sol=5.0, kelly_fraction=0.25, ev_threshold=0.0)
        print(f"{M:5d}  {d.win_prob:6.2%}  {d.cost:7.2%}  {d.net_gain:7.2%}  {d.net_loss:7.2%}"
              f"  {d.breakeven_win_rate:8.2%}  {d.expected_value:+7.2%}  {d.size_sol:9.4f}  "
              f"{'YES' if d.take else 'NO ':>3}  {d.binding_constraint}")
    print()
