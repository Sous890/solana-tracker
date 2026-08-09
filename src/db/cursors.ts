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
  const flush = (wallet: Address): void => {
    const barrier = barriers.get(wallet);
    if (barrier === undefined) return;

    let limit: number;
    if (barrier.outstanding.size > 0) limit = Math.min(...barrier.outstanding);
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
      barriers.set(wallet, { blocked: true, outstanding: new Set<number>(), deferred: [] });
    },
    reserve(wallet, slots) {
      const barrier = barriers.get(wallet);
      if (barrier === undefined) {
        throw new Error(`cursor barrier for ${wallet} is not held — reserve without hold`);
      }
      barrier.blocked = false;
      barrier.outstanding = new Set(slots);
      if (barrier.outstanding.size > peakOutstanding) peakOutstanding = barrier.outstanding.size;
      flush(wallet);
    },
    barrierStats: () => ({ peakDeferred, peakOutstanding, heldNow: barriers.size }),
    release(wallet) {
      const barrier = barriers.get(wallet);
      if (barrier === undefined) return;
      barrier.blocked = false;
      barrier.outstanding.clear();
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
