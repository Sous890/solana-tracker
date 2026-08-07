import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WSOL_MINT,
  accountKeyList,
  isInfrastructureOnly,
  parseSwap,
  programsInvoked,
  tokenDeltasForOwner,
  venuesPresent,
} from '../src/adapters/swapParser.js';
import type { ParsedTransactionWithMeta } from '../src/adapters/swapParser.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL = resolve(HERE, 'fixtures/transactions');
const SYNTH = resolve(HERE, 'fixtures/synthetic');

interface Capture {
  signature: string;
  wallet?: string;
  expected?: Record<string, unknown>;
  tx: ParsedTransactionWithMeta;
}

const real = (name: string): Capture =>
  JSON.parse(readFileSync(join(REAL, `${name}.json`), 'utf8')) as Capture;
const synth = (name: string): Capture =>
  JSON.parse(readFileSync(join(SYNTH, `${name}.json`), 'utf8')) as Capture;

/**
 * Expectations computed by an independent Python decode of the same fixtures
 * (see the recorder), not by this parser. Pinning to these means a shared bug
 * cannot make the tests agree with the code.
 */
const EXPECTED = JSON.parse(readFileSync(join(REAL, 'EXPECTED.json'), 'utf8')) as Record<
  string,
  {
    wallet?: string;
    side?: 'buy' | 'sell';
    mint?: string;
    tokenAmount?: string;
    decimals?: number;
    solAmount?: string;
    path?: string;
    venue?: string;
    feePayer?: boolean;
    slot?: number;
    reason?: string;
  }
>;

// ---------------------------------------------------------------------------
// (a) Every recorded fixture parses to pinned literal values
// ---------------------------------------------------------------------------

describe('recorded transactions', () => {
  const swapFixtures = Object.entries(EXPECTED).filter(([, e]) => e.reason === undefined);

  it('covers all five venues plus the hard cases', () => {
    const names = readdirSync(REAL).filter((f) => f.endsWith('.json') && f !== 'EXPECTED.json');
    for (const required of [
      'raydium-v4-buy',
      'raydium-clmm-buy',
      'pumpfun-sell',
      'whirlpool-buy',
      'meteora-dlmm-buy',
      'failed-swap',
      'wallet-key-from-lookup-table',
      'lookup-table-json-encoding',
    ]) {
      expect(names).toContain(`${required}.json`);
    }
  });

  it.each(swapFixtures)('%s parses to the independently-decoded values', (name, expected) => {
    const capture = real(name);
    const result = parseSwap(capture.tx, expected.wallet as string);

    expect(result.kind).toBe('swap');
    if (result.kind !== 'swap') return;

    expect(result.swap.side).toBe(expected.side);
    expect(result.swap.mint).toBe(expected.mint);
    expect(result.swap.tokenAmount).toBe(BigInt(expected.tokenAmount as string));
    expect(result.swap.decimals).toBe(expected.decimals);
    expect(result.swap.solAmount).toBe(BigInt(expected.solAmount as string));
    expect(result.swap.venue).toBe(expected.venue);
    expect(result.swap.feePayer).toBe(expected.feePayer);
    expect(result.swap.slot).toBe(expected.slot);
    expect(result.swap.signature).toBe(capture.signature);
  });

  // (b) — asserted per fixture so a silent fallback fails the test.
  it.each(swapFixtures)('%s uses the expected solAmount path', (name, expected) => {
    const capture = real(name);
    const result = parseSwap(capture.tx, expected.wallet as string);
    if (result.kind !== 'swap') throw new Error('expected a swap');
    expect(result.solAmountPath).toBe(expected.path);
  });

  it('reports no path disagreement on any recorded fixture', () => {
    for (const [name, expected] of swapFixtures) {
      const result = parseSwap(real(name).tx, expected.wallet as string);
      if (result.kind !== 'swap') continue;
      expect(result.pathDisagreement, name).toBeUndefined();
    }
  });

  it('derives the meteora buy through the rent-refund correction', () => {
    // Raw lamport delta is +2,033,621 because closing the WSOL account
    // refunded rent. Uncorrected this reads as a 2 SOL *receipt* on a buy.
    const capture = real('meteora-dlmm-buy');
    const meta = capture.tx.meta!;
    const keys = accountKeyList(capture.tx)!;
    const index = keys.indexOf(capture.wallet as string);
    const raw = meta.postBalances[index]! - meta.preBalances[index]!;
    expect(raw).toBe(2_033_621);

    const result = parseSwap(capture.tx, capture.wallet as string);
    if (result.kind !== 'swap') throw new Error('expected a swap');
    expect(result.swap.side).toBe('buy');
    expect(result.swap.solAmount).toBe(657n);
  });
});

// ---------------------------------------------------------------------------
// (c) Versioned transactions and the loaded-address key list
// ---------------------------------------------------------------------------

describe('versioned transactions', () => {
  it('merges loadedAddresses under encoding=json', () => {
    const capture = real('lookup-table-json-encoding');
    const meta = capture.tx.meta!;
    const statics = capture.tx.transaction.message.accountKeys;

    // Only the static keys are in accountKeys under this encoding.
    expect(statics).toHaveLength(7);
    expect(meta.loadedAddresses!.writable.length + meta.loadedAddresses!.readonly.length).toBe(50);

    const keys = accountKeyList(capture.tx);
    expect(keys).toHaveLength(57);
    expect(keys).toHaveLength(meta.preBalances.length);
  });

  it('parses the json-encoded fixture to the same values as the jsonParsed one', () => {
    const asJson = parseSwap(real('lookup-table-json-encoding').tx, real('lookup-table-json-encoding').wallet as string);
    const asParsed = parseSwap(real('wallet-key-from-lookup-table').tx, real('wallet-key-from-lookup-table').wallet as string);

    expect(asJson.kind).toBe('swap');
    expect(asParsed.kind).toBe('swap');
    if (asJson.kind !== 'swap' || asParsed.kind !== 'swap') return;
    expect(asJson.swap.mint).toBe(asParsed.swap.mint);
    expect(asJson.swap.tokenAmount).toBe(asParsed.swap.tokenAmount);
    expect(asJson.swap.solAmount).toBe(asParsed.swap.solAmount);
    expect(asJson.swap.side).toBe(asParsed.swap.side);
  });

  it('FAILS with WALLET_NOT_IN_TX when loadedAddresses is stripped', () => {
    const capture = real('lookup-table-json-encoding');
    const stripped = structuredClone(capture.tx);
    stripped.meta!.loadedAddresses = { writable: [], readonly: [] };

    const result = parseSwap(stripped, capture.wallet as string);
    // 7 keys against 57 balances: the mismatch is caught rather than silently
    // attributing balances to the wrong accounts.
    expect(result.kind).toBe('unparsed');
    if (result.kind !== 'unparsed') return;
    expect(result.reason).toBe('WALLET_NOT_IN_TX');
  });

  it('does not double-count under jsonParsed, where the RPC already merged them', () => {
    const capture = real('wallet-key-from-lookup-table');
    const keys = accountKeyList(capture.tx)!;
    expect(keys).toHaveLength(capture.tx.meta!.preBalances.length);
    // The tracked address sits in the lookup-table portion.
    expect(keys.indexOf(capture.wallet as string)).toBeGreaterThan(6);
  });
});

// ---------------------------------------------------------------------------
// (d) (e) Unparsed cases
// ---------------------------------------------------------------------------

describe('unparsed', () => {
  it('(e) a failed transaction is TX_FAILED, not NO_MINT_DELTA', () => {
    const capture = real('failed-swap');
    const keys = accountKeyList(capture.tx)!;
    const result = parseSwap(capture.tx, keys[0]!);

    expect(result.kind).toBe('unparsed');
    if (result.kind !== 'unparsed') return;
    expect(result.reason).toBe('TX_FAILED');
    expect(result.reason).not.toBe('NO_MINT_DELTA');
  });

  it('(e) the failed transaction really does have zero deltas', () => {
    // Which is why order matters: checked after the err guard it would look
    // like an ordinary no-op.
    const capture = real('failed-swap');
    const keys = accountKeyList(capture.tx)!;
    const deltas = tokenDeltasForOwner(capture.tx.meta!, keys[0]!);
    for (const [, value] of deltas) expect(value.delta).toBe(0n);
  });

  it('(d) two moved mints yield MULTI_MINT_DELTA and never a swap', () => {
    const capture = synth('multi-mint-delta');
    const result = parseSwap(capture.tx, capture.wallet as string);

    expect(result.kind).toBe('unparsed');
    if (result.kind !== 'unparsed') return;
    expect(result.reason).toBe('MULTI_MINT_DELTA');
  });

  it('(d) no moved mint yields NO_MINT_DELTA', () => {
    const capture = real('raydium-v4-buy');
    const stripped = structuredClone(capture.tx);
    stripped.meta!.preTokenBalances = [];
    stripped.meta!.postTokenBalances = [];

    const result = parseSwap(stripped, capture.wallet as string);
    expect(result.kind).toBe('unparsed');
    if (result.kind !== 'unparsed') return;
    expect(result.reason).toBe('NO_MINT_DELTA');
  });

  it('a wallet absent from the transaction yields WALLET_NOT_IN_TX', () => {
    const capture = real('raydium-v4-buy');
    const result = parseSwap(capture.tx, 'NotAParticipant1111111111111111111111111111');
    expect(result.kind).toBe('unparsed');
    if (result.kind !== 'unparsed') return;
    expect(result.reason).toBe('WALLET_NOT_IN_TX');
  });

  it('a swap with no recoverable SOL leg yields NO_SOL_LEG', () => {
    const capture = real('raydium-v4-buy');
    const tx = structuredClone(capture.tx);
    // Flatten the lamport movement and leave no WSOL account.
    tx.meta!.postBalances = [...tx.meta!.preBalances];
    tx.meta!.fee = 0;

    const result = parseSwap(tx, capture.wallet as string);
    expect(result.kind).toBe('unparsed');
    if (result.kind !== 'unparsed') return;
    expect(result.reason).toBe('NO_SOL_LEG');
  });
});

// ---------------------------------------------------------------------------
// (f) Summing across accounts
// ---------------------------------------------------------------------------

describe('summing across token accounts', () => {
  it('sums one mint held in two accounts, where largest-only would be wrong', () => {
    const capture = synth('split-token-accounts') as Capture & {
      largestAccountOnlyWouldGive: string;
    };
    const result = parseSwap(capture.tx, capture.wallet as string);

    expect(result.kind).toBe('swap');
    if (result.kind !== 'swap') return;

    const total = BigInt(capture.expected!['tokenAmount'] as string);
    expect(result.swap.tokenAmount).toBe(total);

    // The point of the invariant: reading only the biggest account is wrong.
    const largest = BigInt(capture.largestAccountOnlyWouldGive);
    expect(largest).not.toBe(total);
    expect(result.swap.tokenAmount).not.toBe(largest);
  });

  it('counts both accounts in the delta map', () => {
    const capture = synth('split-token-accounts');
    const deltas = tokenDeltasForOwner(capture.tx.meta!, capture.wallet as string);
    const mint = capture.expected!['mint'] as string;
    expect(deltas.get(mint)?.delta).toBe(BigInt(capture.expected!['tokenAmount'] as string));
  });
});

// ---------------------------------------------------------------------------
// (b) Cross-path agreement
// ---------------------------------------------------------------------------

describe('solAmount paths', () => {
  it('agrees within 0.5% when both are computable', () => {
    const capture = synth('both-sol-paths-agree');
    const result = parseSwap(capture.tx, capture.wallet as string);
    if (result.kind !== 'swap') throw new Error('expected a swap');

    expect(result.solAmountPath).toBe('wsol-token-delta');
    expect(result.pathDisagreement).toBeUndefined();
    expect(result.swap.solAmount).toBe(503_500_047n);
  });

  it('flags a disagreement beyond 0.5% and still prefers path 1', () => {
    const capture = synth('both-sol-paths-disagree');
    const result = parseSwap(capture.tx, capture.wallet as string);
    if (result.kind !== 'swap') throw new Error('expected a swap');

    expect(result.solAmountPath).toBe('wsol-token-delta');
    expect(result.pathDisagreement).toBeDefined();
    expect(result.pathDisagreement!.relative).toBeGreaterThan(0.005);
    // Path 1 wins, but the gap is on the record rather than swallowed.
    expect(result.swap.solAmount).toBe(400_000_000n);
  });

  it('keeps both paths on the same sign convention', () => {
    // A buy spends SOL, so both paths must be negative before the magnitude
    // is taken. Negating path 1 would make this a 200% disagreement.
    const capture = synth('both-sol-paths-agree');
    const deltas = tokenDeltasForOwner(capture.tx.meta!, capture.wallet as string);
    expect(deltas.get(WSOL_MINT)!.delta).toBeLessThan(0n);

    const result = parseSwap(capture.tx, capture.wallet as string);
    if (result.kind !== 'swap') throw new Error('expected a swap');
    expect(result.swap.side).toBe('buy');
    expect(result.pathDisagreement).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Venue
// ---------------------------------------------------------------------------

describe('venue', () => {
  it('identifies each recorded venue', () => {
    for (const [name, expected] of Object.entries(EXPECTED)) {
      if (expected.reason !== undefined) continue;
      const result = parseSwap(real(name).tx, expected.wallet as string);
      if (result.kind !== 'swap') continue;
      expect(result.swap.venue, name).toBe(expected.venue);
    }
  });

  it('does not gate parsing — an unknown program still emits a swap', () => {
    const capture = real('raydium-v4-buy');
    const tx = structuredClone(capture.tx);
    // Replace every venue program with an unrecognised one.
    tx.transaction.message.accountKeys = tx.transaction.message.accountKeys.map((key) => {
      const pubkey = typeof key === 'string' ? key : key.pubkey;
      const replaced = pubkey === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'
        ? 'UnknownDex111111111111111111111111111111111'
        : pubkey;
      return typeof key === 'string' ? replaced : { ...key, pubkey: replaced };
    });

    const result = parseSwap(tx, capture.wallet as string);
    expect(result.kind).toBe('swap');
    if (result.kind !== 'swap') return;
    expect(result.swap.venue).toBe('unknown');
    expect(result.swap.tokenAmount).toBeGreaterThan(0n);
  });

  it('takes the first venue by key order when several are present', () => {
    const keys = [
      'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
      '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    ];
    // VENUE_PROGRAMS order decides, not the order in the key list.
    expect(venuesPresent(keys)).toEqual(['raydium-v4', 'whirlpool']);
  });
});

// ---------------------------------------------------------------------------
// The fee correction applies only to the fee payer
// ---------------------------------------------------------------------------

describe('fee attribution', () => {
  it('does not apply meta.fee to a wallet that did not pay it', () => {
    const capture = synth('non-fee-payer-lamport-path');
    const result = parseSwap(capture.tx, capture.wallet as string);

    expect(result.kind).toBe('swap');
    if (result.kind !== 'swap') return;

    expect(result.swap.feePayer).toBe(false);
    expect(result.solAmountPath).toBe('lamport-delta');
    // Exactly the swap spend, with the rent for the created token account
    // corrected out and the fee — paid by someone else — left alone.
    expect(result.swap.solAmount).toBe(250_000_000n);
    // Applying the fee unconditionally would give this.
    expect(result.swap.solAmount).not.toBe(249_995_000n);
    // Ignoring the created-account rent would give this.
    expect(result.swap.solAmount).not.toBe(252_039_280n);
  });

  it('does apply meta.fee when the tracked wallet is the fee payer', () => {
    // raydium-v4-buy: fee payer, lamport path. Its pinned solAmount already
    // includes the correction; assert the raw delta differs by exactly the fee.
    const capture = real('raydium-v4-buy');
    const meta = capture.tx.meta!;
    const keys = accountKeyList(capture.tx)!;
    const index = keys.indexOf(capture.wallet as string);
    const raw = BigInt(meta.postBalances[index]!) - BigInt(meta.preBalances[index]!);

    const result = parseSwap(capture.tx, capture.wallet as string);
    if (result.kind !== 'swap') throw new Error('expected a swap');
    expect(result.swap.solAmount).toBe(-(raw + BigInt(meta.fee)));
  });
});

// ---------------------------------------------------------------------------
// Multi-mint must never be resolved by guessing
// ---------------------------------------------------------------------------

describe('multi-mint is refused, not resolved', () => {
  /** Add `count` extra non-WSOL mint deltas for the tracked wallet. */
  function withExtraMints(count: number, amounts: bigint[]): Capture {
    const capture = structuredClone(real('raydium-v4-buy'));
    const post = capture.tx.meta!.postTokenBalances!;
    const template = post.find((b) => b.owner === capture.wallet)!;
    for (let i = 0; i < count; i += 1) {
      const extra = structuredClone(template);
      extra.accountIndex = 950 + i;
      extra.mint = `ExtraMint${i}111111111111111111111111111111`;
      extra.uiTokenAmount.amount = String(amounts[i]);
      post.push(extra);
    }
    return capture;
  }

  it('refuses two mints even when one delta dwarfs the other', () => {
    // The real mint moves 460_106_833_473. This one moves far more, so
    // "pick the largest" would confidently return the wrong mint.
    const capture = withExtraMints(1, [999_999_999_999_999n]);
    const result = parseSwap(capture.tx, capture.wallet as string);

    expect(result.kind).toBe('unparsed');
    if (result.kind !== 'unparsed') return;
    expect(result.reason).toBe('MULTI_MINT_DELTA');
    expect(result.detail).toContain('ExtraMint0');
  });

  it('refuses two mints when the real one is the largest', () => {
    // Symmetric: picking the largest would land on the right mint here, which
    // is exactly why the ordering must not decide anything.
    const capture = withExtraMints(1, [1n]);
    const result = parseSwap(capture.tx, capture.wallet as string);
    expect(result.kind).toBe('unparsed');
    if (result.kind !== 'unparsed') return;
    expect(result.reason).toBe('MULTI_MINT_DELTA');
  });

  it('refuses three mints', () => {
    const capture = withExtraMints(2, [5n, 7n]);
    const result = parseSwap(capture.tx, capture.wallet as string);
    expect(result.kind).toBe('unparsed');
    if (result.kind !== 'unparsed') return;
    expect(result.reason).toBe('MULTI_MINT_DELTA');
  });
});

// ---------------------------------------------------------------------------
// Signal provenance stamping
// ---------------------------------------------------------------------------

/**
 * `parseSwap` has no clock and no idea how a transaction reached the process.
 * Both are properties of the fetch, which belongs to `WalletStream` — keeping
 * them out of here is what lets the replay harness re-derive a swap from a
 * recorded transaction and get an identical result.
 */
describe('stamping', () => {
  const capture = real('meteora-dlmm-buy');

  it('defaults fail-closed when no stamp is supplied', () => {
    const result = parseSwap(capture.tx, capture.wallet as string);
    expect(result.kind).toBe('swap');
    if (result.kind !== 'swap') return;

    // An unstamped swap reads as an old gap-fill entry rather than as fresh
    // live signal. A caller that forgets to stamp therefore loses trades; the
    // opposite default would silently buy on a twenty-minute backlog.
    expect(result.swap.source).toBe('gapfill');
    expect(result.swap.observedAt).toBe(0);
  });

  it('carries the stamp through when supplied', () => {
    const result = parseSwap(capture.tx, capture.wallet as string, {
      source: 'live',
      observedAt: 1_700_000_000_000,
    });
    expect(result.kind).toBe('swap');
    if (result.kind !== 'swap') return;

    expect(result.swap.source).toBe('live');
    expect(result.swap.observedAt).toBe(1_700_000_000_000);
  });

  it('stays pure — the stamp changes nothing else about the parse', () => {
    const bare = parseSwap(capture.tx, capture.wallet as string);
    const stamped = parseSwap(capture.tx, capture.wallet as string, {
      source: 'live',
      observedAt: 1_700_000_000_000,
    });
    expect(bare.kind).toBe('swap');
    expect(stamped.kind).toBe('swap');
    if (bare.kind !== 'swap' || stamped.kind !== 'swap') return;

    const { source: _s1, observedAt: _o1, ...bareRest } = bare.swap;
    const { source: _s2, observedAt: _o2, ...stampedRest } = stamped.swap;
    expect(stampedRest).toEqual(bareRest);
  });
});

// ---------------------------------------------------------------------------
// Token movement that is not a trade
// ---------------------------------------------------------------------------

/**
 * 271 transactions across the corpus — 5.3-5.6% of everything this parser called
 * a swap — had a SOL leg of exactly `SPL_TOKEN_ACCOUNT_RENT_LAMPORTS`, split
 * 138 buys to 133 sells. Session 24 fetched six of them and they are not trades:
 * every program that ran was ATA, token or system, and the balance evidence is
 * worse than "mislabelled".
 *
 * On the buy side the tracked wallet's own lamport delta was **zero** — the rent
 * was paid by whoever sent the tokens. On the sell side it was **-2,245,780**,
 * so the parser recorded 2,039,280 lamports arriving while the wallet was
 * paying that much out. The SOL direction was inverted, not merely spurious.
 *
 * `mirror.ts` sizes from `positionSizeSol` and not from the observed swap, so a
 * 0.002 SOL token transfer and a 5 SOL buy produced the same 0.05 SOL entry.
 */
describe('infrastructure-only transactions', () => {
  it('refuses a real ATA-create-and-transfer, with a countable reason', () => {
    const capture = real('ata-transfer-buy-side');
    const result = parseSwap(capture.tx, capture.wallet!, {
      source: 'gapfill',
      observedAt: 0,
    });

    expect(result.kind).toBe('unparsed');
    expect((result as { reason: string }).reason).toBe('INFRASTRUCTURE_ONLY');
  });

  it('identifies the programs that actually ran, not the account keys', () => {
    const capture = real('ata-transfer-buy-side');
    const keys = accountKeyList(capture.tx)!;
    const programs = programsInvoked(capture.tx, keys);

    expect(programs.size).toBeGreaterThan(0);
    // Every one is infrastructure — which is the whole claim.
    expect(isInfrastructureOnly(programs)).toBe(true);
    // And strictly fewer than the key list, because most keys are not programs.
    expect(programs.size).toBeLessThan(keys.length);
  });

  /**
   * The guard that matters more than the filter. A predicate that quietly ate
   * real trades would be worse than the problem it was added for.
   */
  it('still parses every real venue capture as a swap', () => {
    const venueCaptures = [
      'raydium-v4-buy',
      'raydium-clmm-buy',
      'pumpfun-sell',
      'meteora-dlmm-buy',
      'whirlpool-buy',
    ] as const;

    for (const name of venueCaptures) {
      const capture = real(name);
      const result = parseSwap(capture.tx, capture.wallet!, {
        source: 'gapfill',
        observedAt: 0,
      });
      expect(result.kind, `${name} must still parse as a swap`).toBe('swap');
    }
  });

  it('fails OPEN when the encoding does not say what ran', () => {
    // No instructions at all: the parser cannot tell, and a discarded real trade
    // is silent while an admitted transfer is counted. So it must not filter.
    expect(isInfrastructureOnly(new Set())).toBe(false);
  });

  it('does not filter when a venue program ran alongside infrastructure', () => {
    const mixed = new Set([
      '11111111111111111111111111111111',
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    ]);
    expect(isInfrastructureOnly(mixed)).toBe(false);
  });

  /**
   * An unknown DEX must survive. This is the shape handoff 20 got wrong by
   * blaming unrecognised program ids, and the reason this is a denylist.
   */
  it('does not filter an unrecognised venue program', () => {
    const unknownDex = new Set([
      '11111111111111111111111111111111',
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      'SomeDexNobodyHasAddedYet111111111111111111',
    ]);
    expect(isInfrastructureOnly(unknownDex)).toBe(false);
  });
});
