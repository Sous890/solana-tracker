/**
 * The strategy seam — what decides *whether* to trade, and nothing about *how*.
 *
 * This file is types only. It has no runtime imports at all (every `import` is
 * an `import type`, erased at compile time), so `core/strategy.ts` cannot reach
 * a network, a clock, a database, or a broker even by accident.
 *
 * ── WHAT A STRATEGY CAN SEE ───────────────────────────────────────────────
 *
 * A `Context` and its arguments. That is the whole surface. Deliberately absent:
 *
 *   Broker      — a strategy that can execute is a strategy that can bypass
 *                 `guards.ts`, and the guard layer is only total because
 *                 `Broker` is the single door to funds.
 *   Ledger      — positions arrive already read, already frozen. A strategy
 *                 that can write the ledger can assert a position rather than
 *                 derive one, which is the invariant `ledger.ts` exists to hold.
 *   RPC / quotes — one narrow `getPriceSol`, so the number a strategy reasons
 *                 about is the same number the rest of the system reasons about.
 *   Screener    — sellability is a pre-buy admission check owned by guard gate
 *                 7. A strategy that consults it would be a second call site,
 *                 and handoff 08 is explicit that a second call site is a bug.
 *
 * ── DETERMINISM IS A CONTRACT, NOT AN ASPIRATION ──────────────────────────
 *
 * A strategy MUST be a pure function of `(its arguments, ctx)`. No `Date.now()`
 * — `ctx.now()` is the injected clock. No `Math.random()`. No `fetch`. No
 * module-level mutable state that outlives a call.
 *
 * This is not style. Prompt 12 promises byte-identical replays of a recorded
 * session, and a replay can only be byte-identical if the strategy computes the
 * same answer from the same inputs. `tests/strategy.test.ts` greps
 * `src/strategies/` for the three escape hatches and fails on a hit, because
 * this is the only place that promise can be enforced mechanically.
 *
 * ── IDS BELONG TO THE RUNNER ──────────────────────────────────────────────
 *
 * A strategy returns an `IntentDraft` — an `OrderIntent` with no `id`. The
 * runner assigns it. Two reasons: ids stay monotonic and replayable across a
 * whole run rather than being whatever each strategy felt like, and a strategy
 * cannot collide with (or overwrite) an intent it did not create. The ledger
 * keys simulated fills on `intentId:mint`, so a duplicated id is a silently
 * dropped fill, not an error.
 */

import type { Config } from './config.js';
import type { QuoteError } from './quoteSource.js';
import type { Address, OrderIntent, Position, TrackedSwap, UnixMillis } from './types.js';

/**
 * An intent with the `id` left off.
 *
 * `Omit` rather than a hand-written shape, so a future field on `OrderIntent`
 * reaches strategies without this file being edited — and so a strategy cannot
 * quietly stop setting one that becomes required.
 */
export type IntentDraft = Omit<OrderIntent, 'id'>;

/**
 * Structured logging port, mirroring `GuardLogger` and `LedgerLogger`.
 *
 * Deliberately has no `error`: a strategy does not get to declare an emergency.
 * Anything a strategy considers fatal is expressed by returning `null`, and the
 * runner is what reports genuine failures (a throw, a timeout) as
 * `strategy-error`.
 */
export interface StrategyLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/**
 * Everything a strategy is allowed to know, rebuilt fresh for every call.
 *
 * Not a long-lived handle: it is constructed per invocation from live state, so
 * a strategy that stashes one and reads it later is reading a stale snapshot
 * rather than corrupting anything. `positions` and every `Position` in it are
 * frozen — a strategy that tries to write one throws.
 */
export interface Context {
  /**
   * Open positions, newest state, frozen.
   *
   * `Position.state` is `'open' | 'closed'` — there is no "an exit is already
   * running" state to read, and a strategy must not try to infer one. A
   * duplicate exit is refused synchronously by the guard layer's
   * `SELL_IN_FLIGHT`, which is stronger than anything a strategy could check
   * from a snapshot.
   */
  readonly positions: readonly Position[];

  /**
   * Spendable balance in whole SOL, **derived and for heuristics only**.
   *
   * A `number` on purpose: it is a display/decision aid, never an accounting
   * input. The gas reserve is enforced on exact lamports at guard gate 3, and
   * that is the check that decides whether a spend is allowed.
   */
  readonly balanceSol: number;

  /** The validated, frozen config. Read-only; writing a field throws. */
  readonly config: Config;

  /**
   * Price in SOL per whole token, from a real routable probe quote.
   *
   * Returns a `QuoteError` rather than throwing or returning a sentinel: "there
   * is no route" is a fact the caller must handle, and a `0` or a `NaN` would
   * be indistinguishable from a real price at the point it matters most.
   */
  getPriceSol(mint: Address): Promise<number | QuoteError>;

  /** The injected clock. **Never `Date.now()`** — see the header. */
  now(): UnixMillis;

  readonly log: StrategyLogger;
}

/**
 * A trading strategy.
 *
 * Both hooks return `IntentDraft | null`, where `null` means "do nothing" and
 * is the overwhelmingly common answer. A hook returns **at most one** draft: a
 * strategy that wants to do two things does the more urgent one and gets called
 * again, which keeps the per-mint serialization in the runner meaningful.
 */
export interface Strategy {
  /** Stable identifier, used in intent ids and in the registry. */
  readonly name: string;

  /**
   * A tracked wallet swapped.
   *
   * Provisional: the stream runs at `confirmed` commitment and is about someone
   * else's wallet, so this is a hint and never a record. Handoff 07 is explicit
   * that nothing may write a position from a stream event.
   *
   * Not called while the bot is stopping or idle — see the runner.
   */
  onTrackedSwap(swap: TrackedSwap, ctx: Context): Promise<IntentDraft | null>;

  /**
   * A held position was re-priced.
   *
   * `priceSol` is the exit price for **this exact holding** — the whole
   * position quoted out to SOL — not a fixed-size sample, so it is directly
   * comparable to `position.avgEntrySol`. Both are fee-inclusive in the same
   * direction: `avgEntrySol` includes what entry cost, `priceSol` is net of
   * what the route would take on the way out.
   *
   * Called in every bot state, including after `stop()` and with the kill
   * switch engaged. Exits must keep working when entries do not.
   */
  onPriceTick(position: Position, priceSol: number, ctx: Context): Promise<IntentDraft | null>;
}
