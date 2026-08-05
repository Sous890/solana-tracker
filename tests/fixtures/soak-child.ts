/**
 * A real process for the crash drill to really SIGKILL.
 *
 * Fake stream, fake quotes, fake screener — but a REAL ledger, a REAL recorder
 * writing real files, and a real `Tracker`. What the drill is testing is what
 * survives an uncatchable signal on disk, and that is the same whether the
 * quotes came from Jupiter or from this file.
 *
 * argv: <dbPath> <sessionDir> <mode>
 *   mode `crash` — trade in a loop and wait to be killed
 *   mode `restart` — reconcile, print the report as JSON, exit
 */

import { EventEmitter } from 'node:events';
import { writeSync } from 'node:fs';
import { parseConfig } from '../../src/core/config.js';
import type { QuoteRequest, QuoteSource } from '../../src/core/quoteSource.js';
import type { Quote, TrackedSwap } from '../../src/core/types.js';
import { WRAPPED_SOL_MINT } from '../../src/core/units.js';
import { createPaperBroker } from '../../src/adapters/paperBroker.js';
import { createDecimalsResolver, fixtureDecimalsSource } from '../../src/adapters/mintMetadata.js';
import { openLedger } from '../../src/db/ledger.js';
import { openRuntimeState } from '../../src/db/runtimeState.js';
import { Tracker } from '../../src/services/tracker.js';
import type { HeldPositionScreener, Scheduler, WalletFeed } from '../../src/services/tracker.js';
import { StrategyRunner } from '../../src/services/strategyRunner.js';
import { createMirrorStrategy } from '../../src/strategies/mirror.js';
import { canSellFromScreener } from '../../src/adapters/safety.js';

const [dbPath, sessionDir, mode] = process.argv.slice(2);
if (dbPath === undefined || sessionDir === undefined || mode === undefined) {
  console.error('usage: soak-child <dbPath> <sessionDir> <crash|restart>');
  process.exit(2);
}

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const BUY_OUT = 1_000_000_000n;

class FakeStream extends EventEmitter implements WalletFeed {
  async start(): Promise<void> {}
  stop(): void {}
}
class FakeScreener extends EventEmitter implements HeldPositionScreener {
  async screenHeldPosition(): Promise<unknown> {
    return { verdict: 'pass' };
  }
}
const noScheduler: Scheduler = { setInterval: () => 0, clearInterval: () => undefined };

function quoteOf(request: QuoteRequest, out: bigint, at: number): Quote {
  return {
    inMint: request.inMint,
    outMint: request.outMint,
    inAmount: request.inAmount,
    outAmount: out,
    priceImpactPct: 0.1,
    routePlan: [],
    fetchedAt: at,
  };
}

function swapOf(side: 'buy' | 'sell', index: number): TrackedSwap {
  return {
    wallet: WALLET,
    mint: MINT,
    side,
    solAmount: 410_000_000n,
    tokenAmount: BUY_OUT,
    decimals: 6,
    signature: `sig-${side}-${index}`,
    slot: index,
    blockTime: 1_700_000_000 + index,
    venue: 'pumpfun',
    feePayer: true,
    source: 'live',
    observedAt: (1_700_000_000 + index) * 1_000,
  };
}

const config = parseConfig({ trackedWallets: [], paperLatencyPenaltyBps: 0 });
const ledger = openLedger({
  path: dbPath,
  logger: { info: () => undefined, warn: () => undefined },
});
const runtime = openRuntimeState({ path: dbPath });

let clock = 1_700_000_000_000;

const liveQuotes: QuoteSource = {
  getQuote: async (request) =>
    quoteOf(request, request.inMint === WRAPPED_SOL_MINT ? BUY_OUT : 50_300_000n, (clock += 1)),
};

// Late-bound through the recorder, exactly as `createTrackerRuntime` does it.
// Without this the sessions hold swaps and no quotes, and the crash drill would
// be replaying a file that could never have replayed — which would make it a
// test of the drill's own scaffolding rather than of the recorder.
let trackerRef: Tracker | undefined;
const session = () => trackerRef?.session;
const quotes: QuoteSource = {
  getQuote: (request) => {
    const active = session();
    return active === undefined
      ? liveQuotes.getQuote(request)
      : active.wrapQuotes(liveQuotes).getQuote(request);
  },
};

const screener = {
  screenMint: async () => ({
    verdict: 'pass' as const,
    failedChecks: [] as string[],
    unknownChecks: [] as string[],
    details: {},
    screenedAt: clock,
  }),
};

const resolveDecimals = createDecimalsResolver(fixtureDecimalsSource({ [MINT]: 6 }));

const broker = createPaperBroker({
  quoteSource: quotes,
  resolveDecimals,
  ledger,
  config,
  latencyMs: 0,
  now: () => (clock += 1),
  canSell: canSellFromScreener(
    {
      screenMint: (mint, opts) => {
        const active = session();
        return active === undefined
          ? screener.screenMint()
          : active.wrapScreener(screener).screenMint(mint, opts);
      },
    },
    { sizeSol: config.positionSizeSol },
  ),
});

const stream = new FakeStream();
const tracker = new Tracker({
  config,
  ledger,
  runtime,
  broker,
  screener: new FakeScreener(),
  quotes,
  stream,
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  scheduler: noScheduler,
  now: () => (clock += 1),
  recording: {
    enabled: true,
    directory: sessionDir,
    maxBytes: 64 * 1024 * 1024,
    retentionDays: 0,
    secrets: [],
  },
});

trackerRef = tracker;

if (mode === 'restart') {
  // Reconcile only. The tracker's own `start()` does it, and its report is the
  // thing under test.
  const report = await tracker.start();
  // `writeSync` to fd 1, not `console.log`: writes to a pipe are asynchronous
  // and the parent saw an empty stdout under load. A synchronous write cannot
  // be truncated by the process ending.
  writeSync(
    1,
    `${JSON.stringify({
      openPositions: report.openPositions.map((p) => ({
        mint: p.mint,
        tokens: p.tokens.toString(),
      })),
      orphaned: report.orphaned.map((o) => o.id),
      recovered: report.recovered.map((r) => r.id),
    })}\n`,
  );
  await tracker.stop();
  ledger.close();
  runtime.close();
  // Deliberately NOT `process.exit(0)`: `console.log` to a pipe is
  // asynchronous, and exiting truncates whatever has not flushed. The parent
  // saw this as an empty stdout on the second restart and nowhere else, which
  // is exactly how a flush race presents.
  process.exitCode = 0;
}

// -- crash mode --------------------------------------------------------------

if (mode === 'crash') {
const runner = new StrategyRunner({
  strategy: createMirrorStrategy(),
  config,
  quotes,
  resolveDecimals,
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  now: () => clock,
  runId: 'soak',
  host: {
    getState: () => tracker.getState(),
    openPositions: () => ledger.getOpenPositions(),
    balanceLamports: () => broker.getBalanceLamports(),
    submit: (intent) => tracker.submit(intent),
  },
});
tracker.useStrategy(runner);

await tracker.start();

// Announce readiness only once a complete round trip is on disk, so the parent
// kills a process that has something worth losing.
stream.emit('swap', swapOf('buy', 1));
await new Promise((resolve) => setTimeout(resolve, 60));
stream.emit('swap', swapOf('sell', 1));
await new Promise((resolve) => setTimeout(resolve, 60));
stream.emit('swap', swapOf('buy', 2));
await new Promise((resolve) => setTimeout(resolve, 60));

writeSync(1, `READY ${tracker.session?.path ?? ''}\n`);

// Keep trading until killed. Never resolves; that is the point.
let index = 3;
setInterval(() => {
  stream.emit('swap', swapOf(index % 2 === 0 ? 'buy' : 'sell', index));
  index += 1;
}, 5);
}
