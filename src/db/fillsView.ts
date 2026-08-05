/**
 * Read-only listing of recent fills, for `GET /fills`.
 *
 * ── WHY THIS IS A SEPARATE MODULE, AND WHY THAT IS TEMPORARY ──────────────
 *
 * `Ledger` has no "most recent N fills" query. It can return the fills for one
 * intent and it can return positions, and that is all the API needs except
 * this. The prompt that added this module restricted `ledger.ts` to a single
 * change (the replay tie-break), so the query lives here, on its own read-only
 * connection to the same file — the precedent `cursors.ts` set in handoff 07.
 *
 * **This splits ownership of the `fills` table across two modules, which is a
 * cost, not a feature.** `ledger.ts` is the authority: it owns the schema, the
 * write path, and the projections. Nothing here writes, and nothing here
 * interprets — the row-to-`Fill` mapping is the same one `ledger.ts` performs,
 * duplicated rather than shared because exporting it would have meant editing
 * `ledger.ts`. Fold this into `Ledger.getRecentFills()` the next time that file
 * is open for edit, and delete this module.
 *
 * The connection is opened read-only, so the split cannot become a second
 * writer even by accident.
 */

import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import type { Address, Fill } from '../core/types.js';

/** Ceiling on `limit`, so a client cannot ask for the whole history at once. */
export const MAX_FILL_PAGE = 500;

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

export interface FillsView {
  /** Newest first. `limit` is clamped to `[1, MAX_FILL_PAGE]`. */
  recent(limit: number, options?: { mint?: Address }): Fill[];
  close(): void;
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
  if (row.signature === null) throw new Error(`live fill ${row.id} has no signature`);
  return { ...base, simulated: false, signature: row.signature };
}

export function openFillsView(options: { path: string }): FillsView {
  // `readonly` is load-bearing: it is what guarantees this second connection
  // cannot write to a table `ledger.ts` owns.
  const db: Db = new Database(options.path, { readonly: true });
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
  db.defaultSafeIntegers(true);

  const statements = {
    // Newest first, `rowid` breaking ties — the same tie-break the projection
    // replay uses, so a listing and a replay never disagree about which of two
    // fills sharing a millisecond came first.
    recent: db.prepare<[number]>(
      `SELECT * FROM fills ORDER BY at DESC, rowid DESC LIMIT ?`,
    ),
    recentForMint: db.prepare<[string, number]>(
      `SELECT * FROM fills WHERE mint = ? ORDER BY at DESC, rowid DESC LIMIT ?`,
    ),
  };

  return {
    recent(limit, listOptions = {}) {
      const capped = Math.max(1, Math.min(Math.floor(limit), MAX_FILL_PAGE));
      const rows =
        listOptions.mint === undefined
          ? (statements.recent.all(capped) as FillRow[])
          : (statements.recentForMint.all(listOptions.mint, capped) as FillRow[]);
      return rows.map(toFill);
    },

    close() {
      db.close();
    },
  };
}
