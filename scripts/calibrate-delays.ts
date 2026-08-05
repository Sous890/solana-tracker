/**
 * Generate the alpha-decay dataset `calibrate.fit_alpha_half_life` consumes.
 *
 *   npx tsx scripts/calibrate-delays.ts --wallet <address> --sample 200
 *
 * Reads the realised round trips exported by `export-wallet-history.ts`,
 * reconstructs each mint's pool price path, replays every round trip at eight
 * candidate delays, and writes `exports/{wallet}.delays.csv`.
 *
 * ── WHY THIS SAMPLES ──────────────────────────────────────────────────────
 *
 * Cost is dominated by `getTransaction`, one call per pool swap inside a
 * window. A wallet with 3,300 round trips across 300 mints, each window holding
 * tens of pool swaps, is six figures of RPC calls and hours of wall time.
 *
 * The fit does not need that. `fit_alpha_half_life` regresses on the median
 * return at eight delays, so a few hundred round trips already pins each point
 * tightly. The sample is spread evenly across the export's time span rather
 * than taken from the head, because a memecoin wallet's behaviour in one
 * afternoon is not its behaviour over a month — a contiguous block would
 * measure one regime and call it the wallet.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'dotenv/config';
import type { ParsedTransactionWithMeta } from '../src/adapters/swapParser.js';
import type { Address } from '../src/core/types.js';
import {
  DEFAULT_CACHE_DIR,
  getPoolSwaps,
  resolvePoolAccounts,
} from '../src/calibration/poolHistory.js';
import type { PoolRpc, SignaturePage } from '../src/calibration/poolHistory.js';
import {
  DEFAULT_DELAYS_S,
  acceptanceCriteria,
  checkDelayZeroMatchesRealised,
  checkFillRateStability,
  checkFilledRowsHaveSwaps,
  delaysCsv,
  failureAdjustment,
  formatStats,
  replayRoundTrip,
  summarise,
} from '../src/calibration/replayDelays.js';
import type { DelayRow, RoundTripInput } from '../src/calibration/replayDelays.js';

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let rpcCalls = 0;

function rpcUrl(): string {
  const url = process.env['RPC_HTTP_URL'];
  if (url === undefined || url.trim().length === 0) {
    console.error('Missing RPC_HTTP_URL.');
    process.exit(2);
  }
  return url;
}

async function call<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    rpcCalls += 1;
    const response = await fetch(rpcUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (response.status === 429 || response.status >= 500) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    const body = (await response.json()) as { result?: T; error?: { message: string } };
    if (body.error === undefined) return body.result as T;
    // Transient, and Helius signals them as JSON-RPC errors with HTTP 200 —
    // so the status check above never sees them. "Service overloaded" killed a
    // 40-pool run at the seven-minute mark before this list included it.
    if (!/too many requests|rate|overloaded|timeout|try again/i.test(body.error.message)) {
      throw new Error(`${method}: ${body.error.message}`);
    }
    await sleep(1_000 * 2 ** attempt);
  }
  throw new Error(`${method}: gave up`);
}

const rpc: PoolRpc = {
  getSignaturesForAddress: (address, options) =>
    call<SignaturePage[]>('getSignaturesForAddress', [address, options]),
  getTransaction: (signature) =>
    call<ParsedTransactionWithMeta | null>('getTransaction', [
      signature,
      { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' },
    ]),
};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

interface ExportedTrip extends RoundTripInput {
  solIn: number;
  solOut: number;
}

function readRoundTrips(path: string): ExportedTrip[] {
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  const header = (lines[0] ?? '').split(',');
  const index = (name: string): number => header.indexOf(name);

  const iToken = index('token');
  const iSignal = index('signal_ts');
  const iExit = index('exit_ts');
  const iIn = index('sol_in');
  const iOut = index('sol_out');
  const iSig = index('entry_signature');

  if (iSig === -1) {
    console.error(
      'This export has no `entry_signature` column. Re-run export-wallet-history.ts — the\n' +
        'pool for a mint is resolved by inspecting one of its real swaps, and without a\n' +
        'signature there is nothing to inspect.',
    );
    process.exit(2);
  }

  const trips: ExportedTrip[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const solOut = Number(cells[iOut]);
    // Open positions carry an empty sol_out. They have no exit, so there is no
    // forward return to measure — this is the same filter `filter_realised`
    // applies, done here because the replay needs an exit price.
    if (cells[iOut] === '' || !Number.isFinite(solOut)) continue;

    trips.push({
      token: cells[iToken] as Address,
      signature: cells[iSig] as string,
      signalTs: Number(cells[iSignal]),
      exitTs: Number(cells[iExit]),
      solIn: Number(cells[iIn]),
      solOut,
    });
  }
  return trips;
}

/** Evenly spaced across the time-ordered set. See the module header. */
function sampleEvenly<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  const step = items.length / count;
  return Array.from({ length: count }, (_, i) => items[Math.floor(i * step)] as T);
}

/**
 * The most recent `count`, for `--recent`.
 *
 * Trades calendar coverage for fill coverage, and exists because of a measured
 * failure. `getSignaturesForAddress` pages backwards from the tip only, so
 * reaching a window three weeks old on a hot pool costs more signatures than
 * `maxSignatures` allows — the walk stops short and the window comes back
 * empty. A run spread evenly over 20 days recorded **82 of 119 round trips as
 * NO_FILL at delay 0, every one of them an empty window**, which reads as "the
 * token stopped trading" and actually means "we never fetched that far back".
 *
 * Sampling recent trips keeps every window inside signature reach. The cost is
 * real and must be stated wherever the output is used: the sample then
 * describes one recent regime rather than the wallet's whole history.
 */
function sampleRecent<T>(items: T[], count: number): T[] {
  return items.length <= count ? items : items.slice(-count);
}

/**
 * At most one round trip per mint, keeping the earliest entry for each.
 *
 * A FIFO scale-out turns one decision into many round trips — one mint
 * contributed five rows at a single delay in the previous run — so an
 * undeduplicated sample of 120 collapsed onto 14 mints and the effective sample
 * size was 14, not 120. Deduplicating spends the sample on distinct decisions.
 *
 * It also removes a weighting bias: with several tranches per mint, a mint the
 * wallet scaled out of five times counts five times toward every aggregate,
 * quietly tilting the estimate toward heavily-traded mints.
 *
 * The earliest entry per mint is kept because that is the one a copier would
 * actually have acted on — the later tranches are the wallet managing a
 * position it already holds, which is not a signal to mirror.
 */
function oneTripPerMint<T extends { token: string; signalTs: number }>(items: T[]): T[] {
  const best = new Map<string, T>();
  for (const item of items) {
    const held = best.get(item.token);
    if (held === undefined || item.signalTs < held.signalTs) best.set(item.token, item);
  }
  return [...best.values()].sort((a, b) => a.signalTs - b.signalTs);
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };

  const wallet = get('--wallet');
  if (wallet === undefined) {
    console.error('Usage: --wallet <address> [--sample 200] [--exports exports] [--failed N]');
    process.exit(2);
  }

  const exportsDir = get('--exports') ?? 'exports';
  const sampleSize = Number(get('--sample') ?? 200);
  const failedTransactions = Number(get('--failed') ?? 0);
  const cacheDir = get('--cache') ?? DEFAULT_CACHE_DIR;
  const maxFetches = Number(get('--max-fetches') ?? 1_500);

  const all = readRoundTrips(resolve(exportsDir, `${wallet}.csv`));
  const ordered = [...all].sort((a, b) => a.signalTs - b.signalTs);
  const recentOnly = argv.includes('--recent');
  // Dedupe FIRST, then sample: sampling 120 rows and then collapsing them onto
  // 14 mints is how the previous run ended up with an effective n of 14.
  const perMint = argv.includes('--no-dedupe') ? ordered : oneTripPerMint(ordered);
  const sample = recentOnly
    ? sampleRecent(perMint, sampleSize)
    : sampleEvenly(perMint, sampleSize);

  console.error(`wallet          ${wallet}`);
  console.error(`realised trips  ${all.length}`);
  console.error(`distinct mints  ${perMint.length} (one round trip per mint unless --no-dedupe)`);
  console.error(
    `sampled         ${sample.length} (${recentOnly ? 'most recent — see sampleRecent' : 'evenly spaced across the span'})`,
  );
  console.error(
    `span            ${new Date(ordered[0]?.signalTs ?? 0).toISOString().slice(0, 16)} -> ` +
      `${new Date(ordered[ordered.length - 1]?.signalTs ?? 0).toISOString().slice(0, 16)}\n`,
  );

  // -- resolve pools ------------------------------------------------------

  const byMint = new Map<string, ExportedTrip[]>();
  for (const trip of sample) {
    const list = byMint.get(trip.token) ?? [];
    list.push(trip);
    byMint.set(trip.token, list);
  }

  console.error(`resolving ${byMint.size} pool(s)…`);
  const pools = new Map<string, Address>();
  let ambiguous = 0;
  let unresolved = 0;

  for (const [mint, trips] of byMint) {
    const probe = trips[0] as ExportedTrip;
    const tx = await rpc.getTransaction(probe.signature);
    if (tx === null) {
      unresolved += 1;
      continue;
    }
    // The taker in that transaction is the wallet whose history this is.
    const candidates = resolvePoolAccounts(tx, mint, wallet as Address);
    if (candidates.length === 0) {
      unresolved += 1;
      continue;
    }
    if (candidates.length > 1) ambiguous += 1;
    pools.set(mint, candidates[0] as Address);
  }

  console.error(`  resolved      ${pools.size}`);
  console.error(`  ambiguous     ${ambiguous} (multi-hop route; largest counterparty used)`);
  console.error(`  unresolved    ${unresolved}\n`);

  // -- replay -------------------------------------------------------------

  const rows: DelayRow[] = [];
  let done = 0;
  let truncatedPools = 0;
  let cappedPools = 0;
  const failedPools: Array<{ mint: string; message: string }> = [];

  for (const [mint, trips] of byMint) {
    const pool = pools.get(mint);
    if (pool === undefined) continue;

    // One narrow interval PER ROUND TRIP, unioned — never min(from)..max(to).
    // The 30s margin lets a delayed entry near the end still find a fill and
    // keeps the exit lookup off the window edge.
    // See `PoolWindow.intervals` for what the wide version cost.
    const intervals = trips.map((t) => ({
      fromTs: t.signalTs - 30_000,
      toTs: t.exitTs + 30_000,
    }));
    // One pool must not end the run. A long analysis pass that dies on its
    // 41st of 86 pools has produced nothing, and the RPC spend is already gone;
    // recording the casualty and continuing keeps the dataset usable and makes
    // the loss countable.
    try {
      const result = await getPoolSwaps(
        { mint: mint as Address, poolAccount: pool, intervals },
        { rpc, cacheDir, concurrency: 4, maxFetches },
      );
      if (result.fetchCapped) cappedPools += 1;
      if (result.truncated) truncatedPools += 1;

      for (const trip of trips) rows.push(...replayRoundTrip(trip, result.swaps));
    } catch (cause) {
      failedPools.push({ mint, message: (cause as Error).message });
    }

    done += 1;
    process.stderr.write(`\r  replayed ${done}/${pools.size} pools, ${rows.length} rows`);
  }
  process.stderr.write('\r');

  // -- output -------------------------------------------------------------

  mkdirSync(exportsDir, { recursive: true });
  // Timestamped, so a run can never overwrite the one before it. The previous
  // pass destroyed a passing dataset by writing over it.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = resolve(exportsDir, `${wallet}.delays.${stamp}.csv`);
  writeFileSync(outPath, delaysCsv(rows), 'utf8');

  const stats = summarise(rows, DEFAULT_DELAYS_S);

  console.error(`\n── DELAY DIAGNOSTICS ──────────────────────────────────────────────────\n`);
  console.error(formatStats(stats));

  // -- sanity -------------------------------------------------------------

  // Keyed on entry signature AND exit timestamp. The signature alone is not
  // unique: a FIFO scale-out produces several round trips from one entry, and
  // keying on it would silently collapse them onto whichever the map saw last.
  const walletReturns = new Map<string, number>();
  for (const trip of sample) {
    if (trip.solIn > 0) {
      walletReturns.set(`${trip.signature}:${trip.exitTs}`, trip.solOut / trip.solIn - 1);
    }
  }

  const checks = [
    checkDelayZeroMatchesRealised(stats, rows, (row) =>
      walletReturns.get(`${row.signature}:${row.exitTs}`) ?? Number.NaN,
    ),
    checkFilledRowsHaveSwaps(rows),
  ];

  console.error(`\n── SANITY CHECKS ──────────────────────────────────────────────────────\n`);
  for (const check of checks) {
    console.error(`  ${check.passed ? 'PASS' : 'FAIL'}  ${check.name}`);
    console.error(`        ${check.detail}`);
  }

  // -- part 4 -------------------------------------------------------------

  const adjustment = failureAdjustment(wallet as Address, failedTransactions, all.length);
  const survivorship = checkFillRateStability(stats);
  console.error(`\n── SURVIVORSHIP ───────────────────────────────────────────────────────\n`);
  console.error(`  ${survivorship.triggered ? 'WARN' : 'ok  '}  ${survivorship.detail}`);

  console.error(`\n── ACCEPTANCE CRITERIA (fixed before the run) ─────────────────────────\n`);
  for (const criterion of acceptanceCriteria(stats)) {
    console.error(`  ${criterion.passed ? 'PASS' : 'FAIL'}  ${criterion.name}`);
    console.error(`        ${criterion.detail}`);
  }

  console.error(`\n── FAILURE-RATE COST ADJUSTMENT ───────────────────────────────────────\n`);
  console.error(`  failed transactions      ${adjustment.failedTransactions}`);
  console.error(`  successful round trips   ${adjustment.successfulRoundTrips}`);
  console.error(`  failure_rate             ${(adjustment.failureRate * 100).toFixed(2)}%`);
  console.error(`  priority_fee multiplier  ${adjustment.priorityFeeMultiplier.toFixed(4)}`);
  console.error(`  (apply to PoolState.priority_fee_sol before sizing; never hardcode)`);

  console.error(`\n  pools truncated at the signature cap: ${truncatedPools}`);
  console.error(`  pools clipped at the fetch cap:       ${cappedPools}`);
  console.error(`  pools that failed outright:          ${failedPools.length}`);
  for (const failure of failedPools.slice(0, 5)) {
    console.error(`    ${failure.mint.slice(0, 12)}… ${failure.message}`);
  }
  console.error(`  -> ${outPath}`);
  console.error(`  ${rows.length} rows, ${rpcCalls} RPC calls\n`);

  if (checks.some((check) => !check.passed)) process.exitCode = 1;
}

await main();
