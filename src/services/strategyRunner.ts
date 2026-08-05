/**
 * The runner: the only thing that calls a strategy, and the only thing that
 * turns what a strategy says into what the system does.
 *
 * It sits between the tracker's event sources and the existing execution path.
 * The strategy replaces **what to do**. It never replaces **how**: the id, the
 * ledger write, the guard layer, the broker and the events are all the same
 * path `Tracker.submit()` has always taken.
 *
 * ── THE STRATEGY IS UNTRUSTED CODE ────────────────────────────────────────
 *
 * Every call is wrapped. A throw becomes a `strategy-error` event and is
 * treated as `null`. A call that has not answered in 500ms becomes the same
 * thing, counted separately. Neither may stop a loop, change bot state, or
 * escape into the tracker — the price loop must keep marking positions and
 * raising `route-lost` no matter how badly the strategy is behaving, because
 * that alerting is what an operator is left with when the strategy is broken.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
 *
 * **It does not pre-filter.** Not the kill switch, not duplicate holdings, not
 * the daily loss cap. If a strategy asks for something a risk limit forbids,
 * the intent is written and `guards.ts` rejects it, and the rejection lands in
 * `intents.rejection_code` with a machine-readable code. Prompt 12 reports
 * rejection counts by code; a runner that quietly dropped entries before they
 * were recorded would make that report describe a bot that never asked.
 *
 * That is a different thing from a strategy *knowingly* emitting an intent it
 * expects to be rejected — see `mirror.ts`, which no-ops rather than emitting a
 * duplicate buy. The rule is: the strategy does not emit what it knows is
 * wrong; the runner does not second-guess what the strategy emitted.
 *
 * ── SERIALIZED PER MINT ───────────────────────────────────────────────────
 *
 * At most one in-flight strategy call per mint. `onPriceTick` fires every 2
 * seconds; a call that takes longer than that must not stack up behind itself.
 * A call arriving while one is running for the same mint is **skipped**, not
 * queued — the tracker's own loops make the same choice, for the same reason:
 * a backlog against a slow dependency only ever gets further behind.
 */

import { EventEmitter } from 'node:events';
import type { Config } from '../core/config.js';
import type { Context, IntentDraft, Strategy, StrategyLogger } from '../core/strategy.js';
import { isQuoteError } from '../core/quoteSource.js';
import type { QuoteError, QuoteSource } from '../core/quoteSource.js';
import type {
  Address,
  BotState,
  Fill,
  Lamports,
  OrderIntent,
  Position,
  TrackedSwap,
  UnixMillis,
} from '../core/types.js';
import { WRAPPED_SOL_MINT, baseUnitsToTokens, lamportsToSol } from '../core/units.js';
import type { TrackerLogger } from './tracker.js';

/**
 * Hard ceiling on one strategy call.
 *
 * 500ms against a 2s price cadence: three positions can each burn the full
 * budget and the loop still finishes inside its interval. It is a ceiling, not
 * a target — a strategy is a pure function of already-fetched inputs and should
 * answer in microseconds. Hitting this means the strategy is doing I/O it was
 * told not to do, or `getPriceSol` is being called on a slow path.
 */
export const STRATEGY_TIMEOUT_MS = 500;

/** Sentinel for the timeout arm of the race. Not an error — a distinct outcome. */
const TIMED_OUT = Symbol('strategy-timeout');

/** Which hook produced an error, so the event says what was running. */
export type StrategyHook = 'onTrackedSwap' | 'onPriceTick';

export interface StrategyErrorEvent {
  strategy: string;
  hook: StrategyHook;
  mint: Address;
  /** `throw` — the strategy raised. `timeout` — it did not answer in time. */
  kind: 'throw' | 'timeout';
  message: string;
  at: UnixMillis;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * What the runner needs from the tracker, and nothing more.
 *
 * Narrow on purpose: the runner cannot start, stop, flatten or touch the kill
 * switch. It reads state and submits intents, and `submit` is the guarded path.
 */
export interface StrategyHost {
  getState(): BotState;
  /** Live open positions from the ledger. The runner freezes them. */
  openPositions(): Position[];
  balanceLamports(): Promise<Lamports>;
  /** `Tracker.submit` — records the intent, guards it, executes, emits. */
  submit(intent: OrderIntent): Promise<Fill>;
}

export interface StrategyRunnerDeps {
  strategy: Strategy;
  config: Config;
  host: StrategyHost;
  /** Used only by `ctx.getPriceSol`. */
  quotes: QuoteSource;
  /** The same resolver the broker uses, so decimals have one source. */
  resolveDecimals: (mint: Address) => Promise<number>;
  logger: TrackerLogger;
  now?: () => UnixMillis;
  timeoutMs?: number;
  /**
   * Disambiguates intent ids between runs. Defaults to the injected clock read
   * once at construction — see `nextId`.
   */
  runId?: string;
}

// ---------------------------------------------------------------------------
// Signal provenance
// ---------------------------------------------------------------------------

/** The pair of fields `guards.ts` reads to decide whether a signal has expired. */
export interface SignalProvenance {
  signalAt: UnixMillis;
  signalAgeMs: number;
}

/**
 * When the originating swap happened, and how long ago that was.
 *
 * `blockTime` is in **seconds** and is nullable. The null case is real, so it
 * needs a policy rather than a crash, and the two delivery paths deserve
 * opposite answers:
 *
 *   `live`    — we watched it arrive, so `observedAt` is at most a round trip
 *               after the block. Age comes out near zero, which is true.
 *   `gapfill` — `observedAt` says only when *we fetched it*, which for a
 *               backlog is "just now" no matter how old the transaction is.
 *               Trusting it would hand the gate a twenty-minute-old swap
 *               wearing a fresh timestamp — exactly the case being closed. So
 *               it **fails closed**: `signalAt = 0` makes the age enormous and
 *               the gate refuses.
 *
 * A null `blockTime` on a gap fill is therefore an automatic refusal. That is
 * the intended trade: the alternative is guessing, and a wrong guess here buys.
 */
export function signalOf(swap: TrackedSwap, now: UnixMillis): SignalProvenance {
  const signalAt =
    swap.blockTime !== null
      ? swap.blockTime * 1_000
      : swap.source === 'live'
        ? swap.observedAt
        : 0;

  // Clamped at zero. `blockTime` is a stake-weighted median rather than a
  // clock, so it can sit slightly ahead of local time on a fresh block; a
  // negative age would be a nonsense number in the ledger and the audit log.
  return { signalAt, signalAgeMs: Math.max(0, now - signalAt) };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export class StrategyRunner extends EventEmitter {
  private readonly deps: StrategyRunnerDeps;
  private readonly now: () => UnixMillis;
  private readonly timeoutMs: number;
  private readonly runId: string;
  /** Frozen shallow copy: a strategy writing to `ctx.config` throws, and the real config is untouched. */
  private readonly frozenConfig: Config;
  private readonly log: StrategyLogger;

  /** mint -> the operation currently running for it. Presence is the lock. */
  private readonly locks = new Map<Address, Promise<unknown>>();

  private seq = 0;

  readonly stats = {
    swaps: 0,
    ticks: 0,
    drafts: 0,
    submitted: 0,
    /** Submits that came back as a `GuardRejection`. Not an error here. */
    rejected: 0,
    throws: 0,
    timeouts: 0,
    /** Calls skipped because the same mint was already busy. */
    skippedLocked: 0,
  };

  constructor(deps: StrategyRunnerDeps) {
    super();
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? STRATEGY_TIMEOUT_MS;
    this.runId = deps.runId ?? String(this.now());
    this.frozenConfig = Object.freeze({ ...deps.config });
    this.log = {
      info: (fields, message) =>
        deps.logger.info({ strategy: deps.strategy.name, ...fields }, message),
      warn: (fields, message) =>
        deps.logger.warn({ strategy: deps.strategy.name, ...fields }, message),
    };
  }

  get name(): string {
    return this.deps.strategy.name;
  }

  // -- hooks ----------------------------------------------------------------

  /**
   * A tracked wallet swapped.
   *
   * The caller (the tracker) decides whether this is reached at all: it is
   * gated on `status === 'running'`, so entries stop the instant `stop()`
   * begins. That gate lives there rather than here because the tracker owns
   * `BotState` — but it is asserted from both sides.
   */
  async onTrackedSwap(swap: TrackedSwap): Promise<void> {
    this.stats.swaps += 1;
    // Frozen: the tracker already recorded this exact object as a
    // `swap-detected` event, and a strategy editing it would rewrite history
    // that a client has, in the general case, already been sent.
    const frozen = Object.freeze({ ...swap });
    await this.run(
      swap.mint,
      'onTrackedSwap',
      (ctx) => this.deps.strategy.onTrackedSwap(frozen, ctx),
      signalOf(swap, this.now()),
    );
  }

  /**
   * A held position was re-priced.
   *
   * Reached in every bot state, including after `stop()` has returned the bot
   * to idle and with the kill switch engaged. An exit must keep working when an
   * entry does not; that asymmetry is the whole design of `guards.ts` and it
   * would be pointless if the thing that decides to exit stopped being called.
   */
  async onPriceTick(position: Position, priceSol: number): Promise<void> {
    this.stats.ticks += 1;
    // Frozen for the same reason `ctx.positions` is: this object came straight
    // out of the ledger's projection, and the ledger is the only thing allowed
    // to decide what a position is.
    const frozen = Object.freeze({ ...position });
    await this.run(position.mint, 'onPriceTick', (ctx) =>
      this.deps.strategy.onPriceTick(frozen, priceSol, ctx),
    );
  }

  // -- the wrapper ----------------------------------------------------------

  /**
   * Hold the per-mint lock, run the call, release.
   *
   * The lock and the caller's `await` are deliberately **not** the same thing.
   * This method resolves as soon as the operation has an answer — at the 500ms
   * race at the latest — because the tracker's price loop awaits it, and a hook
   * that never resolved would hang that loop forever. That is precisely the
   * "neither may stop a loop" rule, and holding the lock by awaiting the wedged
   * call is how it gets broken.
   *
   * So on a timeout `execute` hands back the still-running promise, and the
   * lock is released when *that* lands — after this method has already
   * returned.
   */
  private async run(
    mint: Address,
    hook: StrategyHook,
    invoke: (ctx: Context) => Promise<IntentDraft | null>,
    signal?: SignalProvenance,
  ): Promise<void> {
    if (this.locks.has(mint)) {
      this.stats.skippedLocked += 1;
      return;
    }

    let release!: () => void;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(mint, lock);
    void lock.then(() => {
      if (this.locks.get(mint) === lock) this.locks.delete(mint);
    });

    let holdUntil: { pending: Promise<unknown> } | undefined;
    try {
      holdUntil = await this.execute(mint, hook, invoke, signal);
    } finally {
      if (holdUntil === undefined) release();
      // A wedged call keeps the mint locked until it lands. One mint, visible
      // in `stats.timeouts`; the alternative is one leaked live invocation per
      // tick for as long as the strategy stays stuck.
      else void holdUntil.pending.then(release, release);
    }
  }

  /**
   * Returns `undefined` when the mint may be unlocked immediately, or a BOX
   * holding the still-running strategy promise when it may not.
   *
   * Boxed rather than returned bare, and that is load-bearing rather than
   * stylistic: `await` flattens nested promises, so `await execute()` on a
   * `Promise<Promise<T>>` would wait for the inner one too — silently
   * reintroducing the exact hang this restructure exists to remove. The box is
   * not a promise, so it comes back immediately.
   */
  private async execute(
    mint: Address,
    hook: StrategyHook,
    invoke: (ctx: Context) => Promise<IntentDraft | null>,
    signal?: SignalProvenance,
  ): Promise<{ pending: Promise<unknown> } | undefined> {
    let context: Context;
    try {
      context = await this.buildContext();
    } catch (cause) {
      // Building the context reads the ledger and the balance. If that fails
      // the strategy never runs, and this is our fault rather than its — but it
      // still must not propagate into the price loop.
      this.fail(hook, mint, 'throw', `context: ${(cause as Error).message}`);
      return undefined;
    }

    // Never rejects: the throw is folded into the result so the race below has
    // exactly two arms and neither of them can escape.
    const work: Promise<{ draft: IntentDraft | null } | { error: Error }> = (async () => {
      try {
        return { draft: await invoke(context) };
      } catch (cause) {
        return { error: cause as Error };
      }
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), this.timeoutMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);

    if (outcome === TIMED_OUT) {
      this.stats.timeouts += 1;
      this.fail(hook, mint, 'timeout', `did not answer within ${this.timeoutMs}ms`);
      // Returned, not awaited: `run` keeps the mint locked until this lands,
      // without making the caller wait for it. A promise cannot be cancelled,
      // so releasing the mint now would let the next tick start a second call
      // while the first is still running — one leaked live invocation per tick
      // for as long as the strategy stays wedged.
      //
      // Whatever it eventually returns is DISCARDED. We already answered `null`
      // for this tick, and acting on a stale draft would be acting on a
      // decision made against a context that has since moved on.
      return { pending: work };
    }

    if ('error' in outcome) {
      this.stats.throws += 1;
      this.fail(hook, mint, 'throw', outcome.error.message);
      return undefined;
    }

    const draft = outcome.draft;
    if (draft === null) return undefined;
    this.stats.drafts += 1;

    // The id is assigned here and nowhere else. See `core/strategy.ts`.
    //
    // Signal provenance is stamped the same way and for a stronger reason: the
    // spread is AFTER `...draft`, so whatever the strategy put in `signalAt` or
    // `signalAgeMs` is overwritten rather than merged. A strategy is untrusted
    // code — one that declared its own signal fresh could walk a twenty-minute
    // reconnect backlog straight past the freshness gate at full size, which is
    // the precise failure this whole mechanism exists to close.
    //
    // `onPriceTick` passes no signal, so an exit carries neither field. That is
    // not an omission: an exit has no originating swap, and `guards.ts` reads
    // `undefined` as "not from a wallet signal" and does not age-gate it.
    const intent: OrderIntent = { ...draft, id: this.nextId(), ...(signal ?? {}) };

    try {
      await this.deps.host.submit(intent);
      this.stats.submitted += 1;
    } catch (cause) {
      // A `GuardRejection` is the system working. It is already written to
      // `intents.rejection_code` and already emitted as a `rejection` event by
      // `Tracker.submit`; re-reporting it as a strategy error would double-count
      // it and would blame the strategy for a risk limit doing its job.
      if ((cause as Error).name === 'GuardRejection') {
        this.stats.rejected += 1;
        return undefined;
      }
      // Anything else — a broker failure, an unroutable quote — is likewise
      // already recorded by `Tracker.submit`. Swallowed here so one bad intent
      // cannot stop the loop that produced it.
      this.deps.logger.warn(
        { strategy: this.name, hook, mint, intentId: intent.id, error: (cause as Error).message },
        `Strategy intent ${intent.id} did not settle: ${(cause as Error).message}`,
      );
    }
    return undefined;
  }

  private fail(hook: StrategyHook, mint: Address, kind: 'throw' | 'timeout', message: string): void {
    const event: StrategyErrorEvent = {
      strategy: this.name,
      hook,
      mint,
      kind,
      message,
      at: this.now(),
    };
    this.deps.logger.error(
      { strategy: this.name, hook, mint, kind },
      `Strategy ${this.name}.${hook} ${kind === 'timeout' ? 'timed out' : 'threw'}: ${message}`,
    );
    this.emit('strategy-error', event);
  }

  // -- context --------------------------------------------------------------

  /**
   * A fresh `Context` per call, built from live state.
   *
   * Frozen all the way down. A strategy that writes to `ctx.positions[0].tokens`
   * throws a `TypeError` in strict mode (which every ESM module is) rather than
   * silently corrupting the projection the ledger just handed us — and the
   * ledger is supposed to be the only thing that decides what a position is.
   */
  private async buildContext(): Promise<Context> {
    const positions = this.deps.host
      .openPositions()
      .map((position) => Object.freeze({ ...position }));
    const balanceSol = lamportsToSol(await this.deps.host.balanceLamports());

    return Object.freeze({
      positions: Object.freeze(positions),
      balanceSol,
      config: this.frozenConfig,
      getPriceSol: (mint: Address) => this.priceSol(mint),
      now: this.now,
      log: this.log,
    });
  }

  /**
   * SOL per whole token, from a real probe quote against routable liquidity.
   *
   * A `number`, and therefore derived-for-heuristics only — `units.ts` is
   * explicit that anything involving a price ratio is display and strategy
   * input, never an accounting one. Every actual amount a strategy puts in a
   * draft is still an exact `bigint`.
   */
  private async priceSol(mint: Address): Promise<number | QuoteError> {
    const probe = BigInt(this.deps.config.priceProbeLamports);
    const quote = await this.deps.quotes.getQuote({
      inMint: WRAPPED_SOL_MINT,
      outMint: mint,
      inAmount: probe,
      slippageBps: this.deps.config.maxSlippageBps,
    });
    if (isQuoteError(quote)) return quote;
    if (quote.outAmount <= 0n) {
      return { error: 'NO_ROUTE', message: 'probe quote returned zero output' };
    }

    let decimals: number;
    try {
      decimals = await this.deps.resolveDecimals(mint);
    } catch (cause) {
      // No scale means the out amount is meaningless — three or nine orders of
      // magnitude of meaningless. Reported as an error rather than guessed.
      return { error: 'UPSTREAM_ERROR', message: `decimals: ${(cause as Error).message}` };
    }

    const wholeTokens = baseUnitsToTokens(quote.outAmount, decimals);
    if (!Number.isFinite(wholeTokens) || wholeTokens <= 0) {
      return { error: 'NO_ROUTE', message: 'probe quote returned no whole tokens' };
    }
    return lamportsToSol(probe) / wholeTokens;
  }

  // -- ids ------------------------------------------------------------------

  /**
   * `<strategy>-<runId>-<seq>`.
   *
   * The counter alone is not enough, and the reason is a real hazard rather
   * than a theoretical one: the ledger keys a simulated fill on
   * `intentId:mint`, and `recordIntent` is `INSERT OR IGNORE`. A counter that
   * restarted at 1 every boot would, on the second run, write an intent id that
   * already exists — the insert would silently no-op and the fill would collide
   * with the previous run's fill, so the position would never move. A dropped
   * fill, no error anywhere.
   *
   * `runId` defaults to the injected clock read once at construction, so it is
   * unique per run and still deterministic: a replay that injects the same
   * clock reproduces the same ids byte for byte.
   */
  private nextId(): string {
    this.seq += 1;
    return `${this.name}-${this.runId}-${String(this.seq).padStart(5, '0')}`;
  }
}
