/**
 * Turn "recording cannot block the live path" from an argument into a number.
 *
 * Two measurements, both over the same synthetic swap burst:
 *
 *   1. EMIT PATH. Time spent inside the tracker's own event emission, with
 *      recording on and with it off. The claim under test is that the
 *      difference is small enough not to matter to a trading decision.
 *
 *   2. DROP VALVE UNDER PRESSURE. Handoff 12 tested the bound by setting it to
 *      zero, which proved the branch and not the pressure. This stalls the
 *      writer for real and reports how many events were dropped, of which
 *      kinds, and — the part that actually matters — whether the tracker's own
 *      latency moved while the recorder was drowning.
 *
 * Run: npx tsx scripts/measure-recorder.ts [events]
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { SessionRecorder, encodeSwap } from '../src/services/recorder.js';
import type { TrackedSwap } from '../src/core/types.js';

const EVENTS = Number(process.argv[2] ?? '10000');
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function swapOf(index: number): TrackedSwap {
  return {
    wallet: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    mint: MINT,
    side: index % 2 === 0 ? 'buy' : 'sell',
    solAmount: 410_000_000n,
    tokenAmount: 1_000_000_000n,
    decimals: 6,
    signature: `sig-${index}`,
    slot: index,
    blockTime: 1_700_000_000 + index,
    venue: 'pumpfun',
    feePayer: true,
  };
}

interface Stats {
  count: number;
  p50: number;
  p99: number;
  max: number;
  totalMs: number;
}

function summarise(nanos: number[], totalMs: number): Stats {
  const sorted = [...nanos].sort((a, b) => a - b);
  const at = (f: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))] ?? 0;
  return { count: sorted.length, p50: at(0.5), p99: at(0.99), max: sorted.at(-1) ?? 0, totalMs };
}

/**
 * The emitter path, measured the way the tracker actually uses it.
 *
 * `recorder.attach(emitter)` is the real subscription, so what is being timed
 * is `emit()` plus every listener on it — which is exactly the cost a trading
 * decision would pay if recording were synchronous with it.
 */
function measureEmit(recorder: SessionRecorder | undefined): Stats {
  const emitter = new EventEmitter();
  recorder?.attach(emitter as never);

  const nanos: number[] = [];
  const wall = process.hrtime.bigint();
  for (let index = 0; index < EVENTS; index += 1) {
    const record = { type: 'swap-detected', data: swapOf(index) };
    const started = process.hrtime.bigint();
    emitter.emit('event', record);
    nanos.push(Number(process.hrtime.bigint() - started));
  }
  return summarise(nanos, Number(process.hrtime.bigint() - wall) / 1e6);
}

async function main(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'measure-'));

  try {
    console.log(`\n=== emit path, ${EVENTS} events ===\n`);

    const off = measureEmit(undefined);
    console.log(
      `recording OFF   p50 ${off.p50}ns  p99 ${off.p99}ns  max ${off.max}ns  total ${off.totalMs.toFixed(1)}ms`,
    );

    const on = new SessionRecorder({
      directory,
      now: () => Date.now(),
      // A bound large enough that nothing drops: this measures the cost of
      // recording, not the cost of refusing to.
      maxBufferedBytes: 512 * 1024 * 1024,
      retentionDays: 0,
    });
    const withRecording = measureEmit(on);
    await on.close();
    console.log(
      `recording ON    p50 ${withRecording.p50}ns  p99 ${withRecording.p99}ns  max ${withRecording.max}ns  total ${withRecording.totalMs.toFixed(1)}ms`,
    );
    console.log(
      `delta           p50 +${withRecording.p50 - off.p50}ns  p99 +${withRecording.p99 - off.p99}ns  ` +
        `total +${(withRecording.totalMs - off.totalMs).toFixed(1)}ms  ` +
        `(${((withRecording.totalMs - off.totalMs) / EVENTS) * 1000}µs per event)`,
    );
    console.log(`lines written   ${on.stats.written}, dropped ${on.stats.dropped}`);

    // -- the drop valve, under real pressure --------------------------------

    console.log(`\n=== drop valve under a stalled writer, ${EVENTS} events ===\n`);

    const stalled = new SessionRecorder({
      directory,
      now: () => Date.now(),
      // Small enough that a burst outruns the writer immediately, which is what
      // a stalled disk looks like from the emit path.
      maxBufferedBytes: 4096,
      retentionDays: 0,
    });
    // Never drain: the stream's buffer fills and stays full.
    (stalled as unknown as { stream: { write: () => boolean; writableLength: number } }).stream = {
      write: () => false,
      get writableLength() {
        return 1_000_000;
      },
    } as never;

    const emitter = new EventEmitter();
    stalled.attach(emitter as never);
    const nanos: number[] = [];
    const wall = process.hrtime.bigint();
    for (let index = 0; index < EVENTS; index += 1) {
      const started = process.hrtime.bigint();
      emitter.emit('event', { type: 'swap-detected', data: swapOf(index) });
      nanos.push(Number(process.hrtime.bigint() - started));
    }
    const saturated = summarise(nanos, Number(process.hrtime.bigint() - wall) / 1e6);

    console.log(
      `saturated       p50 ${saturated.p50}ns  p99 ${saturated.p99}ns  max ${saturated.max}ns  total ${saturated.totalMs.toFixed(1)}ms`,
    );
    console.log(`dropped         ${stalled.stats.dropped} of ${EVENTS}`);
    console.log(
      `by kind         ${[...stalled.stats.droppedByKind].map(([k, v]) => `${k}=${v}`).join(' ')}`,
    );
    console.log(
      `vs OFF          p50 ${saturated.p50 - off.p50 >= 0 ? '+' : ''}${saturated.p50 - off.p50}ns  ` +
        `total ${(saturated.totalMs - off.totalMs).toFixed(1)}ms`,
    );
    console.log(
      '\nThe question this answers: while the recorder was drowning, did the emit\n' +
        'path get slower? A drop that costs less than a write is the valve working.\n',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

await main();
