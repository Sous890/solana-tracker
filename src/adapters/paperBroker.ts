/**
 * The paper broker: a `Broker` that prices against a real quote source but
 * never submits a transaction.
 *
 * Two rules shape everything below.
 *
 * **Integer math only.** Every amount is a bigint from the quote to the ledger
 * row. There is no float intermediate anywhere on this path, not even
 * transiently — a float that exists for one line still rounds, and the whole
 * point of base units is that a full exit lands on zero.
 *
 * **Rounding always goes against the bot.** What it receives is floored, what
 * it pays is ceiled. Each site says so. A paper simulation that rounds in its
 * own favour produces a strategy that only works on paper, and the error
 * compounds across every fill.
 *
 * The output is shaped identically to a live fill apart from `simulated: true`.
 * The strategy layer must not be able to tell which broker it is talking to.
 */

import type { Broker, CanSellResult } from '../core/broker.js';
import type { Config } from '../core/config.js';
import type { QuoteRequest, QuoteSource } from '../core/quoteSource.js';
import { QuoteUnavailableError, isQuoteError } from '../core/quoteSource.js';
import type {
  Address,
  Fill,
  Lamports,
  OrderIntent,
  Position,
  Quote,
  UnixMillis,
} from '../core/types.js';
import {
  WRAPPED_SOL_MINT,
  ceilDiv,
  reduceByBpsFloor,
  shortfallBps,
  solToLamports,
} from '../core/units.js';
import type { Ledger } from '../db/ledger.js';
import type { ResolveDecimals } from './mintMetadata.js';

/** The fixed per-signature network fee. The one cost that is exactly known. */
const BASE_SIGNATURE_FEE_LAMPORTS = 5_000n;

/** Micro-lamports per lamport. */
const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;

/** Simulated time between submitting and confirming. */
export const DEFAULT_PAPER_LATENCY_MS = 400;

/**
 * `canSell` cannot be answered until the screener exists, so it answers "no".
 *
 * Distinct from the guard layer's `CANNOT_SELL` on purpose: this string means
 * "nothing has looked", not "something looked and said no". A stub that fails
 * closed cannot authorize a buy it has not checked.
 */
export const SCREENER_NOT_IMPLEMENTED = 'SCREENER_NOT_IMPLEMENTED';

export class InsufficientBalanceError extends Error {
  constructor(needed: Lamports, available: Lamports) {
    super(
      `Paper wallet has ${available} lamports, needs ${needed}. ` +
        'Refusing to execute — a negative simulated balance would model a trade that could not happen.',
    );
    this.name = 'InsufficientBalanceError';
  }
}

/** Raised when `emergencyExitAll` could not exit every position. */
export class EmergencyExitIncompleteError extends Error {
  readonly completed: Fill[];
  readonly failures: ReadonlyArray<{ mint: Address; cause: unknown }>;

  constructor(completed: Fill[], failures: ReadonlyArray<{ mint: Address; cause: unknown }>) {
    super(
      `Emergency exit sold ${completed.length} position(s) but could not exit ` +
        `${failures.length}: ${failures.map((failure) => failure.mint).join(', ')}. ` +
        'These positions are still held.',
    );
    this.name = 'EmergencyExitIncompleteError';
    this.completed = completed;
    this.failures = failures;
  }
}

export interface PaperBrokerDeps {
  quoteSource: QuoteSource;
  resolveDecimals: ResolveDecimals;
  ledger: Ledger;
  config: Config;
  /** Simulated confirmation latency. Defaults to 400ms; tests pass 0. */
  latencyMs?: number;
  /** Injectable clock, so fills are deterministic under test. */
  now?: () => UnixMillis;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Sellability check, consulted by the guard layer at buy gate 7 and nowhere
   * else. Wire `canSellFromScreener()` here.
   *
   * Defaults to the fail-closed stub: absent a real screener the bot must not
   * enter a position nothing has confirmed it can leave.
   */
  canSell?: (mint: Address) => Promise<CanSellResult>;
}

const defaultSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Total lamports a swap transaction costs in fees.
 *
 * `priorityFeeMicroLamports` is priced per compute unit, so it only becomes a
 * lamport figure once a compute budget is assumed — `config.computeUnitLimit`.
 * Ceiled: this is money the bot pays, so a fractional lamport rounds up.
 */
export function txFeeLamports(config: Config): Lamports {
  const priority = ceilDiv(
    BigInt(config.priorityFeeMicroLamports) * BigInt(config.computeUnitLimit),
    MICRO_LAMPORTS_PER_LAMPORT,
  );
  return priority + BASE_SIGNATURE_FEE_LAMPORTS;
}

export function createPaperBroker(deps: PaperBrokerDeps): Broker {
  const { quoteSource, resolveDecimals, ledger, config } = deps;
  const latencyMs = deps.latencyMs ?? DEFAULT_PAPER_LATENCY_MS;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;

  const startingLamports = solToLamports(config.paperStartingSol);

  /** Ask the quote source, turning a `QuoteError` into a throw for callers that need a Quote. */
  async function quoteOrThrow(request: QuoteRequest): Promise<Quote> {
    const result = await quoteSource.getQuote(request);
    if (isQuoteError(result)) throw new QuoteUnavailableError(result, request);
    return result;
  }

  function quoteRequestFor(intent: OrderIntent): QuoteRequest {
    return intent.side === 'buy'
      ? {
          inMint: WRAPPED_SOL_MINT,
          outMint: intent.mint,
          inAmount: intent.amountLamports ?? 0n,
          slippageBps: intent.maxSlippageBps,
        }
      : {
          inMint: intent.mint,
          outMint: WRAPPED_SOL_MINT,
          inAmount: intent.amountTokens ?? 0n,
          slippageBps: intent.maxSlippageBps,
        };
  }

  function balanceLamports(): Lamports {
    return startingLamports + ledger.getNetLamportsFlow({ simulated: true });
  }

  /**
   * Refuse anything that would drive the simulated wallet below zero.
   *
   * A negative paper balance models a transaction that could not have been
   * submitted, and every later number derived from it is fiction.
   */
  function assertSolvent(lamportsDelta: bigint, feesLamports: bigint): void {
    const available = balanceLamports();
    const resulting = available + lamportsDelta - feesLamports;
    if (resulting < 0n) {
      throw new InsufficientBalanceError(feesLamports - lamportsDelta, available);
    }
  }

  async function simulateBuy(intent: OrderIntent): Promise<Fill> {
    const spend = intent.amountLamports;
    if (spend === undefined || spend <= 0n) {
      throw new RangeError(`buy intent ${intent.id} has no positive amountLamports`);
    }

    const decimals = await resolveDecimals(intent.mint);
    const quote = await quoteOrThrow(quoteRequestFor(intent));
    const fees = txFeeLamports(config);

    // Charged before the swap is modelled: fees are owed whether or not the
    // route turns out well.
    assertSolvent(-spend, fees);

    await sleep(latencyMs);

    // `quote.outAmount` is net of route fees. Verified against the live API in
    // Prompt 6: Jupiter removed `feeAmount`/`feeMint` from `swapInfo` for this
    // reason, and the adapter counts a `ROUTE_FEE_PRESENT` anomaly if one ever
    // reappears. Subtracting route fees here would double count.
    const quoted = quote.outAmount;
    // RECEIVED side: floored, so the fractional base unit is lost to the bot.
    const received = reduceByBpsFloor(quoted, config.paperLatencyPenaltyBps);

    return {
      intentId: intent.id,
      side: 'buy',
      mint: intent.mint,
      tokensDelta: received,
      // PAID side: exactly the lamports offered. No rounding to do.
      lamportsDelta: -spend,
      decimals,
      feesLamports: fees,
      // Measured from the two integers, not restated from the config.
      slippageBps: shortfallBps(quoted, received),
      simulated: true,
      at: now(),
    };
  }

  async function simulateSell(intent: OrderIntent): Promise<Fill> {
    const tokens = intent.amountTokens;
    if (tokens === undefined || tokens <= 0n) {
      throw new RangeError(`sell intent ${intent.id} has no positive amountTokens`);
    }

    const decimals = await resolveDecimals(intent.mint);
    const quote = await quoteOrThrow(quoteRequestFor(intent));
    const fees = txFeeLamports(config);

    await sleep(latencyMs);

    // Net of route fees already; see the note in `simulateBuy`.
    const quoted = quote.outAmount;
    // RECEIVED side: floored again, against the bot.
    const received = reduceByBpsFloor(quoted, config.paperLatencyPenaltyBps);

    assertSolvent(received, fees);

    return {
      intentId: intent.id,
      side: 'sell',
      mint: intent.mint,
      // PAID side: exactly the tokens offered.
      tokensDelta: -tokens,
      lamportsDelta: received,
      decimals,
      feesLamports: fees,
      slippageBps: shortfallBps(quoted, received),
      simulated: true,
      at: now(),
    };
  }

  return {
    async getQuote(intent) {
      return quoteOrThrow(quoteRequestFor(intent));
    },

    async getPositions() {
      return ledger.getOpenPositions();
    },

    async getBalanceLamports() {
      return balanceLamports();
    },

    /**
     * Pre-buy admission only. The guard layer calls this at buy gate 7; the
     * sell path never consults it, so nothing here can block an exit.
     *
     * Falls back to refusing when no screener is injected.
     */
    async canSell(mint): Promise<CanSellResult> {
      if (deps.canSell === undefined) return { ok: false, reason: SCREENER_NOT_IMPLEMENTED };
      return deps.canSell(mint);
    },

    async execute(intent) {
      // Defensive, idempotent write. The tracker will eventually record the
      // intent before the broker is reached; until then this keeps
      // `fills.intent_id` pointing at a row that exists, and once the tracker
      // does it first this silently becomes a no-op.
      ledger.recordIntent(intent, now());

      try {
        const fill = intent.side === 'buy' ? await simulateBuy(intent) : await simulateSell(intent);
        ledger.recordFill(fill);
        ledger.resolveIntent(intent.id, 'filled', undefined, fill.at);
        return fill;
      } catch (cause) {
        const code =
          cause instanceof QuoteUnavailableError ? cause.code : (cause as Error).name;
        ledger.resolveIntent(intent.id, 'failed', code, now());
        throw cause;
      }
    },

    /**
     * Liquidate everything.
     *
     * Every position is attempted even if an earlier one fails, so a single
     * unroutable mint cannot trap the rest of the book. Failures are collected
     * and thrown afterwards rather than swallowed — a position that could not
     * be exited is the single most important thing to surface here, and the
     * fills that did land are already durable in the ledger.
     */
    async emergencyExitAll() {
      const open: Position[] = ledger.getOpenPositions();
      const completed: Fill[] = [];
      const failures: Array<{ mint: Address; cause: unknown }> = [];

      for (const position of open) {
        const intent: OrderIntent = {
          id: `emergency-${position.mint}-${now()}`,
          side: 'sell',
          mint: position.mint,
          amountTokens: position.tokens,
          maxSlippageBps: config.maxSlippageBps,
          reason: 'emergency exit',
        };

        try {
          ledger.recordIntent(intent, now());
          const fill = await simulateSell(intent);
          ledger.recordFill(fill);
          ledger.resolveIntent(intent.id, 'filled', undefined, fill.at);
          completed.push(fill);
        } catch (cause) {
          const code =
            cause instanceof QuoteUnavailableError ? cause.code : (cause as Error).name;
          ledger.resolveIntent(intent.id, 'failed', code, now());
          failures.push({ mint: position.mint, cause });
        }
      }

      if (failures.length > 0) throw new EmergencyExitIncompleteError(completed, failures);
      return completed;
    },
  };
}
