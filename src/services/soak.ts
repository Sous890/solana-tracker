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

export interface SoakSnapshot {
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
  /** Unparsed as a share of tracked swaps, in integer basis points. */
  unparsedShareBps: number;

  /** Recorder events with no schema, by tag. Nonzero is the finding. */
  unmodeledByTag: Tally;
  unmodeledTotal: number;

  guardRejectionsByCode: Tally;

  /** Any nonzero entry is a finding: a position that could not be exited. */
  noRouteWhileHeld: Tally;

  stream: {
    disconnects: number;
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

  private disconnects = 0;
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

  constructor(private readonly options: SoakDigestOptions) {}

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
        this.disconnects += 1;
        this.lastDisconnectAt = (data as { at?: number }).at;
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
    // routes to one number; they must agree exactly.
    const drift = ledgerFlow - this.eventNetFlow;

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
    const shareBps = bps(unparsedTotal, trackedTotal + unparsedTotal);
    if (shareBps > 100) {
      findings.push(
        `unparsed transactions are ${(shareBps / 100).toFixed(2)}% of tracked traffic (>1%)`,
      );
    }

    return {
      window: { startedAt: this.options.startedAt, at, elapsedMs: at - this.options.startedAt },
      trackedSwapsByVenue: sorted(this.venues),
      trackedSwapsTotal: trackedTotal,
      unparsedByReason: sorted(this.unparsed),
      unparsedTotal,
      unparsedShareBps: shareBps,
      unmodeledByTag: sorted(this.unmodeled),
      unmodeledTotal: recorder.unmodeled,
      guardRejectionsByCode: sorted(this.rejections),
      noRouteWhileHeld: sorted(this.noRoute),
      stream: {
        disconnects: this.disconnects,
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
      'unparsed',
      `${snapshot.unparsedTotal} (${(snapshot.unparsedShareBps / 100).toFixed(2)}%)  [${tallyText(snapshot.unparsedByReason)}]`,
    ],
    ['unmodeled', `${snapshot.unmodeledTotal}  [${tallyText(snapshot.unmodeledByTag)}]`],
    ['entry intents', String(snapshot.trades.entryIntents)],
    ['fills', `${snapshot.trades.buys} buys, ${snapshot.trades.sells} sells`],
    ['guard rejections', tallyText(snapshot.guardRejectionsByCode)],
    ['no route while held', tallyText(snapshot.noRouteWhileHeld)],
    [
      'stream',
      `${snapshot.stream.disconnects} down / ${snapshot.stream.reconnects} up, ` +
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
