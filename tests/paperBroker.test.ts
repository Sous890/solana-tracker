import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/core/config.js';
import type { Config } from '../src/core/config.js';
import { guarded } from '../src/core/guards.js';
import type { GuardDeps, GuardLogFields } from '../src/core/guards.js';
import { QuoteUnavailableError } from '../src/core/quoteSource.js';
import type { QuoteError, QuoteRequest, QuoteSource } from '../src/core/quoteSource.js';
import type { OrderIntent, Quote } from '../src/core/types.js';
import { WRAPPED_SOL_MINT, solToLamports } from '../src/core/units.js';
import { openLedger } from '../src/db/ledger.js';
import type { Ledger } from '../src/db/ledger.js';
import { createDecimalsResolver, fixtureDecimalsSource } from '../src/adapters/mintMetadata.js';
import {
  EmergencyExitIncompleteError,
  InsufficientBalanceError,
  SCREENER_NOT_IMPLEMENTED,
  createPaperBroker,
  txFeeLamports,
} from '../src/adapters/paperBroker.js';

/** 6-decimal mint. */
const MINT6 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** 9-decimal mint. */
const MINT9 = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const UNKNOWN_MINT = 'UnknownMint1111111111111111111111111111111';

const AT = 1_700_000_000_000;

const DECIMALS = fixtureDecimalsSource({ [MINT6]: 6, [MINT9]: 9, [WRAPPED_SOL_MINT]: 9 });

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Quote source driven by a table of `in -> out` responses. */
function stubQuotes(
  respond: (request: QuoteRequest) => bigint | QuoteError,
): QuoteSource & { requests: QuoteRequest[] } {
  const requests: QuoteRequest[] = [];
  return {
    requests,
    getQuote: async (request) => {
      requests.push(request);
      const result = respond(request);
      if (typeof result !== 'bigint') return result;
      const quote: Quote = {
        inMint: request.inMint,
        outMint: request.outMint,
        inAmount: request.inAmount,
        outAmount: result,
        priceImpactPct: 0.5,
        routePlan: [],
        fetchedAt: AT,
      };
      return quote;
    },
  };
}

interface Harness {
  broker: ReturnType<typeof createPaperBroker>;
  ledger: Ledger;
  config: Config;
  quotes: ReturnType<typeof stubQuotes>;
  close(): void;
}

function harness(
  respond: (request: QuoteRequest) => bigint | QuoteError,
  overrides: Partial<Config> = {},
): Harness {
  const ledger = openLedger({
    path: ':memory:',
    logger: { info: () => undefined, warn: () => undefined },
  });
  const config = parseConfig(overrides);
  const quotes = stubQuotes(respond);
  let clock = AT;

  const broker = createPaperBroker({
    quoteSource: quotes,
    resolveDecimals: createDecimalsResolver(DECIMALS),
    ledger,
    config,
    latencyMs: 0,
    now: () => (clock += 1),
  });

  return { broker, ledger, config, quotes, close: () => ledger.close() };
}

function buy(mint: string, lamports: bigint, overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    id: `buy-${mint}-${lamports}`,
    side: 'buy',
    mint,
    amountLamports: lamports,
    maxSlippageBps: 300,
    reason: 'test entry',
    ...overrides,
  };
}

function sell(mint: string, tokens: bigint, overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    id: `sell-${mint}-${tokens}`,
    side: 'sell',
    mint,
    amountTokens: tokens,
    maxSlippageBps: 300,
    reason: 'test exit',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fee model
// ---------------------------------------------------------------------------

describe('transaction fees', () => {
  it('prices the priority fee per compute unit and adds the base signature fee', () => {
    const config = parseConfig({ priorityFeeMicroLamports: 200_000, computeUnitLimit: 400_000 });
    // 200_000 µlamports/CU * 400_000 CU / 1e6 = 80_000 lamports, + 5_000 base.
    expect(txFeeLamports(config)).toBe(85_000n);
  });

  it('rounds a fractional lamport of priority fee up, against the bot', () => {
    const config = parseConfig({ priorityFeeMicroLamports: 1, computeUnitLimit: 1 });
    // 1 * 1 / 1e6 = 0.000001 lamports, which must cost 1, not 0.
    expect(txFeeLamports(config)).toBe(1n + 5_000n);
  });

  it('still charges the base fee when the priority fee is zero', () => {
    expect(txFeeLamports(parseConfig({ priorityFeeMicroLamports: 0 }))).toBe(5_000n);
  });
});

// ---------------------------------------------------------------------------
// Exact conservation
// ---------------------------------------------------------------------------

describe('lamport conservation', () => {
  it('accounts for every lamport across a buy then a full sell', async () => {
    // Amounts chosen so the penalty does not divide evenly.
    const h = harness((request) =>
      request.inMint === WRAPPED_SOL_MINT ? 333_333_333_331n : 61_111_111n,
    );
    try {
      const start = solToLamports(h.config.paperStartingSol);
      const fees = txFeeLamports(h.config);
      const spend = 50_000_001n;

      const buyFill = await h.broker.execute(buy(MINT6, spend));
      const afterBuy = await h.broker.getBalanceLamports();
      expect(afterBuy).toBe(start - spend - fees);

      const sellFill = await h.broker.execute(sell(MINT6, buyFill.tokensDelta));
      const afterSell = await h.broker.getBalanceLamports();

      // Exact, to the lamport: nothing is approximate here.
      expect(afterSell).toBe(start - spend - fees + sellFill.lamportsDelta - fees);

      // And the ledger agrees, independently.
      const net = h.ledger.getNetLamportsFlow({ simulated: true });
      expect(net).toBe(buyFill.lamportsDelta - fees + sellFill.lamportsDelta - fees);
      expect(start + net).toBe(afterSell);

      // The position closed exactly, with no dust.
      expect(h.ledger.getPosition(MINT6)?.tokens).toBe(0n);
      expect(h.ledger.getPosition(MINT6)?.state).toBe('closed');
    } finally {
      h.close();
    }
  });

  it('never lets the simulated balance go negative', async () => {
    const h = harness(() => 1_000_000_000n, { paperStartingSol: 0.01 });
    try {
      // 0.01 SOL of balance cannot fund a 5 SOL buy plus fees.
      await expect(h.broker.execute(buy(MINT6, 5_000_000_000n))).rejects.toThrow(
        InsufficientBalanceError,
      );
      expect(await h.broker.getBalanceLamports()).toBe(solToLamports(0.01));
      expect(await h.broker.getBalanceLamports()).toBeGreaterThanOrEqual(0n);
    } finally {
      h.close();
    }
  });

  it('refuses a sell whose proceeds cannot cover the fee', async () => {
    // Proceeds of 1 lamport against an 85,000 lamport fee, from a zero balance.
    const h = harness(() => 1n, { paperStartingSol: 0.00001 });
    try {
      await expect(h.broker.execute(sell(MINT6, 1_000_000n))).rejects.toThrow(
        InsufficientBalanceError,
      );
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The cost model
// ---------------------------------------------------------------------------

describe('cost model', () => {
  it('applies the latency penalty to what a buy receives, floored', async () => {
    const h = harness(() => 333_333_333_331n, { paperLatencyPenaltyBps: 30 });
    try {
      const fill = await h.broker.execute(buy(MINT6, 50_000_000n));
      // 333_333_333_331 * 9970 / 10000, floored.
      expect(fill.tokensDelta).toBe((333_333_333_331n * 9_970n) / 10_000n);
      expect(fill.tokensDelta).toBe(332_333_333_331n);
      // Floor, not round: the exact quotient ends .0007, and rounding up would
      // hand the bot a base unit it did not receive.
      expect(fill.tokensDelta * 10_000n).toBeLessThanOrEqual(333_333_333_331n * 9_970n);
    } finally {
      h.close();
    }
  });

  it('applies the latency penalty to what a sell receives, floored', async () => {
    const h = harness(() => 61_111_111n, { paperLatencyPenaltyBps: 30 });
    try {
      const fill = await h.broker.execute(sell(MINT6, 1_000_000n));
      expect(fill.lamportsDelta).toBe((61_111_111n * 9_970n) / 10_000n);
      expect(fill.lamportsDelta).toBe(60_927_777n);
    } finally {
      h.close();
    }
  });

  it('defaults to a 30 bps penalty and applies exactly that', async () => {
    // Every other cost-model test passes the penalty explicitly, which leaves
    // the *default* untested — change it to 300 and nothing here would notice.
    const h = harness(() => 61_111_111n);
    try {
      expect(h.config.paperLatencyPenaltyBps).toBe(30);
      const fill = await h.broker.execute(sell(MINT6, 1_000_000n));
      expect(fill.lamportsDelta).toBe((61_111_111n * 9_970n) / 10_000n);
      expect(fill.lamportsDelta).toBe(60_927_777n);
    } finally {
      h.close();
    }
  });

  it('defaults the compute budget to 400k CU, making a swap cost 85k lamports', async () => {
    const h = harness(() => 61_111_111n);
    try {
      expect(h.config.computeUnitLimit).toBe(400_000);
      const fill = await h.broker.execute(sell(MINT6, 1_000_000n));
      expect(fill.feesLamports).toBe(85_000n);
    } finally {
      h.close();
    }
  });

  it('measurably reduces proceeds as the penalty rises', async () => {
    const quoted = 61_111_111n;
    const results: bigint[] = [];
    for (const penalty of [0, 30, 300]) {
      const h = harness(() => quoted, { paperLatencyPenaltyBps: penalty });
      try {
        const fill = await h.broker.execute(sell(MINT6, 1_000_000n));
        results.push(fill.lamportsDelta);
      } finally {
        h.close();
      }
    }

    const [none, small, large] = results as [bigint, bigint, bigint];
    expect(none).toBe(quoted);
    expect(small).toBeLessThan(none);
    expect(large).toBeLessThan(small);
    // 30 bps is 0.3%; 300 bps is 3%. Pin the magnitudes, not just the ordering.
    expect(none - small).toBe(183_334n);
    expect(none - large).toBe(1_833_334n);
  });

  it('measurably reduces the balance as fees rise', async () => {
    const cheap = harness(() => 1_000_000_000n, { priorityFeeMicroLamports: 0 });
    const dear = harness(() => 1_000_000_000n, { priorityFeeMicroLamports: 200_000 });
    try {
      await cheap.broker.execute(buy(MINT6, 50_000_000n));
      await dear.broker.execute(buy(MINT6, 50_000_000n));

      const cheapBalance = await cheap.broker.getBalanceLamports();
      const dearBalance = await dear.broker.getBalanceLamports();

      expect(dearBalance).toBeLessThan(cheapBalance);
      // 200_000 µlamports * 400_000 CU / 1e6 = exactly 80_000 lamports more.
      expect(cheapBalance - dearBalance).toBe(80_000n);
    } finally {
      cheap.close();
      dear.close();
    }
  });

  it('records the measured shortfall as slippage, not the configured number', async () => {
    const h = harness(() => 61_111_111n, { paperLatencyPenaltyBps: 30 });
    try {
      const fill = await h.broker.execute(sell(MINT6, 1_000_000n));
      // Derived from the integers: (quoted - received) * 10000 / quoted.
      // Note it is >= the configured 30, never below: flooring what the bot
      // receives makes the realized shortfall marginally worse than the knob.
      expect(fill.slippageBps).toBe(30);
      expect(fill.slippageBps).toBeGreaterThanOrEqual(h.config.paperLatencyPenaltyBps);
      expect(fill.slippageBps).not.toBeNull();
    } finally {
      h.close();
    }
  });

  it('does not subtract route fees, which the quote already nets out', async () => {
    const h = harness(() => 61_111_111n, { paperLatencyPenaltyBps: 0, priorityFeeMicroLamports: 0 });
    try {
      const fill = await h.broker.execute(sell(MINT6, 1_000_000n));
      // outAmount passes through untouched when no penalty applies.
      expect(fill.lamportsDelta).toBe(61_111_111n);
      expect(fill.feesLamports).toBe(5_000n);
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Decimals
// ---------------------------------------------------------------------------

describe('decimals', () => {
  it('round-trips a 6-decimal mint with amounts that do not divide evenly', async () => {
    const h = harness((request) =>
      request.inMint === WRAPPED_SOL_MINT ? 777_777_777_777n : 49_999_999n,
    );
    try {
      const buyFill = await h.broker.execute(buy(MINT6, 50_000_003n));
      expect(buyFill.decimals).toBe(6);
      expect(buyFill.tokensDelta).toBe((777_777_777_777n * 9_970n) / 10_000n);

      const sellFill = await h.broker.execute(sell(MINT6, buyFill.tokensDelta));
      expect(h.ledger.getPosition(MINT6)?.tokens).toBe(0n);
      expect(sellFill.lamportsDelta).toBe((49_999_999n * 9_970n) / 10_000n);
    } finally {
      h.close();
    }
  });

  it('round-trips a 9-decimal mint with amounts that do not divide evenly', async () => {
    const h = harness((request) =>
      request.inMint === WRAPPED_SOL_MINT ? 123_456_789_012_345n : 50_000_001n,
    );
    try {
      const buyFill = await h.broker.execute(buy(MINT9, 50_000_003n));
      expect(buyFill.decimals).toBe(9);
      expect(buyFill.tokensDelta).toBe((123_456_789_012_345n * 9_970n) / 10_000n);

      const sellFill = await h.broker.execute(sell(MINT9, buyFill.tokensDelta));
      expect(h.ledger.getPosition(MINT9)?.tokens).toBe(0n);
      expect(sellFill.lamportsDelta).toBe((50_000_001n * 9_970n) / 10_000n);
    } finally {
      h.close();
    }
  });

  it('refuses a mint whose decimals cannot be resolved, rather than assuming 9', async () => {
    const h = harness(() => 1_000_000_000n);
    try {
      await expect(h.broker.execute(buy(UNKNOWN_MINT, 50_000_000n))).rejects.toThrow(
        /Refusing to assume a scale/,
      );
      // Nothing was recorded: no fill, no position.
      expect(h.ledger.getPosition(UNKNOWN_MINT)).toBeUndefined();
      expect(h.ledger.getIntentStatus(buy(UNKNOWN_MINT, 50_000_000n).id)).toBe('failed');
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// NO_ROUTE
// ---------------------------------------------------------------------------

describe('NO_ROUTE', () => {
  const noRoute: QuoteError = { error: 'NO_ROUTE', message: 'no route found' };

  it('surfaces rather than being swallowed on a held mint', async () => {
    const h = harness((request) =>
      request.inMint === WRAPPED_SOL_MINT ? 1_000_000_000n : noRoute,
    );
    try {
      // Enter successfully...
      const buyFill = await h.broker.execute(buy(MINT6, 50_000_000n));
      expect(h.ledger.getPosition(MINT6)?.tokens).toBe(buyFill.tokensDelta);

      // ...then find there is no way out.
      const attempt = h.broker.execute(sell(MINT6, buyFill.tokensDelta));
      await expect(attempt).rejects.toThrow(QuoteUnavailableError);
      await expect(attempt).rejects.toMatchObject({ code: 'NO_ROUTE' });

      // The position is still held. It has not been quietly marked closed.
      expect(h.ledger.getPosition(MINT6)?.tokens).toBe(buyFill.tokensDelta);
      expect(h.ledger.getPosition(MINT6)?.state).toBe('open');
    } finally {
      h.close();
    }
  });

  it('records the failed intent with its cause', async () => {
    const h = harness(() => noRoute);
    try {
      const intent = buy(MINT6, 50_000_000n);
      await expect(h.broker.execute(intent)).rejects.toThrow(QuoteUnavailableError);
      expect(h.ledger.getIntentStatus(intent.id)).toBe('failed');
    } finally {
      h.close();
    }
  });

  it('reports an unroutable position from emergencyExitAll instead of hiding it', async () => {
    let allowSell = true;
    const h = harness((request) => {
      if (request.inMint === WRAPPED_SOL_MINT) return 1_000_000_000n;
      return allowSell ? 60_000_000n : noRoute;
    });
    try {
      await h.broker.execute(buy(MINT6, 50_000_000n));
      await h.broker.execute(buy(MINT9, 50_000_000n));
      allowSell = false;

      const attempt = h.broker.emergencyExitAll();
      await expect(attempt).rejects.toThrow(EmergencyExitIncompleteError);
      await expect(attempt).rejects.toThrow(/still held/);
    } finally {
      h.close();
    }
  });

  it('exits what it can before reporting what it could not', async () => {
    const h = harness((request) => {
      if (request.inMint === WRAPPED_SOL_MINT) return 1_000_000_000n;
      return request.inMint === MINT6 ? 60_000_000n : noRoute;
    });
    try {
      await h.broker.execute(buy(MINT6, 50_000_000n));
      await h.broker.execute(buy(MINT9, 50_000_000n));

      await h.broker.emergencyExitAll().catch((error: unknown) => {
        expect(error).toBeInstanceOf(EmergencyExitIncompleteError);
        expect((error as EmergencyExitIncompleteError).completed).toHaveLength(1);
        expect((error as EmergencyExitIncompleteError).failures[0]?.mint).toBe(MINT9);
      });

      // The routable one really did exit; the other is still held.
      expect(h.ledger.getPosition(MINT6)?.state).toBe('closed');
      expect(h.ledger.getPosition(MINT9)?.state).toBe('open');
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Fill shape and intent recording
// ---------------------------------------------------------------------------

describe('fills', () => {
  it('is shaped like a live fill apart from `simulated`', async () => {
    const h = harness(() => 1_000_000_000n);
    try {
      const fill = await h.broker.execute(buy(MINT6, 50_000_000n));
      expect(fill.simulated).toBe(true);
      expect(Object.keys(fill).sort()).toEqual(
        [
          'at',
          'decimals',
          'feesLamports',
          'intentId',
          'lamportsDelta',
          'mint',
          'side',
          'simulated',
          'slippageBps',
          'tokensDelta',
        ].sort(),
      );
    } finally {
      h.close();
    }
  });

  it('records the intent before the fill, and resolves it after', async () => {
    const h = harness(() => 1_000_000_000n);
    try {
      const intent = buy(MINT6, 50_000_000n);
      await h.broker.execute(intent);
      expect(h.ledger.getIntentStatus(intent.id)).toBe('filled');
      expect(h.ledger.getFillsForIntent(intent.id)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('does not reset an intent the tracker already recorded', async () => {
    const h = harness(() => 1_000_000_000n);
    try {
      const intent = buy(MINT6, 50_000_000n);
      // The tracker writes it first, as it will from Prompt 9 onward.
      h.ledger.recordIntent(intent, AT);
      await h.broker.execute(intent);
      expect(h.ledger.getIntentStatus(intent.id)).toBe('filled');
    } finally {
      h.close();
    }
  });

  it('leaves live fills out of the paper balance', async () => {
    const h = harness(() => 1_000_000_000n);
    try {
      const before = await h.broker.getBalanceLamports();
      h.ledger.recordFill({
        intentId: 'live-one',
        side: 'buy',
        mint: MINT6,
        tokensDelta: 1_000_000n,
        lamportsDelta: -900_000_000n,
        decimals: 6,
        feesLamports: 5_000n,
        slippageBps: 10,
        simulated: false,
        signature: 'live-sig',
        at: AT,
      });
      // A real trade must not move the simulated wallet.
      expect(await h.broker.getBalanceLamports()).toBe(before);
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// canSell fails closed
// ---------------------------------------------------------------------------

describe('canSell stub', () => {
  it('answers no, with a reason distinct from a real screener refusal', async () => {
    const h = harness(() => 1_000_000_000n);
    try {
      expect(await h.broker.canSell(MINT6)).toEqual({
        ok: false,
        reason: SCREENER_NOT_IMPLEMENTED,
      });
    } finally {
      h.close();
    }
  });

  // The Prompt 5 tripwire test lived here. Prompt 8 landed the real screener,
  // so it was deleted deliberately, as it demanded. The stub remains the
  // DEFAULT when no screener is injected, and the test below still pins that.

  it('blocks a buy at the guard layer for exactly this reason', async () => {
    const h = harness(() => 1_000_000_000n);
    const logged: GuardLogFields[] = [];
    try {
      const deps: GuardDeps = {
        config: h.config,
        logger: { warn: (fields) => logged.push(fields) },
        getState: () => ({
          mode: 'paper',
          status: 'running',
          startedAt: AT,
          killSwitchEngaged: false,
        }),
        getRealizedLossLamportsToday: async () => 0n,
        getUnacknowledgedOrphanCount: async () => 0,
      };
      const guardedBroker = guarded(h.broker, deps);

      await expect(guardedBroker.execute(buy(MINT6, 50_000_000n))).rejects.toMatchObject({
        code: 'CANNOT_SELL',
        reason: SCREENER_NOT_IMPLEMENTED,
      });
      expect(logged[0]?.code).toBe('CANNOT_SELL');

      // Nothing executed: no fill, no position, no balance movement.
      expect(h.ledger.getPositions()).toHaveLength(0);
      expect(await h.broker.getBalanceLamports()).toBe(solToLamports(h.config.paperStartingSol));
    } finally {
      h.close();
    }
  });

  it('does not block a sell — exits stay available while the stub is in place', async () => {
    const h = harness(() => 1_000_000_000n);
    try {
      // canSell is only consulted on entry, so an exit is unaffected.
      const buyFill = await h.broker.execute(buy(MINT6, 50_000_000n));
      await expect(h.broker.execute(sell(MINT6, buyFill.tokensDelta))).resolves.toBeDefined();
    } finally {
      h.close();
    }
  });
});
