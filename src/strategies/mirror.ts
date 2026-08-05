/**
 * MirrorStrategy — copy the tracked wallets, exit on a fixed band.
 *
 * Entries mirror somebody else. Exits do not: a tracked wallet's sell is one
 * exit trigger, and a hard stop / take-profit band is the other, because a
 * wallet that stops trading (or that we stop seeing, at `confirmed` commitment,
 * over a websocket that can drop) must not mean we hold forever.
 *
 * ── PURITY ────────────────────────────────────────────────────────────────
 *
 * No `Date.now`, no `Math.random`, no `fetch`, no module-level mutable state.
 * `tests/strategy.test.ts` greps this directory for the first three and fails
 * on a hit. Everything time-dependent comes from `ctx.now()`. See the header of
 * `core/strategy.ts` for why: Prompt 12's replay promise is only keepable if
 * this file is a pure function of its arguments.
 *
 * ── WHY THE NO-OPS ARE EXPLICIT ───────────────────────────────────────────
 *
 * Several of the cases below would also be caught by `guards.ts` — a duplicate
 * buy is `ALREADY_HOLDING`, a sell with nothing to sell is `NO_OPEN_POSITION`.
 * Returning `null` anyway is not belt-and-braces, it is a different claim.
 *
 * A guard rejection is a *record*: it is written to `intents.rejection_code`
 * and Prompt 12 counts them by code to say how often the risk limits actually
 * bit. A strategy that knowingly emits intents it expects to be rejected fills
 * that table with self-inflicted noise, and the report stops describing the
 * market and starts describing the strategy's sloppiness. So: the strategy does
 * not emit what it already knows is wrong; the runner does not second-guess
 * what the strategy emitted.
 */

import type { Context, IntentDraft, Strategy } from '../core/strategy.js';
import type { Position, TrackedSwap } from '../core/types.js';
import { lamportsToSol, solToLamports } from '../core/units.js';

/**
 * Exit band, as a percentage move from `avgEntrySol`.
 *
 * Both bounds are **inclusive**: exactly -40.00% sells, exactly +150.00% sells.
 * A boundary that sits between the two comparisons is a boundary nobody can
 * state, and the tests pin -39.9 / -40.0 / -40.1 precisely because "at the
 * threshold" is the case a reader will assume and a mutation will flip.
 */
export const STOP_LOSS_PCT = -40;
export const TAKE_PROFIT_PCT = 150;

/**
 * A price with no exponent and no trailing zeros, for the reason string.
 *
 * `String(0.000000123)` is `"1.23e-7"`, which is unreadable in an audit log and
 * — worse — not stable to eyeball against the ledger. Fixed 9 decimal places
 * matches SOL's own scale, then trailing zeros come off.
 */
export function formatPriceSol(price: number): string {
  if (!Number.isFinite(price)) return String(price);
  const fixed = price.toFixed(9);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/** `7xKXtg2C...q2` -> `7xKX..q2`, so a reason line stays readable. */
export function shortAddress(address: string): string {
  return address.length <= 8 ? address : `${address.slice(0, 4)}..${address.slice(-2)}`;
}

/** Signed percentage, one decimal place, always carrying its sign. */
function signedPct(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

/**
 * A position counts as held while it has tokens and is not closed.
 *
 * There is no third state to consider. `PositionState.closing` was deleted on
 * 2026-08-03 — nothing had ever produced it, and it could not be produced
 * without the positions table asserting something the fills do not say.
 *
 * What actually stops a mint being bought back while it is being sold is the
 * guard layer: `sellsInFlight` for the exit (`SELL_IN_FLIGHT`) and
 * `buysInFlight` for the entry (`ALREADY_HOLDING`), both claimed synchronously
 * before any await. A strategy reading a persisted flag could not have been as
 * strong, because the flag would be stale by the time it was read.
 */
function heldPosition(ctx: Context, mint: string): Position | undefined {
  return ctx.positions.find(
    (position) => position.mint === mint && position.state !== 'closed' && position.tokens > 0n,
  );
}

export function createMirrorStrategy(): Strategy {
  return {
    name: 'mirror',

    async onTrackedSwap(swap: TrackedSwap, ctx: Context): Promise<IntentDraft | null> {
      const held = heldPosition(ctx, swap.mint);

      if (swap.side === 'buy') {
        // Already holding it. A second tracked wallet buying the same mint is
        // not a second signal worth acting on — it is the same position.
        if (held !== undefined) return null;

        // ── NO AGE CHECK HERE, DELIBERATELY ─────────────────────────────────
        //
        // A stale swap — a reconnect backlog, a cold-cursor gap fill — must not
        // become a position, and it does not: `guards.ts` refuses it as
        // STALE_SIGNAL on `signalAgeMs`, which `StrategyRunner` stamps from
        // `blockTime` and which a strategy cannot forge.
        //
        // Filtering it *here too* is the obvious instinct and is still wrong,
        // because it would make the filtering invisible. No intent would be
        // created, so no row would reach `intents.rejection_code`, so the
        // STALE_SIGNAL counter would read zero forever — while the bot quietly
        // declined to trade. The only evidence would be a debug line. "How much
        // signal are we dropping as stale, and is the window right?" has to be
        // answerable from the ledger.
        //
        // Same reasoning as the no-ops above, pointed the other way. Those
        // return `null` because the strategy KNOWS the intent is invalid and a
        // self-inflicted rejection is noise. Here it does not know: whether 14s
        // is stale is `maxSignalAgeMs`'s call, that is a risk limit, and a risk
        // limit biting is a measurement rather than noise.

        return {
          side: 'buy',
          mint: swap.mint,
          amountLamports: solToLamports(ctx.config.positionSizeSol),
          maxSlippageBps: ctx.config.maxSlippageBps,
          reason: `mirror: ${shortAddress(swap.wallet)} bought ${formatPriceSol(
            lamportsToSol(swap.solAmount),
          )} SOL`,
        };
      }

      // A tracked wallet sold something we never held. Nothing to mirror — and
      // emitting a sell here would be `NO_OPEN_POSITION`, self-inflicted.
      if (held === undefined) return null;

      // They sold some fraction; we sell all of it. Mirroring the fraction
      // would leave a remainder that occupies a concurrency slot and still has
      // to be exited later, on a signal that may never come.
      return {
        side: 'sell',
        mint: swap.mint,
        amountTokens: held.tokens,
        maxSlippageBps: ctx.config.maxSlippageBps,
        reason: `mirror: ${shortAddress(swap.wallet)} sold ${formatPriceSol(
          lamportsToSol(swap.solAmount),
        )} SOL`,
      };
    },

    async onPriceTick(
      position: Position,
      priceSol: number,
      ctx: Context,
    ): Promise<IntentDraft | null> {
      // Nothing to sell. A concurrent exit is the guard layer's problem, not
      // this one's — `SELL_IN_FLIGHT` is claimed synchronously and a strategy
      // cannot beat it.
      if (position.state !== 'open' || position.tokens <= 0n) return null;

      // No usable price. **Hold — do not panic-sell.** A missing or nonsensical
      // price is a fact about our data, not about the token, and selling on it
      // converts a plumbing failure into a realized loss. A genuinely
      // unroutable position is already surfaced by the tracker's `route-lost`
      // latch, which is an alert for a human, not a signal for a strategy.
      if (!Number.isFinite(priceSol) || priceSol <= 0) return null;

      const entry = position.avgEntrySol;
      if (!Number.isFinite(entry) || entry <= 0) return null;

      const changePct = ((priceSol - entry) / entry) * 100;

      // Inclusive on both bounds; see STOP_LOSS_PCT.
      const trigger =
        changePct <= STOP_LOSS_PCT ? 'stop' : changePct >= TAKE_PROFIT_PCT ? 'take' : null;
      if (trigger === null) return null;

      ctx.log.info(
        { mint: position.mint, trigger, changePct, entry, priceSol, at: ctx.now() },
        `${trigger} triggered on ${position.mint}`,
      );

      return {
        side: 'sell',
        mint: position.mint,
        amountTokens: position.tokens,
        maxSlippageBps: ctx.config.maxSlippageBps,
        reason: `${trigger}: ${signedPct(changePct)} from ${formatPriceSol(entry)}`,
      };
    },
  };
}
