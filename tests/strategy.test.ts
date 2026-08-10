import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/core/config.js';
import type { Config } from '../src/core/config.js';
import type { QuoteError, QuoteRequest, QuoteSource } from '../src/core/quoteSource.js';
import type { Context, IntentDraft, Strategy } from '../src/core/strategy.js';
import type {
  Fill,
  OrderIntent,
  Position,
  Quote,
  SimulatedFill,
  TrackedSwap,
} from '../src/core/types.js';
import { WRAPPED_SOL_MINT, solToLamports } from '../src/core/units.js';
import { createPaperBroker } from '../src/adapters/paperBroker.js';
import { createDecimalsResolver, fixtureDecimalsSource } from '../src/adapters/mintMetadata.js';
import { openLedger } from '../src/db/ledger.js';
import type { Ledger } from '../src/db/ledger.js';
import { openRuntimeState } from '../src/db/runtimeState.js';
import type { RuntimeState } from '../src/db/runtimeState.js';
import { Tracker } from '../src/services/tracker.js';
import type {
  HeldPositionScreener,
  Scheduler,
  TrackerEventRecord,
  WalletFeed,
} from '../src/services/tracker.js';
import { STRATEGY_TIMEOUT_MS, StrategyRunner } from '../src/services/strategyRunner.js';
import { malformedIntentReason } from '../src/core/guards.js';
import {
  STRATEGY_REGISTRY,
  UnknownStrategyError,
  createStrategy,
  strategyNames,
} from '../src/services/strategyRegistry.js';
import {
  STOP_LOSS_PCT,
  TAKE_PROFIT_PCT,
  createMirrorStrategy,
  formatPriceSol,
  shortAddress,
} from '../src/strategies/mirror.js';
import { createEquationStrategy } from '../src/strategies/equation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../src');

const MINT_A = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const MINT_B = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const WALLET_2 = 'BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9XSiHMY';
const NOW = 1_700_000_000_000;
const DECIMALS = 6;

// ---------------------------------------------------------------------------
// Determinism, enforced mechanically
// ---------------------------------------------------------------------------

describe('strategies are pure', () => {
  const files = readdirSync(join(SRC, 'strategies')).filter(
    (name) => name.endsWith('.ts') && !name.startsWith('._'),
  );

  it('finds strategy files to check', () => {
    // A grep that matches nothing passes vacuously. This is the guard on the
    // guard: if `src/strategies/` is ever moved, the purity check below stops
    // being a check and nothing else would say so.
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files).toContain('mirror.ts');
    expect(files).toContain('equation.ts');
  });

  /**
   * The three escape hatches from determinism.
   *
   * Prompt 12 promises byte-identical replays of a recorded session. A replay
   * feeds the same inputs back in; it cannot feed back the same wall clock, the
   * same PRNG draw, or the same network response. Any of these three inside a
   * strategy makes that promise unkeepable, and this is the only place it can
   * be enforced mechanically rather than by review.
   */
  const FORBIDDEN: Array<[string, RegExp]> = [
    ['Date.now', /\bDate\s*\.\s*now\b/],
    ['new Date', /\bnew\s+Date\b/],
    ['Math.random', /\bMath\s*\.\s*random\b/],
    ['fetch', /\bfetch\s*\(/],
  ];

  for (const file of files) {
    for (const [label, pattern] of FORBIDDEN) {
      it(`${file} does not use ${label}`, () => {
        const source = readFileSync(join(SRC, 'strategies', file), 'utf8');
        // Comments are stripped first: the module headers *name* these three in
        // prose explaining why they are banned, and a check that fails on its
        // own documentation is a check people delete.
        const code = source
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1');
        expect(code).not.toMatch(pattern);
      });
    }
  }

  it('imports nothing outside core/', () => {
    for (const file of files) {
      const source = readFileSync(join(SRC, 'strategies', file), 'utf8');
      const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '');
      for (const specifier of imports) {
        // A strategy that can reach `adapters/` can reach a broker, and a
        // strategy that can reach a broker can bypass `guards.ts`. The guard
        // layer is only total because `Broker` is the one door to funds.
        expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.\.\/core\//);
      }
    }
  });

  it('core/strategy.ts is types-only — it has no runtime import at all', () => {
    const source = readFileSync(join(SRC, 'core/strategy.ts'), 'utf8');
    const imports = [...source.matchAll(/^import\s+(type\s+)?/gm)];
    expect(imports.length).toBeGreaterThan(0);
    // Every one is `import type`, so the compiled file has no requires and the
    // interface cannot drag I/O into `core/` by accident.
    for (const match of imports) expect(match[1]).toBe('type ');
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('strategy registry', () => {
  it('resolves both registered names', () => {
    expect(createStrategy('mirror').name).toBe('mirror');
    expect(createStrategy('equation').name).toBe('equation');
  });

  it('throws by name and lists what it knows', () => {
    expect(() => createStrategy('momentum')).toThrow(UnknownStrategyError);
    expect(() => createStrategy('momentum')).toThrow(/knows: equation, mirror/);
  });

  it('hands out a fresh instance each time, so two runtimes cannot share state', () => {
    expect(createStrategy('mirror')).not.toBe(createStrategy('mirror'));
  });

  it('every registered factory reports the name it is registered under', () => {
    // The prefix on every intent id comes from `strategy.name`. A mismatch
    // would put a misleading prefix on the ledger rows an audit reads back.
    for (const name of strategyNames()) expect(createStrategy(name).name).toBe(name);
    expect(strategyNames()).toEqual(['equation', 'mirror']);
  });

  it('is frozen, so nothing can register a strategy at runtime', () => {
    expect(() => {
      (STRATEGY_REGISTRY as Record<string, unknown>)['sneaky'] = () => undefined;
    }).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Mirror, as a pure function
// ---------------------------------------------------------------------------

function position(overrides: Partial<Position> = {}): Position {
  return {
    mint: MINT_A,
    tokens: 1_000_000_000n,
    costLamports: 50_000_000n,
    decimals: DECIMALS,
    openedAt: NOW,
    avgEntrySol: 0.00005,
    lastPriceSol: 0.00005,
    unrealizedSol: 0,
    state: 'open',
    ...overrides,
  };
}

function swapOf(overrides: Partial<TrackedSwap> = {}): TrackedSwap {
  return {
    wallet: WALLET,
    mint: MINT_A,
    side: 'buy',
    solAmount: 410_000_000n,
    tokenAmount: 1_000_000_000n,
    decimals: DECIMALS,
    signature: 'sig',
    slot: 1,
    blockTime: 1_700_000_000,
    venue: 'pumpfun',
    feePayer: true,
    source: 'live',
    observedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function contextOf(positions: Position[] = [], config?: Config): Context {
  return {
    positions: Object.freeze(positions.map((entry) => Object.freeze({ ...entry }))),
    balanceSol: 5,
    config: config ?? parseConfig({}),
    getPriceSol: async () => 0.00005,
    now: () => NOW,
    log: { info: () => undefined, warn: () => undefined },
  };
}

describe('mirror — entries', () => {
  const mirror = createMirrorStrategy();

  it('buys a mint we do not hold when a tracked wallet buys it', async () => {
    const draft = await mirror.onTrackedSwap(swapOf(), contextOf());

    expect(draft).toMatchObject({
      side: 'buy',
      mint: MINT_A,
      amountLamports: solToLamports(0.05),
      maxSlippageBps: 300,
    });
    // The reason names the trigger and the numbers, so a ledger row explains
    // itself without the event stream.
    expect(draft?.reason).toBe('mirror: 7xKX..sU bought 0.41 SOL');
  });

  it('sizes the buy from config, not from what the tracked wallet spent', async () => {
    const config = parseConfig({ positionSizeSol: 0.25 });
    const draft = await mirror.onTrackedSwap(
      swapOf({ solAmount: 900_000_000_000n }),
      contextOf([], config),
    );
    // Mirroring their size would let a whale's position sizing become ours.
    expect(draft?.amountLamports).toBe(solToLamports(0.25));
  });

  it('NO-OPS when a second tracked wallet buys a mint we already hold', async () => {
    const draft = await mirror.onTrackedSwap(
      swapOf({ wallet: WALLET_2 }),
      contextOf([position()]),
    );

    // `guards.ts` would reject this as ALREADY_HOLDING. Emitting it anyway
    // would fill `intents.rejection_code` with self-inflicted noise, and
    // Prompt 12 counts those rows to say how often risk limits actually bit.
    expect(draft).toBeNull();
  });

  it('no-ops on a buy for a mint still holding a single base unit', async () => {
    // Until 2026-08-03 this case read `state: 'closing'`. That state was
    // deleted — nothing produced it — so "we still hold some of this" is now
    // expressed the only way the ledger can express it: tokens remain.
    const draft = await mirror.onTrackedSwap(swapOf(), contextOf([position({ tokens: 1n })]));
    expect(draft).toBeNull();
  });

  it('buys again once the position is genuinely closed', async () => {
    const draft = await mirror.onTrackedSwap(
      swapOf(),
      contextOf([position({ state: 'closed', tokens: 0n })]),
    );
    expect(draft?.side).toBe('buy');
  });
});

describe('mirror — mirrored exits', () => {
  const mirror = createMirrorStrategy();

  it('sells 100% when a tracked wallet sells a mint we hold', async () => {
    const draft = await mirror.onTrackedSwap(
      swapOf({ side: 'sell', solAmount: 410_000_000n }),
      contextOf([position()]),
    );

    expect(draft).toMatchObject({ side: 'sell', mint: MINT_A, amountTokens: 1_000_000_000n });
    expect(draft?.reason).toBe('mirror: 7xKX..sU sold 0.41 SOL');
  });

  it('sells all of it however small the fraction they sold', async () => {
    const draft = await mirror.onTrackedSwap(
      swapOf({ side: 'sell', solAmount: 1_000n }),
      contextOf([position()]),
    );
    // Mirroring the fraction leaves a remainder that still occupies a
    // concurrency slot and still has to be exited, on a signal that may never
    // come.
    expect(draft?.amountTokens).toBe(1_000_000_000n);
  });

  it('NO-OPS when a tracked wallet sells a mint we never held', async () => {
    const draft = await mirror.onTrackedSwap(swapOf({ side: 'sell' }), contextOf([]));
    expect(draft).toBeNull();
  });

  it('sells the remainder when a tracked wallet sells a mint we barely hold', async () => {
    // Was `state: 'closing'` -> null before 2026-08-03. With that state gone,
    // a position holding one base unit is simply a position: the mirror exits
    // it, and a genuinely concurrent exit is refused by `SELL_IN_FLIGHT` in the
    // guard layer rather than guessed at from a snapshot here.
    const draft = await mirror.onTrackedSwap(
      swapOf({ side: 'sell' }),
      contextOf([position({ tokens: 1n })]),
    );
    expect(draft).toMatchObject({ side: 'sell', amountTokens: 1n });
  });

  it('ignores a position in a different mint', async () => {
    const draft = await mirror.onTrackedSwap(
      swapOf({ side: 'sell' }),
      contextOf([position({ mint: MINT_B })]),
    );
    expect(draft).toBeNull();
  });
});

describe('mirror — the exit band', () => {
  const mirror = createMirrorStrategy();
  const ENTRY = 0.00005;

  /** Price that lands exactly `pct` from `ENTRY`. */
  const at = (pct: number): number => ENTRY * (1 + pct / 100);

  it('holds at -39.9%', async () => {
    expect(await mirror.onPriceTick(position(), at(-39.9), contextOf())).toBeNull();
  });

  it('SELLS at exactly -40.0%', async () => {
    // The boundary is inclusive, and it is stated here rather than left to be
    // inferred from which comparison operator someone typed.
    const draft = await mirror.onPriceTick(position(), at(STOP_LOSS_PCT), contextOf());
    expect(draft).toMatchObject({ side: 'sell', amountTokens: 1_000_000_000n });
    expect(draft?.reason).toBe('stop: -40.0% from 0.00005');
  });

  it('sells at -40.1%', async () => {
    const draft = await mirror.onPriceTick(position(), at(-40.1), contextOf());
    expect(draft?.reason).toBe('stop: -40.1% from 0.00005');
  });

  it('holds at +149.9%', async () => {
    expect(await mirror.onPriceTick(position(), at(149.9), contextOf())).toBeNull();
  });

  it('SELLS at exactly +150.0%', async () => {
    const draft = await mirror.onPriceTick(position(), at(TAKE_PROFIT_PCT), contextOf());
    expect(draft).toMatchObject({ side: 'sell', amountTokens: 1_000_000_000n });
    expect(draft?.reason).toBe('take: +150.0% from 0.00005');
  });

  it('sells at +150.1%', async () => {
    const draft = await mirror.onPriceTick(position(), at(150.1), contextOf());
    expect(draft?.reason).toBe('take: +150.1% from 0.00005');
  });

  it('holds flat', async () => {
    expect(await mirror.onPriceTick(position(), ENTRY, contextOf())).toBeNull();
  });

  it('sells the whole position, never a fraction', async () => {
    const draft = await mirror.onPriceTick(
      position({ tokens: 7_777_777_777n }),
      at(-50),
      contextOf(),
    );
    expect(draft?.amountTokens).toBe(7_777_777_777n);
  });

  it('names the entry price in the reason without exponent notation', async () => {
    const draft = await mirror.onPriceTick(
      position({ avgEntrySol: 0.00000123 }),
      0.00000123 * 0.5,
      contextOf(),
    );
    // `String(0.00000123)` is "1.23e-7", which is unreadable in an audit log
    // and cannot be eyeballed against the ledger.
    expect(draft?.reason).toBe('stop: -50.0% from 0.00000123');
  });
});

describe('mirror — holds rather than panics', () => {
  const mirror = createMirrorStrategy();

  it('HOLDS on an unusable price rather than selling', async () => {
    // A missing price is a fact about our data, not about the token. Selling on
    // it converts a plumbing failure into a realized loss. A genuinely
    // unroutable position is surfaced by the tracker's `route-lost` latch — an
    // alert for a human, not a signal for a strategy.
    for (const price of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      expect(await mirror.onPriceTick(position(), price, contextOf())).toBeNull();
    }
  });

  it('holds when getPriceSol on the context reports a QuoteError', async () => {
    const error: QuoteError = { error: 'NO_ROUTE', message: 'TOKEN_NOT_TRADABLE' };
    const ctx: Context = { ...contextOf(), getPriceSol: async () => error };
    // Mirror never calls it on this path, and that is the point: an exit
    // decision is made from the price the tracker already derived from a real
    // exit quote, so a second failing probe cannot produce a sell either.
    expect(await mirror.onPriceTick(position(), Number.NaN, ctx)).toBeNull();
  });

  it('holds on a nonsense entry price', async () => {
    for (const entry of [0, Number.NaN, -0.001]) {
      expect(await mirror.onPriceTick(position({ avgEntrySol: entry }), 1, contextOf())).toBeNull();
    }
  });

  it('holds on a closed position', async () => {
    // Was `state: 'closing'` before 2026-08-03. `closed` is the only non-open
    // state there is now, and a closed position has nothing to sell.
    expect(
      await mirror.onPriceTick(position({ state: 'closed', tokens: 0n }), 0.000001, contextOf()),
    ).toBeNull();
  });

  it('holds on a position with no tokens', async () => {
    expect(await mirror.onPriceTick(position({ tokens: 0n }), 0.000001, contextOf())).toBeNull();
  });
});

describe('mirror formatting helpers', () => {
  it('trims trailing zeros and never emits an exponent', () => {
    expect(formatPriceSol(0.00000123)).toBe('0.00000123');
    expect(formatPriceSol(0.5)).toBe('0.5');
    expect(formatPriceSol(1)).toBe('1');
    expect(formatPriceSol(0.41)).toBe('0.41');
    expect(formatPriceSol(0.000000001)).toBe('0.000000001');
  });

  it('reports a value below SOL precision as 0 rather than as an exponent', () => {
    // 1e-12 lamports does not exist. Showing "1e-12" in a reason string would
    // imply a precision the unit does not have.
    expect(formatPriceSol(1e-12)).toBe('0');
  });

  it('shortens an address to something a human can match', () => {
    expect(shortAddress(WALLET)).toBe('7xKX..sU');
    expect(shortAddress('short')).toBe('short');
  });
});

describe('equation stub', () => {
  const equation = createEquationStrategy();

  it('is a working strategy that never trades', async () => {
    expect(await equation.onTrackedSwap(swapOf(), contextOf())).toBeNull();
    expect(await equation.onPriceTick(position(), 0.000001, contextOf())).toBeNull();
    expect(await equation.onPriceTick(position(), 0.1, contextOf())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Harness — runner over a real ledger, broker and guard layer
// ---------------------------------------------------------------------------

class FakeStream extends EventEmitter implements WalletFeed {
  /**
   * Emits `connected`, because `WalletStream.start()` does. The tracker's
   * `running` status is bound to that event, so a fake that omits it models a
   * feed that never comes up.
   */
  async start(): Promise<void> {
    this.emit('connected', { at: Date.now() });
  }
  stop(): void {}
}
class FakeScreener extends EventEmitter implements HeldPositionScreener {
  async screenHeldPosition(): Promise<unknown> {
    return { verdict: 'pass' };
  }
}
class FakeScheduler implements Scheduler {
  setInterval(): unknown {
    return 0;
  }
  clearInterval(): void {}
}

interface HarnessOptions {
  strategy?: Strategy;
  config?: Record<string, unknown>;
  dbPath?: string;
  ledger?: Ledger;
  runtime?: RuntimeState;
  quote?: (request: QuoteRequest) => Quote | QuoteError;
  canSell?: (mint: string) => Promise<{ ok: boolean; reason?: string }>;
  timeoutMs?: number;
  runId?: string;
}

interface Harness {
  tracker: Tracker;
  runner: StrategyRunner;
  config: Config;
  ledger: Ledger;
  runtime: RuntimeState;
  stream: FakeStream;
  events: TrackerEventRecord[];
  close(): void;
}

function quoteOf(request: QuoteRequest, out: bigint): Quote {
  return {
    inMint: request.inMint,
    outMint: request.outMint,
    inAmount: request.inAmount,
    outAmount: out,
    priceImpactPct: 0.1,
    routePlan: [],
    fetchedAt: NOW,
  };
}

function harness(options: HarnessOptions = {}): Harness {
  const config = parseConfig({ trackedWallets: [], ...(options.config ?? {}) });
  const ledger =
    options.ledger ??
    openLedger({
      path: options.dbPath ?? ':memory:',
      logger: { info: () => undefined, warn: () => undefined },
    });
  const runtime = options.runtime ?? openRuntimeState({ path: options.dbPath ?? ':memory:' });

  const quotes: QuoteSource = {
    getQuote: async (request) => options.quote?.(request) ?? quoteOf(request, 1_000_000_000n),
  };
  const resolveDecimals = createDecimalsResolver(
    fixtureDecimalsSource({ [MINT_A]: DECIMALS, [MINT_B]: DECIMALS }),
  );

  let clock = NOW;
  const broker = createPaperBroker({
    quoteSource: quotes,
    resolveDecimals,
    ledger,
    config,
    latencyMs: 0,
    now: () => (clock += 1),
    canSell: options.canSell ?? (async () => ({ ok: true })),
  });

  const tracker = new Tracker({
    config,
    ledger,
    runtime,
    broker,
    screener: new FakeScreener(),
    quotes,
    stream: new FakeStream(),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    scheduler: new FakeScheduler(),
    now: () => NOW,
  });

  const runner = new StrategyRunner({
    strategy: options.strategy ?? createMirrorStrategy(),
    config,
    quotes,
    resolveDecimals,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => NOW,
    runId: options.runId ?? 'run',
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    host: {
      getState: () => tracker.getState(),
      openPositions: () => ledger.getOpenPositions(),
      balanceLamports: () => broker.getBalanceLamports(),
      submit: (intent) => tracker.submit(intent),
    },
  });
  tracker.useStrategy(runner);

  const events: TrackerEventRecord[] = [];
  tracker.on('event', (event: TrackerEventRecord) => events.push(event));

  const stream = tracker['deps'].stream as FakeStream;

  return {
    tracker,
    runner,
    config,
    ledger,
    runtime,
    stream,
    events,
    close() {
      if (options.ledger === undefined) ledger.close();
      if (options.runtime === undefined) runtime.close();
    },
  };
}

const open_: Harness[] = [];
function open(options: HarnessOptions = {}): Harness {
  const created = harness(options);
  open_.push(created);
  return created;
}
afterEach(() => {
  while (open_.length > 0) open_.pop()?.close();
});

function seedPosition(ledger: Ledger, overrides: Partial<SimulatedFill> = {}): void {
  ledger.recordFill({
    intentId: 'seed',
    side: 'buy',
    mint: MINT_A,
    tokensDelta: 1_000_000_000n,
    lamportsDelta: -50_000_000n,
    decimals: DECIMALS,
    feesLamports: 0n,
    slippageBps: 0,
    simulated: true,
    at: NOW,
    ...overrides,
  });
}

/** A strategy that does exactly what the test tells it to. */
function scripted(
  onSwap: (swap: TrackedSwap, ctx: Context) => Promise<IntentDraft | null>,
  onTick: (p: Position, price: number, ctx: Context) => Promise<IntentDraft | null> = async () =>
    null,
  name = 'mirror',
): Strategy {
  return { name, onTrackedSwap: onSwap, onPriceTick: onTick };
}

// ---------------------------------------------------------------------------
// The runner treats the strategy as untrusted
// ---------------------------------------------------------------------------

describe('the strategy is untrusted', () => {
  it('turns a throw into a strategy-error and treats it as null', async () => {
    const h = open({
      strategy: scripted(async () => {
        throw new Error('strategy exploded');
      }),
    });
    await h.tracker.start();

    await h.runner.onTrackedSwap(swapOf());

    const event = h.events.find((record) => record.type === 'strategy-error');
    expect(event?.data).toMatchObject({
      strategy: 'mirror',
      hook: 'onTrackedSwap',
      kind: 'throw',
      message: 'strategy exploded',
    });
    expect(h.runner.stats.throws).toBe(1);
    expect(h.ledger.getPositions()).toHaveLength(0);
  });

  it('TIMES OUT a strategy that never answers, and counts it separately', async () => {
    const h = open({
      timeoutMs: 20,
      strategy: scripted(() => new Promise(() => undefined)),
    });
    await h.tracker.start();

    // Resolves at the timeout even though the strategy never will. If this
    // hangs, the price loop hangs with it.
    await h.runner.onTrackedSwap(swapOf());

    const event = h.events.find((record) => record.type === 'strategy-error');
    expect(event?.data).toMatchObject({ kind: 'timeout' });
    // Counted apart from a throw: a strategy that raises is broken logic, one
    // that hangs is doing I/O it was told not to do. Different fixes.
    expect(h.runner.stats.timeouts).toBe(1);
    expect(h.runner.stats.throws).toBe(0);
  });

  it('makes a wedged strategy distinguishable from a quiet one', async () => {
    // Both produce no intent. The only thing that tells an operator "the
    // strategy is stuck" rather than "the strategy sees nothing to do" is the
    // event, so silence on a timeout is the failure mode that matters.
    const quiet = open({ strategy: scripted(async () => null) });
    await quiet.tracker.start();
    await quiet.runner.onTrackedSwap(swapOf());
    expect(quiet.events.filter((r) => r.type === 'strategy-error')).toHaveLength(0);

    const wedged = open({ timeoutMs: 20, strategy: scripted(() => new Promise(() => undefined)) });
    await wedged.tracker.start();
    await wedged.runner.onTrackedSwap(swapOf());

    const errors = wedged.events.filter((r) => r.type === 'strategy-error');
    expect(errors).toHaveLength(1);
    // And it names which failure it was: a strategy that raises is broken
    // logic, one that hangs is doing I/O it was told not to do.
    expect(errors[0]?.data).toMatchObject({ kind: 'timeout', hook: 'onTrackedSwap' });
  });

  it('DISCARDS a draft that arrives after the timeout', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const h = open({
      timeoutMs: 20,
      strategy: scripted(async () => {
        await gate;
        return {
          side: 'buy',
          mint: MINT_A,
          amountLamports: solToLamports(0.05),
          maxSlippageBps: 300,
          reason: 'too late',
        };
      }),
    });
    await h.tracker.start();

    const call = h.runner.onTrackedSwap(swapOf());
    await new Promise((resolve) => setTimeout(resolve, 40));
    release();
    await call;

    // We already answered `null` for this event. Acting on the late draft would
    // act on a decision made against a context that has since moved on.
    expect(h.ledger.getPositions()).toHaveLength(0);
    expect(h.runner.stats.submitted).toBe(0);
  });

  it('keeps the mint locked until a timed-out call actually finishes', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const h = open({
      timeoutMs: 20,
      strategy: scripted(async () => {
        calls += 1;
        await gate;
        return null;
      }),
    });
    await h.tracker.start();

    const first = h.runner.onTrackedSwap(swapOf());
    await new Promise((resolve) => setTimeout(resolve, 40));

    // The first call timed out but is still running. A second call now would
    // leak one live invocation per tick for as long as the strategy stays
    // wedged; holding the lock costs one mint and is visible in the stats.
    await h.runner.onTrackedSwap(swapOf());
    expect(calls).toBe(1);
    expect(h.runner.stats.skippedLocked).toBe(1);

    release();
    await first;
    // The lock is released off the wedged call's own settlement, which is a
    // couple of microtask hops after the gate opens.
    await new Promise((resolve) => setImmediate(resolve));

    // And it recovers once the wedged call finally lands — the mint is locked,
    // not permanently poisoned.
    await h.runner.onTrackedSwap(swapOf());
    expect(calls).toBe(2);
  });

  it('does not let a WEDGED strategy stall the price loop', async () => {
    // The hook must resolve at the timeout even though the strategy never will.
    // The tracker awaits `onPriceTick` inside the loop, so a hook that waited
    // for the wedged call would stop the loop dead — and the loop is what marks
    // positions and raises `route-lost`, which is all an operator has left when
    // the strategy is broken.
    const h = open({ timeoutMs: 20, strategy: scripted(async () => null, () => new Promise(() => undefined)) });
    seedPosition(h.ledger);
    seedPosition(h.ledger, { intentId: 'seed-b', mint: MINT_B, at: NOW + 1 });
    await h.tracker.start();

    await h.tracker.priceTick();

    // Both positions marked, both wedged calls reported, loop still alive.
    expect(h.tracker.positions().every((entry) => entry.markLamportsPerToken !== null)).toBe(true);
    expect(h.runner.stats.timeouts).toBe(2);
    expect(h.tracker.stats.priceTicks).toBe(1);

    // And a second tick still runs — the mints stay locked, so it is skipped
    // rather than piling a second wedged call on top of the first.
    await h.tracker.priceTick();
    expect(h.tracker.stats.priceTicks).toBe(2);
    expect(h.runner.stats.skippedLocked).toBe(2);
  });

  it('does not let a strategy failure stop the price loop', async () => {
    const h = open({
      strategy: scripted(async () => null, async () => {
        throw new Error('tick exploded');
      }),
    });
    seedPosition(h.ledger);
    seedPosition(h.ledger, { intentId: 'seed-b', mint: MINT_B, at: NOW + 1 });
    await h.tracker.start();

    await h.tracker.priceTick();

    // Both positions were still marked, and both failures were reported. The
    // alerting the price loop provides is exactly what an operator is left with
    // when the strategy is broken.
    expect(h.events.filter((record) => record.type === 'strategy-error')).toHaveLength(2);
    expect(h.tracker.positions().every((entry) => entry.markLamportsPerToken !== null)).toBe(true);
  });

  it('does not let a strategy failure change bot state', async () => {
    const h = open({
      strategy: scripted(async () => {
        throw new Error('boom');
      }),
    });
    await h.tracker.start();
    await h.runner.onTrackedSwap(swapOf());

    expect(h.tracker.getState()).toMatchObject({ status: 'running', killSwitchEngaged: false });
  });
});

// ---------------------------------------------------------------------------
// Per-mint serialization
// ---------------------------------------------------------------------------

describe('serialized per mint', () => {
  it('runs at most one call per mint at a time', async () => {
    let concurrent = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const h = open({
      strategy: scripted(async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await gate;
        concurrent -= 1;
        return null;
      }),
    });
    await h.tracker.start();

    const calls = [
      h.runner.onTrackedSwap(swapOf()),
      h.runner.onTrackedSwap(swapOf()),
      h.runner.onTrackedSwap(swapOf()),
    ];
    release();
    await Promise.all(calls);

    expect(peak).toBe(1);
    // Skipped, not queued. `onPriceTick` fires every 2 seconds and a backlog
    // against a slow strategy only ever gets further behind.
    expect(h.runner.stats.skippedLocked).toBe(2);
  });

  it('does NOT serialize across different mints', async () => {
    let concurrent = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const h = open({
      strategy: scripted(async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await gate;
        concurrent -= 1;
        return null;
      }),
    });
    await h.tracker.start();

    const calls = [
      h.runner.onTrackedSwap(swapOf({ mint: MINT_A })),
      h.runner.onTrackedSwap(swapOf({ mint: MINT_B })),
    ];
    release();
    await Promise.all(calls);

    // A lock per mint, not a global one: one slow mint must not stall the
    // decision to exit a different position.
    expect(peak).toBe(2);
    expect(h.runner.stats.skippedLocked).toBe(0);
  });

  it('releases the lock after a normal call so the next tick runs', async () => {
    let calls = 0;
    const h = open({
      strategy: scripted(async () => {
        calls += 1;
        return null;
      }),
    });
    await h.tracker.start();

    await h.runner.onTrackedSwap(swapOf());
    await h.runner.onTrackedSwap(swapOf());
    await h.runner.onTrackedSwap(swapOf());

    expect(calls).toBe(3);
    expect(h.runner.stats.skippedLocked).toBe(0);
  });

  it('releases the lock after a throw', async () => {
    let calls = 0;
    const h = open({
      strategy: scripted(async () => {
        calls += 1;
        throw new Error('boom');
      }),
    });
    await h.tracker.start();

    await h.runner.onTrackedSwap(swapOf());
    await h.runner.onTrackedSwap(swapOf());

    expect(calls).toBe(2);
  });

  it('holds the lock across the submit, not just the strategy call', async () => {
    // Otherwise a second call could start while the first intent is executing,
    // and produce a duplicate the guard layer would then reject — polluting the
    // rejection counts with something the runner caused.
    let inStrategy = 0;
    const h = open({
      strategy: scripted(async () => {
        inStrategy += 1;
        return {
          side: 'buy',
          mint: MINT_A,
          amountLamports: solToLamports(0.05),
          maxSlippageBps: 300,
          reason: 'test',
        };
      }),
    });
    await h.tracker.start();

    await Promise.all([h.runner.onTrackedSwap(swapOf()), h.runner.onTrackedSwap(swapOf())]);

    expect(inStrategy).toBe(1);
    expect(h.ledger.getOpenPositions()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The context is read-only
// ---------------------------------------------------------------------------

describe('the context is frozen', () => {
  async function captured(positions = 1): Promise<Context> {
    let seen!: Context;
    const h = open({
      strategy: scripted(async (_swap, ctx) => {
        seen = ctx;
        return null;
      }),
    });
    if (positions > 0) seedPosition(h.ledger);
    await h.tracker.start();
    await h.runner.onTrackedSwap(swapOf());
    return seen;
  }

  it('refuses a write to a Position', async () => {
    const ctx = await captured();
    const first = ctx.positions[0] as Position;
    // The ledger is the only thing allowed to decide what a position is; a
    // strategy that could edit one could assert a holding rather than derive it.
    expect(() => {
      (first as { tokens: bigint }).tokens = 0n;
    }).toThrow(TypeError);
    expect(() => {
      (first as { state: string }).state = 'closed';
    }).toThrow(TypeError);
  });

  it('refuses a write to the positions array', async () => {
    const ctx = await captured();
    expect(() => (ctx.positions as Position[]).push(position())).toThrow(TypeError);
    expect(() => {
      (ctx.positions as Position[])[0] = position({ tokens: 0n });
    }).toThrow(TypeError);
  });

  it('refuses a write to the context itself', async () => {
    const ctx = await captured(0);
    expect(() => {
      (ctx as { balanceSol: number }).balanceSol = 999;
    }).toThrow(TypeError);
  });

  it('refuses a write to the config, and leaves the real config untouched', async () => {
    const ctx = await captured(0);
    expect(() => {
      (ctx.config as { positionSizeSol: number }).positionSizeSol = 100;
    }).toThrow(TypeError);
    expect(ctx.config.positionSizeSol).toBe(0.05);
  });

  it('a strategy cannot act on a position it edited under itself', async () => {
    // The operational shape of the freeze. A strategy that miscalculates,
    // writes the result back onto the Position, and then sizes an order from it
    // would exit 1 base unit of a 1,000,000,000-unit holding — leaving the
    // position open, occupying a concurrency slot, on a signal that has already
    // fired and will not fire again.
    const h = open({
      strategy: scripted(async (_swap, ctx) => {
        const first = ctx.positions[0];
        if (first === undefined) return null;
        try {
          (first as { tokens: bigint }).tokens = 1n;
        } catch {
          /* a strategy may swallow it; the write must still not land */
        }
        return {
          side: 'sell',
          mint: first.mint,
          amountTokens: first.tokens,
          maxSlippageBps: ctx.config.maxSlippageBps,
          reason: 'sized after tampering',
        };
      }),
    });
    seedPosition(h.ledger);
    await h.tracker.start();

    await h.runner.onTrackedSwap(swapOf({ side: 'sell' }));

    // The full holding was sold, and the position is closed.
    const fill = h.events.find((record) => record.type === 'fill');
    expect((fill?.data as { tokensDelta: bigint }).tokensDelta).toBe(-1_000_000_000n);
    expect(h.ledger.getPosition(MINT_A)?.state).toBe('closed');
  });

  it('a strategy cannot widen the risk limits the guard layer enforces', async () => {
    const h = open({
      strategy: scripted(async (_swap, ctx) => {
        try {
          (ctx.config as { positionSizeSol: number }).positionSizeSol = 4.9;
          (ctx.config as { maxConcurrentPositions: number }).maxConcurrentPositions = 999;
        } catch {
          /* swallowed on purpose */
        }
        return {
          side: 'buy',
          mint: MINT_A,
          amountLamports: solToLamports(ctx.config.positionSizeSol),
          maxSlippageBps: ctx.config.maxSlippageBps,
          reason: 'after tampering',
        };
      }),
    });
    await h.tracker.start();
    await h.runner.onTrackedSwap(swapOf());

    // The buy went through at the configured size, not the tampered one. A
    // shared, writable config would have let a strategy raise its own position
    // size past the gas reserve that guard gate 3 is computing against.
    const fill = h.events.find((record) => record.type === 'fill');
    expect((fill?.data as { lamportsDelta: bigint }).lamportsDelta).toBe(-solToLamports(0.05));
  });

  it('does not hand the same object twice — the context is rebuilt per call', async () => {
    const contexts: Context[] = [];
    const h = open({
      strategy: scripted(async (_swap, ctx) => {
        contexts.push(ctx);
        return null;
      }),
    });
    await h.tracker.start();
    await h.runner.onTrackedSwap(swapOf());
    await h.runner.onTrackedSwap(swapOf());

    // A strategy that stashes a context reads a stale snapshot, not live state.
    expect(contexts[0]).not.toBe(contexts[1]);
  });

  it('reports the live balance and positions', async () => {
    let seen!: Context;
    const h = open({
      strategy: scripted(async (_swap, ctx) => {
        seen = ctx;
        return null;
      }),
    });
    seedPosition(h.ledger);
    await h.tracker.start();
    await h.runner.onTrackedSwap(swapOf());

    expect(seen.positions).toHaveLength(1);
    expect(seen.positions[0]?.mint).toBe(MINT_A);
    // 5 SOL start, less the 0.05 SOL seed buy.
    expect(seen.balanceSol).toBeCloseTo(4.95, 9);
  });
});

// ---------------------------------------------------------------------------
// getPriceSol
// ---------------------------------------------------------------------------

describe('ctx.getPriceSol', () => {
  async function priceVia(options: HarnessOptions, mint = MINT_A): Promise<number | QuoteError> {
    let result!: number | QuoteError;
    const h = open({
      ...options,
      strategy: scripted(async (_swap, ctx) => {
        result = await ctx.getPriceSol(mint);
        return null;
      }),
    });
    await h.tracker.start();
    await h.runner.onTrackedSwap(swapOf());
    return result;
  }

  it('derives SOL per whole token from a real probe quote', async () => {
    // 0.1 SOL probe returning 1e9 base units at 6 decimals = 1000 whole tokens,
    // so 0.1 / 1000 = 0.0001 SOL each.
    const price = await priceVia({ quote: (request) => quoteOf(request, 1_000_000_000n) });
    expect(price).toBeCloseTo(0.0001, 12);
  });

  it('returns the QuoteError rather than throwing or a sentinel', async () => {
    const price = await priceVia({
      quote: () => ({ error: 'NO_ROUTE', message: 'TOKEN_NOT_TRADABLE' }),
    });
    // A `0` or a `NaN` would be indistinguishable from a real price at exactly
    // the point it matters most.
    expect(price).toEqual({ error: 'NO_ROUTE', message: 'TOKEN_NOT_TRADABLE' });
  });

  it('reports a zero-output probe as NO_ROUTE, not as a price of zero', async () => {
    const price = await priceVia({ quote: (request) => quoteOf(request, 0n) });
    expect(price).toMatchObject({ error: 'NO_ROUTE' });
  });

  it('reports an unresolvable mint as an error rather than guessing a scale', async () => {
    // Decimals wrong by three or nine orders of magnitude misstates everything
    // downstream. `mintMetadata.ts` refuses to guess and so does this.
    const price = await priceVia({}, 'UnknownMint1111111111111111111111111111111');
    expect(price).toMatchObject({ error: 'UPSTREAM_ERROR' });
  });

  it('probes with the configured size against WSOL', async () => {
    const seen: QuoteRequest[] = [];
    await priceVia({
      quote: (request) => {
        seen.push(request);
        return quoteOf(request, 1_000_000_000n);
      },
    });
    expect(seen[0]).toMatchObject({
      inMint: WRAPPED_SOL_MINT,
      outMint: MINT_A,
      inAmount: 100_000_000n,
    });
  });
});

// ---------------------------------------------------------------------------
// Behaviour by bot state
// ---------------------------------------------------------------------------

describe('behaviour by bot state', () => {
  function counting() {
    const calls = { swap: 0, tick: 0 };
    const strategy = scripted(
      async () => {
        calls.swap += 1;
        return null;
      },
      async () => {
        calls.tick += 1;
        return null;
      },
    );
    return { calls, strategy };
  }

  it('running: both hooks are called', async () => {
    const { calls, strategy } = counting();
    const h = open({ strategy });
    seedPosition(h.ledger);
    await h.tracker.start();

    h.stream.emit('swap', swapOf());
    // Let the swap call settle first. Both hooks are for the same mint, and the
    // per-mint lock would otherwise (correctly) skip the tick — which is a
    // different behaviour from the one under test here.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await h.tracker.priceTick();

    expect(calls).toEqual({ swap: 1, tick: 1 });
  });

  it('IDLE with open positions: onPriceTick yes, onTrackedSwap NO', async () => {
    const { calls, strategy } = counting();
    const h = open({ strategy });
    seedPosition(h.ledger);
    await h.tracker.start();
    await h.tracker.stop();
    expect(h.tracker.getState().status).toBe('idle');

    h.stream.emit('swap', swapOf());
    await new Promise((resolve) => setImmediate(resolve));
    await h.tracker.priceTick();

    // `stop()` means "no new exposure". A swap that could still open a position
    // after it would make stop a suggestion. Exits keep working.
    expect(calls).toEqual({ swap: 0, tick: 1 });
  });

  it('stopping: onPriceTick yes, onTrackedSwap NO', async () => {
    const { calls, strategy } = counting();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // A sell for MINT_B whose quote hangs, so the bot is genuinely stuck in
    // `stopping` — `stop()` waits for in-flight intents — while the assertions
    // below run.
    const h = open({
      strategy,
      quote: (request) => {
        if (request.inMint === MINT_B) {
          return { error: 'TIMEOUT', message: 'held open by the test' };
        }
        return quoteOf(request, 1_000_000_000n);
      },
    });
    seedPosition(h.ledger);
    seedPosition(h.ledger, { intentId: 'seed-b', mint: MINT_B, at: NOW + 1 });
    await h.tracker.start();

    const holder = h.tracker
      .submit({
        id: 'holder',
        side: 'sell',
        mint: MINT_B,
        amountTokens: 1_000_000_000n,
        maxSlippageBps: 300,
        reason: 'holder',
      })
      .catch(() => undefined);

    const stopping = h.tracker.stop();
    expect(h.tracker.getState().status).toBe('stopping');

    h.stream.emit('swap', swapOf());
    await new Promise((resolve) => setTimeout(resolve, 20));
    await h.tracker.priceTick();

    expect(calls).toEqual({ swap: 0, tick: 1 });

    release();
    await gate;
    await holder;
    await stopping;
  });

  it('kill switch engaged: BOTH hooks still called', async () => {
    const { calls, strategy } = counting();
    const h = open({ strategy });
    seedPosition(h.ledger);
    await h.tracker.start();
    h.tracker.killSwitch();

    h.stream.emit('swap', swapOf());
    await new Promise((resolve) => setImmediate(resolve));
    await h.tracker.priceTick();

    // Not pre-filtered. The strategy is asked, the intent is written, and
    // `guards.ts` rejects it with a code — which is what Prompt 12 counts.
    expect(calls).toEqual({ swap: 1, tick: 1 });
  });

  it('kill switch: a buy is rejected by GUARDS and lands in the intents table', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strategy-kill-'));
    const dbPath = join(dir, 't.db');
    const ledger = openLedger({
      path: dbPath,
      logger: { info: () => undefined, warn: () => undefined },
    });

    try {
      const h = open({ dbPath, ledger });
      await h.tracker.start();
      h.tracker.killSwitch();

      h.stream.emit('swap', swapOf());
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const rejection = h.events.find((record) => record.type === 'rejection');
      expect(rejection?.data).toMatchObject({ code: 'KILL_SWITCH_ENGAGED', mint: MINT_A });
      ledger.close();

      // A runner that silently swallowed the entry would make Prompt 12's
      // report describe a bot that never asked.
      const raw = new Database(dbPath, { readonly: true });
      const row = raw
        .prepare(`SELECT id, status, rejection_code FROM intents WHERE side = 'buy'`)
        .get() as { id: string; status: string; rejection_code: string };
      raw.close();
      expect(row).toMatchObject({ status: 'rejected', rejection_code: 'KILL_SWITCH_ENGAGED' });
      expect(row.id).toMatch(/^mirror-run-\d{5}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The exits that must survive stop() and the kill switch
// ---------------------------------------------------------------------------

describe('a -40% stop fires when entries cannot', () => {
  /** A quote source where the exit is worth 40% less than the 0.05 SOL entry. */
  const crashed = (request: QuoteRequest): Quote =>
    request.inMint === WRAPPED_SOL_MINT
      ? quoteOf(request, 1_000_000_000n)
      : quoteOf(request, 30_000_000n);

  it('fires, executes and SETTLES after stop() has returned the bot to idle', async () => {
    const h = open({ quote: crashed });
    seedPosition(h.ledger);
    await h.tracker.start();
    await h.tracker.stop();
    expect(h.tracker.getState().status).toBe('idle');

    await h.tracker.priceTick();

    // Entry 0.05 SOL for 1000 tokens = 0.00005 each. Exit quote 0.03 SOL for
    // the lot = 0.00003 each, a 40% fall exactly on the boundary.
    const position = h.ledger.getPosition(MINT_A);
    expect(position?.state).toBe('closed');
    expect(position?.tokens).toBe(0n);

    const fill = h.events.find((record) => record.type === 'fill');
    expect(fill?.data).toMatchObject({ side: 'sell', mint: MINT_A });
    const intent = h.events.find((record) => record.type === 'intent-created');
    expect((intent?.data as { reason: string }).reason).toMatch(/^stop: -40\.0% from 0\.00005$/);
  });

  it('fires with the kill switch engaged AND persisted across a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strategy-stop-'));
    const dbPath = join(dir, 't.db');

    try {
      // Run one: engage the kill switch and take a position.
      const first = harness({ dbPath, quote: crashed });
      seedPosition(first.ledger);
      first.tracker.killSwitch();
      expect(first.tracker.getState().killSwitchEngaged).toBe(true);
      first.close();

      // Run two: a new process reading the same file.
      const second = harness({ dbPath, quote: crashed, runId: 'run2' });
      try {
        expect(second.tracker.getState().killSwitchEngaged).toBe(true);
        await second.tracker.start();
        await second.tracker.stop();

        await second.tracker.priceTick();

        // A risk limit exists to stop the bot acquiring exposure. Applying one
        // to an exit would trap it in the position the limit warned about —
        // and it survived a restart, a stop, and an engaged kill switch.
        expect(second.ledger.getPosition(MINT_A)?.state).toBe('closed');
        expect(second.tracker.getState()).toMatchObject({
          status: 'idle',
          killSwitchEngaged: true,
        });
      } finally {
        second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a +150% take-profit fires the same way', async () => {
    const h = open({
      quote: (request) =>
        request.inMint === WRAPPED_SOL_MINT
          ? quoteOf(request, 1_000_000_000n)
          : quoteOf(request, 125_000_000n),
    });
    seedPosition(h.ledger);
    await h.tracker.start();
    await h.tracker.stop();

    await h.tracker.priceTick();

    expect(h.ledger.getPosition(MINT_A)?.state).toBe('closed');
    const intent = h.events.find((record) => record.type === 'intent-created');
    expect((intent?.data as { reason: string }).reason).toBe('take: +150.0% from 0.00005');
  });

  it('fires on the FIRST tick that crosses, and only that one', async () => {
    // The operational shape of a threshold: it does not re-fire while the
    // position is being exited, and it does not fire early.
    let price = 0n;
    const h = open({
      quote: (request) =>
        request.inMint === WRAPPED_SOL_MINT
          ? quoteOf(request, 1_000_000_000n)
          : quoteOf(request, price),
    });
    seedPosition(h.ledger);
    await h.tracker.start();

    // -10%, then -39%, then -41%.
    for (const out of [45_000_000n, 30_500_000n, 29_500_000n]) {
      price = out;
      await h.tracker.priceTick();
    }

    const intents = h.events.filter((record) => record.type === 'intent-created');
    expect(intents).toHaveLength(1);
    expect((intents[0]?.data as { reason: string }).reason).toBe('stop: -41.0% from 0.00005');

    // A fourth tick has nothing left to sell.
    await h.tracker.priceTick();
    expect(h.events.filter((record) => record.type === 'intent-created')).toHaveLength(1);
  });

  it('holds inside the band', async () => {
    const h = open({
      quote: (request) =>
        request.inMint === WRAPPED_SOL_MINT
          ? quoteOf(request, 1_000_000_000n)
          : quoteOf(request, 45_000_000n),
    });
    seedPosition(h.ledger);
    await h.tracker.start();

    await h.tracker.priceTick();

    expect(h.ledger.getPosition(MINT_A)?.state).toBe('open');
    expect(h.events.filter((record) => record.type === 'intent-created')).toHaveLength(0);
  });

  it('does not fire on a NO_ROUTE tick — route-lost is an alert, not a signal', async () => {
    const h = open({
      quote: (request) =>
        request.inMint === WRAPPED_SOL_MINT
          ? quoteOf(request, 1_000_000_000n)
          : { error: 'NO_ROUTE', message: 'TOKEN_NOT_TRADABLE' },
    });
    seedPosition(h.ledger);
    await h.tracker.start();

    await h.tracker.priceTick();

    // The strategy is not even consulted: with no price there is no signal, and
    // panic-selling an unroutable position is not possible anyway.
    expect(h.runner.stats.ticks).toBe(0);
    expect(h.ledger.getPosition(MINT_A)?.state).toBe('open');
    expect(h.events.some((record) => record.type === 'route-lost')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The full mirror path
// ---------------------------------------------------------------------------

describe('mirror end to end through guards and the ledger', () => {
  it('opens a position when a tracked wallet buys', async () => {
    const h = open();
    await h.tracker.start();

    h.stream.emit('swap', swapOf());
    await new Promise((resolve) => setTimeout(resolve, 20));

    const position = h.ledger.getPosition(MINT_A);
    expect(position?.state).toBe('open');
    expect(position?.tokens).toBe(997_000_000n);
  });

  it('closes it when the tracked wallet sells', async () => {
    const h = open();
    seedPosition(h.ledger);
    await h.tracker.start();

    h.stream.emit('swap', swapOf({ side: 'sell' }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(h.ledger.getPosition(MINT_A)?.state).toBe('closed');
  });

  it('creates NOTHING when a wallet sells a mint we never held', async () => {
    const h = open();
    await h.tracker.start();

    h.stream.emit('swap', swapOf({ side: 'sell' }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(h.events.filter((record) => record.type === 'intent-created')).toHaveLength(0);
    expect(h.events.filter((record) => record.type === 'rejection')).toHaveLength(0);
  });

  it("the ledger never reports 'closing' — SELL_IN_FLIGHT is the live protection", async () => {
    const h = open();
    seedPosition(h.ledger);
    await h.tracker.start();

    // `PositionState` has three values but `replayMint` only ever writes two:
    // `tokens > 0n ? 'open' : 'closed'`. Nothing in services sets 'closing'
    // either, so mirror's 'closing' branch is future-proofing, not live
    // behaviour. See docs/handoffs/10-strategy.md.
    expect(h.ledger.getPositions().map((entry) => entry.state)).toEqual(['open']);

    // What actually stops a double exit today is guard exit gate 2, claimed
    // synchronously before any await.
    const sell = (id: string) =>
      h.tracker.submit({
        id,
        side: 'sell',
        mint: MINT_A,
        amountTokens: 1_000_000_000n,
        maxSlippageBps: 300,
        reason: 'concurrent',
      });
    const [first, second] = await Promise.allSettled([sell('exit-1'), sell('exit-2')]);

    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    expect((second as PromiseRejectedResult).reason).toMatchObject({ code: 'SELL_IN_FLIGHT' });
  });

  it('creates NOTHING when a second wallet buys a mint we hold', async () => {
    const h = open();
    seedPosition(h.ledger);
    await h.tracker.start();

    h.stream.emit('swap', swapOf({ wallet: WALLET_2 }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Guards would have said ALREADY_HOLDING. A rejection row here would be
    // self-inflicted noise in exactly the table Prompt 12 reads.
    expect(h.events.filter((record) => record.type === 'intent-created')).toHaveLength(0);
    expect(h.events.filter((record) => record.type === 'rejection')).toHaveLength(0);
    expect(h.ledger.getPosition(MINT_A)?.tokens).toBe(1_000_000_000n);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  const SWAPS: TrackedSwap[] = [
    swapOf({ mint: MINT_A, side: 'buy', signature: 's1' }),
    swapOf({ mint: MINT_B, side: 'buy', signature: 's2', wallet: WALLET_2 }),
    swapOf({ mint: MINT_A, side: 'sell', signature: 's3', solAmount: 123_000_000n }),
    swapOf({
      mint: MINT_B,
      side: 'sell',
      signature: 's4',
      solAmount: 456_000_000n,
      wallet: WALLET_2,
    }),
  ];

  async function runOnce(): Promise<Array<{ id: string; reason: string; side: string }>> {
    const h = open({ runId: 'fixed' });
    await h.tracker.start();

    for (const swap of SWAPS) {
      h.stream.emit('swap', swap);
      // Sequenced deliberately: the replay promise is about the same inputs in
      // the same order producing the same output, not about racing them.
      await new Promise((resolve) => setTimeout(resolve, 15));
    }

    return h.events
      .filter((record) => record.type === 'intent-created')
      .map((record) => record.data as { id: string; reason: string; side: string })
      .map(({ id, reason, side }) => ({ id, reason, side }));
  }

  it('yields identical ids, reasons and ordering across two runs', async () => {
    const first = await runOnce();
    const second = await runOnce();

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });

  it('produces the exact sequence, so a change to it is visible in review', async () => {
    const run = await runOnce();
    expect(run).toEqual([
      { id: 'mirror-fixed-00001', side: 'buy', reason: 'mirror: 7xKX..sU bought 0.41 SOL' },
      { id: 'mirror-fixed-00002', side: 'buy', reason: 'mirror: BQ72..MY bought 0.41 SOL' },
      { id: 'mirror-fixed-00003', side: 'sell', reason: 'mirror: 7xKX..sU sold 0.123 SOL' },
      { id: 'mirror-fixed-00004', side: 'sell', reason: 'mirror: BQ72..MY sold 0.456 SOL' },
    ]);
  });

  it('ids are monotonic within a run', async () => {
    const run = await runOnce();
    const seqs = run.map((entry) => Number(entry.id.split('-').at(-1)));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('DISAMBIGUATES ids between runs, so a restart cannot collide', async () => {
    // The hazard is concrete: the ledger keys a simulated fill on
    // `intentId:mint` and `recordIntent` is INSERT OR IGNORE. A counter that
    // restarted at 1 each boot would write an id that already exists, the
    // insert would silently no-op, and the fill would collide with the previous
    // run's — a dropped fill with no error anywhere.
    const a = new StrategyRunner({
      strategy: createMirrorStrategy(),
      config: parseConfig({}),
      quotes: { getQuote: async (request) => quoteOf(request, 1n) },
      resolveDecimals: async () => DECIMALS,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      now: () => NOW,
      host: {
        getState: () => ({ mode: 'paper', status: 'running', killSwitchEngaged: false }),
        openPositions: () => [],
        balanceLamports: async () => 0n,
        submit: async () => {
          throw new Error('unused');
        },
      },
    });
    const b = new StrategyRunner({
      strategy: createMirrorStrategy(),
      config: parseConfig({}),
      quotes: { getQuote: async (request) => quoteOf(request, 1n) },
      resolveDecimals: async () => DECIMALS,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      now: () => NOW + 1,
      host: {
        getState: () => ({ mode: 'paper', status: 'running', killSwitchEngaged: false }),
        openPositions: () => [],
        balanceLamports: async () => 0n,
        submit: async () => {
          throw new Error('unused');
        },
      },
    });

    expect(a['runId']).not.toBe(b['runId']);
    // …and still deterministic: the same injected clock gives the same runId,
    // which is what makes a replay byte-identical rather than merely similar.
    expect(a['runId']).toBe(String(NOW));
  });
});

// ---------------------------------------------------------------------------
// Malformed intents — the ten-case matrix
// ---------------------------------------------------------------------------

/**
 * Every case terminates in a typed `GuardRejection` or a committed fill.
 *
 * ── WHAT THESE TESTS SAID BEFORE 2026-08-03 ───────────────────────────────
 *
 * Prompt 10 measured this matrix against a guard layer that validated risk but
 * not well-formedness, and pinned what it found. One case produced a
 * `GuardRejection`; the rest died further down, and two were not stopped at
 * all. The old expectations, kept because they are the reason the gate exists:
 *
 *   negative / zero / absent buy amount   RangeError from the paper broker,
 *                                         intent `failed`, code `RangeError`
 *   negative sell amount                  RangeError from the paper broker
 *   NaN buy amount                        TypeError "Cannot mix BigInt and
 *                                         other types" from guard gate 3;
 *                                         nothing written to the ledger at all
 *   non-base58 mint / null mint           QuoteUnavailableError NO_ROUTE from
 *                                         the quote adapter — indistinguishable
 *                                         from a real token that briefly had no
 *                                         route
 *   sell with no position                 GuardRejection NO_OPEN_POSITION
 *                                         (the only one that was already right)
 *   oversell by 1000x                     FILLED. Position correctly closed by
 *                                         the ledger's clamp, but the fill row
 *                                         recorded tokensDelta
 *                                         -999,999,999,999 and the paper wallet
 *                                         was credited the full proceeds:
 *                                         balance 4.95 -> 5.947 SOL, +0.997 SOL
 *                                         conjured from tokens never held
 *   NaN sell amount                       "FILLED" — a Fill returned,
 *                                         `intent-created` and `fill` emitted,
 *                                         and NOTHING in the ledger, because
 *                                         `INSERT OR IGNORE` swallowed the
 *                                         NOT NULL violation on both rows
 *
 * `RangeError`, `TypeError` and `NO_ROUTE` were accidents, not defenses. None
 * of them is reachable from this matrix any more.
 */
describe('malformed intents: the ten-case matrix', () => {
  interface Outcome {
    label: string;
    /** The `GuardCode` it was refused with, or `null` if it executed. */
    code: string | null;
    /** Quantity that settled, when it executed. */
    settled?: bigint;
    positionDelta?: bigint;
  }

  async function submitRaw(
    intent: OrderIntent,
    seed: boolean,
  ): Promise<{ outcome: Outcome; harness: Harness }> {
    const h = open();
    if (seed) seedPosition(h.ledger);
    await h.tracker.start();

    const before = h.ledger.getPosition(MINT_A)?.tokens ?? 0n;
    try {
      const fill = await h.tracker.submit(intent);
      const after = h.ledger.getPosition(MINT_A)?.tokens ?? 0n;
      return {
        outcome: {
          label: intent.reason,
          code: null,
          settled: fill.tokensDelta,
          positionDelta: after - before,
        },
        harness: h,
      };
    } catch (cause) {
      const error = cause as Error & { code?: string; name: string };
      return {
        outcome: {
          label: intent.reason,
          // `name` is reported when there is no code, so an accidental
          // RangeError/TypeError shows up as itself rather than as `null`.
          code: error.code ?? error.name,
        },
        harness: h,
      };
    }
  }

  const base = { id: 'garbage', maxSlippageBps: 300 };

  /** The ten cases, exactly as Prompt 10 measured them. */
  const CASES: Array<{ label: string; intent: OrderIntent; seed: boolean; expect: string }> = [
    {
      label: 'negative buy amount',
      intent: { ...base, side: 'buy', mint: MINT_A, amountLamports: -1n, reason: 'negative buy' },
      seed: false,
      expect: 'MALFORMED_INTENT',
    },
    {
      label: 'zero buy amount',
      intent: { ...base, side: 'buy', mint: MINT_A, amountLamports: 0n, reason: 'zero buy' },
      seed: false,
      expect: 'MALFORMED_INTENT',
    },
    {
      label: 'NaN buy amount',
      intent: {
        ...base,
        side: 'buy',
        mint: MINT_A,
        amountLamports: Number.NaN as unknown as bigint,
        reason: 'NaN buy',
      },
      seed: false,
      expect: 'MALFORMED_INTENT',
    },
    {
      label: 'Infinity buy amount',
      intent: {
        ...base,
        side: 'buy',
        mint: MINT_A,
        amountLamports: Number.POSITIVE_INFINITY as unknown as bigint,
        reason: 'Infinity buy',
      },
      seed: false,
      expect: 'MALFORMED_INTENT',
    },
    {
      label: 'absent buy amount',
      intent: { ...base, side: 'buy', mint: MINT_A, reason: 'absent buy' },
      seed: false,
      expect: 'MALFORMED_INTENT',
    },
    {
      label: 'non-base58 mint',
      intent: {
        ...base,
        side: 'buy',
        mint: 'not a mint!!',
        amountLamports: 50_000_000n,
        reason: 'bad mint',
      },
      seed: false,
      expect: 'MALFORMED_INTENT',
    },
    {
      label: 'null mint',
      intent: {
        ...base,
        side: 'buy',
        mint: null as unknown as string,
        amountLamports: 50_000_000n,
        reason: 'null mint',
      },
      seed: false,
      expect: 'MALFORMED_INTENT',
    },
    {
      label: 'negative sell amount',
      intent: { ...base, side: 'sell', mint: MINT_A, amountTokens: -5n, reason: 'negative sell' },
      seed: true,
      expect: 'MALFORMED_INTENT',
    },
    {
      label: 'NaN sell amount',
      intent: {
        ...base,
        side: 'sell',
        mint: MINT_A,
        amountTokens: Number.NaN as unknown as bigint,
        reason: 'NaN sell',
      },
      seed: true,
      expect: 'MALFORMED_INTENT',
    },
    {
      label: 'sell with no position',
      intent: {
        ...base,
        side: 'sell',
        mint: MINT_A,
        amountTokens: 1_000n,
        reason: 'sell nothing',
      },
      seed: false,
      expect: 'NO_OPEN_POSITION',
    },
  ];

  for (const testCase of CASES) {
    it(`${testCase.label} -> ${testCase.expect}`, async () => {
      const { outcome } = await submitRaw(testCase.intent, testCase.seed);
      expect(outcome.code).toBe(testCase.expect);
    });
  }

  it('no case terminates in a RangeError, a TypeError, or a NO_ROUTE', async () => {
    const codes: string[] = [];
    for (const testCase of CASES) {
      const { outcome } = await submitRaw(testCase.intent, testCase.seed);
      codes.push(outcome.code ?? 'FILLED');
    }
    // Those three were what actually stopped seven of these cases before
    // 2026-08-03. They are accidents of the layers below, not defenses: none
    // carries a code Prompt 12 can count, and `NO_ROUTE` is indistinguishable
    // from a real token that briefly had no route.
    expect(codes).not.toContain('RangeError');
    expect(codes).not.toContain('TypeError');
    expect(codes).not.toContain('NO_ROUTE');
    expect(codes).not.toContain('QuoteUnavailableError');
  });

  it('OVERSELL is the one case that must NOT reject — it clamps and executes', async () => {
    // Was: FILLED with tokensDelta -999,999,999,999 and +0.997 SOL conjured
    // into the paper wallet (measured 2026-08-03).
    const h = open();
    seedPosition(h.ledger);
    await h.tracker.start();
    const before = h.ledger.getNetLamportsFlow({ simulated: true });

    const fill = await h.tracker.submit({
      ...base,
      side: 'sell',
      mint: MINT_A,
      amountTokens: 999_999_999_999n,
      reason: 'oversell',
    });

    // Rejecting would strand a holder whose ledger and chain disagree — the
    // exact situation the crash-orphan gate exists for.
    expect(fill.side).toBe('sell');
    // The fill row records what SETTLED, never what was requested.
    expect(fill.tokensDelta).toBe(-1_000_000_000n);
    expect(h.ledger.getPosition(MINT_A)?.tokens).toBe(0n);
    expect(h.ledger.getPosition(MINT_A)?.state).toBe('closed');

    // The clamp happened before the quote, so the proceeds are for the
    // 1,000,000,000 actually held rather than for a thousand times that.
    const proceeds = h.ledger.getNetLamportsFlow({ simulated: true }) - before;
    expect(proceeds).toBeLessThan(1_000_000_000n);
  });

  it('the intent row still records what was ASKED, so the discrepancy stays visible', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oversell-'));
    const dbPath = join(dir, 't.db');
    const ledger = openLedger({
      path: dbPath,
      logger: { info: () => undefined, warn: () => undefined },
    });

    try {
      const h = open({ dbPath, ledger });
      seedPosition(h.ledger);
      await h.tracker.start();
      await h.tracker.submit({
        ...base,
        side: 'sell',
        mint: MINT_A,
        amountTokens: 999_999_999_999n,
        reason: 'oversell',
      });
      ledger.close();

      const raw = new Database(dbPath, { readonly: true });
      const intent = raw
        .prepare(`SELECT amount, status FROM intents WHERE id = 'garbage'`)
        .get() as { amount: number | bigint; status: string };
      const fill = raw
        .prepare(`SELECT tokens_delta FROM fills WHERE intent_id = 'garbage'`)
        .get() as { tokens_delta: number | bigint };
      raw.close();

      // Asked for a thousand times the holding; settled the holding. Both
      // numbers survive, in the two places that mean different things.
      expect(BigInt(intent.amount)).toBe(999_999_999_999n);
      expect(intent.status).toBe('filled');
      expect(BigInt(fill.tokens_delta)).toBe(-1_000_000_000n);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a clamped sell is logged as a notice, not counted as a rejection', async () => {
    const h = open();
    seedPosition(h.ledger);
    await h.tracker.start();
    await h.tracker.submit({
      ...base,
      side: 'sell',
      mint: MINT_A,
      amountTokens: 999_999_999_999n,
      reason: 'oversell',
    });

    // It executed. Filing it under a rejection code would inflate the refusal
    // count with a success, and Prompt 12 reads that count.
    expect(h.events.filter((record) => record.type === 'rejection')).toHaveLength(0);
    expect(h.tracker.stats.rejections).toBe(0);
    expect(h.events.filter((record) => record.type === 'fill')).toHaveLength(1);
  });

  it('a well-formed sell is untouched by the clamp', async () => {
    const h = open();
    seedPosition(h.ledger);
    await h.tracker.start();

    const fill = await h.tracker.submit({
      ...base,
      side: 'sell',
      mint: MINT_A,
      amountTokens: 400_000_000n,
      reason: 'partial exit',
    });

    expect(fill.tokensDelta).toBe(-400_000_000n);
    expect(h.ledger.getPosition(MINT_A)?.tokens).toBe(600_000_000n);
  });

  it('a NaN sell no longer "fills" — it is refused, and nothing is emitted', async () => {
    // Was: a Fill returned, `intent-created` and `fill` emitted, and NOTHING in
    // the ledger (measured 2026-08-03).
    const h = open();
    seedPosition(h.ledger);
    await h.tracker.start();

    await expect(
      h.tracker.submit({
        ...base,
        side: 'sell',
        mint: MINT_A,
        amountTokens: Number.NaN as unknown as bigint,
        reason: 'NaN sell',
      }),
    ).rejects.toMatchObject({ name: 'GuardRejection', code: 'MALFORMED_INTENT' });

    expect(h.events.filter((record) => record.type === 'fill')).toHaveLength(0);
    expect(h.events.filter((record) => record.type === 'intent-created')).toHaveLength(0);
    expect(h.ledger.getPosition(MINT_A)?.tokens).toBe(1_000_000_000n);
  });

  it('refuses a malformed intent BEFORE writing anything', async () => {
    const h = open();
    await h.tracker.start();

    await expect(
      h.tracker.submit({
        ...base,
        side: 'buy',
        mint: MINT_A,
        amountLamports: -1n,
        reason: 'negative',
      }),
    ).rejects.toMatchObject({ code: 'MALFORMED_INTENT' });

    // No intents row: gate 0 runs ahead of the write, because an amount it
    // rejects may not be representable in the column at all.
    expect(h.ledger.getIntentStatus('garbage')).toBeUndefined();
    // The refusal is still announced, so it is not lost.
    const rejection = h.events.find((record) => record.type === 'rejection');
    expect(rejection?.data).toMatchObject({ code: 'MALFORMED_INTENT', mint: MINT_A });
  });

  it('MIRROR still cannot produce any of these', async () => {
    const mirror = createMirrorStrategy();
    const drafts = [
      await mirror.onTrackedSwap(swapOf({ side: 'sell' }), contextOf([position()])),
      await mirror.onPriceTick(position(), 0.00001, contextOf()),
      await mirror.onTrackedSwap(swapOf(), contextOf()),
    ].filter((draft): draft is IntentDraft => draft !== null);

    expect(drafts).toHaveLength(3);
    for (const draft of drafts) {
      expect(malformedIntentReason({ ...draft, id: 'x' })).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Persistence is the precondition for emission
// ---------------------------------------------------------------------------

describe('nothing is announced that is not on disk', () => {
  /** A ledger whose writes report success and store nothing. */
  function lyingLedger(real: Ledger, about: 'intent' | 'fill'): Ledger {
    return {
      ...real,
      recordIntent: about === 'intent' ? () => undefined : real.recordIntent.bind(real),
      recordFill: about === 'fill' ? () => undefined : real.recordFill.bind(real),
      getIntentStatus: real.getIntentStatus.bind(real),
      getFillsForIntent: real.getFillsForIntent.bind(real),
      getOpenPositions: real.getOpenPositions.bind(real),
      getPositions: real.getPositions.bind(real),
      getPosition: real.getPosition.bind(real),
      getNetLamportsFlow: real.getNetLamportsFlow.bind(real),
      getRealizedLossLamportsToday: real.getRealizedLossLamportsToday.bind(real),
      getUnacknowledgedOrphanCount: real.getUnacknowledgedOrphanCount.bind(real),
      reconcileOnStartup: real.reconcileOnStartup.bind(real),
      resolveIntent: real.resolveIntent.bind(real),
    } as Ledger;
  }

  it('refuses with LEDGER_WRITE_FAILED when the intent row does not stick', async () => {
    const real = openLedger({
      path: ':memory:',
      logger: { info: () => undefined, warn: () => undefined },
    });
    const h = open({ ledger: lyingLedger(real, 'intent') });

    try {
      await h.tracker.start();
      await expect(
        h.tracker.submit({
          id: 'ghost',
          side: 'buy',
          mint: MINT_A,
          amountLamports: solToLamports(0.05),
          maxSlippageBps: 300,
          reason: 'write fails',
        }),
      ).rejects.toMatchObject({ name: 'LedgerWriteError' });

      // The measured failure was a write that returned normally and stored
      // nothing, so the check is a read-back rather than a try/catch.
      expect(h.events.filter((record) => record.type === 'intent-created')).toHaveLength(0);
      expect(h.events.filter((record) => record.type === 'fill')).toHaveLength(0);
      const rejection = h.events.find((record) => record.type === 'rejection');
      expect(rejection?.data).toMatchObject({ code: 'LEDGER_WRITE_FAILED', mint: MINT_A });
    } finally {
      real.close();
    }
  });

  it('refuses with LEDGER_WRITE_FAILED when the FILL row does not stick', async () => {
    const real = openLedger({
      path: ':memory:',
      logger: { info: () => undefined, warn: () => undefined },
    });
    const h = open({ ledger: lyingLedger(real, 'fill') });

    try {
      await h.tracker.start();
      await expect(
        h.tracker.submit({
          id: 'ghost-fill',
          side: 'buy',
          mint: MINT_A,
          amountLamports: solToLamports(0.05),
          maxSlippageBps: 300,
          reason: 'fill write fails',
        }),
      ).rejects.toMatchObject({ name: 'LedgerWriteError' });

      // The intent WAS recorded and announced — that write stuck. The fill did
      // not, so no `fill` event: this is exactly the divergence that
      // `INSERT OR IGNORE` used to produce silently.
      expect(h.events.filter((record) => record.type === 'intent-created')).toHaveLength(1);
      expect(h.events.filter((record) => record.type === 'fill')).toHaveLength(0);
      expect(h.ledger.getIntentStatus('ghost-fill')).toBe('rejected');
    } finally {
      real.close();
    }
  });

  it('a NOT NULL violation now THROWS instead of being swallowed', () => {
    // Was silently ignored by `INSERT OR IGNORE` until 2026-08-03, which is how
    // a Fill got returned for a row that was never written.
    const ledger = openLedger({
      path: ':memory:',
      logger: { info: () => undefined, warn: () => undefined },
    });
    try {
      expect(() =>
        ledger.recordFill({
          intentId: 'bad',
          side: 'sell',
          mint: MINT_A,
          tokensDelta: Number.NaN as unknown as bigint,
          lamportsDelta: 1n,
          decimals: DECIMALS,
          feesLamports: 0n,
          slippageBps: 0,
          simulated: true,
          at: NOW,
        }),
      ).toThrow();
    } finally {
      ledger.close();
    }
  });

  it('still ignores a genuine primary-key conflict, which is what it is for', () => {
    // The retry-safety must survive the narrowing: the tracker writes an intent
    // and the broker writes it again defensively at the top of `execute`.
    const ledger = openLedger({
      path: ':memory:',
      logger: { info: () => undefined, warn: () => undefined },
    });
    try {
      const intent: OrderIntent = {
        id: 'dup',
        side: 'buy',
        mint: MINT_A,
        amountLamports: 1n,
        maxSlippageBps: 300,
        reason: 'first',
      };
      ledger.recordIntent(intent, NOW);
      ledger.resolveIntent('dup', 'filled', undefined, NOW);
      // A second write must not reset it to `pending`, and must not throw.
      expect(() => ledger.recordIntent({ ...intent, reason: 'second' }, NOW + 1)).not.toThrow();
      expect(ledger.getIntentStatus('dup')).toBe('filled');

      const fill: SimulatedFill = {
        intentId: 'dup',
        side: 'buy',
        mint: MINT_A,
        tokensDelta: 5n,
        lamportsDelta: -1n,
        decimals: DECIMALS,
        feesLamports: 0n,
        slippageBps: 0,
        simulated: true,
        at: NOW,
      };
      ledger.recordFill(fill);
      expect(() => ledger.recordFill({ ...fill, at: NOW + 999 })).not.toThrow();
      expect(ledger.getFillsForIntent('dup')).toHaveLength(1);
      expect(ledger.getPosition(MINT_A)?.tokens).toBe(5n);
    } finally {
      ledger.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Conservation
// ---------------------------------------------------------------------------

/**
 * Properties over whatever the matrix throws at the system.
 *
 * Generated from the malformed cases rather than from well-formed ones on
 * purpose: a system that conserves value only when it is being used correctly
 * is not conserving value.
 */
describe('conservation', () => {
  /** Every intent from the matrix, interleaved with well-formed ones. */
  function chaosSequence(): OrderIntent[] {
    const slip = { maxSlippageBps: 300 };
    return [
      { id: 'c1', side: 'buy', mint: MINT_A, amountLamports: solToLamports(0.05), reason: 'ok buy', ...slip },
      { id: 'c2', side: 'buy', mint: MINT_A, amountLamports: -1n, reason: 'negative', ...slip },
      { id: 'c3', side: 'buy', mint: MINT_B, amountLamports: 0n, reason: 'zero', ...slip },
      {
        id: 'c4',
        side: 'buy',
        mint: MINT_B,
        amountLamports: Number.NaN as unknown as bigint,
        reason: 'NaN',
        ...slip,
      },
      { id: 'c5', side: 'buy', mint: 'not a mint!!', amountLamports: 1n, reason: 'bad mint', ...slip },
      { id: 'c6', side: 'sell', mint: MINT_A, amountTokens: 999_999_999_999n, reason: 'oversell', ...slip },
      { id: 'c7', side: 'sell', mint: MINT_A, amountTokens: 1n, reason: 'sell nothing left', ...slip },
      { id: 'c8', side: 'buy', mint: MINT_B, amountLamports: solToLamports(0.05), reason: 'ok buy b', ...slip },
      {
        id: 'c9',
        side: 'sell',
        mint: MINT_B,
        amountTokens: Number.NaN as unknown as bigint,
        reason: 'NaN sell',
        ...slip,
      },
      { id: 'c10', side: 'sell', mint: MINT_B, amountTokens: 500_000_000n, reason: 'partial', ...slip },
    ];
  }

  async function runChaos(): Promise<Harness> {
    const h = open();
    await h.tracker.start();
    for (const intent of chaosSequence()) {
      await h.tracker.submit(intent).catch(() => undefined);
    }
    return h;
  }

  it('conserves paper SOL across the whole sequence', async () => {
    const h = await runChaos();

    const rows = allFills(h.ledger);
    const lamportsDelta = rows.reduce((total, fill) => total + fill.lamportsDelta, 0n);
    const fees = rows.reduce((total, fill) => total + fill.feesLamports, 0n);
    const balance = await h.tracker.broker.getBalanceLamports();
    const start = solToLamports(h.config.paperStartingSol);

    // balance = start + Σ(lamportsDelta) - Σ(fees), so:
    //   balance - Σ(lamportsDelta) + Σ(fees) == start
    // Every lamport the wallet holds is accounted for by a fill row, and every
    // fill row moved the wallet.
    expect(balance - lamportsDelta + fees).toBe(start);
  });

  it('CONSERVES TOKENS — no fill sells more than was held', async () => {
    const h = await runChaos();
    const rows = allFills(h.ledger);

    // This is the property the SOL identity cannot catch, because the balance
    // is derived from the same rows it is being checked against: it holds by
    // construction even when a fill row is a lie. Tokens are the independent
    // check, and the oversell defect showed up here and nowhere else.
    for (const mint of [MINT_A, MINT_B]) {
      let held = 0n;
      for (const fill of rows.filter((row) => row.mint === mint)) {
        held += fill.tokensDelta;
        expect(held, `${mint} went negative after ${fill.intentId}`).toBeGreaterThanOrEqual(0n);
      }
      expect(held).toBe(h.ledger.getPosition(mint)?.tokens ?? 0n);
    }
  });

  it('every fill event has a fills row', async () => {
    const h = await runChaos();
    const rows = allFills(h.ledger);

    for (const record of h.events.filter((event) => event.type === 'fill')) {
      const fill = record.data as Fill;
      expect(
        rows.some(
          (row) =>
            row.intentId === fill.intentId &&
            row.mint === fill.mint &&
            row.tokensDelta === fill.tokensDelta,
        ),
        `emitted fill for ${fill.intentId} has no row`,
      ).toBe(true);
    }
    expect(h.events.filter((event) => event.type === 'fill').length).toBeGreaterThan(0);
  });

  it('every intent-created event has an intents row', async () => {
    const h = await runChaos();

    for (const record of h.events.filter((event) => event.type === 'intent-created')) {
      const { id } = record.data as { id: string };
      expect(h.ledger.getIntentStatus(id), `emitted intent ${id} has no row`).toBeDefined();
    }
    expect(h.events.filter((event) => event.type === 'intent-created').length).toBeGreaterThan(0);
  });

  it('emits nothing for an intent it refused', async () => {
    const h = await runChaos();
    const announced = new Set(
      h.events
        .filter((event) => event.type === 'intent-created')
        .map((event) => (event.data as { id: string }).id),
    );

    // c2..c5 and c9 are malformed; none of them may appear.
    for (const id of ['c2', 'c3', 'c4', 'c5', 'c9']) {
      expect(announced.has(id), `${id} was announced`).toBe(false);
    }
    expect(announced.has('c1')).toBe(true);
  });
});

/** Every fill on the books, in replay order. */
function allFills(ledger: Ledger): Fill[] {
  const ids = [
    'seed',
    ...Array.from({ length: 12 }, (_, index) => `c${index + 1}`),
    'garbage',
    'exit-1',
    'exit-2',
  ];
  return ids.flatMap((id) => ledger.getFillsForIntent(id));
}

describe('the runner does not second-guess the strategy', () => {
  it('submits a duplicate buy and lets guards reject it', async () => {
    const h = open({
      strategy: scripted(async () => ({
        side: 'buy',
        mint: MINT_A,
        amountLamports: solToLamports(0.05),
        maxSlippageBps: 300,
        reason: 'deliberate duplicate',
      })),
    });
    seedPosition(h.ledger);
    await h.tracker.start();

    await h.runner.onTrackedSwap(swapOf());

    // The rejection is a record. A runner that dropped it before it was written
    // would make Prompt 12's rejection counts describe a bot that never asked.
    const rejection = h.events.find((record) => record.type === 'rejection');
    expect(rejection?.data).toMatchObject({ code: 'ALREADY_HOLDING' });
    expect(h.runner.stats.rejected).toBe(1);
    expect(h.runner.stats.submitted).toBe(0);
  });

  it('does not report a guard rejection as a strategy error', async () => {
    const h = open({
      strategy: scripted(async () => ({
        side: 'buy',
        mint: MINT_A,
        amountLamports: solToLamports(0.05),
        maxSlippageBps: 300,
        reason: 'deliberate duplicate',
      })),
    });
    seedPosition(h.ledger);
    await h.tracker.start();

    await h.runner.onTrackedSwap(swapOf());

    // A risk limit doing its job is not the strategy misbehaving, and blaming
    // it would double-count the same event under two headings.
    expect(h.events.filter((record) => record.type === 'strategy-error')).toHaveLength(0);
    expect(h.runner.stats.throws).toBe(0);
  });

  it('counts a rejection ONCE, under one heading', async () => {
    const h = open({
      strategy: scripted(async () => ({
        side: 'buy',
        mint: MINT_A,
        amountLamports: solToLamports(0.05),
        maxSlippageBps: 300,
        reason: 'duplicate',
      })),
    });
    seedPosition(h.ledger);
    await h.tracker.start();

    for (let index = 0; index < 3; index += 1) await h.runner.onTrackedSwap(swapOf());

    // Prompt 12 reads both of these. Reporting a risk limit doing its job as a
    // strategy failure would inflate one report and invent an incident in the
    // other.
    expect(h.events.filter((record) => record.type === 'rejection')).toHaveLength(3);
    expect(h.events.filter((record) => record.type === 'strategy-error')).toHaveLength(0);
    expect(h.runner.stats).toMatchObject({ rejected: 3, throws: 0, timeouts: 0, submitted: 0 });
    expect(h.tracker.stats.rejections).toBe(3);
  });

  it('keeps running after a rejected intent', async () => {
    let calls = 0;
    const h = open({
      strategy: scripted(async () => {
        calls += 1;
        return {
          side: 'buy',
          mint: MINT_A,
          amountLamports: solToLamports(0.05),
          maxSlippageBps: 300,
          reason: 'duplicate',
        };
      }),
    });
    seedPosition(h.ledger);
    await h.tracker.start();

    await h.runner.onTrackedSwap(swapOf());
    await h.runner.onTrackedSwap(swapOf());

    expect(calls).toBe(2);
    expect(h.runner.stats.rejected).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Detaching
// ---------------------------------------------------------------------------

describe('useStrategy(null)', () => {
  it('returns the tracker to a pure observer', async () => {
    const h = open();
    seedPosition(h.ledger);
    await h.tracker.start();
    h.tracker.useStrategy(null);

    h.stream.emit('swap', swapOf({ mint: MINT_B }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await h.tracker.priceTick();

    expect(h.events.filter((record) => record.type === 'intent-created')).toHaveLength(0);
    expect(h.runner.stats.swaps).toBe(0);
    // Everything else still works.
    expect(h.events.some((record) => record.type === 'swap-detected')).toBe(true);
    expect(h.tracker.positions()[0]?.markLamportsPerToken).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('the timeout is 500ms as specified', () => {
    expect(STRATEGY_TIMEOUT_MS).toBe(500);
  });

  it('the band is -40 / +150', () => {
    expect(STOP_LOSS_PCT).toBe(-40);
    expect(TAKE_PROFIT_PCT).toBe(150);
  });
});
