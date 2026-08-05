import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrderIntent, SimulatedFill, UnixMillis } from '../src/core/types.js';
import { AcknowledgementError, LedgerVersionError, openLedger, utcDate } from '../src/db/ledger.js';
import type { Ledger, LedgerLogger } from '../src/db/ledger.js';

const MINT = 'So11111111111111111111111111111111111111112';
const AT = 1_700_000_000_000; // 2023-11-14T22:13:20Z
const TODAY = utcDate(AT);
/** All test mints use 6 decimals: 1000 tokens = 1e9 base units. */
const DECIMALS = 6;

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LogLine {
  level: 'info' | 'warn';
  fields: Record<string, unknown>;
  message: string;
}

function capturingLogger(sink: LogLine[]): LedgerLogger {
  return {
    info: (fields, message) => sink.push({ level: 'info', fields, message }),
    warn: (fields, message) => sink.push({ level: 'warn', fields, message }),
  };
}

function buyIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    id: 'intent-buy',
    side: 'buy',
    mint: MINT,
    amountLamports: 50_000_000n,
    maxSlippageBps: 300,
    reason: 'test entry',
    ...overrides,
  };
}

function buyFill(overrides: Partial<SimulatedFill> = {}): SimulatedFill {
  return {
    intentId: 'intent-buy',
    side: 'buy',
    mint: MINT,
    tokensDelta: 1_000_000_000n,
    lamportsDelta: -50_000_000n,
    decimals: DECIMALS,
    feesLamports: 1_000_000n,
    slippageBps: 20,
    simulated: true,
    at: AT,
    ...overrides,
  };
}

function sellFill(overrides: Partial<SimulatedFill> = {}): SimulatedFill {
  return {
    intentId: 'intent-sell',
    side: 'sell',
    mint: MINT,
    tokensDelta: -1_000_000_000n,
    lamportsDelta: 80_000_000n,
    decimals: DECIMALS,
    feesLamports: 1_000_000n,
    slippageBps: 30,
    simulated: true,
    at: AT + 60_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory behaviour
// ---------------------------------------------------------------------------

describe('ledger', () => {
  let ledger: Ledger;
  let logs: LogLine[];

  beforeEach(() => {
    logs = [];
    ledger = openLedger({ path: ':memory:', logger: capturingLogger(logs) });
  });

  afterEach(() => {
    ledger.close();
  });

  describe('intents', () => {
    it('records an intent as pending', () => {
      ledger.recordIntent(buyIntent(), AT);
      expect(ledger.getIntentStatus('intent-buy')).toBe('pending');
    });

    it('marks an intent resolved', () => {
      ledger.recordIntent(buyIntent(), AT);
      ledger.resolveIntent('intent-buy', 'filled', undefined, AT + 1);
      expect(ledger.getIntentStatus('intent-buy')).toBe('filled');
    });

    it('stores a rejection code', () => {
      ledger.recordIntent(buyIntent(), AT);
      ledger.resolveIntent('intent-buy', 'rejected', 'KILL_SWITCH_ENGAGED', AT + 1);
      expect(ledger.getIntentStatus('intent-buy')).toBe('rejected');
    });

    it('stores sell intents denominated in tokens', () => {
      ledger.recordIntent(
        {
          id: 'sell-1',
          side: 'sell',
          mint: MINT,
          amountTokens: 500_000_000n,
          maxSlippageBps: 300,
          reason: 'test exit',
        },
        AT,
      );
      expect(ledger.getIntentStatus('sell-1')).toBe('pending');
    });
  });

  describe('positions derived from fills', () => {
    it('opens a position from a buy fill with a fee-inclusive cost basis', () => {
      ledger.recordFill(buyFill());

      const position = ledger.getPosition(MINT);
      expect(position).toBeDefined();
      expect(position?.tokens).toBe(1_000_000_000n);
      // (0.05 SOL spent + 0.001 fees) / 1000 tokens
      expect(position?.avgEntrySol).toBeCloseTo(0.000051, 12);
      expect(position?.openedAt).toBe(AT);
      expect(position?.state).toBe('open');
    });

    it('averages across multiple buys', () => {
      ledger.recordFill(buyFill());
      ledger.recordFill(
        buyFill({ intentId: 'intent-buy-2', lamportsDelta: -150_000_000n, at: AT + 1_000 }),
      );

      const position = ledger.getPosition(MINT);
      expect(position?.tokens).toBe(2_000_000_000n);
      // (0.051 + 0.151) / 2000
      expect(position?.avgEntrySol).toBeCloseTo(0.000101, 12);
      // The holding period starts at the first buy, not the latest.
      expect(position?.openedAt).toBe(AT);
    });

    it('closes a position when fully sold', () => {
      ledger.recordFill(buyFill());
      ledger.recordFill(sellFill());

      const position = ledger.getPosition(MINT);
      expect(position?.tokens).toBe(0n);
      expect(position?.state).toBe('closed');
      expect(ledger.getOpenPositions()).toHaveLength(0);
    });

    it('lands a full exit exactly on zero, with no dust threshold', () => {
      ledger.recordFill(buyFill());
      ledger.recordFill(sellFill());

      // The float version could not assert this: repeated whole-token
      // subtraction left a ~1e-13 residue, which is why a dust threshold
      // existed at all.
      expect(ledger.getPosition(MINT)?.tokens).toBe(0n);
      expect(ledger.getPosition(MINT)?.costLamports).toBe(0n);
      expect(ledger.getPosition(MINT)?.state).toBe('closed');
    });

    it('keeps a position open when a sell leaves a single base unit', () => {
      ledger.recordFill(buyFill());
      ledger.recordFill(sellFill({ tokensDelta: -999_999_999n }));

      // Not dust to be rounded away: the wallet really does still hold it, and
      // pretending otherwise would drop a real balance off the books.
      const position = ledger.getPosition(MINT);
      expect(position?.tokens).toBe(1n);
      expect(position?.state).toBe('open');
    });

    it('keeps a partial sell open with the basis reduced proportionally', () => {
      ledger.recordFill(buyFill());
      ledger.recordFill(sellFill({ tokensDelta: -400_000_000n, lamportsDelta: 32_000_000n }));

      const position = ledger.getPosition(MINT);
      expect(position?.tokens).toBe(600_000_000n);
      expect(position?.state).toBe('open');
      // Average entry is unchanged by a sell.
      expect(position?.avgEntrySol).toBeCloseTo(0.000051, 12);
    });

    it('relieves cost basis by exact floor division, never a rounded float', () => {
      // Chosen so floor and round disagree: 51000002 * 1e9 / 3e9 is 17000000.67,
      // which floors to 17000000 and rounds to 17000001.
      ledger.recordFill(
        buyFill({
          tokensDelta: 3_000_000_000n,
          lamportsDelta: -50_000_001n,
          feesLamports: 1_000_001n,
        }),
      );
      expect(ledger.getPosition(MINT)?.costLamports).toBe(51_000_002n);

      ledger.recordFill(sellFill({ tokensDelta: -1_000_000_000n, lamportsDelta: 30_000_000n }));

      // 51000002 - 17000000. A rounded relief would leave 34000001 and quietly
      // invent a lamport of cost basis.
      expect(ledger.getPosition(MINT)?.costLamports).toBe(34_000_002n);
      expect(ledger.getPosition(MINT)?.tokens).toBe(2_000_000_000n);
    });

    it('conserves cost basis to the lamport across a full exit', () => {
      ledger.recordFill(
        buyFill({
          tokensDelta: 3_000_000_000n,
          lamportsDelta: -50_000_001n,
          feesLamports: 1_000_001n,
        }),
      );
      ledger.recordFill(
        sellFill({ intentId: 's1', tokensDelta: -1_000_000_000n, lamportsDelta: 30_000_000n }),
      );
      ledger.recordFill(
        sellFill({
          intentId: 's2',
          tokensDelta: -2_000_000_000n,
          lamportsDelta: 60_000_000n,
          at: AT + 120_000,
        }),
      );

      // Whatever the rounding did along the way, nothing is left stranded.
      const position = ledger.getPosition(MINT);
      expect(position?.tokens).toBe(0n);
      expect(position?.costLamports).toBe(0n);
      expect(position?.state).toBe('closed');
    });

    it('computes unrealized P&L from the last fill price', () => {
      ledger.recordFill(buyFill());
      const position = ledger.getPosition(MINT);
      // 1000 * (0.00005 - 0.000051)
      expect(position?.lastPriceSol).toBe(0.00005);
      expect(position?.unrealizedSol).toBeCloseTo(-0.001, 9);
    });

    it('is idempotent — re-recording the same fill does not double the position', () => {
      ledger.recordFill(buyFill());
      ledger.recordFill(buyFill());
      ledger.recordFill(buyFill());

      expect(ledger.getPosition(MINT)?.tokens).toBe(1_000_000_000n);
      expect(ledger.getFillsForIntent('intent-buy')).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Replay order — the tie-break carries causal meaning, not alphabet
  // -------------------------------------------------------------------------

  describe('replay order for fills sharing a millisecond', () => {
    /**
     * The hazard, found by handoff 08 and fixed here.
     *
     * A fill's `at` is the local wall clock, so two fills for one mint can
     * legitimately share a millisecond. The old tie-break was the primary key
     * — `intentId:mint` for a paper fill — which sorts alphabetically and says
     * nothing about which trade happened first.
     *
     * These ids are chosen so alphabet and causality disagree: the SELL is
     * `exit:...`, the BUY is `seed:...`, and `'exit' < 'seed'`. Under the old
     * rule the sell replays against a flat position, relieves basis that was
     * never acquired, and leaves the position `open` after a completed exit —
     * a position the guard layer would then refuse to sell again as a
     * duplicate holding, on a mint the bot no longer owns.
     */
    const SHARED_AT = AT;

    function seedAndExit(): void {
      // Inserted buy-first, which is the causal order and the rowid order.
      ledger.recordFill(
        buyFill({ intentId: 'seed', at: SHARED_AT, tokensDelta: 1_000_000_000n }),
      );
      ledger.recordFill(
        sellFill({ intentId: 'exit', at: SHARED_AT, tokensDelta: -1_000_000_000n }),
      );
    }

    it('replays buy-then-sell when the sell intent id sorts first', () => {
      seedAndExit();

      const position = ledger.getPosition(MINT);
      expect(position?.tokens).toBe(0n);
      expect(position?.state).toBe('closed');
      expect(position?.costLamports).toBe(0n);
    });

    it('excludes the closed position from a reconcile report', () => {
      seedAndExit();

      // The operational consequence: sell-first replay left this position open,
      // so a restart would report a holding the bot had already exited.
      expect(ledger.reconcileOnStartup(SHARED_AT).openPositions).toHaveLength(0);
    });

    it('books the realized P&L of the round trip, not of a phantom short', () => {
      seedAndExit();

      // Paid 50_000_000 + 1_000_000 fee, received 80_000_000 less a 1_000_000
      // fee: +28_000_000 lamports. Replayed sell-first the basis relief is 0
      // (nothing held), so the sell alone books +79_000_000.
      expect(ledger.getDailyPnl(TODAY)?.realizedLamports).toBe(28_000_000n);
    });

    it('orders on `at` first — rowid only breaks ties', () => {
      // A fill inserted second but stamped earlier must still replay first, or
      // the tie-break would have quietly become the whole ordering.
      ledger.recordFill(sellFill({ intentId: 'exit', at: SHARED_AT + 1_000 }));
      ledger.recordFill(buyFill({ intentId: 'seed', at: SHARED_AT }));

      expect(ledger.getPosition(MINT)?.tokens).toBe(0n);
      expect(ledger.getPosition(MINT)?.state).toBe('closed');
    });
  });

  // -------------------------------------------------------------------------
  // Crash-retry identity — the fill is rebuilt by the caller, not replayed
  // -------------------------------------------------------------------------

  describe('idempotency is on the primary key ONLY', () => {
    it('a retry does not rewrite the recorded `at` of a fill', () => {
      // `INSERT OR REPLACE` would. That matters twice: `at` decides which UTC
      // day a realized P&L lands in, and it is the primary sort key of the
      // projection replay. A crash-retry rewriting it moves history.
      ledger.recordFill(buyFill({ at: AT }));
      ledger.recordFill(buyFill({ at: AT + 86_400_000 }));

      const fills = ledger.getFillsForIntent('intent-buy');
      expect(fills).toHaveLength(1);
      expect(fills[0]?.at).toBe(AT);
    });

    it('a retry does not rewrite the recorded amounts of a fill', () => {
      ledger.recordFill(buyFill({ tokensDelta: 1_000_000_000n }));
      ledger.recordFill(buyFill({ tokensDelta: 9_999_999_999n }));

      expect(ledger.getFillsForIntent('intent-buy')[0]?.tokensDelta).toBe(1_000_000_000n);
      expect(ledger.getPosition(MINT)?.tokens).toBe(1_000_000_000n);
    });

    it('a NOT NULL violation THROWS rather than being silently dropped', () => {
      // Until 2026-08-03 `INSERT OR IGNORE` swallowed this along with the
      // primary-key conflict it was there for, so a fill could be "recorded"
      // and simply not exist.
      expect(() =>
        ledger.recordFill(buyFill({ tokensDelta: Number.NaN as unknown as bigint })),
      ).toThrow();
      expect(ledger.getFillsForIntent('intent-buy')).toHaveLength(0);

      expect(() =>
        ledger.recordIntent(buyIntent({ amountLamports: Number.NaN as unknown as bigint })),
      ).toThrow();
      expect(ledger.getIntentStatus('intent-buy')).toBeUndefined();
    });

    it('a CHECK violation throws too', () => {
      // `simulated = 1 AND signature IS NULL` is a CHECK. A row that breaks it
      // is a live fill claiming to be paper, or the reverse.
      expect(() =>
        ledger.recordFill({
          ...buyFill(),
          simulated: false,
          signature: null as unknown as string,
        } as never),
      ).toThrow();
    });
  });

  describe('the position replay clamps an oversell of its own accord', () => {
    it('never lets a position go negative, even if a fill asks it to', () => {
      // The guard layer clamps before the broker now, so this path is not
      // reachable through `execute` any more. It is still the ledger's own
      // invariant — `tokens >= 0n` — and a fill written by any other route
      // (an orphan acknowledgement, a future live broker, a repair script)
      // must not be able to break it.
      ledger.recordFill(buyFill({ tokensDelta: 1_000_000_000n }));
      ledger.recordFill(sellFill({ tokensDelta: -999_999_999_999n }));

      const position = ledger.getPosition(MINT);
      expect(position?.tokens).toBe(0n);
      expect(position?.state).toBe('closed');
      expect(position!.tokens >= 0n).toBe(true);
    });
  });

  describe('crash-retry deduplication', () => {
    /**
     * Stands in for the broker adapter: builds a fresh Fill each time, stamping
     * `at` from the clock at the moment the swap is observed. Passing one
     * object twice would prove nothing — a real retry constructs a new one.
     */
    function paperExecutor(clock: () => UnixMillis) {
      return (intent: OrderIntent): void => {
        ledger.recordFill({
          intentId: intent.id,
          side: 'buy',
          mint: MINT,
          tokensDelta: 1_000_000_000n,
          lamportsDelta: -50_000_000n,
          decimals: DECIMALS,
          feesLamports: 1_000_000n,
          slippageBps: 20,
          simulated: true,
          at: clock(),
        });
      };
    }

    function liveExecutor(clock: () => UnixMillis, signature: string) {
      return (intent: OrderIntent): void => {
        ledger.recordFill({
          intentId: intent.id,
          side: 'buy',
          mint: MINT,
          tokensDelta: 1_000_000_000n,
          lamportsDelta: -50_000_000n,
          decimals: DECIMALS,
          feesLamports: 1_000_000n,
          slippageBps: 20,
          simulated: false,
          // A retry re-observes the same confirmed transaction, so the
          // signature is identical even though the clock has moved.
          signature,
          at: clock(),
        });
      };
    }

    it('dedups a live crash-retry even though `at` differs', () => {
      let now = AT;
      const execute = liveExecutor(() => now, '5xTr...signature');
      const intent = buyIntent();

      ledger.recordIntent(intent, AT);
      execute(intent); // lands, then the process dies

      now += 4_000; // restart: wall clock has moved on
      execute(intent); // retry of the same intent

      expect(ledger.getFillsForIntent(intent.id)).toHaveLength(1);
      expect(ledger.getPosition(MINT)?.tokens).toBe(1_000_000_000n);
    });

    it('dedups a paper crash-retry even though `at` differs', () => {
      let now = AT;
      const execute = paperExecutor(() => now);
      const intent = buyIntent();

      ledger.recordIntent(intent, AT);
      execute(intent);

      now += 4_000;
      execute(intent);

      expect(ledger.getFillsForIntent(intent.id)).toHaveLength(1);
      expect(ledger.getPosition(MINT)?.tokens).toBe(1_000_000_000n);
    });

    it('keeps genuinely distinct live fills apart', () => {
      const intent = buyIntent();
      ledger.recordIntent(intent, AT);
      liveExecutor(() => AT, 'signature-one')(intent);
      liveExecutor(() => AT + 1_000, 'signature-two')(intent);

      // Two transactions really did land: a partial fill, not a retry.
      expect(ledger.getFillsForIntent(intent.id)).toHaveLength(2);
      expect(ledger.getPosition(MINT)?.tokens).toBe(2_000_000_000n);
    });

    it('round-trips a live fill back into a LiveFill with its signature', () => {
      const intent = buyIntent();
      liveExecutor(() => AT, 'sig-round-trip')(intent);

      const [stored] = ledger.getFillsForIntent(intent.id);
      expect(stored?.simulated).toBe(false);
      expect(stored?.simulated === false ? stored.signature : undefined).toBe('sig-round-trip');
    });

    it('tracks positions per mint independently', () => {
      ledger.recordFill(buyFill());
      ledger.recordFill(buyFill({ intentId: 'other', mint: 'OtherMint', tokensDelta: 7_000_000n }));

      expect(ledger.getOpenPositions()).toHaveLength(2);
      expect(ledger.getPosition('OtherMint')?.tokens).toBe(7_000_000n);
    });

    it('reopens a position with a fresh openedAt after a full exit', () => {
      ledger.recordFill(buyFill());
      ledger.recordFill(sellFill());
      ledger.recordFill(buyFill({ intentId: 'intent-buy-3', at: AT + 120_000 }));

      const position = ledger.getPosition(MINT);
      expect(position?.state).toBe('open');
      expect(position?.openedAt).toBe(AT + 120_000);
    });
  });

  describe('daily pnl', () => {
    it('books realized profit, fees and trade count', () => {
      ledger.recordFill(buyFill());
      ledger.recordFill(sellFill());

      const pnl = ledger.getDailyPnl(TODAY);
      // 0.08 proceeds - 0.051 basis - 0.001 exit fee
      expect(pnl?.realizedLamports).toBe(28_000_000n);
      expect(pnl?.feesLamports).toBe(2_000_000n);
      expect(pnl?.tradeCount).toBe(2);
    });

    it('reports a realized loss as a positive number for the guard layer', () => {
      ledger.recordFill(buyFill());
      ledger.recordFill(sellFill({ lamportsDelta: 20_000_000n }));

      // 0.02 - 0.051 - 0.001 = -0.032
      expect(ledger.getDailyPnl(TODAY)?.realizedLamports).toBe(-32_000_000n);
      expect(ledger.getRealizedLossLamportsToday(AT)).toBe(32_000_000n);
    });

    it('reports no loss on a profitable day', () => {
      ledger.recordFill(buyFill());
      ledger.recordFill(sellFill());
      expect(ledger.getRealizedLossLamportsToday(AT)).toBe(0n);
    });

    it('reports no loss when nothing has traded', () => {
      expect(ledger.getRealizedLossLamportsToday(AT)).toBe(0n);
    });

    it('keeps days separate', () => {
      const nextDay = AT + 24 * 60 * 60 * 1_000;
      ledger.recordFill(buyFill());
      ledger.recordFill(sellFill({ at: nextDay }));

      expect(ledger.getDailyPnl(TODAY)?.tradeCount).toBe(1);
      expect(ledger.getDailyPnl(utcDate(nextDay))?.tradeCount).toBe(1);
      expect(ledger.getDailyPnl(utcDate(nextDay))?.realizedLamports).toBe(28_000_000n);
    });
  });

  describe('reconcileOnStartup', () => {
    it('reports a clean ledger as not dirty', () => {
      const report = ledger.reconcileOnStartup(AT);
      expect(report).toMatchObject({ openPositions: [], recovered: [], orphaned: [], dirty: false });
    });

    it('returns open positions rebuilt from fills', () => {
      ledger.recordFill(buyFill());
      const report = ledger.reconcileOnStartup(AT + 1);

      expect(report.openPositions).toHaveLength(1);
      expect(report.openPositions[0]?.mint).toBe(MINT);
      expect(report.openPositions[0]?.tokens).toBe(1_000_000_000n);
      expect(report.dirty).toBe(false);
    });

    it('excludes closed positions from the report', () => {
      ledger.recordFill(buyFill());
      ledger.recordFill(sellFill());
      expect(ledger.reconcileOnStartup(AT).openPositions).toHaveLength(0);
    });

    it('recovers a pending intent that does have a fill', () => {
      ledger.recordIntent(buyIntent(), AT);
      ledger.recordFill(buyFill());
      // No resolveIntent — this is the crash window.

      const report = ledger.reconcileOnStartup(AT + 5_000);

      expect(report.recovered).toHaveLength(1);
      expect(report.recovered[0]?.id).toBe('intent-buy');
      expect(report.recovered[0]?.tokensDelta).toBe(1_000_000_000n);
      expect(report.orphaned).toHaveLength(0);
      expect(report.dirty).toBe(true);
      expect(ledger.getIntentStatus('intent-buy')).toBe('filled');
      // The token is still tracked. This is the whole point.
      expect(report.openPositions[0]?.tokens).toBe(1_000_000_000n);
    });

    it('orphans a pending intent with no fill', () => {
      ledger.recordIntent(buyIntent(), AT);

      const report = ledger.reconcileOnStartup(AT + 5_000);

      expect(report.orphaned).toHaveLength(1);
      expect(report.orphaned[0]?.id).toBe('intent-buy');
      expect(report.recovered).toHaveLength(0);
      expect(report.dirty).toBe(true);
      expect(ledger.getIntentStatus('intent-buy')).toBe('orphaned');
    });

    it('logs orphans as warnings that name the mint', () => {
      ledger.recordIntent(buyIntent(), AT);
      ledger.reconcileOnStartup(AT + 5_000);

      const warnings = logs.filter((line) => line.level === 'warn');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toContain('CRASH ORPHAN');
      expect(warnings[0]?.fields).toMatchObject({ intentId: 'intent-buy', mint: MINT });
    });

    it('leaves already-resolved intents alone', () => {
      ledger.recordIntent(buyIntent(), AT);
      ledger.resolveIntent('intent-buy', 'rejected', 'CANNOT_SELL', AT + 1);

      const report = ledger.reconcileOnStartup(AT + 5_000);
      expect(report.dirty).toBe(false);
      expect(ledger.getIntentStatus('intent-buy')).toBe('rejected');
    });

    it('is safe to run twice', () => {
      ledger.recordIntent(buyIntent(), AT);
      ledger.reconcileOnStartup(AT + 5_000);
      const second = ledger.reconcileOnStartup(AT + 6_000);

      expect(second.dirty).toBe(false);
      expect(second.orphaned).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // The acknowledgement gate
  // -------------------------------------------------------------------------

  describe('orphan acknowledgement', () => {
    /** Produce one unacknowledged orphan and return its id. */
    function orphan(id = 'intent-buy'): string {
      ledger.recordIntent(buyIntent({ id }), AT);
      ledger.reconcileOnStartup(AT + 5_000);
      return id;
    }

    it('counts an orphan as unacknowledged until it is signed off', () => {
      const id = orphan();
      expect(ledger.getUnacknowledgedOrphanCount()).toBe(1);
      expect(ledger.getUnacknowledgedOrphans()[0]?.id).toBe(id);

      ledger.acknowledgeOrphan(id, 'turner', { kind: 'no-tx-on-chain' }, AT + 10_000);
      expect(ledger.getUnacknowledgedOrphanCount()).toBe(0);
      expect(ledger.getUnacknowledgedOrphans()).toHaveLength(0);
    });

    it('records who acknowledged it and how', () => {
      const id = orphan();
      ledger.acknowledgeOrphan(id, 'turner', { kind: 'manually-closed' }, AT + 10_000);

      expect(ledger.getAcknowledgement(id)).toEqual({
        intentId: id,
        acknowledgedAt: AT + 10_000,
        acknowledgedBy: 'turner',
        resolution: 'manually-closed',
      });
    });

    it('records the fill and opens the position when tx-confirmed', () => {
      const id = orphan();
      expect(ledger.getPosition(MINT)).toBeUndefined();

      ledger.acknowledgeOrphan(
        id,
        'turner',
        {
          kind: 'tx-confirmed',
          fill: {
            signature: 'confirmed-sig',
            tokensDelta: 1_000_000_000n,
            decimals: DECIMALS,
            lamportsDelta: -50_000_000n,
            feesLamports: 1_000_000n,
            at: AT + 2_000,
          },
        },
        AT + 10_000,
      );

      // The holding is on the books before the gate lifts.
      const position = ledger.getPosition(MINT);
      expect(position?.tokens).toBe(1_000_000_000n);
      expect(position?.state).toBe('open');
      // Price derived from the deltas: 0.05 SOL / 1000 tokens.
      expect(position?.avgEntrySol).toBeCloseTo(0.000051, 12);
      expect(ledger.getOpenPositions()).toHaveLength(1);

      // And the intent is no longer an orphan at all.
      expect(ledger.getIntentStatus(id)).toBe('filled');
      expect(ledger.getUnacknowledgedOrphanCount()).toBe(0);
    });

    it('stores the tx-confirmed fill as a live fill carrying its signature', () => {
      const id = orphan();
      ledger.acknowledgeOrphan(id, 'turner', {
        kind: 'tx-confirmed',
        fill: {
          signature: 'confirmed-sig',
          tokensDelta: 1_000_000_000n,
          decimals: DECIMALS,
          lamportsDelta: -50_000_000n,
          feesLamports: 1_000_000n,
          at: AT + 2_000,
        },
      });

      const [stored] = ledger.getFillsForIntent(id);
      expect(stored?.simulated).toBe(false);
      expect(stored?.simulated === false ? stored.signature : undefined).toBe('confirmed-sig');
    });

    it('records slippage as null, not zero, for a reconstructed fill', () => {
      const id = orphan();
      ledger.acknowledgeOrphan(id, 'turner', {
        kind: 'tx-confirmed',
        fill: {
          signature: 'confirmed-sig',
          tokensDelta: 1_000_000_000n,
          decimals: DECIMALS,
          lamportsDelta: -50_000_000n,
          feesLamports: 1_000_000n,
          at: AT + 2_000,
        },
      });

      // Zero would be a claim of perfect execution and would bias anything
      // calibrated on realized slippage.
      expect(ledger.getFillsForIntent(id)[0]?.slippageBps).toBeNull();
    });

    it('keeps a genuinely measured zero distinguishable from an unmeasurable one', () => {
      ledger.recordFill(buyFill({ intentId: 'measured', slippageBps: 0 }));
      const measured = ledger.getFillsForIntent('measured')[0];

      expect(measured?.slippageBps).toBe(0);
      expect(measured?.slippageBps).not.toBeNull();
    });

    it('refuses a signature already recorded against another intent', () => {
      // A real fill exists for some other intent.
      ledger.recordFill({
        intentId: 'other-intent',
        side: 'buy',
        mint: 'OtherMint',
        tokensDelta: 500_000_000n,
        lamportsDelta: -20_000_000n,
        decimals: DECIMALS,
        feesLamports: 1_000_000n,
        slippageBps: 15,
        simulated: false,
        signature: 'shared-sig',
        at: AT,
      });

      const id = orphan();
      // Operator pastes the wrong signature during an incident.
      expect(() =>
        ledger.acknowledgeOrphan(id, 'turner', {
          kind: 'tx-confirmed',
          fill: {
            signature: 'shared-sig',
            tokensDelta: 1_000_000_000n,
            decimals: DECIMALS,
            lamportsDelta: -50_000_000n,
            feesLamports: 1_000_000n,
            at: AT + 2_000,
          },
        }),
      ).toThrow(AcknowledgementError);

      // Without this check the INSERT would no-op, the intent would be marked
      // filled, and the gate would lift over an unbooked holding.
      expect(ledger.getUnacknowledgedOrphanCount()).toBe(1);
      expect(ledger.getIntentStatus(id)).toBe('orphaned');
      expect(ledger.getPosition(MINT)).toBeUndefined();
    });

    it('is idempotent against a later duplicate of the same transaction', () => {
      const id = orphan();
      const fill = {
        signature: 'confirmed-sig',
        tokensDelta: 1_000_000_000n,
        decimals: DECIMALS,
        lamportsDelta: -50_000_000n,
        feesLamports: 1_000_000n,
        at: AT + 2_000,
      };
      ledger.acknowledgeOrphan(id, 'turner', { kind: 'tx-confirmed', fill });

      // The same transaction arriving again by any route must not double it.
      ledger.recordFill({
        intentId: id,
        side: 'buy',
        mint: MINT,
        tokensDelta: 1_000_000_000n,
        lamportsDelta: -50_000_000n,
        decimals: DECIMALS,
        feesLamports: 1_000_000n,
        slippageBps: 0,
        simulated: false,
        signature: 'confirmed-sig',
        at: AT + 9_999,
      });

      expect(ledger.getPosition(MINT)?.tokens).toBe(1_000_000_000n);
    });

    it('does not lift the gate when the fill data is rejected', () => {
      const id = orphan();
      expect(() =>
        ledger.acknowledgeOrphan(id, 'turner', {
          kind: 'tx-confirmed',
          // Negative tokensDelta for a buy: the operator mistyped.
          fill: {
            signature: 'sig',
            tokensDelta: -1_000_000_000n,
            decimals: DECIMALS,
            lamportsDelta: -50_000_000n,
            feesLamports: 1_000_000n,
            at: AT,
          },
        }),
      ).toThrow(AcknowledgementError);

      // Nothing partially applied: still gated, still no position.
      expect(ledger.getUnacknowledgedOrphanCount()).toBe(1);
      expect(ledger.getPosition(MINT)).toBeUndefined();
      expect(ledger.getIntentStatus(id)).toBe('orphaned');
    });

    it('rejects tx-confirmed with a zero tokensDelta', () => {
      const id = orphan();
      expect(() =>
        ledger.acknowledgeOrphan(id, 'turner', {
          kind: 'tx-confirmed',
          fill: { signature: 'sig', tokensDelta: 0n, decimals: DECIMALS, lamportsDelta: -50_000_000n, feesLamports: 0n, at: AT },
        }),
      ).toThrow(AcknowledgementError);
    });

    it('rejects tx-confirmed with a blank signature', () => {
      const id = orphan();
      expect(() =>
        ledger.acknowledgeOrphan(id, 'turner', {
          kind: 'tx-confirmed',
          fill: { signature: '  ', tokensDelta: 1_000_000_000n, decimals: DECIMALS, lamportsDelta: -50_000_000n, feesLamports: 0n, at: AT },
        }),
      ).toThrow(AcknowledgementError);
    });

    it('requires an operator name', () => {
      const id = orphan();
      expect(() => ledger.acknowledgeOrphan(id, '  ', { kind: 'no-tx-on-chain' })).toThrow(
        AcknowledgementError,
      );
      expect(ledger.getUnacknowledgedOrphanCount()).toBe(1);
    });

    it('refuses to acknowledge the same orphan twice', () => {
      const id = orphan();
      ledger.acknowledgeOrphan(id, 'turner', { kind: 'no-tx-on-chain' });
      expect(() => ledger.acknowledgeOrphan(id, 'someone-else', { kind: 'manually-closed' })).toThrow(
        AcknowledgementError,
      );
    });

    it('refuses to acknowledge an intent that is not an orphan', () => {
      ledger.recordIntent(buyIntent(), AT);
      ledger.resolveIntent('intent-buy', 'rejected', 'KILL_SWITCH_ENGAGED', AT + 1);
      expect(() => ledger.acknowledgeOrphan('intent-buy', 'turner', { kind: 'no-tx-on-chain' })).toThrow(
        AcknowledgementError,
      );
    });

    it('refuses an unknown intent id', () => {
      expect(() => ledger.acknowledgeOrphan('nope', 'turner', { kind: 'no-tx-on-chain' })).toThrow(
        AcknowledgementError,
      );
    });

    it('gates on each orphan separately — one sign-off does not clear the rest', () => {
      orphan('orphan-a');
      orphan('orphan-b');
      expect(ledger.getUnacknowledgedOrphanCount()).toBe(2);

      ledger.acknowledgeOrphan('orphan-a', 'turner', { kind: 'no-tx-on-chain' });
      expect(ledger.getUnacknowledgedOrphanCount()).toBe(1);
    });

    it('survives a restart — acknowledgement state is on disk, not in memory', () => {
      // Covered end-to-end by the persistence suite below; this asserts the
      // in-process invariant that reconcile does not re-orphan a signed-off row.
      const id = orphan();
      ledger.acknowledgeOrphan(id, 'turner', { kind: 'no-tx-on-chain' });
      ledger.reconcileOnStartup(AT + 20_000);
      expect(ledger.getUnacknowledgedOrphanCount()).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Refusal to open a ledger written by an older schema
// ---------------------------------------------------------------------------

describe('schema version gate', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'solana-tracker-version-'));
    dbPath = join(dir, 'old.db');

    // Version 1, as the float build wrote it: whole-token amounts, whole-SOL
    // amounts, and crucially no record of any mint's decimals.
    const old = new Database(dbPath);
    old.exec(`
      CREATE TABLE fills (
        id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, side TEXT NOT NULL,
        mint TEXT NOT NULL, tokens_delta REAL NOT NULL, sol_delta REAL NOT NULL,
        price_sol REAL NOT NULL, fees_sol REAL NOT NULL,
        slippage_bps REAL NOT NULL, simulated INTEGER NOT NULL, at INTEGER NOT NULL
      );
    `);
    old.prepare(
      `INSERT INTO fills VALUES ('f1', 'intent-buy', 'buy', '${MINT}', 1000, -0.05,
       0.00005, 0.001, 20, 1, ${AT})`,
    ).run();
    old.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to open a version 1 ledger', () => {
    expect(() => openLedger({ path: dbPath, logger: capturingLogger([]) })).toThrow(
      LedgerVersionError,
    );
  });

  it('explains why it cannot convert, rather than guessing a scale', () => {
    try {
      openLedger({ path: dbPath, logger: capturingLogger([]) });
      throw new Error('expected openLedger to refuse');
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerVersionError);
      expect((error as Error).message).toContain('decimals');
      expect((error as Error).message).toContain('Archive the old file');
    }
  });

  it('leaves the old file untouched so the data is still recoverable', () => {
    expect(() => openLedger({ path: dbPath, logger: capturingLogger([]) })).toThrow();

    const raw = new Database(dbPath);
    try {
      const count = raw.prepare('SELECT COUNT(*) AS n FROM fills').get() as { n: number };
      expect(Number(count.n)).toBe(1);
    } finally {
      raw.close();
    }
  });

  it('stamps a fresh database with the current version', () => {
    const fresh = join(dir, 'fresh.db');
    const ledger = openLedger({ path: fresh, logger: capturingLogger([]) });
    ledger.close();

    const raw = new Database(fresh);
    try {
      expect(Number(raw.pragma('user_version', { simple: true }))).toBe(2);
    } finally {
      raw.close();
    }
  });

  it('reopens a current database without complaint', () => {
    const fresh = join(dir, 'fresh2.db');
    const first = openLedger({ path: fresh, logger: capturingLogger([]) });
    first.recordFill(buyFill());
    first.close();

    const second = openLedger({ path: fresh, logger: capturingLogger([]) });
    try {
      expect(second.getPosition(MINT)?.tokens).toBe(1_000_000_000n);
    } finally {
      second.close();
    }
  });
});


// ---------------------------------------------------------------------------
// Durability across a real process kill
// ---------------------------------------------------------------------------

describe('crash recovery (real SIGKILL)', () => {
  let dir: string;
  let dbPath: string;
  let logs: LogLine[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'solana-tracker-crash-'));
    dbPath = join(dir, 'tracker.db');
    logs = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Run the child, kill it mid-trade, and assert it really died by signal. */
  function crashMidTrade(when: 'before-fill' | 'after-fill'): void {
    // `node --import tsx` rather than the tsx CLI: the CLI wrapper spawns an
    // inner process, so the kill would land on the child's child and this
    // assertion would see a clean exit instead of a signal.
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', resolve(HERE, 'fixtures/crash-child.ts'), dbPath, MINT, when],
      { encoding: 'utf8', cwd: PROJECT_ROOT },
    );

    // If this fails the test proves nothing — the process must die uncleanly.
    expect(result.signal, `child stderr: ${result.stderr}`).toBe('SIGKILL');
    expect(existsSync(dbPath)).toBe(true);
  }

  it('survives a kill after the fill was written — the token is not lost', () => {
    crashMidTrade('after-fill');

    // A brand new process, opening the file the dead one left behind.
    const ledger = openLedger({ path: dbPath, logger: capturingLogger(logs) });
    try {
      const report = ledger.reconcileOnStartup(AT + 10_000);

      // The position is reconstructed from the committed fill.
      expect(report.openPositions).toHaveLength(1);
      expect(report.openPositions[0]?.mint).toBe(MINT);
      expect(report.openPositions[0]?.tokens).toBe(1_000_000_000n);

      // The intent the crash left pending is resolved against its fill.
      expect(report.recovered).toHaveLength(1);
      expect(report.recovered[0]?.id).toBe('crashed-intent');
      expect(report.orphaned).toHaveLength(0);
      expect(ledger.getIntentStatus('crashed-intent')).toBe('filled');
      expect(report.dirty).toBe(true);
    } finally {
      ledger.close();
    }
  });

  it('survives a kill before the fill was written — the attempt is flagged', () => {
    crashMidTrade('before-fill');

    const ledger = openLedger({ path: dbPath, logger: capturingLogger(logs) });
    try {
      const report = ledger.reconcileOnStartup(AT + 10_000);

      // No fill was committed, so there is no position to rebuild — but the
      // attempt is on record rather than vanishing.
      expect(report.openPositions).toHaveLength(0);
      expect(report.orphaned).toHaveLength(1);
      expect(report.orphaned[0]?.id).toBe('crashed-intent');
      expect(report.orphaned[0]?.mint).toBe(MINT);
      expect(ledger.getIntentStatus('crashed-intent')).toBe('orphaned');
      expect(report.dirty).toBe(true);

      // And it is loud: the swap may still have confirmed on chain.
      const warnings = logs.filter((line) => line.level === 'warn');
      expect(warnings[0]?.message).toContain('verify the wallet against chain');
    } finally {
      ledger.close();
    }
  });

  it('rebuilds a wiped positions table from the fills alone', () => {
    crashMidTrade('after-fill');

    // Destroy the derived cache, leaving only the fills. If positions were
    // authoritative rather than derived, the holding would be gone for good.
    const raw = new Database(dbPath);
    raw.prepare('DELETE FROM positions').run();
    expect(raw.prepare('SELECT COUNT(*) AS n FROM positions').get()).toEqual({ n: 0 });
    raw.close();

    const ledger = openLedger({ path: dbPath, logger: capturingLogger(logs) });
    try {
      const report = ledger.reconcileOnStartup(AT + 10_000);
      expect(report.openPositions).toHaveLength(1);
      expect(report.openPositions[0]?.tokens).toBe(1_000_000_000n);
      expect(report.openPositions[0]?.avgEntrySol).toBeCloseTo(0.000051, 12);
    } finally {
      ledger.close();
    }
  });

  it('keeps the gate shut across a restart, and lifts it only after sign-off', () => {
    crashMidTrade('before-fill');

    // First restart: the orphan gates entries.
    const first = openLedger({ path: dbPath, logger: capturingLogger(logs) });
    try {
      first.reconcileOnStartup(AT + 10_000);
      expect(first.getUnacknowledgedOrphanCount()).toBe(1);
    } finally {
      first.close();
    }

    // Second restart without acknowledging: restarting is not a way out.
    const second = openLedger({ path: dbPath, logger: capturingLogger(logs) });
    try {
      second.reconcileOnStartup(AT + 20_000);
      expect(second.getUnacknowledgedOrphanCount()).toBe(1);
      second.acknowledgeOrphan('crashed-intent', 'turner', { kind: 'no-tx-on-chain' }, AT + 21_000);
    } finally {
      second.close();
    }

    // Third restart: the sign-off persisted.
    const third = openLedger({ path: dbPath, logger: capturingLogger(logs) });
    try {
      third.reconcileOnStartup(AT + 30_000);
      expect(third.getUnacknowledgedOrphanCount()).toBe(0);
      expect(third.getAcknowledgement('crashed-intent')?.acknowledgedBy).toBe('turner');
    } finally {
      third.close();
    }
  });

  it('leaves a WAL file that a fresh process replays', () => {
    crashMidTrade('after-fill');
    // The killed process never checkpointed or closed the database.
    expect(existsSync(`${dbPath}-wal`)).toBe(true);

    const ledger = openLedger({ path: dbPath, logger: capturingLogger(logs) });
    try {
      expect(ledger.getFillsForIntent('crashed-intent')).toHaveLength(1);
    } finally {
      ledger.close();
    }
  });
});
