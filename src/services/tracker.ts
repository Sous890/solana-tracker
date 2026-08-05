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
import { WalletStream } from '../adapters/walletStream.js';
import { StrategyRunner } from './strategyRunner.js';
import { SessionRecorder } from './recorder.js';

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
    deps.stream.on('unparsed', (result: { reason?: string; signature?: string }) => {
      this.record('swap-unparsed', { reason: result.reason ?? 'UNKNOWN', signature: result.signature });
    });
    deps.stream.on('disconnected', (payload: unknown) => {
      this.record('stream-disconnected', { ...(payload as object), at: this.now() });
    });
    deps.stream.on('reconnected', (payload: unknown) => {
      this.record('stream-reconnected', { ...(payload as object), at: this.now() });
    });
    deps.stream.on('gap-filled', (payload: unknown) => {
      this.record('stream-gap-filled', payload);
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
          };
          this.record('rejection', event);
        } else {
          // The broker resolves its own failures; this is only the alert.
          this.recordError(cause as Error, `execute ${intent.id}`);
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

  return {
    tracker,
    ledger,
    fills,
    config,
    async close() {
      await tracker.shutdown();
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
