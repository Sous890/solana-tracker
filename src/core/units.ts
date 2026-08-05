/**
 * Conversions between exact integer quantities and human-facing decimals.
 *
 * The rule this module exists to enforce:
 *
 *   EXACT     — anything you own or owe. Token balances and lamports are
 *               `bigint` base units. All accounting is done on these, and only
 *               these. They never lose a unit and never drift.
 *
 *   DERIVED   — anything involving a price ratio: `priceSol`, `avgEntrySol`,
 *               `unrealizedSol`. These are `number`, are computed on read from
 *               the exact values, and are for display and strategy heuristics.
 *               A derived value must never be the input to an accounting
 *               decision, because rounding it changes nothing that is owed.
 *
 * Config stays in human units (whole SOL) because a human edits it; it is
 * converted to lamports once, at the boundary, by `solToLamports`.
 */

import type { Lamports, TokenAmount } from './types.js';

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Native SOL's decimals. Wrapped SOL uses the same scale. */
export const SOL_DECIMALS = 9;

/** The wrapped-SOL mint — the SOL side of every pair the bot trades. */
export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

export const BPS_DENOMINATOR = 10_000n;

/** Integer ceiling division. `a` and `b` must be non-negative. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError('ceilDiv requires a positive divisor');
  return (a + b - 1n) / b;
}

/**
 * Reduce `amount` by `bps`, rounding **down**.
 *
 * For a quantity the bot receives, so the remainder is lost to the bot rather
 * than invented for it.
 */
export function reduceByBpsFloor(amount: bigint, bps: number): bigint {
  const kept = BPS_DENOMINATOR - BigInt(bps);
  if (kept < 0n) return 0n;
  return (amount * kept) / BPS_DENOMINATOR;
}

/**
 * Realized shortfall of `actual` against `quoted`, in whole bps, rounded down.
 *
 * Measured from the two integers rather than restated from the configured
 * penalty, so the recorded slippage is what the fill actually did.
 */
export function shortfallBps(quoted: bigint, actual: bigint): number {
  if (quoted <= 0n) return 0;
  const shortfall = quoted - actual;
  if (shortfall <= 0n) return 0;
  return Number((shortfall * BPS_DENOMINATOR) / quoted);
}

/**
 * Whole SOL (float, from config or a human) to exact lamports.
 *
 * Rounds to the nearest lamport: config values like `0.05` are not exactly
 * representable in binary floating point, and truncating would make
 * `reservedGasSol: 0.03` mean 29999999 lamports.
 */
export function solToLamports(sol: number): Lamports {
  if (!Number.isFinite(sol)) throw new RangeError(`cannot convert ${sol} SOL to lamports`);
  return BigInt(Math.round(sol * Number(LAMPORTS_PER_SOL)));
}

/** Exact lamports to whole SOL, for display. Lossy above ~9e6 SOL; irrelevant here. */
export function lamportsToSol(lamports: Lamports): number {
  return Number(lamports) / Number(LAMPORTS_PER_SOL);
}

/** Whole tokens (float, from a human) to exact base units for a mint's decimals. */
export function tokensToBaseUnits(tokens: number, decimals: number): TokenAmount {
  if (!Number.isFinite(tokens)) throw new RangeError(`cannot convert ${tokens} tokens`);
  return BigInt(Math.round(tokens * 10 ** decimals));
}

/** Exact base units to whole tokens, for display only. */
export function baseUnitsToTokens(base: TokenAmount, decimals: number): number {
  return Number(base) / 10 ** decimals;
}

/**
 * Execution price in SOL per whole token, derived from the exact deltas.
 *
 * Display value. Returns 0 for a zero-token fill rather than NaN, so a
 * malformed row cannot poison an average.
 */
export function priceSolFromDeltas(
  lamportsDelta: Lamports,
  tokensDelta: TokenAmount,
  decimals: number,
): number {
  if (tokensDelta === 0n) return 0;
  const sol = lamportsToSol(lamportsDelta < 0n ? -lamportsDelta : lamportsDelta);
  const tokens = baseUnitsToTokens(tokensDelta < 0n ? -tokensDelta : tokensDelta, decimals);
  return tokens === 0 ? 0 : sol / tokens;
}

/** Absolute value for bigint, which has no `Math.abs`. */
export function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}
