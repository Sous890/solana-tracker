# Source — tracker, digest, recorder

> Generated from commit `804724b` (fix: two defects the soak found, one of them introduced by the barrier) on 2026-08-10.
> Regenerate with `npx tsx scripts/bundle-for-claude.ts`. Do not edit by hand.

`tracker.ts` is the orchestrator and holds the guard backstop. `soak.ts` is the digest — every alarm threshold in the system is in it. `recorder.ts` writes the session files that every measurement is made from.

## Files in this bundle

- `src/services/tracker.ts`
- `src/services/soak.ts`
- `src/services/recorder.ts`

---

## `src/services/tracker.ts`

```typescript
/**
 * The tracker: the composition root, and the only owner of `BotState`.
 *
 * Everything the previous eight prompts left as an injected port gets its real
 * implementation constructed here — `createTrackerRuntime()` at the bottom of
 * this file is the one place a network client, a database handle or a wallet
 * subscription comes into existence. `Tracker` itself takes those as arguments,
 * so the state machine can be tested against fakes with no network and no clock.
 *
 * ── THE ASYMMETRY, RESTATED FOR LIFECYCLE ─────────────────────────────────
 *
 * `guards.ts` gates entries hard and exits not at all. The lifecycle commands
 * inherit that shape, and it is the reason they are not symmetric:
 *
 *   start()   STRICT. Starting twice is a bug in the caller, and the second
 *             start would open a second set of subscriptions against one
 *             cursor. It throws.
 *   stop()    CONVERGENT. Asking a stopped bot to stop is satisfied, not an
 *             error. Idle is a no-op; stopping joins the stop already running.
 *   flatten() SEPARATE. It is the only command that sells, it is never reached
 *             by stopping, and it takes an explicit confirmation at the API
 *             boundary. Binding it to the same control as stop is how an
 *             operator liquidates a book they meant to leave alone.
 *   kill()    INSTANT and PERSISTED. Entries are blocked before anything else
 *             happens, and the flag survives the restart that an incident
 *             tends to involve.
 *
 * **`stop()` sells nothing.** It closes the wallet subscriptions, so no new
 * entry can be sourced, and it lets in-flight intents finish. Open positions
 * stay open — and stay monitored: the price loop and the held-position screen
 * keep running while anything is held, precisely because stop() did not exit
 * it. An operator who stops the bot still needs to hear that a position they
 * are holding has lost its route.
 *
 * ── STRATEGY ──────────────────────────────────────────────────────────────
 *
 * Attached by `useStrategy()`, not by the constructor — one visible call at the
 * composition root, because it is the change that turns an observer into a
 * trader. Detached (`null`) the tracker still marks, screens and alerts, and
 * creates nothing.
 *
 * The tracker decides only *when* the strategy is consulted, and that decision
 * is the entry/exit asymmetry again:
 *
 *   onTrackedSwap   only while `running`. An entry sourced while stopping or
 *                   idle would make `stop()` a suggestion.
 *   onPriceTick     in every state, including idle-with-open-positions and with
 *                   the kill switch engaged. An exit must keep working when an
 *                   entry does not.
 *
 * Everything after the decision is unchanged: `submit()` records the intent,
 * `guards.ts` gates it, the broker executes it. The strategy replaces what to
 * do, never how.
 */

import { EventEmitter } from 'node:events';
import pino from 'pino';
import type { Broker } from '../core/broker.js';
import type { Config } from '../core/config.js';
import { GuardRejection, guarded, malformedIntentReason } from '../core/guards.js';
import type { GuardDeps } from '../core/guards.js';
import { isQuoteError } from '../core/quoteSource.js';
import type { QuoteSource } from '../core/quoteSource.js';
import type {
  Address,
  BotState,
  BotStatus,
  Fill,
  Lamports,
  OrderIntent,
  Position,
  TrackedSwap,
  UnixMillis,
} from '../core/types.js';
import { WRAPPED_SOL_MINT, baseUnitsToTokens, lamportsToSol } from '../core/units.js';
import { openLedger } from '../db/ledger.js';
import type { Ledger, ReconcileReport } from '../db/ledger.js';
import { openCursorStore } from '../db/cursors.js';
import type { CursorStore } from '../db/cursors.js';
import { openRuntimeState } from '../db/runtimeState.js';
import type { RuntimeState } from '../db/runtimeState.js';
import { openFillsView } from '../db/fillsView.js';
import type { FillsView } from '../db/fillsView.js';
import { SafetyScreener, canSellFromScreener } from '../adapters/safety.js';
import { createRpcClient } from '../adapters/rpcClient.js';
import { createDexScreenerClient } from '../adapters/dexscreener.js';
import { createStreamSocketFactory } from '../adapters/streamSocket.js';
import { createJupiterQuoteSource } from '../adapters/jupiter.js';
import { createPaperBroker } from '../adapters/paperBroker.js';
import { createDecimalsResolver } from '../adapters/mintMetadata.js';
import {
  HEARTBEAT_INTERVAL_MS,
  SILENCE_TIMEOUT_MS,
  WalletStream,
} from '../adapters/walletStream.js';
import { StrategyRunner } from './strategyRunner.js';
import { SessionRecorder } from './recorder.js';
import { LedgerSnapshotter, assertLedgerPresent } from './ledgerDurability.js';

/** `true`/`1`/`yes` are true; anything else present is false. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes)$/i.test(raw.trim());
}

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/**
 * Every query-string value in a URL, as its own secret.
 *
 * An endpoint is `https://host/?api-key=SECRET`, and the key leaks on its own
 * as often as the whole URL does — a provider echoes it back in an error body,
 * or a log formatter prints just the parameter. Redacting the URL alone would
 * miss both.
 */
function queryValues(url: string): string[] {
  try {
    return [...new URL(url).searchParams.values()].filter((value) => value.length >= 8);
  } catch {
    return [];
  }
}
import { createStrategy } from './strategyRegistry.js';

// ---------------------------------------------------------------------------
// Cadences
// ---------------------------------------------------------------------------

/** Price/route probe, per open position. */
export const PRICE_INTERVAL_MS = 2_000;

/**
 * Held-position screen. 30s, and the arithmetic that says it is safe:
 *
 * `screenHeldPosition` is capped by `maxConcurrentPositions` (3 by default),
 * runs its positions sequentially here, and the screener caps itself at 3
 * concurrent screens with a 250ms floor between DexScreener calls. Worst case
 * is therefore 3 screens per 30s — 0.1/s — against DexScreener's 300/min.
 *
 * The cadence is chosen against the `unknown` case specifically. `pass` and
 * `fail` are cached for 60s, so at 30s every second screen of a healthy mint is
 * a cache hit and costs nothing. `unknown` is **never** cached, by design, so a
 * broken provider means every tick is a real round trip. 30s keeps that at
 * 0.1/s; the 2s price cadence would make it 1.5/s per provider forever, which
 * is how a transient outage becomes a rate-limit ban and then a permanent one.
 */
export const SCREEN_INTERVAL_MS = 30_000;

/** Events replayed to a client attaching mid-run. */
export const EVENT_BUFFER_SIZE = 200;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type TrackerEventName =
  /** A tracked wallet swapped. Provisional (confirmed commitment) and about someone else. */
  | 'swap-detected'
  /** An intent was written to the ledger, before the broker was called. */
  | 'intent-created'
  /** An intent settled. */
  | 'fill'
  /** The guard layer refused an intent. Carries the machine-readable code. */
  | 'rejection'
  /** A held mint's screen degraded into `fail` or `unknown`. Alerting only. */
  | 'sellability-degraded'
  /** A held mint stopped quoting a route out. The position may be trapped. */
  | 'route-lost'
  /** `status` or `killSwitchEngaged` changed. */
  | 'state-change'
  /** Startup reconciliation, including crash orphans and open positions. */
  | 'reconciled'
  /** The strategy threw or timed out. Treated as `null`; never stops a loop. */
  | 'strategy-error'
  /** A tracked-wallet transaction the swap parser refused. Carries its reason code. */
  | 'swap-unparsed'
  /** The wallet websocket dropped. */
  | 'stream-disconnected'
  /** The wallet websocket came back, with the attempt count. */
  | 'stream-reconnected'
  /** A gap fill completed, with how many signatures it recovered. */
  | 'stream-gap-filled'
  /**
   * One signature's trip through the RPC null window: attempts and elapsed ms.
   * The detection leg of CLAUDE.md gap 6, and a LOWER BOUND on copy delay.
   */
  | 'stream-fetch-window'
  /**
   * The fetch queue shed load. Recorded separately from the `error` it also
   * raises, because `error` is excluded from sessions by name and this is the
   * only measure of how much of the feed was dropped.
   */
  | 'stream-queue-overflow'
  /**
   * A notification arrived on a subscription id this process cannot attribute
   * to a wallet. Expected transiently around a reconnect; a steady stream means
   * the id map is wrong. Never fanned out — see handoff 22.
   */
  | 'stream-unknown-subscription'
  | 'error';

export interface TrackerEventRecord {
  /** Monotonic within a process. The SSE `id:`, so a client can resume. */
  seq: number;
  type: TrackerEventName;
  at: UnixMillis;
  data: unknown;
}

/** A refusal, with the code preserved end to end. */
export interface RejectionEvent {
  intentId: string;
  side: OrderIntent['side'];
  mint: Address;
  /**
   * The age guard gate 3 actually judged, when there was one.
   *
   * Carried here because it cannot be carried anywhere else: `intents` has no
   * column for it (CLAUDE.md gap 8) and `db/ledger.ts` is out of scope without a
   * signed sign-off. The recorder writes it onto a `decision` line, so a session
   * file can finally answer "272 STALE_SIGNAL refusals — and how stale?" without
   * anybody inferring an age from timestamps, which that gap forbids.
   *
   * Absent for exits and for an operator's manual order, which is exactly the
   * population the freshness gate does not apply to.
   */
  signalAgeMs?: number;
  /** The `GuardCode`, e.g. `CANNOT_SELL`. */
  code: string;
  /**
   * The code as written to `intents.rejection_code`.
   *
   * For a screener refusal this is `CANNOT_SELL:SCREEN_FAILED:<codes>` or
   * `CANNOT_SELL:SCREEN_UNKNOWN:<codes>`. Handoff 08 is explicit that those two
   * must stay distinguishable "in logs and in the ledger's rejection_code" —
   * an adversarial market and a broken data provider produce the same
   * `CANNOT_SELL` and must not produce the same record.
   */
  rejectionCode: string;
  reason: string;
}

export interface RouteLostEvent {
  mint: Address;
  tokens: string;
  reason: string;
  at: UnixMillis;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface TrackerLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/** The wallet stream, narrowed to what the tracker drives. `WalletStream` satisfies it. */
export interface WalletFeed extends EventEmitter {
  start(): Promise<void>;
  stop(): void;
  /**
   * Liveness tick. Returns true when it tore the socket down.
   *
   * Optional so every existing `WalletFeed` fake stays valid — but `WalletStream`
   * implements it, and `ensureLoops` calls it. It was implemented and never
   * called at all until session 24, which is why a socket that went quiet
   * without erroring was invisible: the detector existed and nothing drove it.
   */
  heartbeat?(healthy: boolean): boolean;
}

/**
 * The screener, narrowed to the held-position path.
 *
 * Deliberately **not** the whole `SafetyScreener`. The tracker must never reach
 * `screenMint` — that is the pre-buy admission check, and it belongs to
 * `canSell` at guard gate 7 and nowhere else. Depending on the narrow shape is
 * what makes "the screener is never consulted on a sell" a property of the type
 * rather than of everyone's memory. `SafetyScreener` satisfies it.
 */
export interface HeldPositionScreener extends EventEmitter {
  screenHeldPosition(mint: Address, options: { sizeSol: number }): Promise<unknown>;
}

/** Timers, injected so the loops can be stepped in a test without real time. */
export interface Scheduler {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realScheduler: Scheduler = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * The strategy seam, as the tracker sees it. `StrategyRunner` satisfies it.
 *
 * Narrow on purpose, and narrower than `Strategy` itself: the tracker hands
 * over an event and gets nothing back. It cannot read a draft, cannot see an
 * intent id, and cannot tell whether the strategy decided to act — because
 * everything that follows from a decision goes through `submit()`, which the
 * runner calls and which is the same guarded path an operator uses.
 *
 * Attached by `useStrategy()` rather than through the constructor. Wiring a
 * strategy is the change that turns an observer into a trader, so it is a
 * single visible call at the composition root instead of one more field in a
 * deps object.
 */
export interface StrategyDriver extends EventEmitter {
  onTrackedSwap(swap: TrackedSwap): Promise<void>;
  onPriceTick(position: Position, priceSol: number): Promise<void>;
}

/** How a run records itself. See `RECORDING_DEFAULTS` for why this is not config.json. */
export interface RecordingOptions {
  enabled: boolean;
  directory: string;
  maxBytes: number;
  retentionDays: number;
  /** Never written to a session file. See `SessionRecorder.redact`. */
  secrets: readonly string[];
}

/**
 * Defaults exactly as prompt 13 specified them — but NOT in `config.json`.
 *
 * `core/config.ts` is frozen and its schema is `.strict()`, so an unknown
 * `recordSessions` key in `config.json` is not ignored, it is a hard
 * validation failure. These therefore arrive as runtime options with
 * environment fallbacks, which is the only place they can live without
 * editing a frozen file. Recorded here rather than in a handoff footnote
 * because the next person will look for them in `config.json` first.
 */
export const RECORDING_DEFAULTS = {
  recordSessions: true,
  sessionDir: './sessions',
  sessionMaxBytes: 64 * 1024 * 1024,
  sessionRetentionDays: 30,
} as const;

export interface TrackerDeps {
  config: Config;
  ledger: Ledger;
  runtime: RuntimeState;
  /**
   * The **unguarded** broker. The tracker wraps it in `guarded()` itself,
   * because `guarded()` needs `getState()` and the tracker is what owns state.
   * Nothing else is given a handle to the inner broker.
   */
  broker: Broker;
  screener: HeldPositionScreener;
  /** Used by the price loop only; the broker has its own. */
  quotes: QuoteSource;
  stream: WalletFeed;
  logger: TrackerLogger;
  now?: () => UnixMillis;
  scheduler?: Scheduler;
  priceIntervalMs?: number;
  screenIntervalMs?: number;
  heartbeatIntervalMs?: number;
  eventBufferSize?: number;
  /** Absent, or `enabled: false`, records nothing and opens no file. */
  recording?: RecordingOptions;
}

/**
 * The code recorded when a write the system depends on did not stick.
 *
 * Distinct from every `GuardCode`: nothing was refused on its merits. The
 * intent may have been perfectly good and the storage underneath it was not,
 * and an operator seeing a run of these should be looking at the disk rather
 * than at the market.
 */
export const LEDGER_WRITE_FAILED = 'LEDGER_WRITE_FAILED';

/** Thrown when an intent could not be durably recorded. Never a refusal on merit. */
export class LedgerWriteError extends Error {
  constructor(message: string) {
    super(`${LEDGER_WRITE_FAILED}: ${message}`);
    this.name = 'LedgerWriteError';
  }
}

/**
 * Whether a row read back from the ledger is the fill the broker just returned.
 *
 * Compared on identity plus the quantities that matter, not with a deep equal:
 * the row has been through SQLite and back, so `slippageBps` may be a REAL and
 * `at` a narrowed number. What must match is what moved.
 */
function sameFill(row: Fill, fill: Fill): boolean {
  return (
    row.intentId === fill.intentId &&
    row.mint === fill.mint &&
    row.side === fill.side &&
    row.tokensDelta === fill.tokensDelta &&
    row.lamportsDelta === fill.lamportsDelta &&
    row.feesLamports === fill.feesLamports
  );
}

/** Thrown by a lifecycle command that cannot run from the current state. */
export class TrackerStateError extends Error {
  readonly status: BotStatus;

  constructor(message: string, status: BotStatus) {
    super(message);
    this.name = 'TrackerStateError';
    this.status = status;
  }
}

/** A position plus the mark the price loop last derived for it. */
export interface MarkedPosition extends Position {
  /** Lamports per whole token from the most recent exit quote, or `null`. */
  markLamportsPerToken: Lamports | null;
  markedAt: UnixMillis | null;
  /** True once an exit quote came back `NO_ROUTE` and has not recovered. */
  routeLost: boolean;
}

export interface FlattenResult {
  completed: Fill[];
  failures: Array<{ mint: Address; reason: string }>;
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

export class Tracker extends EventEmitter {
  private readonly deps: TrackerDeps;
  private readonly now: () => UnixMillis;
  private readonly scheduler: Scheduler;
  private readonly priceIntervalMs: number;
  private readonly screenIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly eventBufferSize: number;

  /** The guarded broker. The only execution surface anything else may reach. */
  readonly broker: Broker;

  private status: BotStatus = 'idle';
  private startedAt: UnixMillis | undefined;
  private killSwitchEngaged: boolean;

  /** Attached by `useStrategy()`. Null means the tracker only observes. */
  private driver: StrategyDriver | null = null;

  /** Guards `start()` against a second call arriving before the first resolves. */
  private starting = false;
  private stopping: Promise<void> | undefined;

  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly screensInFlight = new Set<Address>();

  private priceHandle: unknown;
  private screenHandle: unknown;
  private heartbeatHandle: unknown;
  private priceTickRunning = false;
  private screenTickRunning = false;

  private readonly marks = new Map<Address, { lamportsPerToken: Lamports; at: UnixMillis }>();
  private readonly routeLost = new Set<Address>();

  private readonly events: TrackerEventRecord[] = [];
  private nextSeq = 1;

  /**
   * Opened by `start()`, flushed and closed by `stop()`.
   *
   * Owned by the lifecycle rather than by construction, so an idle process
   * holds no open file handle and a stop leaves a complete session on disk
   * rather than one that ends whenever the process happens to exit.
   */
  private recorder: SessionRecorder | undefined;

  readonly stats = { priceTicks: 0, screenTicks: 0, intents: 0, fills: 0, rejections: 0 };

  constructor(deps: TrackerDeps) {
    super();
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.scheduler = deps.scheduler ?? realScheduler;
    this.priceIntervalMs = deps.priceIntervalMs ?? PRICE_INTERVAL_MS;
    this.screenIntervalMs = deps.screenIntervalMs ?? SCREEN_INTERVAL_MS;
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.eventBufferSize = deps.eventBufferSize ?? EVENT_BUFFER_SIZE;

    // Read once from disk. The flag is written through on every change, and
    // this process is the only writer, so a re-read per guard check would buy
    // nothing. What it does buy is the thing that matters: a kill switch
    // engaged before a crash is still engaged after the restart.
    this.killSwitchEngaged = deps.runtime.killSwitchEngaged();

    const guardDeps: GuardDeps = {
      config: deps.config,
      // Spread rather than passed through: `GuardLogFields` is a closed shape
      // with no index signature, which the logger port asks for.
      logger: { warn: (fields, message) => deps.logger.warn({ ...fields }, message) },
      getState: () => this.getState(),
      getRealizedLossLamportsToday: async () => deps.ledger.getRealizedLossLamportsToday(this.now()),
      getUnacknowledgedOrphanCount: async () => deps.ledger.getUnacknowledgedOrphanCount(),
    };
    this.broker = guarded(deps.broker, guardDeps);

    // The screener owns the transition detection; the tracker only forwards, so
    // there is exactly one definition of "degraded".
    deps.screener.on('sellability-degraded', (payload: unknown) => {
      this.record('sellability-degraded', payload);
    });

    deps.stream.on('swap', (swap: TrackedSwap) => this.onSwap(swap));
    deps.stream.on('error', (error: Error) => this.recordError(error, 'wallet stream'));

    // Forwarded so the soak digest can count them. All four are observations
    // about the feed rather than about the market, which is why none of them
    // is a recorded session input — the recorder classifies them as excluded
    // outputs by name, and a fifth one nobody added to that list would show up
    // as `unmodeled` rather than vanishing.
    deps.stream.on(
      'unparsed',
      (
        result: { reason?: string; signature?: string },
        context?: { wallet?: Address; slot?: number; source?: string },
      ) => {
        this.record('swap-unparsed', {
          reason: result.reason ?? 'UNKNOWN',
          signature: result.signature,
          // Attribution, so a later measurement over these does not have to
          // reconstruct which wallet they belonged to or where on the chain
          // they sat. No existing session file gains these retroactively.
          wallet: context?.wallet,
          slot: context?.slot,
          source: context?.source,
        });
      },
    );
    deps.stream.on('disconnected', (payload: unknown) => {
      this.record('stream-disconnected', { ...(payload as object), at: this.now() });
    });
    deps.stream.on('reconnected', (payload: unknown) => {
      this.record('stream-reconnected', { ...(payload as object), at: this.now() });
    });
    deps.stream.on('gap-filled', (payload: unknown) => {
      this.record('stream-gap-filled', payload);
    });
    deps.stream.on('fetch-window', (payload: unknown) => {
      this.record('stream-fetch-window', payload);
    });
    deps.stream.on('queue-overflow', (payload: unknown) => {
      this.record('stream-queue-overflow', payload);
    });
    deps.stream.on('unknown-subscription', (payload: unknown) => {
      this.record('stream-unknown-subscription', payload);
    });
  }

  // -- state ----------------------------------------------------------------

  getState(): BotState {
    // `startedAt` is set iff status !== 'idle', per the type's invariant, so it
    // is spread in rather than written as `undefined` (which
    // `exactOptionalPropertyTypes` would reject anyway).
    return {
      mode: this.deps.config.mode,
      status: this.status,
      killSwitchEngaged: this.killSwitchEngaged,
      ...(this.startedAt === undefined ? {} : { startedAt: this.startedAt }),
    };
  }

  private setStatus(status: BotStatus): void {
    if (this.status === status) return;
    this.status = status;
    if (status === 'idle') this.startedAt = undefined;
    this.record('state-change', this.getState());
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Reconcile from disk, open the wallet subscriptions, start the loops.
   *
   * Strictly ordered. Reconciliation runs before anything can produce an
   * intent, because until it has run the ledger does not know whether a
   * previous run left a holding it cannot see — and that is the state the
   * orphan gate exists to hold entries shut against.
   *
   * A dirty report does **not** stop the start. Orphans already block every buy
   * at guard gate 0, which is a stronger and more durable mechanism than
   * refusing to boot; and refusing to boot would also deny the operator the
   * exits and the monitoring they need in order to resolve it. Both orphans and
   * open positions are logged *and* emitted — a `reconciled` event carries them
   * to any attached client, so "we started holding three things" cannot be
   * something only the log file knows.
   */
  async start(): Promise<ReconcileReport> {
    if (this.starting || this.status !== 'idle') {
      throw new TrackerStateError(
        `cannot start while ${this.starting ? 'already starting' : this.status}`,
        this.status,
      );
    }
    this.starting = true;

    try {
      // Before reconciliation, so a session covers the whole run including what
      // the previous one left behind.
      this.openRecorder();

      const report = this.deps.ledger.reconcileOnStartup(this.now());

      if (report.orphaned.length > 0) {
        this.deps.logger.warn(
          { orphans: report.orphaned.map((orphan) => orphan.id) },
          `${report.orphaned.length} crash orphan(s) await sign-off — every buy is blocked until \`npm run orphans\` clears them`,
        );
      }
      if (report.openPositions.length > 0) {
        this.deps.logger.warn(
          { mints: report.openPositions.map((position) => position.mint) },
          `Resuming with ${report.openPositions.length} open position(s) from a previous run`,
        );
      }
      this.record('reconciled', {
        openPositions: report.openPositions.map((position) => position.mint),
        orphaned: report.orphaned.map((orphan) => ({
          id: orphan.id,
          mint: orphan.mint,
          side: orphan.side,
        })),
        recovered: report.recovered.map((intent) => intent.id),
        dirty: report.dirty,
      });

      await this.deps.stream.start();

      this.startedAt = this.now();
      this.setStatus('running');
      this.ensureLoops();

      return report;
    } finally {
      this.starting = false;
    }
  }

  /**
   * Stop taking new entries, let in-flight work finish, close subscriptions.
   *
   * Sells nothing. See the module header for why this converges instead of
   * throwing, and why the monitoring loops outlive it.
   */
  async stop(): Promise<void> {
    if (this.status === 'idle') return;
    if (this.stopping !== undefined) return this.stopping;

    this.stopping = (async () => {
      try {
        // First, and before any await: `status !== 'running'` is what guard gate
        // 2 reads, so an entry racing this call is already refused. Sells are
        // untouched — `guardSell` never looks at status.
        this.setStatus('stopping');

        // In-flight intents are allowed to finish. Abandoning one would leave a
        // `pending` row that the next start reports as a crash orphan, which is
        // a wallet-checking chore invented by an orderly shutdown.
        await Promise.allSettled([...this.inFlight]);

        this.deps.stream.stop();
        // Flushed and closed before idle is announced, so a client that sees
        // `idle` can read a complete file.
        await this.closeRecorder();
        this.setStatus('idle');
        // Loops keep running while anything is held; this only tears them down
        // when the book is empty.
        this.maybeStopLoops();
      } finally {
        this.stopping = undefined;
      }
    })();

    return this.stopping;
  }

  /**
   * Liquidate everything, now.
   *
   * Runs from any state, including `idle`, and is never reached by `stop()`.
   * `emergencyExitAll` bypasses the guard layer entirely, so it completes with
   * the kill switch engaged and the daily loss cap breached — which is the
   * whole point: a risk limit exists to stop the bot acquiring exposure, and
   * applying one to the panic exit would trap the bot in exactly the position
   * the limit was warning about.
   *
   * Returns rather than throws on a partial exit. A mint that could not be sold
   * is the single most important thing to surface, and it must reach the caller
   * alongside the fills that did land, not instead of them.
   */
  async flatten(): Promise<FlattenResult> {
    this.deps.logger.warn({ status: this.status }, 'FLATTEN: liquidating every open position');

    try {
      const completed = await this.broker.emergencyExitAll();
      for (const fill of completed) this.record('fill', fill);
      return { completed, failures: [] };
    } catch (cause) {
      // `EmergencyExitIncompleteError` carries both halves. Typed structurally
      // rather than imported, so the tracker does not depend on the paper
      // broker's error classes.
      const partial = cause as {
        completed?: Fill[];
        failures?: ReadonlyArray<{ mint: Address; cause: unknown }>;
      };
      if (!Array.isArray(partial.completed) || !Array.isArray(partial.failures)) {
        this.recordError(cause as Error, 'flatten');
        throw cause;
      }

      for (const fill of partial.completed) this.record('fill', fill);
      const failures = partial.failures.map((failure) => ({
        mint: failure.mint,
        reason: (failure.cause as Error)?.message ?? String(failure.cause),
      }));
      for (const failure of failures) {
        this.deps.logger.error(
          { mint: failure.mint, reason: failure.reason },
          `FLATTEN could not exit ${failure.mint} — it is still held`,
        );
      }
      this.record('error', { source: 'flatten', failures });
      return { completed: partial.completed, failures };
    }
  }

  /**
   * Block every new entry, immediately and durably.
   *
   * Takes effect before this returns: the flag is in memory as well as on disk,
   * and guard gate 1 reads the in-memory copy. Sells stay available — the guard
   * layer's exit path never consults it.
   */
  setKillSwitch(engaged: boolean): void {
    if (this.killSwitchEngaged === engaged) return;
    // Memory first, so an entry racing the disk write is already refused.
    this.killSwitchEngaged = engaged;
    this.deps.runtime.setKillSwitch(engaged, this.now());
    this.deps.logger.warn(
      { killSwitchEngaged: engaged },
      engaged ? 'KILL SWITCH ENGAGED — no new positions' : 'Kill switch released',
    );
    this.record('state-change', this.getState());
  }

  /** Engage. The direction the API exposes. */
  killSwitch(): void {
    this.setKillSwitch(true);
  }

  /**
   * Release. Deliberately **not** on the HTTP API.
   *
   * `BotState` says the kill switch "can only be cleared by an explicit
   * operator action". A POST from anything that can reach localhost is not that;
   * releasing is a decision someone makes at the console, having looked.
   */
  releaseKillSwitch(): void {
    this.setKillSwitch(false);
  }

  /** Tear everything down, for process exit. Does not sell. */
  async shutdown(): Promise<void> {
    await this.stop();
    this.stopLoops();
    // `stop()` closes it on the normal path; this covers a shutdown from idle.
    await this.closeRecorder();
  }

  /** The session this run is writing, if any. */
  get session(): SessionRecorder | undefined {
    return this.recorder;
  }

  private openRecorder(): void {
    const recording = this.deps.recording;
    if (recording === undefined || !recording.enabled || this.recorder !== undefined) return;

    const recorder = new SessionRecorder({
      directory: recording.directory,
      now: this.now,
      maxBytes: recording.maxBytes,
      retentionDays: recording.retentionDays,
      secrets: recording.secrets,
      logger: { warn: (fields, message) => this.deps.logger.warn(fields, message) },
    });
    recorder.attach(this);
    this.recorder = recorder;
    this.deps.logger.info({ session: recorder.path }, `Recording to ${recorder.path}`);
  }

  private async closeRecorder(): Promise<void> {
    const recorder = this.recorder;
    if (recorder === undefined) return;
    this.recorder = undefined;
    await recorder.close();
    this.deps.logger.info(
      {
        written: recorder.stats.written,
        dropped: recorder.stats.dropped,
        unmodeled: recorder.stats.unmodeled,
        rotations: recorder.stats.rotations,
      },
      `Session closed: ${recorder.stats.written} lines, ${recorder.stats.dropped} dropped`,
    );
  }

  // -- execution ------------------------------------------------------------

  /**
   * The one execution pipeline: record, guard, execute, resolve, emit.
   *
   * The intent row is committed **before** the broker is reached, so a process
   * that dies mid-swap leaves evidence it was trying something. The broker
   * writes the same row defensively; `INSERT OR IGNORE` makes the second write
   * a no-op rather than a reset.
   */
  async submit(intent: OrderIntent): Promise<Fill> {
    // Gate 0, run here as well as inside `guarded()`, and deliberately BEFORE
    // the ledger write — the same pure function, so the two cannot drift.
    //
    // It has to come first because a malformed amount may not be representable
    // in SQLite at all: `NaN` binds as NULL against `amount INTEGER NOT NULL`,
    // so "write the intent, then let the gate refuse it" is not available — the
    // write is what would fail. Refusing before the write reports the rejection
    // under its own code instead of disguising it as a storage failure.
    const malformed = malformedIntentReason(intent);
    if (malformed !== null) throw this.refuse(intent, 'MALFORMED_INTENT', malformed);

    // ── PERSISTENCE IS THE PRECONDITION FOR EMISSION ──────────────────────
    //
    // Nothing is announced that is not on disk. An `intent-created` with no
    // `intents` row, or a `fill` with no `fills` row, is the event stream
    // telling a client something the source of truth will deny — which is
    // exactly what `INSERT OR IGNORE` produced before it was narrowed.
    //
    // The write is verified by reading it back rather than by trusting that it
    // did not throw. That is not paranoia: the measured failure was a write
    // that returned normally and stored nothing.
    try {
      this.deps.ledger.recordIntent(intent, this.now());
      if (this.deps.ledger.getIntentStatus(intent.id) === undefined) {
        throw new Error('the intents row is absent after a write that reported success');
      }
    } catch (cause) {
      throw this.refuse(
        intent,
        LEDGER_WRITE_FAILED,
        `could not record the intent: ${(cause as Error).message}`,
      );
    }

    this.stats.intents += 1;
    this.record('intent-created', {
      id: intent.id,
      side: intent.side,
      mint: intent.mint,
      reason: intent.reason,
      // Carried on the event for the same reason the freshness check lives in
      // `guards.ts` rather than in the strategy: a refusal nobody can quantify
      // is not a measurement. "STALE_SIGNAL fired 50 times" says the window is
      // biting; "and every one was 20 minutes old" says why. Both fields are
      // absent for an operator's manual buy and for every exit, which is
      // exactly the population the gate does not apply to.
      //
      // Note this reaches the event stream only. `intents.rejection_code`
      // records that the refusal happened, but the ledger has no column for the
      // age itself and `db/ledger.ts` is out of scope for this change.
      ...(intent.signalAt === undefined ? {} : { signalAt: intent.signalAt }),
      ...(intent.signalAgeMs === undefined ? {} : { signalAgeMs: intent.signalAgeMs }),
    });

    const work = (async (): Promise<Fill> => {
      try {
        const fill = await this.broker.execute(intent);

        // Same precondition on the way out. The broker writes the fill and
        // resolves the intent inside `execute`; this confirms the row survived
        // before anything is told that a trade happened.
        if (!this.deps.ledger.getFillsForIntent(intent.id).some((row) => sameFill(row, fill))) {
          throw this.refuse(
            intent,
            LEDGER_WRITE_FAILED,
            'the broker returned a fill that is not in the fills table',
          );
        }

        this.stats.fills += 1;
        this.record('fill', fill);
        return fill;
      } catch (cause) {
        // Already recorded, resolved and emitted by `refuse`.
        if (cause instanceof LedgerWriteError) throw cause;

        if (cause instanceof GuardRejection) {
          const rejectionCode = rejectionCodeOf(cause);
          // The broker never saw this intent, so nothing else will resolve it.
          this.deps.ledger.resolveIntent(intent.id, 'rejected', rejectionCode, this.now());
          this.stats.rejections += 1;
          const event: RejectionEvent = {
            intentId: cause.intentId,
            side: cause.side,
            mint: cause.mint,
            code: cause.code,
            rejectionCode,
            reason: cause.reason,
            ...(intent.signalAgeMs === undefined ? {} : { signalAgeMs: intent.signalAgeMs }),
          };
          this.record('rejection', event);
        } else {
          this.recordError(cause as Error, `execute ${intent.id}`);

          // The broker resolves its own failures — but only once it has been
          // reached. Guard gates 7 and 8 `await inner.getQuote()` and
          // `inner.canSell()` with no `try`, so a quote outage or a screener
          // throw comes out of `guarded().execute` as something that is not a
          // `GuardRejection`, ahead of the inner broker. Nothing downstream had
          // recorded the intent, nothing above recognised the error, and the row
          // stayed `pending` for ever — six of them in session 23, which
          // `reconcileOnStartup` then turned into `CRASH_ORPHAN`s that shut the
          // entry gate until an operator cleared them by hand.
          //
          // Conditional on the status, not unconditional: when the broker DID
          // run and resolved this itself, that resolution is the accurate one
          // and must not be relabelled by whoever unwinds last.
          if (this.deps.ledger.getIntentStatus(intent.id) === 'pending') {
            this.deps.ledger.resolveIntent(
              intent.id,
              'failed',
              (cause as Error).name || 'EXECUTION_ERROR',
              this.now(),
            );
          }
        }
        throw cause;
      }
    })();

    // Tracked before it is awaited, so `stop()` cannot slip between the two.
    this.inFlight.add(work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(work);
    }
  }

  /**
   * Refuse an intent before it ever reaches execution, and leave a record.
   *
   * One path for the two failures that can happen ahead of the broker — a
   * malformed intent and a ledger write that did not stick. Both resolve the
   * intent `rejected` with a machine-readable code and emit a `rejection`, so
   * they are counted the same way a guard refusal is. The alternative, which
   * the measured behaviour actually did, is a `RangeError` thrown from three
   * layers down with the intent marked `failed` — a word that means "we tried
   * and something went wrong on chain", which is not what happened.
   *
   * `resolveIntent` is an UPDATE: it is a no-op when the row could not be
   * written, which is the malformed case. The rejection is still emitted, and
   * the log line says the record could not be kept.
   */
  private refuse(intent: OrderIntent, code: string, reason: string): Error {
    let persisted = false;
    try {
      this.deps.ledger.resolveIntent(intent.id, 'rejected', code, this.now());
      persisted = this.deps.ledger.getIntentStatus(intent.id) === 'rejected';
    } catch {
      // A ledger that cannot even record the refusal must not turn the refusal
      // into a crash.
    }

    this.stats.rejections += 1;
    const event: RejectionEvent = {
      intentId: intent.id,
      side: intent.side,
      mint: intent.mint,
      code,
      rejectionCode: code,
      reason,
      ...(intent.signalAgeMs === undefined ? {} : { signalAgeMs: intent.signalAgeMs }),
    };
    this.record('rejection', event);
    this.deps.logger.warn(
      { code, reason, intentId: intent.id, side: intent.side, mint: intent.mint, persisted },
      `Refused ${intent.side} of ${intent.mint}: ${reason}`,
    );

    return code === LEDGER_WRITE_FAILED
      ? new LedgerWriteError(reason)
      : new GuardRejection('MALFORMED_INTENT', reason, intent);
  }

  // -- the loops ------------------------------------------------------------

  private ensureLoops(): void {
    if (this.priceHandle === undefined) {
      this.priceHandle = this.scheduler.setInterval(() => {
        void this.priceTick();
      }, this.priceIntervalMs);
    }
    if (this.screenHandle === undefined) {
      this.screenHandle = this.scheduler.setInterval(() => {
        void this.screenTick();
      }, this.screenIntervalMs);
    }
    if (this.heartbeatHandle === undefined) {
      this.heartbeatHandle = this.scheduler.setInterval(() => {
        // `healthy` is `true` because this process has no cheap independent
        // liveness signal: the only thing that could contradict the socket is
        // another network call, and the provider rate-limits at ~10 rps. So the
        // silence limb is the detector here, and the `missedHeartbeats` limb is
        // reserved for an injected health probe that does not exist yet. Stated
        // rather than papered over with a signal that always agrees.
        const torn = this.deps.stream.heartbeat?.(true) ?? false;
        if (torn) {
          this.recordError(
            new Error(`wallet stream torn down: silent for at least ${SILENCE_TIMEOUT_MS}ms`),
            'stream heartbeat',
          );
        }
      }, this.heartbeatIntervalMs);
    }
  }

  private stopLoops(): void {
    if (this.priceHandle !== undefined) {
      this.scheduler.clearInterval(this.priceHandle);
      this.priceHandle = undefined;
    }
    if (this.screenHandle !== undefined) {
      this.scheduler.clearInterval(this.screenHandle);
      this.screenHandle = undefined;
    }
    if (this.heartbeatHandle !== undefined) {
      this.scheduler.clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = undefined;
    }
  }

  /**
   * Tear the loops down only when idle **and** flat.
   *
   * A stopped bot that is still holding is exactly when the alerts matter most:
   * `stop()` deliberately did not sell, so the operator is sitting on a book
   * with no strategy watching it. Losing `route-lost` at that moment would
   * mean the position became unexitable in silence.
   */
  private maybeStopLoops(): void {
    if (this.status !== 'idle') return;
    if (this.deps.ledger.getOpenPositions().length > 0) return;
    this.stopLoops();
  }

  /**
   * Quote the exit for every open position.
   *
   * The probe is the real exit — the whole position, to SOL — not a fixed-size
   * price sample. It is the number that matters, and a `NO_ROUTE` on it is the
   * literal statement "this position cannot be sold right now".
   *
   * `route-lost` fires on the **transition** into no-route, not on every tick.
   * A 2-second alert repeat is a log line wearing an alert's clothes; the edge
   * is the event. Recovery clears the latch, so a mint that goes unroutable
   * again alerts again.
   */
  async priceTick(): Promise<void> {
    if (this.priceTickRunning) return;
    this.priceTickRunning = true;
    this.stats.priceTicks += 1;

    try {
      const open = this.deps.ledger.getOpenPositions();
      for (const position of open) {
        const result = await this.deps.quotes.getQuote({
          inMint: position.mint,
          outMint: WRAPPED_SOL_MINT,
          inAmount: position.tokens,
          slippageBps: this.deps.config.maxSlippageBps,
        });

        if (isQuoteError(result)) {
          if (result.error === 'NO_ROUTE') {
            if (!this.routeLost.has(position.mint)) {
              this.routeLost.add(position.mint);
              const event: RouteLostEvent = {
                mint: position.mint,
                tokens: position.tokens.toString(),
                reason: result.message,
                at: this.now(),
              };
              this.deps.logger.error(
                { mint: position.mint, tokens: position.tokens.toString() },
                `ROUTE LOST for held ${position.mint} — there is currently no way out of this position`,
              );
              this.record('route-lost', event);
            }
          } else {
            // A timeout or an upstream failure is a fact about us, not about the
            // token. Recording it as a lost route would cry wolf, and the wolf
            // here is a trapped position.
            this.deps.logger.warn(
              { mint: position.mint, error: result.error, message: result.message },
              `Could not price held ${position.mint}: ${result.error}`,
            );
          }
          continue;
        }

        this.routeLost.delete(position.mint);
        const wholeTokens = baseUnitsToTokens(position.tokens, position.decimals);
        if (wholeTokens <= 0) continue;

        // Lamports per whole token, floor-divided: this marks a position, and
        // a rounded-down mark understates an unrealized gain rather than
        // overstating one.
        const perToken = (result.outAmount * 10n ** BigInt(position.decimals)) / position.tokens;
        this.marks.set(position.mint, { lamportsPerToken: perToken, at: this.now() });

        if (this.driver === null) continue;

        // The float exit price, NOT `lamportsToSol(perToken)`. `perToken` is
        // floored to whole lamports, which rounds a sub-lamport token's price
        // to zero — and a strategy comparing that against `avgEntrySol` would
        // read a total loss on a token that had merely not moved. This is the
        // same ratio `avgEntrySol` is (SOL over whole tokens), so the two are
        // directly comparable, and both are fee-inclusive in their own
        // direction: entry cost includes what was paid, this is net of what the
        // route would take on the way out.
        const priceSol = lamportsToSol(result.outAmount) / wholeTokens;

        // Awaited, not fired and forgotten. The tick already awaits a network
        // quote per position, and the runner's 500ms ceiling bounds this to
        // less; awaiting is what makes the order of intents a function of the
        // order of positions, which is what Prompt 12's replay needs. A tick
        // that overruns its 2s interval is skipped by `priceTickRunning`, and
        // that shows up in `stats.priceTicks` rather than silently stacking.
        await this.driver.onPriceTick(position, priceSol);
      }
    } finally {
      this.priceTickRunning = false;
      this.maybeStopLoops();
    }
  }

  /**
   * Screen every held mint, sequentially.
   *
   * Sequential rather than parallel on purpose: the screener's own concurrency
   * cap would bound it anyway, but running one at a time means the 250ms
   * DexScreener floor is never the thing doing the waiting, and a slow provider
   * cannot make one tick overlap the next. The per-mint latch is the second
   * half of that — a screen still running when the next tick fires is skipped,
   * not queued.
   *
   * Alerting only. Nothing here creates an intent or blocks an exit.
   */
  async screenTick(): Promise<void> {
    if (this.screenTickRunning) return;
    this.screenTickRunning = true;
    this.stats.screenTicks += 1;

    try {
      for (const position of this.deps.ledger.getOpenPositions()) {
        if (this.screensInFlight.has(position.mint)) continue;
        this.screensInFlight.add(position.mint);
        try {
          await this.deps.screener.screenHeldPosition(position.mint, {
            sizeSol: this.deps.config.positionSizeSol,
          });
        } catch (cause) {
          this.recordError(cause as Error, `screen ${position.mint}`);
        } finally {
          this.screensInFlight.delete(position.mint);
        }
      }
    } finally {
      this.screenTickRunning = false;
      this.maybeStopLoops();
    }
  }

  // -- reads ----------------------------------------------------------------

  positions(): MarkedPosition[] {
    return this.deps.ledger.getOpenPositions().map((position) => {
      const mark = this.marks.get(position.mint);
      return {
        ...position,
        markLamportsPerToken: mark?.lamportsPerToken ?? null,
        markedAt: mark?.at ?? null,
        routeLost: this.routeLost.has(position.mint),
      };
    });
  }

  /** Buffered events, newest last. `sinceSeq` returns only what follows it. */
  recentEvents(sinceSeq?: number): TrackerEventRecord[] {
    if (sinceSeq === undefined) return [...this.events];
    return this.events.filter((event) => event.seq > sinceSeq);
  }

  // -- wiring ---------------------------------------------------------------

  /**
   * Attach the thing that decides what to trade.
   *
   * One call, at the composition root. Passing `null` detaches, which returns
   * the tracker to a pure observer — every loop, mark and alert keeps working
   * and nothing creates an intent.
   */
  useStrategy(driver: StrategyDriver | null): void {
    this.driver = driver;
    if (driver === null) return;
    // The runner owns the definition of a strategy failure; the tracker only
    // carries it into the event buffer and out to any attached client.
    driver.on('strategy-error', (payload: unknown) => this.record('strategy-error', payload));
  }

  /**
   * A tracked wallet swapped.
   *
   * The stream runs at `confirmed` commitment and is about someone else's
   * wallet, so this is a hint and never a record — handoff 07 is explicit that
   * nothing may write a position from a stream event. What it may do is ask the
   * strategy, and only while the bot is **running**.
   *
   * That gate is the entry side of the asymmetry the whole system is built on.
   * `stop()` means "no new exposure"; if a swap could still open a position
   * while stopping or idle, stop would not mean that. It is not merely that
   * guards would reject the buy afterwards — it would reject it as
   * `NOT_RUNNING`, filling the intents table with entries the operator never
   * wanted and that Prompt 12 would then count as risk-limit activity.
   *
   * Exits are unaffected: `onPriceTick` runs in every state.
   */
  private onSwap(swap: TrackedSwap): void {
    this.record('swap-detected', swap);

    const driver = this.driver;
    if (driver === null || this.status !== 'running') return;

    // Tracked in `inFlight` so `stop()` waits for it. The runner's 500ms
    // timeout bounds that wait, and the alternative — a strategy call still
    // running as the process goes idle — is how an intent gets written after
    // the ledger has been reconciled.
    const work = driver.onTrackedSwap(swap).catch((cause: unknown) => {
      // The runner catches everything a strategy can do; reaching here means
      // the runner itself failed, which is ours and must still not propagate
      // into the stream's callback.
      this.recordError(cause as Error, `strategy onTrackedSwap ${swap.mint}`);
    });
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  // -- event plumbing -------------------------------------------------------

  private record(type: TrackerEventName, data: unknown): void {
    const event: TrackerEventRecord = { seq: this.nextSeq++, type, at: this.now(), data };
    this.events.push(event);
    if (this.events.length > this.eventBufferSize) {
      this.events.splice(0, this.events.length - this.eventBufferSize);
    }

    // `EventEmitter` throws on an unhandled 'error', which would turn a logged
    // problem into a crash. The buffer and the log already have it, so the emit
    // is conditional; every other event emits unconditionally.
    if (type !== 'error' || this.listenerCount('error') > 0) {
      this.emit(type, data);
    }
    this.emit('event', event);
  }

  private recordError(error: Error, source: string): void {
    this.deps.logger.error({ source, error: error.message }, `${source}: ${error.message}`);
    this.record('error', { source, message: error.message, name: error.name });
  }
}

/**
 * The code written to `intents.rejection_code`.
 *
 * A plain `GuardCode` for everything except a screener refusal, where the
 * screener's own verdict is appended. `CANNOT_SELL` alone cannot distinguish
 * "a check ran and this token is bad" from "a check could not run", and handoff
 * 08 built three verdicts specifically so that an adversarial market and a
 * broken data provider stay separable in the record.
 */
export function rejectionCodeOf(rejection: GuardRejection): string {
  if (
    rejection.code === 'CANNOT_SELL' &&
    (rejection.reason.startsWith('SCREEN_FAILED:') ||
      rejection.reason.startsWith('SCREEN_UNKNOWN:'))
  ) {
    return `${rejection.code}:${rejection.reason}`;
  }
  return rejection.code;
}

/** Whole-SOL view of a marked position, for display. Never an accounting input. */
export function markSol(position: MarkedPosition): number | null {
  return position.markLamportsPerToken === null
    ? null
    : lamportsToSol(position.markLamportsPerToken);
}

// ---------------------------------------------------------------------------
// The composition root
// ---------------------------------------------------------------------------

/**
 * Everything a real run owns. Constructed here and nowhere else.
 *
 * This is the only function in the codebase that opens a database, creates an
 * HTTP client or a websocket. Every module below it takes its collaborators as
 * arguments, which is what makes the whole stack testable without a network —
 * and what makes this one function the place to look when asking "what is this
 * process actually talking to".
 */
export interface TrackerRuntime {
  tracker: Tracker;
  ledger: Ledger;
  fills: FillsView;
  config: Config;
  /** Ledger snapshots, off this volume. See `services/ledgerDurability.ts`. */
  snapshots: LedgerSnapshotter;
  /**
   * The wallet cursors. Exposed for `barrierStats()`, so a soak REPORTS the
   * cursor barrier's peak rather than assuming it stayed small — and so a
   * wallet still held at exit surfaces as a number instead of as a frozen
   * cursor nobody notices until the next restart.
   */
  cursors: CursorStore;
  /** Closes every handle. Stops the tracker first; sells nothing. */
  close(): Promise<void>;
}

export interface TrackerRuntimeOptions {
  config: Config;
  /**
   * SQLite file. Three connections open it — ledger, cursors, runtime flags —
   * plus a read-only one for the fills listing, which is why `:memory:` is
   * rejected: in-memory databases are per-connection, so the four would not be
   * the same database.
   */
  dbPath: string;
  /** `RPC_HTTP_URL`. Carries the provider key; never logged. */
  rpcHttpUrl: string;
  /** `RPC_WSS_URL`. */
  rpcWssUrl: string;
  /** `JUPITER_API_KEY`. Absent selects the rate-limited free host. */
  jupiterApiKey?: string;
  /**
   * The array `WalletStream` subscribes from, in place of `config.trackedWallets`.
   *
   * Passed by identity, not by value: `WalletStream` reads it at every subscribe
   * and every gap fill, so whoever owns the array can edit the watchlist and have
   * the next `start()` pick it up without a process restart.
   * `services/walletStore.ts` is that owner. Absent copies the config's list,
   * which is the behaviour every caller had before the screener existed.
   */
  walletAddresses?: Address[];
  logger?: TrackerLogger;
  /**
   * Recording, with prompt 13's defaults.
   *
   * NOT in `config.json` — see `RECORDING_DEFAULTS`. Every field falls back to
   * an environment variable and then to the specified default.
   */
  recordSessions?: boolean;
  sessionDir?: string;
  sessionMaxBytes?: number;
  sessionRetentionDays?: number;
  /**
   * Start with an empty ledger even though `sessionDir` is non-empty.
   *
   * The genuine first-run escape hatch. Falls back to `ALLOW_EMPTY_LEDGER`.
   * See `services/ledgerDurability.ts` for why the refusal exists at all.
   */
  allowEmptyLedger?: boolean;
  /** Where snapshots go. Falls back to `LEDGER_SNAPSHOT_DIR`, then off-volume. */
  snapshotDir?: string;
  snapshotIntervalMs?: number;
  snapshotKeep?: number;
}

/** Thrown when the runtime cannot be built as configured. */
export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigError';
  }
}

export function createTrackerRuntime(options: TrackerRuntimeOptions): TrackerRuntime {
  const { config } = options;

  if (config.mode === 'live') {
    // `acknowledgeLiveRisk` gates the *config*; this gates the *code*. There is
    // no live broker — only `paperBroker.ts` implements `Broker` — so a live
    // run would silently be a paper run against a funded wallet's balance.
    throw new RuntimeConfigError(
      'mode is "live" but no live broker exists yet: only the paper broker implements Broker. ' +
        'Set mode to "paper" — a live run would simulate every fill while claiming not to.',
    );
  }
  if (options.dbPath === ':memory:') {
    throw new RuntimeConfigError(
      'dbPath cannot be ":memory:" — the ledger, cursors, runtime flags and the fills view ' +
        'open separate connections, and an in-memory database is private to one connection.',
    );
  }

  const logger = options.logger ?? createPinoLogger();

  // Every secret this process holds, so the recorder can strip them from a line
  // wherever they turn up — including inside an error message or a stack trace,
  // which is exactly where nobody thinks to look.
  const secrets = [options.rpcHttpUrl, options.rpcWssUrl, options.jupiterApiKey]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .flatMap((value) => [value, ...queryValues(value)]);

  const recording: RecordingOptions = {
    enabled: options.recordSessions ?? envBool('RECORD_SESSIONS', RECORDING_DEFAULTS.recordSessions),
    directory: options.sessionDir ?? process.env['SESSION_DIR'] ?? RECORDING_DEFAULTS.sessionDir,
    maxBytes:
      options.sessionMaxBytes ?? envInt('SESSION_MAX_BYTES', RECORDING_DEFAULTS.sessionMaxBytes),
    retentionDays:
      options.sessionRetentionDays ??
      envInt('SESSION_RETENTION_DAYS', RECORDING_DEFAULTS.sessionRetentionDays),
    secrets,
  };

  // BEFORE `openLedger`, which creates the file it is given: after that call the
  // evidence of absence is gone. An empty ledger beside recorded sessions means
  // the database was removed, not that this is a first run — session 22 started
  // clean on a destroyed ledger and the only symptom was thirteen truncated cold
  // fills. `ALLOW_EMPTY_LEDGER=1` is the documented override.
  assertLedgerPresent({
    dbPath: options.dbPath,
    sessionsDir: recording.directory,
    ...(options.allowEmptyLedger === undefined ? {} : { allowEmpty: options.allowEmptyLedger }),
  });

  const ledger = openLedger({
    path: options.dbPath,
    logger: { info: logger.info.bind(logger), warn: logger.warn.bind(logger) },
  });
  const cursors = openCursorStore({ path: options.dbPath });
  const runtime = openRuntimeState({ path: options.dbPath });

  // Late-bound: the recorder is opened by `start()`, but the decorators below
  // are built now. They ask the tracker for the current session on every call,
  // so a run that starts, stops and starts again records into both files
  // without anything being rewired.
  let trackerRef: Tracker | undefined;
  const session = (): SessionRecorder | undefined => trackerRef?.session;

  const rpc = createRpcClient({ httpUrl: options.rpcHttpUrl });
  const liveQuotes = createJupiterQuoteSource({
    config,
    ...(options.jupiterApiKey === undefined ? {} : { apiKey: options.jupiterApiKey }),
    logger: { error: (fields, message) => logger.error(fields, message) },
  });
  // Every quote the broker and the price loop make goes through the recorder.
  const quotes: QuoteSource = {
    getQuote: (request) => {
      const active = session();
      return active === undefined
        ? liveQuotes.getQuote(request)
        : active.wrapQuotes(liveQuotes).getQuote(request);
    },
  };
  const dexscreener = createDexScreenerClient();

  const screener = new SafetyScreener({
    rpc,
    // The screener quotes through the same recording seam, so a replay has the
    // reverse legs the round-trip check made and not only the broker's quotes.
    quotes,
    dexscreener,
    minLiquidityUsd: config.minLiquidityUsd,
    logger: { warn: (fields, message) => logger.warn(fields, message) },
  });

  // Decimals come from the same mint account the screener already reads, which
  // is what `mintMetadata.ts` said should happen once the screener existed: one
  // RPC path, one answer, and the resolver's permanent cache in front of it.
  const resolveDecimals = createDecimalsResolver({
    lookup: async (mint) => {
      const account = await rpc.getParsedMintAccount(mint);
      return account?.data.parsed.info.decimals;
    },
  });

  const broker = createPaperBroker({
    quoteSource: quotes,
    resolveDecimals,
    ledger,
    config,
    // Buy gate 7, and nowhere else. Absent this the broker still refuses every
    // buy with SCREENER_NOT_IMPLEMENTED — fail-closed is the default, this only
    // overrides it with something that has actually looked.
    canSell: canSellFromScreener(
      {
        screenMint: (mint, opts) => {
          const active = session();
          return active === undefined
            ? screener.screenMint(mint, opts)
            : active.wrapScreener(screener).screenMint(mint, opts);
        },
      },
      { sizeSol: config.positionSizeSol },
    ),
  });

  const stream = new WalletStream({
    wallets: options.walletAddresses ?? [...config.trackedWallets],
    rpc,
    cursors,
    connect: createStreamSocketFactory({ wssUrl: options.rpcWssUrl }),
  });

  const tracker = new Tracker({
    config,
    ledger,
    runtime,
    broker,
    screener,
    quotes,
    stream,
    logger,
    recording,
  });
  trackerRef = tracker;

  // The one call that turns an observer into a trader. Resolving the name here
  // rather than in `core/config.ts` is why a bad `strategy` fails at startup
  // instead of at config parse — loudly, by name, listing what is known.
  const strategy = createStrategy(config.strategy);
  const runner = new StrategyRunner({
    strategy,
    config,
    quotes,
    resolveDecimals,
    logger,
    host: {
      getState: () => tracker.getState(),
      openPositions: () => ledger.getOpenPositions(),
      balanceLamports: () => broker.getBalanceLamports(),
      // `tracker.submit`, NOT `broker.execute`. The runner must reach the same
      // guarded, ledger-writing, event-emitting path an operator does — the
      // strategy replaces what to do, never how.
      submit: (intent) => tracker.submit(intent),
    },
  });
  tracker.useStrategy(
    new Proxy(runner, {
      get(target, property, receiver) {
        if (property === 'onPriceTick') {
          return (position: Position, priceSol: number): Promise<void> => {
            const active = session();
            return active === undefined
              ? target.onPriceTick(position, priceSol)
              : active.wrapDriver(target).onPriceTick(position, priceSol);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  );
  logger.info(
    { strategy: strategy.name, recording: recording.enabled, sessionDir: recording.directory },
    `Strategy "${strategy.name}" attached`,
  );

  const fills = openFillsView({ path: options.dbPath });

  // Start / interval / stop. Subscribed to `state-change` rather than wired into
  // `Tracker.stop()`, because the status-flip ordering in `start()`/`stop()` is
  // load-bearing for guard gate 2 and is not to be disturbed — a listener cannot
  // disturb it. `snapshot()` never throws, so a failing backup cannot stop the
  // bot from starting or from shutting down.
  const snapshots = new LedgerSnapshotter({
    dbPath: options.dbPath,
    ...(options.snapshotDir === undefined ? {} : { directory: options.snapshotDir }),
    ...(options.snapshotIntervalMs === undefined
      ? {}
      : { intervalMs: options.snapshotIntervalMs }),
    ...(options.snapshotKeep === undefined ? {} : { keep: options.snapshotKeep }),
    logger: { info: logger.info.bind(logger), warn: logger.warn.bind(logger) },
  });
  snapshots.start();
  tracker.on('event', (record: { type: string; data: unknown }) => {
    if (record.type !== 'state-change') return;
    // The books are only interesting at rest. A snapshot as the bot goes idle is
    // the one that has to contain the open positions a restart must find.
    const status = (record.data as { status?: string } | undefined)?.status;
    if (status === 'idle') snapshots.snapshot('bot-idle');
  });

  return {
    tracker,
    ledger,
    fills,
    config,
    snapshots,
    // Exposed so a soak can REPORT the barrier's peak rather than assume it.
    // `deferred` is bounded now, but a run that sits near the bound is telling
    // you something about gap-fill length that a bound alone hides.
    cursors,
    async close() {
      await tracker.shutdown();
      // Before the handles close, so the last snapshot has the final state in it.
      snapshots.stop('shutdown');
      fills.close();
      runtime.close();
      cursors.close();
      ledger.close();
    },
  };
}

/** pino, wired once. The only place this process decides how logs are written. */
function createPinoLogger(): TrackerLogger {
  const instance = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });
  return {
    info: (fields, message) => instance.info(fields, message),
    warn: (fields, message) => instance.warn(fields, message),
    error: (fields, message) => instance.error(fields, message),
  };
}
```

---

## `src/services/soak.ts`

```typescript
/**
 * The soak digest — what a long paper run actually did, in one object.
 *
 * Pure and incremental: `SoakDigest` is fed tracker events as they happen and
 * asked for a snapshot whenever somebody wants one. Nothing here reads a clock,
 * a file or a network, so the whole thing is testable without running a soak —
 * which matters, because a 24-hour runner whose reporting is only exercised by
 * running it for 24 hours is a reporting layer nobody has ever checked.
 *
 * ── THE ASSERTION THAT IS NOT A METRIC ────────────────────────────────────
 *
 * `paperBalanceDrift` must be exactly zero. The paper balance is
 * `paperStartingSol + Σ(lamportsDelta - fees)` over the fills, and the digest
 * recomputes that sum independently from the `fill` events it saw. A nonzero
 * difference means the event stream and the ledger disagree about what the bot
 * did — which is the 2026-08-03 class of defect, and it is checked here rather
 * than reported, because a number nobody reads is not a check.
 */

import type { Fill, Lamports, UnixMillis } from '../core/types.js';
import { lamportsToSol } from '../core/units.js';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** Counts keyed by something, always emitted in sorted key order. */
export type Tally = Record<string, number>;

/**
 * Reason codes the parser is known to assign on purpose.
 *
 * ── AN ALLOWLIST, AND THE DIRECTION MATTERS ───────────────────────────────
 *
 * A transaction is `classified` only by MATCHING something here. It never
 * becomes classified by failing to match a denylist, because that is the shape
 * that hides drift: the parser gains a seventh code, nothing here changes, and
 * the new code is silently absorbed into a distribution nobody alarms on.
 * Inverted, the same event trips `unhandled` on its first occurrence.
 *
 * This mirrors `isInfrastructureOnly`, which returns false for a program set it
 * does not recognise rather than assuming an unknown program is infrastructure.
 * There, an unknown venue is admitted as a trade; here, an unknown code is
 * admitted as a defect. Both fail towards being noticed.
 *
 * Every entry is a positive determination the parser reached — including the
 * ones that sound like failures. `MULTI_MINT_DELTA` is a deliberate refusal to
 * guess at a multi-leg route; `TX_FAILED` is a transaction that failed on chain
 * and moved nothing. Neither is the parser meeting something it cannot handle,
 * which is the only thing worth waking somebody for.
 *
 * Kept as string literals rather than imported from `swapParser.ts`'s
 * `UnparsedCode` union, deliberately. Importing it would make the two sets
 * identical BY CONSTRUCTION, and a new code would arrive here already
 * allowlisted — which is precisely the drift this is built to catch. The
 * duplication is the check.
 */
const CLASSIFIED_UNPARSED_CODES: ReadonlySet<string> = new Set([
  'TX_FAILED',
  'NO_MINT_DELTA',
  'MULTI_MINT_DELTA',
  'NO_SOL_LEG',
  'WALLET_NOT_IN_TX',
  'INFRASTRUCTURE_ONLY',
]);

/**
 * What trips the unhandled alarm, and where that number comes from.
 *
 * ── RE-DERIVED IN SESSION 25. THE OLD CONSTANT WAS NOT CARRIED ACROSS ─────
 *
 * The predecessor was `>1% of tracked traffic`, and it measured the wrong
 * population: every unparsed transaction, including the ones the parser had
 * correctly declined. It fired at **97.05%** on `digest-001-final-SIGTERM.json`
 * — a healthy run — and session 24's `INFRASTRUCTURE_ONLY` subtraction, which
 * landed seven minutes after that digest was written and has never run, would
 * have brought it to **46.82%** rather than to green. The 1% was inherited from
 * an exit criterion about program IDs and could name no run and no `n`, so it
 * was re-derived rather than adjusted.
 *
 * Measured across the three most recent soaks — `20260806T152610Z-000`,
 * `20260807T023620Z-000`, `20260807T025234Z-000`, 195.7 minutes combined —
 * every one of **n=7,184** unparsed records carried a code from the allowlist
 * above. The genuine unhandled rate is **0 of 7,184 (0 bps)**. It is also 0
 * across all eleven session files on disk, n=16,474, which is corroboration
 * rather than an independent measurement — the same parser produced both.
 *
 * A rate whose observed value is zero does not get a percentage band; the
 * honest threshold is ANY occurrence. That makes this a zero-threshold
 * invariant like the drift and recorder checks, and it can no longer be moved
 * by traffic mix — which is the whole failure mode being removed.
 */
const UNHANDLED_THRESHOLD = 0;
const UNHANDLED_BASIS =
  'measured 0 unhandled, n=7,184 unparsed records, across the 3 soaks of 2026-08-06/07 (195.7 min combined)';

/**
 * How close together two socket-death events must be to be one death.
 *
 * ── DERIVED IN SESSION 25, FROM TWO POPULATIONS THAT DO NOT OVERLAP ───────
 *
 * A real WebSocket fires `error` and then `close` for a single death and both
 * reach the digest. Measured across the eleven sessions on record: the 56
 * error/close pairs are **0ms min, 0ms p50, 1ms p90, 34ms max**, while the 35
 * gaps between genuinely distinct deaths are **9,946ms at the very smallest**.
 * The populations are separated by a factor of 292, so the window is not a
 * judgement call — anything in (34ms, 9,946ms) classifies every observed event
 * identically.
 *
 * 1,000ms: near the geometric midpoint of that gap (~581ms), 29x above the
 * largest pair seen and 10x inside the closest distinct pair of deaths. Chosen
 * round rather than exact because nothing in the data distinguishes 581 from
 * 1,000, and a number with false precision invites someone to trust it further
 * than the measurement supports.
 */
/** Mirrors `MAX_DEFERRED` in `db/cursors.ts`, for the printed line only. */
const MAX_DEFERRED_REPORTED = 4_096;

const DEATH_DEDUPE_MS = 1_000;
const DEATH_DEDUPE_BASIS =
  'pairs max 34ms (n=56) vs closest distinct deaths 9,946ms (n=35), 11 sessions to 2026-08-07';

export interface SoakSnapshot {
  /**
   * Bumped when a field changes meaning rather than merely being added.
   *
   * Digests written before this existed are schema 0 and are NOT comparable to
   * schema 1 on the stream figures. `stream.disconnects` summed connect-attempt
   * failures with socket deaths and double-counted the deaths, and
   * `reconnectLatencyMs` was measured to a `reconnected` event that could fire
   * for a socket which had already died — so the `p50 36113ms` in
   * `digest-001-final-SIGTERM.json` is an interval that may have ended with no
   * socket. See `docs/digest-schema.md`.
   */
  schema: 1;
  window: { startedAt: UnixMillis; at: UnixMillis; elapsedMs: number };

  /** Tracked swaps, by venue. The denominator for the unparsed ratio below. */
  trackedSwapsByVenue: Tally;
  trackedSwapsTotal: number;

  /**
   * Transactions the swap parser refused, by its reason code.
   *
   * **Not by program ID**, and that is a gap rather than a choice:
   * `UnparsedTransaction` carries `{ signature, reason, detail? }` and no
   * account keys, so the program that produced an unparseable transaction is
   * not available to anything downstream of the parser. The exit criterion
   * "zero unparsed program IDs accounting for >1% of tracked swaps" cannot be
   * evaluated without a change to `swapParser.ts`.
   */
  unparsedByReason: Tally;
  unparsedTotal: number;

  /**
   * Unparsed transactions the parser reached a determination about, by code.
   *
   * **A distribution, not an alarm.** Printed so a sudden move in the mix is
   * still visible — infrastructure traffic going from 5% to 95% is worth
   * seeing — but nothing here is a finding, because every one of these is the
   * parser working. `filteredNonTrades` used to break `INFRASTRUCTURE_ONLY` out
   * of this set as a special case; it is now one code among six and needs no
   * special handling.
   */
  classifiedByCode: Tally;
  classifiedTotal: number;
  /** Classified as a share of all observed transactions, in integer bps. */
  classifiedShareBps: number;

  /**
   * Unparsed transactions with no positive determination, by whatever the
   * reason field held. **This is the alarm.**
   *
   * Nonzero means the parser produced something this module cannot account for:
   * a code it has never been taught, or no code at all. Either way the digest is
   * reporting on a population it does not fully understand, and the share above
   * is that much less trustworthy.
   */
  unhandledByCode: Tally;
  unhandledTotal: number;
  unhandledShareBps: number;

  /** Recorder events with no schema, by tag. Nonzero is the finding. */
  unmodeledByTag: Tally;
  unmodeledTotal: number;

  guardRejectionsByCode: Tally;

  /** Any nonzero entry is a finding: a position that could not be exited. */
  noRouteWhileHeld: Tally;

  stream: {
    /**
     * Sockets that were live and died. The number that says how often the feed
     * actually broke.
     */
    socketDeaths: number;
    /**
     * Retries that never opened a socket. High is not alarming on its own — one
     * outage against a backoff capped at 30s emits one per attempt — but it is
     * how long recovery took.
     */
    connectAttemptFailures: number;
    /** `error`+`close` for one death, collapsed. See `DEATH_DEDUPE_MS`. */
    deathEchoesCollapsed: number;
    reconnects: number;
    /** ms between a disconnect and the reconnect that followed it. */
    reconnectLatencyMs: { count: number; p50: number; max: number };
    gapFills: number;
    signaturesRecovered: number;
    truncatedGapFills: number;
    /**
     * Cursor-barrier peaks. `heldNow` must be 0 in a final digest — a wallet
     * still held at exit is a leaked barrier, which freezes that cursor
     * silently.
     */
    barrier: { peakDeferred: number; peakOutstanding: number; heldNow: number };
  };

  quotes: {
    byError: Tally;
    rateLimited: number;
    cacheHits: number;
    cacheMisses: number;
    cacheHitRateBps: number;
  };

  trades: { buys: number; sells: number; entryIntents: number };

  /** All lamports, as strings — this object is serialized and diffed. */
  money: {
    realizedLamports: string;
    feesLamports: string;
    netFlowLamports: string;
    paperBalanceLamports: string;
    /** MUST be "0". See the header. */
    paperBalanceDrift: string;
  };

  recorder: { written: number; dropped: number; droppedByKind: Tally; rotations: number };

  /** Anything the digest itself considers a failure. Empty is the good case. */
  findings: string[];
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

function sorted(counts: Map<string, number>): Tally {
  const out: Tally = {};
  for (const key of [...counts.keys()].sort()) out[key] = counts.get(key)!;
  return out;
}

function bump(counts: Map<string, number>, key: string, by = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + by);
}

function bps(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.floor((part * 10_000) / whole);
}

export interface SoakDigestOptions {
  startedAt: UnixMillis;
  startingLamports: Lamports;
  /** Reads the ledger's own view, to be compared against the event stream. */
  ledgerNetFlowLamports: () => Lamports;
  /** Recorder counters, or zeros when recording is off. */
  recorderStats?: () => {
    written: number;
    dropped: number;
    droppedByKind: Map<string, number>;
    rotations: number;
    unmodeled: number;
  };
  /** Jupiter's cache counters, when the adapter exposes them. */
  quoteCacheStats?: () => { hits: number; misses: number };
  /** Cursor-barrier bookkeeping, so a soak reports its peak rather than guessing. */
  barrierStats?: () => { peakDeferred: number; peakOutstanding: number; heldNow: number };
}

export class SoakDigest {
  private readonly venues = new Map<string, number>();
  private readonly unparsed = new Map<string, number>();
  private readonly unmodeled = new Map<string, number>();
  private readonly rejections = new Map<string, number>();
  private readonly noRoute = new Map<string, number>();
  private readonly quoteErrors = new Map<string, number>();

  private connectAttemptFailures = 0;
  private socketDeaths = 0;
  private deathEchoes = 0;
  private lastDeathAt: UnixMillis | undefined;
  private reconnects = 0;
  private lastDisconnectAt: UnixMillis | undefined;
  private readonly reconnectLatencies: number[] = [];
  private gapFills = 0;
  private signaturesRecovered = 0;
  private truncatedGapFills = 0;
  private rateLimited = 0;

  private buys = 0;
  private sells = 0;
  private entryIntents = 0;

  /** Recomputed from the `fill` events, independently of the ledger. */
  private eventNetFlow = 0n;
  private fees = 0n;
  private realized = 0n;

  /** Per-mint running cost basis, so realized P&L matches `replayMint`'s rule. */
  private readonly held = new Map<string, { tokens: bigint; cost: bigint }>();

  /**
   * The ledger's cumulative net flow when this run began.
   *
   * The drift check compares the event stream's arithmetic against the ledger's,
   * and `eventNetFlow` only ever counts fills **this process** saw — while
   * `ledgerNetFlowLamports()` is cumulative on disk across every run the file has
   * ever had. On a fresh ledger those are the same number and the check was
   * right; against a pre-existing ledger they differ by exactly the prior runs'
   * flow, and the finding fired on a completely healthy soak.
   *
   * Session 23's first-ever final digest reported `PAPER BALANCE DRIFT of
   * -106789862 lamports`, which was the two open positions it had legitimately
   * inherited. A warning that fires on healthy runs is training to ignore
   * warnings, so the baseline is latched here and the comparison is delta
   * against delta.
   */
  private readonly ledgerFlowAtStart: bigint;

  constructor(private readonly options: SoakDigestOptions) {
    this.ledgerFlowAtStart = options.ledgerNetFlowLamports();
  }

  /**
   * Feed one tracker event.
   *
   * Deliberately total over the event names it knows and silent on the rest:
   * an unrecognised event is the recorder's problem (it becomes `unmodeled`),
   * not the digest's, and duplicating that classification here would give two
   * places to update and one of them would be forgotten.
   */
  observe(type: string, data: unknown): void {
    switch (type) {
      case 'swap-detected': {
        const swap = data as { venue?: string };
        bump(this.venues, swap.venue ?? 'unknown');
        break;
      }
      case 'swap-unparsed': {
        bump(this.unparsed, (data as { reason?: string }).reason ?? 'UNKNOWN');
        break;
      }
      case 'rejection': {
        bump(this.rejections, (data as { code?: string }).code ?? 'UNKNOWN');
        break;
      }
      case 'route-lost': {
        bump(this.noRoute, (data as { mint?: string }).mint ?? 'unknown');
        break;
      }
      case 'intent-created': {
        if ((data as { side?: string }).side === 'buy') this.entryIntents += 1;
        break;
      }
      case 'fill': {
        this.applyFill(data as Fill);
        break;
      }
      case 'stream-disconnected': {
        const event = data as { at?: number; phase?: string };
        if (event.phase === 'connect-attempt') {
          // No socket ever existed. One outage emits one of these per retry,
          // so this is a measure of how long recovery took, not of how often
          // the feed broke.
          this.connectAttemptFailures += 1;
          break;
        }

        // A real WebSocket fires `error` and then `close` for one death, and
        // both reach here. Collapse them, so a death counts once.
        const at = event.at;
        const isEcho =
          at !== undefined &&
          this.lastDeathAt !== undefined &&
          at - this.lastDeathAt <= DEATH_DEDUPE_MS;
        if (isEcho) {
          this.deathEchoes += 1;
          break;
        }

        this.socketDeaths += 1;
        this.lastDeathAt = at;
        this.lastDisconnectAt = at;
        break;
      }
      case 'stream-reconnected': {
        this.reconnects += 1;
        const at = (data as { at?: number }).at;
        if (at !== undefined && this.lastDisconnectAt !== undefined) {
          this.reconnectLatencies.push(Math.max(0, at - this.lastDisconnectAt));
          this.lastDisconnectAt = undefined;
        }
        break;
      }
      case 'stream-gap-filled': {
        const event = data as { count?: number; truncated?: boolean };
        this.gapFills += 1;
        this.signaturesRecovered += event.count ?? 0;
        if (event.truncated === true) this.truncatedGapFills += 1;
        break;
      }
      default:
        break;
    }
  }

  /** A quote outcome, fed by the adapter's error path. */
  observeQuoteError(code: string, rateLimited: boolean): void {
    bump(this.quoteErrors, code);
    if (rateLimited) this.rateLimited += 1;
  }

  private applyFill(fill: Fill): void {
    this.eventNetFlow += fill.lamportsDelta - fill.feesLamports;
    this.fees += fill.feesLamports;

    const position = this.held.get(fill.mint) ?? { tokens: 0n, cost: 0n };
    if (fill.side === 'buy') {
      this.buys += 1;
      position.tokens += fill.tokensDelta;
      position.cost += abs(fill.lamportsDelta) + fill.feesLamports;
    } else {
      this.sells += 1;
      const requested = abs(fill.tokensDelta);
      const sold = requested > position.tokens ? position.tokens : requested;
      const relieved = position.tokens === 0n ? 0n : (position.cost * sold) / position.tokens;
      this.realized += abs(fill.lamportsDelta) - relieved - fill.feesLamports;
      position.tokens -= sold;
      position.cost -= relieved;
      if (position.tokens === 0n) position.cost = 0n;
    }
    this.held.set(fill.mint, position);
  }

  snapshot(at: UnixMillis): SoakSnapshot {
    const recorder = this.options.recorderStats?.() ?? {
      written: 0,
      dropped: 0,
      droppedByKind: new Map<string, number>(),
      rotations: 0,
      unmodeled: 0,
    };
    const cache = this.options.quoteCacheStats?.() ?? { hits: 0, misses: 0 };

    const ledgerFlow = this.options.ledgerNetFlowLamports();
    const balance = this.options.startingLamports + ledgerFlow;
    // The event stream's own arithmetic against the ledger's. Two independent
    // routes to one number; they must agree exactly — but only over the same
    // window, which is why the ledger side is measured from `ledgerFlowAtStart`.
    const drift = ledgerFlow - this.ledgerFlowAtStart - this.eventNetFlow;

    const trackedTotal = [...this.venues.values()].reduce((a, b) => a + b, 0);
    const unparsedTotal = [...this.unparsed.values()].reduce((a, b) => a + b, 0);
    const latencies = [...this.reconnectLatencies].sort((a, b) => a - b);

    const findings: string[] = [];
    if (drift !== 0n) {
      findings.push(
        `PAPER BALANCE DRIFT of ${drift} lamports — the fill events and the ledger disagree`,
      );
    }
    if (recorder.dropped > 0) {
      findings.push(
        `${recorder.dropped} session line(s) dropped — every session from this run is unfit for replay`,
      );
    }
    if (this.unmodeled.size > 0) {
      findings.push(
        `${[...this.unmodeled.keys()].sort().join(', ')} produced unmodeled events — the session schema is incomplete`,
      );
    }
    for (const [mint, count] of [...this.noRoute].sort()) {
      findings.push(`NO_ROUTE while holding ${mint} (${count}x) — needs an explanation`);
    }
    // Split by POSITIVE determination. See `CLASSIFIED_UNPARSED_CODES`.
    //
    // The question this alarm asks is "how much of the feed can the parser not
    // account for", not "how much of the feed was not a swap". The second one is
    // a property of who the tracked wallets are and moves with the market; it
    // was what the >1% threshold actually measured, and it is why that finding
    // fired at 97.05% on a run where nothing was wrong.
    const classified = new Map<string, number>();
    const unhandled = new Map<string, number>();
    for (const [code, count] of this.unparsed) {
      if (CLASSIFIED_UNPARSED_CODES.has(code)) classified.set(code, count);
      else unhandled.set(code, count);
    }
    const classifiedTotal = [...classified.values()].reduce((a, b) => a + b, 0);
    const unhandledTotal = [...unhandled.values()].reduce((a, b) => a + b, 0);
    const observedTotal = trackedTotal + unparsedTotal;
    const classifiedShareBps = bps(classifiedTotal, observedTotal);
    const unhandledShareBps = bps(unhandledTotal, observedTotal);

    if (unhandledTotal > UNHANDLED_THRESHOLD) {
      const codes = [...unhandled.keys()].sort().join(', ');
      findings.push(
        `${unhandledTotal} unparsed transaction(s) carried no code this digest recognises ` +
          `[${codes}] — ${(unhandledShareBps / 100).toFixed(2)}% of observed traffic, ` +
          `threshold >${UNHANDLED_THRESHOLD}, basis: ${UNHANDLED_BASIS}`,
      );
    }

    return {
      schema: 1,
      window: { startedAt: this.options.startedAt, at, elapsedMs: at - this.options.startedAt },
      trackedSwapsByVenue: sorted(this.venues),
      trackedSwapsTotal: trackedTotal,
      unparsedByReason: sorted(this.unparsed),
      unparsedTotal,
      classifiedByCode: sorted(classified),
      classifiedTotal,
      classifiedShareBps,
      unhandledByCode: sorted(unhandled),
      unhandledTotal,
      unhandledShareBps,
      unmodeledByTag: sorted(this.unmodeled),
      unmodeledTotal: recorder.unmodeled,
      guardRejectionsByCode: sorted(this.rejections),
      noRouteWhileHeld: sorted(this.noRoute),
      stream: {
        socketDeaths: this.socketDeaths,
        connectAttemptFailures: this.connectAttemptFailures,
        deathEchoesCollapsed: this.deathEchoes,
        reconnects: this.reconnects,
        reconnectLatencyMs: {
          count: latencies.length,
          p50: latencies[Math.floor(latencies.length / 2)] ?? 0,
          max: latencies.at(-1) ?? 0,
        },
        gapFills: this.gapFills,
        signaturesRecovered: this.signaturesRecovered,
        truncatedGapFills: this.truncatedGapFills,
        barrier: this.options.barrierStats?.() ?? {
          peakDeferred: 0,
          peakOutstanding: 0,
          heldNow: 0,
        },
      },
      quotes: {
        byError: sorted(this.quoteErrors),
        rateLimited: this.rateLimited,
        cacheHits: cache.hits,
        cacheMisses: cache.misses,
        cacheHitRateBps: bps(cache.hits, cache.hits + cache.misses),
      },
      trades: { buys: this.buys, sells: this.sells, entryIntents: this.entryIntents },
      money: {
        realizedLamports: this.realized.toString(),
        feesLamports: this.fees.toString(),
        netFlowLamports: ledgerFlow.toString(),
        paperBalanceLamports: balance.toString(),
        paperBalanceDrift: drift.toString(),
      },
      recorder: {
        written: recorder.written,
        dropped: recorder.dropped,
        droppedByKind: sorted(recorder.droppedByKind),
        rotations: recorder.rotations,
      },
      findings,
    };
  }

  /** Register an unmodeled tag observed by the recorder. */
  observeUnmodeled(tag: string): void {
    bump(this.unmodeled, tag);
  }
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function tallyText(tally: Tally): string {
  const entries = Object.entries(tally);
  return entries.length === 0 ? 'none' : entries.map(([k, v]) => `${k}=${v}`).join(' ');
}

export function formatDigest(snapshot: SoakSnapshot): string {
  const hours = (snapshot.window.elapsedMs / 3_600_000).toFixed(2);
  const rows: Array<[string, string]> = [
    ['elapsed', `${hours} h`],
    ['tracked swaps', `${snapshot.trackedSwapsTotal}  [${tallyText(snapshot.trackedSwapsByVenue)}]`],
    [
      'classified',
      `${snapshot.classifiedTotal} (${(snapshot.classifiedShareBps / 100).toFixed(2)}%)  [${tallyText(snapshot.classifiedByCode)}]`,
    ],
    [
      'unhandled',
      `${snapshot.unhandledTotal} (${(snapshot.unhandledShareBps / 100).toFixed(2)}%)  ` +
        `[${tallyText(snapshot.unhandledByCode)}]  must be ${UNHANDLED_THRESHOLD}`,
    ],
    ['unmodeled', `${snapshot.unmodeledTotal}  [${tallyText(snapshot.unmodeledByTag)}]`],
    ['entry intents', String(snapshot.trades.entryIntents)],
    ['fills', `${snapshot.trades.buys} buys, ${snapshot.trades.sells} sells`],
    ['guard rejections', tallyText(snapshot.guardRejectionsByCode)],
    ['no route while held', tallyText(snapshot.noRouteWhileHeld)],
    [
      'stream',
      `${snapshot.stream.socketDeaths} socket deaths / ${snapshot.stream.reconnects} recovered ` +
        `(${snapshot.stream.connectAttemptFailures} failed attempts, ` +
        `${snapshot.stream.deathEchoesCollapsed} echoes collapsed at ${DEATH_DEDUPE_MS}ms; ${DEATH_DEDUPE_BASIS}), ` +
        `reconnect p50 ${snapshot.stream.reconnectLatencyMs.p50}ms max ${snapshot.stream.reconnectLatencyMs.max}ms, ` +
        `${snapshot.stream.gapFills} gap fills recovering ${snapshot.stream.signaturesRecovered} sigs, ` +
        `barrier peak deferred ${snapshot.stream.barrier.peakDeferred}/${MAX_DEFERRED_REPORTED} ` +
        `outstanding ${snapshot.stream.barrier.peakOutstanding} held-now ${snapshot.stream.barrier.heldNow}`,
    ],
    [
      'quotes',
      `${tallyText(snapshot.quotes.byError)}  429=${snapshot.quotes.rateLimited}  ` +
        `cache ${(snapshot.quotes.cacheHitRateBps / 100).toFixed(1)}%`,
    ],
    ['realized pnl', `${lamportsToSol(BigInt(snapshot.money.realizedLamports))} SOL`],
    ['fees', `${lamportsToSol(BigInt(snapshot.money.feesLamports))} SOL`],
    ['paper balance', `${lamportsToSol(BigInt(snapshot.money.paperBalanceLamports))} SOL`],
    ['balance drift', `${snapshot.money.paperBalanceDrift} lamports (must be 0)`],
    [
      'recorder',
      `${snapshot.recorder.written} written, ${snapshot.recorder.dropped} dropped ` +
        `[${tallyText(snapshot.recorder.droppedByKind)}], ${snapshot.recorder.rotations} rotations`,
    ],
  ];

  const width = Math.max(...rows.map(([label]) => label.length));
  const table = rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join('\n');
  const findings =
    snapshot.findings.length === 0
      ? '\n  FINDINGS: none'
      : `\n  FINDINGS:\n${snapshot.findings.map((f) => `    - ${f}`).join('\n')}`;
  return `${table}\n${findings}`;
}
```

---

## `src/services/recorder.ts`

```typescript
/**
 * Record mode — write everything a replay needs, and nothing it does not.
 *
 * ── WHAT IS RECORDED, AND WHY ONLY THIS ───────────────────────────────────
 *
 * **Inputs, never outputs.** A session holds the four things the system cannot
 * recompute — what the tracked wallets did, what the aggregator answered, what
 * the screener decided, and what price each held position was marked at. Fills,
 * intents and positions are deliberately absent: replay regenerates those
 * through the real broker and the real guard layer, and a session that also
 * carried them could be replayed into agreement with itself. The point of a
 * replay is that it can disagree.
 *
 * ── NO CALL SITES INSIDE ADAPTERS ─────────────────────────────────────────
 *
 * Two of the four are already events on the tracker's emitter, so those are a
 * subscription. The other two are not, and rather than reaching into
 * `jupiter.ts` or `safety.ts` to emit something, the recorder hands back
 * **decorators**: `wrapQuotes`, `wrapScreener`, `wrapDriver`. They are
 * installed once at the composition root, they delegate unchanged, and an
 * adapter that has never heard of recording stays that way. `null` recorder,
 * no wrappers, nothing to remove.
 *
 * ── RECORDING MUST NEVER GATE THE LIVE PATH ───────────────────────────────
 *
 * Every write is fire-and-forget onto a stream with a bounded buffer. When the
 * buffer is full the line is **dropped and counted**, never awaited. A bot that
 * hesitated on a trade because a log file was slow would be a worse bot than
 * one with an incomplete log, and an incomplete log announces itself:
 * `dropped > 0` makes the session unfit for replay, which the harness refuses
 * on rather than quietly replaying a hole.
 */

import { EventEmitter } from 'node:events';
import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { QuoteError, QuoteRequest, QuoteSource } from '../core/quoteSource.js';
import type { Address, Position, Quote, TrackedSwap, UnixMillis } from '../core/types.js';

// ---------------------------------------------------------------------------
// Line format
// ---------------------------------------------------------------------------

export type SessionKind =
  | 'swap'
  | 'quote'
  | 'screen'
  | 'price-tick'
  | 'decision'
  | 'unmodeled';

/**
 * The fifth kind: everything the recorder met and could not classify.
 *
 * It exists to make the schema falsifiable. Four kinds were *argued* to be
 * sufficient in handoff 12 and nothing measured it; anything that does not fit
 * now lands here with a tag and its raw payload instead of being silently
 * dropped, and the soak digest counts it by tag.
 *
 * **A nonzero count is the finding, not a nuisance.** The correct response to
 * a tag showing up is to decide whether that input belongs in the model — not
 * to widen one of the other four until the tag disappears, which would delete
 * the only evidence that the schema was incomplete.
 */
export interface UnmodeledPayload {
  tag: string;
  raw: unknown;
}

/**
 * One JSONL line.
 *
 * `seq` is monotonic within a session and is the tie-break for equal
 * timestamps. It is not decoration: `simClockMs` comes from a clock that can
 * produce the same value twice in a row, and two events in one millisecond
 * sorted by timestamp alone come back in whatever order the sort happened to
 * leave them. The ledger learned this the expensive way — see the `(at, rowid)`
 * fix in handoff 09 — and a session file has no rowid to fall back on.
 */
export interface SessionLine {
  seq: number;
  simClockMs: UnixMillis;
  kind: SessionKind;
  payload: unknown;
}

/** A quote exactly as it was asked and answered, including a refusal. */
export interface QuotePayload {
  request: { inMint: Address; outMint: Address; inAmount: string; slippageBps: number };
  /** Present for a priced route. */
  quote?: { inAmount: string; outAmount: string; priceImpactPct: number };
  /** Present instead when there was no route, or the upstream failed. */
  error?: { error: string; message: string };
}

export interface ScreenPayload {
  mint: Address;
  sizeSol: number;
  verdict: string;
  failedChecks: string[];
  unknownChecks: string[];
  /**
   * Mint age in ms at screen time, when the screener established it.
   *
   * Lifted out of `ScreenResult.details`, which is `Record<string, unknown>`
   * and therefore not something a replay can rely on. The quote-decay report
   * buckets by mint age and this is the only place a session learns it.
   */
  ageMs?: number;
}

export interface PriceTickPayload {
  mint: Address;
  /**
   * SOL per whole token, as the decimal string the tracker computed.
   *
   * A string, not a number: this is the one genuinely float-valued input in a
   * session, and `JSON.stringify(0.1 + 0.2)` is not a value anybody wants to
   * diff. Written with `toPrecision(17)`, which round-trips a float64 exactly.
   */
  priceSol: string;
  tokens: string;
  decimals: number;
}

/**
 * A refusal, recorded so a session can say what the bot decided and why not.
 *
 * ── WHY THIS DOES NOT BREAK "INPUTS ONLY" ─────────────────────────────────
 *
 * A rejection is an output, and outputs are excluded because a session carrying
 * them could be replayed into agreement with itself. That argument applies to
 * anything a replay CONSUMES. A `decision` line is never consumed: the replay
 * loader carries it and drives nothing from it, exactly as it does `unmodeled`,
 * so the regenerated rejections still have to stand on their own.
 *
 * It gets its own kind rather than riding on `unmodeled` because the unmodeled
 * count is a falsifiability signal — "the four kinds were argued sufficient and
 * nothing measured it" — and filling it with refusals the recorder fully
 * understands would destroy the one number that can contradict the schema.
 *
 * ── WHAT IT BUYS ──────────────────────────────────────────────────────────
 *
 * Session 23 could not rebuild the destroyed ledger's intents from any session
 * file, and this is why: guard gate 3 runs before the broker's first quote, so a
 * `STALE_SIGNAL` refusal produced no quote, no screen and no tick. All that
 * survived was the originating swap, which is byte-for-byte identical to a swap
 * the strategy declined to act on. 272 refusals on 2026-08-05 were unrecoverable
 * for that reason.
 *
 * `signalAgeMs` also lands here, which is the only place it can. `intents` has
 * no column for it (CLAUDE.md gap 8) and `db/ledger.ts` needs a signed sign-off.
 * This is the measured value at the moment the gate read it — not a backfill and
 * not inferred from timestamps, both of which that gap explicitly forbids.
 */
export interface DecisionPayload {
  intentId: string;
  side: 'buy' | 'sell';
  mint: Address;
  /** The guard code, e.g. `STALE_SIGNAL`. */
  code: string;
  /** As persisted on `intents.rejection_code`; may carry a sub-reason. */
  rejectionCode: string;
  reason: string;
  /** The age the freshness gate actually judged. Absent for exits and manual orders. */
  signalAgeMs?: number;
}

export interface SwapPayload {
  wallet: Address;
  mint: Address;
  side: 'buy' | 'sell';
  solAmount: string;
  tokenAmount: string;
  decimals: number;
  signature: string;
  slot: number;
  blockTime: number | null;
  venue: string;
  feePayer: boolean;
  /**
   * Optional, unlike on `TrackedSwap` itself, and that asymmetry is on purpose.
   *
   * Session files recorded before signal provenance existed do not carry these
   * fields, and a replay must still be able to read them — a recording format
   * that invalidates its own archive on every schema addition is not an archive.
   * `decodeSwap` supplies the same fail-closed defaults `parseSwap` uses.
   */
  source?: string;
  observedAt?: number;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** A float64 as a string that parses back to the identical double. */
export function encodeFloat(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return value.toPrecision(17);
}

export function encodeSwap(swap: TrackedSwap): SwapPayload {
  return {
    wallet: swap.wallet,
    mint: swap.mint,
    side: swap.side,
    solAmount: swap.solAmount.toString(),
    tokenAmount: swap.tokenAmount.toString(),
    decimals: swap.decimals,
    signature: swap.signature,
    slot: swap.slot,
    blockTime: swap.blockTime,
    venue: swap.venue,
    feePayer: swap.feePayer,
    source: swap.source,
    observedAt: swap.observedAt,
  };
}

export function decodeSwap(payload: SwapPayload): TrackedSwap {
  return {
    wallet: payload.wallet,
    mint: payload.mint,
    side: payload.side,
    solAmount: BigInt(payload.solAmount),
    tokenAmount: BigInt(payload.tokenAmount),
    decimals: payload.decimals,
    signature: payload.signature,
    slot: payload.slot,
    blockTime: payload.blockTime,
    venue: payload.venue as TrackedSwap['venue'],
    feePayer: payload.feePayer,
    // Fail closed, matching `parseSwap`: a recording that predates provenance
    // decodes as an old gap-fill entry rather than as fresh live signal.
    source: (payload.source as TrackedSwap['source']) ?? 'gapfill',
    observedAt: payload.observedAt ?? 0,
  };
}

/** `YYYY-MM-DD` in UTC, the unit the date-boundary rotation works in. */
function utcDate(at: UnixMillis): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** The key a replay resolves a quote by: the pair and the exact size. */
export function quoteKey(request: Pick<QuoteRequest, 'inMint' | 'outMint' | 'inAmount'>): string {
  return `${request.inMint}|${request.outMint}|${request.inAmount.toString()}`;
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

export interface RecorderLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface RecorderOptions {
  /** Directory sessions are written to. Created if absent. */
  directory: string;
  /** Injected clock, so a session's timestamps are whatever drives the run. */
  now: () => UnixMillis;
  logger?: RecorderLogger;
  /**
   * Bytes of un-flushed session data tolerated before lines are dropped.
   *
   * The whole point of the bound: past it, recording is behind and the choice
   * is between delaying a trade and losing a log line. It loses the log line.
   */
  maxBufferedBytes?: number;
  /** Rotate once a file passes this size. */
  maxBytes?: number;
  /** Delete session files older than this. `0` disables the sweep. */
  retentionDays?: number;
  /**
   * Strings that must never reach a session file.
   *
   * Redaction happens HERE, at the producer, not at the sink. A sink-side
   * scrubber only protects the sinks somebody remembered to wrap, and the
   * failure mode is silent — the secret is already on disk by the time anyone
   * notices the log formatter was missing one. See `redact`.
   */
  secrets?: readonly string[];
}

export const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_RETENTION_DAYS = 30;
export const REDACTED = '[REDACTED]';

/** What the tracker emits, narrowed to the one event the recorder subscribes to. */
interface TrackerLike extends EventEmitter {
  on(event: 'event', handler: (record: { type: string; data: unknown }) => void): this;
}

/** The part of a screen verdict a session needs. */
export interface ScreenResultLike {
  verdict: string;
  failedChecks: string[];
  unknownChecks: string[];
}

/**
 * The screener surface the recorder wraps. `SafetyScreener` satisfies it.
 *
 * Generic in the result so the wrapper hands back exactly what it was given —
 * a decorator that narrowed `ScreenResult` to the three fields it records would
 * make everything downstream of it poorer for no reason.
 */
export interface ScreenerLike<R extends ScreenResultLike = ScreenResultLike> {
  screenMint(mint: Address, opts: { sizeSol: number }): Promise<R>;
}

/** The strategy driver surface the recorder wraps. `StrategyRunner` satisfies it. */
export interface DriverLike {
  onTrackedSwap(swap: TrackedSwap): Promise<void>;
  onPriceTick(position: Position, priceSol: number): Promise<void>;
}

/**
 * Tracker events that are OUTPUTS, deliberately not recorded.
 *
 * Named explicitly rather than filtered by omission, and that distinction is
 * the whole reason `unmodeled` can mean anything. If the recorder simply
 * ignored what it did not recognise, a new event type would vanish and the
 * session would be quietly incomplete. Instead: known input -> recorded, known
 * output -> skipped by name, anything else -> `unmodeled` with its type as the
 * tag. Adding an event to this list is a decision somebody has to make.
 */
export const EXCLUDED_TRACKER_EVENTS: ReadonlySet<string> = new Set([
  // Regenerated by replay from the inputs. Recording them would let a session
  // be replayed into agreement with itself.
  'intent-created',
  'fill',
  // NOTE: 'rejection' used to be here. It is now written as a `decision` line,
  // which the replay loader carries and never drives, so the self-agreement
  // argument still holds. See `DecisionPayload`.
  // Derived from a quote or a screen, both of which ARE recorded.
  'route-lost',
  'sellability-degraded',
  // Process lifecycle, not market input.
  'state-change',
  'reconciled',
  'strategy-error',
  'error',
]);

export class SessionRecorder {
  private readonly options: Required<
    Pick<RecorderOptions, 'maxBufferedBytes' | 'maxBytes' | 'retentionDays'>
  > &
    RecorderOptions;
  private readonly secrets: readonly string[];
  private readonly startedAt: UnixMillis;

  private stream: WriteStream;
  private currentPath: string;
  private bytesInFile = 0;
  private utcDate: string;
  private rotation = 0;
  private seq = 0;
  private closed = false;

  /**
   * One entry per stream this recorder has called `end()` on, resolving when
   * that stream has actually finished writing.
   *
   * `close()` used to await only `this.stream`, so a stream rotated away from
   * was ended and then forgotten while it still held buffered bytes. `close()`
   * would resolve with an earlier session file short — or, when the rotation
   * had only just happened, still zero bytes on disk. That is a `seq` gap, and
   * the replay loader refuses a session with a gap, so a clean shutdown could
   * quietly produce an unreplayable session. Measured at 51/300 closes losing
   * lines before this set existed.
   */
  private readonly flushing = new Set<Promise<void>>();

  readonly stats = {
    written: 0,
    dropped: 0,
    errors: 0,
    rotations: 0,
    redactions: 0,
    unmodeled: 0,
    /** Drops broken out by kind, so the drop valve's bias is visible. */
    droppedByKind: new Map<string, number>(),
    /** Nanoseconds spent inside `write`, for the emit-path measurement. */
    emitNanos: [] as number[],
  };

  constructor(options: RecorderOptions) {
    this.options = {
      maxBufferedBytes: DEFAULT_MAX_BUFFERED_BYTES,
      maxBytes: DEFAULT_MAX_BYTES,
      retentionDays: DEFAULT_RETENTION_DAYS,
      ...options,
    };
    this.secrets = (options.secrets ?? []).filter((secret) => secret.length >= 8);
    this.startedAt = options.now();
    this.utcDate = utcDate(this.startedAt);

    mkdirSync(options.directory, { recursive: true });
    this.currentPath = this.pathFor(0);
    this.stream = this.open(this.currentPath);
    this.sweepRetention();
  }

  get path(): string {
    return this.currentPath;
  }

  /** `2026-08-04T114400Z-000.jsonl` — start timestamp, then rotation index. */
  private pathFor(rotation: number): string {
    const stamp = new Date(this.startedAt)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, 'Z');
    return join(this.options.directory, `${stamp}-${String(rotation).padStart(3, '0')}.jsonl`);
  }

  private open(path: string): WriteStream {
    const stream = createWriteStream(path, { flags: 'a' });
    stream.on('error', (error) => {
      this.stats.errors += 1;
      this.options.logger?.warn({ error: error.message }, 'session write failed');
    });
    return stream;
  }

  /**
   * Remove `secrets` from a serialized line.
   *
   * Substring replacement on the finished JSON rather than a walk over the
   * object, because a secret does not only appear as a whole field: an RPC URL
   * carrying `?api-key=…` turns up inside an error message, inside a stack
   * trace, inside a `detail` string somebody added last week. The point of
   * redacting at the producer is that it does not depend on knowing where the
   * secret will be.
   */
  private redact(line: string): string {
    let out = line;
    for (const secret of this.secrets) {
      if (!out.includes(secret)) continue;
      out = out.split(secret).join(REDACTED);
      this.stats.redactions += 1;
    }
    return out;
  }

  /**
   * Roll to a new file on size or on a UTC date change, whichever comes first.
   *
   * Size keeps a single file replayable on a normal machine; the date boundary
   * keeps a day's trading in one place, which is how anybody actually asks for
   * it. `seq` deliberately does NOT reset — it is monotonic across the whole
   * run, so two files from one process can be ordered against each other and a
   * gap between them is still detectable.
   */
  private maybeRotate(at: UnixMillis): void {
    const today = utcDate(at);
    const bySize = this.bytesInFile >= this.options.maxBytes;
    const byDate = today !== this.utcDate;
    if (!bySize && !byDate) return;

    const previous = this.stream;
    // Tracked, not awaited. Rotation stays on the synchronous emit path — the
    // live path must never wait on a file — but `close()` can now wait for
    // this file to finish, which is the only way `close()` can mean "on disk".
    void this.endStream(previous);
    this.rotation += 1;
    this.stats.rotations += 1;
    this.utcDate = today;
    this.bytesInFile = 0;
    this.currentPath = this.pathFor(this.rotation);
    this.stream = this.open(this.currentPath);
    this.options.logger?.warn(
      { path: this.currentPath, reason: bySize ? 'size' : 'utc-date' },
      `session rotated to ${this.currentPath}`,
    );
  }

  /** Delete sessions older than the retention window. Best effort, never throws. */
  private sweepRetention(): void {
    if (this.options.retentionDays <= 0) return;
    const cutoff = this.options.now() - this.options.retentionDays * 86_400_000;
    try {
      for (const name of readdirSync(this.options.directory)) {
        if (!name.endsWith('.jsonl')) continue;
        const full = join(this.options.directory, name);
        if (statSync(full).mtimeMs < cutoff) rmSync(full, { force: true });
      }
    } catch (cause) {
      this.options.logger?.warn(
        { error: (cause as Error).message },
        'session retention sweep failed',
      );
    }
  }

  /**
   * Append one line. Never awaits, never throws.
   *
   * Returns whether it was kept, which is only used by tests — a caller on the
   * live path must not branch on it, because branching on it is how recording
   * starts affecting trading.
   */
  write(kind: SessionKind, payload: unknown): boolean {
    if (this.closed) return false;
    const startedNanos = process.hrtime.bigint();

    try {
      if (this.stream.writableLength > this.options.maxBufferedBytes) {
        this.stats.dropped += 1;
        this.stats.droppedByKind.set(kind, (this.stats.droppedByKind.get(kind) ?? 0) + 1);
        // A session with any drops at all is unfit for replay, and the loader
        // refuses one with a `seq` gap. Warned rather than sampled.
        this.options.logger?.warn(
          { kind, dropped: this.stats.dropped },
          'session recording is behind; dropping a line rather than delaying the live path',
        );
        return false;
      }

      const at = this.options.now();
      this.maybeRotate(at);

      this.seq += 1;
      const line: SessionLine = { seq: this.seq, simClockMs: at, kind, payload };
      const text = `${this.redact(JSON.stringify(line))}\n`;
      this.bytesInFile += Buffer.byteLength(text);
      this.stream.write(text);
      this.stats.written += 1;
      return true;
    } finally {
      // Recorded even for a drop: the claim being measured is that the EMIT
      // PATH is cheap, and a drop is part of that path.
      this.stats.emitNanos.push(Number(process.hrtime.bigint() - startedNanos));
    }
  }

  /** Everything the schema does not model. See `UnmodeledPayload`. */
  writeUnmodeled(tag: string, raw: unknown): boolean {
    this.stats.unmodeled += 1;
    return this.write('unmodeled', { tag, raw } satisfies UnmodeledPayload);
  }

  // -- attachment points ----------------------------------------------------

  /**
   * Subscribe to the tracker's existing emitter. Adds no call site anywhere.
   *
   * Three-way classification, not a filter: a recognised input is recorded, a
   * recognised output is skipped by name, and **anything else becomes
   * `unmodeled`**. That last branch is what makes "the four kinds are
   * sufficient" a claim that can fail rather than an assumption that cannot.
   */
  attach(tracker: TrackerLike): void {
    tracker.on('event', (record) => {
      if (record.type === 'swap-detected') {
        this.write('swap', encodeSwap(record.data as TrackedSwap));
        return;
      }
      if (record.type === 'rejection') {
        const data = record.data as {
          intentId: string;
          side: 'buy' | 'sell';
          mint: Address;
          code: string;
          rejectionCode: string;
          reason: string;
          signalAgeMs?: number;
        };
        this.write('decision', {
          intentId: data.intentId,
          side: data.side,
          mint: data.mint,
          code: data.code,
          rejectionCode: data.rejectionCode,
          reason: data.reason,
          ...(data.signalAgeMs === undefined ? {} : { signalAgeMs: data.signalAgeMs }),
        } satisfies DecisionPayload);
        return;
      }
      if (EXCLUDED_TRACKER_EVENTS.has(record.type)) return;
      this.writeUnmodeled(`tracker:${record.type}`, record.data);
    });
  }

  /**
   * A `QuoteSource` that records what it was asked and what came back.
   *
   * Records the refusal too. `NO_ROUTE` is the single most important thing a
   * session can contain — it is the difference between "the strategy chose not
   * to act" and "there was no way to act" — and a replay that synthesised a
   * quote where the real run had none would turn a trapped position into a
   * profitable exit.
   */
  wrapQuotes(inner: QuoteSource): QuoteSource {
    return {
      getQuote: async (request) => {
        const result = await inner.getQuote(request);
        const base: QuotePayload['request'] = {
          inMint: request.inMint,
          outMint: request.outMint,
          inAmount: request.inAmount.toString(),
          slippageBps: request.slippageBps,
        };

        if ((result as QuoteError).error !== undefined) {
          const error = result as QuoteError;
          this.write('quote', {
            request: base,
            error: { error: error.error, message: error.message },
          } satisfies QuotePayload);
        } else {
          const quote = result as Quote;
          this.write('quote', {
            request: base,
            quote: {
              inAmount: quote.inAmount.toString(),
              outAmount: quote.outAmount.toString(),
              priceImpactPct: quote.priceImpactPct,
            },
          } satisfies QuotePayload);
        }
        return result;
      },
    };
  }

  /** A screener that records every `screenMint` verdict, with its failed checks. */
  wrapScreener<R extends ScreenResultLike>(inner: ScreenerLike<R>): ScreenerLike<R> {
    return {
      screenMint: async (mint, opts) => {
        const result = await inner.screenMint(mint, opts);
        const ageMs = (result as { details?: Record<string, unknown> }).details?.['ageMs'];
        this.write('screen', {
          mint,
          sizeSol: opts.sizeSol,
          verdict: result.verdict,
          failedChecks: result.failedChecks,
          unknownChecks: result.unknownChecks,
          ...(typeof ageMs === 'number' ? { ageMs } : {}),
        } satisfies ScreenPayload);
        return result;
      },
    };
  }

  /**
   * A driver that records the price each held position was marked at.
   *
   * Wrapped here rather than inside the price loop because the loop is in a
   * file this has no business editing, and because what matters for a replay is
   * the number the strategy actually saw — which is this argument, after every
   * conversion the tracker applies to it.
   */
  /**
   * A `Proxy`, not a literal, and that is deliberate.
   *
   * `StrategyDriver` is an `EventEmitter` and the tracker subscribes to
   * `strategy-error` on whatever it is handed. A plain object literal would
   * drop that; `Object.create(inner)` is worse, because `EventEmitter` writes
   * its listener map onto `this`, so subscriptions would land on the wrapper
   * while emits fired on the inner and nothing would ever be delivered. The
   * proxy forwards everything it does not intercept to the real object,
   * bound to it.
   */
  wrapDriver<T extends DriverLike>(inner: T): T {
    const recorder = this;
    return new Proxy(inner, {
      get(target, property, receiver) {
        if (property === 'onPriceTick') {
          return (position: Position, priceSol: number): Promise<void> => {
            recorder.write('price-tick', {
              mint: position.mint,
              priceSol: encodeFloat(priceSol),
              tokens: position.tokens.toString(),
              decimals: position.decimals,
            } satisfies PriceTickPayload);
            return target.onPriceTick(position, priceSol);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  /**
   * End one stream, and remember it until it has finished writing.
   *
   * Resolves on `error` as well as on completion: the stream already has an
   * error handler that counts and logs rather than throwing, and a stream that
   * failed will never emit `finish`. Waiting for one that cannot arrive would
   * turn a failed write into a shutdown that hangs.
   */
  private endStream(stream: WriteStream): Promise<void> {
    const finished = new Promise<void>((resolve) => {
      stream.end(() => resolve());
      stream.once('error', () => resolve());
    });
    this.flushing.add(finished);
    void finished.then(() => this.flushing.delete(finished));
    return finished;
  }

  /**
   * Flush and close. Safe to call twice.
   *
   * Awaits every file this recorder opened, not just the current one. See
   * `flushing` for what that fixes.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    void this.endStream(this.stream);
    await Promise.all([...this.flushing]);
  }

  /** p50 / p99 / max of time spent inside `write`, in nanoseconds. */
  emitLatencyNanos(): { count: number; p50: number; p99: number; max: number } {
    const sorted = [...this.stats.emitNanos].sort((a, b) => a - b);
    if (sorted.length === 0) return { count: 0, p50: 0, p99: 0, max: 0 };
    const at = (fraction: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
    return { count: sorted.length, p50: at(0.5), p99: at(0.99), max: sorted.at(-1) ?? 0 };
  }
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * `sessions/{ISO-date}-{n}.jsonl`, where `n` is the first free index.
 *
 * Superseded by the recorder's own rotation naming, which carries a start
 * timestamp and a rotation index. Kept because it is the right helper for
 * anything that needs a free filename in a session directory without opening a
 * recorder — the crash drill uses it.
 */
export function sessionPath(
  directory: string,
  now: UnixMillis,
  exists: (path: string) => boolean,
): string {
  const date = new Date(now).toISOString().slice(0, 10);
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = `${directory}/${date}-${index}.jsonl`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`more than 10000 sessions already recorded for ${date}`);
}
```
