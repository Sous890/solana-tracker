/**
 * Shared domain types for solana-tracker.
 *
 * This module is types-only: no runtime values, no I/O, no dependencies.
 * Everything here describes *what* the system exchanges, never *how* it is
 * fetched or stored.
 *
 * Unit conventions, enforced by the type system wherever it matters:
 *  - `*Lamports` / `*Amount` / `tokens*` : exact `bigint` base units — lamports
 *                          for SOL, 10^decimals for SPL tokens. Everything the
 *                          bot owns or owes is one of these. All accounting is
 *                          done on them; they never drift and never round.
 *  - `*Sol`              : whole SOL as `number`. **Derived, display only.**
 *                          Never an input to an accounting decision.
 *  - `*Bps`              : basis points, integer, 100 bps = 1%.
 *  - `*Pct`              : percent as `number`, 1.5 means 1.5%.
 *  - timestamps          : `UnixMillis`, always UTC.
 *
 * Token amounts are `bigint` rather than `number` for two concrete reasons.
 * Float whole-token arithmetic does not land on zero, so a full exit leaves
 * phantom dust that keeps a position open and unsellable; and a mint with 1e9
 * supply at 9 decimals has 1e18 base units, past the ~9e15 limit for exact
 * integers in a float64.
 */

/** Base58-encoded Solana public key (mint, wallet, program, pool). */
export type Address = string;

/** Base58-encoded transaction signature. */
export type Signature = string;

/** Milliseconds since the Unix epoch, UTC. */
export type UnixMillis = number;

/** Amount in base units (lamports / 10^decimals). Never a float. */
export type RawAmount = bigint;

/** Exact SOL, in lamports. 1 SOL = 1e9 lamports. */
export type Lamports = bigint;

/** Exact token quantity, in base units of that mint (10^decimals per token). */
export type TokenAmount = bigint;

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------

/** An SPL token mint, as far as the tracker cares about it. */
export interface Mint {
  /** Mint account address. Primary key everywhere downstream. */
  address: Address;
  /** Ticker from metadata, e.g. `BONK`. Unverified, may collide. */
  symbol: string;
  /** On-chain decimals for the mint. Authoritative for raw <-> whole math. */
  decimals: number;
  /** Human-readable name from metadata. Unverified. */
  name: string;
}

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

/** One hop of a swap route, as reported by the aggregator. */
export interface RouteStep {
  /** Pool / AMM account address for this hop. */
  ammKey: Address;
  /** Venue label, e.g. `Raydium CLMM`, `Orca Whirlpool`. */
  label: string;
  inMint: Address;
  outMint: Address;
  inAmount: RawAmount;
  outAmount: RawAmount;
  /** Fee charged by this hop, in base units of the hop's fee mint. */
  feeAmount: RawAmount;
  /** Share of the parent leg routed through this hop, 0-100. */
  percent: number;
}

/**
 * A priced swap route at a point in time.
 *
 * Invariant: a Quote is a snapshot, not a promise — it is only actionable
 * while `fetchedAt` is inside the configured staleness window.
 */
export interface Quote {
  inMint: Address;
  outMint: Address;
  /** Amount offered, base units of `inMint`. */
  inAmount: RawAmount;
  /** Amount expected out before slippage, base units of `outMint`. */
  outAmount: RawAmount;
  /** Estimated price impact, percent (0.42 means 0.42%). */
  priceImpactPct: number;
  /** Ordered hops the aggregator intends to use. May be empty for direct fills. */
  routePlan: RouteStep[];
  fetchedAt: UnixMillis;
}

// ---------------------------------------------------------------------------
// OrderIntent
// ---------------------------------------------------------------------------

export type Side = 'buy' | 'sell';

/**
 * A decision to trade, produced by strategy and consumed by execution.
 *
 * Invariant: exactly one of `amountLamports` / `amountTokens` is set.
 *  - `buy`  is denominated in SOL    -> `amountLamports`
 *  - `sell` is denominated in tokens -> `amountTokens`
 * An intent is inert: creating one must never touch the network.
 */
export interface OrderIntent {
  /** Stable id; carried onto the resulting Fill(s) for reconciliation. */
  id: string;
  side: Side;
  /** The non-SOL side of the pair. */
  mint: Address;
  /** Lamports to spend. Set for `buy`. */
  amountLamports?: Lamports;
  /** Token base units to sell. Set for `sell`. */
  amountTokens?: TokenAmount;
  /** Hard ceiling on tolerated slippage, basis points. */
  maxSlippageBps: number;
  /** Why the strategy wants this, for the audit log and the UI. */
  reason: string;

  // -- signal provenance ----------------------------------------------------
  //
  // Both optional, and the absence is meaningful rather than a gap: an intent
  // with no `signalAt` did not originate from an observed wallet swap. An
  // operator's manual buy and every `onPriceTick` exit are in that category,
  // and `guards.ts` deliberately does not apply the freshness gate to them —
  // there is no signal whose age could be wrong.
  //
  // Stamped by `StrategyRunner`, never by the strategy. A strategy is untrusted
  // code (see `services/strategyRunner.ts`); one that could declare its own
  // signal fresh could walk an arbitrarily old backlog straight past the gate.

  /**
   * When the originating swap happened, as `UnixMillis`.
   *
   * Derived from the swap's `blockTime` (which is in *seconds*) where the RPC
   * supplied one, and from `observedAt` where it did not. See
   * `TrackedSwap.blockTime` for why that fallback is not merely convenience.
   */
  signalAt?: UnixMillis;
  /**
   * `now - signalAt` at the moment the intent was created.
   *
   * Frozen at creation rather than recomputed downstream: the guard layer, the
   * ledger row and the audit log must all agree on one number, and a value that
   * drifted between the gate and the record would make a rejection impossible
   * to reconstruct afterwards.
   */
  signalAgeMs?: number;
}

// ---------------------------------------------------------------------------
// Fill
// ---------------------------------------------------------------------------

/**
 * Fields common to every fill, simulated or live.
 *
 * Sign convention (from the bot's perspective):
 *  - buy  : `tokensDelta > 0`, `lamportsDelta < 0`
 *  - sell : `tokensDelta < 0`, `lamportsDelta > 0`
 * `feesLamports` is always positive and is *not* folded into `lamportsDelta`.
 */
interface FillBase {
  /** The OrderIntent this settles. */
  intentId: string;
  side: Side;
  mint: Address;
  /** Change in token balance, base units, signed. Exact. */
  tokensDelta: TokenAmount;
  /** Change in SOL balance excluding fees, lamports, signed. Exact. */
  lamportsDelta: Lamports;
  /**
   * The mint's decimals at fill time.
   *
   * Carried on the fill because base units are meaningless without it: nothing
   * downstream can render an amount, or derive a price, without knowing the
   * scale. Recording it here means a position can be displayed from the ledger
   * alone, with no metadata lookup.
   */
  decimals: number;
  /** Network + priority + platform fees paid, in lamports. Always >= 0. Exact. */
  feesLamports: Lamports;
  /**
   * Realized slippage vs. the quote that motivated the intent, in bps.
   *
   * `null` when it is not measurable rather than zero. A fill reconstructed
   * from chain during orphan acknowledgement has no surviving quote to compare
   * against, and recording that as `0` would put synthetic perfect executions
   * into any sample calibrated on this field. Consumers that aggregate slippage
   * must exclude nulls — the type forces the decision instead of hiding it.
   */
  slippageBps: number | null;
  /**
   * When the fill was observed. **Local wall clock, not chain time** — it is
   * therefore not stable across a crash-retry and must never be used as an
   * identity. See `Fill` below.
   */
  at: UnixMillis;
}

/** A fill in paper mode. No transaction was ever submitted, so there is no signature. */
export interface SimulatedFill extends FillBase {
  simulated: true;
  /**
   * Structurally forbidden rather than merely absent: a simulated fill that
   * carried a signature would be claiming a transaction that does not exist.
   */
  signature?: never;
}

/** A fill in live mode, settled by a real transaction. */
export interface LiveFill extends FillBase {
  simulated: false;
  /**
   * The confirming transaction. Required, because it is the fill's identity in
   * the ledger — chain-assigned, globally unique, and identical when a retry
   * re-observes the same confirmed transaction.
   */
  signature: Signature;
}

/**
 * The realized outcome of an OrderIntent — the only thing that moves a Position.
 *
 * Discriminated on `simulated` so that live fills cannot exist without a
 * signature. The ledger keys live fills on that signature; the paper fallback
 * (`intentId:mint`) is unreachable in live mode by construction, not by
 * convention, because narrowing `simulated: false` guarantees the field.
 */
export type Fill = SimulatedFill | LiveFill;

// ---------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------

/**
 * Two states, not three.
 *
 * `'closing'` was removed on 2026-08-03 after a grep established that nothing
 * had ever produced it: the ledger writes `tokens > 0n ? 'open' : 'closed'`,
 * and no service set it either. Three reasons it was deleted rather than
 * implemented, in the order they decided it:
 *
 * 1. **It is not derivable from fills.** `ledger.ts` rule 2 is that positions
 *    are derived, never asserted — that is what makes a position disagreeing
 *    with the fills impossible by construction. "A sell is in flight" is not a
 *    fact about any fill, so persisting it would have to be an assertion, and
 *    the first assertion is the one that ends the guarantee.
 * 2. **A crash would strand it.** In-flight is per-process runtime state; the
 *    positions table is durable and shared. A process that died between setting
 *    `closing` and resolving it would leave a position stuck in that state with
 *    nothing left running to clear it — a holding that reads as un-exitable
 *    forever, which is the exact failure this codebase is arranged to prevent.
 * 3. **The information already exists, authoritatively.** `guards.ts` holds
 *    `sellsInFlight` and enforces it synchronously before any await, which is
 *    stronger than anything a reader of a persisted flag could do. A second,
 *    weaker copy invites the assumption that checking it is sufficient.
 *
 * If a future UI wants to show "exiting", it should read the guard layer's
 * in-flight set through a port, not a column.
 */
export type PositionState = 'open' | 'closed';

/**
 * Aggregate of all Fills for one mint.
 *
 * Invariants:
 *  - `tokens >= 0n`; `state === 'closed'` iff `tokens === 0n`, exactly. There
 *    is no dust threshold: with exact base units a full exit lands on zero, and
 *    a leftover base unit means the position genuinely still holds one.
 *  - `costLamports` is the fee-inclusive cost basis of the tokens still held.
 *    It rises on buys and is relieved proportionally on sells, in integer math.
 *  - `avgEntrySol`, `lastPriceSol` and `unrealizedSol` are **derived for
 *    display**, computed from the exact fields on read. Never accounting inputs.
 */
export interface Position {
  mint: Address;
  /** Current holdings, base units. Exact. */
  tokens: TokenAmount;
  /** Fee-inclusive cost basis of the held tokens, lamports. Exact. */
  costLamports: Lamports;
  /** The mint's decimals, needed to render `tokens` and the derived prices. */
  decimals: number;
  /** Timestamp of the first buy that opened this position. */
  openedAt: UnixMillis;
  /** Average entry, SOL per whole token, fee-inclusive. Derived. */
  avgEntrySol: number;
  /** Most recent mark price, SOL per whole token. Derived. */
  lastPriceSol: number;
  /** Mark-to-market P&L in SOL. Derived — never the source of truth. */
  unrealizedSol: number;
  state: PositionState;
}

// ---------------------------------------------------------------------------
// BotState
// ---------------------------------------------------------------------------

export type BotMode = 'paper' | 'live';
export type BotStatus = 'idle' | 'running' | 'stopping';

/**
 * Runtime state of the tracker process.
 *
 * Invariants:
 *  - `killSwitchEngaged` blocks every new OrderIntent regardless of `status`,
 *    and can only be cleared by an explicit operator action.
 *  - `startedAt` is set iff `status !== 'idle'`.
 *  - `mode` is fixed for the lifetime of a run; switching requires a restart.
 */
export interface BotState {
  mode: BotMode;
  status: BotStatus;
  /** When the current run began. Absent while `idle`. */
  startedAt?: UnixMillis;
  /** Emergency stop: no new intents, existing positions are left as-is. */
  killSwitchEngaged: boolean;
}

// ---------------------------------------------------------------------------
// TrackedSwap
// ---------------------------------------------------------------------------

/** Where a swap executed. `unknown` never blocks parsing — it is metadata. */
export type SwapVenue =
  | 'raydium-v4'
  | 'raydium-clmm'
  | 'pumpfun'
  | 'whirlpool'
  | 'meteora-dlmm'
  | 'unknown';

/**
 * A swap observed on a wallet the bot mirrors.
 *
 * Direction and size come from the wallet's net token balance deltas, never
 * from decoded instruction data — a route can open and close intermediate
 * accounts inside one transaction, and only the summed delta describes what
 * the wallet actually ended up holding.
 *
 * Provisional: emitted at `confirmed` commitment, which is reorg-exposed. The
 * ledger is the authority on what the bot itself holds.
 */
/**
 * How a swap reached us.
 *
 * `live`    — arrived on the open websocket, seen within a round trip of the
 *             block landing.
 * `gapfill` — recovered by paging `getSignaturesForAddress` from the cursor.
 *             Arbitrarily old: on startup with a cold cursor this is the last
 *             100 signatures whatever their age, and after a long disconnect it
 *             is everything missed while the socket was down.
 *
 * Metadata for counting and for the UI. It is deliberately **not** what the
 * freshness gate reads — the gate reads the age, because a gap fill run one
 * second after a block landed is fresh and a live event delivered behind a
 * stalled drain queue is not. Source and age answer different questions.
 */
export type SwapSource = 'live' | 'gapfill';

export interface TrackedSwap {
  /** The tracked wallet this is attributed to. */
  wallet: Address;
  /** The non-SOL side of the pair. */
  mint: Address;
  side: Side;
  /** Magnitude of the SOL leg, in lamports. Always positive; `side` carries direction. */
  solAmount: Lamports;
  /** Magnitude of the token leg, in base units. Always positive. */
  tokenAmount: TokenAmount;
  /** The mint's decimals, taken from the transaction meta. */
  decimals: number;
  signature: Signature;
  slot: number;
  /**
   * Unix **seconds** as returned by the RPC — not `UnixMillis`. Nullable and
   * non-monotonic across slots, so never order or expire on it.
   */
  blockTime: number | null;
  venue: SwapVenue;
  /** True when the tracked wallet paid the transaction fee (account index 0). */
  feePayer: boolean;

  /**
   * How this reached us. Stamped by `WalletStream`, which is the only component
   * that knows — `parseSwap` sees a transaction, not a delivery path.
   */
  source: SwapSource;
  /**
   * Wall clock when this process finished parsing it, as `UnixMillis`.
   *
   * The freshness fallback when `blockTime` is null. That case is real — the
   * field is nullable on the RPC — and it needs a policy rather than a crash:
   *
   *   `live`    -> `observedAt` is a sound proxy. We watched it arrive, so the
   *                block is at most a round trip old.
   *   `gapfill` -> it is **not** a proxy for anything. The transaction could be
   *                from any point in history and `observedAt` would claim it is
   *                brand new. Handled by failing closed at the gate, not here.
   *
   * Note this deliberately contradicts `blockTime`'s own "never expire on it"
   * warning. That warning is about *ordering* — `blockTime` is non-monotonic
   * across slots, so it cannot sequence events. Expiry only needs it to be
   * roughly right in absolute terms, which it is, and the alternative is having
   * no notion of signal age at all.
   */
  observedAt: UnixMillis;
}
