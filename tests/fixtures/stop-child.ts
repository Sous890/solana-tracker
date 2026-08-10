/**
 * A process that stops the tracker and then exits immediately.
 *
 * Run by `tests/tracker.test.ts` as a real child. The claim under test is that
 * `stop()` does not return until every in-flight intent has settled — and that
 * claim is only observable across a process boundary. In-process, abandoning
 * the `await` still leaves the intent's promise running, so it finishes anyway
 * and the ledger looks identical either way. Only exiting the moment `stop()`
 * resolves distinguishes "waited" from "did not wait".
 *
 * The intent is held open by a quote source that sleeps, so the exit genuinely
 * races the fill.
 *
 * Usage: stop-child.ts <dbPath> <mint>
 */

import { createPaperBroker } from '../../src/adapters/paperBroker.js';
import { createDecimalsResolver, fixtureDecimalsSource } from '../../src/adapters/mintMetadata.js';
import { parseConfig } from '../../src/core/config.js';
import type { QuoteSource } from '../../src/core/quoteSource.js';
import type { OrderIntent } from '../../src/core/types.js';
import { openLedger } from '../../src/db/ledger.js';
import { openRuntimeState } from '../../src/db/runtimeState.js';
import { Tracker } from '../../src/services/tracker.js';
import type { Scheduler, WalletFeed } from '../../src/services/tracker.js';
import { EventEmitter } from 'node:events';

const [, , dbPath, mint] = process.argv;

if (dbPath === undefined || mint === undefined) {
  console.error('usage: stop-child.ts <dbPath> <mint>');
  process.exit(2);
}

const AT = 1_700_000_000_000;
/** Long enough that an exit which did not wait lands first, every time. */
const QUOTE_DELAY_MS = 750;

class NoopStream extends EventEmitter implements WalletFeed {
  /**
   * Emits `connected`, because `WalletStream.start()` does. The tracker's
   * `running` status is bound to that event, so a fake that omits it models a
   * feed that never comes up.
   */
  async start(): Promise<void> {
    this.emit('connected', { at: Date.now() });
  }
  stop(): void {}
}

const noopScheduler: Scheduler = {
  setInterval: () => 0,
  clearInterval: () => undefined,
};

const config = parseConfig({ trackedWallets: [] });

const quotes: QuoteSource = {
  getQuote: async (request) => {
    await new Promise((resolve) => setTimeout(resolve, QUOTE_DELAY_MS));
    return {
      inMint: request.inMint,
      outMint: request.outMint,
      inAmount: request.inAmount,
      outAmount: 1_000_000_000n,
      priceImpactPct: 0.1,
      routePlan: [],
      fetchedAt: AT,
    };
  },
};

const ledger = openLedger({
  path: dbPath,
  logger: { info: () => undefined, warn: () => undefined },
});
const runtime = openRuntimeState({ path: dbPath });

const broker = createPaperBroker({
  quoteSource: quotes,
  resolveDecimals: createDecimalsResolver(fixtureDecimalsSource({ [mint]: 6 })),
  ledger,
  config,
  latencyMs: 0,
  canSell: async () => ({ ok: true }),
});

const tracker = new Tracker({
  config,
  ledger,
  runtime,
  broker,
  screener: new (class extends EventEmitter {
    async screenHeldPosition(): Promise<unknown> {
      return { verdict: 'pass' };
    }
  })(),
  quotes,
  stream: new NoopStream(),
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  scheduler: noopScheduler,
});

const intent: OrderIntent = {
  id: 'inflight-intent',
  side: 'buy',
  mint,
  amountLamports: 50_000_000n,
  maxSlippageBps: 300,
  reason: 'stop test',
};

await tracker.start();

// Deliberately not awaited here: the whole point is that `stop()` is what
// waits for it. A rejection is swallowed so an unhandled rejection cannot be
// the thing that ends the process.
void tracker.submit(intent).catch(() => undefined);

// Let the submit reach its first await, so it is genuinely in flight.
await new Promise((resolve) => setTimeout(resolve, 50));

await tracker.stop();

// Immediately. No drain, no grace period — if `stop()` returned early, the
// fill has not been written and this exit strands the intent as `pending`,
// which the next start files as a crash orphan.
process.exit(0);
