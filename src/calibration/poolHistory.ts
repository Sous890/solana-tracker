/**
 * Reconstruct a mint's realised price path from its pool's own transactions.
 *
 * ── WHY THE POOL AND NOT THE WALLET ───────────────────────────────────────
 *
 * The wallet export answers "what did this wallet get". This module answers
 * "what would *anyone* have got, at time T" — which is the only way to price a
 * delayed entry. A copier arriving 15 seconds late does not get the wallet's
 * fill; they get whatever the pool was trading at when they arrived. So the
 * price path has to come from every swap against the pool, not from the one
 * wallet we happen to be watching.
 *
 * ── REALISED PRICES, NOT MIDS ─────────────────────────────────────────────
 *
 * `priceSol = |solDelta / tokenDelta|` for each swap: the price that trade
 * actually executed at, inclusive of its own slippage. A mid-price from
 * reserves would be the price of an infinitely small trade, which is not a
 * price anybody can transact at and would flatter every delayed entry.
 *
 * ── NO INSTRUCTION DECODING, ANYWHERE ─────────────────────────────────────
 *
 * Direction and size come from pre/post balance deltas via `swapParser`, and
 * the pool account itself is identified from balance ownership (see
 * `resolvePoolAccounts`). Venue layouts change without notice; balances do not.
 *
 * ── THIS IS OFFLINE ANALYSIS ──────────────────────────────────────────────
 *
 * Nothing in the trading path imports this. It is slow, it is network-bound,
 * and it exists to generate a CSV that Python fits. It lives under `src/` only
 * because it shares `swapParser` and must not drift from it.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseSwap } from '../adapters/swapParser.js';
import type { ParsedTransactionWithMeta } from '../adapters/swapParser.js';
import type { Address, SwapVenue } from '../core/types.js';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface PoolSwap {
  mint: Address;
  signature: string;
  /** Unix **millis**. Null blockTime excludes the swap; see `toPoolSwap`. */
  blockTime: number;
  slot: number;
  /** Signed, from the *pool's* perspective inverted to the taker's. Lamports. */
  solDelta: bigint;
  /** Signed, taker's perspective. Base units. */
  tokenDelta: bigint;
  /** Realised execution price, SOL per whole token. */
  priceSol: number;
  venue: SwapVenue;
  /** True when the taker bought the mint (token in, SOL out of their pocket). */
  isBuy: boolean;
  /** Position within the block. Ties are broken on this; see `orderPoolSwaps`. */
  transactionIndex: number;
}

export interface SignaturePage {
  signature: string;
  slot: number;
  err: unknown | null;
  blockTime?: number | null;
}

/** The RPC surface this module needs. Injected so tests never touch a network. */
export interface PoolRpc {
  getSignaturesForAddress(
    address: Address,
    options: { limit: number; before?: string; until?: string },
  ): Promise<SignaturePage[]>;
  getTransaction(signature: string): Promise<ParsedTransactionWithMeta | null>;
}

export interface PoolHistoryDeps {
  rpc: PoolRpc;
  /** Root for the signature-page cache. Reruns are free once this is warm. */
  cacheDir?: string;
  /** Bounds a single pool walk. Hot memecoin pools are effectively unbounded. */
  maxSignatures?: number;
  /** Bounds transactions actually priced, per call. See `fetchCapped`. */
  maxFetches?: number;
  concurrency?: number;
  log?: (message: string) => void;
}

export const DEFAULT_CACHE_DIR = 'cache/pools';
export const DEFAULT_MAX_SIGNATURES = 20_000;
export const DEFAULT_MAX_FETCHES = 400;
export const DEFAULT_CONCURRENCY = 8;
const PAGE_SIZE = 1_000;

const WSOL = 'So11111111111111111111111111111111111111112';

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Oldest first, by slot then position within the block.
 *
 * Deterministic ordering is not cosmetic here: "the first pool swap at or after
 * target_ts" is the entry price, so two swaps in one slot resolving in a
 * different order between runs would change the measured return. `blockTime` is
 * deliberately not a sort key — it is a stake-weighted median, identical across
 * every transaction in a block and non-monotonic across slots.
 *
 * `signature` is the final tie-break. It is arbitrary but it is *stable*, which
 * is the only property being asked for.
 */
export function orderPoolSwaps(swaps: PoolSwap[]): PoolSwap[] {
  return [...swaps].sort((a, b) => {
    if (a.slot !== b.slot) return a.slot - b.slot;
    if (a.transactionIndex !== b.transactionIndex) {
      return a.transactionIndex - b.transactionIndex;
    }
    return a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Pool resolution
// ---------------------------------------------------------------------------

/**
 * Find the pool-side accounts for `mint` by looking at who took the other side.
 *
 * In any swap the taker's balance for the mint moves one way and the pool's
 * vault moves the other. So: among the transaction's token balances for this
 * mint, the entries whose delta has the opposite sign to the taker's belong to
 * the pool. Their `owner` is the pool authority, and paging *that* account's
 * signatures gives the pool's whole trade history.
 *
 * This is a field read, not a decode. It works identically for a Raydium pool,
 * a Whirlpool and a pump.fun bonding curve, because all three must move a token
 * balance to trade — whereas each encodes its instructions differently and
 * changes them without notice.
 *
 * Returns every candidate rather than one. A route that hops two pools produces
 * two, and picking arbitrarily would silently reconstruct the wrong price path.
 * The caller decides, and `getPoolSwaps` reports how many it saw.
 */
export function resolvePoolAccounts(
  tx: ParsedTransactionWithMeta,
  mint: Address,
  taker: Address,
): Address[] {
  const meta = tx.meta;
  if (meta == null) return [];

  const pre = (meta.preTokenBalances ?? []) as Array<{
    accountIndex: number;
    mint?: string;
    owner?: string;
    uiTokenAmount?: { amount?: string };
  }>;
  const post = (meta.postTokenBalances ?? []) as typeof pre;

  const amountAt = (list: typeof pre, index: number): bigint => {
    const hit = list.find((entry) => entry.accountIndex === index);
    return BigInt(hit?.uiTokenAmount?.amount ?? '0');
  };

  const indices = new Set(
    [...pre, ...post].filter((entry) => entry.mint === mint).map((entry) => entry.accountIndex),
  );

  let takerDirection = 0n;
  const byOwner = new Map<string, bigint>();

  for (const index of indices) {
    const owner =
      post.find((entry) => entry.accountIndex === index)?.owner ??
      pre.find((entry) => entry.accountIndex === index)?.owner;
    if (owner === undefined) continue;

    const delta = amountAt(post, index) - amountAt(pre, index);
    if (owner === taker) takerDirection += delta;
    else byOwner.set(owner, (byOwner.get(owner) ?? 0n) + delta);
  }

  if (takerDirection === 0n) return [];

  // Opposite sign to the taker, and non-zero. An account that netted to zero
  // across the transaction was a pass-through, not a counterparty.
  return [...byOwner]
    .filter(([, delta]) => delta !== 0n && (delta > 0n) !== (takerDirection > 0n))
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
    .map(([owner]) => owner);
}

// ---------------------------------------------------------------------------
// Swap extraction
// ---------------------------------------------------------------------------

/**
 * Turn one transaction into a `PoolSwap`, priced from the taker's side.
 *
 * `swapParser` is asked about the *pool authority* rather than about any
 * particular trader: the pool is a party to every swap in the file, so it is
 * the one address guaranteed to be present. Its deltas are the mirror image of
 * the taker's, so both legs are negated to express the trade the way a copier
 * would experience it.
 *
 * Returns undefined for anything that is not a clean single-mint swap — a
 * failed transaction, a liquidity add, a multi-mint route. Those are not price
 * observations and must not become points on the path.
 */
export function toPoolSwap(
  tx: ParsedTransactionWithMeta,
  poolAccount: Address,
  mint: Address,
  transactionIndex: number,
): PoolSwap | undefined {
  const result = parseSwap(tx, poolAccount, { source: 'gapfill', observedAt: 0 });
  if (result.kind !== 'swap') return undefined;

  const swap = result.swap;
  if (swap.mint !== mint || swap.mint === WSOL) return undefined;
  // No timestamp means the observation cannot be placed on the path at all.
  if (swap.blockTime == null) return undefined;
  if (swap.tokenAmount === 0n || swap.solAmount === 0n) return undefined;

  // The pool's `buy` is the taker's sell. Invert so every field below is stated
  // from the perspective of somebody trading against this pool.
  const poolBought = swap.side === 'buy';
  const isBuy = !poolBought;

  const tokenDelta = isBuy ? swap.tokenAmount : -swap.tokenAmount;
  const solDelta = isBuy ? -swap.solAmount : swap.solAmount;

  const priceSol =
    Math.abs(Number(swap.solAmount) / 1e9) /
    Math.abs(Number(swap.tokenAmount) / 10 ** swap.decimals);
  if (!Number.isFinite(priceSol) || priceSol <= 0) return undefined;

  return {
    mint,
    signature: swap.signature,
    blockTime: swap.blockTime * 1_000,
    slot: swap.slot,
    solDelta,
    tokenDelta,
    priceSol,
    venue: swap.venue,
    isBuy,
    transactionIndex,
  };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Signature pages are cached, transactions are not.
 *
 * Pages are small, cheap to store and are what makes a rerun free at the paging
 * stage. Transactions are large and are only fetched for the narrow windows a
 * replay actually needs, so caching them would trade a lot of disk for little.
 */
function cachePath(cacheDir: string, mint: Address): string {
  return join(cacheDir, mint, 'signatures.json');
}

export function readCache(cacheDir: string, mint: Address): SignaturePage[] | undefined {
  const path = cachePath(cacheDir, mint);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SignaturePage[];
  } catch {
    return undefined;
  }
}

export function writeCache(cacheDir: string, mint: Address, pages: SignaturePage[]): void {
  const path = cachePath(cacheDir, mint);
  mkdirSync(join(cacheDir, mint), { recursive: true });
  writeFileSync(path, JSON.stringify(pages), 'utf8');
}

// ---------------------------------------------------------------------------
// getPoolSwaps
// ---------------------------------------------------------------------------

export interface PoolWindow {
  mint: Address;
  /** The pool authority, from `resolvePoolAccounts`. */
  poolAccount: Address;
  /**
   * The intervals to price, in millis. A UNION of narrow windows, not one wide
   * span.
   *
   * This distinction is the difference between a run that finishes and one that
   * does not. A mint traded on Monday and again on Friday has two windows of a
   * few minutes each; expressing that as `min(from) .. max(to)` is four days
   * wide and pulls every transaction the pool saw in between — tens of
   * thousands of `getTransaction` calls to price two entries. Measured: one such
   * mint stalled a 150-trip run for nine minutes before it was killed.
   */
  intervals: ReadonlyArray<{ fromTs: number; toTs: number }>;
}

export interface PoolSwapsResult {
  swaps: PoolSwap[];
  /** Signatures inside the intervals, before any transaction was fetched. */
  signaturesInWindow: number;
  /** True when the walk hit `maxSignatures` before reaching the earliest interval. */
  truncated: boolean;
  /** True when `maxFetches` clipped the transactions actually priced. */
  fetchCapped: boolean;
  fromCache: boolean;
}

/**
 * Every swap against `poolAccount` inside `[fromTs, toTs]`, oldest first.
 *
 * Two stages, and the split is what makes this affordable. Signature pages
 * carry `blockTime`, so the window is applied *before* any transaction is
 * fetched — one cheap call per thousand signatures, then one expensive call per
 * signature that actually falls inside a window somebody asked about. Fetching
 * transactions first would multiply the cost by the pool's whole lifetime.
 */
export async function getPoolSwaps(
  window: PoolWindow,
  deps: PoolHistoryDeps,
): Promise<PoolSwapsResult> {
  const cacheDir = deps.cacheDir ?? DEFAULT_CACHE_DIR;
  const maxSignatures = deps.maxSignatures ?? DEFAULT_MAX_SIGNATURES;
  const maxFetches = deps.maxFetches ?? DEFAULT_MAX_FETCHES;
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;

  const earliest = Math.min(...window.intervals.map((i) => i.fromTs));

  let pages = readCache(cacheDir, window.mint);
  let truncated = false;
  const fromCache = pages !== undefined;

  if (pages === undefined) {
    pages = [];
    let before: string | undefined;

    for (;;) {
      const page = await deps.rpc.getSignaturesForAddress(window.poolAccount, {
        limit: PAGE_SIZE,
        ...(before === undefined ? {} : { before }),
      });
      if (page.length === 0) break;
      pages.push(...page);

      const oldest = page[page.length - 1];
      // Past the earliest interval: everything older is irrelevant to this mint.
      if (oldest?.blockTime != null && oldest.blockTime * 1_000 < earliest) break;
      if (page.length < PAGE_SIZE) break;
      if (pages.length >= maxSignatures) {
        truncated = true;
        break;
      }
      before = oldest?.signature;
      if (before === undefined) break;
    }

    writeCache(cacheDir, window.mint, pages);
  }

  const covered = (ts: number): boolean =>
    window.intervals.some((interval) => ts >= interval.fromTs && ts <= interval.toTs);

  const inWindow = pages.filter(
    (page) => page.err == null && page.blockTime != null && covered(page.blockTime * 1_000),
  );

  // Bounded, and the bound is reported rather than silent. A pool that traded
  // 40,000 times inside the intervals cannot be priced exhaustively at any
  // sensible cost, and a caller must be able to tell "quiet pool" from
  // "clipped".
  const fetchCapped = inWindow.length > maxFetches;
  const toFetch = fetchCapped ? inWindow.slice(0, maxFetches) : inWindow;

  const swaps: PoolSwap[] = [];
  for (let i = 0; i < toFetch.length; i += concurrency) {
    const batch = toFetch.slice(i, i + concurrency);
    const fetched = await Promise.all(
      batch.map(async (entry) => ({
        entry,
        tx: await deps.rpc.getTransaction(entry.signature),
      })),
    );
    for (const { entry, tx } of fetched) {
      if (tx === null) continue;
      // `transactionIndex` is not on the signature listing for every provider.
      // Falling back to 0 makes the signature tie-break in `orderPoolSwaps` the
      // thing that keeps ordering stable, which is why that tie-break exists.
      const index = (entry as { transactionIndex?: number }).transactionIndex ?? 0;
      const swap = toPoolSwap(tx, window.poolAccount, window.mint, index);
      if (swap !== undefined) swaps.push(swap);
    }
  }

  return {
    swaps: orderPoolSwaps(swaps),
    signaturesInWindow: inWindow.length,
    truncated,
    fetchCapped,
    fromCache,
  };
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * First swap at or after `ts`, or undefined.
 *
 * Linear rather than a binary search on purpose: the caller holds one already
 * sorted array per mint and asks it eight questions per round trip, so the scan
 * is not the cost, and a binary search over a non-strict predicate is a
 * well-known place to put an off-by-one that silently shifts every entry price
 * by one swap.
 */
export function firstAtOrAfter(swaps: readonly PoolSwap[], ts: number): PoolSwap | undefined {
  return swaps.find((swap) => swap.blockTime >= ts);
}

/** The swap closest in time to `ts`. Ties resolve to the earlier one. */
export function nearestTo(swaps: readonly PoolSwap[], ts: number): PoolSwap | undefined {
  let best: PoolSwap | undefined;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const swap of swaps) {
    const gap = Math.abs(swap.blockTime - ts);
    if (gap < bestGap) {
      best = swap;
      bestGap = gap;
    }
  }
  return best;
}
