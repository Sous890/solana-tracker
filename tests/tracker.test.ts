import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/core/config.js';
import type { Config } from '../src/core/config.js';
import type { Broker } from '../src/core/broker.js';
import type { QuoteError, QuoteRequest, QuoteSource } from '../src/core/quoteSource.js';
import type {
  Address,
  Fill,
  OrderIntent,
  Quote,
  SimulatedFill,
  TrackedSwap,
} from '../src/core/types.js';
import { WRAPPED_SOL_MINT, solToLamports } from '../src/core/units.js';
import { createPaperBroker } from '../src/adapters/paperBroker.js';
import { createDecimalsResolver, fixtureDecimalsSource } from '../src/adapters/mintMetadata.js';
import { openLedger } from '../src/db/ledger.js';
import type { Ledger } from '../src/db/ledger.js';
import { HEARTBEAT_INTERVAL_MS } from '../src/adapters/walletStream.js';
import { openRuntimeState } from '../src/db/runtimeState.js';
import type { RuntimeState } from '../src/db/runtimeState.js';
import {
  PRICE_INTERVAL_MS,
  SCREEN_INTERVAL_MS,
  Tracker,
  TrackerStateError,
  rejectionCodeOf,
} from '../src/services/tracker.js';
import type {
  HeldPositionScreener,
  Scheduler,
  TrackerEventRecord,
  TrackerLogger,
  WalletFeed,
} from '../src/services/tracker.js';
import { GuardRejection } from '../src/core/guards.js';
import { copyableScores } from './fixtures/scores.js';
import type { WalletScoresFile } from '../src/services/walletScores.js';

const MINT_A = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const MINT_B = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const NOW = 1_700_000_000_000;
const DECIMALS = 6;

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeStream extends EventEmitter implements WalletFeed {
  starts = 0;
  stops = 0;
  startError: Error | undefined;
  /** Liveness ticks the tracker drove, and what it claimed about health. */
  readonly heartbeats: boolean[] = [];
  /** Set to make the next heartbeat report that it tore the socket down. */
  heartbeatTearsDown = false;

  heartbeat(healthy: boolean): boolean {
    this.heartbeats.push(healthy);
    return this.heartbeatTearsDown;
  }

  /**
   * Emits `connected` on success, because `WalletStream.connectOnce()` does and
   * the tracker's `running` status is bound to it. A fake that omits it models
   * a feed that never comes up — which is what `startError` and
   * `withholdConnected` are for.
   */
  withholdConnected = false;

  async start(): Promise<void> {
    if (this.startError !== undefined) throw this.startError;
    this.starts += 1;
    if (!this.withholdConnected) this.emit('connected', { at: Date.now() });
  }

  stop(): void {
    this.stops += 1;
  }
}

class FakeScreener extends EventEmitter implements HeldPositionScreener {
  readonly screened: Address[] = [];
  error: Error | undefined;

  async screenHeldPosition(mint: Address): Promise<unknown> {
    this.screened.push(mint);
    if (this.error !== undefined) throw this.error;
    return { verdict: 'pass' };
  }
}

class FakeScheduler implements Scheduler {
  private readonly handlers = new Map<number, { handler: () => void; ms: number }>();
  private next = 1;

  setInterval(handler: () => void, ms: number): unknown {
    const handle = this.next++;
    this.handlers.set(handle, { handler, ms });
    return handle;
  }

  clearInterval(handle: unknown): void {
    this.handlers.delete(handle as number);
  }

  get active(): number {
    return this.handlers.size;
  }

  /** Registered cadences, in registration order. */
  get intervals(): number[] {
    return [...this.handlers.values()].map((entry) => entry.ms);
  }

  fire(index: number): void {
    [...this.handlers.values()][index]?.handler();
  }
}

function capturingLogger(sink: Array<{ level: string; message: string }>): TrackerLogger {
  return {
    info: (_fields, message) => sink.push({ level: 'info', message }),
    warn: (_fields, message) => sink.push({ level: 'warn', message }),
    error: (_fields, message) => sink.push({ level: 'error', message }),
  };
}

function quoteOf(request: QuoteRequest, out: bigint, impactPct = 0.5): Quote {
  return {
    inMint: request.inMint,
    outMint: request.outMint,
    inAmount: request.inAmount,
    outAmount: out,
    priceImpactPct: impactPct,
    routePlan: [],
    fetchedAt: NOW,
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  config?: Partial<Record<string, unknown>>;
  /** Result for the tracker's own price-loop quote source, per mint. */
  priceQuote?: (request: QuoteRequest) => Quote | QuoteError;
  /** Result for the broker's quote source. */
  brokerQuote?: (request: QuoteRequest) => Quote | QuoteError;
  canSell?: (mint: Address) => Promise<{ ok: boolean; reason?: string }>;
  /** Awaited inside `broker.execute`, so a test can hold an intent in flight. */
  beforeExecute?: () => Promise<void>;
  dbPath?: string;
  ledger?: Ledger;
  runtime?: RuntimeState;
  broker?: Broker;
  walletScores?: WalletScoresFile;
}

interface Harness {
  tracker: Tracker;
  ledger: Ledger;
  runtime: RuntimeState;
  stream: FakeStream;
  screener: FakeScreener;
  scheduler: FakeScheduler;
  config: Config;
  logs: Array<{ level: string; message: string }>;
  events: TrackerEventRecord[];
  brokerCalls: { execute: OrderIntent[]; emergencyExitAll: number };
  close(): void;
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

  const brokerQuotes: QuoteSource = {
    getQuote: async (request) =>
      options.brokerQuote?.(request) ?? quoteOf(request, 1_000_000_000n),
  };
  const priceQuotes: QuoteSource = {
    getQuote: async (request) =>
      options.priceQuote?.(request) ?? quoteOf(request, 50_000_000n),
  };

  const brokerCalls = { execute: [] as OrderIntent[], emergencyExitAll: 0 };
  const paper = createPaperBroker({
    quoteSource: brokerQuotes,
    resolveDecimals: createDecimalsResolver(
      fixtureDecimalsSource({ [MINT_A]: DECIMALS, [MINT_B]: DECIMALS }),
    ),
    ledger,
    config,
    latencyMs: 0,
    // Monotonic, so two fills in one test never share a millisecond by accident
    // and the replay-order fix is not what is under test here.
    now: (() => {
      let clock = NOW;
      return () => (clock += 1);
    })(),
    ...(options.canSell === undefined ? {} : { canSell: options.canSell }),
  });

  // A thin recorder around the paper broker, so tests can assert what the
  // tracker did or did not ask the execution layer to do.
  const broker: Broker =
    options.broker ??
    {
      ...paper,
      execute: async (intent) => {
        brokerCalls.execute.push(intent);
        await options.beforeExecute?.();
        return paper.execute(intent);
      },
      emergencyExitAll: () => {
        brokerCalls.emergencyExitAll += 1;
        return paper.emergencyExitAll();
      },
    };

  const stream = new FakeStream();
  const screener = new FakeScreener();
  const scheduler = new FakeScheduler();
  const logs: Array<{ level: string; message: string }> = [];
  const events: TrackerEventRecord[] = [];

  const tracker = new Tracker({
    // Defaults to every test wallet copyable. A test that wants the gate to
    // bite passes its own scores — absence is a refusal, not a pass.
    walletScores: options.walletScores ?? copyableScores,
    config,
    ledger,
    runtime,
    broker,
    screener,
    quotes: priceQuotes,
    stream,
    logger: capturingLogger(logs),
    scheduler,
    now: () => NOW,
  });
  tracker.on('event', (event: TrackerEventRecord) => events.push(event));

  return {
    tracker,
    ledger,
    runtime,
    stream,
    screener,
    scheduler,
    config,
    logs,
    events,
    brokerCalls,
    close() {
      if (options.ledger === undefined) ledger.close();
      if (options.runtime === undefined) runtime.close();
    },
  };
}

function buyFill(overrides: Partial<SimulatedFill> = {}): SimulatedFill {
  return {
    intentId: 'seed-buy',
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
  };
}

function buyIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    id: 'buy-1',
    side: 'buy',
    mint: MINT_A,
    amountLamports: solToLamports(0.05),
    maxSlippageBps: 300,
    reason: 'test',
    ...overrides,
  };
}

const openHarnesses: Harness[] = [];
function open(options: HarnessOptions = {}): Harness {
  const created = harness(options);
  openHarnesses.push(created);
  return created;
}

afterEach(() => {
  while (openHarnesses.length > 0) openHarnesses.pop()?.close();
});

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe('state machine', () => {
  it('starts idle', () => {
    const h = open();
    expect(h.tracker.getState().status).toBe('idle');
    expect(h.tracker.getState().startedAt).toBeUndefined();
  });

  it('goes idle -> running on start, reconciling before subscribing', async () => {
    const h = open();
    await h.tracker.start();

    expect(h.tracker.getState().status).toBe('running');
    expect(h.tracker.getState().startedAt).toBe(NOW);
    expect(h.stream.starts).toBe(1);

    // Order is the point: nothing may produce an intent before the ledger has
    // said whether a previous run left a holding it cannot see.
    const types = h.events.map((event) => event.type);
    expect(types.indexOf('reconciled')).toBeLessThan(types.indexOf('state-change'));
  });

  it('starts the price and screen loops on start', async () => {
    const h = open();
    expect(h.scheduler.active).toBe(0);
    await h.tracker.start();
    expect(h.scheduler.active).toBe(3);
  });

  it('REFUSES a double start, and does not open a second subscription', async () => {
    const h = open();
    await h.tracker.start();

    await expect(h.tracker.start()).rejects.toBeInstanceOf(TrackerStateError);
    // The damage a permissive double-start would do: two subscriptions sharing
    // one cursor, each advancing it past what the other has emitted.
    expect(h.stream.starts).toBe(1);
    expect(h.tracker.getState().status).toBe('running');
  });

  it('refuses a start that races another start still in progress', async () => {
    const h = open();
    const first = h.tracker.start();
    // Same tick, before the first has resolved.
    await expect(h.tracker.start()).rejects.toBeInstanceOf(TrackerStateError);
    await first;
    expect(h.stream.starts).toBe(1);
  });

  it('stays idle when the subscription cannot be opened', async () => {
    const h = open();
    h.stream.startError = new Error('rpc down');

    await expect(h.tracker.start()).rejects.toThrow('rpc down');
    expect(h.tracker.getState().status).toBe('idle');
    // And it can be retried, which a half-set status would have prevented.
    h.stream.startError = undefined;
    await h.tracker.start();
    expect(h.tracker.getState().status).toBe('running');
  });

  it('goes running -> stopping -> idle on stop, closing the subscription', async () => {
    const h = open();
    await h.tracker.start();
    await h.tracker.stop();

    expect(h.tracker.getState().status).toBe('idle');
    expect(h.tracker.getState().startedAt).toBeUndefined();
    expect(h.stream.stops).toBe(1);

    const transitions = h.events
      .filter((event) => event.type === 'state-change')
      .map((event) => (event.data as { status: string }).status);
    expect(transitions).toEqual(['running', 'stopping', 'idle']);
  });

  it('joins a stop already in progress rather than starting a second teardown', async () => {
    const h = open();
    await h.tracker.start();

    // Both callers must see the same shutdown, and the subscription must be
    // closed once. Stop converges; it does not throw, because asking a bot that
    // is stopping to stop is a request that is already being satisfied.
    await Promise.all([h.tracker.stop(), h.tracker.stop()]);

    expect(h.stream.stops).toBe(1);
    expect(h.tracker.getState().status).toBe('idle');
  });

  it('treats a stop while idle as a no-op', async () => {
    const h = open();
    await expect(h.tracker.stop()).resolves.toBeUndefined();
    expect(h.stream.stops).toBe(0);
    expect(h.tracker.getState().status).toBe('idle');
  });

  it('can start again after a stop', async () => {
    const h = open();
    await h.tracker.start();
    await h.tracker.stop();
    await h.tracker.start();
    expect(h.tracker.getState().status).toBe('running');
    expect(h.stream.starts).toBe(2);
  });

  it('WAITS for an in-flight intent before going idle', async () => {
    // The execution is held open until the test releases it, so the intent is
    // genuinely unfinished at the moment stop() is called.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const h = open({
      canSell: async () => ({ ok: true }),
      beforeExecute: () => gate,
    });
    await h.tracker.start();

    const order: string[] = [];
    const submitted = h.tracker.submit(buyIntent()).then((fill) => {
      order.push('intent-settled');
      return fill;
    });

    // Let the submit reach the gate, then stop while it is sitting there.
    await Promise.resolve();
    const stopping = h.tracker.stop().then(() => {
      order.push('stop-returned');
    });

    // Nothing has finished yet: stop is waiting on the intent, not the reverse.
    expect(order).toEqual([]);
    expect(h.tracker.getState().status).toBe('stopping');

    release();
    await Promise.all([submitted, stopping]);

    // Abandoning it would leave a `pending` row that the next start reports as
    // a crash orphan — a wallet-checking chore invented by an orderly shutdown.
    expect(order).toEqual(['intent-settled', 'stop-returned']);
    expect(h.ledger.getIntentStatus('buy-1')).toBe('filled');
    expect(h.tracker.getState().status).toBe('idle');
  });

  it('refuses new entries the instant stop begins, before any await', async () => {
    const h = open({ canSell: async () => ({ ok: true }) });
    await h.tracker.start();

    const stopping = h.tracker.stop();
    // Same tick. `status` is already 'stopping', which is what guard gate 2
    // reads, so this is refused rather than racing the teardown.
    await expect(h.tracker.submit(buyIntent({ id: 'late-buy' }))).rejects.toMatchObject({
      code: 'NOT_RUNNING',
    });
    await stopping;
  });
});

// ---------------------------------------------------------------------------
// stop() sells nothing
// ---------------------------------------------------------------------------

describe('stop() sells nothing', () => {
  it('leaves every open position untouched', async () => {
    const h = open();
    h.ledger.recordFill(buyFill());
    h.ledger.recordFill(buyFill({ intentId: 'seed-buy-b', mint: MINT_B }));

    await h.tracker.start();
    await h.tracker.stop();

    const positions = h.ledger.getOpenPositions();
    expect(positions).toHaveLength(2);
    expect(positions.map((position) => position.tokens)).toEqual([
      1_000_000_000n,
      1_000_000_000n,
    ]);
  });

  it('never calls the broker at all', async () => {
    const h = open();
    h.ledger.recordFill(buyFill());

    await h.tracker.start();
    await h.tracker.stop();

    // The assertion that matters, stated directly rather than inferred from the
    // position count: stop is not an exit, and must not reach execution.
    expect(h.brokerCalls.execute).toHaveLength(0);
    expect(h.brokerCalls.emergencyExitAll).toBe(0);
  });

  it('records no sell fill', async () => {
    const h = open();
    h.ledger.recordFill(buyFill());

    await h.tracker.start();
    await h.tracker.stop();

    expect(h.ledger.getPosition(MINT_A)?.state).toBe('open');
    expect(h.events.filter((event) => event.type === 'fill')).toHaveLength(0);
  });

  it('keeps monitoring what it did not sell', async () => {
    const h = open();
    h.ledger.recordFill(buyFill());

    await h.tracker.start();
    await h.tracker.stop();

    // stop() deliberately left the book open, so the alerts that tell an
    // operator the book has gone bad must outlive it. Tearing the loops down
    // here would mean a position becoming unexitable in silence.
    expect(h.scheduler.active).toBe(3);
  });

  it('still detects a lost route on what it left behind', async () => {
    const h = open({
      priceQuote: () => ({ error: 'NO_ROUTE', message: 'TOKEN_NOT_TRADABLE' }),
    });
    h.ledger.recordFill(buyFill());

    await h.tracker.start();
    await h.tracker.stop();

    // Not "the timers are still registered" but the property that matters:
    // fire the price loop's own handler after a stop and the alert still
    // arrives. An operator who stopped the bot is sitting on a book with no
    // strategy watching it, which is exactly when a position going unexitable
    // must not happen in silence.
    h.scheduler.fire(0);
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.events.filter((event) => event.type === 'route-lost')).toHaveLength(1);
  });

  it('tears the loops down once the book is empty', async () => {
    const h = open();
    await h.tracker.start();
    await h.tracker.stop();
    expect(h.scheduler.active).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// flatten()
// ---------------------------------------------------------------------------

describe('flatten()', () => {
  it('runs from idle — it is not bound to the run state', async () => {
    const h = open();
    h.ledger.recordFill(buyFill());

    expect(h.tracker.getState().status).toBe('idle');
    const result = await h.tracker.flatten();

    expect(result.failures).toHaveLength(0);
    expect(result.completed).toHaveLength(1);
    expect(h.ledger.getPosition(MINT_A)?.state).toBe('closed');
  });

  it('is a no-op on an empty book rather than an error', async () => {
    const h = open();
    const result = await h.tracker.flatten();
    expect(result).toEqual({ completed: [], failures: [] });
  });

  it('COMPLETES with the kill switch engaged and the daily loss cap breached', async () => {
    const h = open();

    // A realized loss of 0.8 SOL against a 0.5 SOL cap, today.
    h.ledger.recordFill(
      buyFill({ intentId: 'loser-buy', lamportsDelta: -1_000_000_000n }),
    );
    h.ledger.recordFill({
      intentId: 'loser-sell',
      side: 'sell',
      mint: MINT_A,
      tokensDelta: -1_000_000_000n,
      lamportsDelta: 200_000_000n,
      decimals: DECIMALS,
      feesLamports: 0n,
      slippageBps: 0,
      simulated: true,
      at: NOW + 1,
    });
    expect(h.ledger.getRealizedLossLamportsToday(NOW)).toBe(800_000_000n);

    // Still holding something, and entries are killed.
    h.ledger.recordFill(buyFill({ intentId: 'held-b', mint: MINT_B, at: NOW + 2 }));
    await h.tracker.start();
    h.tracker.killSwitch();

    // Every entry gate would refuse a buy right now. The panic exit must not
    // care: a risk limit exists to stop the bot acquiring exposure, and
    // applying one here would trap it in the position the limit warned about.
    await expect(
      h.tracker.submit(buyIntent({ id: 'blocked', mint: MINT_B })),
    ).rejects.toMatchObject({ code: 'KILL_SWITCH_ENGAGED' });

    const result = await h.tracker.flatten();

    expect(result.failures).toHaveLength(0);
    expect(result.completed).toHaveLength(1);
    expect(h.ledger.getOpenPositions()).toHaveLength(0);
    expect(h.tracker.getState().killSwitchEngaged).toBe(true);
  });

  it('completes while stopping', async () => {
    const h = open();
    h.ledger.recordFill(buyFill());
    await h.tracker.start();

    const stopping = h.tracker.stop();
    const result = await h.tracker.flatten();
    await stopping;

    expect(result.completed).toHaveLength(1);
  });

  it('reports a position it could not exit instead of throwing it away', async () => {
    const h = open({
      brokerQuote: (request) =>
        request.inMint === MINT_A
          ? { error: 'NO_ROUTE', message: 'TOKEN_NOT_TRADABLE' }
          : quoteOf(request, 60_000_000n),
    });
    h.ledger.recordFill(buyFill());
    h.ledger.recordFill(buyFill({ intentId: 'seed-b', mint: MINT_B, at: NOW + 1 }));

    const result = await h.tracker.flatten();

    // The fills that landed and the mint still held both reach the caller. A
    // throw would have surfaced the failure and lost the successes.
    expect(result.completed).toHaveLength(1);
    expect(result.failures).toEqual([
      { mint: MINT_A, reason: expect.stringContaining('NO_ROUTE') },
    ]);
    expect(h.ledger.getPosition(MINT_A)?.state).toBe('open');
    expect(h.ledger.getPosition(MINT_B)?.state).toBe('closed');
  });

  it('emits a fill event per position it exited', async () => {
    const h = open();
    h.ledger.recordFill(buyFill());
    await h.tracker.flatten();
    expect(h.events.filter((event) => event.type === 'fill')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

describe('kill switch', () => {
  it('blocks new buys the moment it is engaged', async () => {
    const h = open({ canSell: async () => ({ ok: true }) });
    await h.tracker.start();
    h.tracker.killSwitch();

    await expect(h.tracker.submit(buyIntent())).rejects.toMatchObject({
      code: 'KILL_SWITCH_ENGAGED',
    });
  });

  it('leaves sells available', async () => {
    const h = open();
    h.ledger.recordFill(buyFill());
    await h.tracker.start();
    h.tracker.killSwitch();

    const fill = await h.tracker.submit({
      id: 'exit-1',
      side: 'sell',
      mint: MINT_A,
      amountTokens: 1_000_000_000n,
      maxSlippageBps: 300,
      reason: 'operator exit',
    });

    // The whole asymmetry in one assertion: a bot that is holding must always
    // be able to get out, kill switch or not.
    expect(fill.side).toBe('sell');
    expect(h.ledger.getPosition(MINT_A)?.state).toBe('closed');
  });

  it('does not need the bot to be running', () => {
    const h = open();
    h.tracker.killSwitch();
    expect(h.tracker.getState()).toMatchObject({ status: 'idle', killSwitchEngaged: true });
  });

  it('SURVIVES A RESTART', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracker-kill-'));
    const dbPath = join(dir, 'tracker.db');

    try {
      const first = harness({ dbPath });
      first.tracker.killSwitch();
      expect(first.tracker.getState().killSwitchEngaged).toBe(true);
      first.close();

      // A new process, reading the same file. An in-memory kill switch would be
      // cleared by exactly the restart an incident tends to involve.
      const second = harness({ dbPath, canSell: async () => ({ ok: true }) });
      try {
        expect(second.tracker.getState().killSwitchEngaged).toBe(true);

        // And it still bites, rather than merely being reported.
        await second.tracker.start();
        await expect(second.tracker.submit(buyIntent())).rejects.toMatchObject({
          code: 'KILL_SWITCH_ENGAGED',
        });
      } finally {
        second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives a restart in the released direction too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracker-kill-'));
    const dbPath = join(dir, 'tracker.db');

    try {
      const first = harness({ dbPath });
      first.tracker.killSwitch();
      first.tracker.releaseKillSwitch();
      first.close();

      // A released flag must not read as engaged. `'0'` is the one value that
      // means released — everything else fails closed, which is what makes this
      // worth pinning in both directions.
      const second = harness({ dbPath });
      try {
        expect(second.tracker.getState().killSwitchEngaged).toBe(false);
      } finally {
        second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads an unrecognised persisted value as ENGAGED', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracker-kill-'));
    const dbPath = join(dir, 'tracker.db');

    try {
      const state = openRuntimeState({ path: dbPath });
      state.setKillSwitch(false);
      state.close();

      // Whatever a hand-edit, a partial write or a future version leaves
      // behind, a flag that is not recognisably "released" must not authorise
      // entries. Written outside the module on purpose — this is the case the
      // module's own API cannot produce.
      const raw = new Database(dbPath);
      raw
        .prepare(`UPDATE runtime_flags SET value = ? WHERE key = 'kill_switch_engaged'`)
        .run('maybe');
      raw.close();

      const reopened = openRuntimeState({ path: dbPath });
      try {
        expect(reopened.killSwitchEngaged()).toBe(true);
        expect(reopened.killSwitchChangedAt()).toBeTypeOf('number');
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports no change time before it has ever been written', () => {
    const h = open();
    expect(h.runtime.killSwitchChangedAt()).toBeUndefined();
    expect(h.runtime.killSwitchEngaged()).toBe(false);
  });

  it('reaches disk immediately, not only on the next restart', () => {
    const h = open();
    h.tracker.killSwitch();

    // Read straight off the store, so the durable write is asserted rather than
    // inferred from a later process happening to see it.
    expect(h.runtime.killSwitchEngaged()).toBe(true);
    expect(h.runtime.killSwitchChangedAt()).toBe(NOW);
  });

  it('emits a state change so a client sees it without polling', () => {
    const h = open();
    h.tracker.killSwitch();
    const last = h.events.at(-1);
    expect(last?.type).toBe('state-change');
    expect(last?.data).toMatchObject({ killSwitchEngaged: true });
  });
});

// ---------------------------------------------------------------------------
// Crash recovery on start
// ---------------------------------------------------------------------------

describe('start after a crash', () => {
  function crashedLedger(dbPath: string): Ledger {
    const ledger = openLedger({
      path: dbPath,
      logger: { info: () => undefined, warn: () => undefined },
    });
    // A completed buy — an open position the next run inherits.
    ledger.recordIntent(buyIntent({ id: 'seed-buy' }), NOW);
    ledger.recordFill(buyFill());
    ledger.resolveIntent('seed-buy', 'filled', undefined, NOW);
    // And an intent the crash left pending with no fill.
    ledger.recordIntent(buyIntent({ id: 'crashed-buy', mint: MINT_B }), NOW);
    return ledger;
  }

  it('starts anyway, reporting open positions AND crash orphans', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracker-crash-'));
    const dbPath = join(dir, 'tracker.db');
    const ledger = crashedLedger(dbPath);
    const h = open({ dbPath, ledger });

    try {
      const report = await h.tracker.start();

      expect(report.openPositions.map((position) => position.mint)).toEqual([MINT_A]);
      expect(report.orphaned.map((orphan) => orphan.id)).toEqual(['crashed-buy']);
      expect(report.dirty).toBe(true);
      // Refusing to boot would deny the operator the exits and the monitoring
      // they need to resolve it; the orphan gate already blocks every buy.
      expect(h.tracker.getState().status).toBe('running');
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('EMITS both, rather than only logging them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracker-crash-'));
    const dbPath = join(dir, 'tracker.db');
    const ledger = crashedLedger(dbPath);
    const h = open({ dbPath, ledger });

    try {
      await h.tracker.start();

      const reconciled = h.events.find((event) => event.type === 'reconciled');
      expect(reconciled?.data).toMatchObject({
        openPositions: [MINT_A],
        orphaned: [{ id: 'crashed-buy', mint: MINT_B, side: 'buy' }],
        dirty: true,
      });
      // "We started holding something, and we do not know what else" must not
      // be a thing only the log file knows.
      expect(h.logs.filter((line) => line.level === 'warn')).toHaveLength(2);
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('has every buy blocked by the orphan gate until it is signed off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracker-crash-'));
    const dbPath = join(dir, 'tracker.db');
    const ledger = crashedLedger(dbPath);
    const h = open({ dbPath, ledger, canSell: async () => ({ ok: true }) });

    try {
      await h.tracker.start();

      await expect(
        h.tracker.submit(buyIntent({ id: 'after-crash', mint: MINT_B })),
      ).rejects.toMatchObject({ code: 'UNACKNOWLEDGED_ORPHANS' });

      // And the exit for what it is already holding stays open.
      await expect(
        h.tracker.submit({
          id: 'exit-after-crash',
          side: 'sell',
          mint: MINT_A,
          amountTokens: 1_000_000_000n,
          maxSlippageBps: 300,
          reason: 'operator exit',
        }),
      ).resolves.toBeDefined();
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Strategy slot
// ---------------------------------------------------------------------------

describe('swaps create no intents', () => {
  const swap: TrackedSwap = {
    wallet: 'BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9XSiHMY',
    mint: MINT_A,
    side: 'buy',
    solAmount: 50_000_000n,
    tokenAmount: 1_000_000_000n,
    decimals: DECIMALS,
    signature: 'sig',
    slot: 1,
    blockTime: 1_700_000_000,
    venue: 'pumpfun',
    feePayer: true,
    source: 'live',
    observedAt: 1_700_000_000_000,
  };

  it('emits swap-detected', async () => {
    const h = open();
    await h.tracker.start();
    h.stream.emit('swap', swap);

    expect(h.events.filter((event) => event.type === 'swap-detected')).toHaveLength(1);
  });

  it('creates NO intent and touches no broker', async () => {
    const h = open({ canSell: async () => ({ ok: true }) });
    await h.tracker.start();
    h.stream.emit('swap', swap);
    await Promise.resolve();

    // The strategy slot is null and is not injectable. A stream event is a hint
    // about someone else's wallet at `confirmed` commitment — provisional, and
    // never a reason to spend.
    expect(h.events.filter((event) => event.type === 'intent-created')).toHaveLength(0);
    expect(h.brokerCalls.execute).toHaveLength(0);
    expect(h.ledger.getPositions()).toHaveLength(0);
  });

  it('forwards a stream error without crashing', async () => {
    const h = open();
    await h.tracker.start();
    h.stream.emit('error', new Error('socket closed'));

    expect(h.events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(h.tracker.getState().status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// Rejections keep their codes
// ---------------------------------------------------------------------------

describe('rejection codes survive to the client and to the ledger', () => {
  it('keeps SCREEN_FAILED distinguishable from SCREEN_UNKNOWN', async () => {
    const failed = open({
      canSell: async () => ({ ok: false, reason: 'SCREEN_FAILED:MINT_AUTHORITY_LIVE' }),
    });
    await failed.tracker.start();
    await expect(failed.tracker.submit(buyIntent({ id: 'f' }))).rejects.toBeInstanceOf(
      GuardRejection,
    );

    const unknown = open({
      canSell: async () => ({ ok: false, reason: 'SCREEN_UNKNOWN:LIQUIDITY_UNAVAILABLE' }),
    });
    await unknown.tracker.start();
    await expect(unknown.tracker.submit(buyIntent({ id: 'u' }))).rejects.toBeInstanceOf(
      GuardRejection,
    );

    const codeOf = (h: Harness): string =>
      (h.events.find((event) => event.type === 'rejection')?.data as { rejectionCode: string })
        .rejectionCode;

    // Both are CANNOT_SELL at the guard layer. An adversarial market and a
    // broken data provider must not produce the same record.
    expect(codeOf(failed)).toBe('CANNOT_SELL:SCREEN_FAILED:MINT_AUTHORITY_LIVE');
    expect(codeOf(unknown)).toBe('CANNOT_SELL:SCREEN_UNKNOWN:LIQUIDITY_UNAVAILABLE');
    expect(codeOf(failed)).not.toBe(codeOf(unknown));
  });

  it('writes the screener verdict into the ledger row, not just the log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracker-reject-'));
    const dbPath = join(dir, 'tracker.db');
    const ledger = openLedger({
      path: dbPath,
      logger: { info: () => undefined, warn: () => undefined },
    });
    const h = open({
      dbPath,
      ledger,
      canSell: async () => ({ ok: false, reason: 'SCREEN_FAILED:T22_PAUSABLE,T22_TRANSFER_HOOK' }),
    });

    try {
      await h.tracker.start();
      await expect(h.tracker.submit(buyIntent())).rejects.toBeInstanceOf(GuardRejection);

      // The guard layer never reaches the broker on a rejection, so nothing
      // else would have resolved this row. Read straight out of SQLite:
      // `Ledger` has no getter for `rejection_code`, and the claim under test
      // is about what is durably on disk.
      expect(ledger.getIntentStatus('buy-1')).toBe('rejected');
      ledger.close();

      const raw = new Database(dbPath, { readonly: true });
      const row = raw
        .prepare(`SELECT rejection_code FROM intents WHERE id = ?`)
        .get('buy-1') as { rejection_code: string };
      raw.close();

      expect(row.rejection_code).toBe(
        'CANNOT_SELL:SCREEN_FAILED:T22_PAUSABLE,T22_TRANSFER_HOOK',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a non-screener guard code alone', () => {
    const rejection = new GuardRejection(
      'GAS_RESERVE_BREACH',
      'would leave less than the reserve',
      buyIntent(),
    );
    expect(rejectionCodeOf(rejection)).toBe('GAS_RESERVE_BREACH');
  });

  it('does not decorate a CANNOT_SELL that did not come from the screener', () => {
    const rejection = new GuardRejection('CANNOT_SELL', 'mint cannot be sold', buyIntent());
    expect(rejectionCodeOf(rejection)).toBe('CANNOT_SELL');
  });

  it('records the intent before the broker is called', async () => {
    const h = open({ canSell: async () => ({ ok: true }) });
    await h.tracker.start();

    const submitted = h.tracker.submit(buyIntent());
    // The intent row exists before the fill does, which is what makes a crash
    // mid-swap leave evidence rather than silence.
    expect(h.ledger.getIntentStatus('buy-1')).toBe('pending');
    await submitted;
    expect(h.ledger.getIntentStatus('buy-1')).toBe('filled');
  });
});

// ---------------------------------------------------------------------------
// Price loop
// ---------------------------------------------------------------------------

describe('price loop', () => {
  it('marks each open position from a real exit quote', async () => {
    const h = open({ priceQuote: (request) => quoteOf(request, 60_000_000n) });
    h.ledger.recordFill(buyFill());

    await h.tracker.priceTick();

    const position = h.tracker.positions()[0];
    // 60_000_000 lamports for 1_000_000_000 base units at 6 decimals
    // = 60_000_000 * 1e6 / 1e9 = 60_000 lamports per whole token.
    expect(position?.markLamportsPerToken).toBe(60_000n);
    expect(position?.routeLost).toBe(false);
  });

  it('probes the WHOLE position, not a fixed sample size', async () => {
    const seen: QuoteRequest[] = [];
    const h = open({
      priceQuote: (request) => {
        seen.push(request);
        return quoteOf(request, 60_000_000n);
      },
    });
    h.ledger.recordFill(buyFill());

    await h.tracker.priceTick();

    // The number that matters is what this exact holding would fetch on the way
    // out, not what a probe-sized slice would.
    expect(seen[0]).toMatchObject({
      inMint: MINT_A,
      outMint: WRAPPED_SOL_MINT,
      inAmount: 1_000_000_000n,
    });
  });

  it('raises route-lost for a HELD mint with no way out', async () => {
    const h = open({
      priceQuote: () => ({ error: 'NO_ROUTE', message: 'TOKEN_NOT_TRADABLE' }),
    });
    h.ledger.recordFill(buyFill());

    await h.tracker.priceTick();

    const event = h.events.find((record) => record.type === 'route-lost');
    expect(event?.data).toMatchObject({ mint: MINT_A, tokens: '1000000000' });
    expect(h.tracker.positions()[0]?.routeLost).toBe(true);
  });

  it('fires route-lost on the EDGE, not every two seconds', async () => {
    const h = open({
      priceQuote: () => ({ error: 'NO_ROUTE', message: 'TOKEN_NOT_TRADABLE' }),
    });
    h.ledger.recordFill(buyFill());

    await h.tracker.priceTick();
    await h.tracker.priceTick();
    await h.tracker.priceTick();

    // An alert that repeats every tick is a log line wearing an alert's
    // clothes. The transition is the event.
    expect(h.events.filter((record) => record.type === 'route-lost')).toHaveLength(1);
  });

  it('does not flood the replay buffer a late client will read', async () => {
    const h = open({
      priceQuote: () => ({ error: 'NO_ROUTE', message: 'TOKEN_NOT_TRADABLE' }),
    });
    h.ledger.recordFill(buyFill());
    await h.tracker.start();

    for (let index = 0; index < 300; index += 1) await h.tracker.priceTick();

    // The buffer holds 200 events. Re-alerting every tick would push the
    // reconcile, the state changes and every other event out of it within four
    // minutes, so a client attaching later would see nothing but one repeated
    // alarm — the operational cost of a latch-free alert.
    const buffered = h.tracker.recentEvents();
    expect(buffered.filter((event) => event.type === 'route-lost')).toHaveLength(1);
    expect(buffered.some((event) => event.type === 'state-change')).toBe(true);
  });

  it('re-arms after the route comes back', async () => {
    let routable = false;
    const h = open({
      priceQuote: (request) =>
        routable ? quoteOf(request, 60_000_000n) : { error: 'NO_ROUTE', message: 'gone' },
    });
    h.ledger.recordFill(buyFill());

    await h.tracker.priceTick();
    routable = true;
    await h.tracker.priceTick();
    expect(h.tracker.positions()[0]?.routeLost).toBe(false);

    routable = false;
    await h.tracker.priceTick();
    expect(h.events.filter((record) => record.type === 'route-lost')).toHaveLength(2);
  });

  it('does NOT call a timeout a lost route', async () => {
    const h = open({
      priceQuote: () => ({ error: 'TIMEOUT', message: 'no response within 2000ms' }),
    });
    h.ledger.recordFill(buyFill());

    await h.tracker.priceTick();

    // A timeout is a fact about us; a lost route is a fact about the token.
    // Crying wolf here devalues the one alert that means "trapped".
    expect(h.events.filter((record) => record.type === 'route-lost')).toHaveLength(0);
    expect(h.tracker.positions()[0]?.routeLost).toBe(false);
    expect(h.logs.some((line) => line.message.includes('TIMEOUT'))).toBe(true);
  });

  it('does not call an upstream failure a lost route either', async () => {
    const h = open({
      priceQuote: () => ({ error: 'UPSTREAM_ERROR', message: 'HTTP 503' }),
    });
    h.ledger.recordFill(buyFill());

    await h.tracker.priceTick();

    // NO_ROUTE is the only quote outcome that is a fact about the token. Every
    // other one is a fact about us, and must not be dressed up as "trapped".
    expect(h.events.filter((record) => record.type === 'route-lost')).toHaveLength(0);
    expect(h.tracker.positions()[0]?.routeLost).toBe(false);
  });

  it('does not overlap itself when a tick outlives its interval', async () => {
    let calls = 0;
    const h = open({
      priceQuote: (request) => {
        calls += 1;
        return quoteOf(request, 60_000_000n);
      },
    });
    h.ledger.recordFill(buyFill());

    // Two ticks issued before the first has resolved — what a slow provider and
    // a 2-second interval produce.
    const first = h.tracker.priceTick();
    const second = h.tracker.priceTick();
    await Promise.all([first, second]);

    // The second is skipped, not queued: a backlog of price probes against a
    // slow provider only ever gets further behind.
    expect(calls).toBe(1);
    expect(h.tracker.stats.priceTicks).toBe(1);
  });

  it('does nothing when the book is empty', async () => {
    const h = open();
    await h.tracker.priceTick();
    expect(h.tracker.positions()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Held-position screen
// ---------------------------------------------------------------------------

describe('held-position screen', () => {
  it('screens every open position', async () => {
    const h = open();
    h.ledger.recordFill(buyFill());
    h.ledger.recordFill(buyFill({ intentId: 'seed-b', mint: MINT_B, at: NOW + 1 }));

    await h.tracker.screenTick();

    expect(h.screener.screened).toEqual([MINT_A, MINT_B]);
  });

  it('is registered on the slower cadence, 30s against the price loop 2s', async () => {
    const h = open();
    await h.tracker.start();

    // The registered cadences, read back off the scheduler the tracker actually
    // used. `unknown` is never cached by design, so a broken provider makes
    // every screen a real round trip; at 30s that is 0.1 req/s against a
    // 3-position cap, where the 2s price cadence would make it 1.5 req/s
    // forever — a transient outage turning into a rate-limit ban.
    expect(h.scheduler.intervals).toEqual([
      PRICE_INTERVAL_MS,
      SCREEN_INTERVAL_MS,
      HEARTBEAT_INTERVAL_MS,
    ]);
    expect(SCREEN_INTERVAL_MS).toBe(15 * PRICE_INTERVAL_MS);
  });

  it('is driven by the loop the tracker registered, not only by direct calls', async () => {
    const h = open();
    h.ledger.recordFill(buyFill());
    await h.tracker.start();

    // Fire the screen interval's own handler: the wiring between the scheduler
    // and `screenTick` is the part a direct call would never exercise.
    h.scheduler.fire(1);
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.screener.screened).toEqual([MINT_A]);
  });

  it('forwards sellability-degraded from the screener rather than restating it', async () => {
    const h = open();
    h.ledger.recordFill(buyFill());
    await h.tracker.screenTick();

    h.screener.emit('sellability-degraded', {
      mint: MINT_A,
      verdict: 'unknown',
      unknownChecks: ['LIQUIDITY_UNAVAILABLE'],
    });

    const event = h.events.find((record) => record.type === 'sellability-degraded');
    // One definition of "degraded", and it lives in the screener where the
    // previous verdict is known.
    expect(event?.data).toMatchObject({ mint: MINT_A, verdict: 'unknown' });
  });

  it('survives a screener that throws, and keeps going', async () => {
    const h = open();
    h.screener.error = new Error('rpc exploded');
    h.ledger.recordFill(buyFill());
    h.ledger.recordFill(buyFill({ intentId: 'seed-b', mint: MINT_B, at: NOW + 1 }));

    await h.tracker.screenTick();

    expect(h.screener.screened).toEqual([MINT_A, MINT_B]);
    expect(h.events.filter((record) => record.type === 'error')).toHaveLength(2);
  });

  it('creates no intent and blocks nothing', async () => {
    const h = open();
    h.ledger.recordFill(buyFill());
    await h.tracker.screenTick();

    expect(h.events.filter((record) => record.type === 'intent-created')).toHaveLength(0);
    expect(h.brokerCalls.execute).toHaveLength(0);
    expect(h.ledger.getPosition(MINT_A)?.state).toBe('open');
  });

  it('skips a tick while the previous one is still running', async () => {
    const h = open();
    h.ledger.recordFill(buyFill());

    const first = h.tracker.screenTick();
    const second = h.tracker.screenTick();
    await Promise.all([first, second]);

    expect(h.screener.screened).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe('event buffer', () => {
  it('numbers events monotonically', async () => {
    const h = open();
    await h.tracker.start();
    const seqs = h.tracker.recentEvents().map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('replays only what follows a sequence number', async () => {
    const h = open();
    await h.tracker.start();
    const all = h.tracker.recentEvents();
    const midpoint = all[0]?.seq ?? 0;

    // What a reconnecting client asks for: everything since what it already saw.
    expect(h.tracker.recentEvents(midpoint).every((event) => event.seq > midpoint)).toBe(true);
    expect(h.tracker.recentEvents(midpoint)).toHaveLength(all.length - 1);
  });

  it('bounds the buffer', async () => {
    const h = open();
    for (let index = 0; index < 400; index += 1) {
      h.tracker.killSwitch();
      h.tracker.releaseKillSwitch();
    }
    expect(h.tracker.recentEvents().length).toBeLessThanOrEqual(200);
    // And it keeps the newest, which is what a client attaching now needs.
    expect(h.tracker.recentEvents().at(-1)?.seq).toBeGreaterThan(400);
  });

  it('does not throw when an error event has no listener', async () => {
    const h = open();
    await h.tracker.start();
    // `EventEmitter` throws on an unhandled 'error'. A logged problem turning
    // into a process crash is the opposite of what an alert is for.
    expect(() => h.stream.emit('error', new Error('boom'))).not.toThrow();
    expect(h.tracker.recentEvents().some((event) => event.type === 'error')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End to end through the real screener
// ---------------------------------------------------------------------------

describe('the screener really is wired to buy gate 7', () => {
  it('refuses a buy the screener fails, with the code intact', async () => {
    const h = open({
      canSell: async (mint) => {
        expect(mint).toBe(MINT_A);
        return { ok: false, reason: 'SCREEN_FAILED:FREEZE_AUTHORITY_LIVE' };
      },
    });
    await h.tracker.start();

    await expect(h.tracker.submit(buyIntent())).rejects.toMatchObject({
      code: 'CANNOT_SELL',
      reason: 'SCREEN_FAILED:FREEZE_AUTHORITY_LIVE',
    });
  });

  it('NEVER consults it on a sell', async () => {
    let consulted = 0;
    const h = open({
      canSell: async () => {
        consulted += 1;
        return { ok: false, reason: 'SCREEN_FAILED:EVERYTHING' };
      },
    });
    h.ledger.recordFill(buyFill());
    await h.tracker.start();

    const fill: Fill = await h.tracker.submit({
      id: 'exit-1',
      side: 'sell',
      mint: MINT_A,
      amountTokens: 1_000_000_000n,
      maxSlippageBps: 300,
      reason: 'operator exit',
    });

    // Handoff 08's standing rule, enforced one layer further out: anything that
    // adds a sell-path call site is a bug regardless of how sound the reasoning
    // looks.
    expect(consulted).toBe(0);
    expect(fill.side).toBe('sell');
  });

  it('does not consult it during flatten either', async () => {
    let consulted = 0;
    const h = open({
      canSell: async () => {
        consulted += 1;
        return { ok: false, reason: 'SCREEN_FAILED:EVERYTHING' };
      },
    });
    h.ledger.recordFill(buyFill());

    const result = await h.tracker.flatten();

    expect(consulted).toBe(0);
    expect(result.completed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// An orderly stop, across a real process boundary
// ---------------------------------------------------------------------------

describe('an orderly stop invents no crash orphan (real child process)', () => {
  /**
   * In-process this is untestable. Abandoning the `await` inside `stop()` does
   * not abandon the intent's promise — it runs to completion regardless, and
   * the ledger ends up identical either way. The difference only exists if the
   * process exits the moment `stop()` returns, which is what the child does.
   */
  it('has written the fill by the time stop() returns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracker-stop-'));
    const dbPath = join(dir, 'tracker.db');

    try {
      // `node --import tsx`, not the tsx CLI: the CLI wrapper spawns an inner
      // process, and the exit timing under test would be the wrapper's.
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', resolve(HERE, 'fixtures/stop-child.ts'), dbPath, MINT_A],
        { encoding: 'utf8', cwd: PROJECT_ROOT, timeout: 30_000 },
      );
      expect(result.status, `child stderr: ${result.stderr}`).toBe(0);

      // A fresh process, opening the file the stopped one left behind.
      const ledger = openLedger({
        path: dbPath,
        logger: { info: () => undefined, warn: () => undefined },
      });
      try {
        const report = ledger.reconcileOnStartup(NOW + 10_000);

        // The consequence, not the mechanism: an intent abandoned by an early
        // return stays `pending`, and the next start files it as a crash orphan
        // that blocks every buy until a human checks the wallet against chain.
        // An orderly shutdown must not manufacture that chore.
        expect(report.orphaned).toEqual([]);
        expect(report.dirty).toBe(false);
        expect(ledger.getIntentStatus('inflight-intent')).toBe('filled');
        // 1e9 quoted, less the 30 bps paper latency penalty, floored against
        // the bot: the fill that landed is a real one, not a placeholder.
        expect(ledger.getPosition(MINT_A)?.tokens).toBe(997_000_000n);
      } finally {
        ledger.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Stream liveness is driven by the tracker
// ---------------------------------------------------------------------------

/**
 * `WalletStream.heartbeat()` was implemented and called from nowhere — not the
 * tracker, not the CLIs, not a test — so `SILENCE_TIMEOUT_MS` was dead and a
 * socket that stopped delivering without erroring was undetectable. Session 23
 * found that by watching a two-hour soak. This is the ninety-second version.
 */
describe('stream liveness', () => {
  it('drives the stream heartbeat from a loop it registered', async () => {
    const h = open();
    try {
      await h.tracker.start();
      expect(h.stream.heartbeats).toHaveLength(0);

      // Index 2: price, screen, then heartbeat. Firing the scheduler's own
      // handler is the part a direct call to `heartbeat()` would never exercise,
      // and "nothing calls it" was the entire defect.
      h.scheduler.fire(2);
      await new Promise((resolve) => setImmediate(resolve));

      expect(h.stream.heartbeats).toEqual([true]);
    } finally {
      h.close();
    }
  });

  it('reports a teardown so a silent socket is loud', async () => {
    const h = open();
    try {
      await h.tracker.start();
      h.stream.heartbeatTearsDown = true;
      h.scheduler.fire(2);
      await new Promise((resolve) => setImmediate(resolve));

      const errors = h.events.filter((event) => event.type === 'error');
      expect(errors.some((event) => /silent for/.test(JSON.stringify(event.data)))).toBe(true);
    } finally {
      h.close();
    }
  });

  it('stops driving liveness once the loops are torn down', async () => {
    const h = open();
    try {
      await h.tracker.start();
      await h.tracker.stop();
      // Idle and flat: the loops go, and so does the liveness tick, because
      // there is no subscription left to be silent.
      expect(h.scheduler.active).toBe(0);
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// An intent must always end up resolved
// ---------------------------------------------------------------------------

/**
 * Session 23 left six buy intents `pending` for over an hour, through a clean
 * shutdown, and they became `CRASH_ORPHAN`s that shut the entry gate on the next
 * boot. Session 24 found the mechanism, and it is not a race.
 *
 * Guard gates 7 and 8 do `await inner.getQuote(intent)` and
 * `await inner.canSell(intent.mint)` with no `try`. A quote outage therefore
 * throws a `QuoteUnavailableError` — not a `GuardRejection` — out of
 * `guarded().execute` **before the inner broker runs at all**. The broker
 * resolves its own failures, but it never ran; the guard layer resolves its own
 * rejections, but this was not one; and the tracker only logged it. Nobody owned
 * the row.
 *
 * The timing in the session file is unambiguous: the first `UPSTREAM_ERROR`
 * quote landed at 15:51:36.011 and the first intent that never resolved was
 * created at 15:51:50.911, 14.9 seconds later. Quote errors went from 5.9% of
 * quotes before that boundary to 70.3% after it, and every buy from then on hung.
 */
describe('intent resolution is total', () => {
  it('resolves an intent whose execution threw before the broker was reached', async () => {
    const h = open({
      canSell: async () => ({ ok: true }),
      // Thrown where a quote outage throws it: inside `execute`, ahead of the
      // paper broker, so nothing downstream has recorded or resolved anything.
      beforeExecute: async () => {
        throw new Error('quote provider is down: UPSTREAM_ERROR');
      },
    });
    try {
      await h.tracker.start();

      await expect(h.tracker.submit(buyIntent({ id: 'stranded' }))).rejects.toThrow(
        /UPSTREAM_ERROR/,
      );

      // The whole point. `pending` here is what became a CRASH_ORPHAN and shut
      // the entry gate until an operator ran `npm run orphans` by hand.
      expect(h.ledger.getIntentStatus('stranded')).not.toBe('pending');
      expect(h.ledger.getIntentStatus('stranded')).toBe('failed');
    } finally {
      h.close();
    }
  });

  it('leaves no unacknowledged orphan behind after such a failure', async () => {
    const h = open({
      canSell: async () => ({ ok: true }),
      beforeExecute: async () => {
        throw new Error('quote provider is down: UPSTREAM_ERROR');
      },
    });
    try {
      await h.tracker.start();
      await expect(h.tracker.submit(buyIntent({ id: 'stranded-2' }))).rejects.toThrow();

      // A restart reconciles: nothing was left pending, so nothing is orphaned
      // and gate 0 stays open without an operator touching it.
      const report = h.ledger.reconcileOnStartup(NOW);
      expect(report.orphaned).toHaveLength(0);
      expect(h.ledger.getUnacknowledgedOrphanCount()).toBe(0);
    } finally {
      h.close();
    }
  });

  it('does not overwrite a resolution the broker already made', async () => {
    // The broker resolves its own failures. The safety net must not relabel
    // one that was already handled, or every broker-side `failed` would be
    // rewritten by whoever unwound last.
    const h = open({ canSell: async () => ({ ok: true }) });
    try {
      await h.tracker.start();
      const fill = await h.tracker.submit(buyIntent({ id: 'clean' }));
      expect(fill.intentId).toBe('clean');
      expect(h.ledger.getIntentStatus('clean')).toBe('filled');
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Position monitoring survives a slow feed
// ---------------------------------------------------------------------------

describe('the exit monitor does not wait for the feed', () => {
  /** A stream whose `start()` never settles — an unbounded warm gap fill. */
  function hangingStream(h: Harness): void {
    h.stream.start = () => new Promise<void>(() => undefined);
  }

  it('runs the price loop for positions the reconcile reported, while the feed hangs', async () => {
    const h = open();
    h.ledger.recordFill(buyFill());
    h.ledger.recordFill(buyFill({ intentId: 'seed-buy-b', mint: MINT_B }));
    hangingStream(h);

    // Deliberately NOT awaited: the feed never comes up, so this never returns.
    // That is the condition being tested, not a flaw in the test.
    void h.tracker.start();
    await new Promise((resolve) => setImmediate(resolve));

    // Scheduled before the await, so the loop exists even though `start()` is
    // still outstanding. Only the price loop — the screen and heartbeat loops
    // are about the feed, and the feed is down.
    expect(h.scheduler.active).toBe(1);

    for (let interval = 0; interval < 3; interval += 1) {
      h.scheduler.fire(0);
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Before this change the loop was scheduled after `await stream.start()`,
    // so two positions went 132 minutes on 2026-08-09 with no stop-loss, no
    // take-profit and no route-lost.
    expect(h.tracker.stats.priceTicks).toBeGreaterThan(0);
  });

  it('takes exits but refuses entries while the feed is still coming up', async () => {
    const h = open();
    h.ledger.recordFill(buyFill());
    hangingStream(h);

    void h.tracker.start();
    await new Promise((resolve) => setImmediate(resolve));

    // Gate 2 reads `status !== 'running'`, and the status flip stays below the
    // await on purpose: opening the entry gate onto a feed that is not there
    // would be worse than a delayed start.
    expect(h.tracker.getState().status).not.toBe('running');
    await expect(h.tracker.submit(buyIntent({ id: 'early-buy' }))).rejects.toMatchObject({
      code: 'NOT_RUNNING',
    });

    // The exit still works, because a sell never reaches the entry gates. A bot
    // that is holding must be able to get out even before its feed is up.
    const fill = await h.tracker.submit({
      id: 'early-exit',
      side: 'sell',
      mint: MINT_A,
      amountTokens: 1_000_000_000n,
      maxSlippageBps: 300,
      reason: 'operator exit during startup',
    });
    expect(fill.side).toBe('sell');
    expect(h.ledger.getPosition(MINT_A)?.state).toBe('closed');
  });

  it('still leaves the price loop running after a stop that held positions', async () => {
    // Existing behaviour, asserted here against regression: the split of
    // `ensurePriceLoop` out of `ensureLoops` must not change what survives a
    // stop, because a stopped bot still holding is when the alerts matter most.
    const h = open();
    h.ledger.recordFill(buyFill());

    await h.tracker.start();
    await h.tracker.stop();

    expect(h.scheduler.active).toBe(3);
    const before = h.tracker.stats.priceTicks;
    h.scheduler.fire(0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.tracker.stats.priceTicks).toBeGreaterThan(before);
  });
});

// ---------------------------------------------------------------------------
// `running` means the socket is live
// ---------------------------------------------------------------------------

describe('running is bound to the feed, not to start() returning', () => {
  it('stays out of running when start() resolves without a socket', async () => {
    // `WalletStream.start()` RESOLVES when the initial connect fails — it hands
    // off to the reconnect chain and returns. Bound to that, the bot went
    // `running` with no socket at all, which is an open entry gate on a feed
    // that is not there.
    const h = open();
    h.stream.withholdConnected = true;

    await h.tracker.start();

    expect(h.stream.starts).toBe(1);
    expect(h.tracker.getState().status).not.toBe('running');
    await expect(h.tracker.submit(buyIntent())).rejects.toMatchObject({
      code: 'NOT_RUNNING',
    });
  });

  it('promotes when the feed comes up later, on the reconnect chain', async () => {
    const h = open();
    h.stream.withholdConnected = true;
    await h.tracker.start();
    expect(h.tracker.getState().status).not.toBe('running');

    // The reconnect chain emits this on every successful connect, not only on
    // the first one.
    h.stream.emit('connected', { at: Date.now() });

    expect(h.tracker.getState().status).toBe('running');
  });

  it('does not let a socket coming back promote a bot that was stopped', async () => {
    const h = open();
    await h.tracker.start();
    expect(h.tracker.getState().status).toBe('running');

    await h.tracker.stop();
    expect(h.tracker.getState().status).toBe('idle');

    // A reconnect landing after teardown must not restart the run.
    h.stream.emit('connected', { at: Date.now() });

    expect(h.tracker.getState().status).toBe('idle');
  });

  it('still stops a run whose connect never succeeded', async () => {
    // `stop()` used to return early on `status === 'idle'`. That is no longer
    // sufficient: a run whose connect failed sits at idle with a reconnect
    // chain in flight, and returning would leave the stream retrying for the
    // life of the process with `wantRunning` still set.
    const h = open();
    h.stream.withholdConnected = true;
    await h.tracker.start();

    await h.tracker.stop();

    expect(h.stream.stops).toBe(1);
    h.stream.emit('connected', { at: Date.now() });
    expect(h.tracker.getState().status).toBe('idle');
  });

  it('records the connect separately from the backfill', async () => {
    // Two halves of startup with very different magnitudes once start()
    // connects before it fills. One interval today; two after.
    const h = open();
    await h.tracker.start();

    expect(h.events.filter((event) => event.type === 'stream-connected')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// An exit that arrives mid-entry
// ---------------------------------------------------------------------------

describe('the discarded exit', () => {
  const settle = async (n = 12): Promise<void> => {
    for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
  };

  /**
   * The latch sits on the strategy path, behind the same `driver === null`
   * check as strategy dispatch — deliberately. A tracker with no strategy is a
   * pure observer, and it must not start selling on its own because an operator
   * happened to have a manual buy in flight.
   */
  function attachStub(h: Harness): void {
    const driver = new EventEmitter() as unknown as Parameters<
      typeof h.tracker.useStrategy
    >[0];
    (driver as unknown as { onTrackedSwap: () => Promise<void> }).onTrackedSwap = async () =>
      undefined;
    h.tracker.useStrategy(driver);
  }

  /** A swap for MINT_A on the given side, live and fresh. */
  function swapOn(side: 'buy' | 'sell'): TrackedSwap {
    return {
      wallet: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      mint: MINT_A,
      side,
      solAmount: 1_000_000_000n,
      tokenAmount: 1_000_000_000n,
      decimals: DECIMALS,
      signature: `sig-${side}`,
      slot: 1,
      blockTime: null,
      venue: 'pumpfun',
      feePayer: true,
      source: 'live',
      observedAt: NOW,
    };
  }

  it('fires the sell once the entry fills, exactly once', async () => {
    const h = open({ canSell: async () => ({ ok: true }) });
    attachStub(h);
    await h.tracker.start();

    // An entry is in flight for MINT_A when the source's exit arrives.
    const entry = h.tracker.submit(buyIntent());
    await Promise.resolve();
    h.stream.emit('swap', swapOn('sell'));

    await entry;
    await settle();

    expect(h.tracker.stats.exitLatchFired).toBe(1);
    // An ordinary sell through submit() and the guards — no bypass.
    const sells = h.brokerCalls.execute.filter((call) => call.side === 'sell');
    expect(sells).toHaveLength(1);
    expect(h.ledger.getPosition(MINT_A)?.state).toBe('closed');
  });

  it('discards and COUNTS the latch when the entry never becomes a position', async () => {
    const h = open({ canSell: async () => ({ ok: true }) });
    attachStub(h);
    await h.tracker.start();
    h.tracker.killSwitch();

    // Refused at gate 1, so no position ever exists.
    const entry = h.tracker.submit(buyIntent()).catch(() => undefined);
    await Promise.resolve();
    h.stream.emit('swap', swapOn('sell'));
    await entry;
    await settle();

    expect(h.tracker.stats.exitLatchFired).toBe(0);
    expect(h.tracker.stats.exitLatchDiscarded).toBe(1);
    // A latch that evaporates silently is the same defect as the 49 invisible
    // intents, so the discard is recorded rather than merely not happening.
    expect(
      h.events.filter((e) => e.type === 'exit-latch-resolved'),
    ).toHaveLength(1);
    expect(h.brokerCalls.execute.filter((c) => c.side === 'sell')).toHaveLength(0);
  });

  it('leaves the ordinary path alone when the exit arrives after the fill', async () => {
    const h = open({ canSell: async () => ({ ok: true }) });
    attachStub(h);
    h.ledger.recordFill(buyFill());
    await h.tracker.start();

    // Nothing in flight: the position is already open, so this is the existing
    // strategy path and must not be latched or doubled.
    h.stream.emit('swap', swapOn('sell'));
    await settle();

    expect(h.tracker.stats.exitLatchFired).toBe(0);
    expect(h.tracker.stats.exitLatchDiscarded).toBe(0);
    expect(h.events.filter((e) => e.type === 'exit-latched')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Per-wallet admission
// ---------------------------------------------------------------------------

describe('a wallet we cannot copy is refused at the signal', () => {
  const settle = async (n = 10): Promise<void> => {
    for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
  };
  const FAST = 'popo3Rj6arKNttyUFpWfbkv2gG8uS13TGtmH6JPMuHz';
  const SLOW = 'CT9dekyfadMYxLdfxV76ASSLo2QKXaj5cGPmvM2rcKVC';
  const THIN = 'yVrqX84dNn9pWP3Y2gBzqkCqHLfw7zsukSqjZTDoQ2C';

  const scores: WalletScoresFile = {
    generatedAt: '2026-08-11T00:00:00.000Z',
    basis: 'session 26, n=147 paired round trips against a 5,479ms chain-to-fill',
    scores: [
      // 14/14 round trips close inside our chain-to-fill.
      { wallet: FAST, uncopyableShare: 1, roundTrips: 14, againstDelayMs: 5_479,
        measuredFrom: 'a', measuredTo: 'b' },
      { wallet: SLOW, uncopyableShare: 0, roundTrips: 40, againstDelayMs: 5_479,
        measuredFrom: 'a', measuredTo: 'b' },
      // Perfect share, meaningless sample.
      { wallet: THIN, uncopyableShare: 0, roundTrips: 1, againstDelayMs: 5_479,
        measuredFrom: 'a', measuredTo: 'b' },
    ],
  };

  /** The gate sits behind the same driver check as strategy dispatch. */
  function attachIdleDriver(h: Harness): void {
    const driver = new EventEmitter() as unknown as Parameters<typeof h.tracker.useStrategy>[0];
    (driver as unknown as { onTrackedSwap: () => Promise<void> }).onTrackedSwap = async () =>
      undefined;
    h.tracker.useStrategy(driver);
  }

  function swapFrom(wallet: string, side: 'buy' | 'sell' = 'buy'): TrackedSwap {
    return {
      wallet, mint: MINT_A, side, solAmount: 1_000_000_000n, tokenAmount: 1_000_000_000n,
      decimals: DECIMALS, signature: `sig-${wallet.slice(0, 4)}-${side}`, slot: 1,
      blockTime: null, venue: 'pumpfun', feePayer: true, source: 'live', observedAt: NOW,
    };
  }

  it('refuses a 100%-uncopyable wallet, typed and logged with its n', async () => {
    const h = harness({ walletScores: scores, canSell: async () => ({ ok: true }) });
    openHarnesses.push(h);
    const driver = new EventEmitter() as unknown as Parameters<typeof h.tracker.useStrategy>[0];
    let consulted = 0;
    (driver as unknown as { onTrackedSwap: () => Promise<void> }).onTrackedSwap = async () => {
      consulted += 1;
    };
    h.tracker.useStrategy(driver);
    await h.tracker.start();

    h.stream.emit('swap', swapFrom(FAST));
    await settle();

    // Refused before the strategy is even asked.
    expect(consulted).toBe(0);
    const refusals = h.events.filter((e) => e.type === 'signal-refused');
    expect(refusals).toHaveLength(1);
    const payload = refusals[0]?.data as { code: string; uncopyableShare: number; roundTrips: number };
    expect(payload.code).toBe('WALLET_NOT_COPYABLE');
    expect(payload.uncopyableShare).toBe(1);
    expect(payload.roundTrips).toBe(14);
  });

  it('refuses an unscored wallet as WALLET_UNSCORED, reporting the sample size', async () => {
    // "We know this is bad" and "we do not know" are different facts, and only
    // the second is fixed by waiting for more data.
    const h = harness({ walletScores: scores, canSell: async () => ({ ok: true }) });
    openHarnesses.push(h);
    attachIdleDriver(h);
    await h.tracker.start();

    h.stream.emit('swap', swapFrom(THIN));
    h.stream.emit('swap', swapFrom('BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9XSiHMY'));
    await settle();

    const codes = h.events
      .filter((e) => e.type === 'signal-refused')
      .map((e) => (e.data as { code: string; roundTrips: number }));
    expect(codes).toHaveLength(2);
    expect(codes.every((c) => c.code === 'WALLET_UNSCORED')).toBe(true);
    // Thin sample reports what it had; entirely absent reports zero.
    expect(codes.map((c) => c.roundTrips).sort()).toEqual([0, 1]);
  });

  it('lets a wallet under the threshold through unchanged', async () => {
    const h = harness({ walletScores: scores, canSell: async () => ({ ok: true }) });
    openHarnesses.push(h);
    const driver = new EventEmitter() as unknown as Parameters<typeof h.tracker.useStrategy>[0];
    let consulted = 0;
    (driver as unknown as { onTrackedSwap: () => Promise<void> }).onTrackedSwap = async () => {
      consulted += 1;
    };
    h.tracker.useStrategy(driver);
    await h.tracker.start();

    h.stream.emit('swap', swapFrom(SLOW));
    await settle();

    expect(consulted).toBe(1);
    expect(h.events.filter((e) => e.type === 'signal-refused')).toHaveLength(0);
  });

  it('refuses even when the wallet IS in config.trackedWallets', async () => {
    // Config is editable and the gate must hold if someone puts it back.
    // Removing a wallet from config is not the deliverable.
    const h = harness({
      walletScores: scores,
      canSell: async () => ({ ok: true }),
      config: { trackedWallets: [FAST, SLOW] },
    });
    openHarnesses.push(h);
    attachIdleDriver(h);
    await h.tracker.start();

    expect(h.config.trackedWallets).toContain(FAST);
    h.stream.emit('swap', swapFrom(FAST));
    await settle();

    expect(h.events.filter((e) => e.type === 'signal-refused')).toHaveLength(1);
  });

  it('leaves exits on a refused wallet completely alone', async () => {
    // A position held on a refused wallet's mint must still be exitable. The
    // gate is about acquiring exposure; applying it to an exit would strand the
    // book on a wallet we stopped following.
    const h = harness({ walletScores: scores, canSell: async () => ({ ok: true }) });
    openHarnesses.push(h);
    h.ledger.recordFill(buyFill());
    const driver = new EventEmitter() as unknown as Parameters<typeof h.tracker.useStrategy>[0];
    const seen: string[] = [];
    (driver as unknown as { onTrackedSwap: (s: TrackedSwap) => Promise<void> }).onTrackedSwap =
      async (swap) => {
        seen.push(swap.side);
      };
    h.tracker.useStrategy(driver);
    await h.tracker.start();

    h.stream.emit('swap', swapFrom(FAST, 'sell'));
    await settle();

    // The sell reached the strategy despite the wallet being refused for entry.
    expect(seen).toEqual(['sell']);
    expect(h.events.filter((e) => e.type === 'signal-refused')).toHaveLength(0);

    // And the price loop, which never reads this path, still sells it.
    h.scheduler.fire(0);
    await settle();
    expect(h.tracker.stats.priceTicks).toBeGreaterThan(0);
  });
});
