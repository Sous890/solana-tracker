"""Fit the master equation's parameters from a wallet's trade history.

The point of this module is to replace guessed inputs with measured ones. Every
function here is designed to be pessimistic where the data is ambiguous,
because the failure mode of copy trading is optimistic parameter estimates,
not conservative ones.

Expected trade export columns (rename via the mapping arguments if yours
differ):

    token           token mint address
    signal_ts       when the tracked wallet's transaction was observable (unix s)
    entry_ts        when the wallet's entry filled (unix s)
    exit_ts         when the wallet's exit filled (unix s, NaN if still open)
    sol_in          SOL spent entering
    sol_out         SOL received exiting (NaN if still open)

Requires numpy and pandas.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

__all__ = [
    "RealisedStats",
    "filter_realised",
    "realised_stats",
    "fit_alpha_half_life",
    "latency_adjusted_outcomes",
    "insider_share",
]


@dataclass(frozen=True)
class RealisedStats:
    """Summary of a wallet's closed round trips."""

    n_trades: int
    n_dropped_open: int
    n_dropped_dust: int
    win_rate: float
    avg_win: float
    avg_loss: float
    payoff_ratio: float
    median_return: float
    top_trade_share: float

    def summary(self) -> str:
        return (
            f"{self.n_trades} realised round trips "
            f"({self.n_dropped_open} open, {self.n_dropped_dust} dust dropped)\n"
            f"win rate      {self.win_rate:.1%}\n"
            f"avg win       {self.avg_win:+.1%}\n"
            f"avg loss      {self.avg_loss:+.1%}\n"
            f"payoff ratio  {self.payoff_ratio:.2f}\n"
            f"median return {self.median_return:+.1%}\n"
            f"top trade is  {self.top_trade_share:.1%} of gross profit"
        )


def filter_realised(
    df: pd.DataFrame,
    min_sol_in: float = 0.05,
    sol_in_col: str = "sol_in",
    sol_out_col: str = "sol_out",
) -> tuple[pd.DataFrame, int, int]:
    """Keep only closed round trips above a dust threshold.

    Most wallet trackers mark unsold bags at last quoted price, which inflates
    win rate because dead tokens rarely mark to zero. Airdrops and dust also
    register as trades. Both are dropped here.

    Returns:
        (filtered frame, count dropped as open, count dropped as dust)
    """
    open_mask = df[sol_out_col].isna()
    n_open = int(open_mask.sum())
    closed = df.loc[~open_mask]

    dust_mask = closed[sol_in_col] < min_sol_in
    n_dust = int(dust_mask.sum())
    return closed.loc[~dust_mask].copy(), n_open, n_dust


def realised_stats(
    df: pd.DataFrame,
    min_sol_in: float = 0.05,
    sol_in_col: str = "sol_in",
    sol_out_col: str = "sol_out",
) -> RealisedStats:
    """Compute win rate and payoff ratio from realised round trips only.

    ``top_trade_share`` is the fraction of gross profit from the single best
    trade. If it is above roughly 0.5, the wallet's record is one lottery win
    plus noise and the win rate is not a meaningful summary.
    """
    clean, n_open, n_dust = filter_realised(df, min_sol_in, sol_in_col, sol_out_col)
    if clean.empty:
        raise ValueError("no realised round trips survive filtering")

    ret = (clean[sol_out_col] / clean[sol_in_col] - 1.0).to_numpy(dtype=float)
    wins = ret[ret > 0]
    losses = ret[ret <= 0]

    gross_profit = float(wins.sum()) if wins.size else 0.0
    top_share = float(wins.max() / gross_profit) if gross_profit > 0 else 0.0
    avg_win = float(wins.mean()) if wins.size else 0.0
    avg_loss = float(losses.mean()) if losses.size else 0.0

    return RealisedStats(
        n_trades=int(ret.size),
        n_dropped_open=n_open,
        n_dropped_dust=n_dust,
        win_rate=float((ret > 0).mean()),
        avg_win=avg_win,
        avg_loss=avg_loss,
        payoff_ratio=abs(avg_win / avg_loss) if avg_loss != 0 else float("inf"),
        median_return=float(np.median(ret)),
        top_trade_share=top_share,
    )


def fit_alpha_half_life(
    delays_s: np.ndarray,
    returns: np.ndarray,
    min_points: int = 20,
) -> tuple[float, float, float]:
    """Fit r(dt) = r0 * 2^(-dt / T) by log-linear least squares.

    ``delays_s`` is the gap between the wallet's fill and a hypothetical fill
    at that delay; ``returns`` is the forward return achieved from that later
    entry. Build these by replaying historical price paths at several candidate
    delays, not from the wallet's own fills.

    Only positive returns are used, since the log transform requires it. This
    biases T upward, so treat the result as an optimistic upper bound.

    Returns:
        (half_life_s, r0, r_squared)
    """
    delays = np.asarray(delays_s, dtype=float)
    rets = np.asarray(returns, dtype=float)
    if delays.shape != rets.shape:
        raise ValueError("delays_s and returns must have the same shape")

    mask = rets > 0
    if int(mask.sum()) < min_points:
        raise ValueError(
            f"need at least {min_points} positive-return observations, got {int(mask.sum())}"
        )

    x = delays[mask]
    y = np.log(rets[mask])
    slope, intercept = np.polyfit(x, y, 1)

    if slope >= 0:
        return float("inf"), float(np.exp(intercept)), 0.0

    half_life = float(-np.log(2.0) / slope)
    predicted = slope * x + intercept
    ss_res = float(((y - predicted) ** 2).sum())
    ss_tot = float(((y - y.mean()) ** 2).sum())
    r_squared = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0

    return half_life, float(np.exp(intercept)), r_squared


def latency_adjusted_outcomes(
    df: pd.DataFrame,
    your_delay_s: float,
    half_life_s: float,
    round_trip_cost: float,
    sol_in_col: str = "sol_in",
    sol_out_col: str = "sol_out",
    min_sol_in: float = 0.05,
) -> tuple[float, float, float]:
    """Re-score the wallet's history as if you had copied it.

    Applies alpha decay to the gross move and subtracts round-trip cost, then
    recomputes win rate. Trades that closed marginally positive for the wallet
    flip negative for you, and the count of such flips is the number that
    decides whether the strategy is viable.

    Returns:
        (your_win_rate, their_win_rate, fraction_flipped)
    """
    clean, _, _ = filter_realised(df, min_sol_in, sol_in_col, sol_out_col)
    if clean.empty:
        raise ValueError("no realised round trips survive filtering")

    their_ret = (clean[sol_out_col] / clean[sol_in_col] - 1.0).to_numpy(dtype=float)
    surviving = 2.0 ** (-your_delay_s / half_life_s)

    your_ret = np.where(
        their_ret > 0,
        their_ret * surviving - round_trip_cost,
        their_ret - round_trip_cost,
    )

    their_wins = their_ret > 0
    your_wins = your_ret > 0
    flipped = float((their_wins & ~your_wins).mean())

    return float(your_wins.mean()), float(their_wins.mean()), flipped


def insider_share(
    df: pd.DataFrame,
    launch_ts_col: str = "launch_ts",
    entry_ts_col: str = "entry_ts",
    threshold_s: float = 120.0,
) -> float:
    """Fraction of entries within ``threshold_s`` of token launch.

    A high value suggests pre-launch allocation or privileged information
    rather than a signal you can replicate by watching the chain. Edge you
    cannot reproduce is not edge.
    """
    if launch_ts_col not in df.columns:
        raise ValueError(f"missing column {launch_ts_col!r}")
    age = df[entry_ts_col] - df[launch_ts_col]
    return float((age <= threshold_s).mean())
