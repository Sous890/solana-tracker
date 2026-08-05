/**
 * The report. Deterministic by construction, not by hope.
 *
 * Three rules, each of which a naive implementation breaks:
 *
 *   NO FLOATS in the serialized output. Every money figure is a lamport string
 *   and every ratio is integer basis points. `JSON.stringify(0.1 + 0.2)` is
 *   `0.30000000000000004`, and a report that cannot be diffed is not a report.
 *
 *   NO WALL CLOCK. Nothing here reads `Date.now()`. Durations come from the
 *   session's own simulated clock; the run is not stamped with when it ran,
 *   because "when it ran" is the one field guaranteed to differ between two
 *   identical runs.
 *
 *   STABLE KEY ORDER. Object literals are written in a fixed order and every
 *   map is emitted through `sortedRecord`, so a rejection code appearing in a
 *   different order does not reorder the file.
 */

import type { GuardCode } from '../../src/core/guards.js';

export interface TradeRecord {
  mint: string;
  intentId: string;
  side: 'buy' | 'sell';
  tokensDelta: bigint;
  lamportsDelta: bigint;
  feesLamports: bigint;
  /** Simulated clock, from the session. */
  at: number;
}

export interface ReplayInputs {
  sessionLabel: string;
  sessionLines: number;
  strategy: string;
  paperLatencyPenaltyBps: number;
  positionSizeSol: number;
  paperStartingSol: number;
  fills: TradeRecord[];
  /** Rejection codes as they were emitted, in order. */
  rejections: string[];
  /** Mints that quoted NO_ROUTE while the replay held them. */
  noRouteWhileHeld: string[];
  finalBalanceLamports: bigint;
  ledgerReconcilesClean: boolean;
}

/** A record with keys in sorted order, so serialization is stable. */
function sortedRecord(counts: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of [...counts.keys()].sort()) out[key] = counts.get(key)!;
  return out;
}

/** Integer basis points of `part / whole`, floored. 0 when `whole` is 0. */
function bps(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.floor((part * 10_000) / whole);
}

export interface ReplayReport {
  session: { label: string; lines: number };
  strategy: string;
  parameters: {
    paperLatencyPenaltyBps: number;
    positionSizeSol: string;
    paperStartingSol: string;
  };
  trades: { buys: number; sells: number; roundTrips: number };
  winRate: { wins: number; losses: number; flat: number; bps: number };
  realizedPnlLamports: string;
  maxDrawdownLamports: string;
  totalFeesLamports: string;
  guardRejections: Record<string, number>;
  malformedIntentCount: number;
  noRouteWhileHeld: string[];
  timeToExitMs: {
    count: number;
    minMs: number;
    medianMs: number;
    maxMs: number;
    buckets: Record<string, number>;
  };
  finalBalanceLamports: string;
  ledgerReconcilesClean: boolean;
}

/** Bucket edges in ms. Fixed, so two runs bucket identically. */
const EXIT_BUCKETS: ReadonlyArray<readonly [string, number]> = [
  ['0-10s', 10_000],
  ['10-60s', 60_000],
  ['1-5m', 300_000],
  ['5-30m', 1_800_000],
  ['30m+', Number.POSITIVE_INFINITY],
];

export function buildReport(inputs: ReplayInputs): ReplayReport {
  const buys = inputs.fills.filter((fill) => fill.side === 'buy');
  const sells = inputs.fills.filter((fill) => fill.side === 'sell');

  // Per-mint round trips, walked in fill order. Cost basis is relieved
  // proportionally, in integer math, exactly as `replayMint` does it — the
  // report must not invent a second definition of realized P&L.
  const held = new Map<string, { tokens: bigint; cost: bigint; openedAt: number }>();
  let realized = 0n;
  let wins = 0;
  let losses = 0;
  let flat = 0;
  let roundTrips = 0;
  const exitDurations: number[] = [];

  // Drawdown is measured on the running realized total, which is the only
  // curve that exists without a mark: peak-to-trough of cumulative realized
  // P&L. An unrealized drawdown would need prices this report does not take.
  let peak = 0n;
  let maxDrawdown = 0n;
  let fees = 0n;

  for (const fill of inputs.fills) {
    fees += fill.feesLamports;
    const position = held.get(fill.mint) ?? { tokens: 0n, cost: 0n, openedAt: fill.at };

    if (fill.side === 'buy') {
      if (position.tokens === 0n) position.openedAt = fill.at;
      position.tokens += fill.tokensDelta;
      position.cost += abs(fill.lamportsDelta) + fill.feesLamports;
      held.set(fill.mint, position);
      continue;
    }

    const sold = abs(fill.tokensDelta) > position.tokens ? position.tokens : abs(fill.tokensDelta);
    const relieved = position.tokens === 0n ? 0n : (position.cost * sold) / position.tokens;
    const gain = abs(fill.lamportsDelta) - relieved - fill.feesLamports;

    realized += gain;
    position.tokens -= sold;
    position.cost -= relieved;
    if (position.tokens === 0n) {
      position.cost = 0n;
      roundTrips += 1;
      exitDurations.push(fill.at - position.openedAt);
      if (gain > 0n) wins += 1;
      else if (gain < 0n) losses += 1;
      else flat += 1;
    }
    held.set(fill.mint, position);

    if (realized > peak) peak = realized;
    const drawdown = peak - realized;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  const rejectionCounts = new Map<string, number>();
  for (const code of inputs.rejections) {
    rejectionCounts.set(code, (rejectionCounts.get(code) ?? 0) + 1);
  }

  const sortedDurations = [...exitDurations].sort((a, b) => a - b);
  const bucketCounts = new Map<string, number>();
  for (const [label] of EXIT_BUCKETS) bucketCounts.set(label, 0);
  for (const duration of sortedDurations) {
    for (const [label, ceiling] of EXIT_BUCKETS) {
      if (duration < ceiling) {
        bucketCounts.set(label, (bucketCounts.get(label) ?? 0) + 1);
        break;
      }
    }
  }

  return {
    session: { label: inputs.sessionLabel, lines: inputs.sessionLines },
    strategy: inputs.strategy,
    parameters: {
      paperLatencyPenaltyBps: inputs.paperLatencyPenaltyBps,
      // Config numbers are floats in the file; emitted as strings so the report
      // has no float in it anywhere.
      positionSizeSol: String(inputs.positionSizeSol),
      paperStartingSol: String(inputs.paperStartingSol),
    },
    trades: { buys: buys.length, sells: sells.length, roundTrips },
    winRate: { wins, losses, flat, bps: bps(wins, wins + losses + flat) },
    realizedPnlLamports: realized.toString(),
    maxDrawdownLamports: maxDrawdown.toString(),
    totalFeesLamports: fees.toString(),
    guardRejections: sortedRecord(rejectionCounts),
    malformedIntentCount: rejectionCounts.get('MALFORMED_INTENT' satisfies GuardCode) ?? 0,
    noRouteWhileHeld: [...inputs.noRouteWhileHeld].sort(),
    timeToExitMs: {
      count: sortedDurations.length,
      minMs: sortedDurations[0] ?? 0,
      medianMs: sortedDurations[Math.floor((sortedDurations.length - 1) / 2)] ?? 0,
      maxMs: sortedDurations.at(-1) ?? 0,
      buckets: sortedRecord(bucketCounts),
    },
    finalBalanceLamports: inputs.finalBalanceLamports.toString(),
    ledgerReconcilesClean: inputs.ledgerReconcilesClean,
  };
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

// ---------------------------------------------------------------------------
// Human-readable table
// ---------------------------------------------------------------------------

function lamportsToSolText(lamports: string): string {
  const negative = lamports.startsWith('-');
  const digits = (negative ? lamports.slice(1) : lamports).padStart(10, '0');
  const whole = digits.slice(0, -9);
  const fraction = digits.slice(-9).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction.length > 0 ? `.${fraction}` : ''} SOL`;
}

export function formatTable(report: ReplayReport): string {
  const rows: Array<[string, string]> = [
    ['session', `${report.session.label} (${report.session.lines} lines)`],
    ['strategy', report.strategy],
    ['latency penalty', `${report.parameters.paperLatencyPenaltyBps} bps`],
    ['trades', `${report.trades.buys} buys, ${report.trades.sells} sells, ${report.trades.roundTrips} round trips`],
    [
      'win rate',
      `${(report.winRate.bps / 100).toFixed(2)}%  (${report.winRate.wins}W / ${report.winRate.losses}L / ${report.winRate.flat}F)`,
    ],
    ['realized pnl', `${lamportsToSolText(report.realizedPnlLamports)}  (${report.realizedPnlLamports} lamports)`],
    ['max drawdown', lamportsToSolText(report.maxDrawdownLamports)],
    ['total fees', lamportsToSolText(report.totalFeesLamports)],
    ['final balance', lamportsToSolText(report.finalBalanceLamports)],
    [
      'guard rejections',
      Object.keys(report.guardRejections).length === 0
        ? 'none'
        : Object.entries(report.guardRejections)
            .map(([code, count]) => `${code}=${count}`)
            .join(' '),
    ],
    ['malformed intents', String(report.malformedIntentCount)],
    [
      'no route while held',
      report.noRouteWhileHeld.length === 0 ? 'none' : report.noRouteWhileHeld.join(' '),
    ],
    [
      'time to exit',
      report.timeToExitMs.count === 0
        ? 'no round trips'
        : `min ${report.timeToExitMs.minMs}ms  median ${report.timeToExitMs.medianMs}ms  max ${report.timeToExitMs.maxMs}ms  [${Object.entries(
            report.timeToExitMs.buckets,
          )
            .map(([label, count]) => `${label}:${count}`)
            .join(' ')}]`,
    ],
    ['ledger reconciles clean', report.ledgerReconcilesClean ? 'yes' : 'NO'],
  ];

  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join('\n');
}

/** The one line that must not be a footnote. */
export function slippageVerdict(sweep: ReadonlyArray<{ bps: number; pnl: bigint }>): string {
  const profitable = sweep.filter((point) => point.pnl > 0n).map((point) => point.bps);
  if (profitable.length === 0) return 'UNPROFITABLE AT EVERY SLIPPAGE TESTED';
  if (profitable.length === sweep.length) return 'profitable at every slippage tested';

  const worst = Math.max(...profitable);
  const firstLoss = sweep.find((point) => point.bps > worst && point.pnl <= 0n);
  return (
    `PROFITABLE ONLY AT OR BELOW ${worst} bps` +
    (firstLoss === undefined ? '' : ` — turns negative by ${firstLoss.bps} bps`) +
    '. The 30 bps default is a guess; this strategy is a bet on that guess.'
  );
}
