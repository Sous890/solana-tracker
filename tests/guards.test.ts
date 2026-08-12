import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Broker, CanSellResult } from '../src/core/broker.js';
import { parseConfig } from '../src/core/config.js';
import type { Config } from '../src/core/config.js';
import { GuardRejection, guarded, malformedIntentReason } from '../src/core/guards.js';
import type { GuardCode, GuardDeps, GuardLogFields } from '../src/core/guards.js';
import type { BotState, Fill, OrderIntent, Position, Quote } from '../src/core/types.js';

const MINT_A = 'So11111111111111111111111111111111111111112';
const MINT_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINT_C = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** 0.05 SOL, the default position size. */
const SIZE_LAMPORTS = 50_000_000n;

function buy(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    id: 'intent-1',
    side: 'buy',
    mint: MINT_A,
    amountLamports: SIZE_LAMPORTS,
    maxSlippageBps: 300,
    reason: 'test',
    ...overrides,
  };
}

function sell(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    id: 'intent-2',
    side: 'sell',
    mint: MINT_A,
    amountTokens: 1_000_000_000n,
    maxSlippageBps: 300,
    reason: 'test',
    ...overrides,
  };
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    mint: MINT_A,
    tokens: 1_000_000_000n,
    costLamports: 51_000_000n,
    decimals: 6,
    openedAt: 1_700_000_000_000,
    avgEntrySol: 0.000051,
    lastPriceSol: 0.00006,
    unrealizedSol: 0.009,
    state: 'open',
    ...overrides,
  };
}

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    inMint: MINT_A,
    outMint: MINT_B,
    inAmount: 50_000_000n,
    outAmount: 1_000_000_000n,
    priceImpactPct: 0.5,
    routePlan: [],
    fetchedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function fill(intent: OrderIntent): Fill {
  return {
    intentId: intent.id,
    side: intent.side,
    mint: intent.mint,
    tokensDelta: intent.side === 'buy' ? 1_000_000_000n : -1_000_000_000n,
    lamportsDelta: intent.side === 'buy' ? -50_000_000n : 60_000_000n,
    decimals: 6,
    feesLamports: 100_000n,
    slippageBps: 12,
    simulated: true,
    at: 1_700_000_000_001,
  };
}

interface FakeBrokerOptions {
  balanceLamports?: bigint;
  positions?: Position[];
  quote?: Quote;
  canSell?: CanSellResult;
}

/** A Broker that records what reached it. Nothing here enforces any rule. */
function fakeBroker(options: FakeBrokerOptions = {}) {
  const executed: OrderIntent[] = [];

  /** When set, every `execute` waits on this until `release()` opens it. */
  let gate: Promise<void> | undefined;
  let openGate: (() => void) | undefined;

  const broker: Broker = {
    getQuote: vi.fn(async () => options.quote ?? quote()),
    getPositions: vi.fn(async () => options.positions ?? []),
    getBalanceLamports: vi.fn(async () => options.balanceLamports ?? 1_000_000_000n),
    canSell: vi.fn(async () => options.canSell ?? { ok: true }),
    emergencyExitAll: vi.fn(async () => [fill(sell())]),
    execute: vi.fn(async (intent: OrderIntent) => {
      executed.push(intent);
      const pending = gate;
      if (pending !== undefined) await pending;
      return fill(intent);
    }),
  };

  return {
    broker,
    executed,
    /** Hold every subsequent `execute` open until `release()` is called. */
    blockExecute(): void {
      gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
    },
    release(): void {
      openGate?.();
      gate = undefined;
      openGate = undefined;
    },
  };
}

interface HarnessOptions extends FakeBrokerOptions {
  config?: Partial<Config>;
  state?: Partial<BotState>;
  realizedLossLamportsToday?: bigint;
  /** Mutable so a test can acknowledge orphans mid-session. */
  orphanCount?: { value: number };
}

function harness(options: HarnessOptions = {}) {
  const logged: GuardLogFields[] = [];
  const fake = fakeBroker(options);
  const orphanCount = options.orphanCount ?? { value: 0 };
  /** Counts how often the guard asked, to prove it is not cached. */
  let orphanQueries = 0;

  const deps: GuardDeps = {
    config: parseConfig(options.config ?? {}),
    logger: {
      warn: (fields) => {
        logged.push(fields);
      },
    },
    getState: () => ({
      mode: 'paper',
      status: 'running',
      startedAt: 1_700_000_000_000,
      killSwitchEngaged: false,
      ...options.state,
    }),
    getRealizedLossLamportsToday: async () => options.realizedLossLamportsToday ?? 0n,
    getUnacknowledgedOrphanCount: async () => {
      orphanQueries += 1;
      return orphanCount.value;
    },
  };

  return {
    ...fake,
    logged,
    orphanCount,
    orphanQueries: () => orphanQueries,
    guard: guarded(fake.broker, deps),
  };
}

/** Assert an intent is rejected with a specific code, and that it was logged. */
async function expectRejection(
  promise: Promise<unknown>,
  code: GuardCode,
  logged: GuardLogFields[],
): Promise<GuardRejection> {
  const error = await promise.then(
    () => {
      throw new Error(`expected a ${code} rejection, but execute() resolved`);
    },
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(GuardRejection);
  const rejection = error as GuardRejection;
  expect(rejection.code).toBe(code);
  expect(rejection.reason.length).toBeGreaterThan(0);
  expect(logged.map((entry) => entry.code)).toContain(code);
  return rejection;
}

// ---------------------------------------------------------------------------
// Entry gates
// ---------------------------------------------------------------------------

describe('buy gates', () => {
  it('allows a buy when every gate passes', async () => {
    const { guard, executed } = harness();
    const result = await guard.execute(buy());
    expect(result.intentId).toBe('intent-1');
    expect(executed).toHaveLength(1);
  });

  it('1. rejects when the kill switch is engaged', async () => {
    const { guard, logged, executed } = harness({ state: { killSwitchEngaged: true } });
    await expectRejection(guard.execute(buy()), 'KILL_SWITCH_ENGAGED', logged);
    expect(executed).toHaveLength(0);
  });

  it('2. rejects when the bot is idle', async () => {
    const { guard, logged } = harness({ state: { status: 'idle' } });
    await expectRejection(guard.execute(buy()), 'NOT_RUNNING', logged);
  });

  it('2. rejects when the bot is stopping', async () => {
    const { guard, logged } = harness({ state: { status: 'stopping' } });
    await expectRejection(guard.execute(buy()), 'NOT_RUNNING', logged);
  });

  it('3. rejects a buy whose originating swap is older than maxSignalAgeMs', async () => {
    const { guard, logged, executed } = harness();
    await expectRejection(
      guard.execute(buy({ signalAt: 1_699_999_985_000, signalAgeMs: 15_001 })),
      'STALE_SIGNAL',
      logged,
    );
    expect(executed).toHaveLength(0);
  });

  it('3. allows a buy exactly at the limit', async () => {
    // The boundary is inclusive on the passing side: 15000 is not yet stale.
    const { guard } = harness();
    await expect(guard.execute(buy({ signalAgeMs: 15_000 }))).resolves.toBeDefined();
  });

  it('3. honours a tightened maxSignalAgeMs', async () => {
    const { guard, logged } = harness({ config: { maxSignalAgeMs: 5_000 } });
    await expectRejection(guard.execute(buy({ signalAgeMs: 5_001 })), 'STALE_SIGNAL', logged);
  });

  /**
   * The manual-entry carve-out. An operator's buy has no originating swap, so
   * there is no age that could be wrong; rejecting it would turn a freshness
   * gate into a bar on manual trading.
   */
  it('3. allows a buy carrying no signal metadata at all', async () => {
    const { guard, executed } = harness();
    const intent = buy();
    expect(intent.signalAgeMs).toBeUndefined();
    await expect(guard.execute(intent)).resolves.toBeDefined();
    expect(executed).toHaveLength(1);
  });

  /**
   * Ahead of every gate that does I/O. A trade whose premise has expired should
   * not cost a balance read, a positions read, a quote and a sellability screen
   * on the way to being refused.
   */
  it('3. refuses before touching the broker at all', async () => {
    const { guard, logged, broker } = harness();
    await expectRejection(guard.execute(buy({ signalAgeMs: 60_000 })), 'STALE_SIGNAL', logged);
    expect(broker.getBalanceLamports).not.toHaveBeenCalled();
    expect(broker.getPositions).not.toHaveBeenCalled();
    expect(broker.getQuote).not.toHaveBeenCalled();
    expect(broker.canSell).not.toHaveBeenCalled();
  });

  it('4. rejects when the spend would breach the gas reserve', async () => {
    // 0.07 balance - 0.05 spend = 0.02, which is below the 0.03 reserve.
    const { guard, logged, executed } = harness({ balanceLamports: 70_000_000n });
    await expectRejection(guard.execute(buy()), 'GAS_RESERVE_BREACH', logged);
    expect(executed).toHaveLength(0);
  });

  it('4. allows a buy that lands exactly on the gas reserve', async () => {
    const { guard } = harness({ balanceLamports: 80_000_000n });
    await expect(guard.execute(buy())).resolves.toBeDefined();
  });

  it('4. sizes the check on the intent when it exceeds positionSizeSol', async () => {
    // Config size 0.05 would pass at this balance; the intent's 0.5 must not.
    const { guard, logged } = harness({ balanceLamports: 300_000_000n });
    await expectRejection(
      guard.execute(buy({ amountLamports: 500_000_000n })),
      'GAS_RESERVE_BREACH',
      logged,
    );
  });

  /**
   * The mirror image of the test above, and the one that breaks the moment a
   * sized intent replaces the fixed `positionSizeSol`.
   *
   * The reserve is a question about THIS spend: can the balance afford this
   * intent and still leave the exits funded. Answering it against a config
   * constant the intent does not use refuses trades the balance can plainly
   * afford. Under fixed sizing the two were always equal so nothing showed;
   * under a sized intent they differ on almost every signal. The error is
   * one-directional — it can only over-reject, never admit an unaffordable buy
   * — which is why it was invisible rather than dangerous.
   */
  it('4. sizes the check on the intent when it is BELOW positionSizeSol', async () => {
    // 0.07 balance - 0.02 intent = 0.05, comfortably above the 0.03 reserve.
    // Against the 0.05 config constant it would be 0.02, and refused.
    const { guard, executed } = harness({ balanceLamports: 70_000_000n });
    await expect(guard.execute(buy({ amountLamports: 20_000_000n }))).resolves.toBeDefined();
    expect(executed).toHaveLength(1);
  });

  it('5. rejects at the concurrent position cap', async () => {
    const { guard, logged } = harness({
      config: { maxConcurrentPositions: 2 },
      positions: [position({ mint: MINT_B }), position({ mint: 'Mint3' })],
    });
    await expectRejection(guard.execute(buy()), 'MAX_POSITIONS_REACHED', logged);
  });

  it('5. does not count closed positions against the cap', async () => {
    const { guard } = harness({
      config: { maxConcurrentPositions: 1 },
      positions: [position({ mint: MINT_B, state: 'closed', tokens: 0n })],
    });
    await expect(guard.execute(buy())).resolves.toBeDefined();
  });

  it('6. rejects a mint already held', async () => {
    const { guard, logged } = harness({ positions: [position({ mint: MINT_A })] });
    await expectRejection(guard.execute(buy()), 'ALREADY_HOLDING', logged);
  });

  it('6. rejects a mint held with a sell already in flight', async () => {
    // Until 2026-08-03 this case was expressed as `state: 'closing'`. That
    // state was deleted from `PositionState`: nothing had ever produced it, and
    // producing it would have meant the positions table asserting something the
    // fills do not say. The situation it described is real, and this is what
    // actually covers it — the mint is still held, so gate 5 refuses the entry
    // regardless of whether an exit is running.
    const { guard, logged } = harness({ positions: [position({ mint: MINT_A })] });
    const sell = guard.execute({
      id: 'exiting',
      side: 'sell',
      mint: MINT_A,
      amountTokens: 1_000_000_000n,
      maxSlippageBps: 300,
      reason: 'exit in flight',
    });
    await expectRejection(guard.execute(buy()), 'ALREADY_HOLDING', logged);
    await sell;
  });

  it('7. rejects price impact above the tolerated slippage', async () => {
    // 4% impact is 400 bps, over the 300 bps default.
    const { guard, logged, executed } = harness({ quote: quote({ priceImpactPct: 4 }) });
    await expectRejection(guard.execute(buy()), 'PRICE_IMPACT_EXCEEDED', logged);
    expect(executed).toHaveLength(0);
  });

  it('7. allows price impact exactly at the limit', async () => {
    const { guard } = harness({ quote: quote({ priceImpactPct: 3 }) });
    await expect(guard.execute(buy())).resolves.toBeDefined();
  });

  it('7. honours an intent stricter than the config', async () => {
    const { guard, logged } = harness({
      config: { maxSlippageBps: 1_000 },
      quote: quote({ priceImpactPct: 2 }),
    });
    await expectRejection(
      guard.execute(buy({ maxSlippageBps: 100 })),
      'PRICE_IMPACT_EXCEEDED',
      logged,
    );
  });

  it('7. does not let an intent loosen the config ceiling', async () => {
    const { guard, logged } = harness({
      config: { maxSlippageBps: 300 },
      quote: quote({ priceImpactPct: 15 }),
    });
    await expectRejection(
      guard.execute(buy({ maxSlippageBps: 2_000 })),
      'PRICE_IMPACT_EXCEEDED',
      logged,
    );
  });

  it('8. rejects a mint the broker cannot sell', async () => {
    const { guard, logged, executed } = harness({
      canSell: { ok: false, reason: 'no route to SOL' },
    });
    const rejection = await expectRejection(guard.execute(buy()), 'CANNOT_SELL', logged);
    expect(rejection.reason).toBe('no route to SOL');
    expect(executed).toHaveLength(0);
  });

  it('9. rejects once the daily loss cap is reached', async () => {
    const { guard, logged } = harness({
      config: { maxDailyLossSol: 0.5 },
      realizedLossLamportsToday: 500_000_000n,
    });
    await expectRejection(guard.execute(buy()), 'DAILY_LOSS_LIMIT', logged);
  });

  it('9. allows a buy below the daily loss cap', async () => {
    const { guard } = harness({
      config: { maxDailyLossSol: 0.5 },
      realizedLossLamportsToday: 490_000_000n,
    });
    await expect(guard.execute(buy())).resolves.toBeDefined();
  });
});

describe('gate 0: unacknowledged crash orphans', () => {
  it('rejects a buy while any orphan is unacknowledged', async () => {
    const { guard, logged, executed } = harness({ orphanCount: { value: 1 } });
    const rejection = await expectRejection(
      guard.execute(buy()),
      'UNACKNOWLEDGED_ORPHANS',
      logged,
    );
    expect(rejection.reason).toContain('npm run orphans');
    expect(executed).toHaveLength(0);
  });

  it('takes precedence over the kill switch', async () => {
    const { guard, logged } = harness({
      orphanCount: { value: 2 },
      state: { killSwitchEngaged: true },
    });
    await expectRejection(guard.execute(buy()), 'UNACKNOWLEDGED_ORPHANS', logged);
  });

  it('never blocks a sell — exits stay open while orphans are outstanding', async () => {
    const { guard, executed, logged } = harness({
      orphanCount: { value: 3 },
      positions: [position()],
    });
    await expect(guard.execute(sell())).resolves.toBeDefined();
    expect(executed).toHaveLength(1);
    expect(logged).toHaveLength(0);
  });

  it('never blocks emergencyExitAll', async () => {
    const { guard } = harness({ orphanCount: { value: 3 } });
    await expect(guard.emergencyExitAll()).resolves.toHaveLength(1);
  });

  it('lifts mid-session when the count drops, with no restart', async () => {
    const h = harness({ orphanCount: { value: 1 } });

    await expectRejection(h.guard.execute(buy({ id: 'first' })), 'UNACKNOWLEDGED_ORPHANS', h.logged);

    // An operator acknowledges the orphan through the CLI. Same guard instance,
    // same process — nothing is restarted.
    h.orphanCount.value = 0;

    await expect(h.guard.execute(buy({ id: 'second' }))).resolves.toBeDefined();
    expect(h.executed).toHaveLength(1);
  });

  it('re-gates mid-session if a new orphan appears', async () => {
    const h = harness();
    await expect(h.guard.execute(buy({ id: 'first' }))).resolves.toBeDefined();

    h.orphanCount.value = 1;
    await expectRejection(h.guard.execute(buy({ id: 'second' })), 'UNACKNOWLEDGED_ORPHANS', h.logged);
  });

  it('queries the count on every buy rather than caching it', async () => {
    const h = harness();
    await h.guard.execute(buy({ id: 'a' }));
    await h.guard.execute(buy({ id: 'b', mint: MINT_B }));
    // Was the placeholder 'Mint3' until 2026-08-03, when gate 0 started
    // checking that a mint is base58 and correctly refused it.
    await h.guard.execute(buy({ id: 'c', mint: MINT_C }));

    expect(h.orphanQueries()).toBe(3);
  });
});

describe('buy gates hold against same-tick concurrency', () => {
  it('rejects a second buy of the same mint issued before the first settles', async () => {
    const h = harness();
    h.blockExecute();

    const first = h.guard.execute(buy({ id: 'first' }));
    await expectRejection(h.guard.execute(buy({ id: 'second' })), 'ALREADY_HOLDING', h.logged);

    h.release();
    await expect(first).resolves.toBeDefined();
    expect(h.executed).toHaveLength(1);
  });

  it('counts in-flight buys toward the concurrency cap', async () => {
    const h = harness({ config: { maxConcurrentPositions: 1 } });
    h.blockExecute();

    // Neither buy is in getPositions() yet, so a cap checked only against
    // stored positions would let both through and open two of a maximum one.
    const first = h.guard.execute(buy({ id: 'first', mint: MINT_A }));
    await expectRejection(
      h.guard.execute(buy({ id: 'second', mint: MINT_B })),
      'MAX_POSITIONS_REACHED',
      h.logged,
    );

    h.release();
    await expect(first).resolves.toBeDefined();
    expect(h.executed).toHaveLength(1);
  });

  it('releases the claim after a failed buy', async () => {
    const { guard, broker } = harness();
    vi.mocked(broker.execute).mockRejectedValueOnce(new Error('rpc timeout'));

    await expect(guard.execute(buy())).rejects.toThrow('rpc timeout');
    await expect(guard.execute(buy())).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Exit gates
// ---------------------------------------------------------------------------

describe('sell gates', () => {
  it('allows a sell of an open position', async () => {
    const { guard, executed } = harness({ positions: [position()] });
    const result = await guard.execute(sell());
    expect(result.tokensDelta).toBeLessThan(0);
    expect(executed).toHaveLength(1);
  });

  it('1. rejects a sell with no open position', async () => {
    const { guard, logged, executed } = harness({ positions: [] });
    await expectRejection(guard.execute(sell()), 'NO_OPEN_POSITION', logged);
    expect(executed).toHaveLength(0);
  });

  /**
   * The asymmetry, applied to the newest risk limit.
   *
   * A stale sell is not a stale signal problem — it is a holder trying to get
   * out. Age-gating it would trap the bot in the position for precisely the
   * reason the limit was warning about, which is the failure mode this module's
   * header exists to prevent.
   */
  it('never age-gates a sell, however stale the signal', async () => {
    const { guard, executed } = harness({ positions: [position()] });
    const result = await guard.execute(
      sell({ signalAt: 1_600_000_000_000, signalAgeMs: 100_000_000 }),
    );
    expect(result.tokensDelta).toBeLessThan(0);
    expect(executed).toHaveLength(1);
  });

  it('never age-gates a sell even under a tightened maxSignalAgeMs', async () => {
    const { guard, executed } = harness({
      positions: [position()],
      config: { maxSignalAgeMs: 5_000 },
    });
    await expect(guard.execute(sell({ signalAgeMs: 86_400_000 }))).resolves.toBeDefined();
    expect(executed).toHaveLength(1);
  });

  it('1. rejects a sell of a different mint than the one held', async () => {
    const { guard, logged } = harness({ positions: [position({ mint: MINT_B })] });
    await expectRejection(guard.execute(sell({ mint: MINT_A })), 'NO_OPEN_POSITION', logged);
  });

  it('1. rejects a sell of an already-closed position', async () => {
    const { guard, logged } = harness({
      positions: [position({ state: 'closed', tokens: 0n })],
    });
    await expectRejection(guard.execute(sell()), 'NO_OPEN_POSITION', logged);
  });

  it('2. rejects a second sell of the same mint while one is in flight', async () => {
    const h = harness({ positions: [position()] });
    h.blockExecute();

    const first = h.guard.execute(sell({ id: 'first' }));
    await expectRejection(
      h.guard.execute(sell({ id: 'second' })),
      'SELL_IN_FLIGHT',
      h.logged,
    );

    h.release();
    await expect(first).resolves.toBeDefined();
    expect(h.executed).toHaveLength(1);
  });

  it('2. allows a concurrent sell of a different mint', async () => {
    const h = harness({ positions: [position({ mint: MINT_A }), position({ mint: MINT_B })] });
    h.blockExecute();

    const first = h.guard.execute(sell({ id: 'first', mint: MINT_A }));
    const second = h.guard.execute(sell({ id: 'second', mint: MINT_B }));

    h.release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('2. clears the in-flight flag after a failed sell, so a retry is possible', async () => {
    const { guard, broker, logged } = harness({ positions: [position()] });
    vi.mocked(broker.execute).mockRejectedValueOnce(new Error('rpc timeout'));

    await expect(guard.execute(sell())).rejects.toThrow('rpc timeout');
    // A stuck flag here would strand the position permanently.
    await expect(guard.execute(sell())).resolves.toBeDefined();
    expect(logged).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The asymmetry: risk limits gate entries only
// ---------------------------------------------------------------------------

describe('gate 0: well-formedness, both sides', () => {
  it('rejects a buy with a negative amount instead of widening it', async () => {
    const { guard, logged, executed } = harness();
    // `spendLamports` used `max(requested, positionSizeSol)` as both the
    // gas-reserve clamp AND the low-end check, so -1n became 50_000_000n,
    // passed every gate, and died in the broker as a RangeError.
    await expectRejection(
      guard.execute(buy({ amountLamports: -1n })),
      'MALFORMED_INTENT',
      logged,
    );
    expect(executed).toHaveLength(0);
  });

  for (const [label, amount] of [
    ['zero', 0n],
    ['NaN', Number.NaN as unknown as bigint],
    ['Infinity', Number.POSITIVE_INFINITY as unknown as bigint],
    ['a plain number', 50_000_000 as unknown as bigint],
  ] as const) {
    it(`rejects a buy amount that is ${label}`, async () => {
      const { guard, logged } = harness();
      await expectRejection(
        guard.execute(buy({ amountLamports: amount })),
        'MALFORMED_INTENT',
        logged,
      );
    });
  }

  it('rejects an absent amount for the side', async () => {
    const { guard, logged } = harness();
    const intent = buy();
    delete (intent as { amountLamports?: bigint }).amountLamports;
    await expectRejection(guard.execute(intent), 'MALFORMED_INTENT', logged);
  });

  for (const [label, mint] of [
    ['null', null as unknown as string],
    ['empty', ''],
    ['not base58', 'not a mint!!'],
    ['too short', 'abc'],
    ['containing 0OIl', '0OIl1111111111111111111111111111111111111111'],
  ] as const) {
    it(`rejects a mint that is ${label}`, async () => {
      const { guard, logged } = harness();
      await expectRejection(
        guard.execute(buy({ mint })),
        'MALFORMED_INTENT',
        logged,
      );
    });
  }

  it('names the specific problem, so an operator can fix the caller', async () => {
    // The reason text is what reaches the log and `intents.rejection_code`'s
    // sibling column. Three different mistakes that all end in
    // MALFORMED_INTENT must not read identically, or the code is the only
    // information and the message is noise.
    const missing = malformedIntentReason({
      id: 'x',
      side: 'buy',
      mint: MINT_A,
      maxSlippageBps: 300,
      reason: 'r',
    });
    expect(missing).toBe('amountLamports is required for a buy');

    const empty = malformedIntentReason({
      id: 'x',
      side: 'buy',
      mint: '',
      amountLamports: 1n,
      maxSlippageBps: 300,
      reason: 'r',
    });
    expect(empty).toBe('mint  is not an address');

    const badBase58 = malformedIntentReason({
      id: 'x',
      side: 'buy',
      mint: 'not a mint!!',
      amountLamports: 1n,
      maxSlippageBps: 300,
      reason: 'r',
    });
    expect(badBase58).toContain('is not valid base58');

    // An absent amount is a different mistake from a wrongly-typed one.
    const wrongType = malformedIntentReason({
      id: 'x',
      side: 'sell',
      mint: MINT_A,
      amountTokens: 5 as unknown as bigint,
      maxSlippageBps: 300,
      reason: 'r',
    });
    expect(wrongType).toBe('amountTokens must be an exact bigint, got number 5');
  });

  it('accepts a well-formed intent on both sides', () => {
    expect(
      malformedIntentReason({
        id: 'x',
        side: 'buy',
        mint: MINT_A,
        amountLamports: 1n,
        maxSlippageBps: 0,
        reason: 'r',
      }),
    ).toBeNull();
    expect(
      malformedIntentReason({
        id: 'x',
        side: 'sell',
        mint: MINT_A,
        amountTokens: 1n,
        maxSlippageBps: 300,
        reason: 'r',
      }),
    ).toBeNull();
  });

  it('runs AHEAD of every other gate', async () => {
    // Orphans outstanding, kill switch on, not running, loss cap breached — and
    // the reported code is still the well-formedness one, because an intent
    // that is not an instruction cannot be assessed for risk.
    const { guard, logged, orphanQueries } = harness({
      orphanCount: { value: 3 },
      state: { killSwitchEngaged: true, status: 'idle' },
      realizedLossLamportsToday: 10_000_000_000n,
    });
    await expectRejection(
      guard.execute(buy({ amountLamports: 0n })),
      'MALFORMED_INTENT',
      logged,
    );
    // It is synchronous and pure, so nothing downstream was even asked.
    expect(orphanQueries()).toBe(0);
  });

  it('rejects a malformed SELL too — it is not a risk gate', async () => {
    const { guard, logged, executed } = harness({ positions: [position()] });
    await expectRejection(
      guard.execute(sell({ amountTokens: Number.NaN as unknown as bigint })),
      'MALFORMED_INTENT',
      logged,
    );
    expect(executed).toHaveLength(0);
  });

  it('a well-formed sell still passes gate 0 with EVERY entry control tripped', async () => {
    const { guard, logged, executed } = harness({
      positions: [position()],
      orphanCount: { value: 2 },
      state: { killSwitchEngaged: true, status: 'idle' },
      config: { maxDailyLossSol: 0.5 },
      realizedLossLamportsToday: 10_000_000_000n,
    });

    // The new gate must not have quietly become a risk gate. "Is this a
    // coherent instruction" is answered the same way whatever the bot's state
    // is, and a holder must still be able to get out.
    const result = await guard.execute(sell());

    expect(result.tokensDelta).toBeLessThan(0);
    expect(executed).toHaveLength(1);
    expect(logged).toHaveLength(0);
  });
});

describe('a position with no tokens is not held, whatever its state says', () => {
  it('does not block an entry', async () => {
    // `isLive` checks tokens as well as state. The ledger's own invariant makes
    // those two agree, so this is belt and braces — but the belt is what stops
    // a hand-built or future Position with `state: 'open', tokens: 0n` from
    // occupying a concurrency slot and blocking the mint forever.
    const { guard, executed } = harness({
      positions: [position({ mint: MINT_A, tokens: 0n, state: 'open' })],
    });
    await guard.execute(buy({ mint: MINT_A }));
    expect(executed).toHaveLength(1);
  });

  it('is not sellable', async () => {
    const { guard, logged } = harness({
      positions: [position({ mint: MINT_A, tokens: 0n, state: 'open' })],
    });
    await expectRejection(guard.execute(sell()), 'NO_OPEN_POSITION', logged);
  });
});

describe('exits for more than is held are CLAMPED, never refused', () => {
  it('clamps to the position and executes', async () => {
    const { guard, logged, executed } = harness({
      positions: [position({ tokens: 1_000_000_000n })],
    });

    // Refusing would strand a holder whose ledger and chain disagree — the
    // exact situation the crash-orphan gate exists for.
    const result = await guard.execute(sell({ amountTokens: 999_999_999_999n }));

    expect(result.tokensDelta).toBeLessThan(0);
    // Clamped BEFORE the broker was called, so the quote, the fill and the
    // position delta all describe the same quantity.
    expect(executed[0]?.amountTokens).toBe(1_000_000_000n);

    // Logged, and logged as a NOTICE. `SELL_CLAMPED` is deliberately not a
    // `GuardCode`: that type is the set of reasons an intent did not execute,
    // and Prompt 12 counts it. This one executed.
    expect(logged).toHaveLength(1);
    expect(logged[0]?.code).toBe('SELL_CLAMPED');
    expect(logged[0]?.reason).toContain('requested 999999999999, holding 1000000000');
  });

  it('leaves an exit within the position untouched', async () => {
    const { guard, executed } = harness({ positions: [position({ tokens: 1_000_000_000n })] });
    await guard.execute(sell({ amountTokens: 400_000_000n }));
    expect(executed[0]?.amountTokens).toBe(400_000_000n);
  });

  it('leaves an exit of exactly the position untouched', async () => {
    const { guard, executed } = harness({ positions: [position({ tokens: 1_000_000_000n })] });
    await guard.execute(sell({ amountTokens: 1_000_000_000n }));
    expect(executed[0]?.amountTokens).toBe(1_000_000_000n);
  });
});

describe('sells are never blocked by risk limits', () => {
  it('sells while the kill switch is engaged AND the daily loss cap is breached', async () => {
    const { guard, logged, executed } = harness({
      positions: [position()],
      state: { killSwitchEngaged: true, status: 'running' },
      config: { maxDailyLossSol: 0.5 },
      realizedLossLamportsToday: 10_000_000_000n,
    });

    // The exact scenario the rule exists for: the bot is in its worst state,
    // holding a position, and must still be able to get out.
    const result = await guard.execute(sell());

    expect(result.tokensDelta).toBeLessThan(0);
    expect(executed).toHaveLength(1);
    expect(logged).toHaveLength(0);

    // And the same conditions must still block an entry.
    await expectRejection(guard.execute(buy({ mint: MINT_B })), 'KILL_SWITCH_ENGAGED', logged);
  });

  it('sells with an unacknowledged orphan AND the kill switch AND the loss cap breached', async () => {
    const { guard, logged, executed } = harness({
      positions: [position()],
      orphanCount: { value: 2 },
      state: { killSwitchEngaged: true, status: 'running' },
      config: { maxDailyLossSol: 0.5 },
      realizedLossLamportsToday: 10_000_000_000n,
    });

    // Every entry control in the system is tripped at once. The exit must still
    // work: this is the invariant the rest of the guard layer rests on.
    const result = await guard.execute(sell());

    expect(result.tokensDelta).toBeLessThan(0);
    expect(executed).toHaveLength(1);
    expect(logged).toHaveLength(0);

    // ...and a buy under those same conditions is refused at the orphan gate.
    await expectRejection(
      guard.execute(buy({ mint: MINT_B })),
      'UNACKNOWLEDGED_ORPHANS',
      logged,
    );
  });

  it('sells while the bot is stopping', async () => {
    const { guard } = harness({ positions: [position()], state: { status: 'stopping' } });
    await expect(guard.execute(sell())).resolves.toBeDefined();
  });

  it('sells while the bot is idle', async () => {
    const { guard } = harness({ positions: [position()], state: { status: 'idle' } });
    await expect(guard.execute(sell())).resolves.toBeDefined();
  });

  it('sells at the concurrent position cap', async () => {
    const { guard } = harness({
      config: { maxConcurrentPositions: 1 },
      positions: [position()],
    });
    await expect(guard.execute(sell())).resolves.toBeDefined();
  });

  it('sells with a balance below the gas reserve', async () => {
    const { guard } = harness({ positions: [position()], balanceLamports: 0n });
    await expect(guard.execute(sell())).resolves.toBeDefined();
  });

  it('sells despite price impact far beyond the slippage ceiling', async () => {
    const { guard } = harness({
      positions: [position()],
      quote: quote({ priceImpactPct: 90 }),
    });
    await expect(guard.execute(sell())).resolves.toBeDefined();
  });

  it('never consults risk state on the sell path', async () => {
    const { guard, broker } = harness({ positions: [position()] });
    await guard.execute(sell());

    // A future edit that adds a balance or quote check to the sell path would
    // trip this before it could strand a position in production.
    expect(broker.getBalanceLamports).not.toHaveBeenCalled();
    expect(broker.getQuote).not.toHaveBeenCalled();
    expect(broker.canSell).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Emergency exit and pass-through
// ---------------------------------------------------------------------------

describe('emergencyExitAll', () => {
  it('is not blocked by the kill switch or any other limit', async () => {
    const { guard, broker } = harness({
      state: { killSwitchEngaged: true, status: 'stopping' },
      realizedLossLamportsToday: 999_000_000_000n,
      balanceLamports: 0n,
    });
    await expect(guard.emergencyExitAll()).resolves.toHaveLength(1);
    expect(broker.emergencyExitAll).toHaveBeenCalledOnce();
  });
});

describe('read-only methods pass through', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness({ balanceLamports: 2_500_000_000n, positions: [position()] });
  });

  it('forwards getQuote, getPositions, getBalanceSol and canSell', async () => {
    await expect(h.guard.getBalanceLamports()).resolves.toBe(2_500_000_000n);
    await expect(h.guard.getPositions()).resolves.toHaveLength(1);
    await expect(h.guard.canSell(MINT_A)).resolves.toEqual({ ok: true });
    await expect(h.guard.getQuote(buy())).resolves.toBeDefined();
    // Read-only calls are never rejections, so nothing is logged.
    expect(h.logged).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rejection shape
// ---------------------------------------------------------------------------

describe('GuardRejection', () => {
  it('carries the code, reason and intent identity', async () => {
    const { guard, logged } = harness({ state: { killSwitchEngaged: true } });
    const rejection = await expectRejection(
      guard.execute(buy({ id: 'abc', mint: MINT_B })),
      'KILL_SWITCH_ENGAGED',
      logged,
    );

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection.name).toBe('GuardRejection');
    expect(rejection.intentId).toBe('abc');
    expect(rejection.side).toBe('buy');
    expect(rejection.mint).toBe(MINT_B);
    expect(rejection.message).toContain('KILL_SWITCH_ENGAGED');
  });

  it('logs every rejection with structured fields', async () => {
    const { guard, logged } = harness({ state: { killSwitchEngaged: true } });
    await guard.execute(buy({ id: 'xyz' })).catch(() => undefined);

    expect(logged).toEqual([
      {
        code: 'KILL_SWITCH_ENGAGED',
        reason: expect.any(String),
        intentId: 'xyz',
        side: 'buy',
        mint: MINT_A,
      },
    ]);
  });
});
