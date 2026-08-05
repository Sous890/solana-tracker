/**
 * The narrow seam between "something that can price a swap" and everything that
 * needs one.
 *
 * The paper broker depends only on this, so the real aggregator client can be
 * dropped in without the broker changing. Types only plus two small pure
 * helpers — no I/O, no client, no transport concerns.
 *
 * `Quote` is imported from `core/types.ts` and deliberately not redefined here.
 */

import type { Address, Quote, RawAmount } from './types.js';

/**
 * Why a quote could not be produced.
 *
 * `NO_ROUTE` is the important one, and it is a *result*, not an exception: for
 * a mint the bot is holding, "there is no way out of this position" is a fact
 * the caller must handle, not an error it can let propagate as a transport
 * failure. Making it a return value means the compiler asks about it.
 */
export type QuoteErrorCode =
  /** No route exists between the pair at this size. The position may be trapped. */
  | 'NO_ROUTE'
  /** The upstream service failed or answered unusably. Retryable. */
  | 'UPSTREAM_ERROR'
  /** The upstream did not answer inside the deadline. Retryable. */
  | 'TIMEOUT';

export interface QuoteError {
  error: QuoteErrorCode;
  /** Human-readable detail for logs and the UI. */
  message: string;
}

export interface QuoteRequest {
  inMint: Address;
  outMint: Address;
  /** Amount offered, base units of `inMint`. */
  inAmount: RawAmount;
  /** Tolerated slippage for the route search, in bps. */
  slippageBps: number;
}

export interface QuoteSource {
  /**
   * Price a swap. Resolves to a `Quote` or a `QuoteError` — it does not reject
   * for an absent route.
   */
  getQuote(request: QuoteRequest): Promise<Quote | QuoteError>;
}

/**
 * Something wrong with an otherwise usable quote.
 *
 * An anomaly is **never** a reason to withhold a quote. Sells need quotes, and
 * an adapter that refuses an odd-but-valid route shape is a path to a stranded
 * position — the one failure this build order exists to prevent. So anomalies
 * are logged at error level, counted, and the quote is returned anyway.
 *
 * Paper P&L may be wrong when one of these fires. It may not be wrong silently.
 */
export type QuoteAnomaly =
  /** `platformFee.amount > 0`. Unrepresentable in `Quote`, so the cost is unmodelled. */
  | 'PLATFORM_FEE_PRESENT'
  /** A route hop reported a non-zero fee, which the cost model assumes is netted out. */
  | 'ROUTE_FEE_PRESENT'
  /** Top-level `outAmount` did not equal the sum of legs producing the output mint. */
  | 'OUT_AMOUNT_MISMATCH'
  /** A route leg carried no usable `percent` or `bps`. */
  | 'ROUTE_PERCENT_MISSING'
  /** `priceImpactPct` could not be parsed; treated as maximum impact. */
  | 'PRICE_IMPACT_UNPARSEABLE';

export type AnomalyCounters = Readonly<Record<QuoteAnomaly, number>>;

export interface CacheCounters {
  hits: number;
  misses: number;
  /** Entries served from the shorter NO_ROUTE TTL. */
  noRouteHits: number;
}

/** Narrow a quote result to its failure case. */
export function isQuoteError(result: Quote | QuoteError): result is QuoteError {
  return (result as QuoteError).error !== undefined;
}

/** Thrown when a caller that needs a `Quote` got a `QuoteError` instead. */
export class QuoteUnavailableError extends Error {
  readonly code: QuoteErrorCode;
  readonly inMint: Address;
  readonly outMint: Address;

  constructor(error: QuoteError, request: QuoteRequest) {
    super(`${error.error}: ${error.message} (${request.inMint} -> ${request.outMint})`);
    this.name = 'QuoteUnavailableError';
    this.code = error.error;
    this.inMint = request.inMint;
    this.outMint = request.outMint;
  }
}
