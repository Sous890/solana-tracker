import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/core/config.js';
import { WalletStore, WalletStoreError, openWalletStore } from '../src/services/walletStore.js';

const A = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const B = 'So11111111111111111111111111111111111111112';
const C = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const NOW = 1_700_000_000_000;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  store: WalletStore;
  configPath: string;
  walletsPath: string;
  readConfig(): Record<string, unknown>;
}

function harness(config: Record<string, unknown> = {}, sidecar?: unknown): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'wallet-store-'));
  dirs.push(dir);
  const configPath = join(dir, 'config.json');
  const walletsPath = join(dir, 'data', 'wallets.json');

  writeFileSync(configPath, JSON.stringify({ mode: 'paper', ...config }, null, 2));
  if (sidecar !== undefined) {
    // Written by hand rather than through the store, so reconciliation is
    // exercised against a file this test authored and not one the store made.
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(walletsPath, JSON.stringify(sidecar, null, 2));
  }

  const store = openWalletStore({ configPath, walletsPath, now: () => NOW });
  return {
    store,
    configPath,
    walletsPath,
    readConfig: () => JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>,
  };
}

describe('WalletStore', () => {
  describe('validation', () => {
    it('rejects a non-base58 address', () => {
      const { store } = harness();
      expect(() => store.add({ address: 'not-an-address' })).toThrow(WalletStoreError);
      expect(() => store.add({ address: '0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl' })).toThrow(
        /base58/,
      );
      expect(store.list()).toHaveLength(0);
    });

    it('rejects a duplicate', () => {
      const { store } = harness();
      store.add({ address: A });
      expect(() => store.add({ address: A })).toThrow(/already tracked/);
      expect(store.list()).toHaveLength(1);
    });

    it('bounds label and note length', () => {
      const { store } = harness();
      expect(() => store.add({ address: A, label: 'x'.repeat(65) })).toThrow(/at most 64/);
      expect(() => store.add({ address: A, note: 'x'.repeat(281) })).toThrow(/at most 280/);
    });

    /**
     * The regex here is a copy of the one in the frozen `core/config.ts`. If the
     * two ever drift, this store writes an address the next boot refuses — so
     * every address it accepts is round-tripped through the real validator.
     */
    it('accepts only addresses that parseConfig also accepts', () => {
      const { store, readConfig } = harness();
      for (const address of [A, B, C]) store.add({ address });
      expect(() => parseConfig(readConfig())).not.toThrow();
      expect(parseConfig(readConfig()).trackedWallets).toEqual([A, B, C]);
    });
  });

  describe('persistence', () => {
    it('writes enabled addresses to config.json and annotations to the sidecar', () => {
      const { store, readConfig, walletsPath } = harness();
      store.add({ address: A, label: 'whale', note: 'found in a mint sweep' });

      expect(readConfig()['trackedWallets']).toEqual([A]);
      // The label must not reach config.json — the schema is `.strict()`.
      expect(JSON.stringify(readConfig())).not.toContain('whale');

      const sidecar = JSON.parse(readFileSync(walletsPath, 'utf8')) as {
        wallets: Array<Record<string, unknown>>;
      };
      expect(sidecar.wallets[0]).toMatchObject({ address: A, label: 'whale', enabled: true });
    });

    it('preserves unrelated config fields', () => {
      const { store, readConfig } = harness({ positionSizeSol: 0.25, strategy: 'equation' });
      store.add({ address: A });
      expect(readConfig()['positionSizeSol']).toBe(0.25);
      expect(readConfig()['strategy']).toBe('equation');
    });

    it('drops a muted wallet from config.json but keeps it in the sidecar', () => {
      const { store, readConfig, walletsPath } = harness();
      store.add({ address: A, label: 'cold lately' });
      store.update(A, { enabled: false });

      expect(readConfig()['trackedWallets']).toEqual([]);
      const sidecar = JSON.parse(readFileSync(walletsPath, 'utf8')) as {
        wallets: Array<Record<string, unknown>>;
      };
      expect(sidecar.wallets).toHaveLength(1);
      expect(sidecar.wallets[0]).toMatchObject({ enabled: false, label: 'cold lately' });
    });

    it('refuses to write a config the next boot would reject, and rolls back', () => {
      // `reservedGasSol` under the floor makes any write of this file invalid,
      // whatever the watchlist says.
      const { store, readConfig } = harness({ reservedGasSol: 0.001 });
      expect(() => store.add({ address: A })).toThrow(/next boot would reject/);
      expect(readConfig()['trackedWallets']).toBeUndefined();
      expect(store.list()).toHaveLength(0);
      expect(store.liveAddresses).toEqual([]);
    });

    it('survives a reopen', () => {
      const { store, configPath, walletsPath } = harness();
      store.add({ address: A, label: 'one' });
      store.add({ address: B, label: 'two' });
      store.update(B, { enabled: false });

      const reopened = openWalletStore({ configPath, walletsPath, now: () => NOW });
      expect(reopened.list().map((w) => [w.address, w.label, w.enabled])).toEqual(
        expect.arrayContaining([
          [A, 'one', true],
          [B, 'two', false],
        ]),
      );
      expect(reopened.liveAddresses).toEqual([A]);
    });
  });

  describe('reconciliation between the two files', () => {
    it('adopts an address hand-edited into config.json', () => {
      const { store } = harness({ trackedWallets: [A] });
      expect(store.list()).toHaveLength(1);
      expect(store.list()[0]).toMatchObject({ address: A, label: '', enabled: true });
      expect(store.liveAddresses).toEqual([A]);
    });

    it('config.json wins on enabled — presence there means watched', () => {
      const { store } = harness({ trackedWallets: [A] }, {
        wallets: [{ address: A, label: 'muted in the sidecar', enabled: false, addedAt: 1 }],
      });
      expect(store.list()[0]).toMatchObject({ label: 'muted in the sidecar', enabled: true });
    });

    it('re-asserts an enabled sidecar entry missing from config.json', () => {
      const { store, readConfig } = harness({ trackedWallets: [] }, {
        wallets: [{ address: A, label: 'kept', enabled: true, addedAt: 1 }],
      });
      expect(store.liveAddresses).toEqual([A]);
      // Not written until something commits — a read must not touch the disk.
      expect(readConfig()['trackedWallets']).toEqual([]);
      store.add({ address: B });
      expect(readConfig()['trackedWallets']).toEqual([A, B]);
    });

    it('ignores junk entries in either file', () => {
      const { store } = harness({ trackedWallets: [A, 'nope', 42] }, {
        wallets: [{ address: 'garbage' }, null, { label: 'no address' }],
      });
      expect(store.list().map((w) => w.address)).toEqual([A]);
    });
  });

  describe('liveAddresses identity', () => {
    /**
     * The contract `WalletStream` depends on: the array is mutated, never
     * replaced. Reassigning it would leave the stream subscribed from a
     * detached copy and every later edit would be silently ignored.
     */
    it('mutates the array in place across every operation', () => {
      const { store } = harness();
      const held = store.liveAddresses;

      store.add({ address: A });
      expect(held).toEqual([A]);
      expect(store.liveAddresses).toBe(held);

      store.add({ address: B });
      expect(held).toEqual([A, B]);

      store.update(A, { enabled: false });
      expect(held).toEqual([B]);

      store.remove(B);
      expect(held).toEqual([]);
      expect(store.liveAddresses).toBe(held);
    });
  });

  describe('pendingRestart', () => {
    it('is false while idle, whatever changed', () => {
      const { store } = harness();
      store.add({ address: A });
      expect(store.pendingRestart(false)).toBe(false);
    });

    it('is false immediately after a run subscribes', () => {
      const { store } = harness();
      store.add({ address: A });
      store.markApplied();
      expect(store.pendingRestart(true)).toBe(false);
      expect(store.appliedAddresses()).toEqual([A]);
    });

    it('turns true when the watchlist changes mid-run, and false again on the next start', () => {
      const { store } = harness();
      store.add({ address: A });
      store.markApplied();

      store.add({ address: B });
      expect(store.pendingRestart(true)).toBe(true);

      store.markApplied();
      expect(store.pendingRestart(true)).toBe(false);
    });

    it('notices a mute, not only an add', () => {
      const { store } = harness();
      store.add({ address: A });
      store.add({ address: B });
      store.markApplied();

      store.update(B, { enabled: false });
      expect(store.pendingRestart(true)).toBe(true);
    });

    it('ignores a label edit, which changes nothing the stream can see', () => {
      const { store } = harness();
      store.add({ address: A });
      store.markApplied();

      store.update(A, { label: 'renamed' });
      expect(store.pendingRestart(true)).toBe(false);
    });
  });

  describe('remove', () => {
    it('reports NOT_FOUND for an unknown address', () => {
      const { store } = harness();
      expect(() => store.remove(A)).toThrow(/not tracked/);
      try {
        store.remove(A);
      } catch (cause) {
        expect((cause as WalletStoreError).code).toBe('NOT_FOUND');
      }
    });
  });
});
