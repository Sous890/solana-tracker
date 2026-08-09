/**
 * Task 3 — kill the socket at chosen points and assert the stream recovers.
 *
 * The deterministic version of what a soak samples by luck. Every case asserts
 * the same four things, and "no exception was thrown" is not among them:
 *
 *   1. a live socket exists
 *   2. subscriptions are re-established, one per wallet, on THAT socket
 *   3. the cursor names a position whose predecessors are all handled
 *   4. no entry is absent after recovery
 *
 * This is regression protection for 6644c45 (the cursor barrier) and 6ae46b0
 * (the lost wakeup), neither of which has run outside a unit test.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TrackedSwap } from '../src/core/types.js';
import { WalletStream } from '../src/adapters/walletStream.js';
import type { RpcClient, SignatureEntry, StreamSocket } from '../src/adapters/walletStream.js';
import type { ParsedTransactionWithMeta } from '../src/adapters/swapParser.js';
import { openCursorStore } from '../src/db/cursors.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const capture = JSON.parse(
  readFileSync(join(resolve(HERE, 'fixtures/transactions'), 'raydium-v4-buy.json'), 'utf8'),
) as { wallet: string; tx: ParsedTransactionWithMeta };
const WALLET = capture.wallet;

function txFor(signature: string, slot: number): ParsedTransactionWithMeta {
  const tx = structuredClone(capture.tx);
  tx.slot = slot;
  tx.transaction.signatures = [signature];
  return tx;
}

/** Newest first, as the RPC returns them. sig-N has the highest slot. */
function entries(count: number, startSlot = 100): SignatureEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    signature: `sig-${count - i}`,
    slot: startSlot + (count - i),
    err: null,
    transactionIndex: 0,
  }));
}

const tick = async (times = 12): Promise<void> => {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
};

interface SocketProbe {
  socket: StreamSocket;
  /** wallet -> subscription id the server issued on THIS socket. */
  subscribed: Map<string, number>;
  closed: boolean;
  kill(): void;
}

/**
 * A socket that speaks the subscribe protocol and can be killed on command.
 *
 * `killOnSubscribe` closes the socket when the Nth subscribe arrives, BEFORE
 * replying — the window between `connectOnce` succeeding and subscriptions
 * being established, which is otherwise not reachable from outside.
 */
function probeSocket(firstId: number, killOnSubscribe?: number): SocketProbe {
  let onMessage: (data: string) => void = () => undefined;
  let onClose: () => void = () => undefined;
  let onError: (error: Error) => void = () => undefined;
  const subscribed = new Map<string, number>();
  let nextId = firstId;
  let subscribes = 0;

  const probe: SocketProbe = {
    subscribed,
    closed: false,
    kill() {
      if (probe.closed) return;
      probe.closed = true;
      // A real WebSocket fires error then close for one death. Both reach the
      // stream; the digest collapses them and `onDisconnect` claims only once.
      onError(new Error('websocket error'));
      onClose();
    },
    socket: {
      send: (payload) => {
        const request = JSON.parse(payload) as {
          id?: number;
          method?: string;
          params?: [{ mentions?: string[] }, unknown];
        };
        if (request.method !== 'logsSubscribe') return;
        subscribes += 1;
        if (killOnSubscribe !== undefined && subscribes === killOnSubscribe) {
          probe.kill();
          return;
        }
        if (probe.closed) return;
        const wallet = request.params?.[0]?.mentions?.[0];
        if (wallet === undefined || request.id === undefined) return;
        const id = nextId++;
        subscribed.set(wallet, id);
        onMessage(JSON.stringify({ jsonrpc: '2.0', result: id, id: request.id }));
      },
      close: () => probe.kill(),
      onMessage: (h) => {
        onMessage = h;
      },
      onClose: (h) => {
        onClose = h;
      },
      onError: (h) => {
        onError = h;
      },
    },
  };
  return probe;
}

interface Rig {
  stream: WalletStream;
  cursors: ReturnType<typeof openCursorStore>;
  sockets: SocketProbe[];
  swaps: TrackedSwap[];
  history: SignatureEntry[];
  wallets: string[];
  hold(signature: string): void;
  release(signature: string): void;
  close(): void;
}

function rig(options: {
  wallets?: string[];
  history?: SignatureEntry[];
  killOnSubscribe?: (index: number) => number | undefined;
  failConnects?: number;
}): Rig {
  const wallets = options.wallets ?? [WALLET];
  const history = options.history ?? [];
  const sockets: SocketProbe[] = [];
  const swaps: TrackedSwap[] = [];
  const gates = new Map<string, { wait: Promise<void>; open: () => void }>();
  let connects = 0;

  const cursors = openCursorStore({ path: ':memory:' });
  const rpc: RpcClient = {
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
      const gate = gates.get(signature);
      if (gate !== undefined) await gate.wait;
      const entry = history.find((e) => e.signature === signature);
      return entry === undefined ? null : txFor(signature, entry.slot);
    },
  };

  const stream = new WalletStream({
    wallets,
    rpc,
    cursors,
    connect: async () => {
      connects += 1;
      if (options.failConnects !== undefined && connects <= options.failConnects) {
        throw new Error('WebSocket connect failed: errored before opening');
      }
      const probe = probeSocket(1_000 * connects, options.killOnSubscribe?.(sockets.length));
      sockets.push(probe);
      return probe.socket;
    },
    now: () => 1_700_000_000_000,
    sleep: async () => undefined,
    random: () => 0,
  });
  stream.on('swap', (swap: TrackedSwap) => swaps.push(swap));
  stream.on('error', () => undefined);

  return {
    stream,
    cursors,
    sockets,
    swaps,
    history,
    wallets,
    hold(signature) {
      let open!: () => void;
      const wait = new Promise<void>((resolve) => {
        open = resolve;
      });
      gates.set(signature, { wait, open });
    },
    release(signature) {
      gates.get(signature)?.open();
      gates.delete(signature);
    },
    close() {
      stream.stop();
      cursors.close();
    },
  };
}

/**
 * The four assertions, applied identically to every injection.
 *
 * `aboveSlot` is where the wallet already stood when the run began: entries at
 * or below it were delivered by an earlier run and are correctly never
 * re-emitted, so asserting on them would be asserting that the cursor does not
 * work.
 *
 * `swapsFor` is which wallets the fixture transaction actually names. The
 * capture is one real raydium-v4 buy, so a second tracked wallet parses
 * `WALLET_NOT_IN_TX` and emits nothing — correctly. Only wallets that can
 * produce a swap are held to "no entry absent".
 */
function expectRecovered(
  r: Rig,
  options: { aboveSlot?: number; swapsFor?: string[] } = {},
): void {
  const aboveSlot = options.aboveSlot ?? 0;
  const swapsFor = options.swapsFor ?? [WALLET];
  const live = r.sockets.at(-1);
  // 1. a live socket exists
  expect(live, 'no socket at all after recovery').toBeDefined();
  expect(live!.closed, 'newest socket is closed — the stream is dead').toBe(false);

  // 2. subscriptions re-established on THAT socket, one per wallet
  expect([...live!.subscribed.keys()].sort()).toEqual([...r.wallets].sort());

  for (const wallet of swapsFor) {
    const cursor = r.cursors.get(wallet);
    const emitted = new Set(r.swaps.filter((s) => s.wallet === wallet).map((s) => s.signature));
    const expected = r.history.filter((e) => e.slot > aboveSlot);

    // 4. no entry absent after recovery
    for (const entry of expected) {
      expect(emitted.has(entry.signature), `${entry.signature} absent after recovery`).toBe(true);
    }

    // 3. the cursor names a position whose predecessors are all handled
    if (cursor !== undefined) {
      for (const entry of expected) {
        if (entry.slot <= cursor.lastSlot) {
          expect(
            emitted.has(entry.signature),
            `cursor at slot ${cursor.lastSlot} names a position past unhandled ${entry.signature}`,
          ).toBe(true);
        }
      }
    }
  }
}

describe('socket death injection', () => {
  it('recovers from a death during the post-reconnect gap fill', async () => {
    // The lost wakeup fixed in 6ae46b0: the chain in flight has already
    // connected, so it can never re-establish the socket that just died.
    const full = entries(6);
    const r = rig({ history: [full.at(-1)!] });
    try {
      r.cursors.set(WALLET, 'sig-1', 101);
      await r.stream.start();

      r.history.length = 0;
      r.history.push(...full);
      r.hold('sig-3');

      r.sockets[0]!.kill();
      await tick();
      expect(r.sockets).toHaveLength(2);

      r.sockets[1]!.kill(); // dies mid gap fill
      await tick();
      r.release('sig-3');
      await tick(30);

      // sig-1 was already the cursor when this run began.
      expectRecovered(r, { aboveSlot: 101 });
    } finally {
      r.close();
    }
  });

  it('recovers when the first connect fails after the startup gap fill', async () => {
    // A socket death during `start()`'s gap fill is NOT representable, and that
    // is a property of the code rather than a gap in the harness: `start()` gap
    // fills before it connects, so there is no socket to kill. What can fail in
    // that window is the connect that follows, which lands on the reconnect
    // chain with the startup fill already durable.
    const full = entries(5);
    const r = rig({ history: full, failConnects: 3 });
    try {
      await r.stream.start();
      await tick(40);
      expectRecovered(r);
      // The startup fill completed before any of that, and stayed.
      expect(r.cursors.get(WALLET)?.lastSignature).toBe('sig-5');
    } finally {
      r.close();
    }
  });

  it('recovers from a death between connecting and subscribing', async () => {
    // Killed on the first subscribe, before the server replies — so the socket
    // is up, `connectOnce` has returned true, and no subscription exists.
    const full = entries(4);
    const r = rig({ history: full, killOnSubscribe: (index) => (index === 0 ? 1 : undefined) });
    try {
      await r.stream.start();
      await tick(40);
      expectRecovered(r);
    } finally {
      r.close();
    }
  });

  it('recovers from three deaths in a row', async () => {
    const full = entries(5);
    const r = rig({ history: full });
    try {
      await r.stream.start();
      for (let i = 0; i < 3; i += 1) {
        r.sockets.at(-1)!.kill();
        await tick(20);
      }
      await tick(30);
      expect(r.sockets.length).toBeGreaterThanOrEqual(4);
      expectRecovered(r);
    } finally {
      r.close();
    }
  });

  it('recovers across multiple wallets, and holds every cursor', async () => {
    const other = 'HSsJjkHrxezZ1SdhgdivhDGXbxANicWbKvKsVtrMrJvG';
    const third = 'AgiGpUAF25B7NL9u8byDcptPcYWi4eFU4kjtcRtaMmdQ';
    const full = entries(4);
    const r = rig({ wallets: [WALLET, other, third], history: full });
    try {
      await r.stream.start();
      r.sockets[0]!.kill();
      await tick(30);
      expectRecovered(r);
    } finally {
      r.close();
    }
  });

  // A single wallet's subscription dying while the others stay live is NOT
  // representable, and not because the harness is too weak: `StreamSocket`
  // carries every subscription on one connection, and the stream tears down the
  // whole socket on any error. The server could in principle reply with an
  // error for one `logsSubscribe`, which would leave that wallet unsubscribed
  // while the rest work — that is a real hole, but closing it means a
  // per-subscription health check that does not exist yet, and inventing a
  // failure the transport cannot deliver would be testing the fake.
});

describe('the barrier precondition', () => {
  it('throws when a second wallet loop takes a hold that is already held', () => {
    const cursors = openCursorStore({ path: ':memory:' });
    try {
      cursors.hold(WALLET);
      // The round-robin change is the obvious thing to do this by accident.
      expect(() => cursors.hold(WALLET)).toThrow(/already held/);
      cursors.release(WALLET);
      expect(() => cursors.hold(WALLET)).not.toThrow();
    } finally {
      cursors.close();
    }
  });

  it('throws when narrowing a hold nobody took', () => {
    const cursors = openCursorStore({ path: ':memory:' });
    try {
      expect(() => cursors.reserve(WALLET, [101, 102])).toThrow(/not held/);
    } finally {
      cursors.close();
    }
  });

  it('bounds deferred positions and reports the peak', () => {
    const cursors = openCursorStore({ path: ':memory:' });
    try {
      cursors.hold(WALLET);
      // One outstanding position below everything else pins the barrier, so
      // every completed position above it defers.
      cursors.reserve(WALLET, [1]);
      for (let slot = 2; slot <= 5_000; slot += 1) cursors.set(WALLET, `sig-${slot}`, slot);

      const stats = cursors.barrierStats();
      expect(stats.peakDeferred).toBeLessThanOrEqual(4_096);
      expect(stats.peakDeferred).toBeGreaterThan(4_000);
      // Nothing persisted: slot 1 is still outstanding, so nothing above it is
      // eligible. The cursor staying put is the safe direction.
      expect(cursors.get(WALLET)).toBeUndefined();

      // Once the predecessor lands, the newest surviving position persists.
      cursors.set(WALLET, 'sig-1', 1);
      cursors.release(WALLET);
      expect(cursors.get(WALLET)?.lastSlot).toBe(5_000);
    } finally {
      cursors.close();
    }
  });
});

describe('barrier cost at soak scale', () => {
  it('stays linear as the reservation grows', () => {
    // The 2026-08-09 soak reserved 77,236 slots for one wallet. With
    // `Math.min(...outstanding)` on every completion that cost 1.611ms each —
    // quadratic, ~124s of CPU to drain one wallet — against 0.012ms at 1,000.
    // A pointer over the sorted reservation makes it flat.
    const cost = (n: number): number => {
      const cursors = openCursorStore({ path: ':memory:' });
      try {
        cursors.hold(WALLET);
        cursors.reserve(WALLET, Array.from({ length: n }, (_, i) => i + 1));
        const iterations = 2_000;
        const started = process.hrtime.bigint();
        for (let i = 1; i <= iterations; i += 1) cursors.set(WALLET, `sig-${i}`, i);
        return Number(process.hrtime.bigint() - started) / 1e6 / iterations;
      } finally {
        cursors.close();
      }
    };

    const small = cost(2_000);
    const large = cost(80_000);
    // 40x the reservation must not cost meaningfully more per completion. The
    // bound is loose because this is a timing test on a shared machine; the
    // regression it guards against was 130x, not 5x.
    expect(large).toBeLessThan(Math.max(small, 0.01) * 5);
  });
});
