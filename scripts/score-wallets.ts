/**
 * Compute per-wallet copyability from the recorded corpus.
 *
 * This is the SLOW loop's job. It lives as a script until prompt 17 gives the
 * slow loop a home; the artifact shape is the seam, so moving the producer later
 * changes nothing for the fast loop, which only ever does a map lookup.
 *
 *   npx tsx scripts/score-wallets.ts [--out data/wallet-scores.json] [--delay-ms 5479]
 *
 * `--delay-ms` is this process's chain-to-fill. The share is meaningless without
 * it, which is why it is recorded on every score rather than assumed.
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WalletScore, WalletScoresFile } from '../src/services/walletScores.js';

const args = new Map<string, string>();
for (const token of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/.exec(token);
  if (match !== null) args.set(match[1]!, match[2]!);
}
const outPath = args.get('out') ?? 'data/wallet-scores.json';
const delayMs = Number(args.get('delay-ms') ?? 5_479);

interface Swap {
  wallet: string;
  mint: string;
  side: 'buy' | 'sell';
  slot: number;
  blockTime: number | null;
}

/**
 * Sessions before the subscription-routing fix (fae02b9, 2026-08-06) fanned one
 * notification out to every tracked wallet, so their swaps are attributed to
 * wallets that had nothing to do with them. A per-wallet score built on that is
 * not a weaker measurement, it is a wrong one — so those files are excluded
 * rather than down-weighted.
 */
const ROUTING_FIX_PREFIX = '20260806';
const since = args.get('since') ?? ROUTING_FIX_PREFIX;
const allFiles = readdirSync('sessions').filter((f) => f.endsWith('.jsonl') && !f.startsWith('._'));
const files = allFiles.filter((f) => f >= since);
console.log(`sessions: ${files.length} of ${allFiles.length} (excluded ${allFiles.length - files.length} pre-routing-fix)`);
const swaps: Swap[] = [];
let from = Number.POSITIVE_INFINITY;
let to = 0;

for (const file of files) {
  for (const line of readFileSync(`sessions/${file}`, 'utf8').split('\n')) {
    if (line === '') continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record.simClockMs === 'number') {
      from = Math.min(from, record.simClockMs);
      to = Math.max(to, record.simClockMs);
    }
    if (record.kind !== 'swap') continue;
    const p = record.payload;
    swaps.push({
      wallet: p.wallet,
      mint: p.mint,
      side: p.side,
      slot: p.slot,
      blockTime: p.blockTime ?? null,
    });
  }
}

/** FIFO-pair each wallet's buys to its later sells, per mint. */
const holdsByWallet = new Map<string, number[]>();
const byKey = new Map<string, Swap[]>();
for (const s of swaps) {
  const key = `${s.wallet}|${s.mint}`;
  const list = byKey.get(key);
  if (list === undefined) byKey.set(key, [s]);
  else list.push(s);
}
for (const [key, list] of byKey) {
  list.sort((a, b) => a.slot - b.slot);
  const open: Swap[] = [];
  const wallet = key.split('|')[0]!;
  for (const s of list) {
    if (s.side === 'buy') {
      open.push(s);
      continue;
    }
    const buy = open.shift();
    if (buy === undefined) continue;
    if (buy.blockTime === null || s.blockTime === null) continue;
    const holds = holdsByWallet.get(wallet) ?? [];
    holds.push((s.blockTime - buy.blockTime) * 1_000);
    holdsByWallet.set(wallet, holds);
  }
  // Unpaired buys are deliberately NOT counted: a position still open, or one
  // whose exit fell outside the window, would bias hold time upward.
}

const scores: WalletScore[] = [];
for (const [wallet, holds] of [...holdsByWallet].sort()) {
  const uncopyable = holds.filter((h) => h <= delayMs).length;
  scores.push({
    wallet,
    uncopyableShare: uncopyable / holds.length,
    roundTrips: holds.length,
    againstDelayMs: delayMs,
    measuredFrom: new Date(from).toISOString(),
    measuredTo: new Date(to).toISOString(),
  });
}

const file: WalletScoresFile = {
  generatedAt: new Date().toISOString(),
  basis:
    `paired round trips from ${files.length} session file(s); a trip counts as uncopyable when ` +
    `it closes within ${delayMs}ms of opening, which is this process's measured chain-to-fill`,
  scores,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(file, null, 2)}\n`);

console.log(`wrote ${outPath}  (${scores.length} wallets, ${swaps.length} swaps)`);
for (const s of scores.sort((a, b) => b.uncopyableShare - a.uncopyableShare)) {
  console.log(
    `  ${s.wallet.slice(0, 8)}  share ${(s.uncopyableShare * 100).toFixed(1).padStart(5)}%  ` +
      `n=${String(s.roundTrips).padStart(3)}`,
  );
}
