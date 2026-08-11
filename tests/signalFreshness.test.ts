/**
 * Signal freshness, end to end.
 *
 * The failure this closes: the websocket drops, reconnects twenty minutes
 * later, and `WalletStream.gapFill` hands the strategy the whole backlog at
 * once. On *startup* that is harmless by accident — the gap fill runs inside
 * `stream.start()`, before `setStatus('running')`, and `Tracker.onSwap` drops
 * everything while idle. On *reconnect* status is already `running`, so nothing
 * stops it and fifty stale entries execute at full position size.
 *
 * The reconnect scenario at the bottom of this file is the whole point. The
 * unit tests above it exist so that when it fails, its failure is readable.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/core/config.js';
import type { Config } from '../src/core/config.js';
import type { QuoteRequest, QuoteSource } from '../src/core/quoteSource.js';
import type { Address, Quote, TrackedSwap } from '../src/core/types.js';
import { createPaperBroker } from '../src/adapters/paperBroker.js';
import { createDecimalsResolver, fixtureDecimalsSource } from '../src/adapters/mintMetadata.js';
import { openLedger } from '../src/db/ledger.js';
import { openRuntimeState } from '../src/db/runtimeState.js';
import { Tracker } from '../src/services/tracker.js';
import type {
  HeldPositionScreener,
  Scheduler,
  TrackerEventRecord,
  WalletFeed,
} from '../src/services/tracker.js';
import { StrategyRunner, signalOf } from '../src/services/strategyRunner.js';
import { createMirrorStrategy } from '../src/strategies/mirror.js';
import { copyableScores } from './fixtures/scores.js';

const NOW = 1_700_000_000_000;
const DECIMALS = 6;
const WALLET = 'BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9XSiHMY';

/** Twenty minutes, the disconnect the reconnect scenario simulates. */
const TWENTY_MINUTES_MS = 20 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Mints
// ---------------------------------------------------------------------------

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Distinct valid base58 mints.
 *
 * Distinct rather than one repeated, because `StrategyRunner` holds a per-mint
 * lock: fifty swaps of the same mint would be *skipped as locked*, and a test
 * asserting "zero intents" would pass for that reason instead of the one under
 * test. Fifty different mints means fifty independent trips through the gate.
 */
function mintAt(index: number): Address {
  const head = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pP';
  const a = BASE58[index % BASE58.length] as string;
  const b = BASE58[Math.floor(index / BASE58.length) % BASE58.length] as string;
  return `${head}${a}${b}`;
}

// ---------------------------------------------------------------------------
// signalOf — the null-blockTime policy
// ---------------------------------------------------------------------------

function swapOf(overrides: Partial<TrackedSwap> = {}): TrackedSwap {
  return {
    wallet: WALLET,
    mint: mintAt(0),
    side: 'buy',
    solAmount: 50_000_000n,
    tokenAmount: 1_000_000_000n,
    decimals: DECIMALS,
    signature: 'sig',
    slot: 1,
    blockTime: NOW / 1_000,
    venue: 'pumpfun',
    feePayer: true,
    source: 'live',
    observedAt: NOW,
    ...overrides,
  };
}

describe('signalOf', () => {
  it('converts blockTime from seconds to millis', () => {
    const signal = signalOf(swapOf({ blockTime: 1_699_999_990 }), NOW);
    expect(signal.signalAt).toBe(1_699_999_990_000);
    expect(signal.signalAgeMs).toBe(10_000);
  });

  it('prefers blockTime over observedAt when both are present', () => {
    // observedAt says "just now"; blockTime says the block is a minute old. The
    // block wins, because the question is how stale the price signal is, not
    // how recently we happened to fetch it.
    const signal = signalOf(swapOf({ blockTime: (NOW - 60_000) / 1_000, observedAt: NOW }), NOW);
    expect(signal.signalAgeMs).toBe(60_000);
  });

  it('falls back to observedAt for a live swap with no blockTime', () => {
    const signal = signalOf(
      swapOf({ blockTime: null, source: 'live', observedAt: NOW - 2_000 }),
      NOW,
    );
    expect(signal.signalAt).toBe(NOW - 2_000);
    expect(signal.signalAgeMs).toBe(2_000);
  });

  /**
   * The fail-closed case, and the reason `observedAt` exists at all.
   *
   * For a gap fill, `observedAt` records only when *we fetched it* — which for
   * a twenty-minute backlog is "just now", no matter how old the transaction
   * is. Trusting it would hand the gate a stale swap wearing a fresh timestamp,
   * which is precisely the bug. So it refuses instead of guessing.
   */
  it('treats a gapfill swap with no blockTime as maximally stale', () => {
    const signal = signalOf(
      swapOf({ blockTime: null, source: 'gapfill', observedAt: NOW }),
      NOW,
    );
    expect(signal.signalAt).toBe(0);
    expect(signal.signalAgeMs).toBe(NOW);
  });

  it('clamps a future blockTime to zero rather than reporting a negative age', () => {
    // `blockTime` is a stake-weighted median, not a clock, so it can sit ahead
    // of local time on a fresh block. A negative age would be nonsense in the
    // ledger and in the audit log.
    const signal = signalOf(swapOf({ blockTime: (NOW + 5_000) / 1_000 }), NOW);
    expect(signal.signalAgeMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Full-stack harness
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

const noopScheduler: Scheduler = { setInterval: () => 0, clearInterval: () => undefined };

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

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/**
 * A tracker with the real strategy runner and the real mirror strategy behind
 * it, so a swap travels the whole path an operator's would: onSwap -> runner ->
 * mirror -> stamped intent -> `guarded()` -> paper broker -> ledger.
 *
 * Nothing here is a stub except the feed, the screener and the clock. Stubbing
 * the guard layer or the runner would remove the two components the freshness
 * mechanism is actually made of.
 */
function harness(configOverrides: Partial<Config> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'signal-'));
  const dbPath = join(dir, 'tracker.db');
  const config = parseConfig({ maxConcurrentPositions: 100, ...configOverrides });

  const ledger = openLedger({
    path: dbPath,
    logger: { info: () => undefined, warn: () => undefined },
  });
  const runtime = openRuntimeState({ path: dbPath });

  const quotes: QuoteSource = { getQuote: async (r) => quoteOf(r, 1_000_000_000n) };
  const decimalsFor: Record<string, number> = {};
  for (let i = 0; i < 200; i += 1) decimalsFor[mintAt(i)] = DECIMALS;

  let clock = NOW;
  const broker = createPaperBroker({
    quoteSource: quotes,
    resolveDecimals: createDecimalsResolver(fixtureDecimalsSource(decimalsFor)),
    ledger,
    config,
    latencyMs: 0,
    now: () => (clock += 1),
    canSell: async () => ({ ok: true }),
  });

  const stream = new FakeStream();
  const events: TrackerEventRecord[] = [];

  const tracker = new Tracker({
    walletScores: copyableScores,
    config,
    ledger,
    runtime,
    broker,
    screener: new FakeScreener(),
    quotes,
    stream,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    scheduler: noopScheduler,
    now: () => NOW,
  });
  tracker.on('event', (event: TrackerEventRecord) => events.push(event));

  const runner = new StrategyRunner({
    strategy: createMirrorStrategy(),
    config,
    quotes,
    resolveDecimals: async () => DECIMALS,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => NOW,
    host: {
      getState: () => tracker.getState(),
      openPositions: () => ledger.getOpenPositions(),
      balanceLamports: () => broker.getBalanceLamports(),
      submit: (intent) => tracker.submit(intent),
    },
  });
  tracker.useStrategy(runner);

  cleanups.push(() => {
    runtime.close();
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    tracker,
    ledger,
    stream,
    events,
    rejections: () =>
      events
        .filter((e) => e.type === 'rejection')
        .map((e) => (e.data as { code?: string }).code),
    intents: () => events.filter((e) => e.type === 'intent-created'),
    fills: () => events.filter((e) => e.type === 'fill'),
  };
}

/** Emit and let the runner's per-mint work settle. */
async function feed(h: ReturnType<typeof harness>, swaps: TrackedSwap[]): Promise<void> {
  for (const swap of swaps) h.stream.emit('swap', swap);
  // The runner is async end to end; drain the microtask queue until quiet.
  for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// The reconnect scenario
// ---------------------------------------------------------------------------

describe('a reconnect backlog cannot open positions', () => {
  /**
   * THE test. Twenty minutes of missed traffic arrives while the bot is fully
   * `running` — the state in which nothing previously stood between a gap fill
   * and the broker.
   */
  it('creates zero fills from 50 backfilled swaps carrying 20-minute-old blockTimes', async () => {
    const h = harness();
    await h.tracker.start();
    expect(h.tracker.getState().status).toBe('running');

    const backlog = Array.from({ length: 50 }, (_, i) =>
      swapOf({
        mint: mintAt(i),
        signature: `backfill-${i}`,
        slot: 1_000 + i,
        source: 'gapfill',
        // Spread across the outage, oldest first — the newest is still a full
        // twenty minutes behind the clock.
        blockTime: (NOW - TWENTY_MINUTES_MS - i * 1_000) / 1_000,
        observedAt: NOW,
      }),
    );

    await feed(h, backlog);

    // The claim that matters: no money moved.
    expect(h.fills()).toHaveLength(0);
    expect(h.ledger.getOpenPositions()).toHaveLength(0);

    // And it was refused for the right reason, 50 times, visibly.
    const codes = h.rejections();
    expect(codes).toHaveLength(50);
    expect(new Set(codes)).toEqual(new Set(['STALE_SIGNAL']));
  });

  /**
   * The counterweight. Without this the test above would pass just as happily
   * against a stack that was inert for some unrelated reason — a broken runner,
   * an unattached strategy, a screener refusing everything.
   */
  it('the same 50 swaps DO fill when their blockTimes are fresh', async () => {
    const h = harness();
    await h.tracker.start();

    const live = Array.from({ length: 50 }, (_, i) =>
      swapOf({
        mint: mintAt(i),
        signature: `live-${i}`,
        slot: 2_000 + i,
        source: 'live',
        blockTime: (NOW - 1_000) / 1_000,
        observedAt: NOW,
      }),
    );

    await feed(h, live);

    expect(h.fills().length).toBeGreaterThan(0);
    expect(h.ledger.getOpenPositions().length).toBeGreaterThan(0);
    expect(h.rejections()).not.toContain('STALE_SIGNAL');
  });

  it('records the measured age on the intent, not just the refusal', async () => {
    const h = harness();
    await h.tracker.start();

    await feed(h, [
      swapOf({
        mint: mintAt(7),
        source: 'gapfill',
        blockTime: (NOW - TWENTY_MINUTES_MS) / 1_000,
      }),
    ]);

    // The intent is written before the guard runs, so the age that caused the
    // refusal travels with the event rather than only appearing as a code.
    // (The event stream, not the ledger — `intents` has no column for it and
    // `db/ledger.ts` is out of scope here.)
    const created = h.intents();
    expect(created).toHaveLength(1);
    expect((created[0]?.data as { signalAgeMs?: number }).signalAgeMs).toBe(TWENTY_MINUTES_MS);
  });

  /**
   * Correction from handoff 14: the age check lives in `guards.ts` alone.
   * Filtering in `mirror.ts` as well would work and would be invisible — no
   * intent, no `intents.rejection_code` row, and a STALE_SIGNAL counter reading
   * zero while the bot quietly declined to trade.
   */
  it('still creates the intent, so the refusal is countable', async () => {
    const h = harness();
    await h.tracker.start();

    await feed(h, [
      swapOf({ mint: mintAt(9), source: 'gapfill', blockTime: (NOW - 600_000) / 1_000 }),
    ]);

    expect(h.intents()).toHaveLength(1);
    expect(h.rejections()).toEqual(['STALE_SIGNAL']);
  });

  it('honours a tightened maxSignalAgeMs end to end', async () => {
    const h = harness({ maxSignalAgeMs: 5_000 });
    await h.tracker.start();

    await feed(h, [
      // 10s old: fine under the 15s default, stale under this config.
      swapOf({ mint: mintAt(11), blockTime: (NOW - 10_000) / 1_000 }),
    ]);

    expect(h.fills()).toHaveLength(0);
    expect(h.rejections()).toEqual(['STALE_SIGNAL']);
  });

  it('refuses a gapfill swap whose blockTime the RPC omitted', async () => {
    const h = harness();
    await h.tracker.start();

    await feed(h, [
      swapOf({ mint: mintAt(13), source: 'gapfill', blockTime: null, observedAt: NOW }),
    ]);

    expect(h.fills()).toHaveLength(0);
    expect(h.rejections()).toEqual(['STALE_SIGNAL']);
  });

  it('accepts a live swap whose blockTime the RPC omitted', async () => {
    const h = harness();
    await h.tracker.start();

    await feed(h, [
      swapOf({ mint: mintAt(15), source: 'live', blockTime: null, observedAt: NOW - 500 }),
    ]);

    expect(h.rejections()).not.toContain('STALE_SIGNAL');
    expect(h.fills()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The runner is the authority
// ---------------------------------------------------------------------------

describe('a strategy cannot forge its own signal age', () => {
  /**
   * `StrategyRunner` spreads the provenance AFTER `...draft`, so a strategy
   * setting `signalAgeMs: 0` on a twenty-minute-old swap is overwritten rather
   * than merged. Strategy code is untrusted; this is the difference between a
   * gate and a suggestion.
   */
  it('overwrites what the strategy set', async () => {
    const h = harness();
    await h.tracker.start();

    // MirrorStrategy sets neither field, so this asserts the runner supplies
    // them from the swap rather than passing the draft through untouched.
    await feed(h, [
      swapOf({
        mint: mintAt(17),
        source: 'gapfill',
        blockTime: (NOW - TWENTY_MINUTES_MS) / 1_000,
      }),
    ]);

    const intent = h.intents()[0]?.data as { signalAt?: number; signalAgeMs?: number };
    expect(intent.signalAt).toBe(NOW - TWENTY_MINUTES_MS);
    expect(intent.signalAgeMs).toBe(TWENTY_MINUTES_MS);
  });

  it('leaves an exit unstamped, so it is never age-gated', async () => {
    const h = harness();
    await h.tracker.start();

    // Open a position on fresh signal, then exit it via the tracked wallet's
    // sell — the exit path carries no originating-swap metadata of its own.
    const mint = mintAt(19);
    await feed(h, [swapOf({ mint, blockTime: (NOW - 1_000) / 1_000 })]);
    expect(h.ledger.getOpenPositions()).toHaveLength(1);

    await feed(h, [
      swapOf({
        mint,
        side: 'sell',
        signature: 'exit',
        source: 'gapfill',
        blockTime: (NOW - TWENTY_MINUTES_MS) / 1_000,
      }),
    ]);

    // The sell went through on a signal far past the limit. That is the
    // asymmetry working: a risk limit must never trap a holder.
    expect(h.rejections()).not.toContain('STALE_SIGNAL');
    expect(h.ledger.getOpenPositions()).toHaveLength(0);
  });
});
