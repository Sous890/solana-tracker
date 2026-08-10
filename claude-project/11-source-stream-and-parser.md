# Source — the feed

> Generated from commit `804724b` (fix: two defects the soak found, one of them introduced by the barrier) on 2026-08-10.
> Regenerate with `npx tsx scripts/bundle-for-claude.ts`. Do not edit by hand.

How swaps get from the chain into the system. `walletStream.ts` owns the socket, the gap fill, the reconnect chain and the dedupe; `swapParser.ts` turns a transaction into a swap or a reason code.

## Files in this bundle

- `src/adapters/walletStream.ts`
- `src/adapters/swapParser.ts`

---

## `src/adapters/walletStream.ts`

```typescript
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
/**
 * How long a connected socket may deliver nothing before it is torn down.
 *
 * ── DERIVED IN SESSION 24, FROM DATA THAT HAD TO BE CLEANED FIRST ─────────
 *
 * Session 23 reported the largest healthy gap between live socket deliveries as
 * **4.5 minutes** and this value was never exercised at all, because nothing
 * called `heartbeat()`. Both numbers were wrong in the same direction.
 *
 * That 4.5 minutes was an artifact: the host slept for **84.9 of that soak's
 * 113.9 minutes**, and the long gaps were the machine, not the feed. Excluding
 * every gap that overlaps a `pmset` sleep window, the true distribution over 356
 * samples is **p50 2.6s, p90 14.8s, p99 29.7s, max 57.5s**.
 *
 * 180s is ~3.1x the worst genuinely-healthy gap. The old 90s is only 1.57x it,
 * and the failure that margin protects against is not a missed teardown but a
 * **reconnect storm**: on a quiet market a too-tight timeout tears down, gap
 * fills, finds nothing, goes silent, and tears down again — 13 wallets' worth of
 * `getSignaturesForAddress` every 90 seconds, against a provider that
 * rate-limits at ~10 rps.
 *
 * Raised rather than left at 90s because this is the moment the constant stops
 * being dead code and starts having consequences; it is chosen from measurement,
 * not relaxed to make anything pass. The asymmetry still favours detecting: a
 * spurious teardown costs one gap fill, and the cursor guarantees nothing is
 * lost by it.
 */
export const SILENCE_TIMEOUT_MS = 180_000;
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
/** Bound on history replayed when the cursor is unusable. */
export const MAX_COLD_FILL = 100;
/**
 * Entries retained by the seen set, which is keyed on `(wallet, signature)`.
 *
 * ── RE-DERIVED IN SESSION 23, AND THE OLD ARITHMETIC WAS WRONG ────────────
 *
 * Handoff 22 reasoned that a per-wallet key shrinks the effective dedupe window
 * by up to 13× — 5,000 slots over 13 wallets, "roughly 385 signatures per
 * wallet" — and left the change undone until that was settled. That figure is a
 * fan-out artifact, not a property of per-wallet keying.
 *
 * A notification is routed to **exactly one** wallet (handoff 22), so one
 * delivery consumes one slot whichever way the set is keyed. A signature only
 * consumes k slots when the transaction genuinely names k tracked wallets and
 * each is delivered separately. Measured over both post-routing-fix sessions —
 * 2,788 `fetch-window` records, which carry `(wallet, signature)` — the ratio of
 * distinct pairs to distinct signatures is **1.0000**, and the busiest single
 * run consumed **1,800** slots end to end against a cap of 5,000.
 *
 * That measurement is not independent evidence and must not be quoted as if it
 * were: the signature-only key suppressed a second wallet's delivery inside
 * `handle` *before* `fetch-window` was emitted, so a collision could not have
 * been recorded even if it happened. It bounds the multiplier at 1.0 for
 * traffic the old key admitted, which is why the count is worth taking with the
 * re-keyed build rather than assumed settled.
 *
 * Unchanged at 5,000, and kept as ONE GLOBAL LRU rather than a per-wallet bound.
 * A fixed 5,000/13 = 385 per wallet would be strictly worse than the status quo:
 * the busiest wallet alone consumed 581 slots in a 13-minute run and would
 * evict its own entries mid-run while quiet wallets sat near zero. A global LRU
 * spends capacity where the traffic actually is, and its failure mode under
 * eviction is a duplicate emit — caught downstream by guard gate 6 — rather than
 * a lost swap.
 */
export const SEEN_CAPACITY = 5_000;
export const MAX_IN_FLIGHT = 20;

/**
 * The seen set's key. One transaction can legitimately belong to two tracked
 * wallets, so the signature alone does not identify an observation.
 *
 * `|` is safe as a separator: both halves are base58, which has no `|`.
 */
export function seenKey(wallet: Address, signature: string): string {
  return `${wallet}|${signature}`;
}

/**
 * Attempts at `getTransaction` before a signature is given up on for now.
 *
 * `getTransaction` answers `null` for a signature the socket has only just
 * announced: the cluster knows it, the queried node does not yet. That was
 * handled as a bare `return` until session 21, and it cost roughly 965 swaps —
 * 34.2% of swap-like traffic — because the signature had already been admitted
 * to the seen-set, so gap fill could never bring it back. See handoff 20.
 *
 * Three, not more. The retry budget has to stay far inside `maxSignalAgeMs`
 * (15s), or a signal gets resurrected past the point where acting on it is a
 * different strategy than the one anybody chose. `STALE_SIGNAL` firing is the
 * correct outcome for a genuinely slow signature, not something to engineer
 * around. Retries are also strictly serial — `drain` awaits each `handle` — so
 * this widens latency, never concurrency, and cannot amplify into Helius's
 * ~10 rps ceiling.
 */
export const FETCH_ATTEMPTS = 3;
/** Backoff base: waits 150ms then 300ms. Under half a second added, worst case. */
export const FETCH_RETRY_BASE_MS = 150;

// ---------------------------------------------------------------------------
// Bounded seen-set
// ---------------------------------------------------------------------------

/**
 * Insertion-ordered set capped at `capacity`.
 *
 * A signature arrives from both the socket and the gap fill routinely; the
 * consumer must see it once. `Map` iterates in insertion order, so the oldest
 * key is the first one.
 *
 * Deliberately still a set of opaque strings rather than of `(wallet,
 * signature)` pairs. What a key *means* is the stream's policy, not this
 * structure's — see `seenKey`. Keeping the bound generic is also what let the
 * key change without touching either of this class's own tests.
 */
export class SeenSignatures {
  private readonly entries = new Map<string, true>();

  constructor(private readonly capacity: number = SEEN_CAPACITY) {}

  /** True if this signature has already been admitted. Marks nothing. */
  has(signature: string): boolean {
    return this.entries.has(signature);
  }

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

/**
 * One signature's trip through the null window.
 *
 * This is CLAUDE.md gap 6's detection leg, which `example.py` has been guessing
 * at 1.2s. **It is a lower bound on copy delay, not the delay** — it measures
 * only "how long until the transaction was fetchable", and excludes quote,
 * guard and fill time entirely.
 */
export interface FetchWindowEvent {
  wallet: Address;
  signature: string;
  /**
   * Where on the chain this sat, so a recorded session can be ordered by
   * position rather than by the order the process happened to handle things.
   *
   * Its absence is why session 25's cursor cross-check could only ever be a
   * reconstruction: the barrier compares slots, and no recorded session carried
   * one. Taken from the signature entry rather than the fetched transaction,
   * because it must be present even when the fetch returned nothing.
   */
  slot: number;
  /** 1 means it was fetchable immediately. */
  attempts: number;
  /** From first fetch attempt to the one that returned, in ms. */
  elapsedMs: number;
  /** False when every attempt returned null — the signature stays re-deliverable. */
  resolved: boolean;
  source: SwapSource;
}

/**
 * The bounded queue shed load. Emitted alongside the `error` it has always
 * raised, not instead of it.
 *
 * Before session 21 this existed only as an `error`, and `EXCLUDED_TRACKER_EVENTS`
 * excludes `error` from recording by name — so the one number that says how much
 * of the feed was dropped never reached a session file, and the size of the hole
 * was unknowable after the fact. Recording it does not change the shedding.
 */
/**
 * A notification arrived on a subscription id this stream does not recognise.
 *
 * Emitted rather than guessed at. Until session 22 the id was discarded and the
 * notification fanned out to **every** tracked wallet, which is how a swap by
 * one wallet came to be attributed to another and then deduped out of existence
 * — see handoff 21. Anything that cannot be attributed to exactly one wallet is
 * now a reported event, because the alternative to knowing whose it is has been
 * measured and it is worse than dropping it.
 *
 * Expected transiently around a reconnect: ids are per-connection, so a
 * notification in flight when the socket dropped can land after resubscribe. A
 * steady stream of these means the map is wrong.
 */
export interface UnknownSubscriptionEvent {
  subscription: number | null;
  signature: string;
}

export interface QueueOverflowEvent {
  /**
   * The wallet whose arrival pushed the queue over. **Not** the wallet that lost
   * anything.
   *
   * This field used to be called `wallet`, and every shed-by-wallet figure in
   * this repo's history was read as if it named the victim. It never did: the
   * queue is global and `splice(0, n)` removes the OLDEST entries, which belong
   * to whoever queued first. Session 23 reported "26 of 37 sheds belong to one
   * wallet" on this field — that is the wallet that was *arriving*, and the
   * conclusion drawn from it is void.
   */
  arrivingWallet: Address;
  dropped: number;
  /** Queue depth cap that was exceeded, so a session says what it was measured against. */
  capacity: number;
  /** Who actually lost entries, and how many each. The number worth reading. */
  droppedFor: Array<{ wallet: Address; count: number }>;
  /** Exactly which signatures were shed, so the loss is enumerable after the fact. */
  droppedSignatures: string[];
}

/**
 * Why the stream is not connected.
 *
 * `phase` exists because these two were indistinguishable downstream and got
 * counted as one number. A **connect-attempt** failure means no socket ever
 * existed — the reconnect loop retries with backoff capped at 30s, so a single
 * outage emits thousands of them. A **socket-death** means a socket that was
 * live is gone. Across the eleven sessions on record the split was 25,783
 * attempt failures to 95 death emissions, and the digest reported their sum.
 *
 * Discriminated by a field rather than by matching on `reason`, which is a
 * transport error message and changes with the library.
 */
export interface DisconnectedEvent {
  reason: string;
  phase: 'connect-attempt' | 'socket-death';
}

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

  /**
   * Signatures currently being fetched. Distinct from `seen`, deliberately.
   *
   * `seen` now means exactly one thing: **successfully fetched and dispatched**.
   * That is what makes "an unresolved signature must stay re-deliverable" work
   * — gap fill re-offers anything not in `seen`, and a fetch that returned
   * `null` leaves nothing behind.
   *
   * The alternative considered was admit-then-roll-back-on-failure. Rejected:
   * it makes `seen` mean "processed OR in progress OR briefly-but-no-longer
   * failed", and the eviction interaction with `SEEN_CAPACITY` becomes something
   * you have to reason about rather than read.
   *
   * This set is not an optimisation. `gapFill` awaits `handle` directly while
   * the socket path goes through `enqueue`/`drain`, so the two interleave for
   * real; without it, moving admission after the fetch would let both paths
   * fetch the same signature and emit two swaps for one trade.
   */
  private readonly inFlight = new Set<string>();

  /**
   * JSON-RPC request id -> wallet, for subscribes awaiting their answer.
   *
   * `logsSubscribe` replies `{ id, result: <subscriptionId> }`, and the reply is
   * the only place the two are ever associated. Miss it and the id is
   * unrecoverable for the life of the connection.
   */
  private readonly pendingSubscriptions = new Map<number, Address>();

  /**
   * Subscription id -> wallet. **Rebuilt from empty on every connect.**
   *
   * Ids are per-connection and the server reuses small integers, so a stale
   * entry is not merely useless — it actively misroutes: a notification in
   * flight when the socket dropped can arrive after resubscribe carrying an id
   * that now belongs to a different wallet. Clearing on connect is what makes
   * `unknown-subscription` mean "cannot attribute" rather than "attributed to
   * whoever happens to hold that number now".
   */
  private subscriptions = new Map<number, Address>();
  private readonly queue: Array<{ wallet: Address; entry: SignatureEntry; source: SwapSource }> = [];
  private socket: StreamSocket | undefined;
  private running = false;
  /** One reconnect loop at a time. See `beginReconnect`. */
  private reconnecting = false;
  /** A socket death that arrived while a reconnect was already in flight. */
  private reconnectRequested = false;
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
    await this.gapFillAll();
    if (!(await this.connectOnce())) this.beginReconnect();
  }

  /**
   * One pass of the wallet loop, with every wallet's cursor held for the whole
   * of it.
   *
   * The hold is taken for ALL wallets up front, not per wallet at its turn. The
   * loop is serial, so wallet 13's gap fill does not read its cursor until
   * twelve other wallets have finished — and `reconnect()` connects BEFORE it
   * calls this, so the socket is live and delivering the entire time. A live
   * delivery for wallet 13 arriving during wallet 1's fill would otherwise
   * advance 13's cursor past the window 13 is about to replay, and `until:`
   * returns only what is NEWER, so that window is skipped. No crash required.
   *
   * `start()` is not exposed to that — there is no socket yet — but it takes the
   * same hold, because the two paths differing in a property this subtle is how
   * the next person reintroduces it.
   */
  private async gapFillAll(): Promise<void> {
    const wallets = this.deps.wallets;
    try {
      // Inside the try, not before it. A blanket `hold` cannot persist and so
      // cannot throw today — but that is a fact about `flush`'s internals, and
      // the release guarantee should not depend on reading them.
      for (const wallet of wallets) this.deps.cursors.hold(wallet);
      for (const wallet of wallets) await this.gapFill(wallet);
    } finally {
      // Every hold, on every exit path: normal return, a throw out of any
      // wallet's fill, an early return. A leaked hold is invisible — swaps keep
      // emitting and the socket keeps looking healthy while the wallet's cursor
      // is frozen for the life of the process, and the damage only appears at
      // the next restart, as a replay from a cursor that stopped hours ago.
      //
      // Each release is isolated: one wallet's failure must not strand the
      // twelve behind it in the loop.
      for (const wallet of wallets) {
        try {
          this.deps.cursors.release(wallet);
        } catch (error) {
          this.emit('error', error as Error);
        }
      }
    }
  }

  stop(): void {
    this.running = false;
    this.socket?.close();
    this.socket = undefined;
  }

  /**
   * Attempt exactly one connection. Never starts a reconnect of its own.
   *
   * Splitting this out is the fix for chain multiplication. The old `connect()`
   * routed its own failure through `onDisconnect`, which started a *new*
   * reconnect while the one that had called it was still unwinding — so the
   * number of live chains was set by however many ways a connection had failed,
   * and never came back down. Retrying is now the loop in `reconnect()`, which
   * there is only ever one of.
   */
  private async connectOnce(): Promise<boolean> {
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

      // Both maps belong to the connection, not to the stream. Cleared before
      // resubscribing so an id from the previous socket can never resolve.
      this.pendingSubscriptions.clear();
      this.subscriptions = new Map<number, Address>();

      for (const wallet of this.deps.wallets) {
        const requestId = this.nextRequestId++;
        this.pendingSubscriptions.set(requestId, wallet);
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: requestId,
            method: 'logsSubscribe',
            params: [{ mentions: [wallet] }, { commitment: 'confirmed' }],
          }),
        );
      }
      return true;
    } catch (error) {
      this.emit('error', error as Error);
      this.socket = undefined;
      // Reported, because a failed attempt is as much a part of an outage's
      // shape as the disconnection that started it. It does NOT start a chain.
      this.emit('disconnected', {
        reason: (error as Error).message,
        phase: 'connect-attempt',
      } satisfies DisconnectedEvent);
      return false;
    }
  }

  /**
   * One socket death, one reconnect.
   *
   * Reached more than once per disconnection in practice: a real WebSocket fires
   * `error` and then `close`, and session 23's session file shows exactly that —
   * `websocket error` and `closed` one millisecond apart, after which reconnect
   * attempts arrived in pairs for the remaining 43 minutes. `this.socket` is the
   * flag: the first call clears it, and every later call for the same socket
   * finds it already gone and returns.
   */
  private onDisconnect(reason: string): void {
    if (this.socket === undefined) return;
    this.socket = undefined;
    this.emit('disconnected', { reason, phase: 'socket-death' } satisfies DisconnectedEvent);
    this.beginReconnect();
  }

  /**
   * Start the single reconnect loop, if one is not already running.
   *
   * A request that arrives while one IS running is remembered, not dropped.
   * Dropping it was a lost wakeup: the chain in flight may have connected
   * already and be inside its gap fill, in which case the socket that just died
   * is the one that chain established — so it will never re-establish it. The
   * loop then finished, announced `reconnected` for a socket that was gone,
   * cleared the flag and returned, leaving nothing watching and no way back.
   * The stream was dead for the rest of the process with the feed simply quiet.
   */
  private beginReconnect(): void {
    if (!this.running) return;
    if (this.reconnecting) {
      this.reconnectRequested = true;
      return;
    }
    this.reconnecting = true;
    void this.reconnect()
      .catch((error: unknown) => {
        // `gapFillAll` can throw — `emit('swap')` is synchronous and everything
        // downstream of it is somebody else's code. Unhandled here it would be
        // an unhandled rejection, which ends the process.
        this.emit('error', error as Error);
      })
      .finally(() => {
        this.reconnecting = false;
        const pending = this.reconnectRequested;
        this.reconnectRequested = false;
        if (pending && this.running && this.socket === undefined) this.beginReconnect();
      });
  }

  /** Full jitter over an exponential base, uncapped in attempts. */
  private backoffMs(): number {
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt);
    return Math.floor(this.deps.random() * ceiling);
  }

  /**
   * Retry until connected, then backfill. One of these runs at a time.
   *
   * A loop rather than recursion through `onDisconnect`, so the retry budget
   * belongs to one place and cannot fan out. The gap fill afterwards is the
   * point of the whole exercise: reconnecting without it leaves the window the
   * socket was down for permanently unobserved, and `reconnected` would be
   * reporting success for something that recovered nothing.
   */
  private async reconnect(): Promise<void> {
    for (;;) {
      this.attempt += 1;
      const attempt = this.attempt;
      await this.deps.sleep(this.backoffMs());
      if (!this.running) return;

      if (!(await this.connectOnce())) {
        if (!this.running) return;
        continue;
      }

      // Anything that happened while the socket was down is only recoverable
      // through the cursor. The socket is already live and delivering at this
      // point — see `gapFillAll`, which is what makes that safe.
      await this.gapFillAll();

      // The socket can die inside that gap fill, and on a long one it often
      // will. `reconnected` means "the feed is live again"; emitting it for a
      // socket that has already gone reports a working feed that is not there,
      // and every reconnect-latency figure measured from it is measuring the
      // wrong interval. Keep retrying instead — this chain owns the retry, so
      // it does not depend on the dropped-wakeup path above to notice.
      if (this.socket === undefined) {
        if (!this.running) return;
        continue;
      }

      this.emit('reconnected', { attempt });
      return;
    }
  }

  // -- heartbeat ------------------------------------------------------------

  /**
   * Drive liveness. Call on an interval; returns true when a teardown was
   * triggered. Exposed rather than owning a timer so tests can step it.
   */
  heartbeat(healthy: boolean): boolean {
    // Nothing connected means a reconnect is already the thing in progress, and
    // there is no socket to tear down. Without this guard the silence check
    // stays true for as long as the feed is quiet — `lastMessageAt` only moves
    // on a delivered frame — so every tick would start another reconnect and
    // they would multiply for the length of the outage.
    const socket = this.socket;
    if (socket === undefined) return false;

    this.missedHeartbeats = healthy ? 0 : this.missedHeartbeats + 1;
    const silentFor = this.deps.now() - this.lastMessageAt;

    if (this.missedHeartbeats >= 2 || silentFor >= SILENCE_TIMEOUT_MS) {
      const reason =
        this.missedHeartbeats >= 2 ? 'two heartbeats missed' : `silent for ${silentFor}ms`;
      // Announced BEFORE the raw socket is closed. Closing it first would fire
      // `onClose`, which reports `closed` and claims the disconnection, and the
      // real reason — the one naming why anybody intervened — would be lost.
      this.onDisconnect(reason);
      try {
        socket.close();
      } catch {
        // Already closing. The teardown has happened either way.
      }
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

    // A subscribe confirmation: `{ id, result: <subscriptionId> }`. This is the
    // only message that ever associates a wallet with an id, so it is handled
    // before anything else and never treated as a notification.
    if (typeof payload?.result === 'number' && typeof payload?.id === 'number') {
      const wallet = this.pendingSubscriptions.get(payload.id);
      if (wallet !== undefined) {
        this.pendingSubscriptions.delete(payload.id);
        this.subscriptions.set(payload.result, wallet);
      }
      return;
    }

    const value = payload?.params?.result?.value;
    if (value?.signature === undefined) return;
    // A log notification carrying an error is a failed transaction; it still
    // goes through the parser so it surfaces as TX_FAILED rather than vanishing.
    const slot = payload.params.result.context?.slot ?? 0;

    // Routed to exactly one wallet, by the id the server stamped on it.
    //
    // This used to be a loop over `this.deps.wallets`, which turned one
    // notification into thirteen queue entries — twelve of them for wallets that
    // had nothing to do with the transaction. The bounded queue then shed from
    // the front, so the last wallet in the list survived to fetch, was not in
    // the transaction, and was admitted to the seen set anyway, deduping out the
    // wallet that actually traded. Handoff 21 has the measurement.
    const subscription = payload?.params?.subscription;
    const wallet =
      typeof subscription === 'number' ? this.subscriptions.get(subscription) : undefined;

    if (wallet === undefined) {
      this.emit('unknown-subscription', {
        subscription: typeof subscription === 'number' ? subscription : null,
        signature: value.signature,
      } satisfies UnknownSubscriptionEvent);
      return;
    }

    this.enqueue(wallet, { signature: value.signature, slot, err: value.err ?? null }, 'live');
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
      // `splice` returns what it removed, which is the only place the identity
      // of the loss exists. Discarding it and reporting the arriving wallet
      // instead is what made every historical shed-by-wallet number wrong.
      const removed = this.queue.splice(0, dropped);
      const counts = new Map<Address, number>();
      for (const item of removed) counts.set(item.wallet, (counts.get(item.wallet) ?? 0) + 1);

      this.emit('error', Object.assign(new Error('fetch queue overflow'), { dropped }));
      // Also as its own event, because `error` is excluded from recording by
      // name and this is the only measurement of how much feed was shed.
      this.emit('queue-overflow', {
        arrivingWallet: wallet,
        dropped,
        capacity: MAX_IN_FLIGHT,
        droppedFor: [...counts].map(([victim, count]) => ({ wallet: victim, count })),
        droppedSignatures: removed.map((item) => item.entry.signature),
      } satisfies QueueOverflowEvent);
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
    // Both sets are keyed on the PAIR. One transaction can genuinely belong to
    // two tracked wallets — the trader and the counterparty — and a
    // signature-only key deduped the second away before it was ever fetched.
    const key = seenKey(wallet, entry.signature);
    if (this.seen.has(key)) return;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);

    try {
      const startedAt = this.deps.now();
      let tx: ParsedTransactionWithMeta | null = null;
      let attempts = 0;

      while (attempts < FETCH_ATTEMPTS) {
        attempts += 1;
        try {
          tx = await this.deps.rpc.getTransaction(entry.signature);
        } catch (error) {
          // Not retried here. `rpcClient` has already exhausted its own
          // attempts on anything transport-shaped, so a throw reaching this
          // point is a real failure, not a slow read replica.
          this.emit('error', error as Error);
          return;
        }
        if (tx !== null) break;
        if (attempts < FETCH_ATTEMPTS) {
          await this.deps.sleep(FETCH_RETRY_BASE_MS * 2 ** (attempts - 1));
        }
      }

      // Emitted whether or not it resolved: the share that never resolves is
      // as much a part of the detection-leg distribution as the latencies are.
      this.emit('fetch-window', {
        wallet,
        signature: entry.signature,
        slot: entry.slot,
        attempts,
        elapsedMs: this.deps.now() - startedAt,
        resolved: tx !== null,
        source,
      } satisfies FetchWindowEvent);

      // Deliberately NOT admitted. The signature stays re-deliverable, which is
      // the entire fix: a transaction that was merely early gets another chance
      // from the next gap fill instead of leaving the corpus for good.
      if (tx === null) return;

      // Admission now depends on what the transaction turned out to be, so it
      // happens AFTER the parse rather than before it. `inFlight` still covers
      // the whole window, so the two delivery paths cannot both process this.
      const result = await this.dispatch(wallet, entry, tx, source);

      // `WALLET_NOT_IN_TX` is deliberately NOT admitted.
      //
      // Two of the three ways `parseSwap` reaches this code are degraded RPC
      // responses — `meta === null`, and an account key list that does not match
      // `preBalances` — rather than a genuine absence. Admitting those is the
      // same permanent-loss shape session 21 removed from the null window: the
      // transaction is consumed on the strength of an answer that was never
      // complete. The third case, a real mentions-only match, costs at worst one
      // re-fetch on a re-delivery, and post-routing-fix it was measured at zero
      // occurrences across 833 unparsed records.
      //
      // Under the old signature-only key this was not a safe change — not
      // admitting meant every mentions-only transaction was re-fetched for every
      // other wallet, breaking the socket-versus-gap-fill dedupe the set exists
      // for. That is why handoff 22 called B4 and B5 one change: the key is what
      // makes not-admitting cheap.
      //
      // NOTE the limit: `dispatch` still advances the cursor, so a re-offer will
      // not come back through gap fill. Not admitting keeps the signature
      // re-deliverable over the SOCKET, not through replay. Making the degraded
      // cases genuinely recoverable means holding the cursor back too, which is
      // a separate change with its own monotonicity risk.
      const mentionsOnly = result.kind === 'unparsed' && result.reason === 'WALLET_NOT_IN_TX';
      if (!mentionsOnly) this.seen.admit(key);
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Parse one fetched transaction, emit it, and advance the cursor.
   *
   * Returns the parse result so `handle` can decide admission from it. The
   * decision belongs to the caller because it is about the seen set's
   * bookkeeping, not about delivery.
   */
  private async dispatch(
    wallet: Address,
    entry: SignatureEntry,
    tx: ParsedTransactionWithMeta,
    source: SwapSource,
  ): Promise<ParseResult> {

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
      // Context alongside, the way `swap` already carries its parse metadata.
      // `UnparsedTransaction` is `{ kind, signature, reason, detail? }` — no
      // wallet, no slot — so a recorded `swap-unparsed` could not be attributed
      // to a wallet or placed on the chain at all, and any later measurement
      // over it had to reconstruct both. Passed here rather than added to the
      // parser's result type, which would put delivery facts in a pure function.
      this.emit('unparsed', result, { wallet, slot: tx.slot, source });
    }

    // Only now. The cursor means "delivered", so a crash before this point
    // re-delivers rather than skipping.
    this.deps.cursors.set(wallet, entry.signature, tx.slot, this.deps.now());
    return result;
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

    // Narrow the blanket hold to exactly what is about to be replayed. Until
    // this line the wallet's cursor cannot move at all, because nothing knew
    // what was outstanding; from here a 3,000-entry replay records progress as
    // it goes, and only positions with an unhandled predecessor are held back.
    this.deps.cursors.reserve(wallet, entries.map((entry) => entry.slot));

    for (const entry of entries) await this.handle(wallet, entry, 'gapfill');

    const event: GapFilledEvent = { wallet, count: entries.length, truncated };
    this.emit('gap-filled', event);
  }
}
```

---

## `src/adapters/swapParser.ts`

```typescript
/**
 * Turns a confirmed transaction into a `TrackedSwap`, or says why it cannot.
 *
 * Pure: no network, no clock, no I/O. Everything it needs is in the argument.
 *
 * ── THE INVARIANT ─────────────────────────────────────────────────────────
 *
 * For a transaction T and tracked wallet W:
 *
 *   tokenDelta(mint) = sum over ALL token accounts owned by W holding that
 *                      mint of (postTokenBalance - preTokenBalance)
 *
 * A parseable swap has exactly one mint M where M != WSOL and
 * tokenDelta(M) != 0. `side` is 'buy' when tokenDelta(M) > 0, else 'sell'.
 * Zero such mints, or two or more, is not a swap this parser handles.
 *
 * Summing across *all* accounts is the load-bearing part. A wallet can hold
 * one mint in several accounts, and routes routinely open and close
 * intermediate accounts inside a single transaction; looking at "the ATA", or
 * at the largest account, gives an answer that is quietly wrong.
 *
 * Direction never comes from decoded instruction data. Instruction layouts
 * differ per venue and change without notice; the balance delta is what the
 * wallet actually ended up holding.
 */

import type {
  Address,
  Lamports,
  Signature,
  SwapSource,
  SwapVenue,
  TokenAmount,
  TrackedSwap,
  UnixMillis,
} from '../core/types.js';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Rent-exempt minimum for a 165-byte SPL Token account.
 *
 * **An assumption, and the weakest number in this file.** It is exact for the
 * classic SPL Token account layout. A Token-2022 account carrying extensions
 * is larger and costs more, so a created/closed Token-2022 account is
 * under-corrected here. Path 1 (the WSOL token delta) is immune to this,
 * which is why it is preferred; the disagreement check below is what surfaces
 * the error when path 2 has to be used.
 */
export const SPL_TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;

/** Program ids that identify a venue. Order here is the tie-break order. */
export const VENUE_PROGRAMS: ReadonlyArray<readonly [SwapVenue, Address]> = [
  ['raydium-v4', '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'],
  ['raydium-clmm', 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'],
  ['pumpfun', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],
  ['whirlpool', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'],
  ['meteora-dlmm', 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'],
];

/**
 * Programs that move tokens but are not a market.
 *
 * ── WHY THIS IS A DENYLIST AND NOT AN ALLOWLIST ───────────────────────────
 *
 * Handoff 20 blamed unrecognised venue program ids for the missing swaps and
 * was disproved: this parser works from balance deltas precisely so a venue it
 * has never heard of still produces a swap, and `venue: 'unknown'` is metadata
 * rather than a verdict. Requiring a *known* venue would repeat that mistake and
 * discard every DEX nobody has added yet.
 *
 * Asking the opposite question is safe. If the only programs that ran are these
 * — system, the token programs, the associated-token-account program, compute
 * budget, memo — then no market was touched by anyone, under any venue, known or
 * not. A new DEX cannot look like this, because a new DEX is a program and would
 * be in the invoked set and absent from this list.
 */
export const INFRASTRUCTURE_PROGRAMS: ReadonlySet<string> = new Set([
  '11111111111111111111111111111111', // System
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token Account
  'ComputeBudget111111111111111111111111111111', // Compute budget
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', // Memo v2
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo', // Memo v1
]);

/** Above this relative gap, path 1 and path 2 disagreeing is worth shouting about. */
const PATH_DISAGREEMENT_TOLERANCE = 0.005;

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface UiTokenAmount {
  /** Base units, as a decimal string. The only field safe for arithmetic. */
  amount: string;
  decimals: number;
  /** A float. Never used here. */
  uiAmount?: number | null;
}

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: UiTokenAmount;
}

export interface LoadedAddresses {
  writable: string[];
  readonly: string[];
}

export interface TransactionMeta {
  err: unknown | null;
  fee: number;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances?: TokenBalance[] | null;
  postTokenBalances?: TokenBalance[] | null;
  loadedAddresses?: LoadedAddresses | null;
}

/** An account key is a bare base58 string under `json`, an object under `jsonParsed`. */
export type AccountKey = string | { pubkey: string; source?: 'transaction' | 'lookupTable' };

export interface TransactionMessage {
  accountKeys: AccountKey[];
}

export interface ParsedTransactionWithMeta {
  slot: number;
  blockTime?: number | null;
  version?: number | 'legacy';
  meta: TransactionMeta | null;
  transaction: {
    signatures?: string[];
    message: TransactionMessage;
  };
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type UnparsedCode =
  | 'TX_FAILED'
  | 'NO_MINT_DELTA'
  | 'MULTI_MINT_DELTA'
  | 'NO_SOL_LEG'
  | 'WALLET_NOT_IN_TX'
  /**
   * Tokens moved, but no market was involved — every program that ran was
   * infrastructure. A wallet-to-wallet transfer, an airdrop, a distribution.
   *
   * Counted rather than dropped, because "how many of these are there" is the
   * question that made them worth filtering: 271 across the corpus, 5.3-5.6% of
   * everything the parser called a swap, and `mirror.ts` sizes from
   * `positionSizeSol` rather than from the observed trade — so each one was a
   * full-weight entry signal on a token transfer.
   */
  | 'INFRASTRUCTURE_ONLY';

/** Which rule produced `solAmount`. Recorded for debugging, not for logic. */
export type SolAmountPath = 'wsol-token-delta' | 'lamport-delta';

export interface ParsedSwap {
  kind: 'swap';
  swap: TrackedSwap;
  solAmountPath: SolAmountPath;
  /**
   * Set when both paths were computable and disagreed by more than 0.5%.
   * That disagreement means the rent or fee correction is wrong, and it is
   * surfaced rather than swallowed.
   */
  pathDisagreement?: { wsolLamports: bigint; lamportDelta: bigint; relative: number };
}

export interface UnparsedTransaction {
  kind: 'unparsed';
  signature: Signature;
  reason: UnparsedCode;
  /** Free text for logs. Never parsed. */
  detail?: string;
}

export type ParseResult = ParsedSwap | UnparsedTransaction;

// ---------------------------------------------------------------------------
// Key list
// ---------------------------------------------------------------------------

/**
 * The full account key list, in the order balances are indexed against.
 *
 * Two encodings reach this function and they differ in a way that silently
 * corrupts every index if handled wrongly:
 *
 *   `json`       — `accountKeys` holds only the static keys, and
 *                  `meta.loadedAddresses` holds the lookup-table keys
 *                  separately. They must be concatenated as
 *                  static ++ writable ++ readonly.
 *   `jsonParsed` — the RPC has already merged them, in exactly that order,
 *                  each tagged with `source`, and `loadedAddresses` is absent.
 *                  Concatenating again would double the list.
 *
 * Verified against a live v0 transaction: 15 static + 19 writable + 19
 * readonly under `json` equalled the 53 `jsonParsed` keys, in order,
 * byte-for-byte.
 *
 * Returns `undefined` when the assembled list does not line up with
 * `preBalances`, which is the check that catches either mistake.
 */
export function accountKeyList(tx: ParsedTransactionWithMeta): string[] | undefined {
  const raw = tx.transaction.message.accountKeys;
  const meta = tx.meta;
  if (meta === null) return undefined;

  const alreadyMerged = raw.length > 0 && typeof raw[0] === 'object';
  const statics = raw.map((key) => (typeof key === 'string' ? key : key.pubkey));

  const keys = alreadyMerged
    ? statics
    : [
        ...statics,
        ...(meta.loadedAddresses?.writable ?? []),
        ...(meta.loadedAddresses?.readonly ?? []),
      ];

  // Balances are indexed against the full list. If these disagree, the list
  // was assembled wrongly and every index below would attribute a balance to
  // the wrong account.
  return keys.length === meta.preBalances.length ? keys : undefined;
}

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

interface MintDelta {
  delta: bigint;
  decimals: number;
}

/**
 * Net delta per mint for one owner, summed across every token account.
 *
 * Accepts both SPL Token and Token-2022 balances: the RPC reports them
 * identically here, and `programId` is not filtered on.
 */
export function tokenDeltasForOwner(
  meta: TransactionMeta,
  owner: Address,
): Map<string, MintDelta> {
  const totals = new Map<string, MintDelta>();

  const apply = (balances: TokenBalance[] | null | undefined, sign: bigint): void => {
    for (const balance of balances ?? []) {
      if (balance.owner !== owner) continue;
      const current = totals.get(balance.mint) ?? {
        delta: 0n,
        decimals: balance.uiTokenAmount.decimals,
      };
      // `amount` is the base-unit string. `uiAmount` is a float and is never
      // touched.
      current.delta += sign * BigInt(balance.uiTokenAmount.amount);
      current.decimals = balance.uiTokenAmount.decimals;
      totals.set(balance.mint, current);
    }
  };

  apply(meta.preTokenBalances, -1n);
  apply(meta.postTokenBalances, 1n);
  return totals;
}

/** Token accounts belonging to `owner` that appear in post but not pre. */
function createdAccountCount(meta: TransactionMeta, owner: Address): number {
  const before = new Set(
    (meta.preTokenBalances ?? []).filter((b) => b.owner === owner).map((b) => b.accountIndex),
  );
  return (meta.postTokenBalances ?? []).filter(
    (b) => b.owner === owner && !before.has(b.accountIndex),
  ).length;
}

/** Token accounts belonging to `owner` that appear in pre but not post. */
function closedAccountCount(meta: TransactionMeta, owner: Address): number {
  const after = new Set(
    (meta.postTokenBalances ?? []).filter((b) => b.owner === owner).map((b) => b.accountIndex),
  );
  return (meta.preTokenBalances ?? []).filter(
    (b) => b.owner === owner && !after.has(b.accountIndex),
  ).length;
}

/**
 * Signed lamport flow attributable to the swap, from `pre/postBalances`.
 *
 * Positive means the wallet received SOL. Three corrections, each removing an
 * effect that is not part of the trade:
 *
 *   + fee, when W paid it. `postBalances` is already net of the fee, so
 *     recovering the trade flow means adding it back. (The prompt for this
 *     module said "subtract"; that double-counts — see the handoff.)
 *   + rent for accounts created for W, which W paid and which is not spend.
 *   - rent refunded for accounts closed, which W received and which is not
 *     proceeds. Omitting this is not a rounding error: on a recorded Meteora
 *     buy where the WSOL account was closed, it flips a 657-lamport purchase
 *     into an apparent 2.03 SOL receipt.
 */
function lamportFlow(
  meta: TransactionMeta,
  walletIndex: number,
  isFeePayer: boolean,
  owner: Address,
): bigint {
  const pre = meta.preBalances[walletIndex];
  const post = meta.postBalances[walletIndex];
  if (pre === undefined || post === undefined) return 0n;

  let flow = BigInt(post) - BigInt(pre);
  if (isFeePayer) flow += BigInt(meta.fee);
  flow += BigInt(createdAccountCount(meta, owner)) * SPL_TOKEN_ACCOUNT_RENT_LAMPORTS;
  flow -= BigInt(closedAccountCount(meta, owner)) * SPL_TOKEN_ACCOUNT_RENT_LAMPORTS;
  return flow;
}

// ---------------------------------------------------------------------------
// Venue
// ---------------------------------------------------------------------------

/** Every venue program present, in `VENUE_PROGRAMS` order. */
export function venuesPresent(keys: readonly string[]): SwapVenue[] {
  const present = new Set(keys);
  return VENUE_PROGRAMS.filter(([, program]) => present.has(program)).map(([venue]) => venue);
}

/**
 * Every program actually invoked, top-level and inner.
 *
 * Deliberately NOT the account key list. A venue's program id sits in the keys
 * of any transaction that merely references it, and — more to the point here —
 * the keys of an ATA transfer contain mints and token accounts that are not
 * programs at all. Only the instructions say what ran.
 *
 * Both encodings, for the same reason `accountKeyList` handles both: `jsonParsed`
 * gives `programId` directly, and the raw encoding gives an index into the keys.
 * Returns an empty set when neither is present, and every caller treats that as
 * "cannot tell" rather than as "nothing ran".
 */
export function programsInvoked(
  tx: ParsedTransactionWithMeta,
  keys: readonly string[],
): Set<string> {
  const programs = new Set<string>();
  const add = (instruction: unknown): void => {
    const record = instruction as { programId?: unknown; programIdIndex?: unknown };
    if (typeof record.programId === 'string') {
      programs.add(record.programId);
      return;
    }
    if (typeof record.programIdIndex === 'number') {
      const key = keys[record.programIdIndex];
      if (key !== undefined) programs.add(key);
    }
  };

  const message = (tx as { transaction?: { message?: { instructions?: unknown[] } } }).transaction
    ?.message;
  for (const instruction of message?.instructions ?? []) add(instruction);

  const inner =
    (tx.meta as { innerInstructions?: Array<{ instructions?: unknown[] }> } | null)
      ?.innerInstructions ?? [];
  for (const group of inner) for (const instruction of group.instructions ?? []) add(instruction);

  return programs;
}

/**
 * True when every program that ran is infrastructure — so nothing traded.
 *
 * **Fails open.** An empty set means the encoding did not tell us what ran, and
 * a real trade wrongly discarded is far more expensive than a token transfer
 * wrongly admitted: the first is silent, the second is counted.
 */
export function isInfrastructureOnly(programs: ReadonlySet<string>): boolean {
  if (programs.size === 0) return false;
  for (const program of programs) if (!INFRASTRUCTURE_PROGRAMS.has(program)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// parseSwap
// ---------------------------------------------------------------------------

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Delivery metadata the parser cannot work out for itself.
 *
 * `parseSwap` sees a transaction. It does not see how that transaction reached
 * this process, and it has no clock — both are properties of the *fetch*, which
 * belongs to `WalletStream`. Passing them in keeps this function pure, which is
 * what lets the replay harness re-derive a swap from a recorded transaction.
 *
 * Both defaults are **fail-closed**. An unstamped swap claims to be a gap-fill
 * entry observed at the epoch, so it reads as maximally stale to the freshness
 * gate rather than as fresh live signal. A caller that forgets to stamp loses
 * trades; the opposite default would silently buy on a backlog. Every existing
 * parser test relies on these defaults and needed no change.
 */
export interface SwapStamp {
  source?: SwapSource;
  observedAt?: UnixMillis;
}

export function parseSwap(
  tx: ParsedTransactionWithMeta,
  wallet: Address,
  stamp: SwapStamp = {},
): ParseResult {
  const signature = tx.transaction.signatures?.[0] ?? '';
  const meta = tx.meta;

  if (meta === null) {
    return { kind: 'unparsed', signature, reason: 'WALLET_NOT_IN_TX', detail: 'no meta' };
  }

  // A failed transaction moves nothing, so its deltas are all zero — but it is
  // not semantically a no-op, and must never look like one. Checked first so
  // it can never be mistaken for NO_MINT_DELTA.
  if (meta.err !== null && meta.err !== undefined) {
    return { kind: 'unparsed', signature, reason: 'TX_FAILED' };
  }

  const keys = accountKeyList(tx);
  if (keys === undefined) {
    return {
      kind: 'unparsed',
      signature,
      reason: 'WALLET_NOT_IN_TX',
      detail: 'account key list does not match preBalances length',
    };
  }

  // Tokens can move without a market. Checked after the wallet is known to be
  // in the transaction — "not here at all" is the more basic fact — and before
  // the delta analysis, which cannot tell a transfer from a trade because both
  // move exactly one mint.
  //
  // Confirmed against chain in session 24: six sampled transactions whose SOL
  // leg was exactly `SPL_TOKEN_ACCOUNT_RENT_LAMPORTS` ran only ATA, token and
  // system programs. On the buy side the wallet's own lamport delta was **0** —
  // the rent was paid by the sender — and on the sell side it was **-2,245,780**,
  // so the parser recorded SOL coming in while the wallet was paying it out.
  if (isInfrastructureOnly(programsInvoked(tx, keys))) {
    return {
      kind: 'unparsed',
      signature,
      reason: 'INFRASTRUCTURE_ONLY',
      detail: 'tokens moved but no venue program ran',
    };
  }

  const walletIndex = keys.indexOf(wallet);
  const deltas = tokenDeltasForOwner(meta, wallet);

  // The wallet must appear somewhere: as an account key, or as the owner of a
  // token account. Owners are not necessarily account keys themselves.
  if (walletIndex === -1 && deltas.size === 0) {
    return { kind: 'unparsed', signature, reason: 'WALLET_NOT_IN_TX' };
  }

  const moved = [...deltas.entries()].filter(
    ([mint, value]) => mint !== WSOL_MINT && value.delta !== 0n,
  );

  if (moved.length === 0) {
    return { kind: 'unparsed', signature, reason: 'NO_MINT_DELTA' };
  }
  if (moved.length > 1) {
    // Deliberately not "pick the largest". Two moved mints means this is a
    // shape the invariant does not describe — a multi-leg route, a migration,
    // something else — and guessing produces a confident wrong answer.
    return {
      kind: 'unparsed',
      signature,
      reason: 'MULTI_MINT_DELTA',
      detail: moved.map(([mint]) => mint).join(','),
    };
  }

  const [mint, token] = moved[0] as [string, MintDelta];
  const side = token.delta > 0n ? 'buy' : 'sell';

  // Path 1: the WSOL token delta. A wrapped-SOL account records the SOL leg
  // directly, with no fee or rent mixed in.
  //
  // NOT negated, contrary to this module's brief. A buy drains the wallet's
  // WSOL, so the delta is already negative-for-spent — the same sign
  // convention as the lamport path. Negating would invert path 1 against
  // path 2. That is invisible in `solAmount`, which is a magnitude with `side`
  // carrying direction, but it makes every cross-path comparison read as a
  // 200% disagreement.
  const wsol = deltas.get(WSOL_MINT);
  const wsolLamports = wsol === undefined ? undefined : wsol.delta;

  // Path 2: the lamport delta, corrected.
  const isFeePayer = keys[0] === wallet;
  const lamports = walletIndex === -1 ? undefined : lamportFlow(meta, walletIndex, isFeePayer, wallet);

  let solFlow: bigint | undefined;
  let path: SolAmountPath;
  if (wsolLamports !== undefined && wsolLamports !== 0n) {
    solFlow = wsolLamports;
    path = 'wsol-token-delta';
  } else if (lamports !== undefined && lamports !== 0n) {
    solFlow = lamports;
    path = 'lamport-delta';
  } else {
    return { kind: 'unparsed', signature, reason: 'NO_SOL_LEG' };
  }

  // Both computable: compare. A gap here is the rent or fee arithmetic being
  // wrong, which is exactly the thing worth seeing rather than swallowing.
  let disagreement: ParsedSwap['pathDisagreement'];
  if (wsolLamports !== undefined && wsolLamports !== 0n && lamports !== undefined && lamports !== 0n) {
    const gap = abs(wsolLamports - lamports);
    const scale = abs(wsolLamports);
    const relative = scale === 0n ? 0 : Number(gap) / Number(scale);
    if (relative > PATH_DISAGREEMENT_TOLERANCE) {
      disagreement = { wsolLamports, lamportDelta: lamports, relative };
    }
  }

  const venues = venuesPresent(keys);

  const swap: TrackedSwap = {
    wallet,
    mint,
    side,
    solAmount: abs(solFlow) as Lamports,
    tokenAmount: abs(token.delta) as TokenAmount,
    decimals: token.decimals,
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    // Metadata only. An unrecognised program with a clean single-mint delta
    // still produces a swap.
    venue: venues[0] ?? 'unknown',
    feePayer: isFeePayer,
    source: stamp.source ?? 'gapfill',
    observedAt: stamp.observedAt ?? 0,
  };

  return disagreement === undefined
    ? { kind: 'swap', swap, solAmountPath: path }
    : { kind: 'swap', swap, solAmountPath: path, pathDisagreement: disagreement };
}
```
