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

export type SessionKind = 'swap' | 'quote' | 'screen' | 'price-tick' | 'unmodeled';

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
  'rejection',
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
    previous.end();
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

  /** Flush and close. Safe to call twice. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => this.stream.end(resolve));
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
