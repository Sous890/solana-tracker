/**
 * What is actually in the unparsed set, and how much of it was a real swap.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * Handoff 19 reported a 71% unparsed share and called it gap 9. That number is
 * real but it is not the number anybody wants: it counts every transaction the
 * parser declined, and most of those declined correctly — a failed transaction
 * and an ATA creation are not swaps and never were.
 *
 * The number that matters is the **swap-like unparsed rate**: of the things the
 * parser declined, how many would have parsed as a swap if it had seen them
 * properly. Session 20 measured that at ~34% against a raw 71%, and found the
 * cause is not the parser at all. See docs/handoffs/20-*.md.
 *
 * ── WHY IT NEEDS THE NETWORK ──────────────────────────────────────────────
 *
 * A session records only `{reason, signature}` for an unparsed transaction. It
 * does not record the program id, and it does not record `parseSwap`'s `detail`
 * — the field that separates "the wallet genuinely is not in this transaction"
 * from "the account key list did not line up". So the transactions have to be
 * fetched back. This is the one script that is expected to hit RPC.
 *
 * Uses the app's own `createRpcClient` and `parseSwap`, so what it reports is
 * what production would have done, not a reimplementation.
 *
 * Usage:
 *   npx tsx scripts/classify-unparsed.ts <session.jsonl> [--per-reason 40]
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createRpcClient } from '../src/adapters/rpcClient.js';
import { accountKeyList, parseSwap } from '../src/adapters/swapParser.js';
import type { ParsedTransactionWithMeta } from '../src/adapters/swapParser.js';
import type { Address, Signature } from '../src/core/types.js';

/** Helius rate-limits around 10 rps and answers overload with HTTP 200. */
const REQUESTS_PER_SECOND = 4;

const [sessionPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (sessionPath === undefined) {
  console.error('usage: classify-unparsed <session.jsonl> [--per-reason N]');
  process.exit(2);
}
const perReasonFlag = process.argv.indexOf('--per-reason');
const perReason = perReasonFlag === -1 ? 40 : Number(process.argv[perReasonFlag + 1]);

const wallets: Address[] = JSON.parse(readFileSync('config.json', 'utf8')).trackedWallets;

// -- what the session says --------------------------------------------------

const byReason = new Map<string, string[]>();
let parsedSwaps = 0;
for (const line of readFileSync(sessionPath, 'utf8').split('\n')) {
  if (line.trim() === '') continue;
  const entry = JSON.parse(line) as {
    kind: string;
    payload: { tag?: string; raw?: { reason: string; signature: string } };
  };
  if (entry.kind === 'swap') parsedSwaps += 1;
  if (entry.kind !== 'unmodeled' || entry.payload.tag !== 'tracker:swap-unparsed') continue;
  const raw = entry.payload.raw!;
  byReason.set(raw.reason, [...(byReason.get(raw.reason) ?? []), raw.signature]);
}
const unparsed = [...byReason.values()].reduce((n, l) => n + l.length, 0);

console.log(`parsed swaps ${parsedSwaps}   unparsed ${unparsed}`);
console.log(`raw unparsed share ${((100 * unparsed) / (unparsed + parsedSwaps)).toFixed(1)}%\n`);
for (const [reason, list] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(list.length).padStart(5)}  ${((100 * list.length) / unparsed).toFixed(1)}%  ${reason}`);
}

/** Spread across the whole session, not the first N — those share one burst. */
function spread(list: string[], n: number): string[] {
  if (list.length <= n) return list;
  const step = list.length / n;
  return Array.from({ length: n }, (_, i) => list[Math.floor(i * step)]!);
}

// -- what the chain says ----------------------------------------------------

const rpc = createRpcClient({ httpUrl: process.env.RPC_HTTP_URL! });
const programs = new Map<string, number>();
const bump = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);

console.log('\nfetching…');
const verdicts = new Map<string, Map<string, number>>();
const mismatches = new Map<string, number>();

for (const [reason, list] of byReason) {
  const picked = spread(list, perReason);
  verdicts.set(reason, new Map());
  mismatches.set(reason, 0);

  for (const signature of picked) {
    await new Promise((r) => setTimeout(r, 1000 / REQUESTS_PER_SECOND));
    let tx: ParsedTransactionWithMeta | null;
    try {
      tx = await rpc.getTransaction(signature as Signature);
    } catch {
      bump(verdicts.get(reason)!, 'FETCH_FAILED');
      continue;
    }
    if (tx === null) {
      bump(verdicts.get(reason)!, 'TX_NOT_FOUND');
      continue;
    }

    const message = tx.transaction.message as unknown as {
      instructions?: Array<{ programId?: string }>;
    };
    const meta = tx.meta as unknown as {
      innerInstructions?: Array<{ instructions?: Array<{ programId?: string }> }>;
    } | null;
    for (const ix of message.instructions ?? []) if (ix.programId) bump(programs, ix.programId);
    for (const inner of meta?.innerInstructions ?? [])
      for (const ix of inner.instructions ?? []) if (ix.programId) bump(programs, ix.programId);

    if (accountKeyList(tx) === undefined) {
      mismatches.set(reason, mismatches.get(reason)! + 1);
    }

    // Re-parsed against every tracked wallet. If it parses now, the transaction
    // was always a swap and the live attempt saw something incomplete.
    const parses = wallets.some(
      (w) => parseSwap(tx!, w, { source: 'live', observedAt: 0 }).kind === 'swap',
    );
    bump(verdicts.get(reason)!, parses ? 'PARSES_AS_SWAP_NOW' : 'NOT_A_SWAP');
  }
}

console.log('\n================ RE-PARSED VERDICTS ================');
let swapLike = 0;
for (const [reason, counts] of verdicts) {
  const sampled = [...counts.values()].reduce((a, b) => a + b, 0);
  const hits = counts.get('PARSES_AS_SWAP_NOW') ?? 0;
  const rate = sampled === 0 ? 0 : hits / sampled;
  swapLike += rate * (byReason.get(reason)?.length ?? 0);
  console.log(
    `\n${reason}: sampled ${sampled}, key-list mismatch ${mismatches.get(reason)}` +
      `\n    swap-like rate ${(100 * rate).toFixed(1)}%  ->  ~${Math.round(rate * (byReason.get(reason)?.length ?? 0))} of ${byReason.get(reason)?.length}`,
  );
  for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`      ${v}  ${k}`);
}

console.log('\n================ HEADLINE ================');
console.log(`raw unparsed share      ${((100 * unparsed) / (unparsed + parsedSwaps)).toFixed(1)}%`);
console.log(
  `swap-like unparsed rate ${((100 * swapLike) / (swapLike + parsedSwaps)).toFixed(1)}%` +
    `   (~${Math.round(swapLike)} swaps lost against ${parsedSwaps} recorded)`,
);

console.log('\n=== program ids across the sample ===');
for (const [id, n] of [...programs].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${String(n).padStart(4)}  ${id}`);
}
