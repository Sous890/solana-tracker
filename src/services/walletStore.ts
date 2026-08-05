/**
 * The tracked-wallet registry.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM `config.json` ─────────────────────────
 *
 * `core/config.ts` is `.strict()`, so `trackedWallets` can hold addresses and
 * nothing else — no label, no note, no "off for now". A screener needs those:
 * a bare base58 string is unreadable, and the operation you actually want when
 * a wallet goes cold is to mute it, not to lose the fact that you were ever
 * watching it.
 *
 * So the registry is split, and the split is deliberate rather than incidental:
 *
 *  - `config.json.trackedWallets` stays the **authority on what is watched**.
 *    It is what `createTrackerRuntime` reads, what a bare `npm run serve` sees
 *    with no sidecar present, and what an operator would grep. It holds exactly
 *    the enabled addresses.
 *  - `data/wallets.json` is a **sidecar of annotations** — labels, notes, when
 *    an address was added, and the disabled ones. Deleting it loses your notes
 *    and nothing else; the bot still watches the same wallets.
 *
 * On open the two are reconciled by union, so hand-editing either one is safe.
 *
 * ── WHY EDITS TAKE EFFECT AT `start()`, NOT IMMEDIATELY ───────────────────
 *
 * `WalletStream` reads `deps.wallets` at subscribe time and at every gap fill,
 * and it is handed the array this store owns — the same reference, mutated in
 * place. That means a save is picked up by the next `tracker.start()` without
 * a process restart, and is *not* picked up mid-run.
 *
 * Mid-run application would need `logsUnsubscribe`, whose subscription ids this
 * codebase does not track, and a gap-fill for the newcomer racing an in-flight
 * drain. Neither is worth inventing for a screener. The tracker already boots
 * idle and treats "start the process" and "start the bot" as two decisions;
 * "edit the watchlist, then start" fits that grain exactly, and the API reports
 * `pendingRestart` so the gap is never silent.
 *
 * ── WRITES ────────────────────────────────────────────────────────────────
 *
 * Every mutation validates the *resulting* `config.json` through `parseConfig`
 * before anything touches the disk, so this module cannot write a config the
 * next boot would refuse to load. Both files are written tmp-then-rename, so a
 * crash mid-save leaves the previous version intact rather than a half file.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseConfig } from '../core/config.js';
import type { Address, UnixMillis } from '../core/types.js';

/**
 * Base58, no `0OIl`. Solana public keys land in 32-44 characters.
 *
 * Deliberately duplicated from `core/config.ts` rather than imported: that file
 * does not export it, and it is frozen. The two must agree — a wallet this
 * store accepts but `parseConfig` rejects would be written and then bounce on
 * the next boot. The `walletStore` tests assert agreement by round-tripping
 * every accepted address through `parseConfig`.
 */
export const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Bound on free text, so a label cannot turn config.json into a document. */
export const MAX_LABEL_LENGTH = 64;
export const MAX_NOTE_LENGTH = 280;

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface TrackedWallet {
  address: Address;
  /** Operator-facing name. Empty string when never set — never null. */
  label: string;
  note: string;
  /** Disabled wallets stay in the sidecar and leave `config.json`. */
  enabled: boolean;
  addedAt: UnixMillis;
}

export interface WalletStoreOptions {
  /** Path to `config.json`. The authority on which wallets are watched. */
  configPath: string;
  /** Path to the annotation sidecar, e.g. `./data/wallets.json`. */
  walletsPath: string;
  now?: () => UnixMillis;
}

/** Thrown for every rejected mutation. `code` is what the API maps to a status. */
export class WalletStoreError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_ADDRESS' | 'DUPLICATE' | 'NOT_FOUND' | 'INVALID_FIELD' | 'WRITE_FAILED',
  ) {
    super(message);
    this.name = 'WalletStoreError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Write via a sibling temp file and rename.
 *
 * `rename` within a directory is atomic, so a reader — or a crash — sees either
 * the old file or the new one. Writing in place would expose a truncated
 * `config.json`, which is the one file the next boot cannot do without.
 */
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

function trimmed(value: unknown, max: number, field: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new WalletStoreError(`${field} must be a string`, 'INVALID_FIELD');
  }
  const text = value.trim();
  if (text.length > max) {
    throw new WalletStoreError(`${field} must be at most ${max} characters`, 'INVALID_FIELD');
  }
  return text;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  return b.every((item) => left.has(item));
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class WalletStore {
  private readonly options: Required<WalletStoreOptions>;
  private wallets: TrackedWallet[] = [];

  /**
   * The array handed to `WalletStream`, mutated in place.
   *
   * Exposed as `readonly Address[]` so callers cannot reorder it behind the
   * store's back, but it is the *same object* the stream holds — that identity
   * is the whole mechanism by which a save reaches the next `start()`.
   */
  readonly liveAddresses: Address[] = [];

  /** What `liveAddresses` held the last time a run actually subscribed. */
  private applied: Address[] = [];

  constructor(options: WalletStoreOptions) {
    this.options = { now: () => Date.now(), ...options };
    this.load();
  }

  // -- reads ---------------------------------------------------------------

  /** Every wallet, enabled and not, newest first. */
  list(): TrackedWallet[] {
    return [...this.wallets].sort((a, b) => b.addedAt - a.addedAt);
  }

  enabledAddresses(): Address[] {
    return this.wallets.filter((wallet) => wallet.enabled).map((wallet) => wallet.address);
  }

  /**
   * True when the saved watchlist differs from what the running stream is
   * actually subscribed to. Always false while idle: nothing is subscribed, so
   * nothing is stale.
   */
  pendingRestart(running: boolean): boolean {
    return running && !sameSet(this.enabledAddresses(), this.applied);
  }

  /** Snapshot the subscribed set. Called once a run has genuinely subscribed. */
  markApplied(): void {
    this.applied = [...this.liveAddresses];
  }

  /** What the running stream is subscribed to, for display. */
  appliedAddresses(): Address[] {
    return [...this.applied];
  }

  // -- mutations -----------------------------------------------------------

  add(input: Record<string, unknown>): TrackedWallet {
    const address = typeof input['address'] === 'string' ? input['address'].trim() : '';
    if (!BASE58_ADDRESS.test(address)) {
      throw new WalletStoreError(
        'must be a base58 Solana address (32-44 chars, no 0/O/I/l)',
        'INVALID_ADDRESS',
      );
    }
    if (this.wallets.some((wallet) => wallet.address === address)) {
      throw new WalletStoreError(`${address} is already tracked`, 'DUPLICATE');
    }

    const wallet: TrackedWallet = {
      address,
      label: trimmed(input['label'], MAX_LABEL_LENGTH, 'label'),
      note: trimmed(input['note'], MAX_NOTE_LENGTH, 'note'),
      enabled: input['enabled'] === undefined ? true : input['enabled'] === true,
      addedAt: this.options.now(),
    };

    this.wallets.push(wallet);
    this.commit();
    return wallet;
  }

  update(address: string, patch: Record<string, unknown>): TrackedWallet {
    const wallet = this.wallets.find((candidate) => candidate.address === address);
    if (wallet === undefined) throw new WalletStoreError(`${address} is not tracked`, 'NOT_FOUND');

    if (patch['label'] !== undefined) {
      wallet.label = trimmed(patch['label'], MAX_LABEL_LENGTH, 'label');
    }
    if (patch['note'] !== undefined) wallet.note = trimmed(patch['note'], MAX_NOTE_LENGTH, 'note');
    if (patch['enabled'] !== undefined) {
      if (typeof patch['enabled'] !== 'boolean') {
        throw new WalletStoreError('enabled must be a boolean', 'INVALID_FIELD');
      }
      wallet.enabled = patch['enabled'];
    }

    this.commit();
    return wallet;
  }

  remove(address: string): TrackedWallet {
    const index = this.wallets.findIndex((candidate) => candidate.address === address);
    if (index === -1) throw new WalletStoreError(`${address} is not tracked`, 'NOT_FOUND');
    const [removed] = this.wallets.splice(index, 1) as [TrackedWallet];
    this.commit();
    return removed;
  }

  // -- persistence ---------------------------------------------------------

  /**
   * Union the two files.
   *
   * An address in `config.json` and not the sidecar is adopted enabled with an
   * empty label — that is a hand edit, and the operator meant it. An enabled
   * sidecar entry missing from `config.json` is re-asserted on the next commit.
   * Neither direction ever silently drops a wallet.
   */
  private load(): void {
    const config = readJson(this.options.configPath) as { trackedWallets?: unknown } | undefined;
    const fromConfig = Array.isArray(config?.trackedWallets)
      ? (config.trackedWallets as unknown[]).filter(
          (value): value is string => typeof value === 'string' && BASE58_ADDRESS.test(value),
        )
      : [];

    const sidecar = readJson(this.options.walletsPath) as { wallets?: unknown } | undefined;
    const fromSidecar = Array.isArray(sidecar?.wallets) ? (sidecar.wallets as unknown[]) : [];

    const byAddress = new Map<string, TrackedWallet>();
    for (const raw of fromSidecar) {
      const entry = raw as Partial<TrackedWallet>;
      if (typeof entry?.address !== 'string' || !BASE58_ADDRESS.test(entry.address)) continue;
      byAddress.set(entry.address, {
        address: entry.address,
        label: typeof entry.label === 'string' ? entry.label.slice(0, MAX_LABEL_LENGTH) : '',
        note: typeof entry.note === 'string' ? entry.note.slice(0, MAX_NOTE_LENGTH) : '',
        enabled: entry.enabled !== false,
        addedAt: typeof entry.addedAt === 'number' ? entry.addedAt : this.options.now(),
      });
    }

    for (const address of fromConfig) {
      const existing = byAddress.get(address);
      if (existing === undefined) {
        byAddress.set(address, {
          address,
          label: '',
          note: '',
          enabled: true,
          addedAt: this.options.now(),
        });
      } else {
        // Present in config.json means watched, whatever the sidecar remembers.
        existing.enabled = true;
      }
    }

    this.wallets = [...byAddress.values()];
    this.syncLiveAddresses();
  }

  /** Rewrite `liveAddresses` in place — never reassign; the stream holds it. */
  private syncLiveAddresses(): void {
    this.liveAddresses.length = 0;
    this.liveAddresses.push(...this.enabledAddresses());
  }

  /**
   * Persist both files, config first.
   *
   * The candidate config goes through `parseConfig` before any write, so an
   * address that would fail validation is rejected here rather than at the next
   * boot. On any write failure the in-memory state is rolled back by reloading
   * from disk, so a caller that catches the error is not left holding a store
   * that disagrees with the files.
   */
  private commit(): void {
    const enabled = this.enabledAddresses();

    const raw = (readJson(this.options.configPath) ?? {}) as Record<string, unknown>;
    const candidate = { ...raw, trackedWallets: enabled };
    try {
      parseConfig(candidate);
    } catch (cause) {
      this.load();
      throw new WalletStoreError(
        `refusing to write a config the next boot would reject: ${(cause as Error).message}`,
        'WRITE_FAILED',
      );
    }

    try {
      writeJsonAtomic(this.options.configPath, candidate);
      writeJsonAtomic(this.options.walletsPath, { wallets: this.list() });
    } catch (cause) {
      this.load();
      throw new WalletStoreError(`could not save: ${(cause as Error).message}`, 'WRITE_FAILED');
    }

    this.syncLiveAddresses();
  }
}

export function openWalletStore(options: WalletStoreOptions): WalletStore {
  return new WalletStore(options);
}
