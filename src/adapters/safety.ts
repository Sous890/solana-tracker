/**
 * The screener: what stands between the bot and a token it can buy but not sell.
 *
 * Three verdicts, not two. `fail` means a check ran and the token is bad.
 * `unknown` means a check could not run — RPC error, DexScreener 5xx, quote
 * timeout. Both block a buy, but they demand different operator responses:
 * a wall of `fail` is the market being adversarial, a wall of `unknown` is our
 * own plumbing being down, and collapsing them destroys the only signal that
 * tells those apart.
 *
 * ── THE canSell BOUNDARY ──────────────────────────────────────────────────
 *
 * This module feeds `canSell()`, which the guard layer consults at buy gate 7
 * and nowhere else. It is a PRE-BUY admission check.
 *
 * It must never influence a sell. Once the bot is holding, screener output is
 * advisory: refusing to sell a token the screener dislikes is precisely the
 * trap the whole guard design exists to avoid. For a held position a
 * degradation emits `sellability-degraded` for alerting, and strategy decides.
 * The screener does not create intents and does not block exits.
 */

import { EventEmitter } from 'node:events';
import type { QuoteError, QuoteSource } from '../core/quoteSource.js';
import { isQuoteError } from '../core/quoteSource.js';
import type { Address, UnixMillis } from '../core/types.js';
import { WRAPPED_SOL_MINT, solToLamports } from '../core/units.js';

export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Reject a transfer fee at or above this. 500 bps = 5%. */
export const MAX_TRANSFER_FEE_BPS = 500;

/**
 * Round-trip retention floor: `solOut / (sizeSol * 0.9)`.
 *
 * **The primary sellability signal**, chosen over `priceImpactPct` on measured
 * evidence. Across a live sample, Jupiter reported `priceImpactPct` of exactly
 * `0` on 3 of 7 real routes — including one whose reverse leg simultaneously
 * reported 2.3%. Retention separated the same sample cleanly and monotonically:
 *
 *   USDC 1.0000 · JUP 0.9996 · PYUSD 0.9999 · BONK 0.9990
 *   fresh pump.fun mints 0.9730 and 0.9640
 *   unroutable: no quote at all
 *
 * 0.80 sits far below the thinnest legitimate mint measured (0.964) and far
 * above a honeypot or an extractive fee. Retention absorbs two price impacts
 * and two sets of route fees, so it is roughly twice the one-way cost.
 */
export const MIN_ROUND_TRIP_RETENTION = 0.8;

/**
 * Secondary, advisory. Kept because when Jupiter *does* report impact it is
 * meaningful, and a spurious `0` can only cause a false pass here, never a
 * false fail — retention is what actually gates.
 */
export const MAX_PRICE_IMPACT_BPS = 2_500;

/** Fraction of the forward output offered back on the reverse leg. */
export const REVERSE_QUOTE_FRACTION_BPS = 9_000n;

export const MIN_MINT_AGE_MS = 2 * 60 * 1_000;

export const PASS_CACHE_TTL_MS = 60_000;
export const FAIL_CACHE_TTL_MS = 60_000;

/** Concurrency ceiling; see `DEXSCREENER_MIN_INTERVAL_MS`. */
export const MAX_CONCURRENT_SCREENS = 3;

/**
 * DexScreener publishes 300 req/min for the token endpoint. One screen makes
 * at most one call, and this floor on the interval caps the module at 240/min
 * regardless of how many screens run concurrently.
 */
export const DEXSCREENER_MIN_INTERVAL_MS = 250;

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type ScreenVerdict = 'pass' | 'fail' | 'unknown';

export type FailCode =
  | 'MINT_AUTHORITY_LIVE'
  | 'FREEZE_AUTHORITY_LIVE'
  | 'T22_TRANSFER_HOOK'
  | 'T22_TRANSFER_FEE_HIGH'
  | 'T22_TRANSFER_FEE_SCHEDULED_HIGH'
  | 'T22_NON_TRANSFERABLE'
  | 'T22_PAUSABLE'
  | 'T22_DEFAULT_ACCOUNT_FROZEN'
  | 'T22_PERMANENT_DELEGATE'
  | 'MINT_TOO_YOUNG'
  | 'NO_ROUTE_IN'
  | 'NO_ROUTE_OUT'
  | 'ROUND_TRIP_RETENTION_LOW'
  | 'PRICE_IMPACT_HIGH'
  | 'LIQUIDITY_BELOW_FLOOR';

export type UnknownCode =
  | 'MINT_ACCOUNT_UNAVAILABLE'
  | 'MINT_AGE_UNAVAILABLE'
  | 'QUOTE_UNAVAILABLE'
  | 'LIQUIDITY_UNAVAILABLE';

export interface ScreenResult {
  verdict: ScreenVerdict;
  failedChecks: string[];
  unknownChecks: string[];
  details: Record<string, unknown>;
  screenedAt: UnixMillis;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** A `jsonParsed` mint account, narrowed to what is read. */
export interface ParsedMintAccount {
  owner: string;
  data: {
    parsed: {
      info: {
        decimals: number;
        /**
         * `null` when revoked. The key is always present under `jsonParsed`
         * (verified live), but absence is treated the same way.
         */
        mintAuthority?: string | null;
        freezeAuthority?: string | null;
        extensions?: Array<{ extension: string; state?: Record<string, any> }>;
      };
    };
  };
}

export interface SignatureRef {
  signature: string;
  blockTime?: number | null;
}

export interface SafetyRpc {
  getParsedMintAccount(mint: Address): Promise<ParsedMintAccount | null>;
  getSignaturesForAddress(
    address: Address,
    options: { limit: number; before?: string },
  ): Promise<SignatureRef[]>;
  getEpoch(): Promise<number>;
}

export interface DexPair {
  liquidity?: { usd?: number } | null;
  quoteToken?: { address?: string } | null;
  dexId?: string;
}

export interface DexScreenerClient {
  /** `null` / `[]` pairs mean "not indexed", which is unknown, not zero. */
  getPairs(mint: Address): Promise<DexPair[] | null>;
}

export interface SafetyLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface SafetyDeps {
  rpc: SafetyRpc;
  quotes: QuoteSource;
  dexscreener: DexScreenerClient;
  /** Minimum acceptable liquidity in USD on the deepest routable pair. */
  minLiquidityUsd: number;
  logger?: SafetyLogger;
  now?: () => UnixMillis;
  sleep?: (ms: number) => Promise<void>;
  /** Escape hatch for tests; production uses the constant. */
  minRetention?: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * An authority is live only when it is a non-empty string.
 *
 * Explicitly not a truthiness check on the raw value. Verified live: under
 * `jsonParsed` a revoked authority is JSON `null` with the key present. A
 * truthiness test happens to work for that, but silently also treats the
 * string `"null"` — and any future sentinel — as revoked, which is the
 * failure direction that admits a mint whose supply can still be inflated.
 */
export function authorityIsLive(value: unknown): boolean {
  // Revoked is exactly two shapes: JSON null, or the key absent.
  if (value === null || value === undefined) return false;
  // A string sentinel is treated as revoked only when it is empty or the
  // literal "null" — never by truthiness.
  if (typeof value === 'string') return value.length > 0 && value !== 'null';
  // Anything else is unexpected. Assume LIVE, which refuses the buy. An
  // earlier version returned false here on the reasoning that a non-string is
  // not a pubkey; that admits a mint whose supply can still be inflated the
  // moment the RPC shape changes. Refusing costs a trade; admitting costs the
  // position.
  return true;
}

interface TransferFee {
  epoch: number;
  transferFeeBasisPoints: number;
}

/**
 * The fee that governs a transfer submitted in `currentEpoch`.
 *
 * From the Token-2022 source:
 *
 *   if epoch >= newer_transfer_fee.epoch { newer } else { older }
 *
 * So a fee change scheduled for a future epoch sits in `newer` while `older`
 * still governs — which is exactly how a token about to become extractive
 * reads as clean today.
 */
export function governingTransferFee(
  state: { olderTransferFee?: TransferFee; newerTransferFee?: TransferFee },
  currentEpoch: number,
): { governing: TransferFee | undefined; scheduled: TransferFee | undefined } {
  const older = state.olderTransferFee;
  const newer = state.newerTransferFee;
  if (newer === undefined) return { governing: older, scheduled: undefined };
  if (currentEpoch >= newer.epoch) return { governing: newer, scheduled: undefined };
  // `newer` is not in force yet. It is still a loaded gun: an epoch is roughly
  // two days, and a position held across the boundary pays the new rate.
  return { governing: older, scheduled: newer };
}

/** Retention in bps, computed from exact integers and converted once. */
export function retentionBps(solOut: bigint, expected: bigint): number {
  if (expected <= 0n) return 0;
  return Number((solOut * 10_000n) / expected);
}

// ---------------------------------------------------------------------------
// Screener
// ---------------------------------------------------------------------------

interface CacheEntry {
  result: ScreenResult;
  expiresAt: UnixMillis;
}

export interface ScreenOptions {
  sizeSol: number;
}

export class SafetyScreener extends EventEmitter {
  private readonly deps: SafetyDeps;
  private readonly now: () => UnixMillis;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<ScreenResult>>();
  private readonly lastVerdict = new Map<Address, ScreenVerdict>();

  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private lastDexCallAt = 0;

  readonly stats = { screens: 0, cacheHits: 0, singleFlightJoins: 0, dexCalls: 0 };

  constructor(deps: SafetyDeps) {
    super();
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Cache key includes size. The reverse quote is size-dependent, so a verdict
   * computed for 0.05 SOL says nothing about 5 SOL.
   */
  private key(mint: Address, sizeSol: number): string {
    return `${mint}|${sizeSol}`;
  }

  async screenMint(mint: Address, opts: ScreenOptions): Promise<ScreenResult> {
    const key = this.key(mint, opts.sizeSol);

    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) {
      this.stats.cacheHits += 1;
      return cached.result;
    }

    // Single-flight: N tracked wallets buying the same mint in one block must
    // produce one screen, not N.
    const running = this.inFlight.get(key);
    if (running !== undefined) {
      this.stats.singleFlightJoins += 1;
      return running;
    }

    const work = this.runWithLimit(mint, opts).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);

    const result = await work;

    // `unknown` is NEVER cached. It means our data was missing, and caching
    // that turns a transient outage into a minute of blindness.
    if (result.verdict !== 'unknown') {
      const ttl = result.verdict === 'pass' ? PASS_CACHE_TTL_MS : FAIL_CACHE_TTL_MS;
      this.cache.set(key, { result, expiresAt: this.now() + ttl });
    }
    return result;
  }

  /**
   * Screen a mint the bot already holds.
   *
   * Alerting only. Emits `sellability-degraded` on a transition into `fail` or
   * `unknown`, and returns the result. It creates no intent and blocks nothing.
   */
  async screenHeldPosition(mint: Address, opts: ScreenOptions): Promise<ScreenResult> {
    const result = await this.screenMint(mint, opts);
    const previous = this.lastVerdict.get(mint);
    this.lastVerdict.set(mint, result.verdict);

    if (result.verdict !== 'pass' && previous !== result.verdict) {
      this.emit('sellability-degraded', {
        mint,
        verdict: result.verdict,
        previous,
        failedChecks: result.failedChecks,
        unknownChecks: result.unknownChecks,
        at: result.screenedAt,
      });
    }
    return result;
  }

  // -- concurrency ----------------------------------------------------------

  private async runWithLimit(mint: Address, opts: ScreenOptions): Promise<ScreenResult> {
    if (this.active >= MAX_CONCURRENT_SCREENS) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      this.stats.screens += 1;
      return await this.run(mint, opts);
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }

  // -- the checks -----------------------------------------------------------

  /**
   * Cheapest first, short-circuiting on the first hard fail.
   *
   * Deliberately not the brief's 1-5 numbering: the reverse quote is two
   * network round trips and runs last, after one RPC call for the mint
   * account, a free read of the extensions already in that response, one RPC
   * call for age, and one HTTP call for liquidity.
   */
  private async run(mint: Address, opts: ScreenOptions): Promise<ScreenResult> {
    const failed: string[] = [];
    const unknown: string[] = [];
    const details: Record<string, unknown> = { mint, sizeSol: opts.sizeSol };
    const finish = (): ScreenResult => ({
      verdict: failed.length > 0 ? 'fail' : unknown.length > 0 ? 'unknown' : 'pass',
      failedChecks: failed,
      unknownChecks: unknown,
      details,
      screenedAt: this.now(),
    });

    // 1 & 2 — mint account and, from the same response, extensions.
    let account: ParsedMintAccount | null;
    try {
      account = await this.deps.rpc.getParsedMintAccount(mint);
    } catch (error) {
      unknown.push('MINT_ACCOUNT_UNAVAILABLE');
      details['mintAccountError'] = (error as Error).message;
      return finish();
    }
    if (account === null) {
      unknown.push('MINT_ACCOUNT_UNAVAILABLE');
      details['mintAccountError'] = 'account does not exist';
      return finish();
    }

    const info = account.data.parsed.info;
    details['ownerProgram'] = account.owner;
    details['isToken2022'] = account.owner === TOKEN_2022_PROGRAM_ID;
    details['mintAuthority'] = info.mintAuthority ?? null;
    details['freezeAuthority'] = info.freezeAuthority ?? null;

    if (authorityIsLive(info.mintAuthority)) failed.push('MINT_AUTHORITY_LIVE');
    if (authorityIsLive(info.freezeAuthority)) failed.push('FREEZE_AUTHORITY_LIVE');
    if (failed.length > 0) return finish();

    if (account.owner === TOKEN_2022_PROGRAM_ID) {
      const extensionFailures = await this.checkExtensions(info.extensions ?? [], details, unknown);
      failed.push(...extensionFailures);
      if (failed.length > 0) return finish();
    }

    // 3 — age.
    const age = await this.checkAge(mint, details);
    if (age === 'unknown') unknown.push('MINT_AGE_UNAVAILABLE');
    else if (age === 'too-young') failed.push('MINT_TOO_YOUNG');
    if (failed.length > 0) return finish();

    // 4 — liquidity.
    await this.checkLiquidity(mint, details, failed, unknown);
    if (failed.length > 0) return finish();

    // 5 — the reverse-quote round trip, last because it is the most expensive.
    await this.checkRoundTrip(mint, opts, details, failed, unknown);
    return finish();
  }

  private async checkExtensions(
    extensions: Array<{ extension: string; state?: Record<string, any> }>,
    details: Record<string, unknown>,
    unknown: string[],
  ): Promise<string[]> {
    const failures: string[] = [];
    details['extensions'] = extensions.map((e) => e.extension);
    const find = (name: string): Record<string, any> | undefined =>
      extensions.find((e) => e.extension === name)?.state;

    // Blocks every transfer outright.
    if (find('nonTransferable') !== undefined) failures.push('T22_NON_TRANSFERABLE');

    // Aborts all transfers whenever the authority flips the flag. Not in the
    // brief's list; confirmed sell-blocking against the extension guide.
    if (find('pausable') !== undefined) failures.push('T22_PAUSABLE');

    // New token accounts arrive frozen, so a buyer cannot move what they buy.
    const defaultState = find('defaultAccountState');
    if (defaultState !== undefined) {
      const state = defaultState['accountState'] ?? defaultState['state'];
      if (state === 'frozen' || state === 2) failures.push('T22_DEFAULT_ACCOUNT_FROZEN');
    }

    // Does not block a transfer, but lets the delegate take the position from
    // under us at any time. Fatal for a holding, so treated as such.
    if (find('permanentDelegate') !== undefined) failures.push('T22_PERMANENT_DELEGATE');

    // Only a hook with a real program can run code on transfer; the extension
    // exists with a null programId on plenty of benign mints (PYUSD included).
    const hook = find('transferHook');
    if (hook !== undefined) {
      details['transferHookProgramId'] = hook['programId'] ?? null;
      if (authorityIsLive(hook['programId'])) failures.push('T22_TRANSFER_HOOK');
    }

    const fee = find('transferFeeConfig');
    if (fee !== undefined) {
      let epoch: number;
      try {
        epoch = await this.deps.rpc.getEpoch();
      } catch {
        // Without the epoch we cannot say which fee is in force. That is
        // unknown, not clean.
        unknown.push('MINT_ACCOUNT_UNAVAILABLE');
        details['transferFeeEpochUnavailable'] = true;
        return failures;
      }

      const { governing, scheduled } = governingTransferFee(
        fee as { olderTransferFee?: TransferFee; newerTransferFee?: TransferFee },
        epoch,
      );
      details['currentEpoch'] = epoch;
      details['governingTransferFeeBps'] = governing?.transferFeeBasisPoints ?? 0;
      details['scheduledTransferFeeBps'] = scheduled?.transferFeeBasisPoints ?? null;

      if ((governing?.transferFeeBasisPoints ?? 0) > MAX_TRANSFER_FEE_BPS) {
        failures.push('T22_TRANSFER_FEE_HIGH');
      }
      // A rate that switches on at a future epoch is a rug with a timer.
      if ((scheduled?.transferFeeBasisPoints ?? 0) > MAX_TRANSFER_FEE_BPS) {
        failures.push('T22_TRANSFER_FEE_SCHEDULED_HIGH');
      }
    }

    return failures;
  }

  /**
   * Age from the mint's oldest signature.
   *
   * A **full** page does not establish age: it only bounds it from below by
   * the age of that page's oldest entry. Measured on a live mint whose 1000
   * most recent signatures spanned 0.4 minutes — treating "full page" as
   * satisfying a 2-minute floor would admit a 24-second-old mint. So a full
   * page is only conclusive when its own oldest entry already clears the
   * floor; otherwise it pages back.
   */
  private async checkAge(
    mint: Address,
    details: Record<string, unknown>,
  ): Promise<'ok' | 'too-young' | 'unknown'> {
    const LIMIT = 1_000;
    const MAX_PAGES = 4;
    let before: string | undefined;

    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const entries = await this.deps.rpc.getSignaturesForAddress(mint, {
          limit: LIMIT,
          ...(before === undefined ? {} : { before }),
        });
        if (entries.length === 0) return 'unknown';

        const oldest = entries[entries.length - 1];
        const blockTime = oldest?.blockTime;
        if (blockTime === null || blockTime === undefined) return 'unknown';

        const ageMs = this.now() - blockTime * 1_000;
        details['ageMs'] = ageMs;
        details['ageExact'] = entries.length < LIMIT;

        // A short page means this really is the first signature.
        if (entries.length < LIMIT) return ageMs >= MIN_MINT_AGE_MS ? 'ok' : 'too-young';
        // A full page only bounds age from below.
        if (ageMs >= MIN_MINT_AGE_MS) return 'ok';

        before = oldest?.signature;
        if (before === undefined) return 'unknown';
      }
      return 'unknown';
    } catch (error) {
      details['ageError'] = (error as Error).message;
      return 'unknown';
    }
  }

  /** Rate-limited so concurrent screens cannot exceed DexScreener's budget. */
  private async dexPairs(mint: Address): Promise<DexPair[] | null> {
    const wait = this.lastDexCallAt + DEXSCREENER_MIN_INTERVAL_MS - this.now();
    if (wait > 0) await (this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(wait);
    this.lastDexCallAt = this.now();
    this.stats.dexCalls += 1;
    return this.deps.dexscreener.getPairs(mint);
  }

  /**
   * Liquidity floor on the **deepest single routable pair**, not the sum.
   *
   * Summing rewards an attacker for creating many shallow decoy pools, and
   * counts pools Jupiter may never route through. Taking the deepest pair
   * quoted in SOL or USDC keeps the number close to what an exit can actually
   * draw on.
   *
   * The attack this remains vulnerable to: one genuinely deep pool that
   * Jupiter will not route through — a pool on an unsupported program, or one
   * whose USD valuation DexScreener derives from a manipulated quote-token
   * price. That inflates a single pair, which is exactly what this reads. The
   * round-trip check is the backstop, since it uses a real Jupiter route.
   */
  private async checkLiquidity(
    mint: Address,
    details: Record<string, unknown>,
    failed: string[],
    unknown: string[],
  ): Promise<void> {
    let pairs: DexPair[] | null;
    try {
      pairs = await this.dexPairs(mint);
    } catch (error) {
      unknown.push('LIQUIDITY_UNAVAILABLE');
      details['liquidityError'] = (error as Error).message;
      return;
    }

    // `null` and `[]` mean not indexed. That is unknown, never zero.
    if (pairs === null || pairs.length === 0) {
      unknown.push('LIQUIDITY_UNAVAILABLE');
      details['liquidityIndexed'] = false;
      return;
    }

    const routable = pairs.filter((pair) => {
      const quote = pair.quoteToken?.address;
      return quote === WRAPPED_SOL_MINT || quote === USDC_MINT;
    });
    const considered = routable.length > 0 ? routable : pairs;
    const deepest = considered.reduce(
      (best, pair) => Math.max(best, pair.liquidity?.usd ?? 0),
      0,
    );

    details['liquidityIndexed'] = true;
    details['pairCount'] = pairs.length;
    details['deepestPairUsd'] = deepest;
    details['summedPairsUsd'] = pairs.reduce((t, p) => t + (p.liquidity?.usd ?? 0), 0);

    if (deepest < this.deps.minLiquidityUsd) failed.push('LIQUIDITY_BELOW_FLOOR');
  }

  /**
   * Buy then sell back, for real, on live routes.
   *
   * The load-bearing check: it is the only one that exercises the actual exit
   * path rather than describing it.
   */
  private async checkRoundTrip(
    mint: Address,
    opts: ScreenOptions,
    details: Record<string, unknown>,
    failed: string[],
    unknown: string[],
  ): Promise<void> {
    const sizeLamports = solToLamports(opts.sizeSol);

    const forward = await this.deps.quotes.getQuote({
      inMint: WRAPPED_SOL_MINT,
      outMint: mint,
      inAmount: sizeLamports,
      slippageBps: MAX_PRICE_IMPACT_BPS,
    });

    if (isQuoteError(forward)) {
      this.classifyQuoteError(forward, 'NO_ROUTE_IN', failed, unknown, details, 'forward');
      return;
    }
    details['forwardOutAmount'] = forward.outAmount.toString();
    details['forwardPriceImpactPct'] = forward.priceImpactPct;

    if (forward.outAmount <= 0n) {
      failed.push('NO_ROUTE_IN');
      return;
    }

    // Sell back 90% of what the buy would yield. All base units, no floats.
    const back = (forward.outAmount * REVERSE_QUOTE_FRACTION_BPS) / 10_000n;
    const reverse = await this.deps.quotes.getQuote({
      inMint: mint,
      outMint: WRAPPED_SOL_MINT,
      inAmount: back,
      slippageBps: MAX_PRICE_IMPACT_BPS,
    });

    if (isQuoteError(reverse)) {
      this.classifyQuoteError(reverse, 'NO_ROUTE_OUT', failed, unknown, details, 'reverse');
      return;
    }
    details['reverseOutAmount'] = reverse.outAmount.toString();
    details['reversePriceImpactPct'] = reverse.priceImpactPct;

    const expected = (sizeLamports * REVERSE_QUOTE_FRACTION_BPS) / 10_000n;
    const bps = retentionBps(reverse.outAmount, expected);
    details['roundTripRetentionBps'] = bps;

    const floor = Math.round((this.deps.minRetention ?? MIN_ROUND_TRIP_RETENTION) * 10_000);
    if (bps < floor) failed.push('ROUND_TRIP_RETENTION_LOW');

    // Secondary. Reported as 0 on many real routes, so it can only ever add a
    // failure, never remove one.
    const worstImpactBps = Math.max(forward.priceImpactPct, reverse.priceImpactPct) * 100;
    details['worstPriceImpactBps'] = worstImpactBps;
    if (worstImpactBps > MAX_PRICE_IMPACT_BPS) failed.push('PRICE_IMPACT_HIGH');
  }

  /**
   * `NO_ROUTE` is a fact about the token. A timeout or upstream error is a
   * fact about us, and must not be recorded as a honeypot.
   */
  private classifyQuoteError(
    error: QuoteError,
    noRouteCode: FailCode,
    failed: string[],
    unknown: string[],
    details: Record<string, unknown>,
    leg: string,
  ): void {
    details[`${leg}QuoteError`] = error.error;
    if (error.error === 'NO_ROUTE') failed.push(noRouteCode);
    else unknown.push('QUOTE_UNAVAILABLE');
  }
}

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * Adapt a screener to the `Broker.canSell` shape.
 *
 * `unknown` and `fail` both refuse — the guard layer fails closed — but they
 * carry different reasons so the rejection is distinguishable in logs and in
 * the ledger's `rejection_code`.
 */
/**
 * The one method `canSellFromScreener` needs.
 *
 * Structural rather than `SafetyScreener` so a decorator can sit in front of it
 * — `services/recorder.ts` wraps the screener to capture every verdict for a
 * replay session, and widening this parameter is what lets it do that without
 * a recording call site inside this file. `SafetyScreener` satisfies it; no
 * behaviour here changes.
 */
export interface MintScreener {
  screenMint(mint: Address, opts: ScreenOptions): Promise<ScreenResult>;
}

export function canSellFromScreener(
  screener: MintScreener,
  opts: ScreenOptions,
): (mint: Address) => Promise<{ ok: boolean; reason?: string }> {
  return async (mint) => {
    const result = await screener.screenMint(mint, opts);
    if (result.verdict === 'pass') return { ok: true };
    const prefix = result.verdict === 'unknown' ? 'SCREEN_UNKNOWN' : 'SCREEN_FAILED';
    const codes = result.verdict === 'unknown' ? result.unknownChecks : result.failedChecks;
    return { ok: false, reason: `${prefix}:${codes.join(',')}` };
  };
}
