/**
 * The detection leg, measured rather than guessed.
 *
 * ── WHAT THIS IS, AND WHAT IT IS NOT ──────────────────────────────────────
 *
 * `stream-fetch-window` records, per signature, how many `getTransaction`
 * attempts it took before the transaction was returnable and how long that
 * took. That is the **detection leg only**: the gap between the socket
 * announcing a signature and this process being able to read it.
 *
 * **It is a LOWER BOUND on copy delay, not the delay.** It excludes the quote,
 * the guard layer, and the fill. `example.py` assumes 1.2s for the whole thing;
 * this number is one component of that, and CLAUDE.md gap 6 is the standing
 * record that the rest is still unmeasured.
 *
 * Split by source, and read the `live` rows. `gapfill` signatures are minutes to
 * hours old and were always fetchable, so mixing them in drags every percentile
 * toward the RPC round trip and hides the window entirely.
 *
 * Usage:
 *   npx tsx scripts/detection-window.ts <session.jsonl>
 */

import { readFileSync } from 'node:fs';

interface Window {
  wallet: string;
  signature: string;
  attempts: number;
  elapsedMs: number;
  resolved: boolean;
  source: string;
}

const [path] = process.argv.slice(2);
if (path === undefined) {
  console.error('usage: detection-window <session.jsonl>');
  process.exit(2);
}

const windows: Window[] = [];
let overflowEvents = 0;
let overflowDropped = 0;
const coldFillTruncated: string[] = [];

for (const line of readFileSync(path, 'utf8').split('\n')) {
  if (line.trim() === '') continue;
  let entry: { kind: string; payload: { tag?: string; raw?: unknown } };
  try {
    entry = JSON.parse(line) as typeof entry;
  } catch {
    continue; // a torn final line is normal; parseSession is the strict reader
  }
  if (entry.kind !== 'unmodeled') continue;
  if (entry.payload.tag === 'tracker:stream-fetch-window') {
    windows.push(entry.payload.raw as Window);
  } else if (entry.payload.tag === 'tracker:stream-queue-overflow') {
    overflowEvents += 1;
    overflowDropped += (entry.payload.raw as { dropped: number }).dropped;
  } else if (entry.payload.tag === 'tracker:stream-gap-filled') {
    const gap = entry.payload.raw as { wallet: string; truncated: boolean };
    if (gap.truncated) coldFillTruncated.push(gap.wallet);
  }
}

function report(label: string, rows: Window[]): void {
  console.log(`\n── ${label} (n=${rows.length}) ${'─'.repeat(Math.max(0, 40 - label.length))}`);
  if (rows.length === 0) {
    console.log('   no samples');
    return;
  }
  const resolved = rows.filter((r) => r.resolved);
  const elapsed = resolved.map((r) => r.elapsedMs).sort((a, b) => a - b);
  const at = (q: number): number => elapsed[Math.min(elapsed.length - 1, Math.floor(elapsed.length * q))] ?? 0;
  const firstTry = rows.filter((r) => r.resolved && r.attempts === 1).length;

  console.log(`   resolved on first attempt : ${firstTry}/${rows.length} = ${((100 * firstTry) / rows.length).toFixed(1)}%`);
  console.log(`   needed a retry            : ${resolved.length - firstTry}`);
  console.log(`   never resolved            : ${rows.length - resolved.length}/${rows.length} = ${((100 * (rows.length - resolved.length)) / rows.length).toFixed(1)}%`);
  if (elapsed.length > 0) {
    console.log(`   elapsed ms  p50 ${at(0.5)}   p90 ${at(0.9)}   p99 ${at(0.99)}   max ${elapsed[elapsed.length - 1]}`);
  }
  const byAttempts = new Map<number, number>();
  for (const r of rows) byAttempts.set(r.attempts, (byAttempts.get(r.attempts) ?? 0) + 1);
  console.log(`   attempts: ${[...byAttempts].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}x:${v}`).join('  ')}`);
}

console.log(`session: ${path}`);
report('LIVE — the socket path, where the null window is', windows.filter((w) => w.source === 'live'));
report('GAPFILL — older signatures, always fetchable', windows.filter((w) => w.source === 'gapfill'));
report('ALL SOURCES COMBINED', windows);

console.log(`\n── coverage instrumentation ${'─'.repeat(20)}`);
console.log(`   queue-overflow events : ${overflowEvents}, signatures dropped: ${overflowDropped}`);
console.log(`   cold-fill truncated   : ${coldFillTruncated.length} wallet(s)`);
console.log(
  '\nThe live rows are the detection leg, and a LOWER BOUND on copy delay:\n' +
    'they exclude quote, guard and fill time entirely.',
);
