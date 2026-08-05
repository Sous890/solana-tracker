/**
 * Operator flags that must outlive the process.
 *
 * Exactly one flag today: the kill switch. It is here rather than in memory
 * because an operator who kills entries during an incident and then restarts
 * the bot has not changed their mind — an in-memory kill switch is cleared by
 * the very restart an incident tends to involve, which is the worst possible
 * moment to start buying again.
 *
 * A separate module and connection from `ledger.ts`, following the precedent
 * `cursors.ts` set in handoff 07: the ledger file is shared (WAL supports
 * several connections) but `runtime_flags` is independent of the ledger's
 * schema-version gate, which keys off the `fills` table.
 *
 * Stored as text rather than an integer so a future flag with a non-boolean
 * value does not need a schema change. `'1'` / `'0'` are the only values the
 * kill switch ever writes, and anything unrecognised reads as ENGAGED — the
 * safe direction, since a corrupt flag must not silently authorise entries.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import type { UnixMillis } from '../core/types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runtime_flags (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const KILL_SWITCH_KEY = 'kill_switch_engaged';

export interface RuntimeState {
  /** True when entries are blocked. Absent flag means not engaged. */
  killSwitchEngaged(): boolean;
  /** When it was last written, or `undefined` if it never has been. */
  killSwitchChangedAt(): UnixMillis | undefined;
  setKillSwitch(engaged: boolean, at?: UnixMillis): void;
  close(): void;
}

interface FlagRow {
  value: string;
  updated_at: bigint;
}

export function openRuntimeState(options: { path: string }): RuntimeState {
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
  // FULL, matching the ledger. The write that must not be lost to a power cut
  // is the one saying "stop buying".
  db.pragma('synchronous = FULL');
  db.defaultSafeIntegers(true);
  db.exec(SCHEMA);

  const statements = {
    get: db.prepare<[string]>('SELECT value, updated_at FROM runtime_flags WHERE key = ?'),
    set: db.prepare<[string, string, number]>(
      `INSERT OR REPLACE INTO runtime_flags (key, value, updated_at) VALUES (?, ?, ?)`,
    ),
  };

  const read = (): FlagRow | undefined =>
    statements.get.get(KILL_SWITCH_KEY) as FlagRow | undefined;

  return {
    killSwitchEngaged() {
      const row = read();
      // Never written: the bot has never been killed, so entries are allowed.
      if (row === undefined) return false;
      // Written: '0' is the only value that means "released". Anything else —
      // including a value some future version or a hand-edit left behind — is
      // treated as engaged, because failing closed costs a trade and failing
      // open costs the wallet.
      return row.value !== '0';
    },

    killSwitchChangedAt() {
      const row = read();
      return row === undefined ? undefined : Number(row.updated_at);
    },

    setKillSwitch(engaged, at = Date.now()) {
      statements.set.run(KILL_SWITCH_KEY, engaged ? '1' : '0', at);
    },

    close() {
      db.close();
    },
  };
}
