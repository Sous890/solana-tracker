/**
 * A hand-built session, and an honest statement of what that costs.
 *
 * No recorded sessions exist — this checkout has no credentials, so record mode
 * has never run against a live RPC. Everything the harness is exercised against
 * is built here.
 *
 * The one place that shows through is the slippage sweep. A synthetic session
 * can be generated knowing every position size the ladder will produce, so it
 * contains a quote at each of them and all four points replay. A real recording
 * contains the sizes that one run actually asked for and no others, so its
 * sweep will report the other points as unreplayable. That is a property of
 * recording, not a defect in the harness — see `sweepSlippage`.
 */

import { reduceByBpsFloor, WRAPPED_SOL_MINT, solToLamports } from '../../src/core/units.js';
import { encodeFloat, encodeSwap } from '../../src/services/recorder.js';
import type { SessionLine } from '../../src/services/recorder.js';
import type { TrackedSwap } from '../../src/core/types.js';

export const MINT_A = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
export const MINT_B = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
export const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

export const T0 = 1_700_000_000_000;
export const DECIMALS = 6;

/** What 0.05 SOL buys: 1000 whole tokens at 6 decimals. */
export const BUY_LAMPORTS = solToLamports(0.05);
export const BUY_OUT_TOKENS = 1_000_000_000n;

/**
 * Exit value per 1e9 tokens, chosen to sit just above the round-trip cost.
 *
 * 50,300,000 lamports against a 50,085,000 cost basis is a 130,000 lamport
 * profit at 0 bps and a loss by 30 bps. That is deliberate: it makes the
 * slippage sweep produce the verdict that actually matters — a strategy whose
 * edge is smaller than the guess it is being measured against.
 */
export const EXIT_PER_BILLION = 50_300_000n;

function exitOut(tokens: bigint): bigint {
  return (tokens * EXIT_PER_BILLION) / 1_000_000_000n;
}

function swapOf(overrides: Partial<TrackedSwap>): TrackedSwap {
  return {
    wallet: WALLET,
    mint: MINT_A,
    side: 'buy',
    solAmount: 410_000_000n,
    tokenAmount: BUY_OUT_TOKENS,
    decimals: DECIMALS,
    signature: 'sig',
    slot: 1,
    blockTime: Math.floor(T0 / 1_000),
    venue: 'pumpfun',
    feePayer: true,
    source: 'live',
    observedAt: T0,
    ...overrides,
  };
}

export interface SyntheticOptions {
  /** Position sizes the sweep will ask to exit at. */
  ladder?: readonly number[];
  /** Include a mint that loses its route while held. */
  includeNoRoute?: boolean;
}

/**
 * A session MirrorStrategy trades on: one round trip, plus optionally one
 * position that loses its route and is still held at the end.
 */
export function buildSyntheticSession(options: SyntheticOptions = {}): string {
  const ladder = options.ladder ?? [0, 30, 100, 250];
  const lines: SessionLine[] = [];
  let seq = 0;
  let clock = T0;

  const add = (kind: SessionLine['kind'], payload: unknown, advance = 1_000): void => {
    seq += 1;
    lines.push({ seq, simClockMs: clock, kind, payload });
    clock += advance;
  };

  // -- screens ---------------------------------------------------------------
  for (const mint of options.includeNoRoute === true ? [MINT_A, MINT_B] : [MINT_A]) {
    add('screen', {
      mint,
      sizeSol: 0.05,
      verdict: 'pass',
      failedChecks: [],
      unknownChecks: [],
    });
  }

  // -- entry quote, one size for every ladder point --------------------------
  add('quote', {
    request: {
      inMint: WRAPPED_SOL_MINT,
      outMint: MINT_A,
      inAmount: BUY_LAMPORTS.toString(),
      slippageBps: 300,
    },
    quote: {
      inAmount: BUY_LAMPORTS.toString(),
      outAmount: BUY_OUT_TOKENS.toString(),
      priceImpactPct: 0.1,
    },
  });

  // -- exit quotes, one per position size the ladder produces ----------------
  //
  // This is the generated-knowing-the-answer part. A real recording has the one
  // size its own run asked for.
  const sizes = new Set(ladder.map((bps) => reduceByBpsFloor(BUY_OUT_TOKENS, bps)));
  for (const tokens of [...sizes].sort((a, b) => (a < b ? -1 : 1))) {
    add('quote', {
      request: {
        inMint: MINT_A,
        outMint: WRAPPED_SOL_MINT,
        inAmount: tokens.toString(),
        slippageBps: 300,
      },
      quote: {
        inAmount: tokens.toString(),
        outAmount: exitOut(tokens).toString(),
        priceImpactPct: 0.1,
      },
    });
  }

  if (options.includeNoRoute === true) {
    add('quote', {
      request: {
        inMint: WRAPPED_SOL_MINT,
        outMint: MINT_B,
        inAmount: BUY_LAMPORTS.toString(),
        slippageBps: 300,
      },
      quote: {
        inAmount: BUY_LAMPORTS.toString(),
        outAmount: BUY_OUT_TOKENS.toString(),
        priceImpactPct: 0.1,
      },
    });
    // Every size the ladder can leave held, all unroutable.
    for (const tokens of [...sizes].sort((a, b) => (a < b ? -1 : 1))) {
      add('quote', {
        request: {
          inMint: MINT_B,
          outMint: WRAPPED_SOL_MINT,
          inAmount: tokens.toString(),
          slippageBps: 300,
        },
        error: { error: 'NO_ROUTE', message: 'TOKEN_NOT_TRADABLE' },
      });
    }
  }

  // -- the run ---------------------------------------------------------------

  add('swap', encodeSwap(swapOf({ side: 'buy', signature: 'buy-a' })));

  if (options.includeNoRoute === true) {
    add('swap', encodeSwap(swapOf({ side: 'buy', mint: MINT_B, signature: 'buy-b' })));
  }

  // A tick inside the band: entry is ~0.000050085 SOL/token, this is +0.8%.
  add('price-tick', {
    mint: MINT_A,
    priceSol: encodeFloat(0.0000505),
    tokens: BUY_OUT_TOKENS.toString(),
    decimals: DECIMALS,
  });

  if (options.includeNoRoute === true) {
    // Reached while MINT_B has no route out. The harness records it and holds.
    add('price-tick', {
      mint: MINT_B,
      priceSol: encodeFloat(0.0000505),
      tokens: BUY_OUT_TOKENS.toString(),
      decimals: DECIMALS,
    });
  }

  // The tracked wallet exits; the mirror follows.
  add('swap', encodeSwap(swapOf({ side: 'sell', signature: 'sell-a', solAmount: 123_000_000n })));

  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

/**
 * The 2026-08-03 oversell, as the ledger recorded it.
 *
 * Not a session — sessions hold inputs, and this is the output the defect
 * produced. It is the fill sequence that was on disk that day: a 1,000,000,000
 * unit position, then a sell of a thousand times that, which filled.
 */
export const OVERSELL_FILLS = [
  {
    seq: 1,
    intentId: 'seed',
    mint: MINT_A,
    tokensDelta: 1_000_000_000n,
    lamportsDelta: -50_000_000n,
  },
  {
    seq: 2,
    intentId: 'garbage',
    mint: MINT_A,
    // What the fill row actually said. The position still read zero, because
    // `replayMint` clamps `sold` to what was held — which is exactly why this
    // survived a whole prompt undetected.
    tokensDelta: -999_999_999_999n,
    lamportsDelta: 997_000_000n,
  },
] as const;
