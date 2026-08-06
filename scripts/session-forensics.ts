/**
 * What a session file can and cannot give back about a destroyed ledger.
 *
 *   npx tsx scripts/session-forensics.ts sessions/*.jsonl
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * Session 22 deleted `data/` and with it the ledger. Session 23 was asked
 * whether fills, intents and the two open positions the final `/stop` reported
 * could be rebuilt from the six surviving session files. The answer is partial,
 * and the boundary is sharp enough to be worth a tool rather than a paragraph:
 *
 *   RECOVERABLE   position identity, exact holdings, decimals, mark price, and
 *                 the entry quote that produced each buy — because
 *                 `price-tick` records a live `Position` and the paper broker's
 *                 fill arithmetic is deterministic in the recorded quote.
 *
 *   NOT           intents, in whole. `EXCLUDED_TRACKER_EVENTS` omits
 *                 `intent-created`, `fill` and `rejection` by name, and guard
 *                 gate 3 runs BEFORE the broker's first quote — so a
 *                 `STALE_SIGNAL` rejection produces no quote, no screen and no
 *                 tick. All that survives is the originating swap, which is
 *                 byte-for-byte indistinguishable from a swap the strategy
 *                 declined to act on. There is no inference from one to the
 *                 other, only a guess, and this repo does not book guesses.
 *
 * So this reports evidence. It deliberately does NOT write to a ledger: a
 * reconstruction covering entries but not exits would show every position opened
 * and never closed, and a realised P&L of zero, which is a more confident lie
 * than an empty database.
 */

import { readFileSync } from 'node:fs';

const WSOL = 'So11111111111111111111111111111111111111112';

/** `reduceByBpsFloor` from `core/units.ts`, restated so this needs no imports. */
function reduceByBpsFloor(amount: bigint, bps: bigint): bigint {
  return (amount * (10_000n - bps)) / 10_000n;
}

interface Line {
  seq: number;
  simClockMs: number;
  kind: string;
  payload: any;
}

function load(path: string): Line[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Line);
}

function report(path: string, penaltyBps: bigint): void {
  const lines = load(path);
  const ticks = lines.filter((l) => l.kind === 'price-tick');
  if (ticks.length === 0) return;

  console.log(`\n${'='.repeat(78)}`);
  console.log(path);
  console.log(
    `${lines.length} lines, seq ${lines[0]!.seq}..${lines.at(-1)!.seq}, ` +
      `${new Date(lines[0]!.simClockMs).toISOString()} -> ${new Date(lines.at(-1)!.simClockMs).toISOString()}`,
  );

  // Entry quotes, per mint. The paper broker's buy is a pure function of one of
  // these, so a held size that matches one is evidence rather than inference.
  const entries = new Map<string, Array<{ seq: number; at: number; out: bigint; inAmt: bigint }>>();
  for (const l of lines) {
    if (l.kind !== 'quote' || l.payload.request.inMint !== WSOL || !l.payload.quote) continue;
    const mint = l.payload.request.outMint as string;
    if (!entries.has(mint)) entries.set(mint, []);
    entries.get(mint)!.push({
      seq: l.seq,
      at: l.simClockMs,
      out: BigInt(l.payload.quote.outAmount),
      inAmt: BigInt(l.payload.request.inAmount),
    });
  }

  // The last exit-side quote per mint. A position that is still held keeps being
  // probed for an exit; one that closed stops. That is what separates the two.
  const lastExit = new Map<string, number>();
  for (const l of lines) {
    if (l.kind !== 'quote' || l.payload.request.inMint === WSOL) continue;
    lastExit.set(l.payload.request.inMint as string, l.simClockMs);
  }

  const held = new Map<string, { last: Line; ticks: number }>();
  for (const t of ticks) {
    const mint = t.payload.mint as string;
    const e = held.get(mint);
    held.set(mint, { last: t, ticks: (e?.ticks ?? 0) + 1 });
  }

  const endedAt = lines.at(-1)!.simClockMs;
  console.log(`\nPOSITIONS SEEN (${held.size}):`);
  for (const [mint, { last, ticks: n }] of held) {
    const tokens = BigInt(last.payload.tokens);
    const match = (entries.get(mint) ?? []).filter(
      (c) => reduceByBpsFloor(c.out, penaltyBps) === tokens,
    );
    const exitAt = lastExit.get(mint);
    // Still being probed for an exit when the recording stopped => still open.
    const stillProbed = exitAt !== undefined && endedAt - exitAt < 60_000;

    console.log(`\n  ${mint}`);
    console.log(`    ticks=${n}  last mark ${new Date(last.simClockMs).toISOString()} @ ${last.payload.priceSol}`);
    console.log(`    holdings ${tokens} base units, ${last.payload.decimals} decimals`);
    console.log(
      `    last exit quote ${exitAt === undefined ? '(none)' : new Date(exitAt).toISOString()}` +
        `  =>  ${stillProbed ? 'OPEN at end of session' : 'closed before end of session'}`,
    );
    if (match.length > 0) {
      const first = match[0]!;
      console.log(
        `    RECOVERABLE entry: quote seq=${first.seq} ${new Date(first.at).toISOString()}\n` +
          `      spent ${first.inAmt} lamports, quoted ${first.out}, ` +
          `filled floor(quoted x ${10_000n - penaltyBps}/10000) = ${reduceByBpsFloor(first.out, penaltyBps)}` +
          `${match.length > 1 ? `  (${match.length} quotes give this size; they are equal in value, not in time)` : ''}`,
      );
    } else {
      console.log(`    NO entry quote in this session reproduces this size — opened in an earlier run.`);
    }
  }

  // The part that cannot be recovered, counted rather than asserted.
  const swaps = lines.filter((l) => l.kind === 'swap').length;
  const quotes = lines.filter((l) => l.kind === 'quote').length;
  const screens = lines.filter((l) => l.kind === 'screen').length;
  console.log(
    `\nNOT RECOVERABLE from this file: intents (0 recorded of any status), fill ids,\n` +
      `  intent<->fill linkage, rejection codes, realised P&L, daily_pnl.\n` +
      `  ${swaps} swaps / ${quotes} quotes / ${screens} screens survive; a swap that produced a\n` +
      `  rejected intent is indistinguishable here from one the strategy ignored.`,
  );

  // Paper slippage carries no information — worth printing once so nobody plans
  // a recalibration around fills that cannot supply one.
  const bpsSeen = new Set<number>();
  for (const cands of entries.values())
    for (const c of cands) {
      if (c.out <= 0n) continue;
      const recv = reduceByBpsFloor(c.out, penaltyBps);
      bpsSeen.add(Number(((c.out - recv) * 10_000n) / c.out));
    }
  if (bpsSeen.size > 0) {
    console.log(
      `\n  paper slippage_bps any fill here could record: ${[...bpsSeen].join(', ')}\n` +
        `  (it is the configured penalty restated, so paper fills cannot calibrate it)`,
    );
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const penaltyFlag = args.find((a) => a.startsWith('--penalty-bps='));
  const penaltyBps = BigInt(penaltyFlag?.split('=')[1] ?? '30');
  const files = args.filter((a) => !a.startsWith('--'));

  if (files.length === 0) {
    console.error(
      'usage: npx tsx scripts/session-forensics.ts <session.jsonl…> [--penalty-bps=30]\n' +
        '\n' +
        'Reports what a recorded session can give back about a lost ledger.\n' +
        'Reads only. It never writes to a ledger, on purpose — see the header.',
    );
    process.exit(2);
  }

  console.log(`paperLatencyPenaltyBps = ${penaltyBps} (must match the run being examined)`);
  for (const file of files) report(file, penaltyBps);
}

main();
