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
        `${snapshot.stream.gapFills} gap fills recovering ${snapshot.stream.signaturesRecovered} sigs`,
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
