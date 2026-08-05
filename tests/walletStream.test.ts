import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TrackedSwap } from '../src/core/types.js';
import {
  MAX_COLD_FILL,
  MAX_IN_FLIGHT,
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

function fakeSocket() {
  const sent: string[] = [];
  let onMessage: (data: string) => void = () => undefined;
  let onClose: () => void = () => undefined;

  const socket: StreamSocket = {
    send: (payload) => sent.push(payload),
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
    deliver: (signature: string, slot: number) =>
      onMessage(
        JSON.stringify({
          params: { result: { context: { slot }, value: { signature, err: null } } },
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
