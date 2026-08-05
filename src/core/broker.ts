/**
 * The Broker interface — the only execution surface strategy code may call.
 *
 * Strategy code must never reach an RPC client, a wallet, or a DEX adapter
 * directly. Everything it is allowed to do to the outside world is on this
 * interface, which is what makes the guard layer in `guards.ts` total: if the
 * only door is `Broker`, decorating `Broker` decorates every path to funds.
 *
 * Implementations live in `adapters/` (live) and `services/` (paper). Both are
 * wrapped by `guarded()` before any strategy sees them.
 */

import type { Fill, Lamports, OrderIntent, Position, Quote } from './types.js';

/** Whether a position can currently be exited, and why not if it cannot. */
export interface CanSellResult {
  ok: boolean;
  /** Human-readable cause when `ok` is false. Absent when `ok` is true. */
  reason?: string;
}

export interface Broker {
  /** Price an intent without committing to it. Never moves funds. */
  getQuote(intent: OrderIntent): Promise<Quote>;

  /**
   * Execute an intent and return the resulting Fill.
   *
   * Throws on rejection — including `GuardRejection` when wrapped by
   * `guarded()`. A returned Fill always means the trade happened (or was
   * simulated, per `Fill.simulated`).
   */
  execute(intent: OrderIntent): Promise<Fill>;

  /** Every position the broker considers live. Excludes closed positions. */
  getPositions(): Promise<Position[]>;

  /** Spendable + reserved balance, in lamports. The guard layer subtracts the reserve. */
  getBalanceLamports(): Promise<Lamports>;

  /**
   * Whether this mint can actually be exited right now — liquidity exists, the
   * mint is not frozen, transfers are not tax-trapped. Checked before entry:
   * a position that cannot be sold is a loss no risk limit can undo.
   */
  canSell(mint: string): Promise<CanSellResult>;

  /**
   * Liquidate everything, immediately. This is the panic path: it is never
   * blocked by the guard layer, including when the kill switch is engaged.
   */
  emergencyExitAll(): Promise<Fill[]>;
}
