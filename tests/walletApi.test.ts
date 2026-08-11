/**
 * The `/wallets` routes and the screener page they serve.
 *
 * Kept out of `api.test.ts` because everything here needs a `WalletStore`, and
 * the point of the store being optional is that the existing harness — an API
 * with no store at all — stays a valid, fully working control API.
 */

import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/core/config.js';
import type { QuoteRequest, QuoteSource } from '../src/core/quoteSource.js';
import type { Quote } from '../src/core/types.js';
import { createPaperBroker } from '../src/adapters/paperBroker.js';
import { createDecimalsResolver, fixtureDecimalsSource } from '../src/adapters/mintMetadata.js';
import { openLedger } from '../src/db/ledger.js';
import { openRuntimeState } from '../src/db/runtimeState.js';
import { openFillsView } from '../src/db/fillsView.js';
import { Tracker } from '../src/services/tracker.js';
import type { HeldPositionScreener, Scheduler, WalletFeed } from '../src/services/tracker.js';
import { createApi } from '../src/services/api.js';
import { openWalletStore } from '../src/services/walletStore.js';
import type { WalletStore } from '../src/services/walletStore.js';
import { copyableScores } from './fixtures/scores.js';

const A = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const B = 'So11111111111111111111111111111111111111112';
const NOW = 1_700_000_000_000;

class FakeStream extends EventEmitter implements WalletFeed {
  /** Snapshots of `deps.wallets` at each subscribe, which is what a real start does. */
  readonly subscribes: string[][] = [];
  constructor(private readonly wallets: readonly string[]) {
    super();
  }
  /**
   * Emits `connected`, because `WalletStream.start()` does. The tracker's
   * `running` status is bound to that event, so a fake that omits it models a
   * feed that never comes up.
   */
  async start(): Promise<void> {
    this.subscribes.push([...this.wallets]);
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

const quotes: QuoteSource = {
  getQuote: async (request: QuoteRequest): Promise<Quote> => ({
    inMint: request.inMint,
    outMint: request.outMint,
    inAmount: request.inAmount,
    outAmount: 60_000_000n,
    priceImpactPct: 0.5,
    routePlan: [],
    fetchedAt: NOW,
  }),
};

interface Harness {
  api: ReturnType<typeof createApi>;
  tracker: Tracker;
  store: WalletStore;
  stream: FakeStream;
  configPath: string;
  readConfig(): Record<string, unknown>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function harness(seed: Record<string, unknown> = {}, uiPath?: string): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'wallet-api-'));
  const dbPath = join(dir, 'tracker.db');
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ mode: 'paper', ...seed }, null, 2));

  const store = openWalletStore({
    configPath,
    walletsPath: join(dir, 'data', 'wallets.json'),
    now: () => NOW,
  });

  const config = parseConfig({ trackedWallets: store.enabledAddresses() });
  const ledger = openLedger({
    path: dbPath,
    logger: { info: () => undefined, warn: () => undefined },
  });
  const runtime = openRuntimeState({ path: dbPath });

  // The array by identity — the same wiring `createTrackerRuntime` does.
  const stream = new FakeStream(store.liveAddresses);

  const tracker = new Tracker({
    walletScores: copyableScores,
    config,
    ledger,
    runtime,
    broker: createPaperBroker({
      quoteSource: quotes,
      resolveDecimals: createDecimalsResolver(fixtureDecimalsSource({})),
      ledger,
      config,
      latencyMs: 0,
      now: () => NOW,
    }),
    screener: new FakeScreener(),
    quotes,
    stream,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    scheduler: noopScheduler,
    now: () => NOW,
  });

  const fills = openFillsView({ path: dbPath });
  const api = createApi({
    tracker,
    ledger,
    fills,
    config,
    wallets: store,
    ...(uiPath === undefined ? {} : { uiPath }),
  });

  cleanups.push(async () => {
    await api.close();
    fills.close();
    runtime.close();
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    api,
    tracker,
    store,
    stream,
    configPath,
    readConfig: () => JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------

describe('GET /wallets', () => {
  it('is empty on a fresh config', async () => {
    const h = harness();
    const response = await h.api.inject({ method: 'GET', url: '/wallets' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ wallets: [], applied: [], pendingRestart: false });
  });

  it('surfaces wallets hand-edited into config.json', async () => {
    const h = harness({ trackedWallets: [A] });
    expect((await h.api.inject({ method: 'GET', url: '/wallets' })).json().wallets).toMatchObject([
      { address: A, enabled: true, label: '' },
    ]);
  });
});

describe('POST /wallets', () => {
  it('adds a wallet and writes it to config.json', async () => {
    const h = harness();
    const response = await h.api.inject({
      method: 'POST',
      url: '/wallets',
      payload: { address: A, label: 'whale', note: 'from a mint sweep' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().wallet).toMatchObject({ address: A, label: 'whale', enabled: true });
    expect(h.readConfig()['trackedWallets']).toEqual([A]);
  });

  it('answers 400 for a malformed address', async () => {
    const h = harness();
    const response = await h.api.inject({
      method: 'POST',
      url: '/wallets',
      payload: { address: 'l0Ol' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'INVALID_ADDRESS' });
  });

  it('answers 409 for a duplicate, and does not double-write', async () => {
    const h = harness();
    await h.api.inject({ method: 'POST', url: '/wallets', payload: { address: A } });
    const second = await h.api.inject({ method: 'POST', url: '/wallets', payload: { address: A } });

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'DUPLICATE' });
    expect(h.readConfig()['trackedWallets']).toEqual([A]);
  });

  it('answers 400 for an over-long label rather than truncating it', async () => {
    const h = harness();
    const response = await h.api.inject({
      method: 'POST',
      url: '/wallets',
      payload: { address: A, label: 'x'.repeat(65) },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'INVALID_FIELD' });
  });
});

describe('PATCH /wallets/:address', () => {
  it('mutes a wallet without forgetting it', async () => {
    const h = harness();
    await h.api.inject({ method: 'POST', url: '/wallets', payload: { address: A, label: 'cold' } });

    const response = await h.api.inject({
      method: 'PATCH',
      url: `/wallets/${A}`,
      payload: { enabled: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().wallet).toMatchObject({ enabled: false, label: 'cold' });
    expect(h.readConfig()['trackedWallets']).toEqual([]);
    expect(response.json().wallets).toHaveLength(1);
  });

  it('answers 404 for an untracked address', async () => {
    const h = harness();
    const response = await h.api.inject({
      method: 'PATCH',
      url: `/wallets/${A}`,
      payload: { label: 'x' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('DELETE /wallets/:address', () => {
  it('untracks and says plainly that it sold nothing', async () => {
    const h = harness({ trackedWallets: [A] });
    const response = await h.api.inject({ method: 'DELETE', url: `/wallets/${A}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ removed: A, soldNothing: true, wallets: [] });
    expect(h.readConfig()['trackedWallets']).toEqual([]);
  });

  it('answers 404 twice for the same address', async () => {
    const h = harness({ trackedWallets: [A] });
    expect((await h.api.inject({ method: 'DELETE', url: `/wallets/${A}` })).statusCode).toBe(200);
    expect((await h.api.inject({ method: 'DELETE', url: `/wallets/${A}` })).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The part that matters: when an edit actually reaches the subscriptions
// ---------------------------------------------------------------------------

describe('an edit reaches the stream at the next start, and not before', () => {
  it('subscribes to whatever was saved before start', async () => {
    const h = harness();
    await h.api.inject({ method: 'POST', url: '/wallets', payload: { address: A } });
    await h.api.inject({ method: 'POST', url: '/wallets', payload: { address: B } });

    await h.api.inject({ method: 'POST', url: '/start' });

    expect(h.stream.subscribes).toEqual([[A, B]]);
    expect((await h.api.inject({ method: 'GET', url: '/wallets' })).json()).toMatchObject({
      applied: [A, B],
      pendingRestart: false,
    });
  });

  it('reports pendingRestart when the watchlist changes mid-run', async () => {
    const h = harness({ trackedWallets: [A] });
    await h.api.inject({ method: 'POST', url: '/start' });
    expect(h.stream.subscribes).toEqual([[A]]);

    await h.api.inject({ method: 'POST', url: '/wallets', payload: { address: B } });

    const view = (await h.api.inject({ method: 'GET', url: '/wallets' })).json();
    expect(view.pendingRestart).toBe(true);
    // The claim that must hold: the running stream has NOT picked it up.
    expect(view.applied).toEqual([A]);
    expect(h.stream.subscribes).toEqual([[A]]);
  });

  it('clears pendingRestart on a stop-then-start, with the new set subscribed', async () => {
    const h = harness({ trackedWallets: [A] });
    await h.api.inject({ method: 'POST', url: '/start' });
    await h.api.inject({ method: 'POST', url: '/wallets', payload: { address: B } });
    await h.api.inject({ method: 'POST', url: '/stop' });
    await h.api.inject({ method: 'POST', url: '/start' });

    expect(h.stream.subscribes).toEqual([[A], [A, B]]);
    expect((await h.api.inject({ method: 'GET', url: '/wallets' })).json()).toMatchObject({
      applied: [A, B],
      pendingRestart: false,
    });
  });

  it('is never pendingRestart while idle', async () => {
    const h = harness({ trackedWallets: [A] });
    await h.api.inject({ method: 'POST', url: '/wallets', payload: { address: B } });
    expect((await h.api.inject({ method: 'GET', url: '/wallets' })).json().pendingRestart).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

describe('the screener page', () => {
  it('serves the real UI file at / and /ui', async () => {
    const h = harness();
    for (const url of ['/', '/ui']) {
      const response = await h.api.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('Wallet screener');
    }
  });

  it('says where it looked when the file is missing', async () => {
    const h = harness({}, '/nowhere/index.html');
    const response = await h.api.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'UI_NOT_FOUND' });
    expect(response.json().message).toContain('/nowhere/index.html');
  });
});

describe('without a store', () => {
  it('registers neither /wallets nor the page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'no-store-'));
    const dbPath = join(dir, 'tracker.db');
    const config = parseConfig({ trackedWallets: [] });
    const ledger = openLedger({
      path: dbPath,
      logger: { info: () => undefined, warn: () => undefined },
    });
    const runtime = openRuntimeState({ path: dbPath });
    const fills = openFillsView({ path: dbPath });
    const tracker = new Tracker({
    walletScores: copyableScores,
      config,
      ledger,
      runtime,
      broker: createPaperBroker({
        quoteSource: quotes,
        resolveDecimals: createDecimalsResolver(fixtureDecimalsSource({})),
        ledger,
        config,
        latencyMs: 0,
        now: () => NOW,
      }),
      screener: new FakeScreener(),
      quotes,
      stream: new FakeStream([]),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      scheduler: noopScheduler,
      now: () => NOW,
    });
    const api = createApi({ tracker, ledger, fills, config });
    cleanups.push(async () => {
      await api.close();
      fills.close();
      runtime.close();
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    });

    expect((await api.inject({ method: 'GET', url: '/wallets' })).statusCode).toBe(404);
    expect((await api.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
    // …but the control API is untouched.
    expect((await api.inject({ method: 'GET', url: '/state' })).statusCode).toBe(200);
  });
});
