import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TrackedSwap } from '../src/core/types.js';
import {
  MAX_COLD_FILL,
  MAX_IN_FLIGHT,

  SILENCE_TIMEOUT_MS,
  SeenSignatures,
  WalletStream,
  orderOldestFirst,
} from '../src/adapters/walletStream.js';
import type { RpcClient, SignatureEntry, StreamSocket } from '../src/adapters/walletStream.js';
import type { ParsedTransactionWithMeta } from '../src/adapters/swapParser.js';
import { openCursorStore } from '../src/db/cursors.js';
import type { CursorStore } from '../src/db/cursors.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL = resolve(HERE, 'fixtures/transactions');

const capture = JSON.parse(
  readFileSync(join(REAL, 'raydium-v4-buy.json'), 'utf8'),
) as { wallet: string; signature: string; tx: ParsedTransactionWithMeta };

const WALLET = capture.wallet;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Builds a distinct transaction per signature, reusing one real capture's shape. */
function txFor(signature: string, slot: number): ParsedTransactionWithMeta {
  const tx = structuredClone(capture.tx);
  tx.slot = slot;
  tx.transaction.signatures = [signature];
  return tx;
}

interface FakeRpcOptions {
  /** Signatures the RPC will report, newest first, as the real API does. */
  history: SignatureEntry[];
  pageSize?: number;
}

function fakeRpc(options: FakeRpcOptions) {
  const calls: Array<{ until?: string; before?: string; limit: number }> = [];
  const fetched: string[] = [];

  const rpc: RpcClient = {
    async getSignaturesForAddress(_address, opts) {
      calls.push(opts);
      // The real API returns newest-first and stops at `until` exclusive.
      let list = [...options.history];
      if (opts.before !== undefined) {
        const index = list.findIndex((e) => e.signature === opts.before);
        list = index === -1 ? [] : list.slice(index + 1);
      }
      if (opts.until !== undefined) {
        const index = list.findIndex((e) => e.signature === opts.until);
        if (index !== -1) list = list.slice(0, index);
      }
      return list.slice(0, options.pageSize ?? 1_000);
    },
    async getTransaction(signature) {
      fetched.push(signature);
      const entry = options.history.find((e) => e.signature === signature);
      return entry === undefined ? null : txFor(signature, entry.slot);
    },
  };

  return { rpc, calls, fetched };
}

/**
 * A socket that speaks the `logsSubscribe` protocol, including the part that
 * matters: **it answers a subscribe with a subscription id, and it stamps that
 * id on every notification.**
 *
 * The previous fake did neither. It never replied to a subscribe, and its
 * notifications carried no `subscription` field — so a stream that ignored the
 * id and fanned every notification out to all thirteen wallets looked exactly
 * like one that routed correctly. Seventeen tests passed over a systematic
 * misattribution because the fake could not represent the protocol the bug lives
 * in. See handoff 22.
 */
function fakeSocket(firstSubscriptionId = 1_000) {
  const sent: string[] = [];
  let onMessage: (data: string) => void = () => undefined;
  let onClose: () => void = () => undefined;
  /** wallet -> the id this socket handed out for it, newest subscribe wins. */
  const subscriptionIds = new Map<string, number>();
  // Callers testing reconnect pass a distinct range: a real server does not
  // reissue the same ids to a new connection, and a fake that does makes a
  // stale id indistinguishable from a fresh one.
  let nextSubscriptionId = firstSubscriptionId;

  const socket: StreamSocket = {
    send: (payload) => {
      sent.push(payload);
      // Answer a subscribe the way a validator does: `{ id, result: <subId> }`.
      // Synchronous is safe — `connect()` registers `onMessage` before sending.
      try {
        const request = JSON.parse(payload) as {
          id?: number;
          method?: string;
          params?: [{ mentions?: string[] }, unknown];
        };
        if (request.method !== 'logsSubscribe') return;
        const wallet = request.params?.[0]?.mentions?.[0];
        if (wallet === undefined || request.id === undefined) return;
        const subscription = nextSubscriptionId++;
        subscriptionIds.set(wallet, subscription);
        onMessage(JSON.stringify({ jsonrpc: '2.0', result: subscription, id: request.id }));
      } catch {
        // A test sending something unparseable is testing something else.
      }
    },
    close: () => onClose(),
    onMessage: (h) => {
      onMessage = h;
    },
    onClose: (h) => {
      onClose = h;
    },
    onError: () => undefined,
  };

  return {
    socket,
    sent,
    subscriptionIds,
    /**
     * Deliver a notification. `wallet` selects whose subscription it arrives on;
     * omitted, it uses the first id this socket issued — what every
     * single-wallet test wants.
     */
    deliver: (signature: string, slot: number, wallet?: string) => {
      const subscription =
        wallet === undefined ? [...subscriptionIds.values()][0] : subscriptionIds.get(wallet);
      onMessage(
        JSON.stringify({
          params: { subscription, result: { context: { slot }, value: { signature, err: null } } },
        }),
      );
    },
    /** A notification on an id this socket never issued. */
    deliverRaw: (signature: string, slot: number, subscription: number | undefined) =>
      onMessage(
        JSON.stringify({
          params: { subscription, result: { context: { slot }, value: { signature, err: null } } },
        }),
      ),
  };
}

function entries(count: number, startSlot = 100): SignatureEntry[] {
  // Newest first, matching the RPC.
  return Array.from({ length: count }, (_, i) => ({
    signature: `sig-${count - i}`,
    slot: startSlot + (count - i),
    err: null,
    transactionIndex: 0,
  }));
}

interface Harness {
  stream: WalletStream;
  cursors: CursorStore;
  swaps: TrackedSwap[];
  gapFills: Array<{ wallet: string; count: number; truncated: boolean }>;
  errors: Error[];
  close(): void;
}

function harness(rpc: RpcClient, socketFactory: () => StreamSocket, store?: CursorStore): Harness {
  const cursors = store ?? openCursorStore({ path: ':memory:' });
  const stream = new WalletStream({
    wallets: [WALLET],
    rpc,
    cursors,
    connect: async () => socketFactory(),
    now: () => 1_700_000_000_000,
    sleep: async () => undefined,
    random: () => 0,
  });

  const swaps: TrackedSwap[] = [];
  const gapFills: Array<{ wallet: string; count: number; truncated: boolean }> = [];
  const errors: Error[] = [];
  stream.on('swap', (swap: TrackedSwap) => swaps.push(swap));
  stream.on('gap-filled', (event) => gapFills.push(event));
  stream.on('error', (error: Error) => errors.push(error));

  return { stream, cursors, swaps, gapFills, errors, close: () => cursors.close() };
}

// ---------------------------------------------------------------------------
// Ordering and dedupe primitives
// ---------------------------------------------------------------------------

describe('ordering', () => {
  it('sorts by slot then transaction index, oldest first', () => {
    const unsorted: SignatureEntry[] = [
      { signature: 'c', slot: 11, err: null, transactionIndex: 0 },
      { signature: 'b', slot: 10, err: null, transactionIndex: 5 },
      { signature: 'a', slot: 10, err: null, transactionIndex: 1 },
    ];
    expect(orderOldestFirst(unsorted).map((e) => e.signature)).toEqual(['a', 'b', 'c']);
  });

  it('ignores blockTime, which is nullable and not monotonic', () => {
    const unsorted: SignatureEntry[] = [
      { signature: 'first', slot: 10, err: null, transactionIndex: 0, blockTime: 999 },
      { signature: 'second', slot: 11, err: null, transactionIndex: 0, blockTime: null },
      { signature: 'third', slot: 12, err: null, transactionIndex: 0, blockTime: 1 },
    ];
    expect(orderOldestFirst(unsorted).map((e) => e.signature)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });
});

describe('SeenSignatures', () => {
  it('admits once', () => {
    const seen = new SeenSignatures(10);
    expect(seen.admit('x')).toBe(true);
    expect(seen.admit('x')).toBe(false);
  });

  it('evicts oldest first and stays bounded', () => {
    const seen = new SeenSignatures(3);
    for (const s of ['a', 'b', 'c', 'd']) seen.admit(s);
    expect(seen.size).toBe(3);
    // 'a' was evicted, so it is admitted again.
    expect(seen.admit('a')).toBe(true);
    expect(seen.admit('d')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (g) Gap fill
// ---------------------------------------------------------------------------

describe('gap fill', () => {
  it('emits every missed signature exactly once, in slot order', async () => {
    const history = entries(5);
    const { rpc, calls } = fakeRpc({ history });
    const h = harness(rpc, () => fakeSocket().socket);
    try {
      // Pretend sig-2 was the last thing delivered before the disconnect.
      h.cursors.set(WALLET, 'sig-2', 102);
      await h.stream.start();

      expect(calls[0]?.until).toBe('sig-2');
      expect(h.swaps.map((s) => s.signature)).toEqual(['sig-3', 'sig-4', 'sig-5']);
      expect(h.swaps.map((s) => s.slot)).toEqual([103, 104, 105]);
      expect(h.gapFills[0]).toMatchObject({ count: 3, truncated: false });
    } finally {
      h.close();
    }
  });

  it('does not re-deliver a signature the socket already produced', async () => {
    const history = entries(4);
    const { rpc } = fakeRpc({ history });
    const sock = fakeSocket();
    const h = harness(rpc, () => sock.socket);
    try {
      h.cursors.set(WALLET, 'sig-2', 102);
      await h.stream.start();
      const afterFill = h.swaps.length;

      // The socket now replays one the gap fill already covered.
      sock.deliver('sig-4', 104);
      await new Promise((r) => setImmediate(r));

      expect(h.swaps).toHaveLength(afterFill);
      expect(h.swaps.filter((s) => s.signature === 'sig-4')).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('caps a cold fill and flags it truncated', async () => {
    const history = entries(MAX_COLD_FILL + 40);
    const { rpc } = fakeRpc({ history });
    const h = harness(rpc, () => fakeSocket().socket);
    try {
      // No cursor at all: never replay unbounded history into a live strategy.
      await h.stream.start();

      expect(h.gapFills[0]?.truncated).toBe(true);
      expect(h.swaps).toHaveLength(MAX_COLD_FILL);
      // The newest ones are kept, still oldest-first among them.
      const slots = h.swaps.map((s) => s.slot);
      expect(slots).toEqual([...slots].sort((a, b) => a - b));
      expect(Math.max(...slots)).toBe(100 + MAX_COLD_FILL + 40);
    } finally {
      h.close();
    }
  });

  it('anchors on `until`, not `before`', async () => {
    const history = entries(5);
    const { rpc, calls } = fakeRpc({ history });
    const h = harness(rpc, () => fakeSocket().socket);
    try {
      h.cursors.set(WALLET, 'sig-3', 103);
      await h.stream.start();

      expect(calls[0]?.until).toBe('sig-3');
      expect(calls[0]?.before).toBeUndefined();
      // `before` would have paged backwards into already-seen history.
      expect(h.swaps.map((s) => s.signature)).toEqual(['sig-4', 'sig-5']);
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (h) Cursor durability
// ---------------------------------------------------------------------------

describe('cursor', () => {
  it('advances only after a successful emit', async () => {
    const history = entries(3);
    const { rpc } = fakeRpc({ history });
    const h = harness(rpc, () => fakeSocket().socket);
    try {
      await h.stream.start();
      expect(h.cursors.get(WALLET)?.lastSignature).toBe('sig-3');
    } finally {
      h.close();
    }
  });

  it('does not advance past a transaction that could not be fetched', async () => {
    const history = entries(3);
    const failing: RpcClient = {
      getSignaturesForAddress: async () => history,
      getTransaction: async (signature) => {
        if (signature === 'sig-2') throw new Error('rpc blip');
        const entry = history.find((e) => e.signature === signature)!;
        return txFor(signature, entry.slot);
      },
    };
    const h = harness(failing, () => fakeSocket().socket);
    try {
      await h.stream.start();
      // sig-2 failed, so it was never emitted; sig-3 still was.
      expect(h.swaps.map((s) => s.signature)).toEqual(['sig-1', 'sig-3']);
      expect(h.errors.map((e) => e.message)).toContain('rpc blip');
    } finally {
      h.close();
    }
  });

  it('survives a restart and resumes from the last EMITTED signature', async () => {
    const store = openCursorStore({ path: ':memory:' });
    try {
      const history = entries(4);
      const first = fakeRpc({ history: history.slice(2) }); // only sig-1, sig-2 exist yet
      const a = harness(first.rpc, () => fakeSocket().socket, store);
      await a.stream.start();
      expect(a.swaps.map((s) => s.signature)).toEqual(['sig-1', 'sig-2']);
      expect(store.get(WALLET)?.lastSignature).toBe('sig-2');
      a.stream.stop();

      // Process dies. A brand new stream, same store, more history now.
      const second = fakeRpc({ history });
      const b = harness(second.rpc, () => fakeSocket().socket, store);
      await b.stream.start();

      expect(second.calls[0]?.until).toBe('sig-2');
      expect(b.swaps.map((s) => s.signature)).toEqual(['sig-3', 'sig-4']);
      b.stream.stop();
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Subscription and backpressure
// ---------------------------------------------------------------------------

describe('subscription', () => {
  it('subscribes per wallet at confirmed commitment', async () => {
    const { rpc } = fakeRpc({ history: [] });
    const sock = fakeSocket();
    const h = harness(rpc, () => sock.socket);
    try {
      await h.stream.start();
      const request = JSON.parse(sock.sent[0] ?? '{}');
      expect(request.method).toBe('logsSubscribe');
      expect(request.params[0]).toEqual({ mentions: [WALLET] });
      expect(request.params[1]).toEqual({ commitment: 'confirmed' });
    } finally {
      h.close();
    }
  });
});

describe('backpressure', () => {
  it('drops the oldest pending and reports the count when the queue overflows', async () => {
    const history = entries(MAX_IN_FLIGHT + 10);
    // A getTransaction that never settles keeps the drain loop busy.
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const rpc: RpcClient = {
      getSignaturesForAddress: async () => [],
      getTransaction: async (signature) => {
        if (first) {
          first = false;
          await blocked;
        }
        const entry = history.find((e) => e.signature === signature);
        return entry === undefined ? null : txFor(signature, entry.slot);
      },
    };

    const sock = fakeSocket();
    const h = harness(rpc, () => sock.socket);
    try {
      await h.stream.start();
      for (const entry of history) sock.deliver(entry.signature, entry.slot);

      expect(h.errors.some((e) => e.message === 'fetch queue overflow')).toBe(true);
      const overflow = h.errors.find((e) => e.message === 'fetch queue overflow') as Error & {
        dropped: number;
      };
      expect(overflow.dropped).toBeGreaterThan(0);

      release?.();
      await new Promise((r) => setImmediate(r));
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Signal provenance
// ---------------------------------------------------------------------------

/**
 * `WalletStream` is the only component that knows how a transaction reached
 * this process. By the time a signature is inside `handle()` nothing about it
 * records which path brought it, so if the stamp is wrong here it is wrong
 * everywhere downstream — including at the freshness gate, which is the point.
 */
describe('source stamping', () => {
  it('stamps gap-filled swaps as gapfill', async () => {
    const history = entries(3);
    const { rpc } = fakeRpc({ history });
    const h = harness(rpc, () => fakeSocket().socket);
    try {
      h.cursors.set(WALLET, 'sig-1', 101);
      await h.stream.start();

      expect(h.swaps).toHaveLength(2);
      expect(h.swaps.map((s) => s.source)).toEqual(['gapfill', 'gapfill']);
    } finally {
      h.close();
    }
  });

  it('stamps socket-delivered swaps as live', async () => {
    const history = entries(3);
    const { rpc } = fakeRpc({ history });
    const sock = fakeSocket();
    const h = harness(rpc, () => sock.socket);
    try {
      // Cursor at the tip, so the gap fill produces nothing and every swap
      // below can only have come from the socket.
      h.cursors.set(WALLET, 'sig-3', 103);
      await h.stream.start();
      expect(h.swaps).toHaveLength(0);

      sock.deliver('sig-2', 102);
      await new Promise((r) => setImmediate(r));

      expect(h.swaps).toHaveLength(1);
      expect(h.swaps[0]?.source).toBe('live');
    } finally {
      h.close();
    }
  });

  it('stamps observedAt from the injected clock, not the block', async () => {
    const history = entries(2);
    const { rpc } = fakeRpc({ history });
    const h = harness(rpc, () => fakeSocket().socket);
    try {
      h.cursors.set(WALLET, 'sig-1', 101);
      await h.stream.start();

      // The harness clock. Distinct from the capture's own blockTime, which is
      // what makes this an assertion rather than a coincidence.
      expect(h.swaps[0]?.observedAt).toBe(1_700_000_000_000);
      expect(h.swaps[0]?.observedAt).not.toBe(h.swaps[0]?.blockTime);
    } finally {
      h.close();
    }
  });

  /**
   * The mixed case, which is the one a reconnect actually produces: a backlog
   * lands first and live traffic resumes behind it. Both must be labelled
   * correctly in one run, or the UI counter that distinguishes them is lying.
   */
  it('labels a reconnect backlog and the live traffic behind it differently', async () => {
    const history = entries(5);
    const { rpc } = fakeRpc({ history });
    const sock = fakeSocket();
    const h = harness(rpc, () => sock.socket);
    try {
      h.cursors.set(WALLET, 'sig-2', 102);
      await h.stream.start();

      const backlog = [...h.swaps];
      expect(backlog.map((s) => s.signature)).toEqual(['sig-3', 'sig-4', 'sig-5']);
      expect(backlog.map((s) => s.source)).toEqual(['gapfill', 'gapfill', 'gapfill']);

      // `sig-1` sits below the cursor, so the gap fill never covered it and the
      // seen-set has not admitted it. It can only arrive over the socket, which
      // is what makes the label below an assertion rather than a coincidence.
      sock.deliver('sig-1', 101);
      await new Promise((r) => setImmediate(r));

      expect(h.swaps).toHaveLength(4);
      expect(h.swaps[3]).toMatchObject({ signature: 'sig-1', source: 'live' });
      expect(h.swaps.filter((s) => s.source === 'gapfill')).toHaveLength(3);
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The null window
// ---------------------------------------------------------------------------

/**
 * `getTransaction` routinely answers `null` for a signature the socket has only
 * just announced — the transaction is known to the validator but not yet
 * queryable. Session 20 measured what that cost: roughly 965 swaps, 34.2% of
 * swap-like traffic, gone from the corpus permanently, because the signature was
 * admitted to the seen-set BEFORE the fetch and the gap fill could never
 * re-deliver it.
 */
describe('null window', () => {
  it('retries a null fetch and parses the signature exactly once', async () => {
    const history = entries(1);
    let calls = 0;
    const rpc: RpcClient = {
      getSignaturesForAddress: async () => history,
      getTransaction: async (signature) => {
        calls += 1;
        // The window: known to the cluster, not yet returnable.
        if (calls === 1) return null;
        const entry = history.find((e) => e.signature === signature)!;
        return txFor(signature, entry.slot);
      },
    };
    const h = harness(rpc, () => fakeSocket().socket);
    try {
      await h.stream.start();
      expect(h.swaps.map((s) => s.signature)).toEqual(['sig-1']);
      expect(calls).toBeGreaterThan(1);
    } finally {
      h.close();
    }
  });

  it('does NOT admit a signature that never resolves, so a later gap fill retries it', async () => {
    const history = entries(1);
    let alwaysNull = true;
    const rpc: RpcClient = {
      getSignaturesForAddress: async () => history,
      getTransaction: async (signature) => {
        if (alwaysNull) return null;
        const entry = history.find((e) => e.signature === signature)!;
        return txFor(signature, entry.slot);
      },
    };
    const h = harness(rpc, () => fakeSocket().socket);
    try {
      await h.stream.start();
      expect(h.swaps).toHaveLength(0);

      // The transaction becomes fetchable, and a later gap fill re-delivers the
      // signature rather than treating it as already handled. This is the whole
      // point: an unresolved fetch must not consume the signature.
      alwaysNull = false;
      // `start()` gap-fills every wallet, which is the real trigger — the same
      // one a reconnect uses. No test-only API.
      await h.stream.start();

      expect(h.swaps.map((s) => s.signature)).toEqual(['sig-1']);
    } finally {
      h.close();
    }
  });

  it('parses once when the socket and the gap fill race the same signature', async () => {
    // `gapFill` awaits `handle` directly while the socket path goes through the
    // queue, so the two genuinely interleave. Admitting only after a successful
    // fetch would let both fetch and both emit; the in-flight set is what stops
    // that, and this is the test that would catch its removal.
    const history = entries(1);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fetches = 0;
    const sock = fakeSocket();
    const rpc: RpcClient = {
      getSignaturesForAddress: async () => history,
      getTransaction: async (signature) => {
        fetches += 1;
        if (fetches === 1) {
          // While the first fetch is parked, the socket announces the same
          // signature.
          sock.deliver('sig-1', 101);
          await gate;
        }
        const entry = history.find((e) => e.signature === signature)!;
        return txFor(signature, entry.slot);
      },
    };
    const h = harness(rpc, () => sock.socket);
    try {
      const started = h.stream.start();
      await new Promise((r) => setImmediate(r));
      release!();
      await started;
      await new Promise((r) => setImmediate(r));

      expect(h.swaps.filter((s) => s.signature === 'sig-1')).toHaveLength(1);
      expect(fetches).toBe(1);
    } finally {
      h.close();
    }
  });

  it('reports the window it measured, so the detection leg is not a guess', async () => {
    const history = entries(1);
    let calls = 0;
    const rpc: RpcClient = {
      getSignaturesForAddress: async () => history,
      getTransaction: async (signature) => {
        calls += 1;
        if (calls < 3) return null;
        const entry = history.find((e) => e.signature === signature)!;
        return txFor(signature, entry.slot);
      },
    };
    const windows: Array<{ attempts: number; resolved: boolean }> = [];
    const cursors = openCursorStore({ path: ':memory:' });
    const stream = new WalletStream({
      wallets: [WALLET],
      rpc,
      cursors,
      connect: async () => fakeSocket().socket,
      now: () => 1_700_000_000_000,
      sleep: async () => undefined,
      random: () => 0,
    });
    stream.on('fetch-window', (event) => windows.push(event));
    try {
      await stream.start();
      expect(windows).toHaveLength(1);
      expect(windows[0]).toMatchObject({ attempts: 3, resolved: true });
    } finally {
      cursors.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Subscription routing
// ---------------------------------------------------------------------------

/**
 * `onMessage` used to discard the subscription id and enqueue every
 * notification for EVERY tracked wallet. One notification became thirteen
 * entries, twelve of them for wallets with nothing to do with the transaction;
 * the bounded queue then shed from the front, so the last wallet in the list
 * survived, fetched, was not in the transaction, and was admitted to the seen
 * set anyway — deduping out the wallet that actually traded. See handoff 21 for
 * the evidence and handoff 22 for the fix.
 */
describe('subscription routing', () => {
  const WALLET_B = 'popo3Rj6arKNttyUFpWfbkv2gG8uS13TGtmH6JPMuHz';

  function twoWalletHarness(rpc: RpcClient, socketFactory: () => StreamSocket) {
    const cursors = openCursorStore({ path: ':memory:' });
    const stream = new WalletStream({
      wallets: [WALLET, WALLET_B],
      rpc,
      cursors,
      connect: async () => socketFactory(),
      now: () => 1_700_000_000_000,
      sleep: async () => undefined,
      random: () => 0,
    });
    const attributed: string[] = [];
    const unknown: Array<{ subscription: number | null; signature: string }> = [];
    // `unparsed` and `swap` both carry the wallet the fetch was attributed to,
    // but only the fetch itself proves routing, so record at the RPC boundary.
    stream.on('unknown-subscription', (e) => unknown.push(e));
    return { stream, cursors, attributed, unknown };
  }

  it('routes a notification to the ONE wallet whose subscription carried it', async () => {
    const history = entries(1);
    const fetchedFor: string[] = [];
    const rpc: RpcClient = {
      getSignaturesForAddress: async () => [],
      getTransaction: async (signature) => {
        const entry = history.find((e) => e.signature === signature);
        return entry === undefined ? null : txFor(signature, entry.slot);
      },
    };
    const sock = fakeSocket();
    const cursors = openCursorStore({ path: ':memory:' });
    const stream = new WalletStream({
      wallets: [WALLET, WALLET_B],
      rpc,
      cursors,
      connect: async () => sock.socket,
      now: () => 1_700_000_000_000,
      sleep: async () => undefined,
      random: () => 0,
    });
    // The cursor advances once per successful dispatch, and it is per wallet —
    // so it is the cleanest observable proof of who a fetch was attributed to.
    try {
      await stream.start();
      sock.deliver('sig-1', 101, WALLET_B);
      await new Promise((r) => setImmediate(r));

      expect(cursors.get(WALLET_B)?.lastSignature).toBe('sig-1');
      // The other wallet must not have been touched at all.
      expect(cursors.get(WALLET)?.lastSignature).toBeUndefined();
      void fetchedFor;
    } finally {
      cursors.close();
    }
  });

  it('remaps ids on reconnect, so a stale id is not routed to the wrong wallet', async () => {
    const history = entries(2);
    const rpc: RpcClient = {
      getSignaturesForAddress: async () => [],
      getTransaction: async (signature) => {
        const entry = history.find((e) => e.signature === signature);
        return entry === undefined ? null : txFor(signature, entry.slot);
      },
    };
    // Two sockets: the second hands out different ids for the same wallets.
    const first = fakeSocket(1_000);
    const second = fakeSocket(2_000);
    let handedOut = 0;
    const cursors = openCursorStore({ path: ':memory:' });
    const stream = new WalletStream({
      wallets: [WALLET, WALLET_B],
      rpc,
      cursors,
      connect: async () => (handedOut++ === 0 ? first.socket : second.socket),
      now: () => 1_700_000_000_000,
      sleep: async () => undefined,
      random: () => 0,
    });
    const unknown: unknown[] = [];
    stream.on('unknown-subscription', (e) => unknown.push(e));
    try {
      await stream.start();
      const staleId = first.subscriptionIds.get(WALLET_B)!;

      // Reconnect. The second socket issues fresh ids for both wallets.
      first.socket.close();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // A notification arriving on the OLD id must not be routed at all.
      second.deliverRaw('sig-1', 101, staleId);
      await new Promise((r) => setImmediate(r));
      expect(cursors.get(WALLET)?.lastSignature).toBeUndefined();
      expect(cursors.get(WALLET_B)?.lastSignature).toBeUndefined();
      expect(unknown).toHaveLength(1);

      // The new id routes correctly.
      second.deliver('sig-2', 102, WALLET_B);
      await new Promise((r) => setImmediate(r));
      expect(cursors.get(WALLET_B)?.lastSignature).toBe('sig-2');
    } finally {
      cursors.close();
    }
  });

  it('emits an unknown subscription id rather than fanning it out', async () => {
    const fetched: string[] = [];
    const rpc: RpcClient = {
      getSignaturesForAddress: async () => [],
      getTransaction: async (signature) => {
        fetched.push(signature);
        return txFor(signature, 101);
      },
    };
    const sock = fakeSocket();
    const h = twoWalletHarness(rpc, () => sock.socket);
    try {
      await h.stream.start();
      sock.deliverRaw('sig-1', 101, 999_999);
      await new Promise((r) => setImmediate(r));

      expect(h.unknown).toHaveLength(1);
      expect(h.unknown[0]).toMatchObject({ subscription: 999_999, signature: 'sig-1' });
      // Not fanned out: nothing was fetched for anybody.
      expect(fetched).toHaveLength(0);
    } finally {
      h.cursors.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Seen set keyed on (wallet, signature)
// ---------------------------------------------------------------------------

/**
 * Handoff 22 fixed WHO a notification is routed to. It did not fix what the
 * seen set is keyed on, and those are different bugs with the same symptom.
 *
 * With a signature-only key, one transaction genuinely involving two tracked
 * wallets still loses the second: the first admits the signature and the second
 * is deduped away before it is ever fetched. Handoff 22 argued that re-keying on
 * `(wallet, signature)` and no longer admitting `WALLET_NOT_IN_TX` are one
 * change rather than two, because admitting a mentions-only match is only
 * defensible while the key is signature-only. Both move together here.
 *
 * The collision case is exercised with a REAL capture, not a synthetic one.
 * `raydium-v4-buy.json` has two genuine balance participants — the trader, who
 * buys, and the pool vault, which sells the same token amount back. Nothing
 * about the fixture was fabricated to make this describe block work.
 */
describe('seen set keyed on (wallet, signature)', () => {
  /** The pool vault in the capture: a real second balance participant. */
  const POOL = '4DjZjwnQZz4kMm9djNeZzfAzom2Acnefxd6BtJpKT3kz';
  /** Named in neither leg of the capture, so it parses `WALLET_NOT_IN_TX`. */
  const ABSENT = 'popo3Rj6arKNttyUFpWfbkv2gG8uS13TGtmH6JPMuHz';

  const tick = async (times = 3): Promise<void> => {
    for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
  };

  function pairHarness(
    wallets: string[],
    rpc: RpcClient,
    socketFactory: () => StreamSocket,
  ) {
    const cursors = openCursorStore({ path: ':memory:' });
    const stream = new WalletStream({
      wallets,
      rpc,
      cursors,
      connect: async () => socketFactory(),
      now: () => 1_700_000_000_000,
      sleep: async () => undefined,
      random: () => 0,
    });
    const swaps: TrackedSwap[] = [];
    const unparsed: Array<{ reason: string; signature: string }> = [];
    stream.on('swap', (swap: TrackedSwap) => swaps.push(swap));
    stream.on('unparsed', (result: { reason: string; signature: string }) =>
      unparsed.push(result),
    );
    return { stream, cursors, swaps, unparsed, close: () => cursors.close() };
  }

  it('emits one swap per tracked wallet named in a single transaction', async () => {
    const fetched: string[] = [];
    const rpc: RpcClient = {
      // Nothing from gap fill: every swap below can only have come from the
      // socket, so the assertion is about routing and keying rather than replay.
      getSignaturesForAddress: async () => [],
      getTransaction: async (signature) => {
        fetched.push(signature);
        return txFor(signature, 101);
      },
    };
    const sock = fakeSocket();
    const h = pairHarness([WALLET, POOL], rpc, () => sock.socket);
    try {
      await h.stream.start();

      // One transaction, two matching `mentions` filters: the server delivers
      // it once per subscription, which is exactly what the collision case is.
      sock.deliver('sig-1', 101, WALLET);
      sock.deliver('sig-1', 101, POOL);
      await tick();

      expect(h.swaps).toHaveLength(2);
      expect([...h.swaps.map((s) => s.wallet)].sort()).toEqual([POOL, WALLET].sort());
      expect(new Set(h.swaps.map((s) => s.signature))).toEqual(new Set(['sig-1']));
      // Opposite sides of one trade, which is what makes them two observations
      // rather than one duplicated.
      expect([...h.swaps.map((s) => s.side)].sort()).toEqual(['buy', 'sell']);
      // Both admitted: a per-wallet cursor only advances on a dispatch
      // attributed to that wallet.
      expect(h.cursors.get(WALLET)?.lastSignature).toBe('sig-1');
      expect(h.cursors.get(POOL)?.lastSignature).toBe('sig-1');
      expect(fetched).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it('dedupes the same (wallet, signature) across socket then gap fill', async () => {
    const history = entries(1);
    let listCalls = 0;
    const fetched: string[] = [];
    const rpc: RpcClient = {
      // Startup yields nothing; every later call re-offers `sig-1` regardless of
      // `until`, so the dedupe under test can only come from the seen set and
      // never from the cursor having moved past it.
      getSignaturesForAddress: async () => (++listCalls === 1 ? [] : history),
      getTransaction: async (signature) => {
        fetched.push(signature);
        return txFor(signature, 101);
      },
    };
    const sock = fakeSocket();
    const h = pairHarness([WALLET], rpc, () => sock.socket);
    try {
      await h.stream.start();
      sock.deliver('sig-1', 101, WALLET);
      await tick();
      expect(h.swaps).toHaveLength(1);
      expect(fetched).toEqual(['sig-1']);

      // Drop the socket: reconnect re-runs gap fill, which re-offers sig-1.
      sock.socket.close();
      await tick(6);

      expect(h.swaps).toHaveLength(1);
      expect(fetched).toEqual(['sig-1']);
    } finally {
      h.close();
    }
  });

  it('does not suppress a second wallet on a signature the first admitted', async () => {
    const history = entries(1);
    const fetched: Array<string> = [];
    const rpc: RpcClient = {
      // Only WALLET has history, so POOL can reach `sig-1` over the socket
      // alone — the cross-path case, gap fill first and socket second.
      getSignaturesForAddress: async (address) => (address === WALLET ? history : []),
      getTransaction: async (signature) => {
        fetched.push(signature);
        return txFor(signature, 101);
      },
    };
    const sock = fakeSocket();
    const h = pairHarness([WALLET, POOL], rpc, () => sock.socket);
    try {
      await h.stream.start();
      expect(h.swaps.map((s) => s.wallet)).toEqual([WALLET]);
      expect(h.cursors.get(POOL)?.lastSignature).toBeUndefined();

      sock.deliver('sig-1', 101, POOL);
      await tick();

      expect(h.swaps).toHaveLength(2);
      expect(h.swaps[1]?.wallet).toBe(POOL);
      expect(h.cursors.get(POOL)?.lastSignature).toBe('sig-1');
      expect(fetched).toEqual(['sig-1', 'sig-1']);
    } finally {
      h.close();
    }
  });

  it('does not admit a wallet that was not in the transaction', async () => {
    const fetched: string[] = [];
    const rpc: RpcClient = {
      getSignaturesForAddress: async () => [],
      getTransaction: async (signature) => {
        fetched.push(signature);
        return txFor(signature, 101);
      },
    };
    const sock = fakeSocket();
    const h = pairHarness([ABSENT], rpc, () => sock.socket);
    try {
      await h.stream.start();

      sock.deliver('sig-1', 101, ABSENT);
      await tick();
      expect(h.swaps).toHaveLength(0);
      expect(h.unparsed.map((u) => u.reason)).toEqual(['WALLET_NOT_IN_TX']);
      expect(fetched).toEqual(['sig-1']);

      // Re-delivered. An admitted signature would be deduped and never fetched
      // again; a mentions-only match must stay re-deliverable, because two of
      // the three ways `parseSwap` reaches this code are degraded RPC responses
      // rather than a genuine absence.
      sock.deliver('sig-1', 101, ABSENT);
      await tick();
      expect(fetched).toEqual(['sig-1', 'sig-1']);
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Silence detection and reconnect — fault injection
// ---------------------------------------------------------------------------

/**
 * Session 23 discovered `heartbeat()` was never called by watching a two-hour
 * soak. It has been dead since the file was written, and ninety seconds of fault
 * injection would have said so. These tests are that instrument.
 *
 * They cover three things the soak conflated:
 *   1. a socket that goes silent WITHOUT erroring is detected at all;
 *   2. a reconnect re-subscribes and, crucially, BACKFILLS the window it missed;
 *   3. one socket death produces one reconnect, not one per event the socket
 *      happened to emit on its way out.
 *
 * A socket of their own, rather than `fakeSocket`, because these need to fire
 * `error` and `close` independently — which is exactly what a real WebSocket
 * does on its way down, and what `fakeSocket` has no way to express.
 */
describe('silence detection and reconnect', () => {
  const tick = async (times = 4): Promise<void> => {
    for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
  };

  /** A socket whose failure modes are drivable from the test. */
  function faultSocket(firstSubscriptionId: number) {
    let onMessage: (data: string) => void = () => undefined;
    let onClose: () => void = () => undefined;
    let onError: (error: Error) => void = () => undefined;
    const subscriptionIds = new Map<string, number>();
    let next = firstSubscriptionId;
    const sent: string[] = [];

    const socket: StreamSocket = {
      send: (payload) => {
        sent.push(payload);
        const request = JSON.parse(payload) as {
          id?: number;
          method?: string;
          params?: [{ mentions?: string[] }, unknown];
        };
        if (request.method !== 'logsSubscribe') return;
        const wallet = request.params?.[0]?.mentions?.[0];
        if (wallet === undefined || request.id === undefined) return;
        const subscription = next++;
        subscriptionIds.set(wallet, subscription);
        onMessage(JSON.stringify({ jsonrpc: '2.0', result: subscription, id: request.id }));
      },
      close: () => onClose(),
      onMessage: (h) => {
        onMessage = h;
      },
      onClose: (h) => {
        onClose = h;
      },
      onError: (h) => {
        onError = h;
      },
    };

    return {
      socket,
      sent,
      subscriptionIds,
      /** What a real WebSocket does on its way down: error, then close. */
      dieWithErrorThenClose: () => {
        onError(new Error('websocket error'));
        onClose();
      },
      deliver: (signature: string, slot: number, wallet: string) =>
        onMessage(
          JSON.stringify({
            params: {
              subscription: subscriptionIds.get(wallet),
              result: { context: { slot }, value: { signature, err: null } },
            },
          }),
        ),
    };
  }

  function faultHarness(history: SignatureEntry[], options: { hangFrom?: number } = {}) {
    let clock = 1_700_000_000_000;
    let connects = 0;
    const sockets: Array<ReturnType<typeof faultSocket>> = [];
    const { rpc, calls } = fakeRpc({ history });
    const cursors = openCursorStore({ path: ':memory:' });

    const stream = new WalletStream({
      wallets: [WALLET],
      rpc,
      cursors,
      connect: async () => {
        connects += 1;
        // A connect that never settles holds the stream in the disconnected
        // state deterministically, which is the only way to observe what a
        // heartbeat does while a reconnect is genuinely still outstanding.
        if (options.hangFrom !== undefined && connects >= options.hangFrom) {
          return new Promise<StreamSocket>(() => undefined);
        }
        const s = faultSocket(1_000 * connects);
        sockets.push(s);
        return s.socket;
      },
      now: () => clock,
      sleep: async () => undefined,
      random: () => 0,
    });

    const swaps: TrackedSwap[] = [];
    const disconnected: Array<{ reason: string }> = [];
    const reconnected: Array<{ attempt: number }> = [];
    stream.on('swap', (swap: TrackedSwap) => swaps.push(swap));
    stream.on('disconnected', (event: { reason: string }) => disconnected.push(event));
    stream.on('reconnected', (event: { attempt: number }) => reconnected.push(event));
    // `EventEmitter` throws an unhandled 'error' event, which would fail these
    // tests for a reason that has nothing to do with what they assert.
    stream.on('error', () => undefined);

    return {
      stream,
      cursors,
      swaps,
      disconnected,
      reconnected,
      sockets,
      calls,
      get connects() {
        return connects;
      },
      advance: (ms: number) => {
        clock += ms;
      },
      close: () => cursors.close(),
    };
  }

  it('tears down a socket that has gone silent past the timeout', async () => {
    const h = faultHarness(entries(2));
    try {
      h.cursors.set(WALLET, 'sig-2', 102);
      await h.stream.start();
      expect(h.connects).toBe(1);

      // Silent for longer than the timeout, with no error and no close: the
      // failure mode nothing in this system could previously see.
      h.advance(SILENCE_TIMEOUT_MS + 1_000);
      const tornDown = h.stream.heartbeat(true);
      await tick();

      expect(tornDown).toBe(true);
      expect(h.disconnected.some((d) => /silent/.test(d.reason))).toBe(true);
      expect(h.connects).toBe(2);
    } finally {
      h.close();
    }
  });

  it('does not tear down a socket inside the timeout', async () => {
    const h = faultHarness(entries(2));
    try {
      h.cursors.set(WALLET, 'sig-2', 102);
      await h.stream.start();

      // The largest gap between live deliveries measured with the machine
      // genuinely awake was 57.5s. A timeout that fires inside that would
      // reconnect on a quiet market, forever.
      h.advance(SILENCE_TIMEOUT_MS - 1_000);
      expect(h.stream.heartbeat(true)).toBe(false);
      await tick();

      expect(h.disconnected).toHaveLength(0);
      expect(h.connects).toBe(1);
    } finally {
      h.close();
    }
  });

  it('reconnects and BACKFILLS the window the socket was down for', async () => {
    // Newest first, as the RPC returns them.
    const history: SignatureEntry[] = [
      { signature: 'sig-5', slot: 105, err: null, transactionIndex: 0 },
      { signature: 'sig-4', slot: 104, err: null, transactionIndex: 0 },
      { signature: 'sig-3', slot: 103, err: null, transactionIndex: 0 },
    ];
    const h = faultHarness(history);
    try {
      h.cursors.set(WALLET, 'sig-3', 103);
      await h.stream.start();
      expect(h.swaps.map((s) => s.signature)).toEqual(['sig-4', 'sig-5']);

      // Two transactions happen while the socket is down. The socket cannot
      // deliver them; only the post-reconnect gap fill can.
      history.unshift({ signature: 'sig-7', slot: 107, err: null, transactionIndex: 0 });
      history.unshift({ signature: 'sig-6', slot: 106, err: null, transactionIndex: 0 });

      h.sockets[0]!.dieWithErrorThenClose();
      await tick(8);

      expect(h.connects).toBe(2);
      expect(h.reconnected).toHaveLength(1);
      // Re-subscribed on the NEW socket, not the dead one.
      expect(h.sockets[1]!.subscriptionIds.get(WALLET)).toBeDefined();
      // The gap is filled: this is the assertion that separates "reconnected"
      // from "reconnected and actually recovered the missed window".
      expect(h.swaps.map((s) => s.signature)).toEqual(['sig-4', 'sig-5', 'sig-6', 'sig-7']);
      expect(h.cursors.get(WALLET)?.lastSignature).toBe('sig-7');
    } finally {
      h.close();
    }
  });

  it('treats one socket death as ONE reconnect, not one per event it emitted', async () => {
    const h = faultHarness(entries(2));
    try {
      h.cursors.set(WALLET, 'sig-2', 102);
      await h.stream.start();
      expect(h.connects).toBe(1);

      // A real WebSocket fires `error` and then `close`. Both used to reach
      // `onDisconnect`, and each started its own reconnect chain — visible in
      // session 23's session file as `websocket error` and `closed` one
      // millisecond apart, and thereafter as reconnect attempts arriving in
      // pairs for the rest of the run.
      h.sockets[0]!.dieWithErrorThenClose();
      await tick(8);

      expect(h.connects).toBe(2);
      expect(h.reconnected).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('does not start another reconnect for a heartbeat while already disconnected', async () => {
    // The second connect never settles, so after the first teardown the stream
    // stays genuinely disconnected with a reconnect outstanding.
    const h = faultHarness(entries(2), { hangFrom: 2 });
    try {
      h.cursors.set(WALLET, 'sig-2', 102);
      await h.stream.start();

      h.advance(SILENCE_TIMEOUT_MS + 1_000);
      expect(h.stream.heartbeat(true)).toBe(true);
      await tick(8);
      const afterFirst = h.connects;
      const disconnectsAfterFirst = h.disconnected.length;

      // `lastMessageAt` only moves on a delivered frame, so on a quiet feed
      // every subsequent tick still looks silent. Without a guard each one
      // starts another chain and they multiply for as long as the outage lasts.
      for (let i = 0; i < 3; i += 1) {
        h.advance(SILENCE_TIMEOUT_MS + 1_000);
        expect(h.stream.heartbeat(true)).toBe(false);
      }
      await tick(8);

      expect(h.connects).toBe(afterFirst);
      expect(h.disconnected).toHaveLength(disconnectsAfterFirst);
    } finally {
      h.close();
    }
  });
});
