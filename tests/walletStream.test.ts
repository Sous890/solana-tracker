import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TrackedSwap } from '../src/core/types.js';
import {
  MAX_COLD_FILL,
  MAX_IN_FLIGHT,
  MAX_WARM_FILL,

  SILENCE_TIMEOUT_MS,
  SeenSignatures,
  WalletStream,
  orderOldestFirst,
} from '../src/adapters/walletStream.js';
import type {
  GapFilledEvent,
  HistorySkippedEvent,
  TxFailedSkippedEvent,
  RpcClient,
  SignatureEntry,
  StreamSocket,
} from '../src/adapters/walletStream.js';
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
    /** A log notification whose transaction failed on chain. */
    deliverFailed: (signature: string, slot: number, err: unknown) => {
      const subscription = [...subscriptionIds.values()][0];
      onMessage(
        JSON.stringify({
          params: { subscription, result: { context: { slot }, value: { signature, err } } },
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

// ---------------------------------------------------------------------------
// The cursor advance, and the loss behind it
// ---------------------------------------------------------------------------

/**
 * `reconnect()` connects BEFORE it gap fills — `connectOnce()` subscribes and the
 * socket starts delivering, then the wallet loop runs. So live delivery and gap
 * fill overlap on every reconnect, today, with no change to the startup order.
 *
 * `start()` is the ordering everyone quotes: gap fill for every wallet, then
 * connect. That one is safe. It is also not the only path.
 */
describe('cursor advance while a gap fill is still running', () => {
  const tick = async (times = 6): Promise<void> => {
    for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
  };

  /** An RPC whose `getTransaction` can be held open for named signatures. */
  function gatedRpc(history: SignatureEntry[]) {
    const releases = new Map<string, () => void>();
    const held = new Map<string, Promise<void>>();
    const completed: string[] = [];
    const attempted: string[] = [];

    return {
      history,
      completed,
      attempted,
      /** Hold `getTransaction` for this signature until `release` is called. */
      hold(signature: string): void {
        let release!: () => void;
        held.set(signature, new Promise<void>((resolve) => {
          release = resolve;
        }));
        releases.set(signature, release);
      },
      release(signature: string): void {
        releases.get(signature)?.();
      },
      rpc: {
        async getSignaturesForAddress(_address, opts) {
          let list = [...history];
          if (opts.before !== undefined) {
            const index = list.findIndex((e) => e.signature === opts.before);
            list = index === -1 ? [] : list.slice(index + 1);
          }
          if (opts.until !== undefined) {
            const index = list.findIndex((e) => e.signature === opts.until);
            if (index !== -1) list = list.slice(0, index);
          }
          return list.slice(0, 1_000);
        },
        async getTransaction(signature) {
          attempted.push(signature);
          const gate = held.get(signature);
          if (gate !== undefined) await gate;
          completed.push(signature);
          const entry = history.find((e) => e.signature === signature);
          return entry === undefined ? null : txFor(signature, entry.slot);
        },
      } satisfies RpcClient,
    };
  }

  function streamOn(rpc: RpcClient, cursors: CursorStore, sockets: Array<() => StreamSocket>) {
    let index = 0;
    const stream = new WalletStream({
      wallets: [WALLET],
      rpc,
      cursors,
      connect: async () => (sockets[index++] ?? sockets.at(-1)!)(),
      now: () => 1_700_000_000_000,
      sleep: async () => undefined,
      random: () => 0,
    });
    const swaps: TrackedSwap[] = [];
    stream.on('swap', (swap: TrackedSwap) => swaps.push(swap));
    stream.on('error', () => undefined);
    return { stream, swaps };
  }

  it('loses entries that a live delivery advanced the cursor past', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-loss-'));
    const path = join(dir, 'cursors.db');
    // sig-10(slot 110) .. sig-1(slot 101), newest first, as the RPC returns them.
    const full = entries(10);
    // The wallet has been quiet up to sig-1; everything above it happens while
    // the socket is down.
    const g = gatedRpc([full.at(-1)!]);
    const seenSignatures = new Set<string>();

    const before = openCursorStore({ path });
    before.set(WALLET, 'sig-1', 101);
    const live = fakeSocket(1_000);
    const resumed = fakeSocket(2_000);
    const first = streamOn(g.rpc, before, [() => live.socket, () => resumed.socket]);

    // Gap fill finds nothing (cursor is already at the tip), then connects.
    await first.stream.start();

    // The wallet trades nine times while the socket is down.
    g.history.length = 0;
    g.history.push(...full);
    // The gap fill that follows the reconnect will hold here.
    g.hold('sig-3');

    live.socket.close();
    // `reconnect()` connects FIRST — `resumed` is subscribed and delivering —
    // and only then starts the wallet loop, which reaches sig-3 and blocks.
    await tick(8);

    // Live traffic on the new socket, while sig-3..sig-9 are still outstanding.
    resumed.deliver('sig-10', 110);
    await tick(8);

    // A crash here: work in flight, nothing more will complete.
    first.stream.stop();
    for (const swap of first.swaps) seenSignatures.add(swap.signature);
    const strandedCursor = before.get(WALLET);
    before.close();

    // Leg 1: the gap fill really is mid-flight, with entries behind the hold.
    expect(g.completed).toContain('sig-2');
    expect(g.completed).not.toContain('sig-4');

    // Leg 2: the live delivery really was processed while sig-3..sig-9 were
    // outstanding — that is the race, and it still happens. What must not
    // happen is the cursor naming it. Before the barrier it read sig-10 at slot
    // 110, which is the position whose predecessors were unhandled.
    expect(g.completed).toContain('sig-10');
    expect(strandedCursor?.lastSlot ?? 0).toBeLessThan(110);
    // Positively: it names the newest position whose predecessors are all done.
    expect(strandedCursor?.lastSignature).toBe('sig-2');

    // Leg 3: a restart from that cursor asks for them again.
    //
    // A fresh RPC, with no hold on sig-3: the process that was blocked there is
    // the one that died, and the new one has no reason to stall on it.
    const afterCrash = gatedRpc(full);
    const after = openCursorStore({ path });
    const restarted = streamOn(afterCrash.rpc, after, [() => fakeSocket(3_000).socket]);
    await restarted.stream.start();
    for (const swap of restarted.swaps) seenSignatures.add(swap.signature);
    restarted.stream.stop();
    after.close();
    rmSync(dir, { recursive: true, force: true });

    // The loss. Not "the cursor moved" — these trades are gone, and no future
    // gap fill can reach them, because the cursor says they are done.
    for (const lost of ['sig-4', 'sig-5', 'sig-6', 'sig-7', 'sig-8', 'sig-9']) {
      expect(seenSignatures.has(lost)).toBe(true);
    }
  });

  it('emits one swap when live and gap fill both carry a signature, either order', async () => {
    // The refuted premise, pinned so it is not re-litigated. Dedup was never the
    // exposure here: `seen` and `inFlight` are both keyed on (wallet, signature)
    // and both delivery paths converge on `handle`, so whichever arrives second
    // is dropped. The cursor is what was unprotected.
    for (const liveFirst of [true, false]) {
      const cursors = openCursorStore({ path: ':memory:' });
      cursors.set(WALLET, 'sig-1', 101);
      const g = gatedRpc(entries(3));
      const socket = fakeSocket(1_000);
      const { stream, swaps } = streamOn(g.rpc, cursors, [() => socket.socket]);

      if (liveFirst) {
        // Connect first so the notification is admitted before gap fill runs.
        await stream.start();
        socket.deliver('sig-3', 103);
        await tick(8);
      } else {
        await stream.start();
        await tick(8);
        socket.deliver('sig-3', 103);
        await tick(8);
      }

      expect(swaps.filter((s) => s.signature === 'sig-3')).toHaveLength(1);
      stream.stop();
      cursors.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The barrier must not leak
// ---------------------------------------------------------------------------

/**
 * A hold that is never released freezes a wallet's cursor for the life of the
 * process — silently, while swaps keep emitting and the socket keeps looking
 * healthy. The failure is invisible until the next restart replays from a
 * cursor that stopped moving hours ago.
 *
 * So the hold has to be structurally impossible to leak, not merely unlikely.
 */
describe('gap-fill barrier release', () => {
  const tick = async (times = 6): Promise<void> => {
    for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
  };

  function rpcOver(history: SignatureEntry[]): RpcClient {
    return {
      async getSignaturesForAddress(_address, opts) {
        let list = [...history];
        if (opts.until !== undefined) {
          const index = list.findIndex((e) => e.signature === opts.until);
          if (index !== -1) list = list.slice(0, index);
        }
        return list.slice(0, 1_000);
      },
      async getTransaction(signature) {
        const entry = history.find((e) => e.signature === signature);
        return entry === undefined ? null : txFor(signature, entry.slot);
      },
    };
  }

  it('releases every hold when the wallet loop dies mid-gap-fill', async () => {
    const cursors = openCursorStore({ path: ':memory:' });
    cursors.set(WALLET, 'sig-1', 101);
    const stream = new WalletStream({
      wallets: [WALLET],
      rpc: rpcOver(entries(6)),
      cursors,
      connect: async () => fakeSocket(1_000).socket,
      now: () => 1_700_000_000_000,
      sleep: async () => undefined,
      random: () => 0,
    });

    // A listener that throws is not hypothetical: `emit('swap')` is synchronous,
    // and everything downstream of it is somebody else's code.
    let emitted = 0;
    stream.on('swap', () => {
      emitted += 1;
      if (emitted === 2) throw new Error('listener exploded mid-gap-fill');
    });
    stream.on('error', () => undefined);

    await expect(stream.start()).rejects.toThrow('listener exploded');
    await tick();

    // The exact call a live delivery makes. If the hold leaked, this is
    // deferred for ever and the cursor never moves again.
    cursors.set(WALLET, 'sig-live', 500);
    expect(cursors.get(WALLET)?.lastSignature).toBe('sig-live');
    expect(cursors.get(WALLET)?.lastSlot).toBe(500);

    stream.stop();
    cursors.close();
  });

  it('releases the holds of wallets the loop never reached', async () => {
    // The first wallet throws, so wallets 2 and 3 never have their gap fill run
    // at all — but they were held up front, before the loop started.
    const other = 'HSsJjkHrxezZ1SdhgdivhDGXbxANicWbKvKsVtrMrJvG';
    const third = 'AgiGpUAF25B7NL9u8byDcptPcYWi4eFU4kjtcRtaMmdQ';
    const cursors = openCursorStore({ path: ':memory:' });
    const stream = new WalletStream({
      wallets: [WALLET, other, third],
      rpc: rpcOver(entries(4)),
      cursors,
      connect: async () => fakeSocket(1_000).socket,
      now: () => 1_700_000_000_000,
      sleep: async () => undefined,
      random: () => 0,
    });
    stream.on('swap', () => {
      throw new Error('first wallet exploded');
    });
    stream.on('error', () => undefined);

    await expect(stream.start()).rejects.toThrow('first wallet exploded');
    await tick();

    for (const wallet of [WALLET, other, third]) {
      cursors.set(wallet, `live-${wallet.slice(0, 4)}`, 900);
      expect(cursors.get(wallet)?.lastSlot).toBe(900);
    }

    stream.stop();
    cursors.close();
  });
});

// ---------------------------------------------------------------------------
// The reconnect chain
// ---------------------------------------------------------------------------

describe('a disconnect during reconnection', () => {
  const tick = async (times = 8): Promise<void> => {
    for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
  };

  it('is not lost while the reconnect that follows it is still gap filling', async () => {
    // `reconnect()` connects, then gap fills, then declares success. The socket
    // it just established can die inside that gap fill — and `beginReconnect`
    // refuses to start a chain while `reconnecting` is true, so the death is
    // dropped. The loop then finishes, announces `reconnected` for a socket that
    // is gone, clears the flag, and returns. Nothing is left watching.
    const cursors = openCursorStore({ path: ':memory:' });
    cursors.set(WALLET, 'sig-1', 101);

    const full = entries(4);
    const history: SignatureEntry[] = [full.at(-1)!];
    let releaseFetch: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let gateArmed = false;

    const rpc: RpcClient = {
      async getSignaturesForAddress(_address, opts) {
        let list = [...history];
        if (opts.until !== undefined) {
          const index = list.findIndex((e) => e.signature === opts.until);
          if (index !== -1) list = list.slice(0, index);
        }
        return list.slice(0, 1_000);
      },
      async getTransaction(signature) {
        if (gateArmed && signature === 'sig-2') await gate;
        const entry = history.find((e) => e.signature === signature);
        return entry === undefined ? null : txFor(signature, entry.slot);
      },
    };

    const sockets: Array<ReturnType<typeof fakeSocket>> = [];
    const closed = new Set<number>();
    const stream = new WalletStream({
      wallets: [WALLET],
      rpc,
      cursors,
      connect: async () => {
        const index = sockets.length;
        const socket = fakeSocket(1_000 * (index + 1));
        const shut = socket.socket.close.bind(socket.socket);
        socket.socket.close = () => {
          closed.add(index);
          shut();
        };
        sockets.push(socket);
        return socket.socket;
      },
      now: () => 1_700_000_000_000,
      sleep: async () => undefined,
      random: () => 0,
    });
    stream.on('error', () => undefined);
    // `attempt` is not a proxy for which socket succeeded — `connectOnce` resets
    // the counter on every success, so a second successful connect reports
    // attempt 1 again. What matters is whether a socket was actually alive at
    // the moment success was announced.
    const reconnected: Array<{ liveSocket: boolean }> = [];
    stream.on('reconnected', () =>
      reconnected.push({ liveSocket: !closed.has(sockets.length - 1) }),
    );

    await stream.start();
    expect(sockets).toHaveLength(1);

    // Work for the reconnect's gap fill to get stuck in.
    history.length = 0;
    history.push(...full);
    gateArmed = true;

    sockets[0]!.socket.close();
    await tick();
    expect(sockets).toHaveLength(2);

    // The socket the reconnect just established dies, mid gap fill.
    sockets[1]!.socket.close();
    await tick();

    releaseFetch?.();
    await tick(20);

    // Either it reconnected again, or it is sitting with no socket and nothing
    // pending — which is the stream being silently dead for the rest of the run.
    expect(sockets.length).toBeGreaterThanOrEqual(3);
    // Success announced exactly once, and for a socket that was actually live.
    // Before the fix this fired while the newest socket was already closed.
    expect(reconnected).toHaveLength(1);
    expect(reconnected[0]?.liveSocket).toBe(true);

    stream.stop();
    cursors.close();
  });
});

// ---------------------------------------------------------------------------
// Attribution on the recorded events
// ---------------------------------------------------------------------------

describe('feed events carry enough to be measured later', () => {
  it('stamps a slot on every fetch window, resolved or not', async () => {
    const { rpc } = fakeRpc({ history: entries(2) });
    const h = harness(rpc, () => fakeSocket().socket);
    const windows: Array<{ signature: string; slot: number }> = [];
    h.stream.on('fetch-window', (event: { signature: string; slot: number }) =>
      windows.push(event),
    );
    try {
      await h.stream.start();
      // entries(2) is sig-2 at slot 102 and sig-1 at slot 101.
      expect(windows.map((w) => [w.signature, w.slot])).toEqual([
        ['sig-1', 101],
        ['sig-2', 102],
      ]);
    } finally {
      h.stream.stop();
      h.close();
    }
  });

  it('attributes an unparsed transaction to a wallet and a slot', async () => {
    // `UnparsedTransaction` carries neither, so without the context argument a
    // recorded `swap-unparsed` cannot be tied to a wallet at all — and unparsed
    // records are the majority of tracked traffic.
    const absent = 'popo3Rj6arKNttyUFpWfbkv2gG8uS13TGtmH6JPMuHz';
    const cursors = openCursorStore({ path: ':memory:' });
    const { rpc } = fakeRpc({ history: entries(1) });
    const stream = new WalletStream({
      wallets: [absent],
      rpc,
      cursors,
      connect: async () => fakeSocket().socket,
      now: () => 1_700_000_000_000,
      sleep: async () => undefined,
      random: () => 0,
    });
    const seen: Array<{ reason: string; wallet?: string; slot?: number; source?: string }> = [];
    stream.on('unparsed', (result: { reason: string }, context: any) =>
      seen.push({ reason: result.reason, ...context }),
    );
    stream.on('error', () => undefined);

    await stream.start();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.reason).toBe('WALLET_NOT_IN_TX');
    expect(seen[0]?.wallet).toBe(absent);
    expect(seen[0]?.slot).toBe(101);
    expect(seen[0]?.source).toBe('gapfill');

    stream.stop();
    cursors.close();
  });
});

// ---------------------------------------------------------------------------
// The warm bound
// ---------------------------------------------------------------------------

describe('bounded warm gap fill', () => {
  function warmHarness(history: SignatureEntry[], store?: CursorStore) {
    const { rpc } = fakeRpc({ history });
    const cursors = store ?? openCursorStore({ path: ':memory:' });
    const stream = new WalletStream({
      wallets: [WALLET],
      rpc,
      cursors,
      connect: async () => fakeSocket().socket,
      now: () => 1_700_000_000_000,
      sleep: async () => undefined,
      random: () => 0,
    });
    const swaps: TrackedSwap[] = [];
    const gapFills: GapFilledEvent[] = [];
    const skipped: HistorySkippedEvent[] = [];
    stream.on('swap', (swap: TrackedSwap) => swaps.push(swap));
    stream.on('gap-filled', (event: GapFilledEvent) => gapFills.push(event));
    stream.on('history-skipped', (event: HistorySkippedEvent) => skipped.push(event));
    stream.on('error', () => undefined);
    return { stream, cursors, swaps, gapFills, skipped };
  }

  it('leaves a warm fill under the bound completely alone', async () => {
    // entries(N) is sig-N at slot 100+N down to sig-1 at slot 101.
    const history = entries(MAX_WARM_FILL);
    const h = warmHarness(history);
    try {
      h.cursors.set(WALLET, 'sig-1', 101);
      await h.stream.start();

      // 99 entries newer than the cursor, which is under the bound.
      expect(h.gapFills[0]?.count).toBe(MAX_WARM_FILL - 1);
      expect(h.skipped).toHaveLength(0);
      expect(h.gapFills[0]?.truncated).toBe(false);
      expect(h.cursors.get(WALLET)?.lastSignature).toBe(`sig-${MAX_WARM_FILL}`);
    } finally {
      h.stream.stop();
      h.cursors.close();
    }
  });

  it('truncates over the bound, lands the cursor on the truncation point, and skips no more', async () => {
    const total = MAX_WARM_FILL + 40;
    const history = entries(total);
    const h = warmHarness(history);
    try {
      h.cursors.set(WALLET, 'sig-1', 101);
      await h.stream.start();

      // 139 entries were newer than the cursor; the newest 100 are kept.
      const skippedCount = total - 1 - MAX_WARM_FILL;
      expect(h.skipped).toHaveLength(1);
      expect(h.skipped[0]).toMatchObject({
        wallet: WALLET,
        count: skippedCount,
        bound: MAX_WARM_FILL,
      });

      // The window starts at the CURSOR — the last position actually
      // delivered — not at the oldest signature paging happened to reach. With
      // paging now bounded those differ, and the cursor is the honest edge.
      expect(h.skipped[0]?.fromSlot).toBe(101);
      expect(h.skipped[0]?.toSlot).toBe(101 + skippedCount);

      // Nothing in the skipped window was emitted.
      const emitted = new Set(h.swaps.map((swap) => swap.signature));
      for (let i = 2; i <= 1 + skippedCount; i += 1) {
        expect(emitted.has(`sig-${i}`), `sig-${i} was in the skipped window`).toBe(false);
      }
      // Everything from the truncation point up was.
      expect(h.swaps).toHaveLength(MAX_WARM_FILL);

      // And the cursor ends at the tip, having passed through the truncation
      // point rather than jumping over the kept entries.
      expect(h.cursors.get(WALLET)?.lastSignature).toBe(`sig-${total}`);
    } finally {
      h.stream.stop();
      h.cursors.close();
    }
  });

  it('records the truncation point durably even if nothing after it is handled', async () => {
    // A crash immediately after the skip must not re-attempt the window. The
    // cursor write happens before any entry is handled, so a store inspected at
    // that moment already names the truncation point.
    const total = MAX_WARM_FILL + 10;
    const history = entries(total);
    const { rpc } = fakeRpc({ history });
    const cursors = openCursorStore({ path: ':memory:' });
    const seen: Array<string | undefined> = [];
    const stream = new WalletStream({
      wallets: [WALLET],
      rpc,
      cursors,
      connect: async () => fakeSocket().socket,
      now: () => 1_700_000_000_000,
      sleep: async () => undefined,
      random: () => 0,
    });
    stream.on('history-skipped', () => {
      seen.push(cursors.get(WALLET)?.lastSignature);
    });
    stream.on('error', () => undefined);
    try {
      cursors.set(WALLET, 'sig-1', 101);
      await stream.start();
      // At the instant the gap was announced, the cursor already named the
      // truncation point — the newest abandoned signature.
      expect(seen).toEqual([`sig-${total - MAX_WARM_FILL}`]);
    } finally {
      stream.stop();
      cursors.close();
    }
  });

  it('reports the count as unknown when paging stopped before the window ended', async () => {
    // Paging is bounded too now. A backlog bigger than one page means the
    // window is known but its population never was, and `count` says so rather
    // than reporting a lower bound as a plain number that gets summed.
    const history = entries(2_500);
    const h = warmHarness(history);
    try {
      h.cursors.set(WALLET, 'sig-1', 101);
      await h.stream.start();

      expect(h.skipped).toHaveLength(1);
      expect(h.skipped[0]?.count).toBeNull();
      // The window itself is still exact at both ends.
      expect(h.skipped[0]?.fromSlot).toBe(101);
      expect(h.skipped[0]?.toSlot).toBeGreaterThan(101);
      // And the fill still handled only the bound, not the page.
      expect(h.swaps).toHaveLength(MAX_WARM_FILL);
    } finally {
      h.stream.stop();
      h.cursors.close();
    }
  });

  it('distinguishes a cold truncation from a warm one by event type', async () => {
    const history = entries(MAX_COLD_FILL + 30);

    const cold = warmHarness(history);
    try {
      // No cursor at all.
      await cold.stream.start();
      expect(cold.gapFills[0]?.truncated).toBe(true);
      expect(cold.skipped).toHaveLength(0);
    } finally {
      cold.stream.stop();
      cold.cursors.close();
    }

    const warm = warmHarness(history);
    try {
      warm.cursors.set(WALLET, 'sig-1', 101);
      await warm.stream.start();
      expect(warm.skipped).toHaveLength(1);
      // The flag stays FALSE on a warm truncation: the event type is the
      // discriminator, so neither fact has to be read off the other's flag.
      expect(warm.gapFills[0]?.truncated).toBe(false);
    } finally {
      warm.stream.stop();
      warm.cursors.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Failed transactions are classified, not fetched
// ---------------------------------------------------------------------------

describe('a transaction the notification already called failed', () => {
  function rig(history: SignatureEntry[]) {
    const { rpc, fetched } = fakeRpc({ history });
    const cursors = openCursorStore({ path: ':memory:' });
    const socket = fakeSocket();
    const stream = new WalletStream({
      wallets: [WALLET],
      rpc,
      cursors,
      connect: async () => socket.socket,
      now: () => 1_700_000_000_000,
      sleep: async () => undefined,
      random: () => 0,
    });
    const skipped: TxFailedSkippedEvent[] = [];
    const swaps: TrackedSwap[] = [];
    stream.on('tx-failed-skipped', (e: TxFailedSkippedEvent) => skipped.push(e));
    stream.on('swap', (s: TrackedSwap) => swaps.push(s));
    stream.on('error', () => undefined);
    return { stream, cursors, socket, skipped, swaps, fetched };
  }

  const tick = async (n = 8): Promise<void> => {
    for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
  };

  it('is not fetched, not queued, and is classified once', async () => {
    const h = rig([]);
    try {
      await h.stream.start();
      h.socket.deliverFailed('sig-bad', 500, { InstructionError: [0, 'X'] });
      await tick();

      expect(h.fetched).toHaveLength(0);
      expect(h.skipped).toHaveLength(1);
      expect(h.skipped[0]).toMatchObject({ wallet: WALLET, signature: 'sig-bad', slot: 500 });
      expect(h.skipped[0]?.err).not.toBeNull();
      expect(h.swaps).toHaveLength(0);
    } finally {
      h.stream.stop();
      h.cursors.close();
    }
  });

  it('leaves a successful notification completely unchanged', async () => {
    const history = entries(1);
    const h = rig(history);
    try {
      await h.stream.start();
      h.socket.deliver('sig-1', 101);
      await tick();

      expect(h.skipped).toHaveLength(0);
      expect(h.fetched).toContain('sig-1');
    } finally {
      h.stream.stop();
      h.cursors.close();
    }
  });

  it('skips a failed gap-fill entry identically, and still advances the cursor', async () => {
    // Filtering live only would defer the cost, not remove it: a signature
    // skipped at the socket is not in `seen` after a restart, so gap fill would
    // re-offer it and pay the 194ms then instead.
    const history: SignatureEntry[] = [
      { signature: 'sig-3', slot: 103, err: null, transactionIndex: 0 },
      { signature: 'sig-2', slot: 102, err: { Err: 1 }, transactionIndex: 0 },
      { signature: 'sig-1', slot: 101, err: null, transactionIndex: 0 },
    ];
    const h = rig(history);
    try {
      await h.stream.start();

      expect(h.fetched).not.toContain('sig-2');
      expect(h.skipped.map((e) => e.signature)).toEqual(['sig-2']);
      expect(h.skipped[0]?.source).toBe('gapfill');
      // Reserved like any other position, so the cursor walks over it in order
      // rather than leaving a hole a later write steps past silently.
      expect(h.cursors.get(WALLET)?.lastSignature).toBe('sig-3');
    } finally {
      h.stream.stop();
      h.cursors.close();
    }
  });

  it('does not shed a queued successful notification behind a burst of failures', async () => {
    // The eviction case, asserted directly. The queue is global and sheds
    // OLDEST first, so before this change a flood of failures pushed real swaps
    // out of it — measured at up to 42.6% of one wallet's traffic.
    const history = entries(1);
    const h = rig(history);
    try {
      await h.stream.start();
      h.socket.deliver('sig-1', 101);
      for (let i = 0; i < MAX_IN_FLIGHT * 5; i += 1) {
        h.socket.deliverFailed(`bad-${i}`, 600 + i, { Err: i });
      }
      await tick(20);

      expect(h.skipped).toHaveLength(MAX_IN_FLIGHT * 5);
      // The one that mattered survived and was fetched.
      expect(h.fetched).toContain('sig-1');
    } finally {
      h.stream.stop();
      h.cursors.close();
    }
  });
});
