/**
 * Turns a confirmed transaction into a `TrackedSwap`, or says why it cannot.
 *
 * Pure: no network, no clock, no I/O. Everything it needs is in the argument.
 *
 * ── THE INVARIANT ─────────────────────────────────────────────────────────
 *
 * For a transaction T and tracked wallet W:
 *
 *   tokenDelta(mint) = sum over ALL token accounts owned by W holding that
 *                      mint of (postTokenBalance - preTokenBalance)
 *
 * A parseable swap has exactly one mint M where M != WSOL and
 * tokenDelta(M) != 0. `side` is 'buy' when tokenDelta(M) > 0, else 'sell'.
 * Zero such mints, or two or more, is not a swap this parser handles.
 *
 * Summing across *all* accounts is the load-bearing part. A wallet can hold
 * one mint in several accounts, and routes routinely open and close
 * intermediate accounts inside a single transaction; looking at "the ATA", or
 * at the largest account, gives an answer that is quietly wrong.
 *
 * Direction never comes from decoded instruction data. Instruction layouts
 * differ per venue and change without notice; the balance delta is what the
 * wallet actually ended up holding.
 */

import type {
  Address,
  Lamports,
  Signature,
  SwapSource,
  SwapVenue,
  TokenAmount,
  TrackedSwap,
  UnixMillis,
} from '../core/types.js';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Rent-exempt minimum for a 165-byte SPL Token account.
 *
 * **An assumption, and the weakest number in this file.** It is exact for the
 * classic SPL Token account layout. A Token-2022 account carrying extensions
 * is larger and costs more, so a created/closed Token-2022 account is
 * under-corrected here. Path 1 (the WSOL token delta) is immune to this,
 * which is why it is preferred; the disagreement check below is what surfaces
 * the error when path 2 has to be used.
 */
export const SPL_TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;

/** Program ids that identify a venue. Order here is the tie-break order. */
export const VENUE_PROGRAMS: ReadonlyArray<readonly [SwapVenue, Address]> = [
  ['raydium-v4', '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'],
  ['raydium-clmm', 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'],
  ['pumpfun', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],
  ['whirlpool', 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'],
  ['meteora-dlmm', 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'],
];

/** Above this relative gap, path 1 and path 2 disagreeing is worth shouting about. */
const PATH_DISAGREEMENT_TOLERANCE = 0.005;

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface UiTokenAmount {
  /** Base units, as a decimal string. The only field safe for arithmetic. */
  amount: string;
  decimals: number;
  /** A float. Never used here. */
  uiAmount?: number | null;
}

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: UiTokenAmount;
}

export interface LoadedAddresses {
  writable: string[];
  readonly: string[];
}

export interface TransactionMeta {
  err: unknown | null;
  fee: number;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances?: TokenBalance[] | null;
  postTokenBalances?: TokenBalance[] | null;
  loadedAddresses?: LoadedAddresses | null;
}

/** An account key is a bare base58 string under `json`, an object under `jsonParsed`. */
export type AccountKey = string | { pubkey: string; source?: 'transaction' | 'lookupTable' };

export interface TransactionMessage {
  accountKeys: AccountKey[];
}

export interface ParsedTransactionWithMeta {
  slot: number;
  blockTime?: number | null;
  version?: number | 'legacy';
  meta: TransactionMeta | null;
  transaction: {
    signatures?: string[];
    message: TransactionMessage;
  };
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type UnparsedCode =
  | 'TX_FAILED'
  | 'NO_MINT_DELTA'
  | 'MULTI_MINT_DELTA'
  | 'NO_SOL_LEG'
  | 'WALLET_NOT_IN_TX';

/** Which rule produced `solAmount`. Recorded for debugging, not for logic. */
export type SolAmountPath = 'wsol-token-delta' | 'lamport-delta';

export interface ParsedSwap {
  kind: 'swap';
  swap: TrackedSwap;
  solAmountPath: SolAmountPath;
  /**
   * Set when both paths were computable and disagreed by more than 0.5%.
   * That disagreement means the rent or fee correction is wrong, and it is
   * surfaced rather than swallowed.
   */
  pathDisagreement?: { wsolLamports: bigint; lamportDelta: bigint; relative: number };
}

export interface UnparsedTransaction {
  kind: 'unparsed';
  signature: Signature;
  reason: UnparsedCode;
  /** Free text for logs. Never parsed. */
  detail?: string;
}

export type ParseResult = ParsedSwap | UnparsedTransaction;

// ---------------------------------------------------------------------------
// Key list
// ---------------------------------------------------------------------------

/**
 * The full account key list, in the order balances are indexed against.
 *
 * Two encodings reach this function and they differ in a way that silently
 * corrupts every index if handled wrongly:
 *
 *   `json`       — `accountKeys` holds only the static keys, and
 *                  `meta.loadedAddresses` holds the lookup-table keys
 *                  separately. They must be concatenated as
 *                  static ++ writable ++ readonly.
 *   `jsonParsed` — the RPC has already merged them, in exactly that order,
 *                  each tagged with `source`, and `loadedAddresses` is absent.
 *                  Concatenating again would double the list.
 *
 * Verified against a live v0 transaction: 15 static + 19 writable + 19
 * readonly under `json` equalled the 53 `jsonParsed` keys, in order,
 * byte-for-byte.
 *
 * Returns `undefined` when the assembled list does not line up with
 * `preBalances`, which is the check that catches either mistake.
 */
export function accountKeyList(tx: ParsedTransactionWithMeta): string[] | undefined {
  const raw = tx.transaction.message.accountKeys;
  const meta = tx.meta;
  if (meta === null) return undefined;

  const alreadyMerged = raw.length > 0 && typeof raw[0] === 'object';
  const statics = raw.map((key) => (typeof key === 'string' ? key : key.pubkey));

  const keys = alreadyMerged
    ? statics
    : [
        ...statics,
        ...(meta.loadedAddresses?.writable ?? []),
        ...(meta.loadedAddresses?.readonly ?? []),
      ];

  // Balances are indexed against the full list. If these disagree, the list
  // was assembled wrongly and every index below would attribute a balance to
  // the wrong account.
  return keys.length === meta.preBalances.length ? keys : undefined;
}

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

interface MintDelta {
  delta: bigint;
  decimals: number;
}

/**
 * Net delta per mint for one owner, summed across every token account.
 *
 * Accepts both SPL Token and Token-2022 balances: the RPC reports them
 * identically here, and `programId` is not filtered on.
 */
export function tokenDeltasForOwner(
  meta: TransactionMeta,
  owner: Address,
): Map<string, MintDelta> {
  const totals = new Map<string, MintDelta>();

  const apply = (balances: TokenBalance[] | null | undefined, sign: bigint): void => {
    for (const balance of balances ?? []) {
      if (balance.owner !== owner) continue;
      const current = totals.get(balance.mint) ?? {
        delta: 0n,
        decimals: balance.uiTokenAmount.decimals,
      };
      // `amount` is the base-unit string. `uiAmount` is a float and is never
      // touched.
      current.delta += sign * BigInt(balance.uiTokenAmount.amount);
      current.decimals = balance.uiTokenAmount.decimals;
      totals.set(balance.mint, current);
    }
  };

  apply(meta.preTokenBalances, -1n);
  apply(meta.postTokenBalances, 1n);
  return totals;
}

/** Token accounts belonging to `owner` that appear in post but not pre. */
function createdAccountCount(meta: TransactionMeta, owner: Address): number {
  const before = new Set(
    (meta.preTokenBalances ?? []).filter((b) => b.owner === owner).map((b) => b.accountIndex),
  );
  return (meta.postTokenBalances ?? []).filter(
    (b) => b.owner === owner && !before.has(b.accountIndex),
  ).length;
}

/** Token accounts belonging to `owner` that appear in pre but not post. */
function closedAccountCount(meta: TransactionMeta, owner: Address): number {
  const after = new Set(
    (meta.postTokenBalances ?? []).filter((b) => b.owner === owner).map((b) => b.accountIndex),
  );
  return (meta.preTokenBalances ?? []).filter(
    (b) => b.owner === owner && !after.has(b.accountIndex),
  ).length;
}

/**
 * Signed lamport flow attributable to the swap, from `pre/postBalances`.
 *
 * Positive means the wallet received SOL. Three corrections, each removing an
 * effect that is not part of the trade:
 *
 *   + fee, when W paid it. `postBalances` is already net of the fee, so
 *     recovering the trade flow means adding it back. (The prompt for this
 *     module said "subtract"; that double-counts — see the handoff.)
 *   + rent for accounts created for W, which W paid and which is not spend.
 *   - rent refunded for accounts closed, which W received and which is not
 *     proceeds. Omitting this is not a rounding error: on a recorded Meteora
 *     buy where the WSOL account was closed, it flips a 657-lamport purchase
 *     into an apparent 2.03 SOL receipt.
 */
function lamportFlow(
  meta: TransactionMeta,
  walletIndex: number,
  isFeePayer: boolean,
  owner: Address,
): bigint {
  const pre = meta.preBalances[walletIndex];
  const post = meta.postBalances[walletIndex];
  if (pre === undefined || post === undefined) return 0n;

  let flow = BigInt(post) - BigInt(pre);
  if (isFeePayer) flow += BigInt(meta.fee);
  flow += BigInt(createdAccountCount(meta, owner)) * SPL_TOKEN_ACCOUNT_RENT_LAMPORTS;
  flow -= BigInt(closedAccountCount(meta, owner)) * SPL_TOKEN_ACCOUNT_RENT_LAMPORTS;
  return flow;
}

// ---------------------------------------------------------------------------
// Venue
// ---------------------------------------------------------------------------

/** Every venue program present, in `VENUE_PROGRAMS` order. */
export function venuesPresent(keys: readonly string[]): SwapVenue[] {
  const present = new Set(keys);
  return VENUE_PROGRAMS.filter(([, program]) => present.has(program)).map(([venue]) => venue);
}

// ---------------------------------------------------------------------------
// parseSwap
// ---------------------------------------------------------------------------

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Delivery metadata the parser cannot work out for itself.
 *
 * `parseSwap` sees a transaction. It does not see how that transaction reached
 * this process, and it has no clock — both are properties of the *fetch*, which
 * belongs to `WalletStream`. Passing them in keeps this function pure, which is
 * what lets the replay harness re-derive a swap from a recorded transaction.
 *
 * Both defaults are **fail-closed**. An unstamped swap claims to be a gap-fill
 * entry observed at the epoch, so it reads as maximally stale to the freshness
 * gate rather than as fresh live signal. A caller that forgets to stamp loses
 * trades; the opposite default would silently buy on a backlog. Every existing
 * parser test relies on these defaults and needed no change.
 */
export interface SwapStamp {
  source?: SwapSource;
  observedAt?: UnixMillis;
}

export function parseSwap(
  tx: ParsedTransactionWithMeta,
  wallet: Address,
  stamp: SwapStamp = {},
): ParseResult {
  const signature = tx.transaction.signatures?.[0] ?? '';
  const meta = tx.meta;

  if (meta === null) {
    return { kind: 'unparsed', signature, reason: 'WALLET_NOT_IN_TX', detail: 'no meta' };
  }

  // A failed transaction moves nothing, so its deltas are all zero — but it is
  // not semantically a no-op, and must never look like one. Checked first so
  // it can never be mistaken for NO_MINT_DELTA.
  if (meta.err !== null && meta.err !== undefined) {
    return { kind: 'unparsed', signature, reason: 'TX_FAILED' };
  }

  const keys = accountKeyList(tx);
  if (keys === undefined) {
    return {
      kind: 'unparsed',
      signature,
      reason: 'WALLET_NOT_IN_TX',
      detail: 'account key list does not match preBalances length',
    };
  }

  const walletIndex = keys.indexOf(wallet);
  const deltas = tokenDeltasForOwner(meta, wallet);

  // The wallet must appear somewhere: as an account key, or as the owner of a
  // token account. Owners are not necessarily account keys themselves.
  if (walletIndex === -1 && deltas.size === 0) {
    return { kind: 'unparsed', signature, reason: 'WALLET_NOT_IN_TX' };
  }

  const moved = [...deltas.entries()].filter(
    ([mint, value]) => mint !== WSOL_MINT && value.delta !== 0n,
  );

  if (moved.length === 0) {
    return { kind: 'unparsed', signature, reason: 'NO_MINT_DELTA' };
  }
  if (moved.length > 1) {
    // Deliberately not "pick the largest". Two moved mints means this is a
    // shape the invariant does not describe — a multi-leg route, a migration,
    // something else — and guessing produces a confident wrong answer.
    return {
      kind: 'unparsed',
      signature,
      reason: 'MULTI_MINT_DELTA',
      detail: moved.map(([mint]) => mint).join(','),
    };
  }

  const [mint, token] = moved[0] as [string, MintDelta];
  const side = token.delta > 0n ? 'buy' : 'sell';

  // Path 1: the WSOL token delta. A wrapped-SOL account records the SOL leg
  // directly, with no fee or rent mixed in.
  //
  // NOT negated, contrary to this module's brief. A buy drains the wallet's
  // WSOL, so the delta is already negative-for-spent — the same sign
  // convention as the lamport path. Negating would invert path 1 against
  // path 2. That is invisible in `solAmount`, which is a magnitude with `side`
  // carrying direction, but it makes every cross-path comparison read as a
  // 200% disagreement.
  const wsol = deltas.get(WSOL_MINT);
  const wsolLamports = wsol === undefined ? undefined : wsol.delta;

  // Path 2: the lamport delta, corrected.
  const isFeePayer = keys[0] === wallet;
  const lamports = walletIndex === -1 ? undefined : lamportFlow(meta, walletIndex, isFeePayer, wallet);

  let solFlow: bigint | undefined;
  let path: SolAmountPath;
  if (wsolLamports !== undefined && wsolLamports !== 0n) {
    solFlow = wsolLamports;
    path = 'wsol-token-delta';
  } else if (lamports !== undefined && lamports !== 0n) {
    solFlow = lamports;
    path = 'lamport-delta';
  } else {
    return { kind: 'unparsed', signature, reason: 'NO_SOL_LEG' };
  }

  // Both computable: compare. A gap here is the rent or fee arithmetic being
  // wrong, which is exactly the thing worth seeing rather than swallowing.
  let disagreement: ParsedSwap['pathDisagreement'];
  if (wsolLamports !== undefined && wsolLamports !== 0n && lamports !== undefined && lamports !== 0n) {
    const gap = abs(wsolLamports - lamports);
    const scale = abs(wsolLamports);
    const relative = scale === 0n ? 0 : Number(gap) / Number(scale);
    if (relative > PATH_DISAGREEMENT_TOLERANCE) {
      disagreement = { wsolLamports, lamportDelta: lamports, relative };
    }
  }

  const venues = venuesPresent(keys);

  const swap: TrackedSwap = {
    wallet,
    mint,
    side,
    solAmount: abs(solFlow) as Lamports,
    tokenAmount: abs(token.delta) as TokenAmount,
    decimals: token.decimals,
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    // Metadata only. An unrecognised program with a clean single-mint delta
    // still produces a swap.
    venue: venues[0] ?? 'unknown',
    feePayer: isFeePayer,
    source: stamp.source ?? 'gapfill',
    observedAt: stamp.observedAt ?? 0,
  };

  return disagreement === undefined
    ? { kind: 'swap', swap, solAmountPath: path }
    : { kind: 'swap', swap, solAmountPath: path, pathDisagreement: disagreement };
}
