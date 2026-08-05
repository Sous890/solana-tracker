import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/core/config.js';
import type { QuoteRequest, QuoteSource } from '../src/core/quoteSource.js';
import type { Address, Quote, SimulatedFill } from '../src/core/types.js';
import { createPaperBroker } from '../src/adapters/paperBroker.js';
import { createDecimalsResolver, fixtureDecimalsSource } from '../src/adapters/mintMetadata.js';
import { openLedger } from '../src/db/ledger.js';
import { openRuntimeState } from '../src/db/runtimeState.js';
import { openFillsView } from '../src/db/fillsView.js';
import { Tracker } from '../src/services/tracker.js';
import type { HeldPositionScreener, Scheduler, WalletFeed } from '../src/services/tracker.js';
import { API_HOST, createApi, startApi, toJsonSafe } from '../src/services/api.js';

const MINT_A = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const NOW = 1_700_000_000_000;
const DECIMALS = 6;

class FakeStream extends EventEmitter implements WalletFeed {
  async start(): Promise<void> {}
  stop(): void {}
}

class FakeScreener extends EventEmitter implements HeldPositionScreener {
  async screenHeldPosition(): Promise<unknown> {
    return { verdict: 'pass' };
  }
}

const noopScheduler: Scheduler = {
  setInterval: () => 0,
  clearInterval: () => undefined,
};

function quoteOf(request: QuoteRequest, out: bigint): Quote {
  return {
    inMint: request.inMint,
    outMint: request.outMint,
    inAmount: request.inAmount,
    outAmount: out,
    priceImpactPct: 0.5,
    routePlan: [],
    fetchedAt: NOW,
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

// ---------------------------------------------------------------------------
// Harness — file-backed, because the fills view is a second connection
// ---------------------------------------------------------------------------

interface ApiHarness {
  api: ReturnType<typeof createApi>;
  tracker: Tracker;
  ledger: ReturnType<typeof openLedger>;
  fills: ReturnType<typeof openFillsView>;
  close(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

function harness(
  options: { canSell?: (mint: Address) => Promise<{ ok: boolean; reason?: string }> } = {},
): ApiHarness {
  const dir = mkdtempSync(join(tmpdir(), 'api-'));
  const dbPath = join(dir, 'tracker.db');

  const config = parseConfig({ trackedWallets: [] });
  const ledger = openLedger({
    path: dbPath,
    logger: { info: () => undefined, warn: () => undefined },
  });
  const runtime = openRuntimeState({ path: dbPath });

  const quotes: QuoteSource = { getQuote: async (request) => quoteOf(request, 60_000_000n) };
  let clock = NOW;
  const broker = createPaperBroker({
    quoteSource: quotes,
    resolveDecimals: createDecimalsResolver(fixtureDecimalsSource({ [MINT_A]: DECIMALS })),
    ledger,
    config,
    latencyMs: 0,
    now: () => (clock += 1),
    ...(options.canSell === undefined ? {} : { canSell: options.canSell }),
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
    scheduler: noopScheduler,
    now: () => NOW,
  });

  const fills = openFillsView({ path: dbPath });
  const api = createApi({ tracker, ledger, fills, config });

  const close = async (): Promise<void> => {
    await api.close();
    fills.close();
    runtime.close();
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  };
  cleanups.push(close);

  return { api, tracker, ledger, fills, close };
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

describe('amounts cross the boundary as strings', () => {
  it('turns a bigint into a decimal string, not a number', () => {
    expect(toJsonSafe({ tokens: 1_000_000_000n })).toEqual({ tokens: '1000000000' });
  });

  it('survives a value past the exact-integer range of a float64', () => {
    // 1e18 base units is an ordinary 9-decimal mint with 1e9 supply, and it is
    // past ~9e15 where float64 stops holding integers exactly. Emitting this as
    // a JSON number would round a position's size at the last hop.
    const huge = 1_000_000_000_000_000_001n;
    expect(toJsonSafe({ tokens: huge })).toEqual({ tokens: '1000000000000000001' });
    expect(Number(huge).toString()).not.toBe('1000000000000000001');
  });

  it('recurses through arrays and nested objects', () => {
    expect(toJsonSafe({ a: [{ b: 1n }], c: null, d: 'x' })).toEqual({
      a: [{ b: '1' }],
      c: null,
      d: 'x',
    });
  });
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

describe('GET /state', () => {
  it('reports mode, status and killSwitchEngaged', async () => {
    const h = harness();
    const response = await h.api.inject({ method: 'GET', url: '/state' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mode: 'paper',
      status: 'idle',
      killSwitchEngaged: false,
    });
  });

  it('follows the tracker through the state machine', async () => {
    const h = harness();
    await h.tracker.start();
    expect((await h.api.inject({ method: 'GET', url: '/state' })).json()).toMatchObject({
      status: 'running',
      startedAt: NOW,
    });

    await h.tracker.stop();
    expect((await h.api.inject({ method: 'GET', url: '/state' })).json()).toMatchObject({
      status: 'idle',
      startedAt: null,
    });
  });

  it('surfaces the orphan gate, which silently refuses every buy', async () => {
    const h = harness();
    h.ledger.recordIntent(
      {
        id: 'crashed',
        side: 'buy',
        mint: MINT_A,
        amountLamports: 50_000_000n,
        maxSlippageBps: 300,
        reason: 'crashed',
      },
      NOW,
    );
    await h.tracker.start();

    // A client showing "running" while this is non-zero is showing a lie.
    expect((await h.api.inject({ method: 'GET', url: '/state' })).json()).toMatchObject({
      status: 'running',
      unacknowledgedOrphans: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('POST /start', () => {
  it('starts and reports what reconciliation found', async () => {
    const h = harness();
    h.ledger.recordFill(buyFill());

    const response = await h.api.inject({ method: 'POST', url: '/start' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'running',
      reconciled: { openPositions: [MINT_A] },
    });
  });

  it('answers 409 on a double start', async () => {
    const h = harness();
    await h.api.inject({ method: 'POST', url: '/start' });
    const second = await h.api.inject({ method: 'POST', url: '/start' });

    // A second start is a caller bug, not a request to be quietly absorbed.
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'INVALID_STATE', status: 'running' });
  });
});

describe('POST /stop', () => {
  it('stops, and says plainly that it sold nothing', async () => {
    const h = harness();
    h.ledger.recordFill(buyFill());
    await h.tracker.start();

    const response = await h.api.inject({ method: 'POST', url: '/stop' });

    expect(response.statusCode).toBe(200);
    // An operator hitting stop during an incident should not have to remember
    // that it is not an exit.
    expect(response.json()).toEqual({ status: 'idle', soldNothing: true, openPositions: 1 });
    expect(h.ledger.getPosition(MINT_A)?.state).toBe('open');
  });

  it('answers 200 from idle rather than 409', async () => {
    const h = harness();
    const response = await h.api.inject({ method: 'POST', url: '/stop' });
    // Stop converges: asking a stopped bot to stop is satisfied.
    expect(response.statusCode).toBe(200);
  });
});

describe('POST /kill', () => {
  it('engages the kill switch and shows it in /state', async () => {
    const h = harness();
    const response = await h.api.inject({ method: 'POST', url: '/kill' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ killSwitchEngaged: true });
    expect((await h.api.inject({ method: 'GET', url: '/state' })).json()).toMatchObject({
      killSwitchEngaged: true,
    });
  });

  it('has no route that releases it', async () => {
    const h = harness();
    await h.api.inject({ method: 'POST', url: '/kill' });

    // `BotState` says the kill switch is cleared only by an explicit operator
    // action. A POST from anything that can reach localhost is not that.
    for (const url of ['/unkill', '/release', '/kill/release']) {
      expect((await h.api.inject({ method: 'POST', url })).statusCode).toBe(404);
    }
    const body = await h.api.inject({
      method: 'POST',
      url: '/kill',
      payload: { engaged: false },
    });
    expect(body.json()).toMatchObject({ killSwitchEngaged: true });
  });
});

describe('POST /flatten', () => {
  it('REFUSES without an explicit confirmation', async () => {
    const h = harness();
    h.ledger.recordFill(buyFill());

    for (const payload of [undefined, {}, { confirm: false }, { confirm: 'true' }]) {
      const response = await h.api.inject({
        method: 'POST',
        url: '/flatten',
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'CONFIRMATION_REQUIRED' });
    }

    // Nothing was sold by any of those.
    expect(h.ledger.getPosition(MINT_A)?.state).toBe('open');
  });

  it('liquidates on {"confirm": true}', async () => {
    const h = harness();
    h.ledger.recordFill(buyFill());

    const response = await h.api.inject({
      method: 'POST',
      url: '/flatten',
      payload: { confirm: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().completed).toHaveLength(1);
    expect(response.json().stillHeld).toEqual([]);
    expect(h.ledger.getPosition(MINT_A)?.state).toBe('closed');
  });

  it('works with the kill switch engaged', async () => {
    const h = harness();
    h.ledger.recordFill(buyFill());
    await h.api.inject({ method: 'POST', url: '/kill' });

    const response = await h.api.inject({
      method: 'POST',
      url: '/flatten',
      payload: { confirm: true },
    });

    expect(response.statusCode).toBe(200);
    expect(h.ledger.getOpenPositions()).toHaveLength(0);
  });

  it('is not reachable through /stop', async () => {
    const h = harness();
    h.ledger.recordFill(buyFill());
    await h.tracker.start();
    await h.api.inject({ method: 'POST', url: '/stop' });

    // The two commands are separate controls. This is the assertion that says
    // so at the transport layer.
    expect(h.ledger.getPosition(MINT_A)?.tokens).toBe(1_000_000_000n);
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe('GET /positions', () => {
  it('lists open positions with exact amounts as strings', async () => {
    const h = harness();
    h.ledger.recordFill(buyFill());

    const body = (await h.api.inject({ method: 'GET', url: '/positions' })).json();

    expect(body.positions).toHaveLength(1);
    expect(body.positions[0]).toMatchObject({
      mint: MINT_A,
      tokens: '1000000000',
      costLamports: '50000000',
      routeLost: false,
      markLamportsPerToken: null,
    });
  });

  it('includes the mark once the price loop has run', async () => {
    const h = harness();
    h.ledger.recordFill(buyFill());
    await h.tracker.priceTick();

    const body = (await h.api.inject({ method: 'GET', url: '/positions' })).json();
    expect(body.positions[0]).toMatchObject({ markLamportsPerToken: '60000' });
    expect(body.positions[0].markSol).toBeCloseTo(0.00006, 9);
  });

  it('is empty after a flatten', async () => {
    const h = harness();
    h.ledger.recordFill(buyFill());
    await h.api.inject({ method: 'POST', url: '/flatten', payload: { confirm: true } });

    expect((await h.api.inject({ method: 'GET', url: '/positions' })).json().positions).toEqual(
      [],
    );
  });
});

describe('GET /fills', () => {
  it('returns the most recent fills, newest first', async () => {
    const h = harness();
    for (let index = 0; index < 5; index += 1) {
      h.ledger.recordFill(buyFill({ intentId: `buy-${index}`, at: NOW + index }));
    }

    const body = (await h.api.inject({ method: 'GET', url: '/fills' })).json();

    expect(body.fills).toHaveLength(5);
    expect(body.fills.map((fill: { intentId: string }) => fill.intentId)).toEqual([
      'buy-4',
      'buy-3',
      'buy-2',
      'buy-1',
      'buy-0',
    ]);
  });

  it('defaults to 50 and honours a smaller limit', async () => {
    const h = harness();
    for (let index = 0; index < 60; index += 1) {
      h.ledger.recordFill(buyFill({ intentId: `buy-${index}`, at: NOW + index }));
    }

    expect((await h.api.inject({ method: 'GET', url: '/fills' })).json().fills).toHaveLength(50);
    expect(
      (await h.api.inject({ method: 'GET', url: '/fills?limit=3' })).json().fills,
    ).toHaveLength(3);
  });

  it('clamps a hostile limit rather than serving the whole history', async () => {
    const h = harness();
    h.ledger.recordFill(buyFill());

    expect((await h.api.inject({ method: 'GET', url: '/fills?limit=999999' })).json().limit).toBe(
      500,
    );
    expect((await h.api.inject({ method: 'GET', url: '/fills?limit=0' })).json().limit).toBe(1);
    expect((await h.api.inject({ method: 'GET', url: '/fills?limit=-5' })).json().limit).toBe(1);
    expect((await h.api.inject({ method: 'GET', url: '/fills?limit=abc' })).json().limit).toBe(50);
  });

  it('carries exact amounts as strings', async () => {
    const h = harness();
    h.ledger.recordFill(buyFill({ tokensDelta: 1_000_000_000_000_000_001n }));

    const body = (await h.api.inject({ method: 'GET', url: '/fills' })).json();
    expect(body.fills[0].tokensDelta).toBe('1000000000000000001');
  });

  it('reads through a connection that cannot write', async () => {
    const h = harness();
    h.ledger.recordFill(buyFill());
    // The view is opened readonly, which is what keeps the split ownership of
    // the `fills` table from becoming a second writer.
    const response = await h.api.inject({ method: 'GET', url: '/fills' });
    expect(response.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

describe('GET /events', () => {
  it('replays the buffered tail so a client attaching mid-run is not blind', async () => {
    const h = harness();
    await h.tracker.start();
    h.tracker.killSwitch();

    const running = await startApi({
      tracker: h.tracker,
      ledger: h.ledger,
      fills: h.fills,
      config: parseConfig({}),
      port: 0,
    });

    try {
      expect(running.url.startsWith(`http://${API_HOST}:`)).toBe(true);

      const { response, close } = await sse(`${running.url}/events`);
      try {
        expect(response.headers['content-type']).toContain('text/event-stream');
        const text = await readFrames(response, 3);

        // Everything that already happened, written before the live
        // subscription starts. A client attaching now is not blind to it.
        expect(text).toContain('event: reconciled');
        expect(text).toContain('event: state-change');
        expect(text).toMatch(/^id: 1$/m);
      } finally {
        close();
      }
    } finally {
      await running.close();
    }
  });

  it('resumes from Last-Event-ID rather than re-sending', async () => {
    const h = harness();
    await h.tracker.start();
    h.tracker.killSwitch();

    const running = await startApi({
      tracker: h.tracker,
      ledger: h.ledger,
      fills: h.fills,
      config: parseConfig({}),
      port: 0,
    });

    try {
      const all = h.tracker.recentEvents();
      const lastSeen = all[0]?.seq ?? 0;

      const { response, close } = await sse(`${running.url}/events`, {
        'last-event-id': String(lastSeen),
      });
      try {
        const text = await readFrames(response, all.length - 1);

        // The same distinction the wallet stream's cursor makes: resume, do not
        // re-read.
        expect(text).not.toMatch(new RegExp(`^id: ${lastSeen}$`, 'm'));
        expect(text).toMatch(new RegExp(`^id: ${lastSeen + 1}$`, 'm'));
      } finally {
        close();
      }
    } finally {
      await running.close();
    }
  });

  it('delivers a live event to an already-attached client', async () => {
    const h = harness();
    const running = await startApi({
      tracker: h.tracker,
      ledger: h.ledger,
      fills: h.fills,
      config: parseConfig({}),
      port: 0,
    });

    try {
      // Nothing has happened yet, so the buffer is empty and the first frame
      // this client sees can only be a live one.
      expect(h.tracker.recentEvents()).toHaveLength(0);

      const { response, close } = await sse(`${running.url}/events`);
      try {
        const frames = readFrames(response, 1);
        h.tracker.killSwitch();
        const text = await frames;

        expect(text).toContain('event: state-change');
        expect(text).toContain('"killSwitchEngaged":true');
      } finally {
        close();
      }
    } finally {
      await running.close();
    }
  });

  it('drops its subscription when the client disconnects', async () => {
    const h = harness();
    const running = await startApi({
      tracker: h.tracker,
      ledger: h.ledger,
      fills: h.fills,
      config: parseConfig({}),
      port: 0,
    });

    try {
      const { response, close } = await sse(`${running.url}/events`);
      expect(h.tracker.listenerCount('event')).toBe(1);

      close();
      response.destroy();
      // A listener per abandoned connection is a leak that ends with the
      // tracker writing to sockets nobody is reading.
      await waitFor(() => h.tracker.listenerCount('event') === 0);
      expect(h.tracker.listenerCount('event')).toBe(0);
    } finally {
      await running.close();
    }
  });
});

// ---------------------------------------------------------------------------
// SSE helpers
//
// Raw `node:http` rather than `fetch`: `tests/setup.ts` replaces global fetch
// with a loud failure so the suite can never reach the internet, and that guard
// is worth keeping absolute. These requests go to a server this test started on
// loopback, which is a different thing — so they say so explicitly instead of
// poking a hole in the global.
// ---------------------------------------------------------------------------

async function sse(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ response: IncomingMessage; close: () => void }> {
  return new Promise((resolve, reject) => {
    const request = httpGet(url, { headers }, (response) => {
      resolve({
        response,
        close: () => {
          response.destroy();
          request.destroy();
        },
      });
    });
    request.on('error', reject);
  });
}

/**
 * Read until `count` event frames have arrived, or the stream ends.
 *
 * Counts `event:` lines rather than blank-line separators, so the leading
 * `: connected` comment and the keepalives are not mistaken for events.
 */
async function readFrames(response: IncomingMessage, count: number): Promise<string> {
  let text = '';
  if (count === 0) return text;
  for await (const chunk of response) {
    text += String(chunk);
    if ((text.match(/^event: /gm) ?? []).length >= count) break;
  }
  return text;
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('binding', () => {
  it('binds loopback only', async () => {
    const h = harness();
    const running = await startApi({
      tracker: h.tracker,
      ledger: h.ledger,
      fills: h.fills,
      config: parseConfig({}),
      port: 0,
    });

    try {
      const address = running.app.server.address();
      // This API has no authentication and exposes POST /flatten. The host is
      // not an option, so putting it on a LAN cannot be a config typo.
      expect(typeof address === 'object' && address !== null ? address.address : '').toBe(
        '127.0.0.1',
      );
      expect(API_HOST).toBe('127.0.0.1');
    } finally {
      await running.close();
    }
  });
});
