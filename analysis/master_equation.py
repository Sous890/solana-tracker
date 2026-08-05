"""Position sizing for wallet-copy signals on Solana AMMs.

Implements the gated fractional-Kelly master equation:

    q* = min( A * lambda * 1{E > tau} * (p~*g - (1-p~)*l) / (g*l),  kappa * Q )

where p~ is the selection-deflated win probability, g and l are the
latency-decayed net gain and net loss per unit staked, A is account equity,
lambda is the Kelly fraction, kappa is the pool depth cap, and Q is pool depth.

Stdlib only, so this can sit in a hot path without import cost. Parameter
fitting lives in calibrate.py and depends on numpy/pandas.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from statistics import NormalDist
from typing import Sequence

_NORMAL = NormalDist()

__all__ = [
    "EdgeParams",
    "PoolState",
    "Latency",
    "TradeProfile",
    "Decision",
    "size_position",
    "breakeven_win_rate",
    "portfolio_heat_cap",
]


# ---------------------------------------------------------------------------
# Edge estimation
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EdgeParams:
    """Win-probability estimate, corrected for shrinkage and selection bias.

    Two corrections are applied in sequence:

    1. Beta-binomial shrinkage toward ``prior_mean`` with strength
       ``prior_strength`` (in pseudo-trades). Handles small samples.
    2. Selection deflation. If this wallet was the best of ``wallets_screened``
       candidates, its observed win rate is an extreme order statistic and is
       biased upward by roughly ``z_M`` standard errors.

    ``prior_strength=0`` disables shrinkage; ``wallets_screened=1`` disables
    deflation. Both defaults are deliberately conservative.
    """

    wins: int
    trades: int
    wallets_screened: int = 1
    prior_mean: float = 0.5
    prior_strength: float = 0.0

    def __post_init__(self) -> None:
        if self.trades <= 0:
            raise ValueError("trades must be positive")
        if not 0 <= self.wins <= self.trades:
            raise ValueError("wins must lie in [0, trades]")
        if self.wallets_screened < 1:
            raise ValueError("wallets_screened must be >= 1")
        if not 0.0 < self.prior_mean < 1.0:
            raise ValueError("prior_mean must lie in (0, 1)")
        if self.prior_strength < 0:
            raise ValueError("prior_strength must be non-negative")

    @property
    def raw_win_rate(self) -> float:
        return self.wins / self.trades

    @property
    def shrunk_win_rate(self) -> float:
        """Posterior mean under a Beta(a0, b0) prior."""
        a0 = self.prior_mean * self.prior_strength
        b0 = (1.0 - self.prior_mean) * self.prior_strength
        return (a0 + self.wins) / (a0 + b0 + self.trades)

    @property
    def standard_error(self) -> float:
        p = self.shrunk_win_rate
        return math.sqrt(p * (1.0 - p) / self.trades)

    @property
    def selection_z(self) -> float:
        """Expected inflation of the max of M draws, in standard errors."""
        m = self.wallets_screened
        return _NORMAL.inv_cdf(1.0 - 1.0 / (m + 1.0))

    @property
    def deflated_win_prob(self) -> float:
        """The p~ used for sizing. Clamped to [0.01, 0.99]."""
        p = self.shrunk_win_rate - self.selection_z * self.standard_error
        return min(0.99, max(0.01, p))

    @classmethod
    def from_results(
        cls,
        results: Sequence[bool],
        wallets_screened: int = 1,
        window: int | None = None,
        **kwargs,
    ) -> "EdgeParams":
        """Build from a chronological sequence of win/loss outcomes.

        Pass ``window`` to use only the most recent N trades. Re-estimating on a
        rolling window is how the gate closes itself if the wallet's edge
        decays or its behaviour changes once it is being copied.
        """
        recent = list(results)[-window:] if window else list(results)
        if not recent:
            raise ValueError("results is empty")
        return cls(
            wins=sum(1 for r in recent if r),
            trades=len(recent),
            wallets_screened=wallets_screened,
            **kwargs,
        )


# ---------------------------------------------------------------------------
# Cost model
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PoolState:
    """Constant-product pool and the costs of a round trip through it.

    ``depth_sol`` is the SOL-side reserve, not TVL. Price impact for buying
    with q into a reserve of Q is q/(Q+q); the exit is modelled the same way
    against ``depth_sol * exit_depth_ratio``.

    Set ``exit_depth_ratio`` below 1.0 to model the common case where you are
    exiting into thinner liquidity than you entered against. This is the single
    most under-modelled cost in copy trading.
    """

    depth_sol: float
    dex_fee: float = 0.0025
    priority_fee_sol: float = 0.0
    tip_sol: float = 0.0
    exit_depth_ratio: float = 1.0

    def __post_init__(self) -> None:
        if self.depth_sol <= 0:
            raise ValueError("depth_sol must be positive")
        if not 0 < self.exit_depth_ratio <= 1.0:
            raise ValueError("exit_depth_ratio must lie in (0, 1]")

    def price_impact(self, size_sol: float) -> float:
        """Round-trip price impact as a fraction of notional."""
        if size_sol <= 0:
            return 0.0
        entry = size_sol / (self.depth_sol + size_sol)
        exit_depth = self.depth_sol * self.exit_depth_ratio
        exit_ = size_sol / (exit_depth + size_sol)
        return entry + exit_

    def round_trip_cost(self, size_sol: float) -> float:
        """Total round-trip cost as a fraction of notional.

        Fixed per-transaction costs are amortised over size, so this is
        U-shaped: too small and fees dominate, too large and impact does.
        """
        if size_sol <= 0:
            return float("inf")
        fixed = 2.0 * (self.priority_fee_sol + self.tip_sol) / size_sol
        return 2.0 * self.dex_fee + self.price_impact(size_sol) + fixed


# ---------------------------------------------------------------------------
# Latency
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Latency:
    """Alpha decay between the wallet's fill and yours.

    ``half_life_s`` is the parameter you know least about and it matters nearly
    as much as the delay itself. Fit it from data with
    ``calibrate.fit_alpha_half_life`` rather than guessing.
    """

    delay_s: float
    half_life_s: float

    def __post_init__(self) -> None:
        if self.delay_s < 0:
            raise ValueError("delay_s must be non-negative")
        if self.half_life_s <= 0:
            raise ValueError("half_life_s must be positive")

    @property
    def surviving_alpha(self) -> float:
        """Fraction of the gross move still available when you land."""
        return 2.0 ** (-self.delay_s / self.half_life_s)


@dataclass(frozen=True)
class TradeProfile:
    """Gross outcome magnitudes, before costs and latency decay.

    Both are positive fractions. ``gross_loss`` is typically your stop
    distance, not the wallet's realised average loss.
    """

    gross_win: float
    gross_loss: float

    def __post_init__(self) -> None:
        if self.gross_win <= 0 or self.gross_loss <= 0:
            raise ValueError("gross_win and gross_loss must be positive")

    @property
    def payoff_ratio(self) -> float:
        return self.gross_win / self.gross_loss


# ---------------------------------------------------------------------------
# Master equation
# ---------------------------------------------------------------------------


def breakeven_win_rate(net_gain: float, net_loss: float) -> float:
    """p* = l / (g + l). Returns 1.0 if the trade cannot win."""
    if net_gain <= 0:
        return 1.0
    return net_loss / (net_gain + net_loss)


@dataclass(frozen=True)
class Decision:
    """Full audit trail for one sizing decision.

    Every intermediate is retained so a rejected trade can be explained
    without re-running the calculation.
    """

    take: bool
    size_sol: float
    win_prob: float
    surviving_alpha: float
    cost: float
    net_gain: float
    net_loss: float
    expected_value: float
    kelly_full: float
    breakeven_win_rate: float
    binding_constraint: str
    converged: bool

    @property
    def edge_over_breakeven(self) -> float:
        return self.win_prob - self.breakeven_win_rate

    def explain(self) -> str:
        if self.take:
            return (
                f"TAKE {self.size_sol:.4f} SOL | p~={self.win_prob:.1%} vs "
                f"breakeven {self.breakeven_win_rate:.1%} | EV={self.expected_value:+.2%} "
                f"| cost={self.cost:.2%} | bound by {self.binding_constraint}"
            )
        return (
            f"SKIP | p~={self.win_prob:.1%} vs breakeven "
            f"{self.breakeven_win_rate:.1%} | EV={self.expected_value:+.2%} "
            f"| cost={self.cost:.2%} | {self.binding_constraint}"
        )


def size_position(
    edge: EdgeParams,
    trade: TradeProfile,
    pool: PoolState,
    latency: Latency,
    equity_sol: float,
    kelly_fraction: float = 0.25,
    depth_cap: float = 0.01,
    ev_threshold: float = 0.0,
    max_equity_fraction: float = 0.20,
    max_iterations: int = 60,
    tolerance: float = 1e-9,
) -> Decision:
    """Evaluate the master equation for one signal.

    Cost depends on size and size depends on cost, so the fixed point is found
    by damped iteration. ``ev_threshold`` should be set above zero in
    production to leave a margin for parameter uncertainty.

    Args:
        edge: win probability estimate for the tracked wallet.
        trade: gross win/loss magnitudes for this setup.
        pool: liquidity and fee structure of the target pool.
        latency: your delay and the alpha half-life.
        equity_sol: account equity in SOL.
        kelly_fraction: lambda. 0.25 is already aggressive on estimated params.
        depth_cap: kappa. Hard ceiling as a fraction of pool depth.
        ev_threshold: tau. Minimum EV per unit staked to open.
        max_equity_fraction: absolute ceiling on any single position.

    Returns:
        A Decision with the size and every intermediate quantity.
    """
    if equity_sol <= 0:
        raise ValueError("equity_sol must be positive")
    if not 0 < kelly_fraction <= 1:
        raise ValueError("kelly_fraction must lie in (0, 1]")
    if not 0 < depth_cap <= 1:
        raise ValueError("depth_cap must lie in (0, 1]")
    if not 0 < max_equity_fraction <= 1:
        raise ValueError("max_equity_fraction must lie in (0, 1]")

    p = edge.deflated_win_prob
    surviving = latency.surviving_alpha
    hard_cap = min(equity_sol * max_equity_fraction, pool.depth_sol * depth_cap)

    size = hard_cap
    kelly_full = 0.0
    converged = False

    for _ in range(max_iterations):
        cost = pool.round_trip_cost(size)
        net_gain = trade.gross_win * surviving - cost
        net_loss = trade.gross_loss + cost

        if net_gain <= 0:
            kelly_full = 0.0
            size = 0.0
            converged = True
            break

        kelly_full = (p * net_gain - (1.0 - p) * net_loss) / (net_gain * net_loss)
        target_fraction = min(max(0.0, kelly_full) * kelly_fraction, max_equity_fraction)
        target = min(target_fraction * equity_sol, pool.depth_sol * depth_cap)

        if abs(target - size) < tolerance:
            size = target
            converged = True
            break
        size = 0.5 * size + 0.5 * target

    cost = pool.round_trip_cost(size) if size > 0 else pool.round_trip_cost(hard_cap)
    net_gain = trade.gross_win * surviving - cost
    net_loss = trade.gross_loss + cost
    ev = p * net_gain - (1.0 - p) * net_loss
    be = breakeven_win_rate(net_gain, net_loss)

    if net_gain <= 0:
        constraint = "costs exceed the decayed gross win"
    elif ev <= ev_threshold:
        constraint = "EV gate closed"
    elif size >= pool.depth_sol * depth_cap - tolerance:
        constraint = "pool depth cap"
    elif size >= equity_sol * max_equity_fraction - tolerance:
        constraint = "max equity fraction"
    else:
        constraint = "Kelly"

    take = bool(ev > ev_threshold and size > 0 and net_gain > 0)

    return Decision(
        take=take,
        size_sol=size if take else 0.0,
        win_prob=p,
        surviving_alpha=surviving,
        cost=cost,
        net_gain=net_gain,
        net_loss=net_loss,
        expected_value=ev,
        kelly_full=kelly_full,
        breakeven_win_rate=be,
        binding_constraint=constraint,
        converged=converged,
    )


def portfolio_heat_cap(
    open_positions_sol: Sequence[float],
    equity_sol: float,
    proposed_sol: float,
    max_heat: float = 0.30,
    assumed_correlation: float = 1.0,
) -> float:
    """Trim a proposed size so total exposure respects a heat limit.

    Memecoin positions correlate hard in drawdowns, so the default treats them
    as perfectly correlated: exposure simply sums. Lower ``assumed_correlation``
    only if you have measured it, and be aware that measured correlation rises
    exactly when it hurts.
    """
    if equity_sol <= 0:
        raise ValueError("equity_sol must be positive")
    effective_open = sum(open_positions_sol) * assumed_correlation
    remaining = max_heat * equity_sol - effective_open
    return max(0.0, min(proposed_sol, remaining))
