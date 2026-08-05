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
