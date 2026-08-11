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
import { copyableScores } from './scores.js';

const [dbPath, sessionDir, mode] = process.argv.slice(2);
if (dbPath === undefined || sessionDir === undefined || mode === undefined) {
  console.error('usage: soak-child <dbPath> <sessionDir> <crash|restart>');
  process.exit(2);
}

/** The mint the churn loop trades. Its position opens and closes constantly. */
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
/**
 * A second mint, bought once and never sold — the position the crash drill is
 * actually about.
 *
 * The drill asserts that a position taken before the crash survives it. It used
 * to assert that against `MINT`, whose position the churn loop below opens and
 * closes on a ~10ms cycle, so whether anything was open when the SIGKILL landed
 * was a coin flip on the phase of that cycle rather than a property of the
 * ledger. Measured: the position was flat for 49.3% of the parent's kill
 * window, and the test failed 9/30 runs isolated and 19/30 under load.
 *
 * The tracked wallet never sells this one and `noScheduler` means no price
 * ticks, so nothing in the system can close it. `maxConcurrentPositions`
 * defaults to 3, so holding it alongside the churn position is within the cap.
 */
const ANCHOR_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const BUY_OUT = 1_000_000_000n;

class FakeStream extends EventEmitter implements WalletFeed {
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

function swapOf(side: 'buy' | 'sell', index: number, mint: string = MINT): TrackedSwap {
  return {
    wallet: WALLET,
    mint,
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

const resolveDecimals = createDecimalsResolver(
  fixtureDecimalsSource({ [MINT]: 6, [ANCHOR_MINT]: 6 }),
);

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
    walletScores: copyableScores,
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

/**
 * Poll the ledger until `probe` reports the state we are waiting for.
 *
 * Replaces a fixed `setTimeout`, which under load announced READY before the
 * trades it claimed were on disk had been written at all. A timeout here is a
 * genuine regression — the tracker stopped filling — so it exits loudly with a
 * distinct message rather than letting the parent read it as a flake.
 */
async function waitForLedger(what: string, probe: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!probe()) {
    if (Date.now() > deadline) {
      writeSync(2, `SOAK-CHILD GAVE UP: ${what} did not happen within 30000ms\n`);
      process.exit(3);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const isOpen = (mint: string): boolean =>
  ledger.getOpenPositions().some((position) => position.mint === mint && position.tokens > 0n);

// 1. Take the position that must survive the crash, and do not announce
//    readiness until the ledger actually shows it open. This is the thing the
//    parent's assertion is about, so "it exists" has to be observed, not
//    assumed from a sleep.
stream.emit('swap', swapOf('buy', 1, ANCHOR_MINT));
await waitForLedger(`a position in ${ANCHOR_MINT} opened`, () => isOpen(ANCHOR_MINT));

// 2. A complete round trip on the churn mint, so the session holds a buy, a
//    sell and their quotes before anybody is killed.
stream.emit('swap', swapOf('buy', 2));
await waitForLedger('the churn buy filled', () => isOpen(MINT));
stream.emit('swap', swapOf('sell', 2));
await waitForLedger('the churn sell filled', () => !isOpen(MINT));

writeSync(1, `READY ${tracker.session?.path ?? ''}\n`);

// Keep trading until killed. Never resolves; that is the point.
//
// Only the churn mint is traded here. The anchor position stays open however
// long this runs, so the parent can kill at an arbitrary moment — which is what
// makes it a crash — without the surviving-position assertion depending on when.
let index = 3;
setInterval(() => {
  stream.emit('swap', swapOf(index % 2 === 0 ? 'buy' : 'sell', index));
  index += 1;
}, 5);
}
