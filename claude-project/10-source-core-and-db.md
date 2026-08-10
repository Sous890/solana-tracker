# Source — core types, guards, persistence

> Generated from commit `804724b` (fix: two defects the soak found, one of them introduced by the barrier) on 2026-08-10.
> Regenerate with `npx tsx scripts/bundle-for-claude.ts`. Do not edit by hand.

The trading invariants and the two SQLite stores. `guards.ts` is where the entry/exit asymmetry lives and is the single most important file in the repo. `cursors.ts` holds the gap-fill barrier added in session 25.

## Files in this bundle

- `src/core/types.ts`
- `src/core/broker.ts`
- `src/core/guards.ts`
- `src/core/config.ts`
- `src/db/cursors.ts`
- `src/db/ledger.ts`

---

## `src/core/types.ts`

```typescript
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
```

---

## `src/core/broker.ts`

```typescript
/**
 * The Broker interface — the only execution surface strategy code may call.
 *
 * Strategy code must never reach an RPC client, a wallet, or a DEX adapter
 * directly. Everything it is allowed to do to the outside world is on this
 * interface, which is what makes the guard layer in `guards.ts` total: if the
 * only door is `Broker`, decorating `Broker` decorates every path to funds.
 *
 * Implementations live in `adapters/` (live) and `services/` (paper). Both are
 * wrapped by `guarded()` before any strategy sees them.
 */

import type { Fill, Lamports, OrderIntent, Position, Quote } from './types.js';

/** Whether a position can currently be exited, and why not if it cannot. */
export interface CanSellResult {
  ok: boolean;
  /** Human-readable cause when `ok` is false. Absent when `ok` is true. */
  reason?: string;
}

export interface Broker {
  /** Price an intent without committing to it. Never moves funds. */
  getQuote(intent: OrderIntent): Promise<Quote>;

  /**
   * Execute an intent and return the resulting Fill.
   *
   * Throws on rejection — including `GuardRejection` when wrapped by
   * `guarded()`. A returned Fill always means the trade happened (or was
   * simulated, per `Fill.simulated`).
   */
  execute(intent: OrderIntent): Promise<Fill>;

  /** Every position the broker considers live. Excludes closed positions. */
  getPositions(): Promise<Position[]>;

  /** Spendable + reserved balance, in lamports. The guard layer subtracts the reserve. */
  getBalanceLamports(): Promise<Lamports>;

  /**
   * Whether this mint can actually be exited right now — liquidity exists, the
   * mint is not frozen, transfers are not tax-trapped. Checked before entry:
   * a position that cannot be sold is a loss no risk limit can undo.
   */
  canSell(mint: string): Promise<CanSellResult>;

  /**
   * Liquidate everything, immediately. This is the panic path: it is never
   * blocked by the guard layer, including when the kill switch is engaged.
   */
  emergencyExitAll(): Promise<Fill[]>;
}
```

---

## `src/core/guards.ts`

```typescript
/**
 * The protection layer.
 *
 * `guarded(broker, deps)` decorates any `Broker` and enforces the trading
 * invariants before delegating. It holds no strategy and makes no decisions
 * about *what* to trade — it only decides what is forbidden.
 *
 * The asymmetry below is the whole point and must survive every future edit:
 *
 *   ENTRIES are gated by every risk limit — unacknowledged crash orphans, kill
 *   switch, run status, signal freshness, gas reserve, concurrency cap,
 *   duplicate holdings, price impact, sellability, and the daily loss cap.
 *
 *   EXITS are gated only by "is there something to sell, and is a sell already
 *   running". No risk limit may ever block a sell. A risk limit exists to stop
 *   the bot acquiring more exposure; applying one to an exit would trap the bot
 *   in exactly the position the limit was warning about. If the bot is holding,
 *   it must always be able to get out.
 *
 *   WELL-FORMEDNESS is checked on both sides, ahead of everything, and is not a
 *   risk limit. "Is this a coherent instruction" is a different question from
 *   "is this a trade we want", and the asymmetry above is about the second one.
 *   A sell of `NaN` tokens of `null` is not an exit being blocked; it is not an
 *   exit. The one case that looks malformed and is not is an exit for more than
 *   is held — that is CLAMPED and executed, never refused, because the holder
 *   it would strand is precisely the one whose books already disagree with the
 *   chain.
 *
 * `emergencyExitAll()` bypasses the guard layer entirely.
 */

import type { Broker, CanSellResult } from './broker.js';
import type { Config } from './config.js';
import type { Address, BotState, Fill, Lamports, OrderIntent, Position } from './types.js';
import { lamportsToSol, solToLamports } from './units.js';

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

/** Machine-readable rejection causes. Stable — these end up in logs and the UI. */
export type GuardCode =
  // --- well-formedness, both sides ---------------------------------------
  /**
   * The intent is not a coherent instruction: a missing, non-integer,
   * non-positive or non-finite amount, or a mint that is not an address.
   *
   * Runs ahead of every other gate and applies to **both sides**. It is not a
   * risk gate, so it does not violate "no risk limit may ever block a sell" —
   * a sell for `NaN` tokens of `null` is not an exit being blocked, it is not
   * an exit at all. Nothing downstream can do anything sensible with it, and
   * before this gate existed nothing tried: it reached the broker and died as
   * a `RangeError`, or reached SQLite and was silently dropped.
   */
  | 'MALFORMED_INTENT'
  // --- entry gates -------------------------------------------------------
  /**
   * A previous run crashed mid-trade and nobody has signed off on the outcome.
   * The bot may be holding something it cannot see.
   */
  | 'UNACKNOWLEDGED_ORPHANS'
  /** Kill switch is engaged; no new exposure. */
  | 'KILL_SWITCH_ENGAGED'
  /** Bot is idle or stopping. */
  | 'NOT_RUNNING'
  /**
   * The originating swap is older than `maxSignalAgeMs`.
   *
   * A backstop, not the primary control — `MirrorStrategy` drops a stale swap
   * before an intent exists, precisely so this code stays rare. Seeing it in
   * `intents.rejection_code` means a strategy emitted an entry on a signal it
   * should have discarded, which is a fact worth having about the strategy.
   */
  | 'STALE_SIGNAL'
  /** The spend would eat into the reserved gas, stranding open positions. */
  | 'GAS_RESERVE_BREACH'
  /** Already at the concurrent position cap. */
  | 'MAX_POSITIONS_REACHED'
  /** A position in this mint is already open. */
  | 'ALREADY_HOLDING'
  /** Quoted price impact is worse than the tolerated slippage. */
  | 'PRICE_IMPACT_EXCEEDED'
  /** The broker reports this mint cannot be exited. */
  | 'CANNOT_SELL'
  /** Today's realized loss has reached the daily cap. */
  | 'DAILY_LOSS_LIMIT'
  // --- exit gates --------------------------------------------------------
  /** Nothing to sell for this mint. */
  | 'NO_OPEN_POSITION'
  /** A sell for this mint is already in flight. */
  | 'SELL_IN_FLIGHT';

/**
 * Something the guard layer did that was not a refusal.
 *
 * Kept out of `GuardCode` on purpose: that type is the set of reasons an intent
 * did NOT execute, and Prompt 12 counts it. A clamped sell executed, so filing
 * it under a rejection code would inflate the refusal count with a success.
 */
export type GuardNotice =
  /** An exit asked for more than was held and was reduced to the holding. */
  'SELL_CLAMPED';

/**
 * A refusal to execute, thrown by the guard layer.
 *
 * It is an `Error` because `Broker.execute` returns `Promise<Fill>` — there is
 * no return channel for a refusal, and a caller that ignores a rejection must
 * not proceed as though a trade occurred.
 */
export class GuardRejection extends Error {
  readonly code: GuardCode;
  /** Human-readable explanation, safe to surface in the UI. */
  readonly reason: string;
  readonly intentId: string;
  readonly side: OrderIntent['side'];
  readonly mint: Address;

  constructor(code: GuardCode, reason: string, intent: OrderIntent) {
    super(`${code}: ${reason}`);
    this.name = 'GuardRejection';
    this.code = code;
    this.reason = reason;
    this.intentId = intent.id;
    this.side = intent.side;
    this.mint = intent.mint;
  }
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** Structured fields attached to a guard log line. */
export interface GuardLogFields {
  code: GuardCode | GuardNotice;
  reason: string;
  intentId: string;
  side: OrderIntent['side'];
  mint: Address;
}

/**
 * Minimal logging port. Injected rather than importing pino directly, so this
 * module stays I/O-free and tests can assert on what was logged. `services/`
 * supplies a pino-backed implementation.
 */
export interface GuardLogger {
  warn(fields: GuardLogFields, message: string): void;
}

/**
 * Everything the guard layer needs that it cannot compute itself.
 *
 * `getState` is synchronous: `BotState` is in-memory process state.
 * `getRealizedLossSolToday` is asynchronous: it is backed by the fills table.
 */
export interface GuardDeps {
  readonly config: Config;
  readonly logger: GuardLogger;
  getState(): BotState;
  /** Realized loss for the current UTC day, as positive lamports. Exact. */
  getRealizedLossLamportsToday(): Promise<Lamports>;
  /**
   * Crash orphans awaiting operator sign-off.
   *
   * Called on every buy rather than read once at startup: acknowledging an
   * orphan mid-session must lift the gate immediately, without a restart.
   * Backed by an indexed COUNT, so it is cheap enough to ask every time.
   */
  getUnacknowledgedOrphanCount(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A position counts as held while it still has tokens and is not closed. */
function isLive(position: Position): boolean {
  return position.state !== 'closed' && position.tokens > 0n;
}

/**
 * Base58, no `0OIl`. Solana public keys land in 32-44 characters.
 *
 * Duplicated from `config.ts` rather than imported: that module reads the
 * filesystem in `loadConfig`, and pulling `node:fs` into the guard layer's
 * runtime graph to borrow a regex would trade a two-line copy for the one
 * property this file is supposed to have.
 */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Why this intent is not a coherent instruction, or `null` if it is one.
 *
 * Pure, exported, and total. Exported because the tracker needs the same
 * verdict *before* it writes the intent row — an amount this rejects may not
 * even be representable in SQLite, so "record it, then let the gate refuse it"
 * is not always available. One rule, two call sites, no drift.
 *
 * The checks are deliberately structural rather than economic. "Is this a
 * number the system can act on" is a different question from "is this a trade
 * we want", and conflating them is what produced the measured hole: the gas
 * reserve check was doing double duty as the low-end amount check, and it was
 * never designed for that.
 */
export function malformedIntentReason(intent: OrderIntent): string | null {
  if (intent.side !== 'buy' && intent.side !== 'sell') {
    return `side ${String(intent.side)} is neither buy nor sell`;
  }

  const mint: unknown = intent.mint;
  if (typeof mint !== 'string' || mint.length === 0) {
    return `mint ${mint === null ? 'null' : String(mint)} is not an address`;
  }
  if (!BASE58_ADDRESS.test(mint)) {
    return `mint ${mint} is not valid base58 (32-44 chars, no 0OIl)`;
  }

  // The field the side is denominated in. `OrderIntent`'s invariant is that
  // exactly one is set; the wrong one being present is as unusable as neither.
  const field = intent.side === 'buy' ? 'amountLamports' : 'amountTokens';
  const amount: unknown = intent.side === 'buy' ? intent.amountLamports : intent.amountTokens;

  if (amount === undefined || amount === null) return `${field} is required for a ${intent.side}`;
  if (typeof amount !== 'bigint') {
    // A `number` reaches here whenever the value came from JSON, from
    // arithmetic that lost its bigint-ness, or from a strategy. `NaN` and
    // `Infinity` are numbers, and both used to sail through: `NaN <= 0n` is
    // false, so every comparison below would have said "positive".
    return `${field} must be an exact bigint, got ${typeof amount} ${String(amount)}`;
  }
  if (amount <= 0n) return `${field} must be greater than zero, got ${amount}`;

  if (!Number.isFinite(intent.maxSlippageBps) || intent.maxSlippageBps < 0) {
    return `maxSlippageBps must be a finite non-negative number, got ${intent.maxSlippageBps}`;
  }

  return null;
}

/**
 * Lamports the gas reserve must be computed against.
 *
 * **Clamps HIGH only.** The low end is gate 0's job, and separating the two is
 * the fix for a measured defect rather than a stylistic preference.
 *
 * This `max` exists so an intent asking for MORE than `positionSizeSol` cannot
 * slip past the gas reserve by being sized differently from the config. It was
 * also, accidentally, the only thing looking at the low end — and
 * `max(-1n, 50_000_000n)` is `50_000_000n`, so a negative amount was silently
 * widened into a legal one, passed every remaining gate, and died in the broker
 * as a `RangeError` with the intent already marked `failed`.
 *
 * PRECONDITION: `malformedIntentReason(intent) === null`, so `requested` is a
 * positive bigint. Gate 0 establishes it before this is ever reached.
 */
function spendLamports(intent: OrderIntent, config: Config): Lamports {
  const configured = solToLamports(config.positionSizeSol);
  const requested = intent.amountLamports ?? 0n;
  return requested > configured ? requested : configured;
}

/**
 * Slippage tolerance for this intent, in bps.
 *
 * An intent may be stricter than the config but never looser — the config
 * ceiling is a hard limit, not a default.
 */
function toleratedSlippageBps(intent: OrderIntent, config: Config): number {
  return Math.min(intent.maxSlippageBps, config.maxSlippageBps);
}

// ---------------------------------------------------------------------------
// The decorator
// ---------------------------------------------------------------------------

/**
 * Wrap a Broker so that every entry passes the risk gates and every exit stays
 * available. Read-only methods pass through untouched.
 */
export function guarded(inner: Broker, deps: GuardDeps): Broker {
  const { config, logger } = deps;

  /**
   * Mints with an execution currently delegated to the inner broker.
   *
   * These are claimed *synchronously*, before the first `await` in `execute`.
   * Anything checked after an await is checked against stale state: two intents
   * issued in the same tick would both read "nothing in flight", both pass, and
   * both execute. For sells that is a double-sell; for buys it is a duplicate
   * position that walks straight through gates 4 and 5.
   */
  const sellsInFlight = new Set<Address>();

  /**
   * Mint -> claim ordinal for in-flight buys.
   *
   * Ordinals matter because the gates are evaluated asynchronously after the
   * claim: without them, two buys racing for the last slot would each see the
   * other's claim and both be rejected. A buy is only held against claims that
   * preceded it, so the first to arrive wins the slot.
   */
  const buysInFlight = new Map<Address, number>();
  let nextClaimOrdinal = 0;

  function reject(code: GuardCode, reason: string, intent: OrderIntent): never {
    const rejection = new GuardRejection(code, reason, intent);
    logger.warn(
      {
        code,
        reason,
        intentId: intent.id,
        side: intent.side,
        mint: intent.mint,
      },
      `Rejected ${intent.side} of ${intent.mint}: ${reason}`,
    );
    throw rejection;
  }

  /**
   * Entry gates, in the order they are specified. Order is observable — it
   * decides which code a multiply-invalid intent reports — so it is fixed.
   */
  async function guardBuy(intent: OrderIntent, claimOrdinal: number): Promise<void> {
    // 0. Unacknowledged crash orphans. Ahead of the kill switch because "we do
    //    not know what we are holding" is worse than "we chose to stop": the
    //    concurrency cap, the duplicate check and the gas reserve are all
    //    computed from positions that may be incomplete. Read fresh every time
    //    so an acknowledgement takes effect without a restart.
    const orphans = await deps.getUnacknowledgedOrphanCount();
    if (orphans > 0) {
      reject(
        'UNACKNOWLEDGED_ORPHANS',
        `${orphans} crash orphan(s) await sign-off; run \`npm run orphans\` — positions may be incomplete`,
        intent,
      );
    }

    const state = deps.getState();

    // 1. Kill switch.
    if (state.killSwitchEngaged) {
      reject('KILL_SWITCH_ENGAGED', 'kill switch is engaged; no new positions', intent);
    }

    // 2. Run status.
    if (state.status !== 'running') {
      reject('NOT_RUNNING', `bot is ${state.status}, not running`, intent);
    }

    // 3. Signal freshness.
    //
    //    Here rather than later because it is the last gate that costs nothing:
    //    everything below this line does I/O, and there is no point pricing a
    //    trade whose premise expired. It is also the last gate that can be
    //    decided from the intent alone, which keeps it reproducible from the
    //    ledger row long after the market state that drove gates 4-9 is gone.
    //
    //    `signalAgeMs === undefined` passes deliberately. It means the intent
    //    did not come from an observed swap — an operator's manual buy — and
    //    there is no signal whose age could be wrong. Rejecting those would
    //    make the gate a bar on manual entry, which is not what it is for.
    //    Every strategy-originated buy is stamped by `StrategyRunner`, so the
    //    path this gate exists to close cannot reach here unstamped.
    if (intent.signalAgeMs !== undefined && intent.signalAgeMs > config.maxSignalAgeMs) {
      reject(
        'STALE_SIGNAL',
        `originating swap is ${intent.signalAgeMs}ms old, past the ${config.maxSignalAgeMs}ms limit — the price has had time to move`,
        intent,
      );
    }

    // 4. Gas reserve. The reserve is not spendable, ever — it is what pays for
    //    the exits of positions already open. Compared in lamports: this is a
    //    decision about money, so it is made on exact integers.
    const balance = await inner.getBalanceLamports();
    const spend = spendLamports(intent, config);
    const reserve = solToLamports(config.reservedGasSol);
    if (balance - spend < reserve) {
      reject(
        'GAS_RESERVE_BREACH',
        `spending ${lamportsToSol(spend)} SOL of ${lamportsToSol(balance)} would leave less than the ${config.reservedGasSol} SOL gas reserve`,
        intent,
      );
    }

    const positions = await inner.getPositions();
    const live = positions.filter(isLive);

    // 5. Concurrency cap. Buys already in flight are not in `getPositions()`
    //    yet but will be, so they count. This intent holds a claim of its own,
    //    which is excluded.
    const earlierBuys = [...buysInFlight.values()].filter(
      (ordinal) => ordinal < claimOrdinal,
    ).length;
    const committed = live.length + earlierBuys;
    if (committed >= config.maxConcurrentPositions) {
      reject(
        'MAX_POSITIONS_REACHED',
        `already committed to ${committed} of a maximum ${config.maxConcurrentPositions} positions`,
        intent,
      );
    }

    // 6. Duplicate holding.
    if (live.some((position) => position.mint === intent.mint)) {
      reject('ALREADY_HOLDING', 'a position in this mint is already open', intent);
    }

    // 7. Price impact. `priceImpactPct` is a percent; limits are bps.
    const quote = await inner.getQuote(intent);
    const impactBps = quote.priceImpactPct * 100;
    const toleratedBps = toleratedSlippageBps(intent, config);
    if (impactBps > toleratedBps) {
      reject(
        'PRICE_IMPACT_EXCEEDED',
        `price impact ${quote.priceImpactPct}% (${impactBps} bps) exceeds the ${toleratedBps} bps limit`,
        intent,
      );
    }

    // 8. Sellability. Never enter something that cannot be exited.
    const sellable: CanSellResult = await inner.canSell(intent.mint);
    if (!sellable.ok) {
      reject('CANNOT_SELL', sellable.reason ?? 'mint cannot be sold', intent);
    }

    // 9. Daily loss cap, also in lamports.
    const lossToday = await deps.getRealizedLossLamportsToday();
    if (lossToday >= solToLamports(config.maxDailyLossSol)) {
      reject(
        'DAILY_LOSS_LIMIT',
        `today's realized loss of ${lamportsToSol(lossToday)} SOL has reached the ${config.maxDailyLossSol} SOL limit`,
        intent,
      );
    }
  }

  /**
   * Exit gate. Deliberately short — one check.
   *
   * Do not add risk checks here. The kill switch, the daily loss cap and the
   * concurrency cap are entry controls; a bot that is holding must always be
   * able to sell. See the module header.
   *
   * The second exit gate, `SELL_IN_FLIGHT`, is enforced synchronously in
   * `execute` and cannot live here — see `sellsInFlight`.
   */
  async function guardSell(intent: OrderIntent): Promise<Position> {
    const positions = await inner.getPositions();
    const held = positions.find(
      (position) => position.mint === intent.mint && isLive(position),
    );
    if (held === undefined) {
      reject('NO_OPEN_POSITION', 'no open position for this mint', intent);
    }
    return held;
  }

  /**
   * An exit for more than is held is CLAMPED, never rejected.
   *
   * This is the one malformed-looking case that must still execute. A holder
   * whose ledger and the chain disagree — the exact situation the crash-orphan
   * gate exists for — needs the exit to go through for what is actually there.
   * Refusing would strand them, which is the single outcome this whole build
   * order is arranged to prevent.
   *
   * Clamped HERE, before the broker quotes, so the quote, the fill row and the
   * position delta all describe the same quantity. Clamping later (the ledger's
   * replay already does `min(requested, tokens)`) leaves a fill row asserting a
   * sale that did not happen: measured on 2026-08-03, a sell of 999,999,999,999
   * against a 1,000,000,000 position filled, wrote `tokens_delta` of
   * -999,999,999,999, and credited the paper wallet the whole proceeds —
   * +0.997 SOL conjured out of tokens that were never held.
   *
   * The fill row records what settled, never what was requested. The intent row
   * still records what was asked, which is where the discrepancy stays visible.
   */
  function clampSellToPosition(intent: OrderIntent, held: Position): OrderIntent {
    const requested = intent.amountTokens ?? 0n;
    if (requested <= held.tokens) return intent;

    logger.warn(
      {
        code: 'SELL_CLAMPED',
        reason: `requested ${requested}, holding ${held.tokens}`,
        intentId: intent.id,
        side: intent.side,
        mint: intent.mint,
      },
      `Clamped sell of ${intent.mint} from ${requested} to the ${held.tokens} actually held`,
    );
    return { ...intent, amountTokens: held.tokens };
  }

  return {
    getQuote: (intent) => inner.getQuote(intent),
    getPositions: () => inner.getPositions(),
    getBalanceLamports: () => inner.getBalanceLamports(),
    canSell: (mint) => inner.canSell(mint),

    /** The panic path is never gated. */
    emergencyExitAll: () => inner.emergencyExitAll(),

    async execute(intent: OrderIntent): Promise<Fill> {
      // Gate 0, ahead of everything and on both sides. Synchronous and pure, so
      // it cannot be raced and cannot be reached around: an intent that is not
      // a coherent instruction never touches an in-flight claim, a quote, the
      // screener, or the broker.
      const malformed = malformedIntentReason(intent);
      if (malformed !== null) reject('MALFORMED_INTENT', malformed, intent);

      if (intent.side === 'sell') {
        // Exit gate 2, claimed before any await. A spurious rejection here
        // lasts only as long as the sell already running for this mint.
        if (sellsInFlight.has(intent.mint)) {
          reject('SELL_IN_FLIGHT', 'a sell for this mint is already in flight', intent);
        }
        sellsInFlight.add(intent.mint);
        try {
          const held = await guardSell(intent);
          return await inner.execute(clampSellToPosition(intent, held));
        } finally {
          sellsInFlight.delete(intent.mint);
        }
      }

      if (buysInFlight.has(intent.mint)) {
        reject('ALREADY_HOLDING', 'a buy for this mint is already in flight', intent);
      }
      const claimOrdinal = nextClaimOrdinal++;
      buysInFlight.set(intent.mint, claimOrdinal);
      try {
        await guardBuy(intent, claimOrdinal);
        return await inner.execute(intent);
      } finally {
        buysInFlight.delete(intent.mint);
      }
    },
  };
}
```

---

## `src/core/config.ts`

```typescript
/**
 * Config loading and validation.
 *
 * Two entry points, deliberately split:
 *  - `parseConfig(unknown)` is pure — it is the whole validation surface and
 *    is what the tests exercise.
 *  - `loadConfig(path)` is the single filesystem read in `core/`, kept here so
 *    that "where does config come from" has exactly one answer. Everything
 *    downstream receives an already-validated `Config` by argument.
 *
 * Secrets never live in `config.json` — RPC URLs and API keys come from `.env`
 * and are read by adapters. This file holds tuning parameters only.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** Base58, no `0OIl`. Solana public keys land in 32-44 characters. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ---------------------------------------------------------------------------
// Hard floors
// ---------------------------------------------------------------------------

/**
 * Safety limits that a config file may not cross, checked at load time.
 *
 * These are deliberately *not* spread through the field definitions: they are
 * the rules an operator would want to audit in one place before trusting the
 * bot with a funded wallet. Widening one is a code change and a review, not a
 * config edit.
 */
export const LIMITS = {
  /** SOL held back for fees. Below this the bot can lose its ability to sell. */
  MIN_RESERVED_GAS_SOL: 0.02,
  /** 20%. Above this, "slippage tolerance" is just consent to being drained. */
  MAX_SLIPPAGE_BPS: 2_000,
  /**
   * 5 minutes. Above this the copy-trade premise is gone: a five-minute-old
   * memecoin signal is indistinguishable from buying a mint at random.
   */
  MAX_SIGNAL_AGE_MS: 300_000,
  /**
   * 5 seconds, and this floor matters more than it looks.
   *
   * Signal age is measured against `blockTime`, which is **not a clock**. It is
   * a stake-weighted median of what the cluster's validators claimed the time
   * was, so it drifts from wall clock by seconds in normal operation and
   * further under load — and it can move backwards between adjacent slots.
   *
   * That means the measured age of a genuinely live swap is
   * `network latency + RPC round trip + blockTime drift`, and the last term
   * dominates the first two. A tuning value like 2000 would not be "a tighter
   * copy window"; it would reject signal that arrived instantly, intermittently,
   * for a reason nobody watching the rejection counter would guess. Better to
   * refuse the config than to ship a bot that silently declines to trade.
   */
  MIN_SIGNAL_AGE_MS: 5_000,
} as const;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ConfigObject = z
  .object({
    /** `paper` simulates every fill. `live` submits real transactions. */
    mode: z.enum(['paper', 'live']).default('paper'),

    /**
     * Opt-in required to run in `live` mode. Defaults false so that flipping
     * `mode` alone is never sufficient to start spending real SOL.
     */
    acknowledgeLiveRisk: z.boolean().default(false),

    /** Base58 wallet addresses to mirror. */
    trackedWallets: z
      .array(
        z
          .string()
          .regex(BASE58_ADDRESS, 'must be a base58 Solana address (32-44 chars)'),
      )
      .default([]),

    /** SOL committed per entry. */
    positionSizeSol: z.number().finite().default(0.05),

    /** Hard cap on concurrently open positions. */
    maxConcurrentPositions: z.number().int().positive().default(3),

    /** Slippage ceiling applied to every swap, basis points. */
    maxSlippageBps: z.number().int().nonnegative().default(300),

    /**
     * SOL never available to the trading logic. This is the bot's guaranteed
     * ability to sell: exits cost fees too, and a wallet that spent its last
     * lamport on an entry cannot close the position it just opened.
     */
    reservedGasSol: z.number().finite().default(0.03),

    /** Priority fee attached to swap transactions. Ignored in paper mode. */
    priorityFeeMicroLamports: z.number().int().nonnegative().default(200_000),

    /** Realized loss in a UTC day that trips the kill switch. */
    maxDailyLossSol: z.number().positive().default(0.5),

    /** Skip any pair whose pool holds less than this, in USD. */
    minLiquidityUsd: z.number().nonnegative().default(15_000),

    /**
     * How old a tracked wallet's swap may be and still be worth mirroring, ms.
     *
     * A copy-trading entry is a bet that the price has not yet moved to reflect
     * what the tracked wallet did. That bet has a shelf life measured in
     * seconds; past it the trade is not a worse version of the same strategy,
     * it is a different strategy nobody chose — buying into a move that has
     * already happened.
     *
     * The gate this feeds exists for one specific failure: the websocket drops,
     * reconnects twenty minutes later, and the gap fill hands the strategy the
     * whole backlog at once, at full position size, against prices that are
     * twenty minutes stale. Startup is safe from this today only because the
     * status flip happens to land after the first gap fill — an accident of
     * initialisation order rather than a rule. This is the rule.
     *
     * The 300 s ceiling below is a hard floor-style limit, not advice. A value
     * above it is not "a longer copy window"; it is the check having been
     * disabled by accident.
     */
    maxSignalAgeMs: z.number().int().positive().default(15_000),

    /**
     * Which strategy decides what to trade. Resolved by
     * `services/strategyRegistry.ts` at the composition root.
     *
     * A plain string, **not** an enum, and that is deliberate. Validating the
     * name here would mean `core/` knowing the set of strategies, which lives
     * in `services/` — an import pointing the wrong way down the dependency
     * chain. The cost is that a typo is caught when the runtime is built rather
     * than when the config is parsed; the registry throws by name and lists
     * what it does know, so the failure is loud and immediate either way.
     *
     * Optional in the file: an existing `config.json` written before strategies
     * existed still loads, and still gets `mirror`.
     */
    strategy: z.string().min(1).default('mirror'),

    /** Starting balance for the simulated wallet in paper mode. */
    paperStartingSol: z.number().positive().default(5),

    /**
     * Compute-unit limit assumed for a swap transaction.
     *
     * Turns `priorityFeeMicroLamports` (which is per compute unit) into a
     * lamport cost: `ceil(microLamports * computeUnitLimit / 1e6)`. 400,000 is
     * realistic for a single-hop Jupiter swap through Raydium or Pump.fun;
     * multi-hop routes exceed it.
     *
     * **A recalibration knob, alongside `paperLatencyPenaltyBps`.** The live
     * broker should eventually set this limit explicitly from simulation, and
     * paper should track whatever it sets. Until then it is an estimate.
     */
    computeUnitLimit: z.number().int().positive().default(400_000),

    /**
     * Adverse price movement assumed between quoting and landing, in bps,
     * applied to whatever the bot receives.
     *
     * **This is a guess.** 30 bps is a placeholder for the latency between a
     * quote and a confirmed transaction, and it has not been measured against
     * anything. Until it is recalibrated from live fills, **paper P&L is an
     * upper bound on real P&L** — the real cost of being late is whatever the
     * market did in that window, which on a moving memecoin is routinely worse
     * than 30 bps and is never better in expectation.
     */
    paperLatencyPenaltyBps: z.number().int().nonnegative().max(10_000).default(30),

    // --- quote adapter -----------------------------------------------------

    /** Jupiter Swap API base. The paid host is selected by `JUPITER_API_KEY`. */
    jupiterBaseUrl: z.string().url().default('https://lite-api.jup.ag/swap/v1'),

    /**
     * Restrict routes to liquid intermediate tokens.
     *
     * Exotic multi-hop routes quote well and fill badly. Configurable so the
     * Prompt 12 replay harness can measure both settings rather than assume.
     */
    jupiterRestrictIntermediateTokens: z.boolean().default(true),

    /** Per-attempt HTTP timeout for a quote. */
    quoteTimeoutMs: z.number().int().positive().default(2_000),

    /**
     * Ceiling across all retries of one quote.
     *
     * A caller budgets latency once; retries must not silently exceed it.
     */
    quoteTotalDeadlineMs: z.number().int().positive().default(6_000),

    /** How long a successful quote stays reusable. */
    quoteCacheTtlMs: z.number().int().nonnegative().default(1_500),

    /**
     * How long a NO_ROUTE answer stays reusable. Deliberately shorter than
     * `quoteCacheTtlMs`: a freshly launched mint becomes routable within
     * seconds, and caching "unroutable" for too long makes the bot blind to it.
     */
    noRouteCacheTtlMs: z.number().int().nonnegative().default(500),

    /**
     * Probe size for deriving a price, in lamports.
     *
     * A price is taken from a real quote of this size so it reflects routable
     * liquidity rather than an oracle print. A number here (not a bigint)
     * because config is JSON; it is converted at the adapter boundary.
     */
    priceProbeLamports: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .default(100_000_000),
  })
  .strict();

/**
 * The floors above, applied after field parsing.
 *
 * `superRefine` rather than chained `.refine`s so that a config violating
 * several limits reports all of them at once — an operator fixing a config
 * file should not have to rerun to discover the next problem.
 */
export const ConfigSchema = ConfigObject.superRefine((config, ctx) => {
  if (config.reservedGasSol < LIMITS.MIN_RESERVED_GAS_SOL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reservedGasSol'],
      message: `must be at least ${LIMITS.MIN_RESERVED_GAS_SOL} SOL — below this the bot may be unable to pay for its own exits`,
    });
  }

  if (config.maxSlippageBps > LIMITS.MAX_SLIPPAGE_BPS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxSlippageBps'],
      message: `must be at most ${LIMITS.MAX_SLIPPAGE_BPS} bps (${LIMITS.MAX_SLIPPAGE_BPS / 100}%)`,
    });
  }

  if (config.maxSignalAgeMs > LIMITS.MAX_SIGNAL_AGE_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxSignalAgeMs'],
      message: `must be at most ${LIMITS.MAX_SIGNAL_AGE_MS} ms (${LIMITS.MAX_SIGNAL_AGE_MS / 1_000}s) — beyond that the copy-trade premise no longer holds`,
    });
  }

  if (config.maxSignalAgeMs < LIMITS.MIN_SIGNAL_AGE_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxSignalAgeMs'],
      message: `must be at least ${LIMITS.MIN_SIGNAL_AGE_MS} ms — blockTime drifts seconds from wall clock, so a tighter window rejects live signal as stale`,
    });
  }

  if (config.positionSizeSol <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['positionSizeSol'],
      message: 'must be greater than 0',
    });
  }

  if (config.mode === 'live' && config.acknowledgeLiveRisk !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['acknowledgeLiveRisk'],
      message:
        'must be true to run in live mode — live mode spends real SOL and can lose all of it',
    });
  }
});

export type Config = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown for any config problem: unreadable file, bad JSON, failed validation. */
export class ConfigError extends Error {
  /** One entry per validation failure, `path: message`. Empty for I/O errors. */
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(issues.length > 0 ? `${message}\n  - ${issues.join('\n  - ')}` : message);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Validate an already-parsed config object and apply defaults.
 * Pure. Throws `ConfigError` listing every violation.
 */
export function parseConfig(input: unknown): Config {
  const result = ConfigSchema.safeParse(input);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  });
  throw new ConfigError('Invalid config', issues);
}

/**
 * Read, parse, and validate `config.json`.
 * Throws `ConfigError` if the file is missing, malformed, or invalid.
 */
export function loadConfig(path = 'config.json'): Config {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(
      `Cannot read config file at ${path} — copy config.example.json to get started`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(
      `Config file at ${path} is not valid JSON: ${(cause as Error).message}`,
    );
  }

  return parseConfig(parsed);
}
```

---

## `src/db/cursors.ts`

```typescript
/**
 * Per-wallet stream cursors.
 *
 * A separate module and a separate connection from `ledger.ts`, which this
 * prompt was told not to touch. Both open the same SQLite file; WAL supports
 * multiple connections, and `wallet_cursors` is independent of the ledger's
 * schema-version gate (which keys off the `fills` table).
 *
 * The cursor records the last signature **successfully emitted**, never the
 * last received. A crash between receiving and emitting must re-deliver, not
 * skip: a missed swap on a tracked wallet is a signal the strategy never sees.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import type { Address, Signature, UnixMillis } from '../core/types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wallet_cursors (
  wallet         TEXT    PRIMARY KEY,
  last_signature TEXT    NOT NULL,
  last_slot      INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
`;

/**
 * Ceiling on completed-but-not-yet-persistable positions held per wallet.
 *
 * Unbounded, this grew with the length of a gap fill: every completed entry
 * behind an outstanding predecessor stays in memory until the barrier lifts.
 * The largest single gap fill on record is **3,142 entries** (H8sMJS in
 * `20260807T025234Z-000`), so 4,096 is the next power of two above the worst
 * case actually observed — the bound is a backstop against a pathological
 * replay, not a limit the normal path is expected to reach.
 *
 * Hitting it is not a data-loss event. See the drop policy in `set`.
 */
const MAX_DEFERRED = 4_096;

export interface WalletCursor {
  wallet: Address;
  lastSignature: Signature;
  lastSlot: number;
  updatedAt: UnixMillis;
}

export interface CursorStore {
  get(wallet: Address): WalletCursor | undefined;
  /** Record the last emitted signature. Call after emitting, not on receipt. */
  set(wallet: Address, signature: Signature, slot: number, at?: UnixMillis): void;
  /**
   * Take the barrier for this wallet: nothing advances until `release`.
   *
   * **THROWS if the wallet is already held**, and that is the point. The barrier
   * is not reentrant and two wallet loops running at once would defeat it
   * silently — `release` drops it outright, so whichever loop finishes a wallet
   * first removes the other's protection, and the surviving loop's remaining
   * entries stop holding anything back. Silent defeat of a data-loss guard is
   * exactly the failure that should not wait to be discovered in a soak.
   *
   * Single-chain holds today: `reconnect()` is guarded by `reconnecting`, and
   * `start()` finishes its loop before a socket exists. It did NOT hold before
   * the chain-splitting fix of 2026-08-06 (b1b02ea), which is where the doubled
   * `gap-filled` events in the 2026-08-05 sessions come from. The queued
   * round-robin change has to make this counted before it runs loops
   * concurrently, and this throw is what will tell it so.
   */
  hold(wallet: Address): void;
  /**
   * Narrow an existing hold to exactly the positions about to be handled.
   *
   * Separate from `hold` so that "take the barrier" and "say what is behind it"
   * are different operations: taking twice is a bug, narrowing repeatedly is
   * not. Until this is called nothing advances at all, because nothing knows
   * what is outstanding; after it, only positions with an unhandled predecessor
   * are held back, so a long replay records progress as it goes.
   *
   * Throws if the wallet is not held — narrowing something nobody took is the
   * same class of mistake.
   */
  reserve(wallet: Address, slots: readonly number[]): void;
  /**
   * Everything outstanding for this wallet is handled or abandoned.
   *
   * Idempotent, deliberately: it is called from a `finally` that sweeps every
   * wallet, including ones already released in the loop body.
   */
  release(wallet: Address): void;
  /** Barrier bookkeeping, for a soak to report rather than guess. */
  barrierStats(): { peakDeferred: number; peakOutstanding: number; heldNow: number };
  all(): WalletCursor[];
  close(): void;
}

interface CursorRow {
  wallet: string;
  last_signature: string;
  last_slot: bigint;
  updated_at: bigint;
}

export function openCursorStore(options: { path: string }): CursorStore {
  if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true });

  const db: Db = new Database(options.path);
  // Defence in depth, not a fix for anything measured.
  //
  // Several connections share this file, and SQLite without a busy timeout
  // returns SQLITE_BUSY *immediately* rather than waiting. A `SQLITE_BUSY` was
  // seen during the 2026-08-04 crash drill and initially blamed on this; it
  // was not — the real cause was leaked test child processes still holding the
  // database open, and the drill passes without this pragma once they are
  // reaped. It is kept because waiting briefly is the right behaviour for a
  // shared file and costs nothing, NOT because a defect was found here.
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  // Matches ledger.ts, so INTEGER columns read back as bigint here too.
  db.defaultSafeIntegers(true);
  db.exec(SCHEMA);

  const statements = {
    get: db.prepare<[string]>('SELECT * FROM wallet_cursors WHERE wallet = ?'),
    all: db.prepare('SELECT * FROM wallet_cursors ORDER BY wallet ASC'),
    upsert: db.prepare<[string, string, number, number]>(
      `INSERT OR REPLACE INTO wallet_cursors (wallet, last_signature, last_slot, updated_at)
       VALUES (?, ?, ?, ?)`,
    ),
  };

  const toCursor = (row: CursorRow): WalletCursor => ({
    wallet: row.wallet,
    lastSignature: row.last_signature,
    lastSlot: Number(row.last_slot),
    updatedAt: Number(row.updated_at),
  });

  /**
   * Per-wallet outstanding work, in memory only.
   *
   * Deliberately NOT persisted. A crash must lose these, because the whole point
   * is that nothing above the barrier ever reached the table — so the row on disk
   * is already the safe prefix, and recovery is "replay from it".
   */
  interface Barrier {
    /** True until the caller says what it is replaying. Blocks everything. */
    blocked: boolean;
    /** Slots the caller intends to handle and has not finished. */
    outstanding: Set<number>;
    /**
     * The reserved slots in ascending order, with `head` the index of the lowest
     * one still outstanding.
     *
     * ── WHY THIS IS NOT `Math.min(...outstanding)` ────────────────────────────
     *
     * It was, and that made the barrier QUADRATIC in the length of a gap fill:
     * O(n) to scan on every one of n completions, plus spreading a 77,236-element
     * set into `Math.min` each time. Measured on the 2026-08-09 soak's actual
     * backlog: 0.012ms per completion at 1,000 outstanding, 0.155ms at 10,000,
     * **1.611ms at 77,236** — about 124 seconds of pure CPU to drain one wallet,
     * growing as the square. Gap fill hands entries to `handle` oldest-first, so
     * the minimum only ever moves forward and a pointer is enough.
     */
    sorted: number[];
    head: number;
    /** Completed positions not yet eligible to persist, oldest first. */
    deferred: Array<{ signature: Signature; slot: number; at: UnixMillis }>;
  }
  const barriers = new Map<Address, Barrier>();
  let peakDeferred = 0;
  let peakOutstanding = 0;

  const persist = (wallet: Address, signature: Signature, slot: number, at: UnixMillis): void => {
    statements.upsert.run(wallet, signature, slot, at);
  };

  /**
   * Persist the newest completed position that has no unhandled predecessor.
   *
   * ── WHY SLOT, AND ONLY SLOT ───────────────────────────────────────────────
   *
   * Signature strings do not order. Slot does, and it is the one key present on
   * BOTH delivery paths: `dispatch` writes `tx.slot` from the fetched
   * transaction, and both gap fill and the live socket fetch before they
   * dispatch. Intra-block position is NOT available on both — `transactionIndex`
   * rides on `SignatureEntry` from `getSignaturesForAddress`, and a live
   * notification is built from `{ signature, slot, err }` with no index at all.
   *
   * So ties inside a slot cannot be ordered, and are resolved by refusing to
   * move: the comparison is `slot < barrier`, strictly. A completed position in
   * the same slot as an outstanding one waits. That costs one extra replay of a
   * block and cannot skip a sibling transaction.
   *
   * There is deliberately no monotonicity guard. Backwards is the safe
   * direction — it re-delivers, and `seen` drops the duplicate — and a cursor
   * left too far forward by the old code can only be repaired by moving it back.
   */
  /**
   * The lowest slot still outstanding, amortised O(1).
   *
   * Walks `head` forward past everything already completed. Each index is
   * passed at most once over the life of a reservation, so the whole drain is
   * linear rather than quadratic.
   */
  const lowestOutstanding = (barrier: Barrier): number => {
    while (barrier.head < barrier.sorted.length) {
      const slot = barrier.sorted[barrier.head]!;
      if (barrier.outstanding.has(slot)) return slot;
      barrier.head += 1;
    }
    return Number.POSITIVE_INFINITY;
  };

  const flush = (wallet: Address): void => {
    const barrier = barriers.get(wallet);
    if (barrier === undefined) return;

    let limit: number;
    if (barrier.outstanding.size > 0) limit = lowestOutstanding(barrier);
    else if (barrier.blocked) limit = Number.NEGATIVE_INFINITY;
    else limit = Number.POSITIVE_INFINITY;

    let best: { signature: Signature; slot: number; at: UnixMillis } | undefined;
    for (const entry of barrier.deferred) {
      if (entry.slot < limit && (best === undefined || entry.slot > best.slot)) best = entry;
    }
    if (best === undefined) return;

    persist(wallet, best.signature, best.slot, best.at);
    barrier.deferred = barrier.deferred.filter((entry) => entry.slot > best.slot);
  };

  return {
    get(wallet) {
      const row = statements.get.get(wallet) as CursorRow | undefined;
      return row === undefined ? undefined : toCursor(row);
    },
    set(wallet, signature, slot, at = Date.now()) {
      const barrier = barriers.get(wallet);
      // No declared work: the caller is the only producer and this is the
      // straight-through path the store has always had.
      if (barrier === undefined) {
        persist(wallet, signature, slot, at);
        return;
      }
      // `dispatch` writes `tx.slot`; `hold` was given `entry.slot`. They are the
      // same transaction and should agree — if they ever do not, the delete
      // misses, the slot stays outstanding until `release`, and the cursor is
      // held back rather than advanced. Wrong in the safe direction.
      barrier.outstanding.delete(slot);
      barrier.deferred.push({ signature, slot, at });

      // Bounded, dropping the LOWEST slots. Only the highest eligible position
      // is ever persisted, so a dropped low one costs nothing but the ability to
      // name it — the cursor simply stays further back, which re-delivers. The
      // opposite policy would throw away the position most likely to be the one
      // persisted next.
      if (barrier.deferred.length > MAX_DEFERRED) {
        barrier.deferred.sort((a, b) => a.slot - b.slot);
        barrier.deferred.splice(0, barrier.deferred.length - MAX_DEFERRED);
      }
      // Peak RETAINED, measured after the trim: what a soak should report is
      // how much was actually held, not the transient one-over before trimming.
      if (barrier.deferred.length > peakDeferred) peakDeferred = barrier.deferred.length;
      flush(wallet);
    },
    hold(wallet) {
      if (barriers.has(wallet)) {
        throw new Error(
          `cursor barrier for ${wallet} is already held — two wallet loops are running at once, ` +
            'which defeats the barrier silently. Make it counted before running loops concurrently.',
        );
      }
      barriers.set(wallet, {
        blocked: true,
        outstanding: new Set<number>(),
        sorted: [],
        head: 0,
        deferred: [],
      });
    },
    reserve(wallet, slots) {
      const barrier = barriers.get(wallet);
      if (barrier === undefined) {
        throw new Error(`cursor barrier for ${wallet} is not held — reserve without hold`);
      }
      barrier.blocked = false;
      barrier.outstanding = new Set(slots);
      barrier.sorted = [...barrier.outstanding].sort((a, b) => a - b);
      barrier.head = 0;
      if (barrier.outstanding.size > peakOutstanding) peakOutstanding = barrier.outstanding.size;
      flush(wallet);
    },
    barrierStats: () => ({ peakDeferred, peakOutstanding, heldNow: barriers.size }),
    release(wallet) {
      const barrier = barriers.get(wallet);
      if (barrier === undefined) return;
      barrier.blocked = false;
      barrier.outstanding.clear();
      barrier.head = barrier.sorted.length;
      flush(wallet);
      barriers.delete(wallet);
    },
    all() {
      return (statements.all.all() as CursorRow[]).map(toCursor);
    },
    close() {
      db.close();
    },
  };
}
```

---

## `src/db/ledger.ts`

```typescript
/**
 * The ledger — durable record of everything the bot intended and did.
 *
 * The design goal is narrow and absolute: **a crash mid-trade must never lose
 * track of a held token.** Three rules follow from it, and every choice below
 * exists to serve one of them.
 *
 * 1. INTENT BEFORE EXECUTION. An intent row is committed before the broker is
 *    called, so a process that dies during a swap leaves evidence that it was
 *    trying something. On restart those rows are pending, and pending means
 *    "we do not know what happened" — the loudest state in the system.
 *
 * 2. POSITIONS ARE DERIVED, NEVER ASSERTED. `fills` is the only source of
 *    truth. The `positions` table is a cache rebuilt by replaying fills, and
 *    is never written from a caller's idea of what a position should be. A
 *    position that disagrees with the fills is, by construction, impossible.
 *
 * 3. FILLS ARE IDEMPOTENT. A fill's primary key is derived from its content,
 *    so re-recording the same fill after a crash-and-retry is a no-op rather
 *    than a doubled position.
 *
 * SQL lives here and nowhere else; callers exchange `core` types only.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import type {
  Address,
  Fill,
  Lamports,
  OrderIntent,
  Position,
  Signature,
  TokenAmount,
  UnixMillis,
} from '../core/types.js';
import {
  absBigInt,
  baseUnitsToTokens,
  lamportsToSol,
  priceSolFromDeltas,
} from '../core/units.js';

// There is no dust threshold. With exact base units a full exit lands on 0n,
// and a leftover base unit means the position genuinely still holds one. The
// float version needed a fudge factor here; this one does not.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type IntentStatus =
  /** Written, outcome unknown. The only state a crash can leave behind. */
  | 'pending'
  /** A fill was recorded for it. */
  | 'filled'
  /** The guard layer or the broker refused it. No funds moved. */
  | 'rejected'
  /** Execution was attempted and errored. May or may not have touched chain. */
  | 'failed'
  /** Found pending at startup with no fill. Outcome genuinely unknown. */
  | 'orphaned';

export interface DailyPnl {
  /** UTC date, `YYYY-MM-DD`. */
  date: string;
  /** Realized profit (positive) or loss (negative) for the day, in lamports. Exact. */
  realizedLamports: Lamports;
  /** Fees paid across every fill that day, in lamports. Exact. */
  feesLamports: Lamports;
  /** Number of fills that day. */
  tradeCount: number;
}

export interface OrphanedIntent {
  id: string;
  side: OrderIntent['side'];
  mint: Address;
  /** Lamports for a buy, token base units for a sell. */
  amount: bigint;
  reason: string;
  createdAt: UnixMillis;
}

/**
 * On-chain data for an orphan whose transaction turned out to have confirmed.
 *
 * Required by the `tx-confirmed` resolution so that acknowledging one cannot be
 * separated from recording it: clearing the gate without booking the fill would
 * resume trading against a holding the ledger does not know about.
 */
export interface ConfirmedFillData {
  /** The confirming transaction found on chain. Becomes the fill's identity. */
  signature: Signature;
  /** Signed token change in base units, matching the intent's side. */
  tokensDelta: TokenAmount;
  /** The mint's decimals — required to interpret `tokensDelta` at all. */
  decimals: number;
  /** Signed lamport change excluding fees. */
  lamportsDelta: Lamports;
  /** Fees paid, in lamports. */
  feesLamports: Lamports;
  /** Chain time of the transaction, if known; otherwise when it was found. */
  at: UnixMillis;
}

/**
 * What an operator determined about an orphaned intent.
 *
 * A discriminated union rather than a string plus optional fields: the compiler
 * refuses `tx-confirmed` without the fill, so the dangerous combination cannot
 * be written.
 */
export type OrphanResolution =
  /** Checked the chain; the transaction never landed. Nothing was acquired. */
  | { kind: 'no-tx-on-chain' }
  /** The holding was dealt with by hand, outside the bot. */
  | { kind: 'manually-closed' }
  /** The transaction confirmed. The fill is recorded as part of acknowledging. */
  | { kind: 'tx-confirmed'; fill: ConfirmedFillData };

export type OrphanResolutionKind = OrphanResolution['kind'];

/** A recorded operator acknowledgement. */
export interface OrphanAcknowledgement {
  intentId: string;
  acknowledgedAt: UnixMillis;
  acknowledgedBy: string;
  resolution: OrphanResolutionKind;
}

/** Thrown when an acknowledgement is invalid or would be a no-op. */
export class AcknowledgementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcknowledgementError';
  }
}

export interface RecoveredIntent extends OrphanedIntent {
  /** When the fill that settles this intent landed. */
  filledAt: UnixMillis;
  /** Signed token change the recovered fill applied, in base units. */
  tokensDelta: TokenAmount;
}

/**
 * What `reconcileOnStartup()` found **on disk**.
 *
 * DECISION (recorded, not accidental): reconciliation is against the local
 * ledger only. It never queries chain, and "reconciles clean" here means
 * "no intent was left pending" — *not* "the wallet matches the books".
 *
 * Those differ in exactly one case, and it is the dangerous one: the process
 * died after a swap confirmed but before its fill was written. Disk says
 * `pending`; the chain says you hold 40,000 tokens. No position exists, so
 * `guards.guardSell` would reject an exit with `NO_OPEN_POSITION` — the bot is
 * holding something it cannot sell.
 *
 * The orphan gate is the deliberate substitute for on-chain reconciliation: a
 * human checks the wallet and runs `npm run orphans ack`, and `tx-confirmed`
 * books the fill so the position becomes exitable. Entries stay blocked until
 * they do. That is a human-in-the-loop stand-in, not an equivalent.
 *
 * Consequences for later work:
 *  - Any preflight that claims "the ledger reconciles clean" must compare
 *    against **chain balances**, not this report. This report cannot make that
 *    claim and does not try to.
 *  - In paper mode the gap never bites, because a simulated fill cannot land
 *    without the ledger writing it. Do not let paper-mode green mislead.
 */
export interface ReconcileReport {
  /** Every position still holding tokens, rebuilt from fills. */
  openPositions: Position[];
  /**
   * Intents that were pending at startup but do have a fill: the trade landed
   * and the process died before marking it resolved. Now marked `filled`.
   * Recorded exposure, recovered cleanly.
   */
  recovered: RecoveredIntent[];
  /**
   * Intents that were pending at startup with no fill. Now marked `orphaned`.
   *
   * **This is not proof that nothing happened.** The database cannot see
   * on-chain state: a swap may have confirmed in the instant between the
   * broker call and the crash. Every entry here needs the wallet checked
   * against chain before the bot is trusted to trade again.
   */
  orphaned: OrphanedIntent[];
  /** True if anything needed recovering — worth surfacing in the UI. */
  dirty: boolean;
}

/** Structured logging port, mirroring `core/guards.ts`. Pino is wired in `services/`. */
export interface LedgerLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface LedgerOptions {
  /** SQLite file path. `:memory:` is accepted for tests. */
  path: string;
  logger: LedgerLogger;
}

// ---------------------------------------------------------------------------
// Row shapes (private — never escape this module)
// ---------------------------------------------------------------------------

// The connection runs with `defaultSafeIntegers`, so every INTEGER column comes
// back as a bigint. Fields that are logically counts or timestamps are narrowed
// to `number` in the mappers below; exact money and token columns stay bigint.

interface FillRow {
  id: string;
  intent_id: string;
  side: 'buy' | 'sell';
  mint: string;
  tokens_delta: bigint;
  lamports_delta: bigint;
  fees_lamports: bigint;
  decimals: bigint;
  slippage_bps: number | null;
  simulated: bigint;
  signature: string | null;
  at: bigint;
}

interface PositionRow {
  mint: string;
  tokens: bigint;
  cost_lamports: bigint;
  decimals: bigint;
  opened_at: bigint;
  state: 'open' | 'closed';
  last_price_sol: number;
  updated_at: bigint;
}

interface IntentRow {
  id: string;
  side: 'buy' | 'sell';
  mint: string;
  amount: bigint;
  reason: string;
  status: IntentStatus;
  created_at: bigint;
  resolved_at: bigint | null;
  rejection_code: string | null;
  acknowledged_at: bigint | null;
  acknowledged_by: string | null;
  resolution: OrphanResolutionKind | null;
}

interface DailyPnlRow {
  date: string;
  realized_lamports: bigint;
  fees_lamports: bigint;
  trade_count: bigint;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Schema version, stored in `PRAGMA user_version`.
 *
 * 2 introduced exact integer money: token amounts in base units and SOL in
 * lamports, replacing whole-token and whole-SOL floats.
 */
const SCHEMA_VERSION = 2;

const INDEXES = `
CREATE INDEX IF NOT EXISTS fills_mint_at  ON fills (mint, at);
CREATE INDEX IF NOT EXISTS fills_intent   ON fills (intent_id);
CREATE INDEX IF NOT EXISTS intents_status ON intents (status);
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fills (
  id           TEXT    PRIMARY KEY,
  intent_id    TEXT    NOT NULL,
  side         TEXT    NOT NULL CHECK (side IN ('buy', 'sell')),
  mint         TEXT    NOT NULL,
  -- Exact integers, not REAL. Base units for tokens, lamports for SOL.
  tokens_delta INTEGER NOT NULL,
  lamports_delta INTEGER NOT NULL,
  fees_lamports  INTEGER NOT NULL,
  -- The mint's decimals at fill time; base units mean nothing without it.
  decimals     INTEGER NOT NULL,
  -- Nullable on purpose: NULL means "not measurable", which is not the same
  -- claim as 0 bps. See \`Fill.slippageBps\`.
  slippage_bps REAL,
  simulated    INTEGER NOT NULL CHECK (simulated IN (0, 1)),
  -- NULL exactly when simulated. For live fills this duplicates \`id\`, which is
  -- the signature; stored explicitly so a row can be turned back into a
  -- \`LiveFill\` without reinterpreting the primary key.
  signature    TEXT,
  at           INTEGER NOT NULL,
  CHECK ((simulated = 1 AND signature IS NULL) OR (simulated = 0 AND signature IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS positions (
  mint           TEXT    PRIMARY KEY,
  -- Exact holdings and cost basis. Prices are derived on read, never stored.
  tokens         INTEGER NOT NULL,
  cost_lamports  INTEGER NOT NULL,
  decimals       INTEGER NOT NULL,
  opened_at      INTEGER NOT NULL,
  state          TEXT    NOT NULL CHECK (state IN ('open', 'closed')),
  last_price_sol REAL    NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS intents (
  id             TEXT    PRIMARY KEY,
  side           TEXT    NOT NULL CHECK (side IN ('buy', 'sell')),
  mint           TEXT    NOT NULL,
  -- Lamports for a buy, token base units for a sell. Exact either way.
  amount         INTEGER NOT NULL,
  reason         TEXT    NOT NULL,
  status         TEXT    NOT NULL CHECK (
                   status IN ('pending', 'filled', 'rejected', 'failed', 'orphaned')
                 ),
  created_at     INTEGER NOT NULL,
  resolved_at    INTEGER,
  rejection_code TEXT,
  -- Operator acknowledgement of a crash orphan. NULL means unacknowledged,
  -- which is what holds the entry gate shut across restarts.
  acknowledged_at INTEGER,
  acknowledged_by TEXT,
  resolution      TEXT CHECK (
                    resolution IS NULL
                    OR resolution IN ('no-tx-on-chain', 'manually-closed', 'tx-confirmed')
                  )
);

CREATE TABLE IF NOT EXISTS daily_pnl (
  date              TEXT    PRIMARY KEY,
  realized_lamports INTEGER NOT NULL,
  fees_lamports     INTEGER NOT NULL,
  trade_count       INTEGER NOT NULL
);
`;

/** Thrown when a ledger file predates the current schema and cannot be converted. */
export class LedgerVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerVersionError';
  }
}

/**
 * Check the schema version, and refuse to open anything older.
 *
 * There is deliberately no automatic upgrade from version 1. Those rows store
 * token amounts as whole-token floats and never recorded the mint's decimals,
 * so converting them to base units would require guessing the scale of every
 * historical fill. A wrong guess is off by three or nine orders of magnitude on
 * a position the bot then thinks it can sell. Refusing is the safe answer, and
 * the data is not lost — it is still in the file.
 */
function checkVersion(db: Db, path: string): void {
  const version = Number(db.pragma('user_version', { simple: true }));

  const hasTables =
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'fills'`)
        .get() as { n: number | bigint }
    ).n > 0;

  if (!hasTables) {
    // Brand new file: stamp it and carry on.
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    return;
  }

  if (version === SCHEMA_VERSION) return;

  throw new LedgerVersionError(
    `Ledger at ${path} is schema version ${version}; this build requires ${SCHEMA_VERSION}.\n` +
      'Version 2 stores token amounts in base units and SOL in lamports. Version 1 rows\n' +
      'hold whole-token floats with no record of each mint\'s decimals, so they cannot be\n' +
      'converted without guessing the scale — which would misstate real holdings.\n' +
      'Archive the old file and start a fresh ledger.',
  );
}

// Note the absence of a foreign key from fills.intent_id to intents.id. A fill
// is the record that funds moved; it must always be writable, even if its
// intent row is somehow missing. A constraint here could reject the one write
// the system genuinely cannot afford to lose.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** UTC calendar date for a timestamp, `YYYY-MM-DD`. */
export function utcDate(at: UnixMillis): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Identity of a fill, used as its primary key.
 *
 * Live fills key on the confirming signature: chain-assigned, globally unique,
 * and — critically — identical when a post-crash retry re-observes the same
 * transaction. Simulated fills have no signature and key on `intentId:mint`,
 * which is equally stable because a paper fill never splits across
 * transactions.
 *
 * `at` is deliberately absent from both. It comes from the local clock, so a
 * retry produces a different value; including it would make every retry a new
 * row and double the position on replay.
 *
 * The paper branch is unreachable in live mode by construction: narrowing on
 * `simulated` gives the compiler a `LiveFill`, where `signature` is required.
 */
export function fillId(fill: Fill): string {
  return fill.simulated ? `${fill.intentId}:${fill.mint}` : fill.signature;
}

function toFill(row: FillRow): Fill {
  const base = {
    intentId: row.intent_id,
    side: row.side,
    mint: row.mint,
    tokensDelta: row.tokens_delta,
    lamportsDelta: row.lamports_delta,
    feesLamports: row.fees_lamports,
    decimals: Number(row.decimals),
    slippageBps: row.slippage_bps,
    at: Number(row.at),
  };

  if (row.simulated === 1n) return { ...base, simulated: true };
  if (row.signature === null) {
    // Guarded by a CHECK constraint; reaching here means the file was edited
    // outside this module.
    throw new Error(`live fill ${row.id} has no signature`);
  }
  return { ...base, simulated: false, signature: row.signature };
}

/** The amount an intent is denominated in — lamports for buys, base units for sells. */
function intentAmount(intent: OrderIntent): bigint {
  return intent.side === 'buy' ? (intent.amountLamports ?? 0n) : (intent.amountTokens ?? 0n);
}

function toPosition(row: PositionRow): Position {
  const decimals = Number(row.decimals);
  const wholeTokens = baseUnitsToTokens(row.tokens, decimals);
  // Derived on read from the exact fields — never stored, so they cannot drift
  // away from the integers they describe.
  const avgEntrySol = wholeTokens === 0 ? 0 : lamportsToSol(row.cost_lamports) / wholeTokens;

  return {
    mint: row.mint,
    tokens: row.tokens,
    costLamports: row.cost_lamports,
    decimals,
    openedAt: Number(row.opened_at),
    avgEntrySol,
    lastPriceSol: row.last_price_sol,
    unrealizedSol: wholeTokens * (row.last_price_sol - avgEntrySol),
    state: row.state,
  };
}

function toOrphan(row: IntentRow): OrphanedIntent {
  return {
    id: row.id,
    side: row.side,
    mint: row.mint,
    amount: row.amount,
    reason: row.reason,
    createdAt: Number(row.created_at),
  };
}

/** Replay outcome for one mint. */
interface Replayed {
  position: PositionRow;
  /** Realized P&L per UTC date contributed by this mint's sells, in lamports. */
  realizedByDate: Map<string, bigint>;
}

/**
 * Rebuild one mint's position by replaying its fills in order.
 *
 * All of this is integer arithmetic. Cost basis is fee-inclusive: a buy's basis
 * is the lamports it consumed plus the fees it cost, which is what the position
 * actually has to earn back.
 *
 * Basis relief on a partial sell is `cost * sold / held`, floor-divided. The
 * remainder — at most `held - 1` lamports, so sub-nanosol in practice — stays
 * with the tokens still held, and is zeroed on a full exit. Rounding therefore
 * never invents or destroys a lamport across the life of a position.
 */
function replayMint(mint: string, fills: FillRow[]): Replayed {
  let tokens = 0n;
  let costLamports = 0n;
  let decimals = fills[0] === undefined ? 0 : Number(fills[0].decimals);
  let openedAt = fills[0]?.at ?? 0n;
  let lastPriceSol = 0;
  let updatedAt = 0n;
  const realizedByDate = new Map<string, bigint>();

  for (const fill of fills) {
    decimals = Number(fill.decimals);
    updatedAt = fill.at;
    const price = priceSolFromDeltas(fill.lamports_delta, fill.tokens_delta, decimals);
    if (price > 0) lastPriceSol = price;

    if (fill.side === 'buy') {
      // A buy arriving at a flat position starts a new holding period.
      if (tokens === 0n) openedAt = fill.at;
      tokens += fill.tokens_delta;
      costLamports += absBigInt(fill.lamports_delta) + fill.fees_lamports;
      continue;
    }

    // Sell: relieve basis proportionally and book the difference as realized.
    const requested = absBigInt(fill.tokens_delta);
    const sold = requested > tokens ? tokens : requested;
    const relieved = tokens === 0n ? 0n : (costLamports * sold) / tokens;
    const realized = absBigInt(fill.lamports_delta) - relieved - fill.fees_lamports;

    const date = utcDate(Number(fill.at));
    realizedByDate.set(date, (realizedByDate.get(date) ?? 0n) + realized);

    tokens -= sold;
    costLamports -= relieved;
    // A full exit is exactly zero — no threshold needed, and none wanted: a
    // leftover base unit means the position really does still hold one.
    if (tokens === 0n) costLamports = 0n;
  }

  return {
    position: {
      mint,
      tokens,
      cost_lamports: costLamports,
      decimals: BigInt(decimals),
      opened_at: openedAt,
      // The only two states there are. `'closing'` was removed from
      // `PositionState` on 2026-08-03: it is not derivable from fills, and a
      // position table that asserts anything a fill does not say is the end of
      // rule 2. See the type.
      state: tokens > 0n ? 'open' : 'closed',
      last_price_sol: lastPriceSol,
      updated_at: updatedAt,
    },
    realizedByDate,
  };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export interface Ledger {
  /**
   * Commit an intent as `pending`. Call this BEFORE touching the broker.
   *
   * Idempotent: re-recording an id that already exists is a no-op, never a
   * reset. Safe for the tracker and the broker to both call.
   */
  recordIntent(intent: OrderIntent, at?: UnixMillis): void;
  /** Mark an intent resolved. `rejectionCode` carries a `GuardCode` or error tag. */
  resolveIntent(
    id: string,
    status: Exclude<IntentStatus, 'pending'>,
    rejectionCode?: string,
    at?: UnixMillis,
  ): void;
  /** Record a fill and re-derive the projections it affects. Idempotent. */
  recordFill(fill: Fill): void;
  getPositions(): Position[];
  getOpenPositions(): Position[];
  getPosition(mint: Address): Position | undefined;
  getIntentStatus(id: string): IntentStatus | undefined;
  getFillsForIntent(id: string): Fill[];
  /**
   * Net lamports moved by recorded fills: `sum(lamportsDelta - feesLamports)`.
   *
   * Filtered by `simulated` so the paper wallet cannot be moved by live fills,
   * or vice versa. Exact — summed as integers in SQLite, returned as a bigint.
   */
  getNetLamportsFlow(options: { simulated: boolean }): Lamports;
  getDailyPnl(date: string): DailyPnl | undefined;
  /** Today's realized loss as positive lamports; 0n when flat or up. Exact. */
  getRealizedLossLamportsToday(now?: UnixMillis): Lamports;

  /** Crash orphans nobody has signed off on. Non-empty means entries are gated. */
  getUnacknowledgedOrphans(): OrphanedIntent[];
  /**
   * How many orphans are still unacknowledged.
   *
   * Queried by the guard layer on every buy — never cached — so an
   * acknowledgement made mid-session lifts the gate without a restart.
   */
  getUnacknowledgedOrphanCount(): number;
  /**
   * Sign off on one orphan. The only way to lift the gate.
   *
   * For `tx-confirmed` the fill is recorded in the same transaction, so the
   * position is on the books before trading can resume. Throws
   * `AcknowledgementError` if the intent is not an unacknowledged orphan or the
   * supplied fill data is inconsistent with it.
   */
  acknowledgeOrphan(
    id: string,
    operator: string,
    resolution: OrphanResolution,
    at?: UnixMillis,
  ): void;
  getAcknowledgement(id: string): OrphanAcknowledgement | undefined;
  /** Rebuild in-memory state from disk and resolve anything a crash left behind. */
  reconcileOnStartup(now?: UnixMillis): ReconcileReport;
  close(): void;
}

export function openLedger({ path, logger }: LedgerOptions): Ledger {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db: Db = new Database(path);

  // WAL lets reads proceed during writes and, more importantly here, survives a
  // hard kill with committed transactions intact.
  db.pragma('journal_mode = WAL');
  // FULL, not NORMAL. NORMAL survives a process crash but can lose the last
  // commits to a power cut — and the write we cannot lose is the one saying we
  // are holding a token.
  db.pragma('synchronous = FULL');

  // Every INTEGER column comes back as a bigint. Uniform, so there is one rule
  // to remember instead of a per-column exception list; the row mappers narrow
  // timestamps and counts back to `number`.
  db.defaultSafeIntegers(true);

  checkVersion(db, path);
  db.exec(SCHEMA);
  db.exec(INDEXES);

  const statements = {
    // `ON CONFLICT(id) DO NOTHING`, not `OR IGNORE`, and not `OR REPLACE`.
    //
    // The idempotency this needs is narrow: an intent id is immutable, and more
    // than one layer legitimately records the same intent — the tracker writes
    // it first, and the broker writes it again defensively at the top of
    // `execute`. REPLACE would reset an already-resolved row back to `pending`,
    // which a later reconcile would report as a crash orphan that never
    // happened.
    //
    // `OR IGNORE` bought that at far too high a price: it suppresses EVERY
    // constraint failure, not just the primary key. Measured on 2026-08-03, an
    // intent whose `amount` was `NaN` bound as NULL, violated `amount INTEGER
    // NOT NULL`, and was silently discarded — while `Tracker.submit` returned a
    // Fill and emitted `intent-created` and `fill`. The event stream said a
    // trade happened and the ledger, which is the source of truth, had no row
    // for it.
    //
    // Targeting the conflict at `id` keeps the retry-safety and lets every
    // other constraint do its job: a NOT NULL or CHECK violation now throws.
    insertIntent: db.prepare<
      [string, string, string, bigint, string, number]
    >(`INSERT INTO intents
         (id, side, mint, amount, reason, status, created_at, resolved_at, rejection_code)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)
       ON CONFLICT(id) DO NOTHING`),

    resolveIntent: db.prepare<[string, number, string | null, string]>(
      `UPDATE intents SET status = ?, resolved_at = ?, rejection_code = ? WHERE id = ?`,
    ),

    insertFill: db.prepare<
      [
        string,
        string,
        string,
        string,
        bigint,
        bigint,
        bigint,
        number,
        number | null,
        number,
        string | null,
        number,
      ]
    // Same narrowing, same reason. A fill is the record that funds moved; a
    // fill that cannot be written must be an error, never a silence.
    >(`INSERT INTO fills
         (id, intent_id, side, mint, tokens_delta, lamports_delta, fees_lamports,
          decimals, slippage_bps, simulated, signature, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`),

    // Tie-break on `rowid`, not `id`. `at` is the local wall clock, so two
    // fills for one mint can genuinely share a millisecond; `id` is content-
    // derived (`intentId:mint`, or the signature), so falling back to it orders
    // by an alphabet that carries no causal meaning. A buy `seed:MINT` and a
    // sell `exit:MINT` in the same millisecond replayed sell-first, which
    // relieves basis that was never acquired and leaves the position `open`
    // after a completed exit.
    //
    // `rowid` is SQLite's insertion order, which is the causal order: a fill
    // cannot be inserted before the fill it follows. `fills` is a plain rowid
    // table (no WITHOUT ROWID) and rows are never deleted, so the value is
    // stable, and the `ON CONFLICT(id) DO NOTHING` insert means re-recording a
    // fill after a crash keeps the original position in the sequence rather
    // than moving it to the end.
    allFills: db.prepare(`SELECT * FROM fills ORDER BY at ASC, rowid ASC`),
    netLamportsFlow: db.prepare<[number]>(
      `SELECT COALESCE(SUM(lamports_delta - fees_lamports), 0) AS net
         FROM fills WHERE simulated = ?`,
    ),
    fillById: db.prepare<[string]>(`SELECT intent_id FROM fills WHERE id = ?`),
    // Same tie-break, for the same reason. This query had none at all, so ties
    // fell to whatever order the `fills_intent` index happened to yield;
    // `reconcileTx` reads `fills.at(-1)` to date a recovered intent, and an
    // unspecified order makes that read unspecified too.
    fillsByIntent: db.prepare<[string]>(
      `SELECT * FROM fills WHERE intent_id = ? ORDER BY at ASC, rowid ASC`,
    ),
    upsertPosition: db.prepare<
      [string, bigint, bigint, number, number, string, number, number]
    >(`INSERT OR REPLACE INTO positions
         (mint, tokens, cost_lamports, decimals, opened_at, state, last_price_sol, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    allPositions: db.prepare(`SELECT * FROM positions ORDER BY opened_at ASC`),
    openPositions: db.prepare(
      `SELECT * FROM positions WHERE state = 'open' ORDER BY opened_at ASC`,
    ),
    positionByMint: db.prepare<[string]>(`SELECT * FROM positions WHERE mint = ?`),
    clearPositions: db.prepare(`DELETE FROM positions`),

    clearPnl: db.prepare(`DELETE FROM daily_pnl`),
    upsertPnl: db.prepare<[string, bigint, bigint, number]>(
      `INSERT OR REPLACE INTO daily_pnl (date, realized_lamports, fees_lamports, trade_count)
       VALUES (?, ?, ?, ?)`,
    ),
    pnlByDate: db.prepare<[string]>(`SELECT * FROM daily_pnl WHERE date = ?`),

    intentStatus: db.prepare<[string]>(`SELECT status FROM intents WHERE id = ?`),
    intentById: db.prepare<[string]>(`SELECT * FROM intents WHERE id = ?`),
    pendingIntents: db.prepare(
      `SELECT * FROM intents WHERE status = 'pending' ORDER BY created_at ASC`,
    ),

    unacknowledgedOrphans: db.prepare(
      `SELECT * FROM intents
        WHERE status = 'orphaned' AND acknowledged_at IS NULL
        ORDER BY created_at ASC`,
    ),
    unacknowledgedOrphanCount: db.prepare(
      `SELECT COUNT(*) AS n FROM intents
        WHERE status = 'orphaned' AND acknowledged_at IS NULL`,
    ),
    acknowledgeOrphan: db.prepare<[number, string, string, string]>(
      `UPDATE intents
          SET acknowledged_at = ?, acknowledged_by = ?, resolution = ?
        WHERE id = ?`,
    ),
  };

  /**
   * Recompute `positions` and `daily_pnl` from the full fills history.
   *
   * Deliberately a total rebuild rather than an incremental update. Derived
   * tables that are patched drift; derived tables that are recomputed cannot.
   * The cost is a replay per write, which is trivial at the scale this bot
   * operates at (thousands of fills). If the history ever reaches the point
   * where this shows up in a profile, the fix is a checkpoint row — not
   * incremental patching.
   */
  function rebuildProjections(): void {
    const fills = statements.allFills.all() as FillRow[];

    const byMint = new Map<string, FillRow[]>();
    for (const fill of fills) {
      const bucket = byMint.get(fill.mint);
      if (bucket === undefined) byMint.set(fill.mint, [fill]);
      else bucket.push(fill);
    }

    statements.clearPositions.run();
    const realizedByDate = new Map<string, bigint>();

    for (const [mint, mintFills] of byMint) {
      const { position, realizedByDate: mintRealized } = replayMint(mint, mintFills);
      statements.upsertPosition.run(
        position.mint,
        position.tokens,
        position.cost_lamports,
        Number(position.decimals),
        Number(position.opened_at),
        position.state,
        position.last_price_sol,
        Number(position.updated_at),
      );
      for (const [date, realized] of mintRealized) {
        realizedByDate.set(date, (realizedByDate.get(date) ?? 0n) + realized);
      }
    }

    // Fees and trade counts are per-fill and mint-independent.
    const feesByDate = new Map<string, bigint>();
    const countByDate = new Map<string, number>();
    for (const fill of fills) {
      const date = utcDate(Number(fill.at));
      feesByDate.set(date, (feesByDate.get(date) ?? 0n) + fill.fees_lamports);
      countByDate.set(date, (countByDate.get(date) ?? 0) + 1);
    }

    statements.clearPnl.run();
    for (const date of new Set([...realizedByDate.keys(), ...feesByDate.keys()])) {
      statements.upsertPnl.run(
        date,
        realizedByDate.get(date) ?? 0n,
        feesByDate.get(date) ?? 0n,
        countByDate.get(date) ?? 0,
      );
    }
  }

  function insertFill(fill: Fill): void {
    statements.insertFill.run(
      fillId(fill),
      fill.intentId,
      fill.side,
      fill.mint,
      fill.tokensDelta,
      fill.lamportsDelta,
      fill.feesLamports,
      fill.decimals,
      fill.slippageBps,
      fill.simulated ? 1 : 0,
      fill.simulated ? null : fill.signature,
      fill.at,
    );
  }

  const recordFillTx = db.transaction((fill: Fill) => {
    insertFill(fill);
    rebuildProjections();
  });

  const reconcileTx = db.transaction((now: UnixMillis): ReconcileReport => {
    // Projections first: the pending sweep below reads the fills they derive from.
    rebuildProjections();

    const pending = statements.pendingIntents.all() as IntentRow[];
    const recovered: RecoveredIntent[] = [];
    const orphaned: OrphanedIntent[] = [];

    for (const row of pending) {
      const fills = statements.fillsByIntent.all(row.id) as FillRow[];
      const last = fills.at(-1);

      if (last !== undefined) {
        // The trade landed; only the bookkeeping was lost. Nothing is at risk.
        statements.resolveIntent.run('filled', Number(last.at), null, row.id);
        recovered.push({
          ...toOrphan(row),
          filledAt: Number(last.at),
          tokensDelta: fills.reduce((sum, fill) => sum + fill.tokens_delta, 0n),
        });
        continue;
      }

      // No fill. The swap may still have confirmed on chain — the database
      // cannot tell. Mark it and make noise.
      statements.resolveIntent.run('orphaned', now, 'CRASH_ORPHAN', row.id);
      orphaned.push(toOrphan(row));
    }

    const openPositions = (statements.openPositions.all() as PositionRow[]).map(toPosition);
    return { openPositions, recovered, orphaned, dirty: recovered.length + orphaned.length > 0 };
  });

  /**
   * Acknowledge one orphan.
   *
   * A single transaction: for `tx-confirmed`, the fill is inserted and the
   * projections rebuilt in the same atomic step that clears the flag. There is
   * no ordering in which the gate lifts while the holding is still off the
   * books.
   */
  const acknowledgeOrphanTx = db.transaction(
    (
      id: string,
      operator: string,
      resolution: OrphanResolution,
      at: UnixMillis,
    ): void => {
      const row = statements.intentById.get(id) as IntentRow | undefined;
      if (row === undefined) {
        throw new AcknowledgementError(`no intent with id ${id}`);
      }
      if (row.status !== 'orphaned') {
        throw new AcknowledgementError(
          `intent ${id} is ${row.status}, not orphaned — only crash orphans are acknowledged`,
        );
      }
      if (row.acknowledged_at !== null) {
        throw new AcknowledgementError(
          `intent ${id} was already acknowledged by ${row.acknowledged_by ?? 'unknown'}`,
        );
      }
      if (operator.trim().length === 0) {
        throw new AcknowledgementError('an operator name is required');
      }

      if (resolution.kind === 'tx-confirmed') {
        const {
          signature,
          tokensDelta,
          decimals,
          lamportsDelta,
          feesLamports,
          at: filledAt,
        } = resolution.fill;

        if (signature.trim().length === 0) {
          throw new AcknowledgementError('tx-confirmed requires the transaction signature');
        }
        if (tokensDelta === 0n) {
          throw new AcknowledgementError('tx-confirmed requires a non-zero tokensDelta');
        }
        // A sign error here would book the opposite of what happened, so it is
        // rejected rather than corrected.
        const expectedPositive = row.side === 'buy';
        if (expectedPositive !== tokensDelta > 0n) {
          throw new AcknowledgementError(
            `tokensDelta ${tokensDelta} has the wrong sign for a ${row.side}`,
          );
        }
        if (feesLamports < 0n) {
          throw new AcknowledgementError('feesLamports cannot be negative');
        }
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
          throw new AcknowledgementError(`decimals ${decimals} is not a plausible mint scale`);
        }

        // `insertFill` ignores a primary-key conflict, so a signature already on file would
        // silently no-op while this intent was still marked filled and the gate
        // lifted — the exact shape of a stranded position. An orphan has no
        // fills by construction (reconcile files anything with a fill as
        // `filled`), so a collision always means the wrong signature was
        // supplied.
        const collision = statements.fillById.get(signature) as
          | { intent_id: string }
          | undefined;
        if (collision !== undefined && collision.intent_id !== id) {
          throw new AcknowledgementError(
            `signature ${signature} is already recorded against intent ${collision.intent_id}`,
          );
        }

        insertFill({
          intentId: id,
          side: row.side,
          mint: row.mint,
          tokensDelta,
          lamportsDelta,
          decimals,
          feesLamports,
          // Not measurable: the quote that motivated this intent is long gone.
          // Explicitly null, never 0 — a synthetic "perfect execution" would
          // bias anything calibrated on realized slippage.
          slippageBps: null,
          simulated: false,
          signature,
          at: filledAt,
        });
        rebuildProjections();

        // The intent is settled by a real fill, so it is no longer an orphan.
        statements.resolveIntent.run('filled', filledAt, null, id);
      }

      statements.acknowledgeOrphan.run(at, operator, resolution.kind, id);
    },
  );

  return {
    recordIntent(intent, at = Date.now()) {
      statements.insertIntent.run(
        intent.id,
        intent.side,
        intent.mint,
        intentAmount(intent),
        intent.reason,
        at,
      );
    },

    resolveIntent(id, status, rejectionCode, at = Date.now()) {
      statements.resolveIntent.run(status, at, rejectionCode ?? null, id);
    },

    recordFill(fill) {
      recordFillTx(fill);
    },

    getPositions() {
      return (statements.allPositions.all() as PositionRow[]).map(toPosition);
    },

    getOpenPositions() {
      return (statements.openPositions.all() as PositionRow[]).map(toPosition);
    },

    getPosition(mint) {
      const row = statements.positionByMint.get(mint) as PositionRow | undefined;
      return row === undefined ? undefined : toPosition(row);
    },

    getIntentStatus(id) {
      const row = statements.intentStatus.get(id) as { status: IntentStatus } | undefined;
      return row?.status;
    },

    getFillsForIntent(id) {
      return (statements.fillsByIntent.all(id) as FillRow[]).map(toFill);
    },

    getNetLamportsFlow({ simulated }) {
      // Summed in SQLite over INTEGER columns and read back as a bigint, so the
      // total never passes through a float. The `simulated` filter keeps the
      // paper wallet and a real wallet strictly separate: a live fill must
      // never move the simulated balance, or paper P&L silently inherits real
      // trades.
      const row = statements.netLamportsFlow.get(simulated ? 1 : 0) as { net: bigint };
      return row.net;
    },

    getUnacknowledgedOrphans() {
      return (statements.unacknowledgedOrphans.all() as IntentRow[]).map(toOrphan);
    },

    getUnacknowledgedOrphanCount() {
      // COUNT(*) arrives as a bigint under `defaultSafeIntegers`. This is a
      // count, not money, so it is narrowed here rather than leaking outward.
      const row = statements.unacknowledgedOrphanCount.get() as { n: bigint };
      return Number(row.n);
    },

    acknowledgeOrphan(id, operator, resolution, at = Date.now()) {
      acknowledgeOrphanTx(id, operator, resolution, at);
      logger.warn(
        { intentId: id, operator, resolution: resolution.kind },
        `Orphan ${id} acknowledged by ${operator} as ${resolution.kind}`,
      );
    },

    getAcknowledgement(id) {
      const row = statements.intentById.get(id) as IntentRow | undefined;
      if (row?.acknowledged_at == null || row.acknowledged_by === null) return undefined;
      return {
        intentId: row.id,
        acknowledgedAt: Number(row.acknowledged_at),
        acknowledgedBy: row.acknowledged_by,
        resolution: row.resolution ?? 'no-tx-on-chain',
      };
    },

    getDailyPnl(date) {
      const row = statements.pnlByDate.get(date) as DailyPnlRow | undefined;
      if (row === undefined) return undefined;
      return {
        date: row.date,
        realizedLamports: row.realized_lamports,
        feesLamports: row.fees_lamports,
        tradeCount: Number(row.trade_count),
      };
    },

    getRealizedLossLamportsToday(now = Date.now()) {
      const row = statements.pnlByDate.get(utcDate(now)) as DailyPnlRow | undefined;
      if (row === undefined) return 0n;
      return row.realized_lamports < 0n ? -row.realized_lamports : 0n;
    },

    reconcileOnStartup(now = Date.now()) {
      const report = reconcileTx(now);

      for (const intent of report.recovered) {
        logger.info(
          { intentId: intent.id, mint: intent.mint, side: intent.side, filledAt: intent.filledAt },
          `Recovered ${intent.side} of ${intent.mint}: fill was on disk, intent left pending by a crash`,
        );
      }

      for (const intent of report.orphaned) {
        logger.warn(
          { intentId: intent.id, mint: intent.mint, side: intent.side, amount: intent.amount },
          `CRASH ORPHAN: ${intent.side} of ${intent.mint} was pending with no fill — verify the wallet against chain before trading`,
        );
      }

      logger.info(
        {
          openPositions: report.openPositions.length,
          recovered: report.recovered.length,
          orphaned: report.orphaned.length,
        },
        `Reconciled ledger: ${report.openPositions.length} open position(s)`,
      );

      return report;
    },

    close() {
      db.close();
    },
  };
}
```
