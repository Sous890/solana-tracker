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
  /**
   * A digest over a ledger that STARTS this run at zero and ends it at
   * `netFlow`, which is what a fresh soak actually sees.
   *
   * It used to hand back a constant. That was indistinguishable from a moving
   * ledger only while the file began empty — and the drift check latches the
   * opening value at construction so it can compare the run's own delta rather
   * than the file's whole history. See `ledgerFlowAtStart`.
   */
  function digestOf(netFlow: bigint = 0n): SoakDigest {
    let flow = 0n;
    const digest = new SoakDigest({
      startedAt: T0,
      startingLamports: 5_000_000_000n,
      ledgerNetFlowLamports: () => flow,
    });
    flow = netFlow;
    return digest;
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
    // A code the parser positively assigned. Counted and printed, never alarmed:
    // `MULTI_MINT_DELTA` is a determination — "this is a shape the invariant does
    // not describe, and guessing produces a confident wrong answer" — not a
    // failure to reach one.
    expect(snapshot.classifiedByCode).toEqual({ MULTI_MINT_DELTA: 1 });
    expect(snapshot.classifiedShareBps).toBe(2500);
    expect(snapshot.unhandledTotal).toBe(0);
    expect(snapshot.findings).toEqual([]);
  });

  // -- the split ------------------------------------------------------------
  //
  // Four counters had cried wolf before this one, and the unparsed rate was the
  // fourth — created by the same session that fixed the other three. The alarm
  // fired at 97.05% on `digest-001-final-SIGTERM.json`, a healthy run, because
  // it measured "how much of the feed was not a swap" rather than "how much of
  // the feed the parser could not account for". Those are different questions
  // and only the second one is a defect.

  it('does not alarm on classified codes, whatever share of the feed they are', () => {
    const digest = digestOf();
    digest.observe('swap-detected', { venue: 'pumpfun' });
    // The shape of the run that fired at 97%: infrastructure traffic dominates,
    // and every bit of it was correctly declined.
    for (let i = 0; i < 3_496; i += 1) {
      digest.observe('swap-unparsed', { reason: 'INFRASTRUCTURE_ONLY' });
    }
    for (let i = 0; i < 72; i += 1) digest.observe('swap-unparsed', { reason: 'TX_FAILED' });

    const snapshot = digest.snapshot(T0 + 1000);
    expect(snapshot.classifiedTotal).toBe(3_568);
    expect(snapshot.classifiedShareBps).toBe(9997);
    expect(snapshot.unhandledTotal).toBe(0);
    expect(snapshot.unhandledShareBps).toBe(0);
    expect(snapshot.findings).toEqual([]);
  });

  it('alarms on a code it does not positively recognise', () => {
    const digest = digestOf();
    for (let i = 0; i < 99; i += 1) digest.observe('swap-detected', { venue: 'pumpfun' });
    // A reason string the digest has never been taught. The parser gaining a
    // code without this module gaining it too is exactly the drift the split
    // exists to catch, so it must land in `unhandled` rather than being absorbed
    // into the classified distribution by not matching anything.
    digest.observe('swap-unparsed', { reason: 'SOME_NEW_VENUE_SHAPE' });

    const snapshot = digest.snapshot(T0 + 1000);
    expect(snapshot.unhandledByCode).toEqual({ SOME_NEW_VENUE_SHAPE: 1 });
    expect(snapshot.unhandledTotal).toBe(1);
    expect(snapshot.classifiedTotal).toBe(0);
    expect(snapshot.findings).toHaveLength(1);
    expect(snapshot.findings[0]).toContain('SOME_NEW_VENUE_SHAPE');
  });

  it('alarms when no reason code was assigned at all', () => {
    const digest = digestOf();
    digest.observe('swap-detected', { venue: 'pumpfun' });
    digest.observe('swap-unparsed', {});

    const snapshot = digest.snapshot(T0 + 1000);
    expect(snapshot.unhandledByCode).toEqual({ UNKNOWN: 1 });
    expect(snapshot.findings).toHaveLength(1);
  });

  it('prints the threshold and the basis it was derived from', () => {
    const digest = digestOf();
    digest.observe('swap-unparsed', { reason: 'SOME_NEW_VENUE_SHAPE' });

    const finding = digest.snapshot(T0 + 1000).findings[0] ?? '';
    // The value, the threshold it breached, and where that threshold came from —
    // on the line itself, so a stale basis is visible the moment it fires rather
    // than a session later.
    expect(finding).toContain('threshold >0');
    expect(finding).toContain('n=7,184');
    expect(finding).toMatch(/2026-08-0[67]/);
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
    digest.observe('stream-disconnected', { at: T0, phase: 'socket-death' });
    digest.observe('stream-reconnected', { at: T0 + 2_500 });
    digest.observe('stream-disconnected', { at: T0 + 10_000, phase: 'socket-death' });
    digest.observe('stream-reconnected', { at: T0 + 10_400 });
    digest.observe('stream-gap-filled', { count: 37, truncated: false });

    const snapshot = digest.snapshot(T0);
    expect(snapshot.stream.socketDeaths).toBe(2);
    expect(snapshot.stream.reconnectLatencyMs.max).toBe(2_500);
    expect(snapshot.stream.signaturesRecovered).toBe(37);
  });

  // -- the disconnect split -------------------------------------------------

  it('counts a retry that never opened a socket apart from a socket that died', () => {
    const digest = digestOf();
    digest.observe('stream-disconnected', { at: T0, phase: 'socket-death' });
    // One outage against a 30s-capped backoff emits one of these per attempt.
    // Summed with the death above, this is what made `disconnects` unreadable:
    // 25,783 attempt failures against ~39 real deaths, reported as one number.
    for (let i = 1; i <= 40; i += 1) {
      digest.observe('stream-disconnected', { at: T0 + i * 1_000, phase: 'connect-attempt' });
    }

    const snapshot = digest.snapshot(T0);
    expect(snapshot.stream.socketDeaths).toBe(1);
    expect(snapshot.stream.connectAttemptFailures).toBe(40);
  });

  it('collapses the error/close pair a single socket death emits', () => {
    const digest = digestOf();
    // A real WebSocket fires both, 0-1ms apart. Measured max across the corpus
    // is 34ms; the closest genuinely distinct deaths are 9,946ms apart.
    digest.observe('stream-disconnected', { at: T0, phase: 'socket-death' });
    digest.observe('stream-disconnected', { at: T0 + 1, phase: 'socket-death' });
    digest.observe('stream-disconnected', { at: T0 + 34, phase: 'socket-death' });

    const snapshot = digest.snapshot(T0);
    expect(snapshot.stream.socketDeaths).toBe(1);
    expect(snapshot.stream.deathEchoesCollapsed).toBe(2);
  });

  it('surfaces an acknowledged gap as a finding, and survives a shutdown snapshot', () => {
    // The digest is the one artifact anybody reads. A run that skipped history
    // and did not say so is a run whose cursors describe positions it never
    // delivered.
    const digest = digestOf();
    digest.observe('stream-history-skipped', {
      wallet: 'BCagckXeMChUKrHEd6fKFA1uiWDtcmCXMsqaheLiUPJd',
      fromSlot: 437_800_000,
      toSlot: 437_911_358,
      count: 19_945,
    });

    const snapshot = digest.snapshot(T0 + 1_000);
    expect(snapshot.stream.historySkipped).toHaveLength(1);
    expect(snapshot.stream.signaturesSkipped).toBe(19_945);

    const finding = snapshot.findings.find((f) => f.includes('ACKNOWLEDGED GAP'));
    expect(finding).toBeDefined();
    expect(finding).toContain('19945');
    expect(finding).toContain('437800000-437911358');
    // Threshold and basis on the line, like every other finding.
    expect(finding).toContain('bounded at 100');
    expect(finding).toContain('n=47,684');

    // Accumulated in the digest's own state rather than read back through a
    // callback at snapshot time. That is what makes it survive a final digest
    // taken during shutdown: the `?? 0` over a torn-down `tracker.session`
    // reported `written: 0` for a recorder that had written 71,891 lines, and
    // internal state cannot fail that way. Snapshotting repeatedly, as the
    // hourly-then-final sequence does, must not lose or double it.
    const second = digest.snapshot(T0 + 2_000);
    expect(second.stream.historySkipped).toHaveLength(1);
    expect(second.stream.signaturesSkipped).toBe(19_945);
    expect(second.findings.filter((f) => f.includes('ACKNOWLEDGED GAP'))).toHaveLength(1);
  });

  it('keeps two deaths separate once they are further apart than the window', () => {
    const digest = digestOf();
    digest.observe('stream-disconnected', { at: T0, phase: 'socket-death' });
    digest.observe('stream-disconnected', { at: T0 + 9_946, phase: 'socket-death' });

    const snapshot = digest.snapshot(T0);
    expect(snapshot.stream.socketDeaths).toBe(2);
    expect(snapshot.stream.deathEchoesCollapsed).toBe(0);
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

/**
 * The drift check compared a per-process counter against a cumulative ledger, so
 * it fired on every healthy run against a ledger that was not brand new. Session
 * 23's first-ever final digest reported `PAPER BALANCE DRIFT of -106789862
 * lamports` — the two open positions it had legitimately inherited on restart.
 *
 * A warning that fires on healthy runs is training to ignore warnings.
 */
describe('paper balance drift, against a ledger that already had history', () => {
  const T0 = 1_700_000_000_000;
  const MINT = 'So11111111111111111111111111111111111111112';

  const aFill = (): SimulatedFill => ({
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
  });

  function digestOnExisting(opening: bigint, netFlow: bigint): SoakDigest {
    let flow = opening;
    const digest = new SoakDigest({
      startedAt: T0,
      startingLamports: 5_000_000_000n,
      ledgerNetFlowLamports: () => flow,
    });
    flow = opening + netFlow;
    return digest;
  }

  it('reports no drift when this run agrees, whatever the ledger inherited', () => {
    // -106,789,862 is what session 23 actually inherited from the run before it.
    const digest = digestOnExisting(-106_789_862n, -50_085_000n);
    digest.observe('fill', aFill());

    const snapshot = digest.snapshot(T0);
    expect(snapshot.money.paperBalanceDrift).toBe('0');
    expect(snapshot.findings).toEqual([]);
  });

  it('still catches a genuine disagreement inside the run', () => {
    const digest = digestOnExisting(-106_789_862n, -99_999_999n);
    digest.observe('fill', aFill());

    const snapshot = digest.snapshot(T0);
    expect(snapshot.money.paperBalanceDrift).not.toBe('0');
    expect(snapshot.findings[0]).toMatch(/PAPER BALANCE DRIFT/);
  });

  it('still reports the ledger\'s cumulative balance, not just this run\'s', () => {
    const digest = digestOnExisting(-106_789_862n, -50_085_000n);
    digest.observe('fill', aFill());
    // 5 SOL starting, less everything the file has ever spent.
    expect(digest.snapshot(T0).money.paperBalanceLamports).toBe(
      String(5_000_000_000n - 106_789_862n - 50_085_000n),
    );
  });
});
