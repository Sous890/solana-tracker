/**
 * A process that dies mid-trade, on purpose.
 *
 * Run by `tests/ledger.test.ts` as a real child process and killed with
 * SIGKILL, which cannot be caught: no exit handler runs, no `close()` is
 * called, nothing is flushed politely. Whatever survives is what SQLite
 * genuinely committed to disk.
 *
 * Usage: crash-child.ts <dbPath> <mint> <before-fill | after-fill>
 */

import { openLedger } from '../../src/db/ledger.js';
import type { Fill, OrderIntent } from '../../src/core/types.js';

const [, , dbPath, mint, when] = process.argv;

if (dbPath === undefined || mint === undefined || when === undefined) {
  console.error('usage: crash-child.ts <dbPath> <mint> <before-fill|after-fill>');
  process.exit(2);
}

const AT = 1_700_000_000_000;

const intent: OrderIntent = {
  id: 'crashed-intent',
  side: 'buy',
  mint,
  amountLamports: 50_000_000n,
  maxSlippageBps: 300,
  reason: 'crash test',
};

const fill: Fill = {
  intentId: intent.id,
  side: 'buy',
  mint,
  tokensDelta: 1_000_000_000n,
  lamportsDelta: -50_000_000n,
  decimals: 6,
  feesLamports: 1_000_000n,
  slippageBps: 20,
  simulated: true,
  at: AT + 1,
};

const ledger = openLedger({
  path: dbPath,
  logger: { info: () => undefined, warn: () => undefined },
});

// Step 1: the intent is committed before the broker is ever called.
ledger.recordIntent(intent, AT);

// Step 2: the swap lands and the fill is recorded — in the `after-fill` case.
if (when === 'after-fill') {
  ledger.recordFill(fill);
}

// Step 3: die. Before `resolveIntent`, always. SIGKILL to self is as close to
// a power cut as a test can get without one.
process.kill(process.pid, 'SIGKILL');

// Unreachable. If SIGKILL somehow failed, fail loudly rather than exiting 0 and
// letting the test believe it observed a crash.
setTimeout(() => process.exit(3), 5_000);
