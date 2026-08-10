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
 * Bound on history replayed when the cursor IS usable.
 *
 * ── DERIVED IN SESSION 25, AGAINST ENTRY LATENCY RATHER THAN SAFETY ───────
 *
 * This used to be unbounded, because the `MAX_COLD_FILL` check is gated on
 * `cursor === undefined`. Session 25's soak paid for that: one wallet ran 20,045
 * serial fetches with 77,236 slots reserved and was still going at shutdown, and
 * the socket never connected at all across a 132.3-minute window.
 *
 * **What this bound is for, since d40fc56.** `ensurePriceLoop()` now runs before
 * `stream.start()`, so a long fill no longer strands held positions — stop-loss,
 * take-profit and `route-lost` all survive it. What it does NOT survive is entry
 * latency: `start()` still does not return while a warm fill runs, so `status`
 * stays `idle`, guard gate 2 refuses every buy, and a 132-minute fill is still
 * 132 minutes of zero entries. That is the cost this bound buys down.
 *
 * ── 1. THE PER-WALLET BOUND, AND THE DECAY CLAIM BEHIND IT ────────────────
 *
 * 100 entries. The claim is that replayed history has **no** trading value
 * beyond the first few seconds, and the system already asserts this elsewhere:
 * `maxSignalAgeMs` is 15,000ms, and guard gate 3 refuses any intent whose
 * originating swap is older than that. `MirrorStrategy` deliberately does not
 * filter on age itself, so a stale replayed swap becomes a `STALE_SIGNAL`
 * rejection rather than a trade. Gap fill replays history at least as old as the
 * downtime, so after even a one-minute outage every replayed entry is already
 * past the gate. Depth beyond that is corpus and cursor continuity, not alpha.
 *
 * The alpha-decay harness (handoff 16) measures the shape: mean forward return
 * by entry delay, **n=119 round trips sampled over 20 days on one wallet**:
 *
 *     delay      0s     15s     30s     60s    120s
 *     mean    16.24%  10.70%   9.08%   6.45%   5.82%
 *
 * Down 34% by the 15s gate and 60% by 60s. It is one wallet and 119 trips, so it
 * establishes the direction and rough magnitude, not a precise half-life — but
 * every candidate bound sits far to the right of the 15s cliff, so the choice is
 * not sensitive to that imprecision.
 *
 * 100 is therefore chosen from COST, with the decay curve establishing only that
 * the benefit side is flat. It matches `MAX_COLD_FILL` deliberately: the reason
 * cold fill is capped — "never replay unbounded history into a live strategy" —
 * applies identically whether or not a cursor happens to exist, and the two
 * differing was an oversight in a guard condition rather than a decision.
 *
 * Coverage, measured over **n=842 `gap-filled` events across all 12 session
 * files** (2026-08-04 to 2026-08-09): p50 16, p75 45, p90 100, p99 675, max
 * 7,822. **90.7% of fills are already at or under 100** and see no change at
 * all; the bound bites on the remaining 9.3%.
 *
 * ── 2. THE AGGREGATE STARTUP COST, WHICH IS STILL LARGE ───────────────────
 *
 * `gapFillAll()` is serial across 13 wallets, so the worst case is 13 x 100 =
 * **1,300 fetches before `start()` returns**. At the measured mean gap-fill
 * fetch of 194ms (p50 158ms, p90 206ms, **n=47,684**) that is **~4.2 minutes**,
 * or ~4.5 at p90.
 *
 * Four minutes of zero entries is not a good number and is not presented as one.
 * At the measured live arrival rate of 1.40 swaps/min across all 13 wallets it
 * is roughly six missed signals per cold start. It is ~31x better than the
 * observed 132-minute failure, and it is bounded rather than open-ended, but the
 * fix that actually removes it is concurrency across wallets, not a smaller
 * per-wallet cap. **This number belongs in the re-soak gate**, not buried here:
 * a re-soak should expect ~4 minutes of startup blindness, and if it sees much
 * more the bound is not working.
 *
 * ── 3. THE IMPLIED CEILING ON `Barrier.peakOutstanding` ───────────────────
 *
 * `reserve()` is called once per wallet with exactly the entries about to be
 * handled, so a bounded fill bounds the reservation: **peakOutstanding <= 100**,
 * against 77,236 observed. That matters because the barrier was quadratic in the
 * reservation until 804724b — at 77,236 it cost 1.611ms per completion, ~124s of
 * CPU for one wallet. It is linear now, but this bound means the pathological
 * input can no longer be constructed at all.
 *
 * `MAX_DEFERRED` stays at 4,096, now ~40x the ceiling it guards. Left alone
 * deliberately: deferral is driven by live deliveries landing above the barrier,
 * not by reservation size, and prompt 16 will make those land during the fill
 * for the first time. At 1.40 swaps/min over a ~4 minute fill that is single
 * digits, so 4,096 is wildly slack — but re-deriving a constant whose input is
 * about to change, inside a commit that is meant to be one change, would be
 * guessing twice. It is oversized, harmless, and flagged rather than adjusted.
 *
 * ── ORDER-INDEPENDENCE (prompt 16 moves `connectOnce` ahead of this) ──────
 *
 * The truncation path is order-independent and does not assume the socket is
 * down. It reads only the cursor and the paged entries, and the cursor write
 * that records the skip happens **after** `reserve()`, so it lands below the
 * barrier and persists immediately while a concurrent live delivery for the same
 * wallet — which sits above the barrier — stays deferred. A live delivery cannot
 * therefore be mistaken for the truncation point, and the truncation point
 * cannot overwrite a newer live position.
 *
 * The one thing that does change under prompt 16: the skipped window will be
 * computed while new signatures are still arriving, so `toSlot` becomes "newest
 * skipped at the moment of paging" rather than "newest skipped, full stop".
 * That is already true of any gap fill and is why the event carries explicit
 * slots instead of a count alone.
 */
export const MAX_WARM_FILL = 100;
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
 * A socket is open and every subscribe has been sent.
 *
 * Distinct from `reconnected`, deliberately. That one means "an outage is over"
 * and is emitted after the backfill; this one means "the feed is live" and is
 * emitted the moment it is true, on the first connect as well as on every
 * subsequent one. The tracker's `running` status is bound to this rather than to
 * `start()` returning, so `running` cannot mean "we finished trying" — it means
 * a socket exists and is subscribed.
 */
export interface ConnectedEvent {
  at: UnixMillis;
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
  /**
   * True when the cursor was unusable and history was capped at
   * `MAX_COLD_FILL`. **Cold truncation only.**
   *
   * A warm truncation does NOT set this — it emits `history-skipped` instead.
   * The two are different facts: a cold truncation is "we had no idea where we
   * were, so we took the newest 100 and started from there", while a warm one is
   * "we knew exactly where we were and chose to abandon a measurable window".
   * Only the second one means a cursor is now describing a position the process
   * never actually delivered, and a later measurement has to be able to count
   * them apart without inspecting a flag on an event that means neither.
   */
  truncated: boolean;
}

/**
 * A warm gap fill deliberately abandoned part of its backlog.
 *
 * ── WHY THIS IS AN EVENT AND NOT A FLAG ───────────────────────────────────
 *
 * The cursor barrier exists to make it impossible for a cursor to advance past
 * history that was never handled. This does exactly that on purpose. The two
 * must be impossible to confuse, so the deliberate one announces itself with its
 * own type, its own slot range, and its own digest finding — an ACKNOWLEDGED
 * gap. The alternative is a cursor that silently describes a position the
 * process never delivered, which is the failure the barrier was built for.
 *
 * `fromSlot`/`toSlot` bound the abandoned window and `count` is exact: paging
 * runs to completion before truncation, so the whole skipped range is known.
 * That costs one `getSignaturesForAddress` page per 1,000 skipped signatures —
 * ~78 calls on the worst backlog observed, against the 20,045 `getTransaction`
 * calls the bound removes — which is a good trade for being able to say exactly
 * how much history was dropped and where.
 */
export interface HistorySkippedEvent {
  wallet: Address;
  /** Oldest abandoned slot. */
  fromSlot: number;
  /** Newest abandoned slot. The cursor now stands here. */
  toSlot: number;
  /** Exact count of abandoned signatures. */
  count: number;
  /** The bound that produced this, so the event says what it was measured against. */
  bound: number;
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

      // The socket is up and every subscribe has been sent. Emitted separately
      // from `reconnected`, which fires only after the backfill and only on the
      // reconnect path — this is "the feed is live", which is a different fact
      // and, once `start()` connects before it fills, happens at a very
      // different time from "the backfill finished".
      this.emit('connected', { at: this.deps.now() } satisfies ConnectedEvent);
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

    // The warm bound. See `MAX_WARM_FILL` — this is an entry-latency decision,
    // not a safety one, and it is the only place in the system that abandons
    // history on purpose.
    let skipped: SignatureEntry[] = [];
    if (cursor !== undefined && entries.length > MAX_WARM_FILL) {
      skipped = entries.slice(0, entries.length - MAX_WARM_FILL);
      entries = entries.slice(-MAX_WARM_FILL);
    }

    // Narrow the blanket hold to exactly what is about to be replayed. Until
    // this line the wallet's cursor cannot move at all, because nothing knew
    // what was outstanding; from here a 3,000-entry replay records progress as
    // it goes, and only positions with an unhandled predecessor are held back.
    this.deps.cursors.reserve(wallet, entries.map((entry) => entry.slot));

    if (skipped.length > 0) {
      const oldest = skipped[0]!;
      const newest = skipped[skipped.length - 1]!;

      // AFTER `reserve`, and that ordering is the whole safety argument.
      //
      // Every skipped slot is below every kept slot, so this write sits below
      // the barrier and persists immediately — while a live delivery for the
      // same wallet, which sits above it, stays deferred. The truncation point
      // therefore cannot overwrite a newer live position, and a live position
      // cannot be mistaken for the truncation point. That holds whether or not a
      // socket is connected, which is what makes this order-independent ahead of
      // prompt 16.
      //
      // The cursor is advanced deliberately: the window is abandoned, so the
      // decision has to be durable or the next start re-attempts it and pays the
      // cost again. Announced first-class rather than left as a silent jump —
      // this is the one place a cursor legitimately names a position the process
      // never delivered, and it says so.
      this.deps.cursors.set(wallet, newest.signature, newest.slot, this.deps.now());
      this.emit('history-skipped', {
        wallet,
        fromSlot: oldest.slot,
        toSlot: newest.slot,
        count: skipped.length,
        bound: MAX_WARM_FILL,
      } satisfies HistorySkippedEvent);
    }

    for (const entry of entries) await this.handle(wallet, entry, 'gapfill');

    const event: GapFilledEvent = { wallet, count: entries.length, truncated };
    this.emit('gap-filled', event);
  }
}
