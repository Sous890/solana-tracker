/**
 * Export a tracked wallet's CLOSED round trips to CSV, for `calibrate.py`.
 *
 *   npx tsx scripts/export-wallet-history.ts --days 30
 *
 * ── WHY THIS EXISTS RATHER THAN READING THE SESSION FILES ─────────────────
 *
 * `calibrate.py` wants realised round trips: a buy paired to the sell that
 * closed it. The recorded sessions in `sessions/` span 51 seconds, which
 * contains essentially no complete round trips — `filter_realised` would drop
 * everything and `realised_stats` would raise on an empty frame. The fix is
 * more history, not a looser definition of "closed": marking open bags at last
 * price is the exact thing `calibrate.py`'s docstring exists to prevent.
 *
 * ── THIS IS NOT PART OF THE TRACKER ───────────────────────────────────────
 *
 * An offline analysis step, run against a wallet BEFORE it is added to
 * `trackedWallets`. It lives in `scripts/` for the same reason
 * `record-transactions.ts` does: it talks to a real RPC, it is slow, and
 * nothing in `src/` may import it.
 *
 * ── SIGNAL TIME EQUALS ENTRY TIME, DELIBERATELY ───────────────────────────
 *
 * The schema carries both `signal_ts` and `entry_ts` so that a bot's execution
 * delay can be modelled. This export has no bot in it — it is the wallet's own
 * history, so the signal *is* the entry and the two are equal by construction.
 *
 * That makes every statistic computed from this file a **zero-latency upper
 * bound**: what a copier who was infinitely fast and paid no fees would have
 * got. A real copier is strictly worse. `latency_adjusted_outcomes` is the
 * function that closes that gap, and it needs inputs this project does not yet
 * have (see handoff 16).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'dotenv/config';
import { parseSwap } from '../src/adapters/swapParser.js';
import type { ParsedTransactionWithMeta } from '../src/adapters/swapParser.js';
import type { Address, TrackedSwap } from '../src/core/types.js';
import { isTransientRpcMessage } from '../src/adapters/rpcTransient.js';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Signatures per `getSignaturesForAddress` page. The RPC maximum. */
const PAGE_SIZE = 1_000;

/** Concurrent `getTransaction` calls. Helius tolerates this; be polite anyway. */
const FETCH_CONCURRENCY = 8;

/**
 * Round trips smaller than this are dropped as dust.
 *
 * Not a judgement about the wallet — a judgement about the arithmetic. A
 * 0.0004 SOL entry that returns 0.0008 SOL is a +100% trade that no copier
 * could have taken at `positionSizeSol`, and leaving it in would let a rounding
 * artefact dominate `top_trade_share`.
 */
const DUST_SOL = 0.001;

const LAMPORTS_PER_SOL = 1_000_000_000n;

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

interface SignatureEntry {
  signature: string;
  slot: number;
  err: unknown | null;
  blockTime?: number | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function rpcUrl(): string {
  const url = process.env['RPC_HTTP_URL'];
  if (url === undefined || url.trim().length === 0) {
    console.error('Missing RPC_HTTP_URL. This script needs the same .env `npm run serve` uses.');
    process.exit(2);
  }
  return url;
}

let rpcCalls = 0;

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
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
    // Helius signals transient failures as JSON-RPC errors with HTTP 200, so the
    // status check above never sees them. Shared classifier — this script is the
    // second to learn that lesson the hard way.
    if (!isTransientRpcMessage(body.error.message)) {
      throw new Error(`${method}: ${body.error.message}`);
    }
    await sleep(1_000 * 2 ** attempt);
  }
  throw new Error(`${method}: gave up after 6 attempts`);
}

/** Page backwards from the tip until the cutoff or the signature cap. */
async function walkSignatures(
  wallet: Address,
  sinceUnixSeconds: number,
  maxSignatures: number,
): Promise<{ entries: SignatureEntry[]; reachedCutoff: boolean }> {
  const entries: SignatureEntry[] = [];
  let before: string | undefined;

  for (;;) {
    const page = await rpc<SignatureEntry[]>('getSignaturesForAddress', [
      wallet,
      { limit: PAGE_SIZE, ...(before === undefined ? {} : { before }) },
    ]);
    if (page.length === 0) return { entries, reachedCutoff: true };

    for (const entry of page) {
      // `blockTime` is nullable. A null here cannot be compared to the cutoff,
      // so it is kept rather than guessed at — the parser will decide whether
      // it is usable, and a round trip missing a timestamp is dropped later.
      if (entry.blockTime != null && entry.blockTime < sinceUnixSeconds) {
        return { entries, reachedCutoff: true };
      }
      entries.push(entry);
      if (entries.length >= maxSignatures) return { entries, reachedCutoff: false };
    }

    if (page.length < PAGE_SIZE) return { entries, reachedCutoff: true };
    before = page[page.length - 1]?.signature;
    if (before === undefined) return { entries, reachedCutoff: true };

    process.stderr.write(`\r  ${wallet.slice(0, 8)}… ${entries.length} signatures`);
  }
}

// ---------------------------------------------------------------------------
// Round trips
// ---------------------------------------------------------------------------

export interface RoundTrip {
  token: Address;
  signalTs: number;
  entryTs: number;
  /** NaN for a position still open. `filter_realised` is what drops those. */
  exitTs: number;
  solIn: number;
  solOut: number;
  /**
   * The entry transaction, appended as the LAST column.
   *
   * Last so that anything reading this file positionally is unaffected — the
   * six columns `calibrate.py` asks for keep their indices. It is here because
   * `src/calibration/poolHistory.ts` resolves a mint's pool account by
   * inspecting one real swap for it, and without a signature there is nothing
   * to inspect short of walking the wallet again.
   */
  entrySignature: string;
  /** The closing transaction. Empty for a position still open. */
  exitSignature: string;
}

interface Lot {
  tokens: bigint;
  lamportsIn: bigint;
  entryTs: number;
  signature: string;
}

/**
 * Pair buys to sells FIFO, per mint.
 *
 * FIFO rather than average cost because `calibrate.py` wants individual round
 * trips, not a per-mint aggregate: `top_trade_share` and `payoff_ratio` are
 * both statements about the distribution across trades, and averaging the
 * entries away would flatten exactly the shape being measured.
 *
 * A partial sell splits the lot proportionally on both legs. A wallet that
 * scales out of one entry across three sells produces three round trips, which
 * is what actually happened.
 */
export function pairFifo(swaps: TrackedSwap[]): { trips: RoundTrip[]; open: RoundTrip[] } {
  const byMint = new Map<string, TrackedSwap[]>();
  for (const swap of swaps) {
    const list = byMint.get(swap.mint) ?? [];
    list.push(swap);
    byMint.set(swap.mint, list);
  }

  const trips: RoundTrip[] = [];
  const open: RoundTrip[] = [];

  for (const [mint, all] of byMint) {
    // Oldest first, by slot. `blockTime` is not monotonic across slots and must
    // not be used to order — the same rule `walletStream.orderOldestFirst` follows.
    const ordered = [...all].sort((a, b) => a.slot - b.slot);
    const lots: Lot[] = [];

    for (const swap of ordered) {
      const ts = swap.blockTime == null ? Number.NaN : swap.blockTime * 1_000;

      if (swap.side === 'buy') {
        lots.push({
          tokens: swap.tokenAmount,
          lamportsIn: swap.solAmount,
          entryTs: ts,
          signature: swap.signature,
        });
        continue;
      }

      // A sell with no open lot is a bag acquired outside the window we walked —
      // an airdrop, or a buy older than the cutoff. It closes nothing here and
      // inventing an entry for it would fabricate a return.
      let remaining = swap.tokenAmount;
      while (remaining > 0n && lots.length > 0) {
        const lot = lots[0] as Lot;
        const take = lot.tokens < remaining ? lot.tokens : remaining;
        if (take <= 0n) break;

        const solIn = (lot.lamportsIn * take) / lot.tokens;
        const solOut = (swap.solAmount * take) / swap.tokenAmount;

        trips.push({
          token: mint,
          signalTs: lot.entryTs,
          entryTs: lot.entryTs,
          exitTs: ts,
          solIn: Number(solIn) / Number(LAMPORTS_PER_SOL),
          solOut: Number(solOut) / Number(LAMPORTS_PER_SOL),
          entrySignature: lot.signature,
          exitSignature: swap.signature,
        });

        lot.lamportsIn -= solIn;
        lot.tokens -= take;
        remaining -= take;
        if (lot.tokens <= 0n) lots.shift();
      }
    }

    // Whatever is left was never closed. Emitted with `sol_out` absent so that
    // `filter_realised` drops it — deliberately not dropped here, because "how
    // many of this wallet's entries never closed" is itself a finding.
    for (const lot of lots) {
      open.push({
        token: mint,
        signalTs: lot.entryTs,
        entryTs: lot.entryTs,
        exitTs: Number.NaN,
        solIn: Number(lot.lamportsIn) / Number(LAMPORTS_PER_SOL),
        solOut: Number.NaN,
        entrySignature: lot.signature,
        exitSignature: '',
      });
    }
  }

  return { trips, open };
}

// ---------------------------------------------------------------------------
// Failure detail
// ---------------------------------------------------------------------------

export interface FailureRow {
  signature: string;
  slot: number;
  blockTime: number | null;
  reason: string;
  /**
   * The mint the wallet was *trying* to trade, where it can be read off.
   *
   * Not a parse. A failed transaction moves nothing, so `swapParser` correctly
   * refuses it and there is no parsed mint to report. But the token accounts it
   * touched are still listed in `meta.preTokenBalances`, and the single non-WSOL
   * mint among them is the intended target. That is a field read, not a second
   * classifier — which is why it is allowed to live here.
   *
   * Empty when the transaction touched no token account, or more than one
   * non-WSOL mint, in which case guessing would be fabrication.
   */
  intendedMint: string;
}

const WSOL = 'So11111111111111111111111111111111111111112';

export function intendedMintOf(tx: ParsedTransactionWithMeta): string {
  const balances = [
    ...((tx.meta?.preTokenBalances ?? []) as Array<{ mint?: string }>),
    ...((tx.meta?.postTokenBalances ?? []) as Array<{ mint?: string }>),
  ];
  const mints = new Set(
    balances
      .map((b) => b.mint)
      .filter((m): m is string => typeof m === 'string' && m !== WSOL),
  );
  return mints.size === 1 ? ([...mints][0] as string) : '';
}

function failuresCsv(rows: FailureRow[]): string {
  const lines = ['signature,slot,block_time,reason,intended_mint'];
  for (const row of rows) {
    lines.push(
      [row.signature, row.slot, row.blockTime ?? '', row.reason, row.intendedMint].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function csvOf(rows: RoundTrip[]): string {
  const cell = (value: number): string => (Number.isNaN(value) ? '' : String(value));
  const lines = ['token,signal_ts,entry_ts,exit_ts,sol_in,sol_out,entry_signature,exit_signature'];
  for (const row of rows) {
    lines.push(
      [
        row.token,
        cell(row.signalTs),
        cell(row.entryTs),
        cell(row.exitTs),
        cell(row.solIn),
        cell(row.solOut),
        row.entrySignature,
        row.exitSignature,
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Args {
  wallets: Address[];
  days: number;
  maxSignatures: number;
  outDir: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };

  const explicit = get('--wallets');
  let wallets: Address[];
  if (explicit !== undefined) {
    wallets = explicit.split(',').map((w) => w.trim()).filter((w) => w.length > 0);
  } else {
    const configPath = process.env['CONFIG_PATH'] ?? 'config.json';
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { trackedWallets?: string[] };
    wallets = config.trackedWallets ?? [];
  }

  return {
    wallets,
    days: Number(get('--days') ?? 30),
    maxSignatures: Number(get('--max-signatures') ?? 5_000),
    outDir: get('--out') ?? 'exports',
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.wallets.length === 0) {
    console.error('No wallets. Pass --wallets, or put them in config.json trackedWallets.');
    process.exit(2);
  }

  const cutoff = Math.floor(Date.now() / 1_000) - args.days * 86_400;
  mkdirSync(args.outDir, { recursive: true });

  console.error(
    `Exporting ${args.wallets.length} wallet(s), back ${args.days} days ` +
      `(cutoff ${new Date(cutoff * 1_000).toISOString()}), cap ${args.maxSignatures} signatures each.\n`,
  );

  for (const wallet of args.wallets) {
    const startedAt = Date.now();
    console.error(`── ${wallet}`);

    const { entries, reachedCutoff } = await walkSignatures(wallet, cutoff, args.maxSignatures);
    process.stderr.write('\r');
    console.error(`  signatures walked      ${entries.length}${reachedCutoff ? '' : ' (HIT CAP)'}`);

    const swaps: TrackedSwap[] = [];
    const failures = new Map<string, number>();
    const failureRows: FailureRow[] = [];
    let missing = 0;

    for (let i = 0; i < entries.length; i += FETCH_CONCURRENCY) {
      const batch = entries.slice(i, i + FETCH_CONCURRENCY);
      const fetched = await Promise.all(
        batch.map(async (entry) => {
          const tx = await rpc<ParsedTransactionWithMeta | null>('getTransaction', [
            entry.signature,
            { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' },
          ]);
          return tx;
        }),
      );

      for (const tx of fetched) {
        if (tx === null) {
          missing += 1;
          continue;
        }
        // The tracker's parser, not a second one. A separate implementation
        // here would mean the export describes trades the bot would not see.
        const result = parseSwap(tx, wallet, { source: 'gapfill', observedAt: Date.now() });
        if (result.kind === 'swap') {
          swaps.push(result.swap);
        } else {
          failures.set(result.reason, (failures.get(result.reason) ?? 0) + 1);
          failureRows.push({
            signature: result.signature,
            slot: tx.slot,
            blockTime: tx.blockTime ?? null,
            reason: result.reason,
            intendedMint: intendedMintOf(tx),
          });
        }
      }

      process.stderr.write(
        `\r  fetching…              ${Math.min(i + FETCH_CONCURRENCY, entries.length)}/${entries.length}`,
      );
    }
    process.stderr.write('\r');

    const { trips, open } = pairFifo(swaps);
    const kept = trips.filter((t) => t.solIn >= DUST_SOL && !Number.isNaN(t.exitTs));
    const dust = trips.length - kept.length;

    const rows = [...kept, ...open];
    const outPath = resolve(args.outDir, `${wallet}.csv`);
    writeFileSync(outPath, csvOf(rows), 'utf8');

    const failPath = resolve(args.outDir, `${wallet}.failures.csv`);
    writeFileSync(failPath, failuresCsv(failureRows), 'utf8');

    const buys = swaps.filter((s) => s.side === 'buy').length;
    console.error(`  swaps parsed           ${swaps.length} (${buys} buy / ${swaps.length - buys} sell)`);
    console.error(`  transactions missing   ${missing}`);
    console.error('  parse failures by code');
    if (failures.size === 0) console.error('    (none)');
    for (const [code, count] of [...failures].sort((a, b) => b[1] - a[1])) {
      console.error(`    ${code.padEnd(22)} ${count}`);
    }
    console.error(`  round trips formed     ${trips.length}`);
    console.error(`  dropped as dust        ${dust} (< ${DUST_SOL} SOL in)`);
    console.error(`  still open (sol_out=)  ${open.length}`);
    console.error(`  REALISED ROUND TRIPS   ${kept.length}`);
    console.error(`  -> ${outPath}`);
    console.error(`  -> ${failPath}`);
    console.error(`  ${((Date.now() - startedAt) / 1_000).toFixed(1)}s, ${rpcCalls} RPC calls\n`);
  }
}

await main();
