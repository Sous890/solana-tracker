import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLedger } from '../src/db/ledger.js';

const MINT = 'So11111111111111111111111111111111111111112';
const AT = 1_700_000_000_000;

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');
const CLI = resolve(PROJECT_ROOT, 'src/cli/orphans.ts');

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

describe('npm run orphans', () => {
  let dir: string;
  let dbPath: string;

  function run(...args: string[]): Run {
    const result = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
      encoding: 'utf8',
      cwd: PROJECT_ROOT,
      // Never inherit stdin: a prompt would hang the suite instead of failing.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  /** Seed the database with `count` unacknowledged orphans. */
  function seedOrphans(count: number): void {
    const ledger = openLedger({
      path: dbPath,
      logger: { info: () => undefined, warn: () => undefined },
    });
    try {
      for (let index = 0; index < count; index += 1) {
        ledger.recordIntent(
          {
            id: `orphan-${index}`,
            side: 'buy',
            mint: MINT,
            amountLamports: 50_000_000n,
            maxSlippageBps: 300,
            reason: 'new pool signal',
          },
          AT,
        );
      }
      ledger.reconcileOnStartup(AT + 1_000);
    } finally {
      ledger.close();
    }
  }

  function orphanCount(): number {
    const ledger = openLedger({
      path: dbPath,
      logger: { info: () => undefined, warn: () => undefined },
    });
    try {
      return ledger.getUnacknowledgedOrphanCount();
    } finally {
      ledger.close();
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'solana-tracker-cli-'));
    dbPath = join(dir, 'tracker.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('list', () => {
    it('lists unacknowledged orphans with age, mint and intended size', () => {
      seedOrphans(2);
      const result = run('list', '--db', dbPath);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('2 unacknowledged crash orphan(s)');
      expect(result.stdout).toContain('NEW ENTRIES ARE BLOCKED');
      expect(result.stdout).toContain('orphan-0');
      expect(result.stdout).toContain(MINT);
      expect(result.stdout).toContain('0.05 SOL');
      expect(result.stdout).toContain('AGE');
    });

    it('defaults to listing when no command is given', () => {
      seedOrphans(1);
      expect(run('--db', dbPath).stdout).toContain('orphan-0');
    });

    it('says so plainly when nothing is outstanding', () => {
      seedOrphans(0);
      const result = run('list', '--db', dbPath);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Entries are not gated');
    });

    it('refuses a missing database instead of creating an empty one', () => {
      const missing = join(dir, 'absent.db');
      const result = run('list', '--db', missing);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('No ledger at');
      // An empty ledger would report "no orphans" and read as a clean bill of health.
      expect(existsSync(missing)).toBe(false);
    });
  });

  describe('ack', () => {
    it('acknowledges no-tx-on-chain and lifts the gate', () => {
      seedOrphans(1);
      const result = run(
        'ack', 'orphan-0', '--db', dbPath, '--operator', 'turner',
        '--resolution', 'no-tx-on-chain',
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('No orphans remain');
      expect(orphanCount()).toBe(0);
    });

    it('records the fill and reports the position for tx-confirmed', () => {
      seedOrphans(1);
      const result = run(
        'ack', 'orphan-0', '--db', dbPath, '--operator', 'turner',
        '--resolution', 'tx-confirmed',
        '--signature', '5xConfirmedSig',
        '--tokens-delta', '1000000000',
        '--decimals', '6',
        '--lamports-delta', '-50000000',
        '--fees-lamports', '1000000',
        '--at', String(AT + 2_000),
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Fill recorded');
      expect(result.stdout).toContain('1000 tokens');
      expect(result.stdout).toContain('open');
      expect(orphanCount()).toBe(0);

      const ledger = openLedger({
        path: dbPath,
        logger: { info: () => undefined, warn: () => undefined },
      });
      try {
        expect(ledger.getPosition(MINT)?.tokens).toBe(1_000_000_000n);
        expect(ledger.getAcknowledgement('orphan-0')?.acknowledgedBy).toBe('turner');
      } finally {
        ledger.close();
      }
    });

    it('keeps the remaining orphans gated after one sign-off', () => {
      seedOrphans(3);
      const result = run(
        'ack', 'orphan-0', '--db', dbPath, '--operator', 'turner',
        '--resolution', 'manually-closed',
      );

      expect(result.stdout).toContain('2 orphan(s) still unacknowledged');
      expect(orphanCount()).toBe(2);
    });

    it('requires an operator name', () => {
      seedOrphans(1);
      const result = run('ack', 'orphan-0', '--db', dbPath, '--resolution', 'no-tx-on-chain');

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--operator');
      expect(orphanCount()).toBe(1);
    });

    it('requires a known resolution', () => {
      seedOrphans(1);
      const result = run(
        'ack', 'orphan-0', '--db', dbPath, '--operator', 'turner', '--resolution', 'looks-fine',
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--resolution must be one of');
      expect(orphanCount()).toBe(1);
    });

    it('rejects an unknown id before asking for anything', () => {
      seedOrphans(1);
      const result = run(
        'ack', 'nope', '--db', dbPath, '--operator', 'turner', '--resolution', 'tx-confirmed',
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('not an unacknowledged orphan');
      expect(orphanCount()).toBe(1);
    });

    it('rejects fill data inconsistent with the intent, leaving the gate shut', () => {
      seedOrphans(1);
      const result = run(
        'ack', 'orphan-0', '--db', dbPath, '--operator', 'turner',
        '--resolution', 'tx-confirmed',
        '--signature', 'sig',
        // Negative for a buy: mistyped.
        '--tokens-delta', '-1000000000',
        '--decimals', '6',
        '--lamports-delta', '-50000000',
        '--fees-lamports', '1000000',
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('wrong sign');
      expect(orphanCount()).toBe(1);
    });

    it('has no clear-all', () => {
      seedOrphans(3);
      // Every plausible spelling of "just make it go away".
      expect(run('ack', '--all', '--db', dbPath, '--operator', 'turner').status).toBe(1);
      expect(run('ack-all', '--db', dbPath, '--operator', 'turner').status).toBe(2);
      expect(run('clear', '--db', dbPath).status).toBe(2);
      expect(orphanCount()).toBe(3);
    });

    it('refuses to acknowledge the same orphan twice', () => {
      seedOrphans(2);
      const first = run(
        'ack', 'orphan-0', '--db', dbPath, '--operator', 'turner',
        '--resolution', 'no-tx-on-chain',
      );
      expect(first.status).toBe(0);

      const second = run(
        'ack', 'orphan-0', '--db', dbPath, '--operator', 'someone-else',
        '--resolution', 'manually-closed',
      );
      expect(second.status).toBe(1);
      expect(orphanCount()).toBe(1);
    });
  });
});
