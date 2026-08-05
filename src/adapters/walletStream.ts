/**
 * Live wallet stream: `logsSubscribe` over websocket, with gap fill.
 *
 * Emits `swap` | `unparsed` | `gap-filled` | `disconnected` | `reconnected` |
 * `error`.
 *
 * **Everything here is provisional.** The subscription runs at `confirmed`
 * commitment, which is reorg-exposed: a swap emitted at `confirmed` can be
 * rolled back, and this module will not retract it. That is an accepted
 * trade — waiting for `finalized` costs ~13 seconds, which is an eternity for
 * a copy-trading signal. The ledger is the authority on what the bot actually
 * holds; a `swap` event is a hint about someone else's wallet, never a record
 * of our own position.
 *
 * Transport, clock and sleep are injected so the whole thing is testable
 * without a network or real time.
 */

import { EventEmitter } from 'node:events';
import type { Address, Signature, SwapSource, UnixMillis } from '../core/types.js';
import type { CursorStore } from '../db/cursors.js';
import { parseSwap } from './swapParser.js';
import type { ParsedTransactionWithMeta, ParseResult } from './swapParser.js';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface SignatureEntry {
  signature: string;
  slot: number;
  err: unknown | null;
  blockTime?: number | null;
  /** Position within the block. Present on modern RPCs; used for ordering. */
  transactionIndex?: number | null;
}

/** The JSON-RPC calls this module needs. Implemented over HTTP in production. */
export interface RpcClient {
  getSignaturesForAddress(
    address: Address,
    options: { until?: Signature; before?: Signature; limit: number },
  ): Promise<SignatureEntry[]>;
  getTransaction(signature: Signature): Promise<ParsedTransactionWithMeta | null>;
}

/** A websocket, narrowed to what is used. */
export interface StreamSocket {
  send(payload: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (error: Error) => void): void;
}

export interface WalletStreamDeps {
  wallets: Address[];
  rpc: RpcClient;
  cursors: CursorStore;
  connect: () => Promise<StreamSocket>;
  now?: () => UnixMillis;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const SILENCE_TIMEOUT_MS = 90_000;
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
/** Bound on history replayed when the cursor is unusable. */
export const MAX_COLD_FILL = 100;
export const SEEN_CAPACITY = 5_000;
export const MAX_IN_FLIGHT = 20;

// ---------------------------------------------------------------------------
// Bounded seen-set
// ---------------------------------------------------------------------------

/**
 * Insertion-ordered set capped at `capacity`.
 *
 * A signature arrives from both the socket and the gap fill routinely; the
 * consumer must see it once. `Map` iterates in insertion order, so the oldest
 * key is the first one.
 */
export class SeenSignatures {
  private readonly entries = new Map<string, true>();

  constructor(private readonly capacity: number = SEEN_CAPACITY) {}

  /** True if this signature is new. Marks it seen as a side effect. */
  admit(signature: string): boolean {
    if (this.entries.has(signature)) return false;
    this.entries.set(signature, true);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return true;
  }

  get size(): number {
    return this.entries.size;
  }
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Oldest first, by slot then position within the block.
 *
 * `blockTime` is deliberately not used: it is nullable and not monotonic
 * across slots, so ordering on it reorders real events.
 */
export function orderOldestFirst(entries: SignatureEntry[]): SignatureEntry[] {
  return [...entries].sort((a, b) => {
    if (a.slot !== b.slot) return a.slot - b.slot;
    return (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0);
  });
}

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

export interface GapFilledEvent {
  wallet: Address;
  count: number;
  /** True when the cursor was unusable and history was capped at MAX_COLD_FILL. */
  truncated: boolean;
}

export class WalletStream extends EventEmitter {
  private readonly deps: Required<Pick<WalletStreamDeps, 'now' | 'sleep' | 'random'>> &
    WalletStreamDeps;

  private readonly seen = new SeenSignatures();
  private readonly queue: Array<{ wallet: Address; entry: SignatureEntry; source: SwapSource }> = [];
  private socket: StreamSocket | undefined;
  private running = false;
  private draining = false;
  private attempt = 0;
  private lastMessageAt = 0;
  private missedHeartbeats = 0;
  private nextRequestId = 1;

  constructor(deps: WalletStreamDeps) {
    super();
    this.deps = {
      ...deps,
      now: deps.now ?? (() => Date.now()),
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      random: deps.random ?? Math.random,
    };
  }

  // -- lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    this.running = true;
    // Gap fill on startup as well as on reconnect: the process may have been
    // down for any length of time, and the cursor is the only record of that.
    for (const wallet of this.deps.wallets) await this.gapFill(wallet);
    await this.connect();
  }

  stop(): void {
    this.running = false;
    this.socket?.close();
    this.socket = undefined;
  }

  private async connect(): Promise<void> {
    try {
      const socket = await this.deps.connect();
      this.socket = socket;
      this.attempt = 0;
      this.lastMessageAt = this.deps.now();
      this.missedHeartbeats = 0;

      socket.onMessage((data) => this.onMessage(data));
      socket.onClose(() => this.onDisconnect('closed'));
      socket.onError((error) => {
        this.emit('error', error);
        this.onDisconnect(error.message);
      });

      for (const wallet of this.deps.wallets) {
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: this.nextRequestId++,
            method: 'logsSubscribe',
            params: [{ mentions: [wallet] }, { commitment: 'confirmed' }],
          }),
        );
      }
    } catch (error) {
      this.emit('error', error as Error);
      this.onDisconnect((error as Error).message);
    }
  }

  private onDisconnect(reason: string): void {
    this.socket = undefined;
    this.emit('disconnected', { reason });
    if (this.running) void this.reconnect();
  }

  /** Full jitter over an exponential base, uncapped in attempts. */
  private backoffMs(): number {
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt);
    return Math.floor(this.deps.random() * ceiling);
  }

  private async reconnect(): Promise<void> {
    this.attempt += 1;
    await this.deps.sleep(this.backoffMs());
    if (!this.running) return;

    await this.connect();
    if (this.socket === undefined) return;

    // Anything that happened while the socket was down is only recoverable
    // through the cursor.
    for (const wallet of this.deps.wallets) await this.gapFill(wallet);
    this.emit('reconnected', { attempt: this.attempt });
  }

  // -- heartbeat ------------------------------------------------------------

  /**
   * Drive liveness. Call on an interval; returns true when a teardown was
   * triggered. Exposed rather than owning a timer so tests can step it.
   */
  heartbeat(healthy: boolean): boolean {
    this.missedHeartbeats = healthy ? 0 : this.missedHeartbeats + 1;
    const silentFor = this.deps.now() - this.lastMessageAt;

    if (this.missedHeartbeats >= 2 || silentFor >= SILENCE_TIMEOUT_MS) {
      this.socket?.close();
      this.onDisconnect(
        this.missedHeartbeats >= 2 ? 'two heartbeats missed' : `silent for ${silentFor}ms`,
      );
      return true;
    }
    return false;
  }

  // -- ingest ---------------------------------------------------------------

  private onMessage(data: string): void {
    this.lastMessageAt = this.deps.now();

    let payload: any;
    try {
      payload = JSON.parse(data);
    } catch {
      this.emit('error', new Error('unparseable socket frame'));
      return;
    }

    const value = payload?.params?.result?.value;
    if (value?.signature === undefined) return;
    // A log notification carrying an error is a failed transaction; it still
    // goes through the parser so it surfaces as TX_FAILED rather than vanishing.
    const slot = payload.params.result.context?.slot ?? 0;

    for (const wallet of this.deps.wallets) {
      this.enqueue(wallet, { signature: value.signature, slot, err: value.err ?? null }, 'live');
    }
  }

  /**
   * Bounded queue. On overflow the OLDEST pending entry is dropped: a stale
   * swap signal is worthless, and an unbounded queue during a burst turns into
   * a memory problem and a growing lag that never recovers.
   */
  private enqueue(wallet: Address, entry: SignatureEntry, source: SwapSource): void {
    this.queue.push({ wallet, entry, source });
    if (this.queue.length > MAX_IN_FLIGHT) {
      const dropped = this.queue.length - MAX_IN_FLIGHT;
      this.queue.splice(0, dropped);
      this.emit('error', Object.assign(new Error('fetch queue overflow'), { dropped }));
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        if (next === undefined) break;
        await this.handle(next.wallet, next.entry, next.source);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Fetch, parse, emit, then advance the cursor. In that order.
   *
   * `source` is passed rather than inferred because this method is the single
   * point both delivery paths converge on — the live socket via `drain`, and
   * `gapFill` — and by the time a signature reaches here nothing about it
   * records which one brought it. This is the only place in the system that
   * still knows, so it is the only place that can say.
   */
  private async handle(
    wallet: Address,
    entry: SignatureEntry,
    source: SwapSource,
  ): Promise<void> {
    if (!this.seen.admit(entry.signature)) return;

    let tx: ParsedTransactionWithMeta | null;
    try {
      tx = await this.deps.rpc.getTransaction(entry.signature);
    } catch (error) {
      this.emit('error', error as Error);
      return;
    }
    if (tx === null) return;

    // Stamped here, after the fetch, so `observedAt` is when this process
    // actually had the transaction in hand — not when the signature was queued.
    // Under a backed-up drain those differ by exactly the lag that makes a
    // "live" swap stale, which is the thing the freshness gate must be able to
    // see.
    const result: ParseResult = parseSwap(tx, wallet, {
      source,
      observedAt: this.deps.now(),
    });
    if (result.kind === 'swap') {
      this.emit('swap', result.swap, {
        solAmountPath: result.solAmountPath,
        pathDisagreement: result.pathDisagreement,
      });
    } else {
      this.emit('unparsed', result);
    }

    // Only now. The cursor means "delivered", so a crash before this point
    // re-delivers rather than skipping.
    this.deps.cursors.set(wallet, entry.signature, tx.slot, this.deps.now());
  }

  // -- gap fill -------------------------------------------------------------

  /**
   * Replay everything missed since the cursor.
   *
   * `until` is the anchor, not `before`: `until` walks backwards from the tip
   * and stops when it reaches the known signature, which is "everything newer
   * than what we have". `before` would page backwards *from* it into history
   * already seen.
   */
  private async gapFill(wallet: Address): Promise<void> {
    const cursor = this.deps.cursors.get(wallet);
    const collected: SignatureEntry[] = [];
    let truncated = false;
    let before: Signature | undefined;

    try {
      for (;;) {
        const page = await this.deps.rpc.getSignaturesForAddress(wallet, {
          limit: 1_000,
          ...(cursor === undefined ? {} : { until: cursor.lastSignature }),
          ...(before === undefined ? {} : { before }),
        });

        collected.push(...page);

        // A short or empty page means the tip has been reached.
        if (page.length === 0 || page.length < 1_000) break;

        // No cursor, or one the RPC no longer holds: never replay unbounded
        // history into a live strategy.
        if (cursor === undefined && collected.length >= MAX_COLD_FILL) {
          truncated = true;
          break;
        }

        before = page[page.length - 1]?.signature;
        if (before === undefined) break;
      }
    } catch (error) {
      this.emit('error', error as Error);
      return;
    }

    let entries = orderOldestFirst(collected);
    if (cursor === undefined && entries.length > MAX_COLD_FILL) {
      // Keep the newest MAX_COLD_FILL, still oldest-first among those.
      entries = entries.slice(-MAX_COLD_FILL);
      truncated = true;
    }

    for (const entry of entries) await this.handle(wallet, entry, 'gapfill');

    const event: GapFilledEvent = { wallet, count: entries.length, truncated };
    this.emit('gap-filled', event);
  }
}
