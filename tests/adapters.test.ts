/**
 * The three adapters the tracker constructs: JSON-RPC, DexScreener, websocket.
 *
 * Every RPC and DexScreener body replayed here is a **real capture**, taken
 * from `api.mainnet-beta.solana.com` and `api.dexscreener.com` while writing
 * this module. They are in `tests/fixtures/rpc/`. `fetchImpl` is injected, so
 * the suite still never reaches the network — see `tests/setup.ts`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RpcError, createRpcClient } from '../src/adapters/rpcClient.js';
import { DexScreenerError, createDexScreenerClient } from '../src/adapters/dexscreener.js';
import { SocketConnectError, createStreamSocketFactory } from '../src/adapters/streamSocket.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RPC = resolve(HERE, 'fixtures/rpc');

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const TOKEN_ACCOUNT = 'AdaNSzcn26QdXVD9WKVqdYXqpd2eQUiBQXqwAdeN71aq';
const RPC_URL = 'https://rpc.example.invalid/?api-key=SECRET';

const capture = (name: string): unknown =>
  JSON.parse(readFileSync(join(RPC, `${name}.json`), 'utf8'));

/** A `fetch` that replays one body, recording what it was asked. */
function replay(
  body: unknown,
  options: { status?: number; headers?: Record<string, string> } = {},
) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status: options.status ?? 200,
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Parsed request bodies, so the JSON-RPC envelope can be asserted. */
const sentBodies = (calls: Array<{ init: RequestInit | undefined }>): any[] =>
  calls.map((call) => JSON.parse(String(call.init?.body)));

// ---------------------------------------------------------------------------
// getParsedMintAccount
// ---------------------------------------------------------------------------

describe('rpcClient.getParsedMintAccount', () => {
  it('returns the jsonParsed mint account from a real capture', async () => {
    const { fetchImpl, calls } = replay(capture('getAccountInfo-mint'));
    const client = createRpcClient({ httpUrl: RPC_URL, fetchImpl });

    const account = await client.getParsedMintAccount(BONK);

    expect(account?.owner).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    expect(account?.data.parsed.info.decimals).toBe(5);
    // Both revoked, as JSON `null` with the key present — the shape
    // `authorityIsLive` was written against.
    expect(account?.data.parsed.info.mintAuthority).toBeNull();
    expect(account?.data.parsed.info.freezeAuthority).toBeNull();

    expect(sentBodies(calls)[0]).toMatchObject({
      method: 'getAccountInfo',
      params: [BONK, { encoding: 'jsonParsed', commitment: 'confirmed' }],
    });
  });

  it('returns null for an address that holds nothing', async () => {
    const { fetchImpl } = replay(capture('getAccountInfo-nonexistent'));
    const client = createRpcClient({ httpUrl: RPC_URL, fetchImpl });

    // `result.value === null` is the ONE case that maps to null here. It is a
    // different claim from "we could not read it", and the screener records the
    // two differently.
    await expect(client.getParsedMintAccount(BONK)).resolves.toBeNull();
  });

  it('REFUSES a token account that is not a mint', async () => {
    const { fetchImpl } = replay(capture('getAccountInfo-token-account'));
    const client = createRpcClient({ httpUrl: RPC_URL, fetchImpl });

    // A real SPL token account. It is owned by the Token program, so an
    // owner-based check waves it through — and then `parsed.info.decimals` is
    // `undefined` and `mintAuthority` is absent, which `authorityIsLive` reads
    // as revoked. That is a screener pass on an account that is not a mint.
    await expect(client.getParsedMintAccount(TOKEN_ACCOUNT)).rejects.toThrow(
      /is a account, not a mint/,
    );
  });

  it('refuses an account whose data the RPC could not parse', async () => {
    const { fetchImpl } = replay(capture('getAccountInfo-unparseable-data'));
    const client = createRpcClient({ httpUrl: RPC_URL, fetchImpl });

    // Unparseable accounts come back as `[data, encoding]`. Real capture: the
    // system program's own account under `jsonParsed`.
    await expect(client.getParsedMintAccount(BONK)).rejects.toThrow(
      /not a parseable token mint/,
    );
  });

  it('surfaces a JSON-RPC error rather than a null', async () => {
    const { fetchImpl, calls } = replay(capture('rpc-error'));
    const client = createRpcClient({ httpUrl: RPC_URL, fetchImpl });

    await expect(client.getParsedMintAccount('not-a-valid-pubkey')).rejects.toBeInstanceOf(
      RpcError,
    );
    // A JSON-RPC error is the node answering, not failing to answer, so it is
    // not retried: a malformed request would only fail again.
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getEpoch and getSignaturesForAddress
// ---------------------------------------------------------------------------

describe('rpcClient.getEpoch', () => {
  it('reads the epoch out of getEpochInfo', async () => {
    const { fetchImpl, calls } = replay(capture('getEpochInfo'));
    const client = createRpcClient({ httpUrl: RPC_URL, fetchImpl });

    await expect(client.getEpoch()).resolves.toBe(1011);
    expect(sentBodies(calls)[0].method).toBe('getEpochInfo');
  });
});

describe('rpcClient.getSignaturesForAddress', () => {
  it('normalises a real page for both callers', async () => {
    const { fetchImpl } = replay(capture('getSignaturesForAddress'));
    const client = createRpcClient({ httpUrl: RPC_URL, fetchImpl });

    const page = await client.getSignaturesForAddress(BONK, { limit: 3 });

    expect(page).toHaveLength(3);
    // `SignatureRef` (the screener's age check) needs signature + blockTime;
    // `SignatureEntry` (the stream's ordering) needs slot + transactionIndex.
    // One method satisfies both frozen shapes.
    // Asserted through `toMatchObject` rather than by field access: the client
    // is typed as `SafetyRpc & RpcClient`, and reading a property off that
    // intersection resolves to whichever declaration TypeScript picks first.
    // The runtime object carries all of them, which is the claim.
    expect(page[0]).toMatchObject({
      signature: expect.any(String),
      slot: expect.any(Number),
      blockTime: expect.any(Number),
      transactionIndex: expect.any(Number),
      err: null,
    });
  });

  it('passes `before` and `until` through, and omits what was not asked for', async () => {
    const { fetchImpl, calls } = replay(capture('getSignaturesForAddress'));
    const client = createRpcClient({ httpUrl: RPC_URL, fetchImpl });

    await client.getSignaturesForAddress(BONK, { limit: 1_000, until: 'CURSOR' });
    // `until` walks back from the tip and stops at what we have; `before` pages
    // into history already seen. Sending the wrong one is handoff 07's
    // mutation 5, so the config object is asserted exactly.
    expect(sentBodies(calls)[0].params[1]).toEqual({
      limit: 1_000,
      commitment: 'confirmed',
      until: 'CURSOR',
    });
  });
});

describe('rpcClient.getTransaction', () => {
  it('always sends maxSupportedTransactionVersion', async () => {
    const { fetchImpl, calls } = replay({ jsonrpc: '2.0', id: 1, result: null });
    const client = createRpcClient({ httpUrl: RPC_URL, fetchImpl });

    await expect(client.getTransaction('SIG')).resolves.toBeNull();
    // Without it the node refuses every versioned transaction outright, which
    // is most of them now.
    expect(sentBodies(calls)[0].params[1]).toMatchObject({
      encoding: 'jsonParsed',
      maxSupportedTransactionVersion: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

describe('rpcClient retries', () => {
  function flaky(failures: number, status: number) {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls <= failures) {
        return new Response('rate limited', { status, headers: { 'retry-after': '0' } });
      }
      return new Response(JSON.stringify(capture('getEpochInfo')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, count: () => calls };
  }

  it('retries a 429 and succeeds', async () => {
    const { fetchImpl, count } = flaky(2, 429);
    const client = createRpcClient({ httpUrl: RPC_URL, fetchImpl, sleep: async () => undefined });

    // Public and shared endpoints answer 429 under any real load. Treating that
    // as fatal would make an ordinary rate limit look like an outage.
    await expect(client.getEpoch()).resolves.toBe(1011);
    expect(count()).toBe(3);
  });

  it('retries a 5xx and succeeds', async () => {
    const { fetchImpl, count } = flaky(1, 503);
    const client = createRpcClient({ httpUrl: RPC_URL, fetchImpl, sleep: async () => undefined });

    await expect(client.getEpoch()).resolves.toBe(1011);
    expect(count()).toBe(2);
  });

  it('gives up after the attempt budget and throws', async () => {
    const { fetchImpl, count } = flaky(99, 429);
    const client = createRpcClient({ httpUrl: RPC_URL, fetchImpl, sleep: async () => undefined });

    // Past the budget it throws, and the screener degrades to `unknown` rather
    // than to a wrong answer.
    await expect(client.getEpoch()).rejects.toThrow(/gave up after 3 attempt/);
    expect(count()).toBe(3);
  });

  it('does not retry a 4xx that is not a rate limit', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('nope', { status: 401 });
    }) as unknown as typeof fetch;
    const client = createRpcClient({ httpUrl: RPC_URL, fetchImpl, sleep: async () => undefined });

    await expect(client.getEpoch()).rejects.toThrow(/HTTP 401/);
    expect(calls).toBe(1);
  });

  it('times out an attempt and reports the budget', async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      })) as unknown as typeof fetch;

    const client = createRpcClient({
      httpUrl: RPC_URL,
      fetchImpl,
      timeoutMs: 5,
      maxAttempts: 1,
      sleep: async () => undefined,
    });

    await expect(client.getEpoch()).rejects.toThrow(/no response within 5ms/);
  });

  it('never puts the endpoint key in an error message', async () => {
    const { fetchImpl } = replay(capture('rpc-error'));
    const client = createRpcClient({ httpUrl: RPC_URL, fetchImpl });

    // The URL carries the provider key. Errors are logged; the key is not.
    await expect(client.getEpoch()).rejects.not.toThrow(/SECRET/);
  });
});

// ---------------------------------------------------------------------------
// DexScreener
// ---------------------------------------------------------------------------

describe('dexscreener', () => {
  it('returns pairs from a real indexed response', async () => {
    const { fetchImpl, calls } = replay(capture('dexscreener-indexed'));
    const client = createDexScreenerClient({ fetchImpl });

    const pairs = await client.getPairs(BONK);

    expect(pairs?.length).toBeGreaterThan(0);
    expect(pairs?.[0]).toMatchObject({
      liquidity: { usd: expect.any(Number) },
      quoteToken: { address: expect.any(String) },
      dexId: expect.any(String),
    });
    expect(calls[0]?.url).toBe(`https://api.dexscreener.com/latest/dex/tokens/${BONK}`);
  });

  it('returns NULL — not an empty array — for a mint it has never indexed', async () => {
    const { fetchImpl } = replay(capture('dexscreener-not-indexed'));
    const client = createDexScreenerClient({ fetchImpl });

    // The real body is `{"pairs": null}`. "Not indexed" is unknown, never zero:
    // reporting it as zero liquidity would libel the mint as illiquid and
    // produce `SCREEN_FAILED` where `SCREEN_UNKNOWN` is the truth.
    await expect(client.getPairs('11111111111111111111111111111111')).resolves.toBeNull();
  });

  it('THROWS on an outage rather than returning null', async () => {
    const { fetchImpl } = replay({}, { status: 503 });
    const client = createDexScreenerClient({ fetchImpl });

    // Returning null here would report an outage as "not indexed" — the same
    // answer for two different situations. A throw becomes
    // LIQUIDITY_UNAVAILABLE with the message attached.
    await expect(client.getPairs(BONK)).rejects.toBeInstanceOf(DexScreenerError);
  });

  it('reports a timeout as its own failure', async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      })) as unknown as typeof fetch;
    const client = createDexScreenerClient({ fetchImpl, timeoutMs: 5 });

    await expect(client.getPairs(BONK)).rejects.toThrow(/no response within 5ms/);
  });

  it('reports a zero-liquidity pair as data, not as absence', async () => {
    // A pre-graduation pump.fun token: indexed, one pair, `liquidity.usd = 0`,
    // because it trades on a bonding curve and has no pool depth. Handoff 08
    // measured this on every fresh mint sampled. The adapter reports what the
    // API said; applying the floor is `safety.ts`'s job.
    const { fetchImpl } = replay({
      schemaVersion: '1.0.0',
      pairs: [{ liquidity: { usd: 0 }, quoteToken: { address: 'So11111111111111111111111111111111111111112' }, dexId: 'pumpfun' }],
    });
    const client = createDexScreenerClient({ fetchImpl });

    const pairs = await client.getPairs(BONK);
    expect(pairs).toHaveLength(1);
    expect(pairs?.[0]?.liquidity?.usd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// StreamSocket
// ---------------------------------------------------------------------------

/** Minimal stand-in for the global WebSocket, driven by the test. */
class FakeWebSocket {
  static last: FakeWebSocket | undefined;
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Array<(event: any) => void>>();

  constructor(readonly url: string) {
    FakeWebSocket.last = this;
  }

  addEventListener(type: string, handler: (event: any) => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(handler);
    this.listeners.set(type, bucket);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.closed = true;
  }

  fire(type: string, event: unknown = {}): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
}

const fakeImpl = FakeWebSocket as unknown as typeof WebSocket;

describe('streamSocket', () => {
  it('resolves only once the socket is OPEN', async () => {
    const connect = createStreamSocketFactory({ wssUrl: 'wss://x.invalid', WebSocketImpl: fakeImpl });

    let resolved = false;
    const pending = connect().then((socket) => {
      resolved = true;
      return socket;
    });

    await Promise.resolve();
    // `WalletStream` subscribes immediately after this resolves, and `send()`
    // on a CONNECTING socket throws.
    expect(resolved).toBe(false);

    FakeWebSocket.last?.fire('open');
    const socket = await pending;
    socket.send('{"jsonrpc":"2.0"}');
    expect(FakeWebSocket.last?.sent).toEqual(['{"jsonrpc":"2.0"}']);
  });

  it('rejects when the socket closes before opening', async () => {
    const connect = createStreamSocketFactory({ wssUrl: 'wss://x.invalid', WebSocketImpl: fakeImpl });
    const pending = connect();
    await Promise.resolve();
    FakeWebSocket.last?.fire('close');

    // Rejecting routes the failure into the stream's backoff, which is what
    // keeps a provider outage from becoming a crash.
    await expect(pending).rejects.toBeInstanceOf(SocketConnectError);
  });

  it('rejects when the socket errors before opening', async () => {
    const connect = createStreamSocketFactory({ wssUrl: 'wss://x.invalid', WebSocketImpl: fakeImpl });
    const pending = connect();
    await Promise.resolve();
    FakeWebSocket.last?.fire('error');

    await expect(pending).rejects.toThrow(/errored before opening/);
  });

  it('gives up on a socket that never opens, and releases the handle', async () => {
    const connect = createStreamSocketFactory({
      wssUrl: 'wss://x.invalid',
      WebSocketImpl: fakeImpl,
      connectTimeoutMs: 5,
    });
    const pending = connect();

    await expect(pending).rejects.toThrow(/did not open within 5ms/);
    // A socket left CONNECTING would eventually open into a stream nobody is
    // reading.
    expect(FakeWebSocket.last?.closed).toBe(true);
  });

  it('delivers text frames as strings to a handler attached after connect', async () => {
    const connect = createStreamSocketFactory({ wssUrl: 'wss://x.invalid', WebSocketImpl: fakeImpl });
    const pending = connect();
    await Promise.resolve();
    FakeWebSocket.last?.fire('open');
    const socket = await pending;

    const received: string[] = [];
    socket.onMessage((data) => received.push(data));
    FakeWebSocket.last?.fire('message', { data: '{"a":1}' });

    expect(received).toEqual(['{"a":1}']);
  });

  it('routes a post-open close and error to their handlers', async () => {
    const connect = createStreamSocketFactory({ wssUrl: 'wss://x.invalid', WebSocketImpl: fakeImpl });
    const pending = connect();
    await Promise.resolve();
    FakeWebSocket.last?.fire('open');
    const socket = await pending;

    let closed = 0;
    let errored = 0;
    socket.onClose(() => (closed += 1));
    socket.onError(() => (errored += 1));

    FakeWebSocket.last?.fire('error');
    FakeWebSocket.last?.fire('close');

    expect(errored).toBe(1);
    expect(closed).toBe(1);
  });
});
