/**
 * Alpha-decay replay harness.
 *
 * The load-bearing test is `recovers a known half-life`: a synthetic pool whose
 * price decays on a known exponential must produce a dataset from which that
 * half-life is recoverable. If it is not, every number this harness emits
 * against real pools is unfalsifiable.
 *
 * NOTE ON THE FIT IN THAT TEST. `src/calibration/` deliberately contains no
 * fitting — that is `calibrate.fit_alpha_half_life`'s job, in Python. The
 * two-point log solve below lives in the test file only, as an *assertion* that
 * the emitted curve has the shape it claims, not as production logic. It must
 * not migrate into `src/`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CACHE_DIR,
  getPoolSwaps,
  firstAtOrAfter,
  nearestTo,
  orderPoolSwaps,
  readCache,
  resolvePoolAccounts,
  toPoolSwap,
} from '../src/calibration/poolHistory.js';
import type { PoolRpc, PoolSwap, SignaturePage } from '../src/calibration/poolHistory.js';
import type { ParsedTransactionWithMeta } from '../src/adapters/swapParser.js';
import {
  DEFAULT_DELAYS_S,
  checkDelayZeroMatchesRealised,
  checkFilledRowsHaveSwaps,
  delaysCsv,
  failureAdjustment,
  replayRoundTrip,
  summarise,
} from '../src/calibration/replayDelays.js';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const POOL = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
const TAKER = 'BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9XSiHMY';
const T0 = 1_700_000_000_000;

/**
 * Exit delay for tests that assert ENTRY-side behaviour only.
 *
 * Zero is never a correct exit delay for a mirror strategy — see the
 * `replayRoundTrip exit delay` block. These tests were written against an
 * undelayed exit and are preserved at 0 deliberately: they check NO_DATA /
 * NO_FILL classification, the entry-side decay curve and the CSV shape, none of
 * which is a claim about what a copier's exit price would have been. Naming the
 * value stops it reading as a default.
 */
const EXIT_UNDELAYED = 0;

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'calib-'));
  dirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Synthetic transactions
// ---------------------------------------------------------------------------

/**
 * A transaction in which `taker` trades `tokens` for `lamports` against `pool`.
 *
 * Built as balance deltas only, because that is all `swapParser` and
 * `resolvePoolAccounts` are allowed to read. No instruction data appears
 * anywhere in this file, which is the point.
 */
function swapTx(options: {
  signature: string;
  slot: number;
  blockTime: number;
  lamports: bigint;
  tokens: bigint;
  takerBuys: boolean;
  decimals?: number;
  pool?: string;
}): ParsedTransactionWithMeta {
  const decimals = options.decimals ?? 6;
  const pool = options.pool ?? POOL;
  const takerTokensPre = 1_000_000_000_000n;
  const poolTokensPre = 9_000_000_000_000n;

  const takerDelta = options.takerBuys ? options.tokens : -options.tokens;
  const takerSolDelta = options.takerBuys ? -options.lamports : options.lamports;

  const tokenBalance = (index: number, owner: string, amount: bigint) => ({
    accountIndex: index,
    mint: MINT,
    owner,
    uiTokenAmount: { amount: amount.toString(), decimals },
  });

  return {
    slot: options.slot,
    blockTime: Math.floor(options.blockTime / 1_000),
    transaction: {
      signatures: [options.signature],
      message: { accountKeys: [{ pubkey: TAKER }, { pubkey: pool }] },
    },
    meta: {
      err: null,
      fee: 5_000,
      // Both sides move. The pool's lamports are the mirror of the taker's —
      // without that the pool has no SOL leg and `parseSwap` correctly refuses
      // to call it a swap, which is what this fixture originally got wrong.
      preBalances: [10_000_000_000, 10_000_000_000],
      postBalances: [
        Number(10_000_000_000n + takerSolDelta) - 5_000,
        Number(10_000_000_000n - takerSolDelta),
      ],
      preTokenBalances: [
        tokenBalance(0, TAKER, takerTokensPre),
        tokenBalance(1, pool, poolTokensPre),
      ],
      postTokenBalances: [
        tokenBalance(0, TAKER, takerTokensPre + takerDelta),
        tokenBalance(1, pool, poolTokensPre - takerDelta),
      ],
    },
  } as unknown as ParsedTransactionWithMeta;
}

/** A pool swap priced directly, bypassing the parser. For replay-only tests. */
function poolSwapAt(ts: number, priceSol: number, overrides: Partial<PoolSwap> = {}): PoolSwap {
  return {
    mint: MINT,
    signature: `sig-${ts}-${priceSol}`,
    blockTime: ts,
    slot: Math.floor((ts - T0) / 400) + 1_000,
    solDelta: -1_000_000_000n,
    tokenDelta: 1_000_000n,
    priceSol,
    venue: 'pumpfun',
    isBuy: true,
    transactionIndex: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pool resolution
// ---------------------------------------------------------------------------

describe('resolvePoolAccounts', () => {
  it('finds the account on the other side of the taker', () => {
    const tx = swapTx({
      signature: 'a',
      slot: 1,
      blockTime: T0,
      lamports: 1_000_000_000n,
      tokens: 1_000_000n,
      takerBuys: true,
    });
    expect(resolvePoolAccounts(tx, MINT, TAKER)).toEqual([POOL]);
  });

  it('is direction-agnostic — a sell resolves the same pool', () => {
    const tx = swapTx({
      signature: 'b',
      slot: 1,
      blockTime: T0,
      lamports: 1_000_000_000n,
      tokens: 1_000_000n,
      takerBuys: false,
    });
    expect(resolvePoolAccounts(tx, MINT, TAKER)).toEqual([POOL]);
  });

  it('returns nothing when the taker did not move that mint', () => {
    const tx = swapTx({
      signature: 'c',
      slot: 1,
      blockTime: T0,
      lamports: 1_000_000_000n,
      tokens: 1_000_000n,
      takerBuys: true,
    });
    expect(resolvePoolAccounts(tx, 'So11111111111111111111111111111111111111112', TAKER)).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

describe('toPoolSwap', () => {
  it('prices from the taker perspective, inverting the pool side', () => {
    // Taker pays 1 SOL for 1.0 whole token (1e6 base units at 6dp) -> 1 SOL each.
    const tx = swapTx({
      signature: 'p',
      slot: 5,
      blockTime: T0,
      lamports: 1_000_000_000n,
      tokens: 1_000_000n,
      takerBuys: true,
    });

    const swap = toPoolSwap(tx, POOL, MINT, 3);
    expect(swap).toBeDefined();
    expect(swap?.priceSol).toBeCloseTo(1, 9);
    // The pool sold, so the taker bought.
    expect(swap?.isBuy).toBe(true);
    expect(swap?.tokenDelta).toBe(1_000_000n);
    expect(swap?.solDelta).toBeLessThan(0n);
    expect(swap?.blockTime).toBe(T0);
    expect(swap?.transactionIndex).toBe(3);
  });

  it('prices a taker sell at the same scale', () => {
    const tx = swapTx({
      signature: 'q',
      slot: 6,
      blockTime: T0,
      lamports: 2_000_000_000n,
      tokens: 1_000_000n,
      takerBuys: false,
    });
    const swap = toPoolSwap(tx, POOL, MINT, 0);
    expect(swap?.priceSol).toBeCloseTo(2, 9);
    expect(swap?.isBuy).toBe(false);
    expect(swap?.tokenDelta).toBeLessThan(0n);
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe('orderPoolSwaps', () => {
  it('sorts by slot, then transaction index', () => {
    const swaps = [
      poolSwapAt(T0, 3, { slot: 11, transactionIndex: 0, signature: 'c' }),
      poolSwapAt(T0, 2, { slot: 10, transactionIndex: 5, signature: 'b' }),
      poolSwapAt(T0, 1, { slot: 10, transactionIndex: 1, signature: 'a' }),
    ];
    expect(orderPoolSwaps(swaps).map((s) => s.signature)).toEqual(['a', 'b', 'c']);
  });

  /**
   * Slot ties. Every transaction in a block shares one `blockTime`, so without a
   * deterministic tie-break "the first swap at or after target_ts" would depend
   * on RPC page order and the measured entry price would drift between runs.
   */
  it('breaks slot+index ties on signature, stably', () => {
    const make = (sig: string): PoolSwap =>
      poolSwapAt(T0, 1, { slot: 42, transactionIndex: 0, signature: sig });

    const forward = orderPoolSwaps([make('c'), make('a'), make('b')]);
    const reverse = orderPoolSwaps([make('b'), make('c'), make('a')]);

    expect(forward.map((s) => s.signature)).toEqual(['a', 'b', 'c']);
    expect(reverse.map((s) => s.signature)).toEqual(['a', 'b', 'c']);
  });

  it('ignores blockTime, which is identical across a block', () => {
    const swaps = [
      poolSwapAt(T0 + 5_000, 1, { slot: 20, signature: 'later-slot' }),
      poolSwapAt(T0 + 5_000, 1, { slot: 10, signature: 'earlier-slot' }),
    ];
    expect(orderPoolSwaps(swaps).map((s) => s.signature)).toEqual([
      'earlier-slot',
      'later-slot',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

describe('lookups', () => {
  const path = [
    poolSwapAt(T0, 1),
    poolSwapAt(T0 + 10_000, 2),
    poolSwapAt(T0 + 20_000, 3),
  ];

  it('firstAtOrAfter is inclusive of an exact match', () => {
    expect(firstAtOrAfter(path, T0 + 10_000)?.priceSol).toBe(2);
  });

  it('firstAtOrAfter returns undefined past the end', () => {
    expect(firstAtOrAfter(path, T0 + 30_000)).toBeUndefined();
  });

  it('nearestTo picks the closer side', () => {
    expect(nearestTo(path, T0 + 12_000)?.priceSol).toBe(2);
    expect(nearestTo(path, T0 + 18_000)?.priceSol).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * The exit side of the delay, which was not applied.
 *
 * A mirror exit is learned about over the same chain-to-fill path that delays
 * the entry: the tracked wallet's sell lands, the socket announces it, and only
 * then can we quote and submit. Pricing the entry at `signalTs + delay` and the
 * exit at the wallet's own `exitTs` hands us their exit at our entry — a trade
 * strictly better than anything executable, on both ends of the same position.
 *
 * There is no correct value of 0 here, which is why `exitDelayS` has no default.
 */
describe('replayRoundTrip exit delay', () => {
  /**
   * Price rises into the wallet's exit and falls after it — the ordinary shape
   * of a mint the wallet sold near a local top. An undelayed exit books the top.
   */
  const risingThenFalling = [
    poolSwapAt(T0, 1),
    poolSwapAt(T0 + 5_000, 1.5),
    poolSwapAt(T0 + 10_000, 2),
    poolSwapAt(T0 + 15_000, 1),
  ];
  const trip = { token: MINT, signature: 'rt', signalTs: T0, exitTs: T0 + 10_000 };

  it('prices the exit at the wallet exit PLUS the exit delay', () => {
    const row = replayRoundTrip(trip, risingThenFalling, [0], 5)[0]!;
    expect(row.fillStatus).toBe('FILLED');
    expect(row.entryPriceSol).toBe(1);
    // The swap at T0+15_000, not the T0+10_000 top.
    expect(row.exitPriceSol).toBe(1);
    expect(row.forwardReturn).toBeCloseTo(0, 12);
  });

  it('an undelayed exit books the wallet top, which is the artefact', () => {
    const delayed = replayRoundTrip(trip, risingThenFalling, [0], 5)[0]!;
    const undelayed = replayRoundTrip(trip, risingThenFalling, [0], 0)[0]!;
    expect(undelayed.exitPriceSol).toBe(2);
    expect(undelayed.forwardReturn).toBeCloseTo(1, 12);
    // A flat trade reported as a double. This gap is the finding.
    expect(undelayed.forwardReturn - delayed.forwardReturn).toBeCloseTo(1, 12);
  });

  /**
   * Separate defect, same class. `nearestTo` minimises |blockTime - exitTs| and
   * resolves ties to the EARLIER swap, so it can price our exit at a spike that
   * happened before the wallet sold. We cannot sell on a print we have not seen.
   */
  it('never prices the exit before the wallet sold, even at zero delay', () => {
    const spikeBeforeExit = [
      poolSwapAt(T0, 1),
      poolSwapAt(T0 + 9_000, 5),
      poolSwapAt(T0 + 11_000, 1),
    ];
    const row = replayRoundTrip(trip, spikeBeforeExit, [0], 0)[0]!;
    expect(row.exitPriceSol).toBe(1);
    expect(row.forwardReturn).toBeCloseTo(0, 12);
  });

  it('reports NO_EXIT_PRICE when the delayed exit falls past the path', () => {
    const rows = replayRoundTrip(trip, risingThenFalling, [0], 600);
    expect(rows[0]!.fillStatus).toBe('NO_EXIT_PRICE');
    expect(rows[0]!.forwardReturn).toBeNaN();
  });

  it('a longer exit delay is no better on a falling path', () => {
    const rows = [0, 2, 5].map(
      (exitDelayS) => replayRoundTrip(trip, risingThenFalling, [0], exitDelayS)[0]!,
    );
    // 0s books the T0+10_000 top. 2s and 5s both resolve to the T0+15_000 print,
    // the first at or after the moment we could have submitted, so they agree.
    expect(rows.every((row) => row.fillStatus === 'FILLED')).toBe(true);
    expect(rows[0]!.forwardReturn).toBeGreaterThan(rows[1]!.forwardReturn);
    expect(rows[1]!.forwardReturn).toBeCloseTo(rows[2]!.forwardReturn, 12);
    expect(rows[2]!.exitPriceSol).toBe(1);
  });
});

/**
 * The entry may not be priced at the tracked wallet's own fill, nor at any
 * print that preceded it.
 *
 * `firstAtOrAfter(swaps, signalTs + delay)` has no notion of whose swap it is.
 * At delay 0, `targetTs === signalTs`, and the wallet's own buy sits at exactly
 * that blockTime — so the entry was priced at their fill, which no copier can
 * reach. Measured on HSsJjkHr: the wallet's entry signature was in the pool path
 * for 64 of 67 trips, all at exactly `signalTs`.
 *
 * `blockTime` is second-resolution, so it is worse than that: several prints
 * share the signal's second and `orderPoolSwaps` returns whichever sorts first.
 * That is routinely a trade AHEAD of the wallet's own, which is why the replay's
 * delay-0 entry came out CHEAPER than the wallet's own fill in 8 of 10 trips
 * where both could be matched by signature (median -3.1%).
 *
 * Same shape as the degenerate perfect-foresight ceiling, at the other end of
 * the trade: a bound that could act on information it would not have had.
 */
describe('replayRoundTrip entry exclusion', () => {
  const trip = { token: MINT, signature: 'wallet-buy', signalTs: T0, exitTs: T0 + 20_000 };

  /** Three prints in the signal's second: one before the wallet's, then theirs. */
  const sameSecond = [
    poolSwapAt(T0, 1.0, { signature: 'someone-else-first' }),
    poolSwapAt(T0, 1.5, { signature: 'wallet-buy' }),
    poolSwapAt(T0, 2.0, { signature: 'someone-else-after' }),
    poolSwapAt(T0 + 20_000, 3.0, { signature: 'exit-print' }),
  ];

  it('does not price the entry at the wallet own fill', () => {
    const row = replayRoundTrip(trip, sameSecond, [0], EXIT_UNDELAYED)[0]!;
    expect(row.entryPriceSol).not.toBe(1.5);
  });

  it('does not price the entry ahead of the wallet own fill', () => {
    const row = replayRoundTrip(trip, sameSecond, [0], EXIT_UNDELAYED)[0]!;
    // 1.0 precedes the signal in path order. A copier cannot act on a signal
    // that has not happened yet.
    expect(row.entryPriceSol).not.toBe(1.0);
    expect(row.entryPriceSol).toBe(2.0);
  });

  it('still honours the delay when the wallet print is absent from the path', () => {
    const withoutWallet = [
      poolSwapAt(T0, 1.0, { signature: 'a' }),
      poolSwapAt(T0 + 5_000, 2.0, { signature: 'b' }),
      poolSwapAt(T0 + 20_000, 3.0, { signature: 'exit-print' }),
    ];
    const row = replayRoundTrip(trip, withoutWallet, [5], EXIT_UNDELAYED)[0]!;
    expect(row.entryPriceSol).toBe(2.0);
  });
});

describe('replayRoundTrip', () => {
  it('emits one row per delay', () => {
    const swaps = Array.from({ length: 300 }, (_, i) => poolSwapAt(T0 + i * 1_000, 1));
    const rows = replayRoundTrip(
      { token: MINT, signature: 'rt', signalTs: T0, exitTs: T0 + 200_000 },
      swaps,
      DEFAULT_DELAYS_S,
      EXIT_UNDELAYED,
    );
    expect(rows).toHaveLength(DEFAULT_DELAYS_S.length);
    expect(rows.map((r) => r.delayS)).toEqual([...DEFAULT_DELAYS_S]);
  });

  /**
   * An empty window is NO_DATA, not NO_FILL.
   *
   * The distinction is the whole lesson of run 1: ~70% of its rows were filed
   * as NO_FILL — read as "the token stopped trading" — when every one of them
   * was a window the signature walk had never reached. One is a market fact,
   * the other invalidates the bucket.
   */
  it('records NO_DATA when the window is empty, never NO_FILL', () => {
    const swaps = [poolSwapAt(T0 - 60_000, 1)];
    const rows = replayRoundTrip(
      { token: MINT, signature: 'rt', signalTs: T0, exitTs: T0 + 60_000 },
      swaps,
      DEFAULT_DELAYS_S,
      EXIT_UNDELAYED,
    );

    expect(rows.every((row) => row.fillStatus === 'NO_DATA')).toBe(true);
    expect(rows.every((row) => Number.isNaN(row.forwardReturn))).toBe(true);
    expect(rows.every((row) => row.nPoolSwapsInWindow === 0)).toBe(true);
  });

  /**
   * And the converse: a window that HAD swaps but offered no entry at the
   * delayed target is genuine illiquidity, and must not be excused as missing
   * data. Neither must be silently dropped — at long delays this is where the
   * worst outcomes live, so deleting them would flatten the curve being
   * measured.
   */
  it('separates NO_FILL from NO_DATA within one round trip', () => {
    const swaps = [poolSwapAt(T0, 1), poolSwapAt(T0 + 10_000, 1.5)];
    const rows = replayRoundTrip(
      { token: MINT, signature: 'rt', signalTs: T0, exitTs: T0 + 10_000 },
      swaps,
      DEFAULT_DELAYS_S,
      EXIT_UNDELAYED,
    );

    const byDelay = new Map(rows.map((row) => [row.delayS, row]));
    expect(byDelay.get(0)?.fillStatus).toBe('FILLED');
    // Past the wallet's exit, but the path was there — a real refusal.
    expect(byDelay.get(30)?.fillStatus).toBe('NO_FILL');
    expect(rows.some((row) => row.fillStatus === 'NO_DATA')).toBe(false);

    const stats = summarise(rows);
    const long = stats.find((row) => row.delayS === 30);
    expect(long?.noFillRate).toBe(1);
    expect(long?.noDataRate).toBe(0);
    // fillRate excludes NO_DATA from its denominator; here there is none.
    expect(long?.fillRate).toBe(0);
  });

  it('records NO_FILL for delays that land past the wallet exit only', () => {
    // Swaps exist up to +20s; the wallet exits at +20s. Delays beyond that
    // cannot fill, shorter ones can.
    const swaps = [
      poolSwapAt(T0, 1),
      poolSwapAt(T0 + 10_000, 1.5),
      poolSwapAt(T0 + 20_000, 2),
    ];
    const rows = replayRoundTrip(
      { token: MINT, signature: 'rt', signalTs: T0, exitTs: T0 + 20_000 },
      swaps,
      DEFAULT_DELAYS_S,
      EXIT_UNDELAYED,
    );

    const byDelay = new Map(rows.map((row) => [row.delayS, row]));
    expect(byDelay.get(0)?.fillStatus).toBe('FILLED');
    expect(byDelay.get(15)?.fillStatus).toBe('FILLED');
    expect(byDelay.get(30)?.fillStatus).toBe('NO_FILL');
    expect(byDelay.get(120)?.fillStatus).toBe('NO_FILL');
  });

  it('computes forward return against the swap nearest the wallet exit', () => {
    const swaps = [poolSwapAt(T0, 1), poolSwapAt(T0 + 60_000, 1.5)];
    const rows = replayRoundTrip(
      { token: MINT, signature: 'rt', signalTs: T0, exitTs: T0 + 60_000 },
      swaps,
      DEFAULT_DELAYS_S,
      EXIT_UNDELAYED,
    );
    const zero = rows.find((row) => row.delayS === 0);
    expect(zero?.entryPriceSol).toBe(1);
    expect(zero?.exitPriceSol).toBe(1.5);
    expect(zero?.forwardReturn).toBeCloseTo(0.5, 9);
  });
});

// ---------------------------------------------------------------------------
// The load-bearing test
// ---------------------------------------------------------------------------

/**
 * Two-point solve for a half-life on an exponential decay.
 *
 * TEST-ONLY. `src/calibration/` fits nothing; this exists to assert the emitted
 * dataset has the exponential shape it claims, and must not move into `src/`.
 * Given r(d) = r0 * 2^(-d/H), then H = (d2 - d1) / log2(r1 / r2).
 */
function halfLifeFrom(d1: number, r1: number, d2: number, r2: number): number {
  return (d2 - d1) / Math.log2(r1 / r2);
}

describe('synthetic exponential decay', () => {
  /**
   * A pool whose price rises toward a fixed exit, such that a copier entering
   * `d` seconds late captures a return decaying on a known half-life.
   *
   * Construction: exit price is fixed. Entry price at delay `d` is set so that
   * `exit/entry - 1 = r0 * 2^(-d/H)`. Recovering H from the emitted medians is
   * then a statement about the harness, not about the market.
   */
  const HALF_LIFE_S = 30;
  const R0 = 0.5;
  const EXIT_PRICE = 1;

  function decayPool(): PoolSwap[] {
    const swaps: PoolSwap[] = [];
    // One swap per second for four minutes, so every candidate delay has an
    // exact fill and the measurement is not confounded by fill availability.
    for (let d = 0; d <= 240; d += 1) {
      const targetReturn = R0 * 2 ** (-d / HALF_LIFE_S);
      swaps.push(poolSwapAt(T0 + d * 1_000, EXIT_PRICE / (1 + targetReturn)));
    }
    // The exit observation, at the wallet's exit time.
    swaps.push(poolSwapAt(T0 + 300_000, EXIT_PRICE, { signature: 'exit' }));
    return orderPoolSwaps(swaps);
  }

  it('recovers the known half-life to within 10%', () => {
    const rows = replayRoundTrip(
      { token: MINT, signature: 'rt', signalTs: T0, exitTs: T0 + 300_000 },
      decayPool(),
      DEFAULT_DELAYS_S,
      EXIT_UNDELAYED,
    );
    const stats = summarise(rows);

    // Every delay filled, so the curve is not distorted by missing points.
    expect(stats.every((row) => row.nFilled === 1)).toBe(true);

    const at = (delay: number): number =>
      stats.find((row) => row.delayS === delay)?.medianReturn ?? Number.NaN;

    // Solved across the widest pair with clean signal, 15s -> 120s.
    const recovered = halfLifeFrom(15, at(15), 120, at(120));
    expect(recovered).toBeGreaterThan(HALF_LIFE_S * 0.9);
    expect(recovered).toBeLessThan(HALF_LIFE_S * 1.1);

    // And the shorter pair agrees, which a spurious fit would not.
    const shortPair = halfLifeFrom(0, at(0), 30, at(30));
    expect(shortPair).toBeGreaterThan(HALF_LIFE_S * 0.9);
    expect(shortPair).toBeLessThan(HALF_LIFE_S * 1.1);
  });

  it('shows monotonic decay in the diagnostics table', () => {
    const rows = replayRoundTrip(
      { token: MINT, signature: 'rt', signalTs: T0, exitTs: T0 + 300_000 },
      decayPool(),
      DEFAULT_DELAYS_S,
      EXIT_UNDELAYED,
    );
    const medians = summarise(rows).map((row) => row.medianReturn);
    for (let i = 1; i < medians.length; i += 1) {
      expect(medians[i] as number).toBeLessThan(medians[i - 1] as number);
    }
  });
});

// ---------------------------------------------------------------------------
// Sanity checks
// ---------------------------------------------------------------------------

describe('sanity checks', () => {
  const swaps = [poolSwapAt(T0, 1), poolSwapAt(T0 + 60_000, 1.1)];
  const rows = replayRoundTrip(
    { token: MINT, signature: 'rt', signalTs: T0, exitTs: T0 + 60_000 },
    swaps,
    DEFAULT_DELAYS_S,
    EXIT_UNDELAYED,
  );

  it('passes delay-0 comparison when the reconstruction agrees with the wallet', () => {
    expect(checkDelayZeroMatchesRealised(summarise(rows), rows, () => 0.1).passed).toBe(true);
  });

  it('FAILS it when the reconstruction disagrees — the pool is wrong, not the alpha', () => {
    const check = checkDelayZeroMatchesRealised(summarise(rows), rows, () => 0.9);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain('gap');
  });

  /**
   * The regression. A run whose NO_FILL rate is high has two very different
   * populations, and NO_FILL is not random — it selects for illiquid windows,
   * which are the losing trades. Comparing the replay's filled subset against
   * the wallet's median over EVERYTHING therefore manufactures a failure.
   *
   * Measured on real data: 18.48pp and FAIL against all 120 sampled, 3.18pp and
   * PASS against the same 15 that filled.
   */
  it('compares only the trips that filled, not the whole sample', () => {
    // Two trips: one fills, one does not. The unfilled one is a huge winner for
    // the wallet — exactly the skew that broke the old check.
    const filling = replayRoundTrip(
      { token: MINT, signature: 'fills', signalTs: T0, exitTs: T0 + 60_000 },
      swaps,
      DEFAULT_DELAYS_S,
      EXIT_UNDELAYED,
    );
    const empty = replayRoundTrip(
      { token: MINT, signature: 'no-fill', signalTs: T0 + 10_000_000, exitTs: T0 + 10_060_000 },
      swaps,
      DEFAULT_DELAYS_S,
      EXIT_UNDELAYED,
    );
    const both = [...filling, ...empty];

    const walletReturnOf = (row: { signature: string }): number =>
      row.signature === 'fills' ? 0.1 : 5.0;

    const check = checkDelayZeroMatchesRealised(summarise(both), both, walletReturnOf);
    expect(check.passed).toBe(true);
    expect(check.detail).toContain('SAME 1 filled trip');
  });

  it('passes the empty-window check on a normal replay', () => {
    expect(checkFilledRowsHaveSwaps(rows).passed).toBe(true);
  });

  it('fails the empty-window check on a contradictory row', () => {
    const bad = rows.map((row) => ({ ...row, nPoolSwapsInWindow: 0 }));
    expect(checkFilledRowsHaveSwaps(bad).passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

function fakeRpc(pages: SignaturePage[], txs: Map<string, ParsedTransactionWithMeta>): {
  rpc: PoolRpc;
  sigCalls: () => number;
} {
  let sigCalls = 0;
  return {
    sigCalls: () => sigCalls,
    rpc: {
      async getSignaturesForAddress(_address, options) {
        sigCalls += 1;
        if (options.before === undefined) return pages.slice(0, options.limit);
        const index = pages.findIndex((p) => p.signature === options.before);
        return index === -1 ? [] : pages.slice(index + 1, index + 1 + options.limit);
      },
      async getTransaction(signature) {
        return txs.get(signature) ?? null;
      },
    },
  };
}

describe('determinism', () => {
  /**
   * The same cached window twice must produce byte-identical output. Anything
   * that varies — map iteration order, an unstable sort, a wall-clock read —
   * would make two runs of the harness disagree about the same history.
   */
  it('replaying a cached window twice yields byte-identical CSVs', async () => {
    const cacheDir = tempDir();

    // Deliberately shuffled, and with slot ties, so the ordering path is
    // exercised rather than accidentally satisfied by arrival order.
    const specs = [
      { sig: 'd', slot: 12, ts: T0 + 3_000, lamports: 1_300_000_000n },
      { sig: 'b', slot: 10, ts: T0 + 1_000, lamports: 1_100_000_000n },
      { sig: 'a', slot: 10, ts: T0 + 1_000, lamports: 1_050_000_000n },
      { sig: 'c', slot: 11, ts: T0 + 2_000, lamports: 1_200_000_000n },
    ];

    const pages: SignaturePage[] = specs.map((s) => ({
      signature: s.sig,
      slot: s.slot,
      err: null,
      blockTime: Math.floor(s.ts / 1_000),
    }));
    const txs = new Map(
      specs.map((s) => [
        s.sig,
        swapTx({
          signature: s.sig,
          slot: s.slot,
          blockTime: s.ts,
          lamports: s.lamports,
          tokens: 1_000_000n,
          takerBuys: true,
        }),
      ]),
    );

    const run = async (): Promise<string> => {
      const { rpc } = fakeRpc(pages, txs);
      const result = await getPoolSwaps(
        { mint: MINT, poolAccount: POOL, intervals: [{ fromTs: T0, toTs: T0 + 10_000 }] },
        { rpc, cacheDir, concurrency: 3 },
      );
      const rows = replayRoundTrip(
        { token: MINT, signature: 'rt', signalTs: T0, exitTs: T0 + 10_000 },
        result.swaps,
        DEFAULT_DELAYS_S,
        EXIT_UNDELAYED,
      );
      return delaysCsv(rows);
    };

    const first = await run();
    const second = await run();
    expect(second).toBe(first);
    expect(first.length).toBeGreaterThan(DELAYS_CSV_LENGTH_FLOOR);
  });

  it('writes a signature cache and reuses it without paging again', async () => {
    const cacheDir = tempDir();
    const pages: SignaturePage[] = [
      { signature: 'only', slot: 10, err: null, blockTime: Math.floor(T0 / 1_000) },
    ];
    const txs = new Map([
      [
        'only',
        swapTx({
          signature: 'only',
          slot: 10,
          blockTime: T0,
          lamports: 1_000_000_000n,
          tokens: 1_000_000n,
          takerBuys: true,
        }),
      ],
    ]);

    const cold = fakeRpc(pages, txs);
    const first = await getPoolSwaps(
      { mint: MINT, poolAccount: POOL, intervals: [{ fromTs: T0 - 1_000, toTs: T0 + 1_000 }] },
      { rpc: cold.rpc, cacheDir },
    );
    expect(first.fromCache).toBe(false);
    expect(cold.sigCalls()).toBeGreaterThan(0);
    expect(readCache(cacheDir, MINT)).toHaveLength(1);

    const warm = fakeRpc(pages, txs);
    const second = await getPoolSwaps(
      { mint: MINT, poolAccount: POOL, intervals: [{ fromTs: T0 - 1_000, toTs: T0 + 1_000 }] },
      { rpc: warm.rpc, cacheDir },
    );
    expect(second.fromCache).toBe(true);
    expect(warm.sigCalls()).toBe(0);
    expect(second.swaps.map((s) => s.signature)).toEqual(first.swaps.map((s) => s.signature));
  });

  it('does not write into the default cache directory during tests', () => {
    // A guard against a future edit dropping the injected cacheDir: the repo's
    // real cache must never be populated by a test run.
    expect(DEFAULT_CACHE_DIR).toBe('cache/pools');
  });
});

const DELAYS_CSV_LENGTH_FLOOR = 100;

// ---------------------------------------------------------------------------
// Part 4 — failure-rate adjustment
// ---------------------------------------------------------------------------

describe('failureAdjustment', () => {
  it('derives the multiplier from failures per success', () => {
    const adjustment = failureAdjustment('w', 2_314, 1_845);
    expect(adjustment.failureRate).toBeCloseTo(2_314 / (2_314 + 1_845), 9);
    expect(adjustment.priorityFeeMultiplier).toBeCloseTo(1 + 2_314 / 1_845, 9);
  });

  it('is 1.0 for a wallet that never fails — no adjustment, not a special case', () => {
    expect(failureAdjustment('w', 0, 100).priorityFeeMultiplier).toBe(1);
  });

  it('is infinite when nothing succeeded, rather than silently 1', () => {
    // A wallet with no successful round trips has no measurable cost basis. The
    // sizing layer must see that rather than a plausible-looking number.
    expect(failureAdjustment('w', 50, 0).priorityFeeMultiplier).toBe(Number.POSITIVE_INFINITY);
  });
});

// ---------------------------------------------------------------------------
// Interval union — the fix for a nine-minute stall
// ---------------------------------------------------------------------------

/**
 * A mint traded twice, days apart, must cost two narrow windows and not one
 * wide span. Expressed as `min(from)..max(to)` the gap between them is pulled
 * in too — which on a real pool was tens of thousands of `getTransaction` calls
 * and stalled a run indefinitely.
 */
describe('interval union', () => {
  it('fetches only inside the intervals, not across the gap between them', async () => {
    const cacheDir = tempDir();
    const DAY = 86_400_000;

    // Three swaps: one in each interval, one squarely in the gap.
    const specs = [
      { sig: 'early', ts: T0 },
      { sig: 'gap', ts: T0 + DAY },
      { sig: 'late', ts: T0 + 2 * DAY },
    ];
    const pages: SignaturePage[] = specs.map((s, i) => ({
      signature: s.sig,
      slot: 100 + i,
      err: null,
      blockTime: Math.floor(s.ts / 1_000),
    }));
    const txs = new Map(
      specs.map((s, i) => [
        s.sig,
        swapTx({
          signature: s.sig,
          slot: 100 + i,
          blockTime: s.ts,
          lamports: 1_000_000_000n,
          tokens: 1_000_000n,
          takerBuys: true,
        }),
      ]),
    );

    const fetched: string[] = [];
    const rpc: PoolRpc = {
      async getSignaturesForAddress(_a, options) {
        return options.before === undefined ? pages : [];
      },
      async getTransaction(signature) {
        fetched.push(signature);
        return txs.get(signature) ?? null;
      },
    };

    const result = await getPoolSwaps(
      {
        mint: MINT,
        poolAccount: POOL,
        intervals: [
          { fromTs: T0 - 1_000, toTs: T0 + 1_000 },
          { fromTs: T0 + 2 * DAY - 1_000, toTs: T0 + 2 * DAY + 1_000 },
        ],
      },
      { rpc, cacheDir },
    );

    expect(fetched.sort()).toEqual(['early', 'late']);
    expect(result.signaturesInWindow).toBe(2);
    expect(result.swaps.map((s) => s.signature)).toEqual(['early', 'late']);
  });

  it('reports fetchCapped rather than silently clipping', async () => {
    const cacheDir = tempDir();
    const specs = Array.from({ length: 10 }, (_, i) => ({ sig: `s${i}`, ts: T0 + i * 1_000 }));
    const pages: SignaturePage[] = specs.map((s, i) => ({
      signature: s.sig,
      slot: 200 + i,
      err: null,
      blockTime: Math.floor(s.ts / 1_000),
    }));
    const txs = new Map(
      specs.map((s, i) => [
        s.sig,
        swapTx({
          signature: s.sig,
          slot: 200 + i,
          blockTime: s.ts,
          lamports: 1_000_000_000n,
          tokens: 1_000_000n,
          takerBuys: true,
        }),
      ]),
    );

    const rpc: PoolRpc = {
      async getSignaturesForAddress(_a, options) {
        return options.before === undefined ? pages : [];
      },
      async getTransaction(signature) {
        return txs.get(signature) ?? null;
      },
    };

    const result = await getPoolSwaps(
      { mint: MINT, poolAccount: POOL, intervals: [{ fromTs: T0, toTs: T0 + 20_000 }] },
      { rpc, cacheDir, maxFetches: 4 },
    );

    expect(result.fetchCapped).toBe(true);
    expect(result.signaturesInWindow).toBe(10);
    expect(result.swaps).toHaveLength(4);
  });
});
