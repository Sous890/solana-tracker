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

  return {
    get(wallet) {
      const row = statements.get.get(wallet) as CursorRow | undefined;
      return row === undefined ? undefined : toCursor(row);
    },
    set(wallet, signature, slot, at = Date.now()) {
      statements.upsert.run(wallet, signature, slot, at);
    },
    all() {
      return (statements.all.all() as CursorRow[]).map(toCursor);
    },
    close() {
      db.close();
    },
  };
}
