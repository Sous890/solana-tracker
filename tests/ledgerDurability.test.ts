/**
 * Snapshots, and the refusal to start on a ledger that was removed.
 *
 * Both exist because session 22 destroyed `data/` and the loss was silent: the
 * next run came up with an empty book and the only visible symptom was thirteen
 * truncated cold fills. Session 23 established that the destroyed rows were not
 * recoverable from the surviving session files — a rejected intent leaves no
 * trace in a session at all — so the fix has to be a copy, made before the loss.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SimulatedFill } from '../src/core/types.js';
import { openLedger } from '../src/db/ledger.js';
import type { Ledger } from '../src/db/ledger.js';
import {
  ALLOW_EMPTY_LEDGER_ENV,
  LedgerLostError,
  LedgerSnapshotter,
  assertLedgerPresent,
  listSnapshots,
  pruneSnapshots,
  sessionFileCount,
  snapshotLedger,
  snapshotName,
} from '../src/services/ledgerDurability.js';

const MINT = 'So11111111111111111111111111111111111111112';
const AT = 1_700_000_000_000;

function buyFill(overrides: Partial<SimulatedFill> = {}): SimulatedFill {
  return {
    intentId: 'intent-buy',
    side: 'buy',
    mint: MINT,
    tokensDelta: 1_000_000_000n,
    lamportsDelta: -50_000_000n,
    decimals: 6,
    feesLamports: 1_000_000n,
    slippageBps: 30,
    simulated: true,
    at: AT,
    ...overrides,
  };
}

let dir: string;
let dbPath: string;
let sessionsDir: string;
let snapshotDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'durability-'));
  dbPath = join(dir, 'data', 'tracker.db');
  sessionsDir = join(dir, 'sessions');
  snapshotDir = join(dir, 'snapshots');
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env[ALLOW_EMPTY_LEDGER_ENV];
});

// ---------------------------------------------------------------------------
// A3 — the refusal
// ---------------------------------------------------------------------------

describe('assertLedgerPresent', () => {
  it('refuses when the ledger is gone but sessions remain', () => {
    writeFileSync(join(sessionsDir, '20260806T041217Z-000.jsonl'), '{"seq":1}\n');

    expect(() => assertLedgerPresent({ dbPath, sessionsDir, snapshotDir })).toThrow(
      LedgerLostError,
    );
    // The message has to carry the way out, or it is just an obstacle.
    expect(() => assertLedgerPresent({ dbPath, sessionsDir, snapshotDir })).toThrow(
      new RegExp(ALLOW_EMPTY_LEDGER_ENV),
    );
  });

  it('allows a genuine first run: no ledger and no sessions', () => {
    expect(() => assertLedgerPresent({ dbPath, sessionsDir })).not.toThrow();
  });

  it('allows a missing sessions directory entirely', () => {
    rmSync(sessionsDir, { recursive: true, force: true });
    expect(() => assertLedgerPresent({ dbPath, sessionsDir })).not.toThrow();
  });

  it('allows when the ledger exists, however many sessions there are', () => {
    writeFileSync(join(sessionsDir, 'a.jsonl'), '{}\n');
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(dbPath, '');
    expect(() => assertLedgerPresent({ dbPath, sessionsDir })).not.toThrow();
  });

  it('honours the explicit override, and the environment one', () => {
    writeFileSync(join(sessionsDir, 'a.jsonl'), '{}\n');

    expect(() =>
      assertLedgerPresent({ dbPath, sessionsDir, allowEmpty: true }),
    ).not.toThrow();

    process.env[ALLOW_EMPTY_LEDGER_ENV] = '1';
    expect(() => assertLedgerPresent({ dbPath, sessionsDir })).not.toThrow();
  });

  it('does not count exFAT AppleDouble sidecars as history', () => {
    // `._*` files are binary metadata this volume sprays everywhere. Counting
    // one as a session would refuse a genuine first run on an empty directory.
    writeFileSync(join(sessionsDir, '._20260806T041217Z-000.jsonl'), 'binary');
    expect(sessionFileCount(sessionsDir)).toBe(0);
    expect(() => assertLedgerPresent({ dbPath, sessionsDir })).not.toThrow();
  });

  it('ignores a :memory: ledger, which has no file to be missing', () => {
    writeFileSync(join(sessionsDir, 'a.jsonl'), '{}\n');
    expect(() =>
      assertLedgerPresent({ dbPath: ':memory:', sessionsDir }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// A2 — snapshots
// ---------------------------------------------------------------------------

describe('snapshotLedger', () => {
  let ledger: Ledger;

  beforeEach(() => {
    ledger = openLedger({ path: dbPath, logger: { info: () => undefined, warn: () => undefined } });
  });

  afterEach(() => {
    ledger.close();
  });

  it('restores to a ledger holding the same open position', () => {
    ledger.recordFill(buyFill());
    const before = ledger.getOpenPositions();
    expect(before).toHaveLength(1);

    const path = snapshotLedger({ dbPath, directory: snapshotDir, reason: 'test' });
    expect(existsSync(path)).toBe(true);

    // Restore the way an operator would: copy it over a fresh path and open it.
    const restoredPath = join(dir, 'restored.db');
    copyFileSync(path, restoredPath);
    const restored = openLedger({
      path: restoredPath,
      logger: { info: () => undefined, warn: () => undefined },
    });
    try {
      const after = restored.getOpenPositions();
      expect(after).toHaveLength(1);
      expect(after[0]?.mint).toBe(before[0]?.mint);
      expect(after[0]?.tokens).toBe(before[0]?.tokens);
      expect(after[0]?.costLamports).toBe(before[0]?.costLamports);
      expect(after[0]?.openedAt).toBe(before[0]?.openedAt);
    } finally {
      restored.close();
    }
  });

  /**
   * The reason this is `VACUUM INTO` and not `cp`.
   *
   * The ledger runs in WAL with `synchronous = FULL`, so a committed fill can be
   * durable in `tracker.db-wal` while `tracker.db` itself has not been
   * checkpointed. Copying the main file alone yields a database that opens
   * perfectly and is quietly missing the newest rows — the worst shape a backup
   * can take, because nothing about it announces the loss.
   */
  it('captures rows still living in the WAL, which a file copy loses', () => {
    ledger.recordFill(buyFill());

    /** Fills readable from a database file, or `null` if it has no such table. */
    const fillsIn = (path: string): number | null => {
      const db = new Database(path, { readonly: true });
      try {
        const row = db.prepare('SELECT COUNT(*) AS n FROM fills').get() as {
          n: bigint | number;
        };
        return Number(row.n);
      } catch {
        return null;
      } finally {
        db.close();
      }
    };

    const naive = join(dir, 'naive-copy.db');
    copyFileSync(dbPath, naive);

    const path = snapshotLedger({ dbPath, directory: snapshotDir, reason: 'wal' });

    // The snapshot has the fill.
    expect(fillsIn(path)).toBe(1);

    // The naive copy does not — and it is worse than a missing row. Nothing has
    // been checkpointed yet, so `tracker.db` on its own carries no schema at
    // all: `fills` is not a table there. It opens without complaint either way,
    // which is exactly what makes a file copy the dangerous choice.
    expect(fillsIn(naive)).not.toBe(1);
  });

  it('leaves no .partial behind, so a torn file is never mistaken for a good one', () => {
    snapshotLedger({ dbPath, directory: snapshotDir, reason: 'test' });
    expect(readdirSync(snapshotDir).filter((n) => n.endsWith('.partial'))).toHaveLength(0);
  });

  it('names snapshots so a lexical sort is a chronological one', () => {
    const early = snapshotName(AT, 'start');
    const late = snapshotName(AT + 86_400_000, 'stop');
    expect([late, early].sort()).toEqual([early, late]);
  });

  it('prunes to the newest N', () => {
    for (let i = 0; i < 5; i += 1) {
      snapshotLedger({
        dbPath,
        directory: snapshotDir,
        reason: 'test',
        now: () => AT + i * 60_000,
      });
    }
    expect(listSnapshots(snapshotDir)).toHaveLength(5);

    const deleted = pruneSnapshots(snapshotDir, 2);
    expect(deleted).toHaveLength(3);

    const kept = listSnapshots(snapshotDir);
    expect(kept).toHaveLength(2);
    // Newest first, and the two newest are the ones kept.
    expect(kept[0]).toBe(snapshotName(AT + 4 * 60_000, 'test'));
    expect(kept[1]).toBe(snapshotName(AT + 3 * 60_000, 'test'));
  });
});

describe('LedgerSnapshotter', () => {
  let ledger: Ledger;

  beforeEach(() => {
    ledger = openLedger({ path: dbPath, logger: { info: () => undefined, warn: () => undefined } });
  });

  afterEach(() => {
    ledger.close();
  });

  it('snapshots on start, on interval, and on stop, staying bounded', () => {
    let clock = AT;
    const snapshotter = new LedgerSnapshotter({
      dbPath,
      directory: snapshotDir,
      keep: 3,
      intervalMs: 60_000,
      now: () => (clock += 1_000),
    });

    snapshotter.start();
    expect(snapshotter.stats.taken).toBe(1);

    for (let i = 0; i < 4; i += 1) snapshotter.snapshot('interval');
    snapshotter.stop();

    expect(snapshotter.stats.taken).toBe(6);
    expect(snapshotter.stats.failed).toBe(0);
    // Bounded regardless of how many were taken.
    expect(listSnapshots(snapshotDir)).toHaveLength(3);
    expect(listSnapshots(snapshotDir)[0]).toMatch(/-stop\.db$/);
  });

  /**
   * A backup that can stop the bot from starting has inverted its own purpose.
   */
  it('counts a failure instead of throwing it at the caller', () => {
    const snapshotter = new LedgerSnapshotter({
      dbPath: join(dir, 'does-not-exist', 'nothing.db'),
      directory: snapshotDir,
      keep: 3,
    });

    expect(() => snapshotter.start()).not.toThrow();
    expect(() => snapshotter.stop()).not.toThrow();
    expect(snapshotter.stats.taken).toBe(0);
    expect(snapshotter.stats.failed).toBe(2);
    expect(snapshotter.lastError).toBeDefined();
  });

  it('is safe to start and stop twice', () => {
    const snapshotter = new LedgerSnapshotter({ dbPath, directory: snapshotDir, keep: 5 });
    snapshotter.start();
    snapshotter.start();
    expect(snapshotter.stats.taken).toBe(1);
    snapshotter.stop();
    snapshotter.stop();
    expect(snapshotter.stats.failed).toBe(0);
  });
});
