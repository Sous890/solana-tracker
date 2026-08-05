/**
 * Jupiter Swap API v1 — the real implementation of `QuoteSource`.
 *
 * Verified live against `https://lite-api.jup.ag/swap/v1/quote` while writing
 * this; see `docs/handoffs/06-quote-adapter.md` for the captured responses.
 *
 * Three things about this API drive the code below.
 *
 * 1. **Amounts are decimal strings.** `"outAmount":"258472072271"`. They go
 *    straight to `BigInt`. Nothing on that path may touch `Number`: a
 *    9-decimal mint above ~9M supply exceeds 2^53 and the loss is silent.
 *
 * 2. **`priceImpactPct` is a decimal FRACTION string**, e.g.
 *    `"0.0000358961947259951525246234"` for 3.59 bps. The frozen
 *    `Quote.priceImpactPct` holds a **percent**, and `guards.ts` multiplies it
 *    by 100 to reach bps. So the conversion is fraction -> bps (integer, away
 *    from zero) -> percent, and it happens exactly once, here.
 *
 * 3. **Odd route shapes must not withhold a quote.** Sells need quotes. An
 *    adapter that refuses a valid-but-strange response is a path to a stranded
 *    position, so anomalies are logged, counted, and the quote is returned.
 */

import type {
  AnomalyCounters,
  CacheCounters,
  QuoteAnomaly,
  QuoteError,
  QuoteRequest,
  QuoteSource,
} from '../core/quoteSource.js';
import type { Config } from '../core/config.js';
import type { Address, Quote, RouteStep, UnixMillis } from '../core/types.js';

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

interface WireSwapInfo {
  ammKey?: string;
  label?: string;
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  /** Removed from the live API; retained so a reappearance is detectable. */
  feeAmount?: string;
  feeMint?: string;
}

interface WireRoutePlanStep {
  swapInfo?: WireSwapInfo;
  percent?: number | null;
  bps?: number | null;
}

interface WireQuote {
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  otherAmountThreshold?: string;
  priceImpactPct?: string;
  routePlan?: WireRoutePlanStep[];
  platformFee?: { amount?: string; feeBps?: number } | null;
  contextSlot?: number;
}

interface WireError {
  error?: string;
  errorCode?: string;
}

/**
 * Error codes that mean "this pair cannot be traded", captured live:
 *   {"error":"No routes found","errorCode":"NO_ROUTES_FOUND"}
 *   {"error":"The token X is not tradable","errorCode":"TOKEN_NOT_TRADABLE"}
 *
 * Matched on `errorCode`, never on the message text. Anything else is an
 * `UPSTREAM_ERROR`: mistaking a transport failure for "no route exists" would
 * make a held token look like a honeypot, or — worse — the reverse.
 */
const NO_ROUTE_CODES = new Set(['NO_ROUTES_FOUND', 'TOKEN_NOT_TRADABLE']);

// ---------------------------------------------------------------------------
// priceImpactPct conversion
// ---------------------------------------------------------------------------

const PLAIN_DECIMAL = /^-?\d*(?:\.\d+)?$/;

/**
 * Exact decimal-string fraction to integer bps, rounded **away from zero**.
 *
 * String arithmetic, not float: the API returns up to 28 decimal places, and
 * `Number("0.0000358961947259951525246234") * 10000` is not the value we want
 * to round. Away from zero so impact is never understated — an understated
 * impact is one the guard layer would wave through.
 *
 *   "0" -> 0   "0.0001" -> 1   "0.00005" -> 1   "0.25" -> 2500   "1" -> 10000
 */
export function fractionStringToBps(raw: string): number {
  const text = raw.trim();
  if (!PLAIN_DECIMAL.test(text) || text === '' || text === '-') {
    throw new RangeError(`unparseable price impact: ${raw}`);
  }

  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const [whole = '', fraction = ''] = body.split('.');

  // Shift the decimal point four places: fraction * 10_000 = bps.
  const shifted = (fraction + '0000').slice(0, 4);
  const remainder = fraction.slice(4);

  let bps = BigInt(whole === '' ? '0' : whole) * 10_000n + BigInt(shifted);
  // Any non-zero digit past the 4th place rounds the magnitude up.
  if (/[1-9]/.test(remainder)) bps += 1n;

  return Number(negative ? -bps : bps);
}

/**
 * Integer bps to the percent the frozen `Quote.priceImpactPct` holds.
 *
 * `guards.ts` recovers bps with `percent * 100`. That round trip is not exact
 * in IEEE754 — `2.99 * 100` is `298.99999999999994` — but the residue is ~1e-13
 * against a 1 bps granularity, so it cannot move a decision across an integer
 * threshold. Pinned by test across 295..305 bps rather than argued.
 */
export function bpsToPercent(bps: number): number {
  return bps / 100;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  /** Present for a successful quote; absent for a cached NO_ROUTE. */
  quote?: Quote;
  noRoute?: QuoteError;
  expiresAt: UnixMillis;
}

function cacheKey(request: QuoteRequest): string {
  // swapMode is fixed to ExactIn by this adapter but is part of the key so a
  // future ExactOut path cannot collide with an ExactIn entry.
  return [
    request.inMint,
    request.outMint,
    request.inAmount.toString(),
    request.slippageBps,
    'ExactIn',
  ].join('|');
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface JupiterLogger {
  error(fields: Record<string, unknown>, message: string): void;
}

export interface JupiterDeps {
  config: Config;
  /** Set to use the paid host and send `x-api-key`. Never logged. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  now?: () => UnixMillis;
  sleep?: (ms: number) => Promise<void>;
  logger?: JupiterLogger;
}

/**
 * `QuoteSource` plus the extras only this adapter provides.
 *
 * A superset, deliberately: the paper broker depends on the narrow
 * `QuoteSource` and must not widen when a richer client is injected.
 */
export interface JupiterQuoteSource extends QuoteSource {
  getPriceLamportsPerToken(mint: Address, decimals: number): Promise<bigint | QuoteError>;
  cacheStats(): CacheCounters;
  anomalyStats(): AnomalyCounters;
}

const EMPTY_ANOMALIES: AnomalyCounters = {
  PLATFORM_FEE_PRESENT: 0,
  ROUTE_FEE_PRESENT: 0,
  OUT_AMOUNT_MISMATCH: 0,
  ROUTE_PERCENT_MISSING: 0,
  PRICE_IMPACT_UNPARSEABLE: 0,
};

export const PAID_BASE_URL = 'https://api.jup.ag/swap/v1';

export function createJupiterQuoteSource(deps: JupiterDeps): JupiterQuoteSource {
  const { config } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const logger = deps.logger ?? { error: () => undefined };

  const baseUrl = deps.apiKey !== undefined ? PAID_BASE_URL : config.jupiterBaseUrl;
  const cache = new Map<string, CacheEntry>();
  const cacheCounters: CacheCounters = { hits: 0, misses: 0, noRouteHits: 0 };
  const anomalies: Record<QuoteAnomaly, number> = { ...EMPTY_ANOMALIES };

  function raise(anomaly: QuoteAnomaly, fields: Record<string, unknown>, message: string): void {
    anomalies[anomaly] += 1;
    logger.error({ anomaly, ...fields }, message);
  }

  // -------------------------------------------------------------------------
  // Response mapping
  // -------------------------------------------------------------------------

  function toRouteStep(step: WireRoutePlanStep, index: number, outputMint: string): RouteStep {
    const info = step.swapInfo ?? {};

    // `percent` is nullable upstream and `bps` now sits beside it. Neither is
    // used by any calculation here — the out-amount invariant below is
    // percent-free by construction — but `RouteStep.percent` is required by the
    // frozen type, so a value has to be chosen.
    let percent: number;
    if (typeof step.percent === 'number') {
      percent = step.percent;
    } else if (typeof step.bps === 'number') {
      percent = step.bps / 100;
    } else {
      percent = 0;
      raise(
        'ROUTE_PERCENT_MISSING',
        { hop: index, ammKey: info.ammKey },
        'route leg carried neither percent nor bps; recorded as 0',
      );
    }

    // Jupiter removed feeAmount/feeMint precisely because outAmount is net of
    // them. If one ever comes back non-zero the cost model is understating
    // fees, so it is counted — but never allowed to withhold the quote.
    if (info.feeAmount !== undefined && info.feeAmount !== '0') {
      raise(
        'ROUTE_FEE_PRESENT',
        { hop: index, ammKey: info.ammKey, feeAmount: info.feeAmount },
        'route leg reported a fee; the cost model assumes outAmount is already net',
      );
    }

    return {
      ammKey: info.ammKey ?? '',
      // Cosmetic; used only in logs and the UI.
      label: info.label ?? 'unknown',
      inMint: info.inputMint ?? '',
      outMint: info.outputMint ?? outputMint,
      inAmount: BigInt(info.inAmount ?? '0'),
      outAmount: BigInt(info.outAmount ?? '0'),
      // Always 0n: the field is required by the frozen RouteStep but no longer
      // exists upstream.
      feeAmount: 0n,
      percent,
    };
  }

  function toQuote(wire: WireQuote, request: QuoteRequest): Quote {
    const outAmount = BigInt(wire.outAmount ?? '0');
    const outputMint = wire.outputMint ?? request.outMint;

    let priceImpactPercent: number;
    try {
      priceImpactPercent = bpsToPercent(fractionStringToBps(wire.priceImpactPct ?? '0'));
    } catch {
      // Fail safe rather than open: maximum impact blocks entries at the guard
      // layer while leaving the quote usable for an exit, which never checks it.
      priceImpactPercent = 100;
      raise(
        'PRICE_IMPACT_UNPARSEABLE',
        { raw: wire.priceImpactPct },
        'could not parse priceImpactPct; treating as 100% impact',
      );
    }

    const routePlan = (wire.routePlan ?? []).map((step, index) =>
      toRouteStep(step, index, outputMint),
    );

    // outAmount must equal the sum of the legs that produce the output mint.
    // This holds for a single hop, for a parallel split (verified live: three
    // legs at 76/23/1 summed exactly to the total), and for sequential
    // multi-hop, where only the final leg produces the output mint.
    const producing = routePlan.filter((step) => step.outMint === outputMint);
    if (producing.length > 0) {
      const summed = producing.reduce((total, step) => total + step.outAmount, 0n);
      if (summed !== outAmount) {
        raise(
          'OUT_AMOUNT_MISMATCH',
          { outAmount: outAmount.toString(), summed: summed.toString(), legs: producing.length },
          'top-level outAmount does not equal the sum of producing legs',
        );
      }
    }

    const platformFee = wire.platformFee;
    if (platformFee != null && platformFee.amount !== undefined && BigInt(platformFee.amount) > 0n) {
      // We never send platformFeeBps or feeAccount, so this should be
      // impossible. `Quote` has no field for it, so the cost would go
      // unmodelled and overstate paper P&L.
      raise(
        'PLATFORM_FEE_PRESENT',
        { amount: platformFee.amount, feeBps: platformFee.feeBps },
        'platform fee reported but unrepresentable in Quote; paper P&L will overstate',
      );
    }

    return {
      inMint: wire.inputMint ?? request.inMint,
      outMint: outputMint,
      inAmount: BigInt(wire.inAmount ?? request.inAmount.toString()),
      outAmount,
      priceImpactPct: priceImpactPercent,
      routePlan,
      fetchedAt: now(),
    };
  }

  // -------------------------------------------------------------------------
  // Fetching
  // -------------------------------------------------------------------------

  function buildUrl(request: QuoteRequest): string {
    const url = new URL(`${baseUrl.replace(/\/$/, '')}/quote`);
    url.searchParams.set('inputMint', request.inMint);
    url.searchParams.set('outputMint', request.outMint);
    // Base units of the INPUT mint.
    url.searchParams.set('amount', request.inAmount.toString());
    url.searchParams.set('slippageBps', String(request.slippageBps));
    url.searchParams.set('swapMode', 'ExactIn');
    url.searchParams.set(
      'restrictIntermediateTokens',
      String(config.jupiterRestrictIntermediateTokens),
    );
    return url.toString();
  }

  function retryAfterMs(response: Response): number | undefined {
    const header = response.headers.get('retry-after');
    if (header === null) return undefined;
    const seconds = Number(header);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
  }

  /** One HTTP attempt. Never throws; returns a discriminated outcome. */
  async function attempt(
    request: QuoteRequest,
    remainingMs: number,
  ): Promise<
    | { kind: 'quote'; wire: WireQuote }
    | { kind: 'noRoute'; body: WireError }
    | { kind: 'retryable'; status: number; retryAfterMs?: number }
    | { kind: 'fatal'; error: QuoteError }
  > {
    const controller = new AbortController();
    const budget = Math.min(config.quoteTimeoutMs, remainingMs);
    const timer = setTimeout(() => controller.abort(), budget);

    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      // The key is sent, never logged, and never placed in the URL.
      if (deps.apiKey !== undefined) headers['x-api-key'] = deps.apiKey;

      const response = await fetchImpl(buildUrl(request), {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (response.ok) {
        return { kind: 'quote', wire: (await response.json()) as WireQuote };
      }

      if (response.status === 429 || response.status >= 500) {
        const after = retryAfterMs(response);
        return after === undefined
          ? { kind: 'retryable', status: response.status }
          : { kind: 'retryable', status: response.status, retryAfterMs: after };
      }

      if (response.status >= 400) {
        const body = (await response.json().catch(() => ({}))) as WireError;
        if (body.errorCode !== undefined && NO_ROUTE_CODES.has(body.errorCode)) {
          return { kind: 'noRoute', body };
        }
        return {
          kind: 'fatal',
          error: {
            error: 'UPSTREAM_ERROR',
            message: `HTTP ${response.status}: ${body.errorCode ?? body.error ?? 'unknown'}`,
          },
        };
      }

      return {
        kind: 'fatal',
        error: { error: 'UPSTREAM_ERROR', message: `unexpected HTTP ${response.status}` },
      };
    } catch (cause) {
      const aborted = (cause as Error).name === 'AbortError';
      return {
        kind: 'fatal',
        error: aborted
          ? { error: 'TIMEOUT', message: `no response within ${budget}ms` }
          : { error: 'UPSTREAM_ERROR', message: (cause as Error).message },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchQuote(request: QuoteRequest): Promise<Quote | QuoteError> {
    const deadline = now() + config.quoteTotalDeadlineMs;
    let lastRetryable: { status: number } | undefined;

    for (let tries = 0; tries < 3; tries += 1) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        return {
          error: 'TIMEOUT',
          message: `total deadline of ${config.quoteTotalDeadlineMs}ms exhausted`,
        };
      }

      const outcome = await attempt(request, remaining);

      if (outcome.kind === 'quote') return toQuote(outcome.wire, request);
      if (outcome.kind === 'noRoute') {
        return {
          error: 'NO_ROUTE',
          message: outcome.body.errorCode ?? 'no route',
        };
      }
      if (outcome.kind === 'fatal') {
        // A timeout on one attempt is still worth retrying inside the budget.
        if (outcome.error.error !== 'TIMEOUT') return outcome.error;
        lastRetryable = { status: 0 };
      } else {
        lastRetryable = { status: outcome.status };
      }

      const isLastAttempt = tries === 2;
      if (isLastAttempt) break;

      // Exponential backoff, honouring Retry-After when given, and never
      // sleeping past the caller's total budget.
      const backoff = 250 * 2 ** tries;
      const suggested = outcome.kind === 'retryable' ? outcome.retryAfterMs : undefined;
      const delay = Math.max(backoff, suggested ?? 0);
      const left = deadline - now();
      if (delay >= left) {
        return {
          error: 'TIMEOUT',
          message: `total deadline of ${config.quoteTotalDeadlineMs}ms exhausted during backoff`,
        };
      }
      await sleep(delay);
    }

    return {
      error: 'UPSTREAM_ERROR',
      message: `gave up after 3 attempts (last status ${lastRetryable?.status ?? 'unknown'})`,
    };
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  async function getQuote(request: QuoteRequest): Promise<Quote | QuoteError> {
    const key = cacheKey(request);
    const cached = cache.get(key);
    const at = now();

    if (cached !== undefined && cached.expiresAt > at) {
      cacheCounters.hits += 1;
      if (cached.noRoute !== undefined) {
        cacheCounters.noRouteHits += 1;
        return cached.noRoute;
      }
      // The ORIGINAL fetchedAt is preserved. The paper broker's latency model
      // reads this timestamp; refreshing it here would make a stale quote look
      // fresh and understate the cost of being late.
      return cached.quote as Quote;
    }

    cacheCounters.misses += 1;
    const result = await fetchQuote(request);

    if (!('error' in result)) {
      cache.set(key, { quote: result, expiresAt: at + config.quoteCacheTtlMs });
    } else if (result.error === 'NO_ROUTE') {
      // Shorter TTL: a freshly launched mint becomes routable within seconds.
      cache.set(key, { noRoute: result, expiresAt: at + config.noRouteCacheTtlMs });
    }
    // Transport failures are never cached — retrying immediately is correct.

    return result;
  }

  return {
    getQuote,

    /**
     * Price from a real probe quote, in lamports per WHOLE token.
     *
     * Derived from routable liquidity rather than an oracle. Integer math
     * throughout, **rounded down**: the price is used to mark positions, and a
     * rounded-down mark understates unrealized gains rather than overstating
     * them.
     */
    async getPriceLamportsPerToken(mint, decimals) {
      const probe = BigInt(config.priceProbeLamports);
      const result = await getQuote({
        inMint: 'So11111111111111111111111111111111111111112',
        outMint: mint,
        inAmount: probe,
        slippageBps: config.maxSlippageBps,
      });

      if ('error' in result) return result;
      if (result.outAmount <= 0n) {
        return { error: 'NO_ROUTE', message: 'probe returned zero output' };
      }

      // lamports per whole token = probeLamports * 10^decimals / outAmountBaseUnits
      return (probe * 10n ** BigInt(decimals)) / result.outAmount;
    },

    cacheStats: () => ({ ...cacheCounters }),
    anomalyStats: () => ({ ...anomalies }),
  };
}
