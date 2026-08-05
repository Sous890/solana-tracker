/**
 * Replay a recorded session through the REAL guard layer and the REAL paper
 * broker.
 *
 * ── WHAT MAKES THIS A REPLAY AND NOT A SIMULATION ─────────────────────────
 *
 * Nothing here reimplements execution. `guarded()` and `createPaperBroker()`
 * are the same functions the live process runs; the ledger is a real SQLite
 * file. What is swapped out is only the outside world:
 *
 *   the clock      a counter driven by the session's own `simClockMs`
 *   the network    a `fetch` that throws — a replay that touches the network is
 *                  a failed replay, not a slow one, because the answer it got
 *                  would be today's rather than the one being replayed
 *   quotes         resolved from the recording by (inMint, outMint, amount).
 *                  A MISS IS A HARD ERROR naming the miss. Synthesising one
 *                  would mean the run reports on a market that never existed,
 *                  and would do it silently.
 *   sellability    resolved from the recorded screen verdicts, same rule
 *
 * Usage:
 *   npm run replay -- <session.jsonl> [--slippage-bps 0,30,100,250] [--json out.json]
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../../src/core/config.js';
import type { Config } from '../../src/core/config.js';
import { GuardRejection, guarded, malformedIntentReason } from '../../src/core/guards.js';
import type { GuardDeps } from '../../src/core/guards.js';
import type { QuoteSource } from '../../src/core/quoteSource.js';
import type { Address, Fill, OrderIntent, Position, UnixMillis } from '../../src/core/types.js';
import { WRAPPED_SOL_MINT } from '../../src/core/units.js';
import { createPaperBroker } from '../../src/adapters/paperBroker.js';
import { createDecimalsResolver } from '../../src/adapters/mintMetadata.js';
import { openLedger } from '../../src/db/ledger.js';
import type { Ledger } from '../../src/db/ledger.js';
import { quoteKey } from '../../src/services/recorder.js';
import { createStrategy } from '../../src/services/strategyRegistry.js';
import type { Strategy } from '../../src/core/strategy.js';
import { StrategyRunner } from '../../src/services/strategyRunner.js';
import { InvariantChecker, InvariantViolation } from './invariants.js';
import { loadSession, materialiseQuote } from './session.js';
import type { LoadedSession } from './session.js';
import { buildReport, formatTable, slippageVerdict } from './report.js';
import type { ReplayReport, TradeRecord } from './report.js';

export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayError';
  }
}

/** The slippage ladder every session is run at. */
export const SLIPPAGE_SWEEP = [0, 30, 100, 250] as const;

// ---------------------------------------------------------------------------
// The simulated clock
// ---------------------------------------------------------------------------

/**
 * A clock that only moves when the session says so.
 *
 * Every `now()` in the run resolves here — the ledger's, the broker's, the
 * runner's, the guard layer's. If any of them reached `Date.now()` instead, two
 * replays of one session would differ in `fills.at`, which is the ledger's
 * primary sort key, and "byte-identical" would become "identical apart from the
 * timestamps", which is a different and much weaker promise.
 */
export class SimClock {
  private current: UnixMillis;

  constructor(start: UnixMillis) {
    this.current = start;
  }

  now = (): UnixMillis => this.current;

  /**
   * Advance to a session timestamp, never backwards, and never by zero.
   *
   * The forced +1 matters: two fills sharing a millisecond fall back to the
   * ledger's `rowid` tie-break, which is correct but makes the ordering
   * dependent on insertion rather than on the session. Distinct timestamps keep
   * the replay's ordering a property of the recording.
   */
  advanceTo(at: UnixMillis): void {
    this.current = at > this.current ? at : this.current + 1;
  }

  tick(): UnixMillis {
    this.current += 1;
    return this.current;
  }
}

// ---------------------------------------------------------------------------
// The network trap
// ---------------------------------------------------------------------------

export function installFetchTrap(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    throw new ReplayError(
      `A replay reached the network: ${String(input)}\n` +
        'Every input must come from the session. A live answer would be from today, ' +
        'not from the run being replayed, and the report would silently describe neither.',
    );
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export interface ReplayOptions {
  session: LoadedSession;
  sessionLabel: string;
  strategyName: string;
  /** Overrides `paperLatencyPenaltyBps`; everything else comes from defaults. */
  slippageBps: number;
  configOverrides?: Record<string, unknown>;
  /**
   * Run a strategy object instead of resolving `strategyName` from the
   * registry. Only for tests that need to force a specific intent through the
   * real guard layer — a registered strategy cannot emit the garbage the
   * regression fixture is about.
   */
  strategyOverride?: Strategy;
}

export interface ReplayResult {
  report: ReplayReport;
  quoteMisses: string[];
}

export async function replaySession(options: ReplayOptions): Promise<ReplayResult> {
  const config: Config = parseConfig({
    trackedWallets: [],
    ...(options.configOverrides ?? {}),
    strategy: options.strategyName,
    paperLatencyPenaltyBps: options.slippageBps,
  });

  const first = options.session.lines[0]!;
  const clock = new SimClock(first.simClockMs);

  const directory = mkdtempSync(join(tmpdir(), 'replay-'));
  const dbPath = join(directory, 'replay.db');
  const ledger: Ledger = openLedger({
    path: dbPath,
    logger: { info: () => undefined, warn: () => undefined },
  });

  const restoreFetch = installFetchTrap();

  const fills: TradeRecord[] = [];
  const rejections: string[] = [];
  const noRouteWhileHeld = new Set<string>();
  const checker = new InvariantChecker(ledger);

  try {
    // -- the recorded market ------------------------------------------------

    const quotes: QuoteSource = {
      getQuote: async (request) => {
        const key = quoteKey(request);
        const recorded = options.session.quotes.get(key);
        if (recorded === undefined) {
          // Never synthesised. A replay that invents a price is a replay of a
          // market that never existed.
          throw new ReplayError(
            `QUOTE MISS: no recorded quote for ${request.inMint} -> ${request.outMint} ` +
              `at ${request.inAmount.toString()}.\n` +
              `    key: ${key}\n` +
              '    The session does not contain this request. Either the strategy or the ' +
              'config differs from the recorded run, or the session is incomplete.',
          );
        }
        return materialiseQuote(recorded, request, clock.now());
      },
    };

    const decimalsByMint = new Map<Address, number>();
    for (const entry of options.session.drivable) {
      if (entry.kind === 'swap') decimalsByMint.set(entry.swap.mint, entry.swap.decimals);
      else decimalsByMint.set(entry.tick.mint, entry.tick.decimals);
    }
    const resolveDecimals = createDecimalsResolver({
      lookup: async (mint) => decimalsByMint.get(mint),
    });

    // -- the real broker, the real guards -----------------------------------

    const state = { status: 'running' as const, killSwitchEngaged: false };
    const inner = createPaperBroker({
      quoteSource: quotes,
      resolveDecimals,
      ledger,
      config,
      latencyMs: 0,
      now: () => clock.tick(),
      canSell: async (mint) => {
        const screen = options.session.screens.get(mint);
        if (screen === undefined) {
          throw new ReplayError(
            `SCREEN MISS: no recorded screenMint verdict for ${mint}.\n` +
              '    The session does not contain this decision, and inventing one would ' +
              'change which entries the guard layer admitted.',
          );
        }
        if (screen.verdict === 'pass') return { ok: true };
        const prefix = screen.verdict === 'unknown' ? 'SCREEN_UNKNOWN' : 'SCREEN_FAILED';
        const codes = screen.verdict === 'unknown' ? screen.unknownChecks : screen.failedChecks;
        return { ok: false, reason: `${prefix}:${codes.join(',')}` };
      },
    });

    const guardDeps: GuardDeps = {
      config,
      logger: { warn: () => undefined },
      getState: () => ({ mode: 'paper', status: state.status, killSwitchEngaged: state.killSwitchEngaged }),
      getRealizedLossLamportsToday: async () => ledger.getRealizedLossLamportsToday(clock.now()),
      getUnacknowledgedOrphanCount: async () => ledger.getUnacknowledgedOrphanCount(),
    };
    const broker = guarded(inner, guardDeps);

    // -- the execution pipeline, minus the tracker's I/O --------------------

    let currentSeq = 0;
    let escaped: Error | undefined;
    /**
     * `Tracker.submit`, minus the event emitter — same order, same guarantees.
     *
     * The order is load-bearing and is copied deliberately: gate 0 runs BEFORE
     * the ledger write, because an amount it rejects may not be representable
     * in the column at all. Getting this wrong makes a malformed intent die as
     * a SQLite constraint error instead of as a counted `MALFORMED_INTENT`,
     * which is precisely the confusion handoff 11 removed.
     */
    const submit = async (intent: OrderIntent): Promise<Fill> => {
      const malformed = malformedIntentReason(intent);
      if (malformed !== null) {
        rejections.push('MALFORMED_INTENT');
        throw new GuardRejection('MALFORMED_INTENT', malformed, intent);
      }

      if (intent.side === 'sell') {
        // Invariant 3, before the guard layer's clamp can absorb the condition.
        checker.beforeSell(currentSeq, intent.mint, intent.amountTokens ?? 0n);
      }

      ledger.recordIntent(intent, clock.now());
      try {
        const fill = await broker.execute(intent);
        // The intent is resolved by the broker; the fill is only counted once
        // the row is on disk.
        checker.afterFill(currentSeq, fill);
        fills.push({
          mint: fill.mint,
          intentId: fill.intentId,
          side: fill.side,
          tokensDelta: fill.tokensDelta,
          lamportsDelta: fill.lamportsDelta,
          feesLamports: fill.feesLamports,
          at: fill.at,
        });
        return fill;
      } catch (cause) {
        if (cause instanceof GuardRejection) {
          ledger.resolveIntent(intent.id, 'rejected', cause.code, clock.now());
          rejections.push(cause.code);
        }
        throw cause;
      }
    };

    /**
     * Anything that must not be survivable, stashed on its way past the runner.
     *
     * `StrategyRunner` deliberately catches everything `submit` throws — that
     * is how a broker failure does not stop the loop, and it is right. It is
     * wrong for the two things this harness exists to raise: an invariant
     * violation and a missing session input. Both are stashed as they go by and
     * re-thrown the moment the drive loop regains control, so the runner's
     * tolerance cannot quietly turn a failed replay into a passing one.
     */
    const fatal = (cause: unknown): boolean =>
      cause instanceof InvariantViolation || cause instanceof ReplayError;

    /** Remember a fatal thrown anywhere under `body`, and re-raise it after. */
    const guardFatal = async (body: () => Promise<void>): Promise<void> => {
      try {
        await body();
      } catch (cause) {
        if (fatal(cause)) throw cause;
        throw cause;
      } finally {
        if (escaped !== undefined) {
          const stashed = escaped;
          escaped = undefined;
          throw stashed;
        }
      }
    };

    const stashing = <T>(work: Promise<T>): Promise<T> =>
      work.catch((cause: unknown) => {
        if (fatal(cause) && escaped === undefined) escaped = cause as Error;
        throw cause;
      });

    const runner = new StrategyRunner({
      strategy: options.strategyOverride ?? createStrategy(options.strategyName),
      config,
      quotes,
      resolveDecimals,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      now: clock.now,
      runId: 'replay',
      host: {
        getState: guardDeps.getState,
        openPositions: () => ledger.getOpenPositions(),
        balanceLamports: () => broker.getBalanceLamports(),
        submit: (intent) => stashing(submit(intent)),
      },
    });

    // -- drive ---------------------------------------------------------------

    for (const entry of options.session.drivable) {
      currentSeq = entry.seq;
      clock.advanceTo(entry.simClockMs);

      if (entry.kind === 'swap') {
        await guardFatal(() => runner.onTrackedSwap(entry.swap));
        continue;
      }

      // A price tick is only meaningful against a position the replay actually
      // holds. Using the RECORDED holding instead would paper over a divergence
      // — which is the one thing a replay exists to reveal.
      const position: Position | undefined = ledger
        .getOpenPositions()
        .find((open) => open.mint === entry.tick.mint);
      if (position === undefined) continue;

      // Was there a route out for this mint at this size, in the recording?
      const exitKey = quoteKey({
        inMint: entry.tick.mint,
        outMint: WRAPPED_SOL_MINT,
        inAmount: position.tokens,
      });
      const exitQuote = options.session.quotes.get(exitKey);
      if (exitQuote !== undefined && exitQuote.error?.error === 'NO_ROUTE') {
        noRouteWhileHeld.add(entry.tick.mint);
        continue;
      }

      await guardFatal(() => runner.onPriceTick(position, Number(entry.tick.priceSol)));
    }

    checker.finalise();

    // A replay that leaves a pending intent behind has lost track of one, which
    // is the same failure the orphan gate exists for.
    const report = ledger.reconcileOnStartup(clock.now());
    const clean = !report.dirty;

    return {
      report: buildReport({
        sessionLabel: options.sessionLabel,
        sessionLines: options.session.lines.length,
        strategy: options.strategyName,
        paperLatencyPenaltyBps: options.slippageBps,
        positionSizeSol: config.positionSizeSol,
        paperStartingSol: config.paperStartingSol,
        fills,
        rejections,
        noRouteWhileHeld: [...noRouteWhileHeld],
        finalBalanceLamports: await broker.getBalanceLamports(),
        ledgerReconcilesClean: clean,
      }),
      quoteMisses: [],
    };
  } finally {
    restoreFetch();
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

export interface SweepResult {
  reports: ReplayReport[];
  /**
   * Ladder points the session cannot answer for, with the miss that stopped
   * them. See the note below: this is common and it is not a bug.
   */
  unreplayable: Array<{ bps: number; reason: string }>;
  verdict: string;
}

/**
 * Run the ladder.
 *
 * ── WHY A POINT CAN BE UNREPLAYABLE, AND WHY THAT IS NOT A BUG ────────────
 *
 * Changing `paperLatencyPenaltyBps` changes how many tokens a buy receives,
 * which changes the size of the exit the strategy asks for, which changes the
 * quote key. A session recorded at 30 bps therefore contains
 * `MINT->WSOL at 997000000` and nothing else, and replaying it at 0 bps asks
 * for `MINT->WSOL at 1000000000` — a miss.
 *
 * The miss is correct and must stay a miss. Interpolating between recorded
 * sizes would be synthesising a quote, price impact is not linear in size, and
 * the resulting P&L would be a number nobody could defend. So the point is
 * reported as unreplayable rather than answered with a guess, and the ladder
 * carries on.
 *
 * The consequence, stated once here and again in the handoff: **the slippage
 * sweep is only complete over a session that happens to contain quotes at every
 * size the sweep produces.** A synthetic session can be built that way. A real
 * recording generally cannot, and the honest reading of a real sweep is "these
 * are the points the recording can answer for".
 */
export async function sweepSlippage(
  options: Omit<ReplayOptions, 'slippageBps'>,
  ladder: readonly number[] = SLIPPAGE_SWEEP,
): Promise<SweepResult> {
  const reports: ReplayReport[] = [];
  const unreplayable: Array<{ bps: number; reason: string }> = [];

  for (const bps of ladder) {
    try {
      const { report } = await replaySession({ ...options, slippageBps: bps });
      reports.push(report);
    } catch (cause) {
      // Only a missing input is tolerated here. An invariant violation is the
      // whole point of the harness and must never be swallowed by a sweep.
      if (!(cause instanceof ReplayError)) throw cause;
      unreplayable.push({ bps, reason: firstLine(cause.message) });
    }
  }

  return {
    reports,
    unreplayable,
    verdict:
      reports.length === 0
        ? 'NO LADDER POINT COULD BE REPLAYED — the session does not contain the quotes this sweep needs'
        : slippageVerdict(
            reports.map((report) => ({
              bps: report.parameters.paperLatencyPenaltyBps,
              pnl: BigInt(report.realizedPnlLamports),
            })),
          ),
  };
}

function firstLine(message: string): string {
  return message.split('\n')[0] ?? message;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  session: string;
  ladder: number[];
  strategy: string;
  jsonOut?: string;
} {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token.startsWith('--')) {
      flags.set(token.slice(2), argv[index + 1] ?? 'true');
      index += 1;
    } else {
      positional.push(token);
    }
  }
  const session = positional[0];
  if (session === undefined) {
    console.error(
      'usage: npm run replay -- <session.jsonl> [--slippage-bps 0,30,100,250] ' +
        '[--strategy mirror] [--json out.json]',
    );
    process.exit(2);
  }
  const ladderText = flags.get('slippage-bps');
  return {
    session,
    ladder:
      ladderText === undefined || ladderText === 'true'
        ? [...SLIPPAGE_SWEEP]
        : ladderText.split(',').map((part) => Number(part.trim())),
    strategy: flags.get('strategy') ?? 'mirror',
    ...(flags.get('json') === undefined ? {} : { jsonOut: flags.get('json')! }),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const session = loadSession(args.session);

  const sweep = await sweepSlippage(
    { session, sessionLabel: args.session, strategyName: args.strategy },
    args.ladder,
  );

  for (const report of sweep.reports) {
    console.log(`\n── ${report.parameters.paperLatencyPenaltyBps} bps ${'─'.repeat(40)}`);
    console.log(formatTable(report));
  }

  console.log(`\n── slippage sensitivity ${'─'.repeat(34)}`);
  for (const report of sweep.reports) {
    console.log(
      `  ${String(report.parameters.paperLatencyPenaltyBps).padStart(4)} bps   ` +
        `pnl ${report.realizedPnlLamports.padStart(14)} lamports   ` +
        `${report.trades.roundTrips} round trips`,
    );
  }
  for (const miss of sweep.unreplayable) {
    console.log(`  ${String(miss.bps).padStart(4)} bps   NOT REPLAYABLE — ${miss.reason}`);
  }
  console.log(`\n  ${sweep.verdict}\n`);

  const serialized = `${JSON.stringify(
    { reports: sweep.reports, unreplayable: sweep.unreplayable, verdict: sweep.verdict },
    null,
    2,
  )}\n`;
  if (args.jsonOut !== undefined) {
    writeFileSync(args.jsonOut, serialized);
    console.log(`  wrote ${args.jsonOut}`);
  } else {
    console.log(serialized);
  }
}

// Only when run directly, so the harness can be imported by tests.
if (process.argv[1]?.endsWith('run.ts') === true) {
  await main();
}
