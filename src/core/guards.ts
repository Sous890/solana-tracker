/**
 * The protection layer.
 *
 * `guarded(broker, deps)` decorates any `Broker` and enforces the trading
 * invariants before delegating. It holds no strategy and makes no decisions
 * about *what* to trade — it only decides what is forbidden.
 *
 * The asymmetry below is the whole point and must survive every future edit:
 *
 *   ENTRIES are gated by every risk limit — unacknowledged crash orphans, kill
 *   switch, run status, signal freshness, gas reserve, concurrency cap,
 *   duplicate holdings, price impact, sellability, and the daily loss cap.
 *
 *   EXITS are gated only by "is there something to sell, and is a sell already
 *   running". No risk limit may ever block a sell. A risk limit exists to stop
 *   the bot acquiring more exposure; applying one to an exit would trap the bot
 *   in exactly the position the limit was warning about. If the bot is holding,
 *   it must always be able to get out.
 *
 *   WELL-FORMEDNESS is checked on both sides, ahead of everything, and is not a
 *   risk limit. "Is this a coherent instruction" is a different question from
 *   "is this a trade we want", and the asymmetry above is about the second one.
 *   A sell of `NaN` tokens of `null` is not an exit being blocked; it is not an
 *   exit. The one case that looks malformed and is not is an exit for more than
 *   is held — that is CLAMPED and executed, never refused, because the holder
 *   it would strand is precisely the one whose books already disagree with the
 *   chain.
 *
 * `emergencyExitAll()` bypasses the guard layer entirely.
 */

import type { Broker, CanSellResult } from './broker.js';
import type { Config } from './config.js';
import type { Address, BotState, Fill, Lamports, OrderIntent, Position } from './types.js';
import { lamportsToSol, solToLamports } from './units.js';

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

/** Machine-readable rejection causes. Stable — these end up in logs and the UI. */
export type GuardCode =
  // --- well-formedness, both sides ---------------------------------------
  /**
   * The intent is not a coherent instruction: a missing, non-integer,
   * non-positive or non-finite amount, or a mint that is not an address.
   *
   * Runs ahead of every other gate and applies to **both sides**. It is not a
   * risk gate, so it does not violate "no risk limit may ever block a sell" —
   * a sell for `NaN` tokens of `null` is not an exit being blocked, it is not
   * an exit at all. Nothing downstream can do anything sensible with it, and
   * before this gate existed nothing tried: it reached the broker and died as
   * a `RangeError`, or reached SQLite and was silently dropped.
   */
  | 'MALFORMED_INTENT'
  // --- entry gates -------------------------------------------------------
  /**
   * A previous run crashed mid-trade and nobody has signed off on the outcome.
   * The bot may be holding something it cannot see.
   */
  | 'UNACKNOWLEDGED_ORPHANS'
  /** Kill switch is engaged; no new exposure. */
  | 'KILL_SWITCH_ENGAGED'
  /** Bot is idle or stopping. */
  | 'NOT_RUNNING'
  /**
   * The originating swap is older than `maxSignalAgeMs`.
   *
   * A backstop, not the primary control — `MirrorStrategy` drops a stale swap
   * before an intent exists, precisely so this code stays rare. Seeing it in
   * `intents.rejection_code` means a strategy emitted an entry on a signal it
   * should have discarded, which is a fact worth having about the strategy.
   */
  | 'STALE_SIGNAL'
  /** The spend would eat into the reserved gas, stranding open positions. */
  | 'GAS_RESERVE_BREACH'
  /** Already at the concurrent position cap. */
  | 'MAX_POSITIONS_REACHED'
  /** A position in this mint is already open. */
  | 'ALREADY_HOLDING'
  /** Quoted price impact is worse than the tolerated slippage. */
  | 'PRICE_IMPACT_EXCEEDED'
  /** The broker reports this mint cannot be exited. */
  | 'CANNOT_SELL'
  /** Today's realized loss has reached the daily cap. */
  | 'DAILY_LOSS_LIMIT'
  // --- exit gates --------------------------------------------------------
  /** Nothing to sell for this mint. */
  | 'NO_OPEN_POSITION'
  /** A sell for this mint is already in flight. */
  | 'SELL_IN_FLIGHT';

/**
 * Something the guard layer did that was not a refusal.
 *
 * Kept out of `GuardCode` on purpose: that type is the set of reasons an intent
 * did NOT execute, and Prompt 12 counts it. A clamped sell executed, so filing
 * it under a rejection code would inflate the refusal count with a success.
 */
export type GuardNotice =
  /** An exit asked for more than was held and was reduced to the holding. */
  'SELL_CLAMPED';

/**
 * A refusal to execute, thrown by the guard layer.
 *
 * It is an `Error` because `Broker.execute` returns `Promise<Fill>` — there is
 * no return channel for a refusal, and a caller that ignores a rejection must
 * not proceed as though a trade occurred.
 */
export class GuardRejection extends Error {
  readonly code: GuardCode;
  /** Human-readable explanation, safe to surface in the UI. */
  readonly reason: string;
  readonly intentId: string;
  readonly side: OrderIntent['side'];
  readonly mint: Address;

  constructor(code: GuardCode, reason: string, intent: OrderIntent) {
    super(`${code}: ${reason}`);
    this.name = 'GuardRejection';
    this.code = code;
    this.reason = reason;
    this.intentId = intent.id;
    this.side = intent.side;
    this.mint = intent.mint;
  }
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** Structured fields attached to a guard log line. */
export interface GuardLogFields {
  code: GuardCode | GuardNotice;
  reason: string;
  intentId: string;
  side: OrderIntent['side'];
  mint: Address;
}

/**
 * Minimal logging port. Injected rather than importing pino directly, so this
 * module stays I/O-free and tests can assert on what was logged. `services/`
 * supplies a pino-backed implementation.
 */
export interface GuardLogger {
  warn(fields: GuardLogFields, message: string): void;
}

/**
 * Everything the guard layer needs that it cannot compute itself.
 *
 * `getState` is synchronous: `BotState` is in-memory process state.
 * `getRealizedLossSolToday` is asynchronous: it is backed by the fills table.
 */
export interface GuardDeps {
  readonly config: Config;
  readonly logger: GuardLogger;
  getState(): BotState;
  /** Realized loss for the current UTC day, as positive lamports. Exact. */
  getRealizedLossLamportsToday(): Promise<Lamports>;
  /**
   * Crash orphans awaiting operator sign-off.
   *
   * Called on every buy rather than read once at startup: acknowledging an
   * orphan mid-session must lift the gate immediately, without a restart.
   * Backed by an indexed COUNT, so it is cheap enough to ask every time.
   */
  getUnacknowledgedOrphanCount(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A position counts as held while it still has tokens and is not closed. */
function isLive(position: Position): boolean {
  return position.state !== 'closed' && position.tokens > 0n;
}

/**
 * Base58, no `0OIl`. Solana public keys land in 32-44 characters.
 *
 * Duplicated from `config.ts` rather than imported: that module reads the
 * filesystem in `loadConfig`, and pulling `node:fs` into the guard layer's
 * runtime graph to borrow a regex would trade a two-line copy for the one
 * property this file is supposed to have.
 */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Why this intent is not a coherent instruction, or `null` if it is one.
 *
 * Pure, exported, and total. Exported because the tracker needs the same
 * verdict *before* it writes the intent row — an amount this rejects may not
 * even be representable in SQLite, so "record it, then let the gate refuse it"
 * is not always available. One rule, two call sites, no drift.
 *
 * The checks are deliberately structural rather than economic. "Is this a
 * number the system can act on" is a different question from "is this a trade
 * we want", and conflating them is what produced the measured hole: the gas
 * reserve check was doing double duty as the low-end amount check, and it was
 * never designed for that.
 */
export function malformedIntentReason(intent: OrderIntent): string | null {
  if (intent.side !== 'buy' && intent.side !== 'sell') {
    return `side ${String(intent.side)} is neither buy nor sell`;
  }

  const mint: unknown = intent.mint;
  if (typeof mint !== 'string' || mint.length === 0) {
    return `mint ${mint === null ? 'null' : String(mint)} is not an address`;
  }
  if (!BASE58_ADDRESS.test(mint)) {
    return `mint ${mint} is not valid base58 (32-44 chars, no 0OIl)`;
  }

  // The field the side is denominated in. `OrderIntent`'s invariant is that
  // exactly one is set; the wrong one being present is as unusable as neither.
  const field = intent.side === 'buy' ? 'amountLamports' : 'amountTokens';
  const amount: unknown = intent.side === 'buy' ? intent.amountLamports : intent.amountTokens;

  if (amount === undefined || amount === null) return `${field} is required for a ${intent.side}`;
  if (typeof amount !== 'bigint') {
    // A `number` reaches here whenever the value came from JSON, from
    // arithmetic that lost its bigint-ness, or from a strategy. `NaN` and
    // `Infinity` are numbers, and both used to sail through: `NaN <= 0n` is
    // false, so every comparison below would have said "positive".
    return `${field} must be an exact bigint, got ${typeof amount} ${String(amount)}`;
  }
  if (amount <= 0n) return `${field} must be greater than zero, got ${amount}`;

  if (!Number.isFinite(intent.maxSlippageBps) || intent.maxSlippageBps < 0) {
    return `maxSlippageBps must be a finite non-negative number, got ${intent.maxSlippageBps}`;
  }

  return null;
}

/**
 * Lamports the gas reserve must be computed against.
 *
 * **Clamps HIGH only.** The low end is gate 0's job, and separating the two is
 * the fix for a measured defect rather than a stylistic preference.
 *
 * This `max` exists so an intent asking for MORE than `positionSizeSol` cannot
 * slip past the gas reserve by being sized differently from the config. It was
 * also, accidentally, the only thing looking at the low end — and
 * `max(-1n, 50_000_000n)` is `50_000_000n`, so a negative amount was silently
 * widened into a legal one, passed every remaining gate, and died in the broker
 * as a `RangeError` with the intent already marked `failed`.
 *
 * PRECONDITION: `malformedIntentReason(intent) === null`, so `requested` is a
 * positive bigint. Gate 0 establishes it before this is ever reached.
 */
function spendLamports(intent: OrderIntent, config: Config): Lamports {
  const configured = solToLamports(config.positionSizeSol);
  const requested = intent.amountLamports ?? 0n;
  return requested > configured ? requested : configured;
}

/**
 * Slippage tolerance for this intent, in bps.
 *
 * An intent may be stricter than the config but never looser — the config
 * ceiling is a hard limit, not a default.
 */
function toleratedSlippageBps(intent: OrderIntent, config: Config): number {
  return Math.min(intent.maxSlippageBps, config.maxSlippageBps);
}

// ---------------------------------------------------------------------------
// The decorator
// ---------------------------------------------------------------------------

/**
 * Wrap a Broker so that every entry passes the risk gates and every exit stays
 * available. Read-only methods pass through untouched.
 */
export function guarded(inner: Broker, deps: GuardDeps): Broker {
  const { config, logger } = deps;

  /**
   * Mints with an execution currently delegated to the inner broker.
   *
   * These are claimed *synchronously*, before the first `await` in `execute`.
   * Anything checked after an await is checked against stale state: two intents
   * issued in the same tick would both read "nothing in flight", both pass, and
   * both execute. For sells that is a double-sell; for buys it is a duplicate
   * position that walks straight through gates 4 and 5.
   */
  const sellsInFlight = new Set<Address>();

  /**
   * Mint -> claim ordinal for in-flight buys.
   *
   * Ordinals matter because the gates are evaluated asynchronously after the
   * claim: without them, two buys racing for the last slot would each see the
   * other's claim and both be rejected. A buy is only held against claims that
   * preceded it, so the first to arrive wins the slot.
   */
  const buysInFlight = new Map<Address, number>();
  let nextClaimOrdinal = 0;

  function reject(code: GuardCode, reason: string, intent: OrderIntent): never {
    const rejection = new GuardRejection(code, reason, intent);
    logger.warn(
      {
        code,
        reason,
        intentId: intent.id,
        side: intent.side,
        mint: intent.mint,
      },
      `Rejected ${intent.side} of ${intent.mint}: ${reason}`,
    );
    throw rejection;
  }

  /**
   * Entry gates, in the order they are specified. Order is observable — it
   * decides which code a multiply-invalid intent reports — so it is fixed.
   */
  async function guardBuy(intent: OrderIntent, claimOrdinal: number): Promise<void> {
    // 0. Unacknowledged crash orphans. Ahead of the kill switch because "we do
    //    not know what we are holding" is worse than "we chose to stop": the
    //    concurrency cap, the duplicate check and the gas reserve are all
    //    computed from positions that may be incomplete. Read fresh every time
    //    so an acknowledgement takes effect without a restart.
    const orphans = await deps.getUnacknowledgedOrphanCount();
    if (orphans > 0) {
      reject(
        'UNACKNOWLEDGED_ORPHANS',
        `${orphans} crash orphan(s) await sign-off; run \`npm run orphans\` — positions may be incomplete`,
        intent,
      );
    }

    const state = deps.getState();

    // 1. Kill switch.
    if (state.killSwitchEngaged) {
      reject('KILL_SWITCH_ENGAGED', 'kill switch is engaged; no new positions', intent);
    }

    // 2. Run status.
    if (state.status !== 'running') {
      reject('NOT_RUNNING', `bot is ${state.status}, not running`, intent);
    }

    // 3. Signal freshness.
    //
    //    Here rather than later because it is the last gate that costs nothing:
    //    everything below this line does I/O, and there is no point pricing a
    //    trade whose premise expired. It is also the last gate that can be
    //    decided from the intent alone, which keeps it reproducible from the
    //    ledger row long after the market state that drove gates 4-9 is gone.
    //
    //    `signalAgeMs === undefined` passes deliberately. It means the intent
    //    did not come from an observed swap — an operator's manual buy — and
    //    there is no signal whose age could be wrong. Rejecting those would
    //    make the gate a bar on manual entry, which is not what it is for.
    //    Every strategy-originated buy is stamped by `StrategyRunner`, so the
    //    path this gate exists to close cannot reach here unstamped.
    if (intent.signalAgeMs !== undefined && intent.signalAgeMs > config.maxSignalAgeMs) {
      reject(
        'STALE_SIGNAL',
        `originating swap is ${intent.signalAgeMs}ms old, past the ${config.maxSignalAgeMs}ms limit — the price has had time to move`,
        intent,
      );
    }

    // 4. Gas reserve. The reserve is not spendable, ever — it is what pays for
    //    the exits of positions already open. Compared in lamports: this is a
    //    decision about money, so it is made on exact integers.
    const balance = await inner.getBalanceLamports();
    const spend = spendLamports(intent, config);
    const reserve = solToLamports(config.reservedGasSol);
    if (balance - spend < reserve) {
      reject(
        'GAS_RESERVE_BREACH',
        `spending ${lamportsToSol(spend)} SOL of ${lamportsToSol(balance)} would leave less than the ${config.reservedGasSol} SOL gas reserve`,
        intent,
      );
    }

    const positions = await inner.getPositions();
    const live = positions.filter(isLive);

    // 5. Concurrency cap. Buys already in flight are not in `getPositions()`
    //    yet but will be, so they count. This intent holds a claim of its own,
    //    which is excluded.
    const earlierBuys = [...buysInFlight.values()].filter(
      (ordinal) => ordinal < claimOrdinal,
    ).length;
    const committed = live.length + earlierBuys;
    if (committed >= config.maxConcurrentPositions) {
      reject(
        'MAX_POSITIONS_REACHED',
        `already committed to ${committed} of a maximum ${config.maxConcurrentPositions} positions`,
        intent,
      );
    }

    // 6. Duplicate holding.
    if (live.some((position) => position.mint === intent.mint)) {
      reject('ALREADY_HOLDING', 'a position in this mint is already open', intent);
    }

    // 7. Price impact. `priceImpactPct` is a percent; limits are bps.
    const quote = await inner.getQuote(intent);
    const impactBps = quote.priceImpactPct * 100;
    const toleratedBps = toleratedSlippageBps(intent, config);
    if (impactBps > toleratedBps) {
      reject(
        'PRICE_IMPACT_EXCEEDED',
        `price impact ${quote.priceImpactPct}% (${impactBps} bps) exceeds the ${toleratedBps} bps limit`,
        intent,
      );
    }

    // 8. Sellability. Never enter something that cannot be exited.
    const sellable: CanSellResult = await inner.canSell(intent.mint);
    if (!sellable.ok) {
      reject('CANNOT_SELL', sellable.reason ?? 'mint cannot be sold', intent);
    }

    // 9. Daily loss cap, also in lamports.
    const lossToday = await deps.getRealizedLossLamportsToday();
    if (lossToday >= solToLamports(config.maxDailyLossSol)) {
      reject(
        'DAILY_LOSS_LIMIT',
        `today's realized loss of ${lamportsToSol(lossToday)} SOL has reached the ${config.maxDailyLossSol} SOL limit`,
        intent,
      );
    }
  }

  /**
   * Exit gate. Deliberately short — one check.
   *
   * Do not add risk checks here. The kill switch, the daily loss cap and the
   * concurrency cap are entry controls; a bot that is holding must always be
   * able to sell. See the module header.
   *
   * The second exit gate, `SELL_IN_FLIGHT`, is enforced synchronously in
   * `execute` and cannot live here — see `sellsInFlight`.
   */
  async function guardSell(intent: OrderIntent): Promise<Position> {
    const positions = await inner.getPositions();
    const held = positions.find(
      (position) => position.mint === intent.mint && isLive(position),
    );
    if (held === undefined) {
      reject('NO_OPEN_POSITION', 'no open position for this mint', intent);
    }
    return held;
  }

  /**
   * An exit for more than is held is CLAMPED, never rejected.
   *
   * This is the one malformed-looking case that must still execute. A holder
   * whose ledger and the chain disagree — the exact situation the crash-orphan
   * gate exists for — needs the exit to go through for what is actually there.
   * Refusing would strand them, which is the single outcome this whole build
   * order is arranged to prevent.
   *
   * Clamped HERE, before the broker quotes, so the quote, the fill row and the
   * position delta all describe the same quantity. Clamping later (the ledger's
   * replay already does `min(requested, tokens)`) leaves a fill row asserting a
   * sale that did not happen: measured on 2026-08-03, a sell of 999,999,999,999
   * against a 1,000,000,000 position filled, wrote `tokens_delta` of
   * -999,999,999,999, and credited the paper wallet the whole proceeds —
   * +0.997 SOL conjured out of tokens that were never held.
   *
   * The fill row records what settled, never what was requested. The intent row
   * still records what was asked, which is where the discrepancy stays visible.
   */
  function clampSellToPosition(intent: OrderIntent, held: Position): OrderIntent {
    const requested = intent.amountTokens ?? 0n;
    if (requested <= held.tokens) return intent;

    logger.warn(
      {
        code: 'SELL_CLAMPED',
        reason: `requested ${requested}, holding ${held.tokens}`,
        intentId: intent.id,
        side: intent.side,
        mint: intent.mint,
      },
      `Clamped sell of ${intent.mint} from ${requested} to the ${held.tokens} actually held`,
    );
    return { ...intent, amountTokens: held.tokens };
  }

  return {
    getQuote: (intent) => inner.getQuote(intent),
    getPositions: () => inner.getPositions(),
    getBalanceLamports: () => inner.getBalanceLamports(),
    canSell: (mint) => inner.canSell(mint),

    /** The panic path is never gated. */
    emergencyExitAll: () => inner.emergencyExitAll(),

    async execute(intent: OrderIntent): Promise<Fill> {
      // Gate 0, ahead of everything and on both sides. Synchronous and pure, so
      // it cannot be raced and cannot be reached around: an intent that is not
      // a coherent instruction never touches an in-flight claim, a quote, the
      // screener, or the broker.
      const malformed = malformedIntentReason(intent);
      if (malformed !== null) reject('MALFORMED_INTENT', malformed, intent);

      if (intent.side === 'sell') {
        // Exit gate 2, claimed before any await. A spurious rejection here
        // lasts only as long as the sell already running for this mint.
        if (sellsInFlight.has(intent.mint)) {
          reject('SELL_IN_FLIGHT', 'a sell for this mint is already in flight', intent);
        }
        sellsInFlight.add(intent.mint);
        try {
          const held = await guardSell(intent);
          return await inner.execute(clampSellToPosition(intent, held));
        } finally {
          sellsInFlight.delete(intent.mint);
        }
      }

      if (buysInFlight.has(intent.mint)) {
        reject('ALREADY_HOLDING', 'a buy for this mint is already in flight', intent);
      }
      const claimOrdinal = nextClaimOrdinal++;
      buysInFlight.set(intent.mint, claimOrdinal);
      try {
        await guardBuy(intent, claimOrdinal);
        return await inner.execute(intent);
      } finally {
        buysInFlight.delete(intent.mint);
      }
    },
  };
}
