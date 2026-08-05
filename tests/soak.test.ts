import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { SimulatedFill, TrackedSwap } from '../src/core/types.js';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_RETENTION_DAYS,
  EXCLUDED_TRACKER_EVENTS,
  REDACTED,
  SessionRecorder,
  encodeSwap,
} from '../src/services/recorder.js';
import { RECORDING_DEFAULTS } from '../src/services/tracker.js';
import { SoakDigest, formatDigest } from '../src/services/soak.js';
import { parseSession } from './replay/session.js';
import { replaySession } from './replay/run.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
/** Must match `ANCHOR_MINT` in `tests/fixtures/soak-child.ts`. */
const ANCHOR_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const T0 = 1_700_000_000_000;

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'soak-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function swapOf(index = 0): TrackedSwap {
  return {
    wallet: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    mint: MINT,
    side: 'buy',
    solAmount: 410_000_000n,
    tokenAmount: 1_000_000_000n,
    decimals: 6,
    signature: `sig-${index}`,
    slot: index,
    blockTime: 1_700_000_000,
    venue: 'pumpfun',
    feePayer: true,
    source: 'live',
    observedAt: 1_700_000_000_000,
  };
}

// ---------------------------------------------------------------------------
// Where the settings live
// ---------------------------------------------------------------------------

describe('recording settings', () => {
  it('carry the specified defaults', () => {
    expect(RECORDING_DEFAULTS).toEqual({
      recordSessions: true,
      sessionDir: './sessions',
      sessionMaxBytes: 64 * 1024 * 1024,
      sessionRetentionDays: 30,
    });
    expect(DEFAULT_MAX_BYTES).toBe(RECORDING_DEFAULTS.sessionMaxBytes);
    expect(DEFAULT_RETENTION_DAYS).toBe(RECORDING_DEFAULTS.sessionRetentionDays);
  });

  it('CANNOT live in config.json — the schema is strict and frozen', async () => {
    // Stated as a test because the next person will look in config.json first.
    // `ConfigObject` is `.strict()`, so an unknown key is a hard failure rather
    // than something ignored, and `core/config.ts` is frozen.
    const { parseConfig, ConfigError } = await import('../src/core/config.js');
    expect(() => parseConfig({ recordSessions: true })).toThrow(ConfigError);
    expect(() => parseConfig({ sessionDir: './sessions' })).toThrow(ConfigError);
  });
});

// ---------------------------------------------------------------------------
// Rotation and retention
// ---------------------------------------------------------------------------

describe('rotation', () => {
  it('names files with the start timestamp and a rotation index', () => {
    const dir = tempDir();
    const recorder = new SessionRecorder({ directory: dir, now: () => T0, retentionDays: 0 });
    expect(recorder.path).toMatch(/\/20231114T221320Z-000\.jsonl$/);
    void recorder.close();
  });

  it('rotates on size', async () => {
    const dir = tempDir();
    const recorder = new SessionRecorder({
      directory: dir,
      now: () => T0,
      maxBytes: 400,
      retentionDays: 0,
    });
    for (let index = 0; index < 12; index += 1) recorder.write('swap', encodeSwap(swapOf(index)));
    await recorder.close();

    const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();
    expect(files.length).toBeGreaterThan(1);
    expect(files[0]).toMatch(/-000\.jsonl$/);
    expect(files[1]).toMatch(/-001\.jsonl$/);
    expect(recorder.stats.rotations).toBeGreaterThan(0);
  });

  it('rotates on a UTC date change even when the file is small', async () => {
    const dir = tempDir();
    let clock = Date.UTC(2026, 7, 4, 23, 59, 59);
    const recorder = new SessionRecorder({
      directory: dir,
      now: () => clock,
      retentionDays: 0,
    });
    recorder.write('swap', encodeSwap(swapOf(1)));
    clock = Date.UTC(2026, 7, 5, 0, 0, 1);
    recorder.write('swap', encodeSwap(swapOf(2)));
    await recorder.close();

    expect(readdirSync(dir).filter((n) => n.endsWith('.jsonl'))).toHaveLength(2);
    expect(recorder.stats.rotations).toBe(1);
  });

  it('does NOT reset seq across a rotation', async () => {
    // Monotonic across the whole run, so two files can be ordered against each
    // other and a gap between them is still detectable.
    const dir = tempDir();
    const recorder = new SessionRecorder({
      directory: dir,
      now: () => T0,
      maxBytes: 400,
      retentionDays: 0,
    });
    for (let index = 0; index < 12; index += 1) recorder.write('swap', encodeSwap(swapOf(index)));
    await recorder.close();

    const seqs = readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
      .flatMap((name) =>
        readFileSync(join(dir, name), 'utf8')
          .trim()
          .split('\n')
          .map((line) => (JSON.parse(line) as { seq: number }).seq),
      );
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
  });

  it('sweeps sessions past the retention window and keeps the rest', async () => {
    const dir = tempDir();
    const old = join(dir, 'old.jsonl');
    const fresh = join(dir, 'fresh.jsonl');
    writeFileSync(old, '{}\n');
    writeFileSync(fresh, '{}\n');
    const longAgo = Date.now() / 1000 - 40 * 86_400;
    utimesSync(old, longAgo, longAgo);

    const recorder = new SessionRecorder({
      directory: dir,
      now: () => Date.now(),
      retentionDays: 30,
    });
    await recorder.close();

    const remaining = readdirSync(dir);
    expect(remaining).not.toContain('old.jsonl');
    expect(remaining).toContain('fresh.jsonl');
  });
});

// ---------------------------------------------------------------------------
// The fifth kind
// ---------------------------------------------------------------------------

describe('unmodeled — the schema is falsifiable', () => {
  it('routes an unrecognised tracker event to unmodeled with its type as the tag', async () => {
    const dir = tempDir();
    const recorder = new SessionRecorder({ directory: dir, now: () => T0, retentionDays: 0 });
    const tracker = new EventEmitter();
    recorder.attach(tracker as never);

    tracker.emit('event', { type: 'brand-new-thing', data: { detail: 1 } });
    const path = recorder.path;
    await recorder.close();

    const line = JSON.parse(readFileSync(path, 'utf8').trim()) as {
      kind: string;
      payload: { tag: string; raw: unknown };
    };
    expect(line.kind).toBe('unmodeled');
    expect(line.payload).toEqual({ tag: 'tracker:brand-new-thing', raw: { detail: 1 } });
    expect(recorder.stats.unmodeled).toBe(1);
  });

  it('skips recognised outputs by NAME, not by omission', async () => {
    // The distinction is the whole reason `unmodeled` means anything: if the
    // recorder ignored what it did not recognise, a new event type would vanish
    // and the session would be quietly incomplete.
    const dir = tempDir();
    const recorder = new SessionRecorder({ directory: dir, now: () => T0, retentionDays: 0 });
    const tracker = new EventEmitter();
    recorder.attach(tracker as never);

    for (const type of EXCLUDED_TRACKER_EVENTS) tracker.emit('event', { type, data: {} });
    const path = recorder.path;
    await recorder.close();

    expect(readFileSync(path, 'utf8').trim()).toBe('');
    expect(recorder.stats.unmodeled).toBe(0);
  });

  it('the new stream events are NOT silently excluded', () => {
    // They are observations about the feed, not market inputs, so they land in
    // `unmodeled` until somebody decides otherwise — which is the intended
    // signal, not an oversight.
    for (const type of ['swap-unparsed', 'stream-disconnected', 'stream-reconnected']) {
      expect(EXCLUDED_TRACKER_EVENTS.has(type)).toBe(false);
    }
  });

  it('a session carrying unmodeled lines still parses and replays', () => {
    const line = (seq: number, kind: string, payload: unknown): string =>
      JSON.stringify({ seq, simClockMs: T0 + seq, kind, payload });
    const session = parseSession(
      `${line(1, 'unmodeled', { tag: 'tracker:mystery', raw: {} })}\n` +
        `${line(2, 'screen', { mint: MINT, sizeSol: 0.05, verdict: 'pass', failedChecks: [], unknownChecks: [] })}\n`,
      's',
    );
    expect(session.lines).toHaveLength(2);
    expect(session.drivable).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Secret hygiene
// ---------------------------------------------------------------------------

describe('secret hygiene', () => {
  const KEY = 'abcd1234-secret-api-key-9876';
  const URL = `https://rpc.example.com/?api-key=${KEY}`;

  it('redacts a secret wherever it appears in a line, not only in known fields', async () => {
    const dir = tempDir();
    const recorder = new SessionRecorder({
      directory: dir,
      now: () => T0,
      retentionDays: 0,
      secrets: [URL, KEY],
    });

    // Buried in an error message, which is exactly where nobody looks.
    recorder.writeUnmodeled('tracker:error', {
      message: `fetch failed for ${URL}`,
      stack: `at get (${URL}:1:1)`,
      nested: { deep: [{ key: KEY }] },
    });
    const path = recorder.path;
    await recorder.close();

    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('api-key=');
    expect(text).toContain(REDACTED);
    expect(recorder.stats.redactions).toBeGreaterThan(0);
  });

  it('redacts at the PRODUCER, so a new sink cannot leak by being forgotten', async () => {
    const dir = tempDir();
    const recorder = new SessionRecorder({
      directory: dir,
      now: () => T0,
      retentionDays: 0,
      secrets: [KEY],
    });
    // A payload shape that did not exist when the redactor was written.
    recorder.write('unmodeled', { tag: 'x', raw: { somethingNobodyPlannedFor: KEY } });
    const path = recorder.path;
    await recorder.close();
    expect(readFileSync(path, 'utf8')).not.toContain(KEY);
  });

  it('ignores short "secrets", which would redact half the file', () => {
    const dir = tempDir();
    const recorder = new SessionRecorder({
      directory: dir,
      now: () => T0,
      retentionDays: 0,
      // `sig` would match every signature field in the session.
      secrets: ['sig'],
    });
    recorder.write('swap', encodeSwap(swapOf(1)));
    void recorder.close();
    expect(recorder.stats.redactions).toBe(0);
  });

  it('a digest never contains a secret, because it never sees one', () => {
    const digest = new SoakDigest({
      startedAt: T0,
      startingLamports: 5_000_000_000n,
      ledgerNetFlowLamports: () => 0n,
    });
    digest.observe('swap-detected', swapOf(1));
    const text = JSON.stringify(digest.snapshot(T0 + 1000));
    expect(text).not.toContain(KEY);
    expect(text).not.toMatch(/api-key/);
  });
});

// ---------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------

describe('soak digest', () => {
  function digestOf(netFlow: bigint = 0n): SoakDigest {
    return new SoakDigest({
      startedAt: T0,
      startingLamports: 5_000_000_000n,
      ledgerNetFlowLamports: () => netFlow,
    });
  }

  const fill = (overrides: Partial<SimulatedFill> = {}): SimulatedFill => ({
    intentId: 'i',
    side: 'buy',
    mint: MINT,
    tokensDelta: 1_000_000_000n,
    lamportsDelta: -50_000_000n,
    decimals: 6,
    feesLamports: 85_000n,
    slippageBps: 0,
    simulated: true,
    at: T0,
    ...overrides,
  });

  it('counts tracked swaps by venue and unparsed by reason', () => {
    const digest = digestOf();
    digest.observe('swap-detected', { venue: 'pumpfun' });
    digest.observe('swap-detected', { venue: 'pumpfun' });
    digest.observe('swap-detected', { venue: 'raydium-v4' });
    digest.observe('swap-unparsed', { reason: 'MULTI_MINT_DELTA' });

    const snapshot = digest.snapshot(T0 + 1000);
    expect(snapshot.trackedSwapsByVenue).toEqual({ 'raydium-v4': 1, pumpfun: 2 });
    expect(snapshot.unparsedByReason).toEqual({ MULTI_MINT_DELTA: 1 });
    // 1 of 4 total observed transactions.
    expect(snapshot.unparsedShareBps).toBe(2500);
    expect(snapshot.findings.some((f) => f.includes('>1%'))).toBe(true);
  });

  it('groups guard rejections by code and counts entry intents', () => {
    const digest = digestOf();
    digest.observe('rejection', { code: 'MALFORMED_INTENT' });
    digest.observe('rejection', { code: 'ALREADY_HOLDING' });
    digest.observe('rejection', { code: 'ALREADY_HOLDING' });
    digest.observe('intent-created', { side: 'buy' });
    digest.observe('intent-created', { side: 'sell' });

    const snapshot = digest.snapshot(T0);
    expect(snapshot.guardRejectionsByCode).toEqual({ ALREADY_HOLDING: 2, MALFORMED_INTENT: 1 });
    expect(snapshot.trades.entryIntents).toBe(1);
  });

  it('treats ANY no-route-while-held as a finding', () => {
    const digest = digestOf();
    digest.observe('route-lost', { mint: MINT });
    const snapshot = digest.snapshot(T0);
    expect(snapshot.noRouteWhileHeld).toEqual({ [MINT]: 1 });
    expect(snapshot.findings.some((f) => f.includes('NO_ROUTE while holding'))).toBe(true);
  });

  it('measures reconnect latency between a disconnect and the reconnect after it', () => {
    const digest = digestOf();
    digest.observe('stream-disconnected', { at: T0 });
    digest.observe('stream-reconnected', { at: T0 + 2_500 });
    digest.observe('stream-disconnected', { at: T0 + 10_000 });
    digest.observe('stream-reconnected', { at: T0 + 10_400 });
    digest.observe('stream-gap-filled', { count: 37, truncated: false });

    const snapshot = digest.snapshot(T0);
    expect(snapshot.stream.disconnects).toBe(2);
    expect(snapshot.stream.reconnectLatencyMs.max).toBe(2_500);
    expect(snapshot.stream.signaturesRecovered).toBe(37);
  });

  it('ASSERTS paper balance drift is zero, and finds it when it is not', () => {
    // The two routes to one number: the ledger's own sum, and the digest's
    // independent arithmetic over the `fill` events it saw.
    const agreeing = digestOf(-50_085_000n);
    agreeing.observe('fill', fill());
    expect(agreeing.snapshot(T0).money.paperBalanceDrift).toBe('0');
    expect(agreeing.snapshot(T0).findings).toEqual([]);

    const disagreeing = digestOf(-99_999_999n);
    disagreeing.observe('fill', fill());
    const snapshot = disagreeing.snapshot(T0);
    expect(snapshot.money.paperBalanceDrift).not.toBe('0');
    expect(snapshot.findings[0]).toMatch(/PAPER BALANCE DRIFT/);
  });

  it('computes realized P&L by the ledger\'s own basis-relief rule', () => {
    const digest = digestOf(0n);
    digest.observe('fill', fill());
    digest.observe(
      'fill',
      fill({ intentId: 'j', side: 'sell', tokensDelta: -1_000_000_000n, lamportsDelta: 60_000_000n }),
    );
    // 60,000,000 out, less a 50,085,000 fee-inclusive basis and an 85,000 fee.
    expect(digest.snapshot(T0).money.realizedLamports).toBe('9830000');
  });

  it('reports dropped session lines as a finding — the session is unfit for replay', () => {
    const digest = new SoakDigest({
      startedAt: T0,
      startingLamports: 5_000_000_000n,
      ledgerNetFlowLamports: () => 0n,
      recorderStats: () => ({
        written: 100,
        dropped: 3,
        droppedByKind: new Map([['swap', 3]]),
        rotations: 1,
        unmodeled: 0,
      }),
    });
    const snapshot = digest.snapshot(T0);
    expect(snapshot.recorder.droppedByKind).toEqual({ swap: 3 });
    expect(snapshot.findings.some((f) => f.includes('unfit for replay'))).toBe(true);
  });

  it('reports unmodeled tags as a finding — that is the whole point of the kind', () => {
    const digest = digestOf();
    digest.observeUnmodeled('tracker:something-new');
    const snapshot = digest.snapshot(T0);
    expect(snapshot.unmodeledByTag).toEqual({ 'tracker:something-new': 1 });
    expect(snapshot.findings.some((f) => f.includes('schema is incomplete'))).toBe(true);
  });

  it('serializes with stable key order and renders a table', () => {
    const digest = digestOf();
    digest.observe('swap-detected', { venue: 'whirlpool' });
    const first = JSON.stringify(digest.snapshot(T0 + 5));
    const second = JSON.stringify(digest.snapshot(T0 + 5));
    expect(second).toBe(first);
    expect(formatDigest(digest.snapshot(T0 + 5))).toMatch(/balance drift\s+0 lamports/);
  });

  it('a clean digest has no findings', () => {
    const digest = digestOf();
    digest.observe('swap-detected', { venue: 'pumpfun' });
    expect(digest.snapshot(T0).findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Crash drill — a real SIGKILL
// ---------------------------------------------------------------------------

describe('crash drill', () => {
  const CHILD = join(HERE, 'fixtures/soak-child.ts');

  /**
   * `detached`, so the child can be killed as a PROCESS GROUP.
   *
   * `npx tsx` is a wrapper that spawns the real `node`. Killing the returned
   * handle kills the wrapper and orphans the node process underneath it —
   * which, for a child whose whole job is to loop until killed, means it runs
   * forever. Fifty of them accumulated during this prompt, drove the load
   * average past 100, held the crash-drill databases open, and produced a
   * `SQLITE_BUSY` that looked exactly like a production defect. Killing
   * `-pid` takes the group.
   */
  function run(dbPath: string, sessionDir: string, mode: string) {
    return spawn('npx', ['tsx', CHILD, dbPath, sessionDir, mode], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
  }

  function killGroup(child: { pid?: number | undefined }): void {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }

  /**
   * RUNS IN THE SUITE. The header here used to say it was skipped and run by
   * hand; it was never `it.skip`, so that was describing an intention rather
   * than the file, and it is the sort of note that makes a red run arguable.
   *
   * It spawns a real `npx tsx` child, SIGKILLs it, and replays a ~3,700-line
   * session twice in-process. Running alongside the other spawn-based tests it
   * starves them: `cli-orphans` and the tracker's orderly-stop child both began
   * timing out at 5s the moment this was added, and they are not the code under
   * test. Serialising the whole suite fixed those and tripled the runtime, so
   * that was reverted too.
   *
   * What it establishes, verified across 30 isolated and 30 contended runs on
   * 2026-08-05 — see docs/handoffs/18-flake-mechanisms.md:
   *   - every session file in sessionDir parsed, including the truncated tail
   *   - the pre-crash file replayed to a stable SHA-256
   *   - the restart reported the surviving anchor position (1,000,000,000 units)
   *
   * Run it alone with:  npx vitest run tests/soak.test.ts -t "SIGKILL"
   */
  it(
    'survives a real SIGKILL: positions, intents, sessions and the replay hash',
    async () => {
      const dir = tempDir();
      const dbPath = join(dir, 'soak.db');
      const sessionDir = join(dir, 'sessions');

      // -- 1. run, and kill it while it is trading -------------------------
      const child = run(dbPath, sessionDir, 'crash');
      const ready = await new Promise<string>((resolveReady, rejectReady) => {
        let buffer = '';
        const timer = setTimeout(() => rejectReady(new Error(`child never READY: ${buffer}`)), 45_000);
        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const match = /READY (.+)/.exec(buffer);
          if (match !== null) {
            clearTimeout(timer);
            resolveReady(match[1]!.trim());
          }
        });
        child.stderr.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
        });
        // The child now gives up loudly rather than announcing a readiness it
        // has not reached. Surfacing that here, instead of waiting out the 45s
        // timeout, keeps a real regression — the tracker stopped filling —
        // legible as itself rather than as "the machine was busy".
        child.on('exit', (code) => {
          clearTimeout(timer);
          rejectReady(new Error(`child exited (${code}) before READY: ${buffer}`));
        });
      });

      // A random point inside a 60s window, scaled to keep the suite usable:
      // the property under test is "killed mid-write", not the wall time.
      //
      // Deliberately still random. It is the child that now guarantees there is
      // something to lose — it does not print READY until the ledger shows the
      // anchor position open, and nothing it does afterwards can close that
      // position. Before that, the only position was the churn mint's, which
      // opens and closes on a ~10ms cycle, so this delay was sampling the phase
      // of that cycle and the assertion below was a coin flip.
      await new Promise((r) => setTimeout(r, 50 + Math.floor(Math.random() * 250)));
      // SIGKILL, not SIGTERM. An uncatchable signal is the whole drill —
      // anything the process could have handled is a shutdown, not a crash.
      killGroup(child);
      await new Promise((r) => child.on('exit', r));

      // -- 2. every session file parses ------------------------------------
      const files = readdirSync(sessionDir).filter((name) => name.endsWith('.jsonl'));
      expect(files.length).toBeGreaterThan(0);
      const parsed = files.map((name) =>
        parseSession(readFileSync(join(sessionDir, name), 'utf8'), name),
      );
      for (const session of parsed) expect(session.lines.length).toBeGreaterThan(0);

      // -- 3. the pre-crash file still replays to its original hash ---------
      //
      // The file is read ONCE. A killed process's session is not stable the
      // instant `exit` fires: the kernel is still writing back pages the dead
      // process had dirtied, so two reads a few milliseconds apart can return
      // different lengths. Found by this test failing with two different
      // hashes for what looked like the same file. Re-reading would be testing
      // the page cache; the criterion is about the replay.
      const text = readFileSync(ready, 'utf8');
      const preCrash = parseSession(text, 'pre-crash');
      expect(preCrash.lines.length).toBeGreaterThan(3);

      const hashOf = async (): Promise<string> => {
        const { report } = await replaySession({
          session: parseSession(text, 'pre-crash'),
          sessionLabel: 'pre-crash',
          strategyName: 'mirror',
          slippageBps: 0,
        });
        return createHash('sha256').update(JSON.stringify(report, null, 2)).digest('hex');
      };
      const first = await hashOf();
      const second = await hashOf();
      expect(second).toBe(first);

      // Once the kernel has finished writing back, the file on disk replays
      // too — possibly to a different hash, because it may legitimately hold
      // MORE events than the snapshot taken mid-flush. What must hold is that
      // it is still a valid, replayable session.
      await new Promise((r) => setTimeout(r, 250));
      const settled = readFileSync(ready, 'utf8');
      expect(settled.length).toBeGreaterThanOrEqual(text.length);
      const { report: settledReport } = await replaySession({
        session: parseSession(settled, 'settled'),
        sessionLabel: 'pre-crash',
        strategyName: 'mirror',
        slippageBps: 0,
      });
      const settledHash = createHash('sha256')
        .update(JSON.stringify(settledReport, null, 2))
        .digest('hex');
      if (settled === text) expect(settledHash).toBe(first);
      expect(settledHash).toMatch(/^[0-9a-f]{64}$/);

      // -- 4. restart: same open positions, nothing stuck pending -----------
      const restart = run(dbPath, sessionDir, 'restart');
      const output = await new Promise<string>((resolveOut, rejectOut) => {
        let buffer = '';
        let errors = '';
        restart.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
        });
        restart.stderr.on('data', (chunk: Buffer) => {
          errors += chunk.toString();
        });
        restart.on('exit', (code) => {
          if (buffer.trim().length === 0) {
            rejectOut(new Error(`restart produced no output (exit ${code}): ${errors}`));
            return;
          }
          resolveOut(buffer);
        });
      });

      const report = JSON.parse(output.trim().split('\n').at(-1)!) as {
        openPositions: Array<{ mint: string; tokens: string }>;
        orphaned: string[];
        recovered: string[];
      };
      // The position taken before the crash survived it. Named, not counted:
      // the churn mint may legitimately be open or flat depending on where the
      // SIGKILL landed, so a bare count would pass on the wrong position.
      expect(report.openPositions.map((p) => p.mint)).toContain(ANCHOR_MINT);
      expect(
        report.openPositions.find((p) => p.mint === ANCHOR_MINT)?.tokens,
      ).toBe('1000000000');

      // A crash mid-trade may legitimately leave an orphan — that is what the
      // orphan gate is for. What must NOT survive reconciliation is an intent
      // still `pending`, which means nobody knows what happened to it.
      const raw = await import('better-sqlite3');
      const db = new raw.default(dbPath, { readonly: true });
      const pending = db
        .prepare(`SELECT COUNT(*) AS n FROM intents WHERE status = 'pending'`)
        .get() as { n: number };
      db.close();
      expect(pending.n).toBe(0);
    },
    120_000,
  );
});
