import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/core/config.js';
import { guarded } from '../src/core/guards.js';
import type { GuardDeps, GuardLogFields } from '../src/core/guards.js';
import type { QuoteError, QuoteRequest, QuoteSource } from '../src/core/quoteSource.js';
import type { Quote } from '../src/core/types.js';
import { WRAPPED_SOL_MINT, solToLamports } from '../src/core/units.js';
import {
  MAX_CONCURRENT_SCREENS,
  SafetyScreener,
  TOKEN_2022_PROGRAM_ID,
  authorityIsLive,
  canSellFromScreener,
  governingTransferFee,
  retentionBps,
} from '../src/adapters/safety.js';
import type {
  DexPair,
  ParsedMintAccount,
  SafetyDeps,
  SignatureRef,
} from '../src/adapters/safety.js';
import { createPaperBroker } from '../src/adapters/paperBroker.js';
import { createDecimalsResolver, fixtureDecimalsSource } from '../src/adapters/mintMetadata.js';
import { openLedger } from '../src/db/ledger.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MINTS = resolve(HERE, 'fixtures/mints');

const load = (name: string): any =>
  JSON.parse(readFileSync(join(MINTS, `${name}.json`), 'utf8'));

/** Independently decoded by a Python TLV parser; see the handoff. */
const EXPECTED = load('EXPECTED') as Record<string, any>;

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const NOW = 1_700_000_000_000;

function accountOf(fixture: string): ParsedMintAccount {
  return load(fixture).jsonParsed.value as ParsedMintAccount;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  account?: ParsedMintAccount | null;
  accountError?: string;
  epoch?: number;
  signatures?: SignatureRef[] | (() => SignatureRef[]);
  signaturesError?: string;
  pairs?: DexPair[] | null;
  pairsError?: string;
  forward?: bigint | QuoteError;
  reverse?: bigint | QuoteError;
  minLiquidityUsd?: number;
  quoteImpactPct?: number;
}

function quoteOf(request: QuoteRequest, out: bigint, impact: number): Quote {
  return {
    inMint: request.inMint,
    outMint: request.outMint,
    inAmount: request.inAmount,
    outAmount: out,
    priceImpactPct: impact,
    routePlan: [],
    fetchedAt: NOW,
  };
}

function harness(options: HarnessOptions = {}) {
  const calls = { account: 0, signatures: 0, pairs: 0, quotes: 0 };

  const quotes: QuoteSource = {
    getQuote: async (request) => {
      calls.quotes += 1;
      const forwardLeg = request.inMint === WRAPPED_SOL_MINT;
      const value = forwardLeg ? (options.forward ?? 1_000_000_000n) : (options.reverse ?? 45_000_000n);
      if (typeof value !== 'bigint') return value;
      return quoteOf(request, value, options.quoteImpactPct ?? 0.5);
    },
  };

  const deps: SafetyDeps = {
    rpc: {
      getParsedMintAccount: async () => {
        calls.account += 1;
        if (options.accountError !== undefined) throw new Error(options.accountError);
        return options.account === undefined ? accountOf('clean-spl-bonk') : options.account;
      },
      getSignaturesForAddress: async () => {
        calls.signatures += 1;
        if (options.signaturesError !== undefined) throw new Error(options.signaturesError);
        const sigs = options.signatures ?? [
          { signature: 'oldest', blockTime: Math.floor(NOW / 1_000) - 3_600 },
        ];
        return typeof sigs === 'function' ? sigs() : sigs;
      },
      getEpoch: async () => options.epoch ?? 1_011,
    },
    quotes,
    dexscreener: {
      getPairs: async () => {
        calls.pairs += 1;
        if (options.pairsError !== undefined) throw new Error(options.pairsError);
        return options.pairs === undefined
          ? [{ liquidity: { usd: 50_000 }, quoteToken: { address: WRAPPED_SOL_MINT } }]
          : options.pairs;
      },
    },
    minLiquidityUsd: options.minLiquidityUsd ?? 15_000,
    now: () => NOW,
    sleep: async () => undefined,
  };

  return { screener: new SafetyScreener(deps), calls, deps };
}

const SIZE = { sizeSol: 0.05 };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('authorityIsLive', () => {
  it('treats an explicit null as revoked', () => {
    expect(authorityIsLive(null)).toBe(false);
  });

  it('treats an absent key as revoked', () => {
    expect(authorityIsLive(undefined)).toBe(false);
  });

  it('treats the STRING "null" as revoked, which truthiness would not', () => {
    // The failure direction that matters: a truthy "null" would read as a live
    // authority... but the inverse sentinel would read as clean. Explicit.
    expect(authorityIsLive('null')).toBe(false);
  });

  it('treats an empty string as revoked', () => {
    expect(authorityIsLive('')).toBe(false);
  });

  it('treats a real pubkey as live', () => {
    expect(authorityIsLive('BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG')).toBe(true);
  });

  it.each([[{}], [[]], [42], [true]])(
    'treats an unexpected shape (%s) as LIVE, refusing rather than admitting',
    (value) => {
      // Fail-safe direction. Reading an unrecognised RPC shape as "revoked"
      // would admit a mint whose supply can still be inflated.
      expect(authorityIsLive(value)).toBe(true);
    },
  );
});

describe('governingTransferFee', () => {
  const older = { epoch: 100, transferFeeBasisPoints: 10 };
  const newer = { epoch: 200, transferFeeBasisPoints: 9_000 };

  it('uses newer when currentEpoch >= newer.epoch (the source rule)', () => {
    const { governing, scheduled } = governingTransferFee(
      { olderTransferFee: older, newerTransferFee: newer },
      200,
    );
    expect(governing).toBe(newer);
    expect(scheduled).toBeUndefined();
  });

  it('uses older when currentEpoch < newer.epoch, and reports the scheduled one', () => {
    const { governing, scheduled } = governingTransferFee(
      { olderTransferFee: older, newerTransferFee: newer },
      199,
    );
    // This is the trap: the token reads clean today at 10 bps...
    expect(governing).toBe(older);
    // ...while a 90% fee is already scheduled.
    expect(scheduled).toBe(newer);
  });

  it('is exact at the boundary epoch', () => {
    expect(governingTransferFee({ olderTransferFee: older, newerTransferFee: newer }, 200).governing)
      .toBe(newer);
    expect(governingTransferFee({ olderTransferFee: older, newerTransferFee: newer }, 201).governing)
      .toBe(newer);
  });
});

describe('retentionBps', () => {
  it('computes from exact integers', () => {
    expect(retentionBps(45_000_000n, 45_000_000n)).toBe(10_000);
    expect(retentionBps(44_550_000n, 45_000_000n)).toBe(9_900);
    expect(retentionBps(0n, 45_000_000n)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fixture cross-check
// ---------------------------------------------------------------------------

describe('recorded mint fixtures', () => {
  it('jsonParsed agrees with the independent TLV decode', () => {
    for (const [name, expected] of Object.entries(EXPECTED)) {
      const info = load(name).jsonParsed.value.data.parsed.info;
      expect(info.mintAuthority ?? null, name).toBe(expected.mintAuthority);
      expect(info.freezeAuthority ?? null, name).toBe(expected.freezeAuthority);
      expect(info.decimals, name).toBe(expected.decimals);
      const seen = (info.extensions ?? []).map((e: any) => e.extension).sort();
      expect(seen, name).toEqual(Object.keys(expected.extensions).sort());
    }
  });

  it('passes a clean SPL mint with both authorities revoked', async () => {
    const h = harness({ account: accountOf('clean-spl-bonk') });
    const result = await h.screener.screenMint(MINT, SIZE);
    expect(result.verdict).toBe('pass');
    expect(result.failedChecks).toEqual([]);
  });

  it('fails a mint with live authorities, naming both', async () => {
    const h = harness({ account: accountOf('live-authorities-usdc') });
    const result = await h.screener.screenMint(MINT, SIZE);

    expect(result.verdict).toBe('fail');
    expect(result.failedChecks).toEqual(['MINT_AUTHORITY_LIVE', 'FREEZE_AUTHORITY_LIVE']);
    // Short-circuited: nothing further was consulted.
    expect(h.calls.pairs).toBe(0);
    expect(h.calls.quotes).toBe(0);
  });

  it('passes the real Token-2022 pump.fun mint, whose extensions are benign', async () => {
    // metadataPointer + tokenMetadata: neither blocks a transfer.
    const h = harness({ account: accountOf('fresh-pump-mint') });
    const result = await h.screener.screenMint(MINT, SIZE);
    expect(result.verdict).toBe('pass');
    expect(result.details['extensions']).toEqual(['metadataPointer', 'tokenMetadata']);
  });

  it('fails the real PYUSD mint on permanentDelegate and live authorities', async () => {
    const h = harness({ account: accountOf('token2022-extensions-pyusd') });
    const result = await h.screener.screenMint(MINT, SIZE);
    expect(result.verdict).toBe('fail');
    expect(result.failedChecks).toContain('MINT_AUTHORITY_LIVE');
  });
});

// ---------------------------------------------------------------------------
// Token-2022 extensions
// ---------------------------------------------------------------------------

describe('Token-2022 extensions', () => {
  function t22(extensions: Array<{ extension: string; state?: any }>): ParsedMintAccount {
    return {
      owner: TOKEN_2022_PROGRAM_ID,
      data: { parsed: { info: { decimals: 6, mintAuthority: null, freezeAuthority: null, extensions } } },
    };
  }

  it.each([
    ['nonTransferable', {}, 'T22_NON_TRANSFERABLE'],
    ['pausable', {}, 'T22_PAUSABLE'],
    ['permanentDelegate', { delegate: 'Dele1111111111111111111111111111111111111' }, 'T22_PERMANENT_DELEGATE'],
    ['defaultAccountState', { accountState: 'frozen' }, 'T22_DEFAULT_ACCOUNT_FROZEN'],
  ])('rejects %s', async (extension, state, code) => {
    const h = harness({ account: t22([{ extension, state }]) });
    const result = await h.screener.screenMint(MINT, SIZE);
    expect(result.verdict).toBe('fail');
    expect(result.failedChecks).toContain(code);
  });

  it('rejects a transferHook with a real programId', async () => {
    const h = harness({
      account: t22([{ extension: 'transferHook', state: { programId: 'Hook111111111111111111111111111111111111111' } }]),
    });
    const result = await h.screener.screenMint(MINT, SIZE);
    expect(result.failedChecks).toContain('T22_TRANSFER_HOOK');
  });

  it('accepts a transferHook whose programId is null, as PYUSD really has', async () => {
    const h = harness({ account: t22([{ extension: 'transferHook', state: { programId: null } }]) });
    const result = await h.screener.screenMint(MINT, SIZE);
    expect(result.failedChecks).not.toContain('T22_TRANSFER_HOOK');
    expect(result.verdict).toBe('pass');
  });

  it('accepts a defaultAccountState of initialized', async () => {
    const h = harness({
      account: t22([{ extension: 'defaultAccountState', state: { accountState: 'initialized' } }]),
    });
    expect((await h.screener.screenMint(MINT, SIZE)).verdict).toBe('pass');
  });

  it.each(['mintCloseAuthority', 'interestBearingConfig', 'metadataPointer', 'groupPointer', 'confidentialTransferMint'])(
    'accepts %s, which does not restrict transfers',
    async (extension) => {
      const h = harness({ account: t22([{ extension, state: {} }]) });
      expect((await h.screener.screenMint(MINT, SIZE)).verdict).toBe('pass');
    },
  );

  describe('transferFeeConfig epochs', () => {
    const config = (older: number, newer: number, newerEpoch: number) => ({
      extension: 'transferFeeConfig',
      state: {
        olderTransferFee: { epoch: 100, transferFeeBasisPoints: older },
        newerTransferFee: { epoch: newerEpoch, transferFeeBasisPoints: newer },
      },
    });

    it('reads the newer fee once its epoch has arrived', async () => {
      const h = harness({ account: t22([config(0, 9_000, 200)]), epoch: 200 });
      const result = await h.screener.screenMint(MINT, SIZE);
      expect(result.failedChecks).toContain('T22_TRANSFER_FEE_HIGH');
      expect(result.details['governingTransferFeeBps']).toBe(9_000);
    });

    it('reads the older fee while the newer one is still scheduled', async () => {
      const h = harness({ account: t22([config(10, 9_000, 200)]), epoch: 199 });
      const result = await h.screener.screenMint(MINT, SIZE);
      // Governing fee is the benign one...
      expect(result.details['governingTransferFeeBps']).toBe(10);
      // ...but the scheduled hike is caught rather than read as clean.
      expect(result.failedChecks).toContain('T22_TRANSFER_FEE_SCHEDULED_HIGH');
      expect(result.verdict).toBe('fail');
    });

    it('accepts a fee below the ceiling in both slots', async () => {
      const h = harness({ account: t22([config(100, 200, 200)]), epoch: 199 });
      expect((await h.screener.screenMint(MINT, SIZE)).verdict).toBe('pass');
    });

    it('is unknown, not clean, when the epoch cannot be read', async () => {
      const h = harness({ account: t22([config(0, 9_000, 999_999)]) });
      h.deps.rpc.getEpoch = async () => {
        throw new Error('rpc down');
      };
      const result = await h.screener.screenMint(MINT, SIZE);
      expect(result.verdict).toBe('unknown');
    });
  });
});

// ---------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------

describe('age floor', () => {
  const seconds = (ms: number): number => Math.floor((NOW - ms) / 1_000);

  it('rejects a mint under two minutes old on a short page', async () => {
    const h = harness({ signatures: [{ signature: 'first', blockTime: seconds(60_000) }] });
    const result = await h.screener.screenMint(MINT, SIZE);
    expect(result.failedChecks).toContain('MINT_TOO_YOUNG');
    expect(result.details['ageExact']).toBe(true);
  });

  it('accepts a mint older than the floor on a short page', async () => {
    const h = harness({ signatures: [{ signature: 'first', blockTime: seconds(180_000) }] });
    expect((await h.screener.screenMint(MINT, SIZE)).verdict).toBe('pass');
  });

  it('does NOT treat a full page as satisfying the floor', async () => {
    // Measured live: a hot mint's 1000 most recent signatures spanned 0.4
    // minutes. Treating "full page" as old enough admits a 24-second-old mint.
    let page = 0;
    const h = harness({
      signatures: () => {
        page += 1;
        // First page: 1000 entries all within 24 seconds.
        if (page === 1)
          return Array.from({ length: 1_000 }, (_, i) => ({
            signature: `s${i}`,
            blockTime: seconds(24_000),
          }));
        // Second page reaches the real first signature, 30 seconds old.
        return [{ signature: 'first', blockTime: seconds(30_000) }];
      },
    });

    const result = await h.screener.screenMint(MINT, SIZE);
    expect(h.calls.signatures).toBe(2);
    expect(result.failedChecks).toContain('MINT_TOO_YOUNG');
  });

  it('stops paging once the lower bound already clears the floor', async () => {
    const h = harness({
      signatures: () =>
        Array.from({ length: 1_000 }, (_, i) => ({
          signature: `s${i}`,
          blockTime: seconds(600_000),
        })),
    });
    const result = await h.screener.screenMint(MINT, SIZE);
    expect(h.calls.signatures).toBe(1);
    expect(result.verdict).toBe('pass');
    expect(result.details['ageExact']).toBe(false);
  });

  it('is unknown when the RPC fails', async () => {
    const h = harness({ signaturesError: 'node behind' });
    const result = await h.screener.screenMint(MINT, SIZE);
    expect(result.verdict).toBe('unknown');
    expect(result.unknownChecks).toContain('MINT_AGE_UNAVAILABLE');
  });

  it('is unknown when blockTime is null', async () => {
    const h = harness({ signatures: [{ signature: 'first', blockTime: null }] });
    expect((await h.screener.screenMint(MINT, SIZE)).verdict).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Liquidity
// ---------------------------------------------------------------------------

describe('liquidity floor', () => {
  it('uses the deepest routable pair, not the sum', async () => {
    // Ten shallow decoys sum to $50k but none can absorb an exit.
    const decoys: DexPair[] = Array.from({ length: 10 }, () => ({
      liquidity: { usd: 5_000 },
      quoteToken: { address: WRAPPED_SOL_MINT },
    }));
    const h = harness({ pairs: decoys, minLiquidityUsd: 15_000 });
    const result = await h.screener.screenMint(MINT, SIZE);

    expect(result.failedChecks).toContain('LIQUIDITY_BELOW_FLOOR');
    expect(result.details['deepestPairUsd']).toBe(5_000);
    expect(result.details['summedPairsUsd']).toBe(50_000);
  });

  it('passes when one routable pair clears the floor', async () => {
    const h = harness({
      pairs: [
        { liquidity: { usd: 1_000 }, quoteToken: { address: WRAPPED_SOL_MINT } },
        { liquidity: { usd: 40_000 }, quoteToken: { address: WRAPPED_SOL_MINT } },
      ],
    });
    const result = await h.screener.screenMint(MINT, SIZE);
    expect(result.verdict).toBe('pass');
    expect(result.details['deepestPairUsd']).toBe(40_000);
  });

  it('treats pairs: null as unknown, never as zero', async () => {
    const h = harness({ pairs: null });
    const result = await h.screener.screenMint(MINT, SIZE);
    expect(result.verdict).toBe('unknown');
    expect(result.unknownChecks).toContain('LIQUIDITY_UNAVAILABLE');
    expect(result.failedChecks).not.toContain('LIQUIDITY_BELOW_FLOOR');
  });

  it('treats pairs: [] as unknown, never as zero', async () => {
    const h = harness({ pairs: [] });
    const result = await h.screener.screenMint(MINT, SIZE);
    expect(result.verdict).toBe('unknown');
    expect(result.unknownChecks).toContain('LIQUIDITY_UNAVAILABLE');
  });

  it('treats a DexScreener error as unknown', async () => {
    const h = harness({ pairsError: 'HTTP 503' });
    expect((await h.screener.screenMint(MINT, SIZE)).verdict).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe('round-trip retention', () => {
  it('passes a clean round trip', async () => {
    const h = harness({ forward: 1_000_000_000n, reverse: 44_800_000n });
    const result = await h.screener.screenMint(MINT, SIZE);
    // 44_800_000 / (0.05 SOL * 0.9 = 45_000_000) = 9955 bps
    expect(result.details['roundTripRetentionBps']).toBe(9_955);
    expect(result.verdict).toBe('pass');
  });

  it('fails a honeypot that routes in but not out', async () => {
    const h = harness({
      forward: 1_000_000_000n,
      reverse: { error: 'NO_ROUTE', message: 'No routes found' },
    });
    const result = await h.screener.screenMint(MINT, SIZE);
    expect(result.verdict).toBe('fail');
    expect(result.failedChecks).toEqual(['NO_ROUTE_OUT']);
  });

  it('fails a mint with no route in', async () => {
    const h = harness({ forward: { error: 'NO_ROUTE', message: 'No routes found' } });
    const result = await h.screener.screenMint(MINT, SIZE);
    expect(result.failedChecks).toEqual(['NO_ROUTE_IN']);
  });

  it('fails on retention below the floor', async () => {
    // Half the SOL comes back: an extractive tax or a drained pool.
    const h = harness({ forward: 1_000_000_000n, reverse: 22_500_000n });
    const result = await h.screener.screenMint(MINT, SIZE);
    expect(result.details['roundTripRetentionBps']).toBe(5_000);
    expect(result.failedChecks).toContain('ROUND_TRIP_RETENTION_LOW');
  });

  it('catches a bad mint even when priceImpactPct reports zero', async () => {
    // Measured: Jupiter reported exactly 0 on 3 of 7 real routes. Retention is
    // what actually gates, so a lying impact figure changes nothing.
    const h = harness({ forward: 1_000_000_000n, reverse: 10_000_000n, quoteImpactPct: 0 });
    const result = await h.screener.screenMint(MINT, SIZE);
    expect(result.details['worstPriceImpactBps']).toBe(0);
    expect(result.failedChecks).toContain('ROUND_TRIP_RETENTION_LOW');
    expect(result.verdict).toBe('fail');
  });

  it('separates a quote TIMEOUT from a honeypot', async () => {
    // A transport failure must never be recorded as "cannot sell".
    const h = harness({ forward: { error: 'TIMEOUT', message: 'slow' } });
    const result = await h.screener.screenMint(MINT, SIZE);
    expect(result.verdict).toBe('unknown');
    expect(result.unknownChecks).toContain('QUOTE_UNAVAILABLE');
    expect(result.failedChecks).toEqual([]);
  });

  it('sells back exactly 90% of the forward output, in base units', async () => {
    const seen: QuoteRequest[] = [];
    const h = harness({ forward: 1_000_000_007n });
    h.deps.quotes = {
      getQuote: async (request) => {
        seen.push(request);
        return quoteOf(request, request.inMint === WRAPPED_SOL_MINT ? 1_000_000_007n : 45_000_000n, 0.1);
      },
    };
    await new SafetyScreener(h.deps).screenMint(MINT, SIZE);
    // (1_000_000_007 * 9000) / 10000, floored — no float in the path.
    expect(seen[1]?.inAmount).toBe(900_000_006n);
  });
});

// ---------------------------------------------------------------------------
// Cache, single-flight, concurrency
// ---------------------------------------------------------------------------

describe('cache', () => {
  it('caches a pass for 60s', async () => {
    const h = harness();
    await h.screener.screenMint(MINT, SIZE);
    await h.screener.screenMint(MINT, SIZE);
    expect(h.calls.account).toBe(1);
    expect(h.screener.stats.cacheHits).toBe(1);
  });

  it('caches a fail for 60s', async () => {
    const h = harness({ account: accountOf('live-authorities-usdc') });
    await h.screener.screenMint(MINT, SIZE);
    await h.screener.screenMint(MINT, SIZE);
    expect(h.calls.account).toBe(1);
  });

  it('NEVER caches an unknown', async () => {
    const h = harness({ pairs: null });
    const first = await h.screener.screenMint(MINT, SIZE);
    const second = await h.screener.screenMint(MINT, SIZE);

    expect(first.verdict).toBe('unknown');
    expect(second.verdict).toBe('unknown');
    // Two full screens: a provider outage must not blind us for a minute.
    expect(h.calls.account).toBe(2);
    expect(h.screener.stats.cacheHits).toBe(0);
  });

  it('lets a recovered provider through immediately, not after a stale minute', async () => {
    // The operational point of never caching unknown: when DexScreener comes
    // back, the very next screen must see it.
    let broken = true;
    const h = harness();
    h.deps.dexscreener = {
      getPairs: async () =>
        broken ? null : [{ liquidity: { usd: 50_000 }, quoteToken: { address: WRAPPED_SOL_MINT } }],
    };
    const screener = new SafetyScreener(h.deps);

    expect((await screener.screenMint(MINT, SIZE)).verdict).toBe('unknown');
    broken = false;
    expect((await screener.screenMint(MINT, SIZE)).verdict).toBe('pass');
  });

  it('keys on size, so a verdict for one trade is not reused for another', async () => {
    const h = harness();
    await h.screener.screenMint(MINT, { sizeSol: 0.05 });
    await h.screener.screenMint(MINT, { sizeSol: 5 });
    // The reverse quote is size-dependent; these are different questions.
    expect(h.calls.account).toBe(2);
    expect(h.screener.stats.cacheHits).toBe(0);
  });

  it('returns a DIFFERENT verdict for a size the mint cannot absorb', async () => {
    // The behavioural reason the key includes size: a thin pool round-trips
    // fine at 0.05 SOL and collapses at 5 SOL. A mint-only key would serve
    // the small-size pass to the large-size question.
    const h = harness();
    h.deps.quotes = {
      getQuote: async (request) => {
        const big = request.inAmount > 1_000_000_000n;
        const out = request.inMint === WRAPPED_SOL_MINT
          ? 1_000_000_000n
          : big ? 100_000_000n : 44_800_000n;
        return quoteOf(request, out, 0.1);
      },
    };
    const screener = new SafetyScreener(h.deps);

    expect((await screener.screenMint(MINT, { sizeSol: 0.05 })).verdict).toBe('pass');
    const large = await screener.screenMint(MINT, { sizeSol: 5 });
    expect(large.verdict).toBe('fail');
    expect(large.failedChecks).toContain('ROUND_TRIP_RETENTION_LOW');
  });

  it('reuses the cache for the same size', async () => {
    const h = harness();
    await h.screener.screenMint(MINT, { sizeSol: 5 });
    await h.screener.screenMint(MINT, { sizeSol: 5 });
    expect(h.calls.account).toBe(1);
  });
});

describe('single-flight and concurrency', () => {
  it('collapses concurrent screens of the same mint into one', async () => {
    const h = harness();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => h.screener.screenMint(MINT, SIZE)),
    );
    expect(results.every((r) => r.verdict === 'pass')).toBe(true);
    expect(h.calls.account).toBe(1);
    expect(h.screener.stats.singleFlightJoins).toBe(7);
  });

  it('caps concurrent screens of different mints', async () => {
    let peak = 0;
    let active = 0;
    const h = harness();
    const original = h.deps.rpc.getParsedMintAccount;
    h.deps.rpc.getParsedMintAccount = async (mint) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setImmediate(r));
      active -= 1;
      return original(mint);
    };

    const screener = new SafetyScreener(h.deps);
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => screener.screenMint(`mint-${i}`, SIZE)),
    );
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_SCREENS);
  });

  it('makes at most one DexScreener call per screen', async () => {
    const h = harness();
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => h.screener.screenMint(`mint-${i}`, SIZE)),
    );
    expect(h.screener.stats.dexCalls).toBe(6);
    expect(h.calls.pairs).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// THE canSell BOUNDARY
// ---------------------------------------------------------------------------

describe('canSell boundary', () => {
  function wire(canSell: (mint: string) => Promise<{ ok: boolean; reason?: string }>) {
    const ledger = openLedger({
      path: ':memory:',
      logger: { info: () => undefined, warn: () => undefined },
    });
    const config = parseConfig({});
    const quotes: QuoteSource = {
      getQuote: async (request) => quoteOf(request, 1_000_000_000n, 0.1),
    };
    // A monotonic clock, not a constant. The ledger replays fills ordered by
    // (at, id), so two fills sharing a millisecond fall back to alphabetical
    // intent-id order — which would replay an 'exit' before a 'seed'. See the
    // handoff: a latent ordering hazard, not a screener concern.
    let clock = NOW;
    const broker = createPaperBroker({
      quoteSource: quotes,
      resolveDecimals: createDecimalsResolver(fixtureDecimalsSource({ [MINT]: 6 })),
      ledger,
      config,
      latencyMs: 0,
      now: () => (clock += 1),
      canSell,
    });

    const logged: GuardLogFields[] = [];
    const deps: GuardDeps = {
      config,
      logger: { warn: (fields) => logged.push(fields) },
      getState: () => ({ mode: 'paper', status: 'running', startedAt: NOW, killSwitchEngaged: false }),
      getRealizedLossLamportsToday: async () => 0n,
      getUnacknowledgedOrphanCount: async () => 0,
    };

    return { broker, guardedBroker: guarded(broker, deps), ledger, logged, config };
  }

  it('admits a buy when the screener passes', async () => {
    const h = harness();
    const w = wire(canSellFromScreener(h.screener, SIZE));
    try {
      await expect(
        w.guardedBroker.execute({
          id: 'buy-ok',
          side: 'buy',
          mint: MINT,
          amountLamports: solToLamports(0.05),
          maxSlippageBps: 300,
          reason: 'test',
        }),
      ).resolves.toBeDefined();
    } finally {
      w.ledger.close();
    }
  });

  it('refuses a buy on fail, with a code distinct from unknown', async () => {
    const h = harness({ account: accountOf('live-authorities-usdc') });
    const w = wire(canSellFromScreener(h.screener, SIZE));
    try {
      await expect(
        w.guardedBroker.execute({
          id: 'buy-fail',
          side: 'buy',
          mint: MINT,
          amountLamports: solToLamports(0.05),
          maxSlippageBps: 300,
          reason: 'test',
        }),
      ).rejects.toMatchObject({ code: 'CANNOT_SELL' });
      expect(w.logged[0]?.reason).toContain('SCREEN_FAILED');
      expect(w.logged[0]?.reason).toContain('MINT_AUTHORITY_LIVE');
    } finally {
      w.ledger.close();
    }
  });

  it('refuses a buy on unknown, and says so differently', async () => {
    const h = harness({ pairs: null });
    const w = wire(canSellFromScreener(h.screener, SIZE));
    try {
      await expect(
        w.guardedBroker.execute({
          id: 'buy-unknown',
          side: 'buy',
          mint: MINT,
          amountLamports: solToLamports(0.05),
          maxSlippageBps: 300,
          reason: 'test',
        }),
      ).rejects.toMatchObject({ code: 'CANNOT_SELL' });
      // Fails closed like a failure, but is distinguishable from one.
      expect(w.logged[0]?.reason).toContain('SCREEN_UNKNOWN');
      expect(w.logged[0]?.reason).toContain('LIQUIDITY_UNAVAILABLE');
      expect(w.logged[0]?.reason).not.toContain('SCREEN_FAILED');
    } finally {
      w.ledger.close();
    }
  });

  /** The two assertions this whole module exists to satisfy. */
  it('SELLS a held mint while the screener fails EVERY check', async () => {
    const everythingFails = vi.fn(async () => ({
      ok: false,
      reason: 'SCREEN_FAILED:MINT_AUTHORITY_LIVE,FREEZE_AUTHORITY_LIVE,NO_ROUTE_OUT,LIQUIDITY_BELOW_FLOOR',
    }));
    const w = wire(everythingFails);
    try {
      // Acquire a position without the screener in the way.
      const bought = await w.broker.execute({
        id: 'seed',
        side: 'buy',
        mint: MINT,
        amountLamports: solToLamports(0.05),
        maxSlippageBps: 300,
        reason: 'seed',
      });

      const sold = await w.guardedBroker.execute({
        id: 'exit',
        side: 'sell',
        mint: MINT,
        amountTokens: bought.tokensDelta,
        maxSlippageBps: 300,
        reason: 'exit',
      });

      expect(sold.tokensDelta).toBeLessThan(0n);
      expect(w.ledger.getPosition(MINT)?.state).toBe('closed');
      // Direct assertion: the sell path never asked.
      expect(everythingFails).not.toHaveBeenCalled();
    } finally {
      w.ledger.close();
    }
  });

  it('completes emergencyExitAll while the screener THROWS on every call', async () => {
    const throwing = vi.fn(async () => {
      throw new Error('screener exploded');
    });
    const w = wire(throwing as unknown as (mint: string) => Promise<{ ok: boolean }>);
    try {
      await w.broker.execute({
        id: 'seed',
        side: 'buy',
        mint: MINT,
        amountLamports: solToLamports(0.05),
        maxSlippageBps: 300,
        reason: 'seed',
      });

      const fills = await w.guardedBroker.emergencyExitAll();

      expect(fills).toHaveLength(1);
      expect(w.ledger.getPosition(MINT)?.state).toBe('closed');
      expect(throwing).not.toHaveBeenCalled();
    } finally {
      w.ledger.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Held positions: alerting only
// ---------------------------------------------------------------------------

describe('held positions', () => {
  it('emits sellability-degraded on a transition to fail, and creates nothing', async () => {
    const h = harness({ reverse: { error: 'NO_ROUTE', message: 'No routes found' } });
    const events: any[] = [];
    h.screener.on('sellability-degraded', (e) => events.push(e));

    const result = await h.screener.screenHeldPosition(MINT, SIZE);

    expect(result.verdict).toBe('fail');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ mint: MINT, verdict: 'fail', previous: undefined });
    expect(events[0].failedChecks).toContain('NO_ROUTE_OUT');
  });

  it('does not re-emit while the verdict is unchanged', async () => {
    const h = harness({ reverse: { error: 'NO_ROUTE', message: 'gone' } });
    const events: any[] = [];
    h.screener.on('sellability-degraded', (e) => events.push(e));

    await h.screener.screenHeldPosition(MINT, SIZE);
    await h.screener.screenHeldPosition(MINT, SIZE);
    expect(events).toHaveLength(1);
  });

  it('stays silent while a held mint remains healthy', async () => {
    const h = harness();
    const events: any[] = [];
    h.screener.on('sellability-degraded', (e) => events.push(e));
    await h.screener.screenHeldPosition(MINT, SIZE);
    expect(events).toHaveLength(0);
  });

  it('emits on unknown too, since that is also a loss of assurance', async () => {
    const h = harness({ pairsError: 'HTTP 500' });
    const events: any[] = [];
    h.screener.on('sellability-degraded', (e) => events.push(e));
    await h.screener.screenHeldPosition(MINT, SIZE);
    expect(events[0]).toMatchObject({ verdict: 'unknown' });
  });
});
