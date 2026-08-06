/**
 * Keeping the ledger, and noticing when it is gone.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * Session 22 deleted `data/` with `rm -rf` — the ledger, the cursors, the
 * runtime state and the watchlist labels. Session 23 established what could be
 * recovered from the surviving session files and the answer is: the two open
 * positions, exactly, and essentially nothing else. Intents leave no trace in a
 * session at all, because guard gate 3 runs before the broker's first quote, so
 * a rejected intent produces no quote, no screen and no tick — only the
 * originating swap, which is indistinguishable from one the strategy declined.
 *
 * The loss was silent. The next run started clean on a destroyed ledger and the
 * only visible symptom was thirteen truncated cold fills. Two separate things
 * were missing and this module supplies both:
 *
 *   1. a copy of the ledger somewhere `rm -rf` in the repo cannot reach, and
 *   2. a refusal to start when the ledger is absent but the history is not.
 *
 * ── WHY NOT IN `db/ledger.ts` ─────────────────────────────────────────────
 *
 * The session brief asked for the refusal inside `reconcileOnStartup()`, which
 * lives in `db/ledger.ts` — a file CLAUDE.md puts off-limits without a signed
 * sign-off, and this session's brief carries none. The check is implemented here
 * instead, at the composition root, and runs BEFORE `openLedger` rather than
 * inside it.
 *
 * That is not only the compliant place, it is the better one. `openLedger`
 * CREATES the file it is given, so by the time `reconcileOnStartup` runs the
 * evidence of absence is already gone — it would be reporting on a database it
 * had just made. And a ledger module has no business stat-ing a session
 * directory it is never told about. The behaviour the brief asked for is
 * unchanged: the process refuses to start.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Snapshots default OFF the repo volume entirely.
 *
 * The repo lives on an external drive; the point of a snapshot is to survive
 * both a bad `rm` inside the tree and the tree's disk. `~` is neither.
 */
export const DEFAULT_SNAPSHOT_DIR = join(homedir(), '.solana-tracker', 'snapshots');
/** Bounded, oldest pruned first. 24 covers a day of quarter-hourly snapshots. */
export const DEFAULT_SNAPSHOT_KEEP = 24;
export const DEFAULT_SNAPSHOT_INTERVAL_MS = 15 * 60_000;

/** Set to `1` / `true` to start with an empty ledger beside a non-empty `sessions/`. */
export const ALLOW_EMPTY_LEDGER_ENV = 'ALLOW_EMPTY_LEDGER';

export class LedgerLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerLostError';
  }
}

/** Session files, ignoring exFAT's `._*` AppleDouble sidecars. */
export function sessionFileCount(directory: string): number {
  try {
    return readdirSync(directory).filter(
      (name) => name.endsWith('.jsonl') && !name.startsWith('._'),
    ).length;
  } catch {
    // No directory is the genuine first run, not a missing history.
    return 0;
  }
}

export interface LedgerPresenceOptions {
  dbPath: string;
  sessionsDir: string;
  snapshotDir?: string;
  /** Override for the genuine first run. Defaults to the env var. */
  allowEmpty?: boolean;
}

/**
 * Refuse to start with an empty ledger when `sessions/` says there is history.
 *
 * The pairing is what makes this a signal rather than a nuisance. A missing
 * database on its own is a first run. A missing database beside recorded
 * sessions means something removed it, and the failure mode is silent: the bot
 * comes up with no positions, no cursors and no kill-switch state, cold-fills
 * every wallet, and looks like a quiet morning.
 */
export function assertLedgerPresent(options: LedgerPresenceOptions): void {
  const { dbPath, sessionsDir } = options;
  if (dbPath === ':memory:') return;
  if (existsSync(dbPath)) return;

  const sessions = sessionFileCount(sessionsDir);
  if (sessions === 0) return;

  const allowEmpty =
    options.allowEmpty ?? ['1', 'true', 'yes'].includes(
      (process.env[ALLOW_EMPTY_LEDGER_ENV] ?? '').toLowerCase(),
    );
  if (allowEmpty) return;

  const snapshotDir = options.snapshotDir ?? DEFAULT_SNAPSHOT_DIR;
  throw new LedgerLostError(
    `The ledger at ${dbPath} does not exist, but ${sessionsDir} holds ${sessions} recorded ` +
      'session file(s). That pairing means the database was removed rather than never created.\n' +
      '\n' +
      'Starting now would begin with an empty book: no positions, no cursors, no persisted\n' +
      'kill switch, and a cold fill on every tracked wallet. Session 22 did exactly that and\n' +
      'the only visible symptom was thirteen truncated cold fills.\n' +
      '\n' +
      `  Restore a snapshot:  ls -t ${snapshotDir}\n` +
      `                       cp <newest>.db ${dbPath}\n` +
      `  Genuine first run:   ${ALLOW_EMPTY_LEDGER_ENV}=1 npm run serve\n` +
      '\n' +
      'Note that restoring recovers the books. It does not recover the intents — a rejected\n' +
      'intent leaves no trace in a session file, so it cannot be rebuilt from one.',
  );
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/** `tracker-20260806T051636Z-stop.db` — sorts chronologically as a string. */
export function snapshotName(at: number, reason: string): string {
  const stamp = new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `tracker-${stamp}-${reason}.db`;
}

export interface SnapshotOptions {
  dbPath: string;
  directory: string;
  reason: string;
  now?: () => number;
}

/**
 * Copy the ledger to `directory`, consistently, while it is open and in WAL.
 *
 * `VACUUM INTO` rather than a file copy. A WAL database is two or three files,
 * and copying `tracker.db` alone gets whatever was last checkpointed — which is
 * a torn snapshot that opens cleanly and is quietly missing the newest fills.
 * `VACUUM INTO` reads through SQLite, so it sees the WAL, and it writes a single
 * compacted file with no `-wal` or `-shm` alongside it.
 *
 * Written to a temporary name and renamed. A snapshot interrupted halfway must
 * never be left sitting in the directory looking like a good one, because the
 * moment anybody needs it is the moment nobody is inclined to check.
 */
export function snapshotLedger(options: SnapshotOptions): string {
  const now = options.now ?? Date.now;
  mkdirSync(options.directory, { recursive: true });

  const final = join(options.directory, snapshotName(now(), options.reason));
  const partial = `${final}.partial`;
  rmSync(partial, { force: true });

  // Read-only, and a connection of its own: three modules already share this
  // file, and a snapshot must not be able to write to any of them.
  const db = new Database(options.dbPath, { readonly: true });
  try {
    db.prepare('VACUUM INTO ?').run(partial);
  } finally {
    db.close();
  }
  renameSync(partial, final);
  return final;
}

/** Newest first. Only completed snapshots — a `.partial` is not a snapshot. */
export function listSnapshots(directory: string): string[] {
  try {
    return readdirSync(directory)
      .filter((name) => name.startsWith('tracker-') && name.endsWith('.db'))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Keep the newest `keep`, delete the rest. Returns what was deleted. */
export function pruneSnapshots(directory: string, keep: number): string[] {
  const all = listSnapshots(directory);
  const doomed = all.slice(Math.max(0, keep));
  for (const name of doomed) rmSync(join(directory, name), { force: true });
  return doomed;
}

export interface SnapshotterOptions {
  dbPath: string;
  directory?: string;
  keep?: number;
  intervalMs?: number;
  logger?: { info(fields: Record<string, unknown>, message: string): void;
             warn(fields: Record<string, unknown>, message: string): void };
  now?: () => number;
}

/**
 * Snapshots on start, on stop, and on an interval in between.
 *
 * **Never throws onto the caller's path.** A snapshot is a backup, and a backup
 * that can stop the bot from starting — or from shutting down cleanly — has
 * inverted its own purpose. Failures are counted and logged, and `lastError`
 * makes them assertable rather than merely visible.
 */
export class LedgerSnapshotter {
  private readonly options: Required<Omit<SnapshotterOptions, 'logger' | 'now'>> &
    SnapshotterOptions;
  private timer: NodeJS.Timeout | undefined;

  readonly stats = { taken: 0, failed: 0, pruned: 0 };
  lastPath: string | undefined;
  lastError: Error | undefined;

  constructor(options: SnapshotterOptions) {
    this.options = {
      directory: options.directory ?? process.env['LEDGER_SNAPSHOT_DIR'] ?? DEFAULT_SNAPSHOT_DIR,
      keep: options.keep ?? DEFAULT_SNAPSHOT_KEEP,
      intervalMs: options.intervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS,
      ...options,
    };
  }

  get directory(): string {
    return this.options.directory;
  }

  /** Take one now. Returns the path, or undefined if it failed. */
  snapshot(reason: string): string | undefined {
    try {
      const path = snapshotLedger({
        dbPath: this.options.dbPath,
        directory: this.options.directory,
        reason,
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
      });
      this.stats.taken += 1;
      this.lastPath = path;
      this.stats.pruned += pruneSnapshots(this.options.directory, this.options.keep).length;
      this.options.logger?.info({ path, reason }, 'ledger snapshot written');
      return path;
    } catch (cause) {
      this.stats.failed += 1;
      this.lastError = cause as Error;
      this.options.logger?.warn(
        { error: (cause as Error).message, reason },
        'ledger snapshot failed — the bot is unaffected, but the ledger is unprotected',
      );
      return undefined;
    }
  }

  /** Snapshot immediately, then every `intervalMs`. Safe to call twice. */
  start(): void {
    if (this.timer !== undefined) return;
    this.snapshot('start');
    this.timer = setInterval(() => this.snapshot('interval'), this.options.intervalMs);
    // The interval must not be what keeps the process alive at shutdown.
    this.timer.unref?.();
  }

  /** Final snapshot, then stop the timer. Safe to call twice. */
  stop(reason = 'stop'): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.snapshot(reason);
  }
}
