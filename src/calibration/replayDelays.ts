/**
 * Replay each round trip as if a copier had entered N seconds late.
 *
 * The question: how fast does a tracked wallet's edge decay? Answered by taking
 * the wallet's own entries, re-pricing them against the pool's realised path at
 * a set of candidate delays, and exiting where the wallet exited.
 *
 * ── THE EXIT IS THE WALLET'S EXIT, NOT A RULE ─────────────────────────────
 *
 * A copier holds until the wallet sells, because the wallet selling is the only
 * exit signal a mirror strategy has. Substituting a stop-loss or a fixed hold
 * would measure a different strategy — one with its own edge and its own decay
 * — and the number would not answer the question asked.
 *
 * ── NO_FILL IS A RESULT ───────────────────────────────────────────────────
 *
 * If the pool has no swap between the delayed target and the wallet's exit,
 * there was nothing to buy: the copier arrived and the token had stopped
 * trading. Those rows are emitted with `fill_status = NO_FILL` and no return.
 * Dropping them would quietly delete the worst outcomes at the longest delays —
 * which is precisely where the decay being measured is largest — and the
 * remaining rows would show a *flatter* curve than reality.
 *
 * ── WHAT THIS DOES NOT DO ─────────────────────────────────────────────────
 *
 * No fitting. It emits a CSV of forward returns per delay and stops.
 * `calibrate.fit_alpha_half_life` does the fit, in Python, where the numerics
 * belong. Nothing here computes a half-life, an r-squared or a regression.
 */

import type { Address } from '../core/types.js';
import { firstAtOrAfter, nearestTo } from './poolHistory.js';
import type { PoolSwap } from './poolHistory.js';

/** Candidate delays, seconds. Dense at the short end, where decay is steepest. */
export const DEFAULT_DELAYS_S = [0, 1, 2, 5, 15, 30, 60, 120] as const;

export interface RoundTripInput {
  token: Address;
  /** Entry transaction; identifies the round trip in the output. */
  signature: string;
  signalTs: number;
  exitTs: number;
}

/**
 * Why a row has no return, and the NO_FILL/NO_DATA split is load-bearing.
 *
 * `NO_DATA`  — the reconstructed path had no swaps in this window at all. That
 *              is a statement about our fetching, not about the market: the
 *              signature walk never reached this date, or the fetch cap clipped
 *              it. Run 1 reported ~70% "NO_FILL" that was entirely this.
 * `NO_FILL`  — the path HAD swaps, and none of them landed at or after the
 *              delayed target before the wallet exited. That is a real market
 *              fact: a copier arriving that late had nothing to buy.
 *
 * Collapsing the two makes a coverage gap indistinguishable from illiquidity,
 * and the second is a result while the first invalidates one.
 */
export type FillStatus = 'FILLED' | 'NO_FILL' | 'NO_DATA' | 'NO_EXIT_PRICE';

export interface DelayRow {
  token: Address;
  signature: string;
  signalTs: number;
  exitTs: number;
  delayS: number;
  entryPriceSol: number;
  exitPriceSol: number;
  forwardReturn: number;
  fillStatus: FillStatus;
  nPoolSwapsInWindow: number;
}

/**
 * One row per (round trip, delay).
 *
 * `swaps` must already be ordered by `orderPoolSwaps` — the caller holds one
 * sorted array per mint and reuses it across all eight delays, which is both
 * cheaper and the reason two runs over the same cache agree exactly.
 */
export function replayRoundTrip(
  trip: RoundTripInput,
  swaps: readonly PoolSwap[],
  delays: readonly number[] = DEFAULT_DELAYS_S,
): DelayRow[] {
  // The window a copier could have transacted in: from the signal to the
  // wallet's exit. Counted once and reported on every row, because a round trip
  // whose pool went quiet is a different kind of observation from one that was
  // liquid throughout, and the diagnostics need to tell them apart.
  const inWindow = swaps.filter(
    (swap) => swap.blockTime >= trip.signalTs && swap.blockTime <= trip.exitTs,
  );

  const exit = nearestTo(swaps, trip.exitTs);

  return delays.map((delayS) => {
    const base: DelayRow = {
      token: trip.token,
      signature: trip.signature,
      signalTs: trip.signalTs,
      exitTs: trip.exitTs,
      delayS,
      entryPriceSol: Number.NaN,
      exitPriceSol: Number.NaN,
      forwardReturn: Number.NaN,
      // No coverage until proven otherwise. An empty window is a fetching
      // failure, and defaulting to NO_FILL would file it as a market fact.
      fillStatus: inWindow.length === 0 ? 'NO_DATA' : 'NO_FILL',
      nPoolSwapsInWindow: inWindow.length,
    };

    // Nothing was reconstructed here, so nothing can be concluded here.
    if (swaps.length === 0 || inWindow.length === 0) return { ...base, fillStatus: 'NO_DATA' };

    const targetTs = trip.signalTs + delayS * 1_000;
    const entry = firstAtOrAfter(swaps, targetTs);

    // The path exists and simply had nothing at or after the delayed target
    // before the wallet sold. A copier arriving that late could not have bought.
    if (entry === undefined || entry.blockTime > trip.exitTs) {
      return { ...base, fillStatus: 'NO_FILL' };
    }
    if (exit === undefined) return { ...base, fillStatus: 'NO_EXIT_PRICE' };

    const forwardReturn = exit.priceSol / entry.priceSol - 1;
    if (!Number.isFinite(forwardReturn)) return { ...base, fillStatus: 'NO_EXIT_PRICE' };

    return {
      ...base,
      entryPriceSol: entry.priceSol,
      exitPriceSol: exit.priceSol,
      forwardReturn,
      fillStatus: 'FILLED',
    };
  });
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface DelayStats {
  delayS: number;
  n: number;
  nFilled: number;
  medianReturn: number;
  meanReturn: number;
  winRate: number;
  /** Genuine illiquidity: the path existed and offered no entry. A RESULT. */
  noFillRate: number;
  /** Missing coverage: the path was empty. Invalidates the bucket, not a result. */
  noDataRate: number;
  /** Filled / (filled + NO_FILL), excluding NO_DATA. The honest fill rate. */
  fillRate: number;
  /**
   * Points surviving `fit_alpha_half_life`'s log mask.
   *
   * The fit takes logs of forward returns, so only strictly positive ones
   * survive. This — not `nFilled` — is the sample size the half-life is
   * actually estimated from, and it is the number the acceptance criteria are
   * written against.
   */
  nPositive: number;
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

/**
 * Per-delay summary, printed before anything is fitted.
 *
 * If decay is not visible here by eye, the fit downstream is meaningless
 * whatever its r-squared says — a regression through noise still returns a
 * number, and that number will be a half-life somebody might size against.
 */
export function summarise(rows: readonly DelayRow[], delays: readonly number[] = DEFAULT_DELAYS_S): DelayStats[] {
  return delays.map((delayS) => {
    const forDelay = rows.filter((row) => row.delayS === delayS);
    const filled = forDelay.filter((row) => row.fillStatus === 'FILLED');
    const returns = filled.map((row) => row.forwardReturn);

    const noFill = forDelay.filter((row) => row.fillStatus === 'NO_FILL').length;
    const noData = forDelay.filter((row) => row.fillStatus === 'NO_DATA').length;
    const attempted = filled.length + noFill;

    return {
      delayS,
      n: forDelay.length,
      nFilled: filled.length,
      medianReturn: median(returns),
      meanReturn:
        returns.length === 0 ? Number.NaN : returns.reduce((a, b) => a + b, 0) / returns.length,
      winRate:
        returns.length === 0 ? Number.NaN : returns.filter((r) => r > 0).length / returns.length,
      noFillRate: forDelay.length === 0 ? Number.NaN : noFill / forDelay.length,
      noDataRate: forDelay.length === 0 ? Number.NaN : noData / forDelay.length,
      // Denominator excludes NO_DATA: a window we never fetched is not evidence
      // that a copier could or could not have filled in it.
      fillRate: attempted === 0 ? Number.NaN : filled.length / attempted,
      nPositive: returns.filter((value) => value > 0).length,
    };
  });
}

// ---------------------------------------------------------------------------
// Survivorship
// ---------------------------------------------------------------------------

export interface SurvivorshipWarning {
  triggered: boolean;
  detail: string;
}

/**
 * Does the fill rate fall as delay grows?
 *
 * This is the bias that would quietly corrupt the half-life. Unfilled windows
 * are illiquid ones, and illiquid ones are disproportionately losers — so every
 * measured curve is already computed on a favourable subsample. If the fill rate
 * ALSO falls with delay, that subsample gets *cleaner* as delay grows: the long
 * buckets shed their worst outcomes fastest, the measured decay looks shallower
 * than it is, and the fitted half-life comes out too long.
 *
 * `fit_alpha_half_life` independently biases the half-life upward by keeping
 * only positive returns for the log. Two optimistic biases compounding in one
 * parameter — and it is the parameter `master_equation.py` gives the least
 * guidance on guessing. So this is measured and reported rather than assumed
 * absent.
 */
export function checkFillRateStability(stats: readonly DelayStats[]): SurvivorshipWarning {
  const usable = stats.filter((row) => Number.isFinite(row.fillRate));
  if (usable.length < 2) {
    return { triggered: false, detail: 'not enough delay buckets with a usable fill rate' };
  }

  const first = usable[0] as DelayStats;
  const last = usable[usable.length - 1] as DelayStats;
  const drop = first.fillRate - last.fillRate;

  return {
    triggered: drop > 0.1,
    detail:
      `fill rate ${(first.fillRate * 100).toFixed(1)}% at ${first.delayS}s -> ` +
      `${(last.fillRate * 100).toFixed(1)}% at ${last.delayS}s ` +
      `(${drop >= 0 ? 'drop' : 'rise'} ${Math.abs(drop * 100).toFixed(1)}pp)` +
      (drop > 0.1
        ? ' — long delays are dropping their worst trades, so the measured decay is TOO SHALLOW and any fitted half-life is TOO LONG'
        : ' — no material survivorship drift'),
  };
}

// ---------------------------------------------------------------------------
// Acceptance criteria, fixed before the run
// ---------------------------------------------------------------------------

export interface Acceptance {
  name: string;
  passed: boolean;
  detail: string;
}

/** ≥20 positive points, spread across the range, and a roughly monotone median. */
export function acceptanceCriteria(
  stats: readonly DelayStats[],
  minPositive = 20,
): Acceptance[] {
  const totalPositive = stats.reduce((sum, row) => sum + row.nPositive, 0);

  const longBuckets = stats.filter((row) => row.delayS >= 30);
  const longPositive = longBuckets.reduce((sum, row) => sum + row.nPositive, 0);
  const bucketsWithEnough = stats.filter((row) => row.nPositive >= 3).length;

  // The fit pools every delay into one log-linear regression, so a thin tail
  // lets the short buckets set the slope by themselves.
  const spreadOk = longPositive >= 5 && bucketsWithEnough >= 5;

  const medians = stats.map((row) => row.medianReturn).filter(Number.isFinite);
  let inversions = 0;
  for (let i = 1; i < medians.length; i += 1) {
    if ((medians[i] as number) > (medians[i - 1] as number)) inversions += 1;
  }
  const monotoneOk = medians.length >= 4 && inversions <= Math.floor(medians.length / 3);

  return [
    {
      name: `>= ${minPositive} positive-return points survive the log mask`,
      passed: totalPositive >= minPositive,
      detail: `${totalPositive} positive of ${stats.reduce((s, r) => s + r.nFilled, 0)} filled`,
    },
    {
      name: 'positive points present across the delay range, not piled at the short end',
      passed: spreadOk,
      detail: `${longPositive} positive at >=30s; ${bucketsWithEnough}/${stats.length} buckets have >=3`,
    },
    {
      name: 'median is monotone-ish (a non-negative slope returns inf from the fit)',
      passed: monotoneOk,
      detail: `${inversions} inversion(s) across ${medians.length} buckets`,
    },
  ];
}

export function formatStats(stats: readonly DelayStats[]): string {
  const pct = (value: number): string =>
    Number.isFinite(value) ? `${(value * 100).toFixed(2)}%`.padStart(9) : '        —';

  const lines = [
    'delay_s        n   filled      pos     median       mean   win_rate  fill_rate   no_fill   no_data',
    '------- -------- -------- -------- ---------- ---------- ---------- ---------- --------- ---------',
  ];
  for (const row of stats) {
    lines.push(
      [
        String(row.delayS).padStart(7),
        String(row.n).padStart(8),
        String(row.nFilled).padStart(8),
        String(row.nPositive).padStart(8),
        pct(row.medianReturn),
        pct(row.meanReturn),
        pct(row.winRate),
        pct(row.fillRate),
        pct(row.noFillRate),
        pct(row.noDataRate),
      ].join(' '),
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Sanity checks
// ---------------------------------------------------------------------------

export interface SanityCheck {
  name: string;
  passed: boolean;
  detail: string;
}

/**
 * Delay 0 must reproduce the wallet's own realised median.
 *
 * At zero delay the copier is the wallet, so the reconstructed path should
 * return what the wallet actually got. A large gap does not mean alpha is
 * decaying — it means the pool reconstruction is wrong, and every number
 * downstream of it is describing the wrong pool or the wrong price convention.
 *
 * ── COMPARE THE SAME POPULATION ───────────────────────────────────────────
 *
 * The wallet median is computed over **exactly the round trips that filled at
 * delay 0**, not over everything sampled. This is not a refinement; the earlier
 * version compared the replay's 15 filled trips against the wallet's own median
 * across all 120 sampled, reported an 18.48pp gap, and FAILED — while the
 * like-for-like gap on the same data was 3.18pp and passes.
 *
 * A high NO_FILL rate makes the two populations wildly different, and NO_FILL
 * is not random: it selects for illiquid windows, which are the losing trades.
 * So the unfilled remainder is systematically better than the filled subset,
 * and comparing against it manufactures a failure out of nothing.
 */
export function checkDelayZeroMatchesRealised(
  stats: readonly DelayStats[],
  rows: readonly DelayRow[],
  /** The wallet's own realised return for a round trip, by its delay-0 row. */
  walletReturnOf: (row: DelayRow) => number,
  toleranceAbs = 0.05,
): SanityCheck {
  const zero = stats.find((row) => row.delayS === 0);
  const observed = zero?.medianReturn ?? Number.NaN;

  const filled = rows.filter((row) => row.delayS === 0 && row.fillStatus === 'FILLED');
  const walletReturns = filled.map(walletReturnOf).filter((value) => Number.isFinite(value));

  const sorted = [...walletReturns].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const walletMedian =
    sorted.length === 0
      ? Number.NaN
      : sorted.length % 2 === 0
        ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
        : (sorted[mid] as number);

  const gap = Math.abs(observed - walletMedian);
  return {
    name: 'delay-0 median ≈ wallet realised median (same population)',
    passed: Number.isFinite(gap) && gap <= toleranceAbs,
    detail:
      `replay ${(observed * 100).toFixed(2)}% vs wallet ${(walletMedian * 100).toFixed(2)}% ` +
      `over the SAME ${walletReturns.length} filled trip(s) ` +
      `(gap ${(gap * 100).toFixed(2)}pp, tolerance ${(toleranceAbs * 100).toFixed(0)}pp)`,
  };
}

/** A filled row priced off a window with no swaps in it is a contradiction. */
export function checkFilledRowsHaveSwaps(rows: readonly DelayRow[]): SanityCheck {
  const offenders = rows.filter(
    (row) => row.fillStatus === 'FILLED' && row.nPoolSwapsInWindow <= 0,
  );
  return {
    name: 'every FILLED row has n_pool_swaps_in_window > 0',
    passed: offenders.length === 0,
    detail:
      offenders.length === 0
        ? `${rows.filter((r) => r.fillStatus === 'FILLED').length} filled rows, all with swaps`
        : `${offenders.length} filled row(s) claim a price from an empty window`,
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export const DELAYS_CSV_HEADER =
  'token,signature,signal_ts,exit_ts,delay_s,entry_price_sol,exit_price_sol,forward_return,fill_status,n_pool_swaps_in_window';

export function delaysCsv(rows: readonly DelayRow[]): string {
  const cell = (value: number): string => (Number.isFinite(value) ? String(value) : '');
  const lines = [DELAYS_CSV_HEADER];
  for (const row of rows) {
    lines.push(
      [
        row.token,
        row.signature,
        row.signalTs,
        row.exitTs,
        row.delayS,
        cell(row.entryPriceSol),
        cell(row.exitPriceSol),
        cell(row.forwardReturn),
        row.fillStatus,
        row.nPoolSwapsInWindow,
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Part 4 — failure-rate cost adjustment
// ---------------------------------------------------------------------------

export interface FailureAdjustment {
  wallet: Address;
  failedTransactions: number;
  successfulRoundTrips: number;
  failureRate: number;
  /**
   * What `PoolState.priority_fee_sol` must be multiplied by before sizing.
   *
   * Realised returns are computed only over round trips that *closed*, so every
   * priority fee spent on a transaction that reverted is invisible in the cost
   * basis. A wallet landing one transaction in two pays roughly twice the fee
   * per successful entry, and sizing against the unadjusted fee understates the
   * cost of copying it by that factor.
   *
   * Derived and printed, never hardcoded: it is a property of a wallet at a
   * point in time, and a constant in the source would silently outlive the
   * measurement that produced it.
   */
  priorityFeeMultiplier: number;
}

export function failureAdjustment(
  wallet: Address,
  failedTransactions: number,
  successfulRoundTrips: number,
): FailureAdjustment {
  const total = failedTransactions + successfulRoundTrips;
  return {
    wallet,
    failedTransactions,
    successfulRoundTrips,
    failureRate: total === 0 ? Number.NaN : failedTransactions / total,
    priorityFeeMultiplier:
      successfulRoundTrips === 0
        ? Number.POSITIVE_INFINITY
        : 1 + failedTransactions / successfulRoundTrips,
  };
}
