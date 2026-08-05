import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/core/config.js';
import type { Config } from '../src/core/config.js';
import { isQuoteError } from '../src/core/quoteSource.js';
import type { QuoteError, QuoteSource } from '../src/core/quoteSource.js';
import type { Quote } from '../src/core/types.js';
import {
  PAID_BASE_URL,
  bpsToPercent,
  createJupiterQuoteSource,
  fractionStringToBps,
} from '../src/adapters/jupiter.js';
import { createDecimalsResolver, fixtureDecimalsSource } from '../src/adapters/mintMetadata.js';
import { createPaperBroker } from '../src/adapters/paperBroker.js';
import { openLedger } from '../src/db/ledger.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDED = resolve(HERE, 'fixtures/jupiter');
const SYNTHETIC = resolve(HERE, 'fixtures/synthetic');

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

interface Fixture {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

function recorded(name: string): Fixture {
  return JSON.parse(readFileSync(join(RECORDED, `${name}.json`), 'utf8')) as Fixture;
}

function synthetic(name: string): Fixture {
  return JSON.parse(readFileSync(join(SYNTHETIC, `${name}.json`), 'utf8')) as Fixture;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A fetch that replays a queue of fixtures and records the URLs it was given. */
function stubFetch(queue: Fixture[]) {
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  let index = 0;

  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    urls.push(input.toString());
    headers.push((init?.headers ?? {}) as Record<string, string>);
    const fixture = queue[Math.min(index, queue.length - 1)];
    index += 1;
    if (fixture === undefined) throw new Error('stubFetch: queue empty');
    return new Response(JSON.stringify(fixture.body), {
      status: fixture.status,
      headers: fixture.headers ?? {},
    });
  }) as unknown as typeof fetch;

  return { impl, urls, headers, calls: () => index };
}

function client(
  queue: Fixture[],
  overrides: Partial<Config> = {},
  extra: { apiKey?: string; clock?: { now: number }; sleeps?: number[] } = {},
) {
  const fetchStub = stubFetch(queue);
  const clock = extra.clock ?? { now: 1_700_000_000_000 };
  const sleeps = extra.sleeps ?? [];
  const config = parseConfig(overrides);

  const source = createJupiterQuoteSource({
    config,
    ...(extra.apiKey === undefined ? {} : { apiKey: extra.apiKey }),
    fetchImpl: fetchStub.impl,
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
    },
  });

  return { source, fetchStub, clock, sleeps, config };
}

const request = { inMint: SOL, outMint: USDC, inAmount: 100_000_000n, slippageBps: 50 };

// ---------------------------------------------------------------------------
// priceImpactPct: stage one — fraction string to integer bps
// ---------------------------------------------------------------------------

describe('fractionStringToBps', () => {
  // The table from the prompt, pinned at the stage where it is correct.
  it.each([
    ['0', 0],
    ['0.0001', 1],
    ['0.00005', 1], // rounds away from zero
    ['0.25', 2500],
    ['1', 10000],
  ])('converts %s to %i bps', (input, expected) => {
    expect(fractionStringToBps(input)).toBe(expected);
  });

  it('rounds away from zero on the smallest possible residue', () => {
    // 0.000010001 * 10000 = 0.10001 bps, which rounds up to 1.
    expect(fractionStringToBps('0.000010001')).toBe(1);
    expect(fractionStringToBps('0.00000000001')).toBe(1);
  });

  it('never understates: output bps >= exact value', () => {
    for (const raw of ['0.12345678', '0.999999999', '0.00019999']) {
      const exact = Number(raw) * 10_000;
      expect(fractionStringToBps(raw)).toBeGreaterThanOrEqual(exact);
    }
  });

  it('handles the full 28-place precision the API actually returns', () => {
    // Captured live.
    expect(fractionStringToBps('0.0000358961947259951525246234')).toBe(1);
    expect(fractionStringToBps('0.9998906287176604337406947647')).toBe(9999);
  });

  it('does not lose precision through a float intermediate', () => {
    // Number("0.1234567890123456789") * 10000 drifts; string math does not.
    expect(fractionStringToBps('0.1234000000000000000000000001')).toBe(1235);
  });

  it('rejects what it cannot parse rather than guessing', () => {
    expect(() => fractionStringToBps('1e-7')).toThrow(RangeError);
    expect(() => fractionStringToBps('abc')).toThrow(RangeError);
    expect(() => fractionStringToBps('')).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// priceImpactPct: stage two — bps to the percent the frozen field holds
// ---------------------------------------------------------------------------

describe('bpsToPercent', () => {
  it.each([
    [0, 0],
    [1, 0.01],
    [2500, 25],
    [10000, 100],
  ])('converts %i bps to %f percent', (bps, expected) => {
    expect(bpsToPercent(bps)).toBe(expected);
  });

  /**
   * The float round trip guards performs. `bpsToPercent` divides by 100 and
   * `guards.ts` multiplies by 100, and IEEE754 does not round-trip that
   * cleanly — 2.99 * 100 is 298.99999999999994. The claim is that the residue
   * is ~1e-13 against 1 bps of granularity and so cannot move a decision.
   * Asserted here rather than argued, across the whole boundary region.
   */
  it('survives the guards round trip across 295..305 bps at a 300 bps limit', () => {
    const limit = 300;
    for (let trueBps = 295; trueBps <= 305; trueBps += 1) {
      const percent = bpsToPercent(trueBps);
      // Exactly what guards.ts:282 computes.
      const recoveredBps = percent * 100;
      const rejected = recoveredBps > limit;

      // The decision must match the one made on the exact integer.
      expect(rejected, `true ${trueBps} bps recovered as ${recoveredBps}`).toBe(trueBps > limit);
      // And the residue must stay far below one bps.
      expect(Math.abs(recoveredBps - trueBps)).toBeLessThan(1e-9);
    }
  });

  it('accepts exactly at the limit, where > already permits', () => {
    expect(bpsToPercent(300) * 100 > 300).toBe(false);
    expect(bpsToPercent(301) * 100 > 300).toBe(true);
  });

  it('walks the whole path: fraction string -> percent -> guards decision', () => {
    const cases: Array<[string, number, boolean]> = [
      ['0.0295', 295, false],
      ['0.0299', 299, false],
      ['0.03', 300, false], // exactly at the limit: permitted
      ['0.029901', 300, false], // rounds up to 300, still permitted
      ['0.030001', 301, true], // rounds up past the limit: rejected
      ['0.0305', 305, true],
    ];
    for (const [raw, expectedBps, expectedReject] of cases) {
      const bps = fractionStringToBps(raw);
      expect(bps, raw).toBe(expectedBps);
      expect(bpsToPercent(bps) * 100 > 300, raw).toBe(expectedReject);
    }
  });
});

// ---------------------------------------------------------------------------
// Parsing recorded responses
// ---------------------------------------------------------------------------

describe('recorded fixtures', () => {
  it('parses a single-hop quote entirely as bigint', async () => {
    const { source } = client([recorded('quote-single-hop-sol-usdc')]);
    const result = await source.getQuote(request);

    expect(isQuoteError(result)).toBe(false);
    const quote = result as Quote;
    expect(typeof quote.inAmount).toBe('bigint');
    expect(typeof quote.outAmount).toBe('bigint');
    expect(quote.outAmount).toBe(7_359_462n);
    expect(quote.routePlan).toHaveLength(1);
    expect(typeof quote.routePlan[0]?.inAmount).toBe('bigint');
  });

  it.each([
    'quote-single-hop-sol-usdc',
    'quote-split-route-sol-usdc',
    'quote-high-impact-thin',
  ])('%s: outAmount equals the sum of legs producing the output mint', async (name) => {
    const { source } = client([recorded(name)]);
    const result = (await source.getQuote(request)) as Quote;

    const producing = result.routePlan.filter((step) => step.outMint === result.outMint);
    const summed = producing.reduce((total, step) => total + step.outAmount, 0n);

    expect(summed).toBe(result.outAmount);
    // No anomaly was raised, which is the same claim from the other side.
    expect(source.anomalyStats().OUT_AMOUNT_MISMATCH).toBe(0);
  });

  it('handles a mixed route where not every leg produces the output mint', async () => {
    // quote-high-impact-thin is 4 hops of which only 3 produce the output —
    // a split with one two-hop branch. "the final hop's outAmount" would be
    // wrong here; the sum of producing legs is right.
    const { source } = client([recorded('quote-high-impact-thin')]);
    const quote = (await source.getQuote(request)) as Quote;
    const producing = quote.routePlan.filter((step) => step.outMint === quote.outMint);

    expect(quote.routePlan.length).toBeGreaterThan(producing.length);
    expect(producing.reduce((t, s) => t + s.outAmount, 0n)).toBe(quote.outAmount);
  });

  it('synthesizes feeAmount as 0n, since the API no longer reports it', async () => {
    const { source } = client([recorded('quote-split-route-sol-usdc')]);
    const quote = (await source.getQuote(request)) as Quote;

    for (const step of quote.routePlan) expect(step.feeAmount).toBe(0n);
    expect(source.anomalyStats().ROUTE_FEE_PRESENT).toBe(0);
  });

  it('converts the recorded price impact into the frozen percent unit', async () => {
    const { source } = client([recorded('quote-split-route-sol-usdc')]);
    const quote = (await source.getQuote(request)) as Quote;
    // Recorded "0.9998903062..." — a fraction, so 9999 bps, so 99.99 percent.
    expect(quote.priceImpactPct).toBeCloseTo(99.99, 6);
    expect(quote.priceImpactPct * 100).toBeGreaterThan(300);
  });
});

// ---------------------------------------------------------------------------
// bigint boundary
// ---------------------------------------------------------------------------

describe('amounts above 2^53', () => {
  it('round-trips an outAmount that float parsing would corrupt', async () => {
    const { source } = client([synthetic('quote-outamount-over-2p53')]);
    const quote = (await source.getQuote(request)) as Quote;

    expect(quote.outAmount).toBe(10_000_000_000_000_001n);
    expect(quote.outAmount).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));

    // The exact failure this guards against: Number() silently drops the 1.
    expect(Number('10000000000000001')).toBe(10_000_000_000_000_000);
    expect(BigInt(quote.outAmount)).not.toBe(BigInt(Number('10000000000000001')));
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe('error mapping', () => {
  it('maps NO_ROUTES_FOUND to a NO_ROUTE value, not a throw', async () => {
    const { source } = client([recorded('error-no-routes-found')]);
    const result = await source.getQuote(request);

    expect(isQuoteError(result)).toBe(true);
    expect((result as QuoteError).error).toBe('NO_ROUTE');
  });

  it('maps TOKEN_NOT_TRADABLE to NO_ROUTE as well', async () => {
    const { source } = client([recorded('error-token-not-tradable')]);
    expect(((await source.getQuote(request)) as QuoteError).error).toBe('NO_ROUTE');
  });

  it('does NOT map an unrecognised 400 to NO_ROUTE', async () => {
    // Free tier rejects restrictIntermediateTokens=false with NOT_SUPPORTED.
    // Calling that "no route" would make a tradable token look like a honeypot.
    const { source } = client([recorded('error-not-supported-restrict-false')]);
    const result = (await source.getQuote(request)) as QuoteError;

    expect(result.error).toBe('UPSTREAM_ERROR');
    expect(result.error).not.toBe('NO_ROUTE');
  });

  it('never retries a non-retryable 4xx', async () => {
    const { source, fetchStub } = client([recorded('error-token-not-tradable')]);
    await source.getQuote(request);
    expect(fetchStub.calls()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Retry, backoff, deadline
// ---------------------------------------------------------------------------

describe('retry and deadline', () => {
  const rateLimited = synthetic('error-429-rate-limited');

  it('backs off exponentially and gives up after 3 attempts', async () => {
    const sleeps: number[] = [];
    const { source, fetchStub } = client([rateLimited, rateLimited, rateLimited], {}, { sleeps });

    const result = (await source.getQuote(request)) as QuoteError;

    expect(fetchStub.calls()).toBe(3);
    expect(result.error).toBe('UPSTREAM_ERROR');
    // Retry-After of 2s dominates the 250/500ms backoff.
    expect(sleeps).toEqual([2_000, 2_000]);
  });

  it('uses exponential backoff when no Retry-After is given', async () => {
    const sleeps: number[] = [];
    const plain = { status: 503, body: { error: 'upstream' } };
    const { source } = client([plain, plain, plain], {}, { sleeps });

    await source.getQuote(request);
    expect(sleeps).toEqual([250, 500]);
  });

  it('recovers if a retry succeeds', async () => {
    const { source, fetchStub } = client([rateLimited, recorded('quote-single-hop-sol-usdc')]);
    const result = await source.getQuote(request);

    expect(fetchStub.calls()).toBe(2);
    expect(isQuoteError(result)).toBe(false);
  });

  it('stops at the total deadline rather than the attempt count', async () => {
    const sleeps: number[] = [];
    const { source, fetchStub } = client(
      [rateLimited, rateLimited, rateLimited],
      // A budget smaller than the first Retry-After.
      { quoteTotalDeadlineMs: 1_000 },
      { sleeps },
    );

    const result = (await source.getQuote(request)) as QuoteError;

    expect(result.error).toBe('TIMEOUT');
    expect(result.message).toContain('deadline');
    // It refused to sleep past the caller's budget.
    expect(sleeps).toEqual([]);
    expect(fetchStub.calls()).toBe(1);
  });

  it('a caller can never block longer than its budget', async () => {
    const clock = { now: 1_700_000_000_000 };
    const start = clock.now;
    const { source } = client(
      [rateLimited, rateLimited, rateLimited],
      { quoteTotalDeadlineMs: 3_000 },
      { clock },
    );

    await source.getQuote(request);
    expect(clock.now - start).toBeLessThanOrEqual(3_000);
  });
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

describe('cache', () => {
  it('serves a second identical request without a second fetch', async () => {
    const { source, fetchStub } = client([recorded('quote-single-hop-sol-usdc')]);
    await source.getQuote(request);
    await source.getQuote(request);

    expect(fetchStub.calls()).toBe(1);
    expect(source.cacheStats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it('preserves the ORIGINAL fetchedAt on a hit', async () => {
    const clock = { now: 1_700_000_000_000 };
    const { source } = client([recorded('quote-single-hop-sol-usdc')], {}, { clock });

    const first = (await source.getQuote(request)) as Quote;
    clock.now += 1_000;
    const second = (await source.getQuote(request)) as Quote;

    // The paper broker's latency model reads this. Refreshing it would make a
    // one-second-old quote look brand new and understate the cost of lateness.
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(second.fetchedAt).not.toBe(clock.now);
  });

  it('holds at 1499ms and expires at 1501ms', async () => {
    const clock = { now: 1_700_000_000_000 };
    const { source, fetchStub } = client(
      [recorded('quote-single-hop-sol-usdc'), recorded('quote-single-hop-sol-usdc')],
      {},
      { clock },
    );

    await source.getQuote(request);
    clock.now += 1_499;
    await source.getQuote(request);
    expect(fetchStub.calls()).toBe(1);

    clock.now += 2; // now 1501ms past the original
    await source.getQuote(request);
    expect(fetchStub.calls()).toBe(2);
  });

  it('caches NO_ROUTE on a shorter TTL', async () => {
    const clock = { now: 1_700_000_000_000 };
    const { source, fetchStub } = client(
      [recorded('error-no-routes-found'), recorded('error-no-routes-found')],
      {},
      { clock },
    );

    await source.getQuote(request);
    clock.now += 499;
    await source.getQuote(request);
    expect(fetchStub.calls()).toBe(1);
    expect(source.cacheStats().noRouteHits).toBe(1);

    clock.now += 2; // 501ms: past the NO_ROUTE TTL but well inside 1500ms
    await source.getQuote(request);
    expect(fetchStub.calls()).toBe(2);
  });

  it('never caches a transport failure', async () => {
    const plain = { status: 503, body: { error: 'upstream' } };
    const { source, fetchStub } = client(
      [plain, plain, plain, plain, plain, plain],
      { quoteTotalDeadlineMs: 60_000 },
    );

    await source.getQuote(request);
    await source.getQuote(request);
    // Three attempts each time; nothing was reused.
    expect(fetchStub.calls()).toBe(6);
  });

  it('keys on every request field', async () => {
    const fixture = recorded('quote-single-hop-sol-usdc');
    const { source, fetchStub } = client([fixture, fixture, fixture]);

    await source.getQuote(request);
    await source.getQuote({ ...request, inAmount: 100_000_001n });
    await source.getQuote({ ...request, slippageBps: 51 });

    expect(fetchStub.calls()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

describe('request', () => {
  it('sends the amount in base units of the input mint', async () => {
    const { source, fetchStub } = client([recorded('quote-single-hop-sol-usdc')]);
    await source.getQuote({ ...request, inAmount: 123_456_789n });

    const url = new URL(fetchStub.urls[0] ?? '');
    expect(url.searchParams.get('amount')).toBe('123456789');
    expect(url.searchParams.get('inputMint')).toBe(SOL);
    expect(url.searchParams.get('swapMode')).toBe('ExactIn');
    expect(url.searchParams.get('restrictIntermediateTokens')).toBe('true');
  });

  it('uses the lite host and sends no key when none is configured', async () => {
    const { source, fetchStub } = client([recorded('quote-single-hop-sol-usdc')]);
    await source.getQuote(request);

    expect(fetchStub.urls[0]).toContain('lite-api.jup.ag');
    expect(fetchStub.headers[0]?.['x-api-key']).toBeUndefined();
  });

  it('switches host and sends the key when one is provided, and never in the URL', async () => {
    const { source, fetchStub } = client(
      [recorded('quote-single-hop-sol-usdc')],
      {},
      { apiKey: 'secret-key-value' },
    );
    await source.getQuote(request);

    expect(fetchStub.urls[0]).toContain(PAID_BASE_URL);
    expect(fetchStub.urls[0]).not.toContain('secret-key-value');
    expect(fetchStub.headers[0]?.['x-api-key']).toBe('secret-key-value');
  });
});

// ---------------------------------------------------------------------------
// Anomalies never withhold a quote
// ---------------------------------------------------------------------------

describe('anomalies', () => {
  function mutateFixture(mutate: (body: Record<string, unknown>) => void): Fixture {
    const fixture = recorded('quote-single-hop-sol-usdc');
    const body = structuredClone(fixture.body) as Record<string, unknown>;
    mutate(body);
    return { status: 200, body };
  }

  it('returns the quote when a platform fee appears, and counts it', async () => {
    const { source } = client([
      mutateFixture((body) => {
        body['platformFee'] = { amount: '1234', feeBps: 10 };
      }),
    ]);

    const result = await source.getQuote(request);
    expect(isQuoteError(result)).toBe(false);
    expect(source.anomalyStats().PLATFORM_FEE_PRESENT).toBe(1);
  });

  it('accepts platformFee null and absent without counting anything', async () => {
    const nulled = mutateFixture((body) => {
      body['platformFee'] = null;
    });
    const absent = mutateFixture((body) => {
      delete body['platformFee'];
    });
    const { source } = client([nulled, absent]);

    await source.getQuote(request);
    await source.getQuote({ ...request, slippageBps: 51 });
    expect(source.anomalyStats().PLATFORM_FEE_PRESENT).toBe(0);
  });

  it('returns the quote when a route fee reappears, and counts it', async () => {
    const { source } = client([
      mutateFixture((body) => {
        const plan = body['routePlan'] as Array<{ swapInfo: Record<string, unknown> }>;
        plan[0]!.swapInfo['feeAmount'] = '999';
      }),
    ]);

    const result = await source.getQuote(request);
    expect(isQuoteError(result)).toBe(false);
    expect(source.anomalyStats().ROUTE_FEE_PRESENT).toBe(1);
  });

  it('returns the quote when the out-amount invariant breaks, and counts it', async () => {
    const { source } = client([
      mutateFixture((body) => {
        body['outAmount'] = '999999';
      }),
    ]);

    const result = await source.getQuote(request);
    expect(isQuoteError(result)).toBe(false);
    expect((result as Quote).outAmount).toBe(999_999n);
    expect(source.anomalyStats().OUT_AMOUNT_MISMATCH).toBe(1);
  });

  it('falls back for a missing percent and counts it, but keeps the quote', async () => {
    const { source } = client([
      mutateFixture((body) => {
        const plan = body['routePlan'] as Array<Record<string, unknown>>;
        plan[0]!['percent'] = null;
        plan[0]!['bps'] = null;
      }),
    ]);

    const quote = (await source.getQuote(request)) as Quote;
    expect(quote.routePlan[0]?.percent).toBe(0);
    expect(source.anomalyStats().ROUTE_PERCENT_MISSING).toBe(1);
  });

  it('derives percent from bps when only bps is present', async () => {
    const { source } = client([
      mutateFixture((body) => {
        const plan = body['routePlan'] as Array<Record<string, unknown>>;
        plan[0]!['percent'] = null;
        plan[0]!['bps'] = 10_000;
      }),
    ]);

    const quote = (await source.getQuote(request)) as Quote;
    expect(quote.routePlan[0]?.percent).toBe(100);
    expect(source.anomalyStats().ROUTE_PERCENT_MISSING).toBe(0);
  });

  it('falls back to a placeholder label without complaint', async () => {
    const { source } = client([
      mutateFixture((body) => {
        const plan = body['routePlan'] as Array<{ swapInfo: Record<string, unknown> }>;
        delete plan[0]!.swapInfo['label'];
      }),
    ]);

    const quote = (await source.getQuote(request)) as Quote;
    // Cosmetic: nothing computes on it.
    expect(quote.routePlan[0]?.label).toBe('unknown');
  });

  it('treats an unparseable price impact as maximum, blocking entries but not exits', async () => {
    const { source } = client([
      mutateFixture((body) => {
        body['priceImpactPct'] = 'not-a-number';
      }),
    ]);

    const quote = (await source.getQuote(request)) as Quote;
    expect(quote.priceImpactPct).toBe(100);
    // 100 percent is 10_000 bps, far above the 2_000 bps hard ceiling, so
    // every entry is blocked while exits (which never check impact) still work.
    expect(quote.priceImpactPct * 100).toBe(10_000);
    expect(quote.priceImpactPct * 100).toBeGreaterThan(2_000);
    expect(source.anomalyStats().PRICE_IMPACT_UNPARSEABLE).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Price
// ---------------------------------------------------------------------------

describe('getPriceLamportsPerToken', () => {
  it('derives lamports per whole token from a probe quote, rounded down', async () => {
    const { source } = client([recorded('quote-single-hop-sol-usdc')]);
    // Probe 0.1 SOL -> 7_359_462 base units of a 6-decimal mint.
    const price = await source.getPriceLamportsPerToken(USDC, 6);

    expect(typeof price).toBe('bigint');
    // 100_000_000 * 10^6 / 7_359_462, floored.
    expect(price).toBe((100_000_000n * 1_000_000n) / 7_359_462n);
    expect(price).toBe(13_587_949n);
  });

  it('returns NO_ROUTE as a value rather than throwing', async () => {
    const { source } = client([recorded('error-no-routes-found')]);
    const price = await source.getPriceLamportsPerToken(USDC, 6);

    expect(typeof price).not.toBe('bigint');
    expect((price as QuoteError).error).toBe('NO_ROUTE');
  });
});

// ---------------------------------------------------------------------------
// Integration with the paper broker
// ---------------------------------------------------------------------------

describe('paper broker over the real adapter', () => {
  function wire(queue: Fixture[]) {
    const ledger = openLedger({
      path: ':memory:',
      logger: { info: () => undefined, warn: () => undefined },
    });
    const { source, config } = client(queue);
    const broker = createPaperBroker({
      quoteSource: source as QuoteSource,
      resolveDecimals: createDecimalsResolver(fixtureDecimalsSource({ [USDC]: 6, [SOL]: 9 })),
      ledger,
      config,
      latencyMs: 0,
      now: () => 1_700_000_000_000,
    });
    return { broker, ledger, source };
  }

  it('executes a buy against a recorded quote, all bigint', async () => {
    const { broker, ledger } = wire([recorded('quote-single-hop-sol-usdc')]);
    try {
      const fill = await broker.execute({
        id: 'integration-buy',
        side: 'buy',
        mint: USDC,
        amountLamports: 100_000_000n,
        maxSlippageBps: 300,
        reason: 'integration',
      });

      expect(typeof fill.tokensDelta).toBe('bigint');
      expect(fill.decimals).toBe(6);
      // 7_359_462 less the 30 bps latency penalty, floored.
      expect(fill.tokensDelta).toBe((7_359_462n * 9_970n) / 10_000n);
      expect(ledger.getPosition(USDC)?.tokens).toBe(fill.tokensDelta);
    } finally {
      ledger.close();
    }
  });

  it('propagates NO_ROUTE through paperBroker.getQuote without throwing', async () => {
    const { broker, ledger } = wire([recorded('error-no-routes-found')]);
    try {
      // The Broker interface returns Promise<Quote>, so it converts to a throw
      // at that boundary — but the QuoteSource result was a value all the way.
      await expect(
        broker.getQuote({
          id: 'x',
          side: 'sell',
          mint: USDC,
          amountTokens: 1_000n,
          maxSlippageBps: 300,
          reason: 'exit',
        }),
      ).rejects.toMatchObject({ code: 'NO_ROUTE' });
    } finally {
      ledger.close();
    }
  });

  it('surfaces NO_ROUTE from the source as a value, not an exception', async () => {
    const { source } = wire([recorded('error-no-routes-found')]);
    const result = await source.getQuote(request);
    expect(isQuoteError(result)).toBe(true);
    expect((result as QuoteError).error).toBe('NO_ROUTE');
  });
});

// ---------------------------------------------------------------------------
// The suite is offline
// ---------------------------------------------------------------------------

describe('network isolation', () => {
  it('fails loudly if anything reaches for the global fetch', async () => {
    await expect(fetch('https://lite-api.jup.ag/swap/v1/quote')).rejects.toThrow(
      /Network access from a test/,
    );
  });
});
