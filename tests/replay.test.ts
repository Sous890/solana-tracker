import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { malformedIntentReason } from '../src/core/guards.js';
import type { QuoteError, QuoteRequest } from '../src/core/quoteSource.js';
import type { Context, IntentDraft, Strategy } from '../src/core/strategy.js';
import type { OrderIntent, Position, Quote, TrackedSwap } from '../src/core/types.js';
import { WRAPPED_SOL_MINT } from '../src/core/units.js';
import { openLedger } from '../src/db/ledger.js';
import {
  SessionRecorder,
  decodeSwap,
  encodeSwap,
  quoteKey,
  sessionPath,
} from '../src/services/recorder.js';
import type { SessionKind } from '../src/services/recorder.js';
import { InvariantChecker, InvariantViolation } from './replay/invariants.js';
import { SessionError, parseSession } from './replay/session.js';
import { buildReport, formatTable, slippageVerdict } from './replay/report.js';
import {
  ReplayError,
  SLIPPAGE_SWEEP,
  SimClock,
  installFetchTrap,
  replaySession,
  sweepSlippage,
} from './replay/run.js';
import {
  BUY_LAMPORTS,
  DECIMALS,
  MINT_A,
  MINT_B,
  OVERSELL_FILLS,
  T0,
  WALLET,
  buildSyntheticSession,
} from './replay/synthetic.js';

// ---------------------------------------------------------------------------
// Record mode
// ---------------------------------------------------------------------------

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'recorder-'));
}

function swapOf(overrides: Partial<TrackedSwap> = {}): TrackedSwap {
  return {
    wallet: WALLET,
    mint: MINT_A,
    side: 'buy',
    solAmount: 410_000_000n,
    tokenAmount: 1_000_000_000n,
    decimals: DECIMALS,
    signature: 'sig',
    slot: 1,
    blockTime: 1_700_000_000,
    venue: 'pumpfun',
    feePayer: true,
    source: 'live',
    observedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function quoteOf(request: QuoteRequest, out: bigint): Quote {
  return {
    inMint: request.inMint,
    outMint: request.outMint,
    inAmount: request.inAmount,
    outAmount: out,
    priceImpactPct: 0.25,
    routePlan: [],
    fetchedAt: T0,
  };
}

async function recorded(
  run: (recorder: SessionRecorder) => Promise<void> | void,
): Promise<{ lines: Array<Record<string, unknown>>; recorder: SessionRecorder; dir: string }> {
  const dir = tempDir();
  let clock = T0;
  const recorder = new SessionRecorder({ directory: dir, now: () => (clock += 1) });
  await run(recorder);
  // Path first, then close: `close` flushes, and the path can have moved if the
  // run rotated.
  const path = recorder.path;
  await recorder.close();
  const text = readFileSync(path, 'utf8');
  const lines = text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { lines, recorder, dir };
}

describe('record mode', () => {
  it('writes one line per event, with a monotonic seq', async () => {
    const { lines, dir } = await recorded((recorder) => {
      recorder.write('swap', encodeSwap(swapOf()));
      recorder.write('swap', encodeSwap(swapOf({ signature: 'b' })));
      recorder.write('screen', { mint: MINT_A });
    });
    try {
      expect(lines.map((line) => line['seq'])).toEqual([1, 2, 3]);
      expect(lines.map((line) => line['kind'])).toEqual(['swap', 'swap', 'screen']);
      // The line shape the spec fixes.
      expect(Object.keys(lines[0]!)).toEqual(['seq', 'simClockMs', 'kind', 'payload']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('seq is the tie-break — it advances even when the clock does not', async () => {
    const dir = tempDir();
    // A clock stuck on one millisecond, which a real one routinely is.
    const recorder = new SessionRecorder({ directory: dir, now: () => T0 });
    recorder.write('swap', encodeSwap(swapOf()));
    recorder.write('swap', encodeSwap(swapOf({ signature: 'b' })));
    const path = recorder.path;
    await recorder.close();

    try {
      const lines = readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { seq: number; simClockMs: number });
      expect(lines.map((line) => line.simClockMs)).toEqual([T0, T0]);
      // `at` alone is not a stable sort key. This is the field that is.
      expect(lines.map((line) => line.seq)).toEqual([1, 2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('subscribes to the tracker emitter rather than reaching into adapters', async () => {
    const tracker = new EventEmitter();
    const { lines, dir } = await recorded((recorder) => {
      recorder.attach(tracker as never);
      tracker.emit('event', { type: 'swap-detected', data: swapOf() });
      // Recognised OUTPUTS are skipped by name; a session holds inputs.
      tracker.emit('event', { type: 'fill', data: {} });
      tracker.emit('event', { type: 'rejection', data: {} });
      // Anything the schema does not know becomes `unmodeled`, never nothing.
      tracker.emit('event', { type: 'something-new', data: { a: 1 } });
    });
    try {
      expect(lines).toHaveLength(2);
      expect(lines[0]!['kind']).toBe('swap');
      expect(lines[1]).toMatchObject({
        kind: 'unmodeled',
        payload: { tag: 'tracker:something-new', raw: { a: 1 } },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records a quote and its response through a decorator', async () => {
    const { lines, dir } = await recorded(async (recorder) => {
      const wrapped = recorder.wrapQuotes({
        getQuote: async (request) => quoteOf(request, 1_000_000_000n),
      });
      const result = await wrapped.getQuote({
        inMint: WRAPPED_SOL_MINT,
        outMint: MINT_A,
        inAmount: BUY_LAMPORTS,
        slippageBps: 300,
      });
      // The decorator delegates unchanged.
      expect((result as Quote).outAmount).toBe(1_000_000_000n);
    });
    try {
      const payload = lines[0]!['payload'] as {
        request: { inAmount: string };
        quote: { outAmount: string };
      };
      expect(payload.request.inAmount).toBe(BUY_LAMPORTS.toString());
      expect(payload.quote.outAmount).toBe('1000000000');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('RECORDS NO_ROUTE — the most important thing a session can contain', async () => {
    const error: QuoteError = { error: 'NO_ROUTE', message: 'TOKEN_NOT_TRADABLE' };
    const { lines, dir } = await recorded(async (recorder) => {
      const wrapped = recorder.wrapQuotes({ getQuote: async () => error });
      await wrapped.getQuote({
        inMint: MINT_A,
        outMint: WRAPPED_SOL_MINT,
        inAmount: 1n,
        slippageBps: 300,
      });
    });
    try {
      // The difference between "the strategy chose not to act" and "there was
      // no way to act". A replay missing this turns a trapped position into a
      // profitable exit.
      expect((lines[0]!['payload'] as { error: QuoteError }).error).toEqual(error);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records a screen verdict with its failed checks', async () => {
    const { lines, dir } = await recorded(async (recorder) => {
      const wrapped = recorder.wrapScreener({
        screenMint: async () => ({
          verdict: 'fail',
          failedChecks: ['MINT_AUTHORITY_LIVE', 'LIQUIDITY_BELOW_FLOOR'],
          unknownChecks: [],
          details: {},
          screenedAt: T0,
        }),
      });
      const result = await wrapped.screenMint(MINT_A, { sizeSol: 0.05 });
      // Generic in the result: the decorator hands back everything it got.
      expect(result.details).toEqual({});
    });
    try {
      expect(lines[0]!['payload']).toMatchObject({
        mint: MINT_A,
        verdict: 'fail',
        failedChecks: ['MINT_AUTHORITY_LIVE', 'LIQUIDITY_BELOW_FLOOR'],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records the price each held position was marked at', async () => {
    const position = { mint: MINT_A, tokens: 997_000_000n, decimals: DECIMALS } as Position;
    const { lines, dir } = await recorded(async (recorder) => {
      const wrapped = recorder.wrapDriver({
        onTrackedSwap: async (_swap: TrackedSwap) => undefined,
        onPriceTick: async (_position: Position, _priceSol: number) => undefined,
      });
      await wrapped.onPriceTick(position, 0.000050085);
    });
    try {
      const payload = lines[0]!['payload'] as { priceSol: string; tokens: string };
      // A string, and one that round-trips exactly.
      expect(Number(payload.priceSol)).toBe(0.000050085);
      expect(payload.tokens).toBe('997000000');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the driver decorator preserves the EventEmitter the tracker subscribes to', async () => {
    // A plain object literal would drop this, and `Object.create` would break
    // it more subtly: EventEmitter writes its listener map onto `this`, so
    // subscriptions would land on the wrapper while emits fired on the inner.
    class FakeDriver extends EventEmitter {
      async onTrackedSwap(_swap: TrackedSwap): Promise<void> {}
      async onPriceTick(_position: Position, _priceSol: number): Promise<void> {}
    }
    const inner = new FakeDriver();
    const { dir } = await recorded((recorder) => {
      const wrapped = recorder.wrapDriver(inner);
      const seen: unknown[] = [];
      wrapped.on('strategy-error', (payload) => seen.push(payload));
      inner.emit('strategy-error', { kind: 'timeout' });
      expect(seen).toEqual([{ kind: 'timeout' }]);
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it('DROPS rather than blocks when it falls behind, and counts the drop', async () => {
    const dir = tempDir();
    // A buffer of nothing, so the first write is already "behind".
    const recorder = new SessionRecorder({ directory: dir, now: () => T0, maxBufferedBytes: 0 });

    try {
      // The first write lands in the stream's buffer; from then on the stream
      // is "behind" by this recorder's standard.
      expect(recorder.write('swap', encodeSwap(swapOf()))).toBe(true);

      // A bot that hesitated on a trade because a log file was slow would be a
      // worse bot than one with an incomplete log.
      expect(recorder.write('swap', encodeSwap(swapOf({ signature: 'b' })))).toBe(false);
      expect(recorder.stats.dropped).toBe(1);
      expect(recorder.stats.written).toBe(1);
      await recorder.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names sessions {ISO-date}-{n}, taking the first free index', () => {
    const taken = new Set(['s/2026-08-04-1.jsonl', 's/2026-08-04-2.jsonl']);
    expect(sessionPath('s', Date.UTC(2026, 7, 4, 12), (path) => taken.has(path))).toBe(
      's/2026-08-04-3.jsonl',
    );
  });
});

// ---------------------------------------------------------------------------
// Session loading
// ---------------------------------------------------------------------------

describe('session loading refuses a session it cannot replay faithfully', () => {
  const line = (seq: number): string =>
    JSON.stringify({ seq, simClockMs: T0 + seq, kind: 'screen', payload: { mint: MINT_A } });

  it('rejects a gap, because a gap means the recorder dropped lines', () => {
    // A missing quote becomes a loud miss. A missing SWAP becomes a trade that
    // simply never happens, which is silent — so the gap is caught up front.
    expect(() => parseSession(`${line(1)}\n${line(3)}\n`, 's')).toThrow(SessionError);
    expect(() => parseSession(`${line(1)}\n${line(3)}\n`, 's')).toThrow(/gap/);
  });

  it('rejects an out-of-order session', () => {
    expect(() => parseSession(`${line(2)}\n${line(1)}\n`, 's')).toThrow(/out of order/);
  });

  it('rejects an empty session', () => {
    expect(() => parseSession('', 's')).toThrow(/empty/);
  });

  it('rejects unparseable JSON in the MIDDLE — that is corruption, not a crash', () => {
    expect(() => parseSession(`{oops\n${line(2)}\n`, 's')).toThrow(/not JSON/);
  });

  it('TOLERATES a truncated final line, and reports it', () => {
    // The normal shape of a session from a process that died: the last write
    // was cut between `stream.write()` and the kernel flushing it. Refusing it
    // would make the recording unusable in the one case it was written for.
    const session = parseSession(`${line(1)}\n${line(2)}\n{"seq":3,"simCl`, 's');
    expect(session.lines).toHaveLength(2);
    expect(session.truncatedTail).toBe('{"seq":3,"simCl');
  });

  it('tolerates a final line that parses but lost its header', () => {
    // JSON stays valid at more cut points than one would like: `{"seq":3}` is
    // parseable and is still a torn write.
    const session = parseSession(`${line(1)}\n{"payload":{}}`, 's');
    expect(session.lines).toHaveLength(1);
    expect(session.truncatedTail).toBe('{"payload":{}}');
  });

  it('reports no tail on an intact session', () => {
    expect(parseSession(`${line(1)}\n${line(2)}\n`, 's').truncatedTail).toBeNull();
  });

  it('rejects an unknown kind rather than skipping it', () => {
    const bad = JSON.stringify({ seq: 1, simClockMs: T0, kind: 'mystery', payload: {} });
    expect(() => parseSession(`${bad}\n`, 's')).toThrow(/unknown kind/);
  });

  it('indexes quotes by (inMint, outMint, amount)', () => {
    const session = parseSession(buildSyntheticSession(), 'synthetic');
    expect(
      session.quotes.has(
        quoteKey({ inMint: WRAPPED_SOL_MINT, outMint: MINT_A, inAmount: BUY_LAMPORTS }),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The simulated clock and the network trap
// ---------------------------------------------------------------------------

describe('the replay environment', () => {
  it('never goes backwards, and never stands still', () => {
    const clock = new SimClock(T0);
    clock.advanceTo(T0 - 5_000);
    // Going backwards would reorder fills against the ledger's `at` sort.
    expect(clock.now()).toBe(T0 + 1);
    clock.advanceTo(T0 + 10_000);
    expect(clock.now()).toBe(T0 + 10_000);
  });

  it('THROWS on any network access', () => {
    const restore = installFetchTrap();
    try {
      expect(() => globalThis.fetch('https://api.jup.ag/quote')).toThrow(ReplayError);
      expect(() => globalThis.fetch('https://api.jup.ag/quote')).toThrow(/reached the network/);
    } finally {
      restore();
    }
  });

  it('restores the previous fetch, so one replay cannot poison the next test', () => {
    const before = globalThis.fetch;
    installFetchTrap()();
    expect(globalThis.fetch).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Smoke: MirrorStrategy over a synthetic session
// ---------------------------------------------------------------------------

describe('replay smoke test — MirrorStrategy', () => {
  const session = () => parseSession(buildSyntheticSession(), 'synthetic');

  it('runs a full round trip through the real guards and the real broker', async () => {
    const { report } = await replaySession({
      session: session(),
      sessionLabel: 'synthetic',
      strategyName: 'mirror',
      slippageBps: 0,
    });

    expect(report.trades).toEqual({ buys: 1, sells: 1, roundTrips: 1 });
    expect(report.ledgerReconcilesClean).toBe(true);
    // 50,300,000 out, less a 50,085,000 fee-inclusive basis and an 85,000 exit
    // fee. Every figure a string; no float anywhere in the report.
    expect(report.realizedPnlLamports).toBe('130000');
    expect(report.totalFeesLamports).toBe('170000');
    expect(report.winRate).toEqual({ wins: 1, losses: 0, flat: 0, bps: 10_000 });
  });

  it('produces a report with no float anywhere in it', async () => {
    const { report } = await replaySession({
      session: session(),
      sessionLabel: 'synthetic',
      strategyName: 'mirror',
      slippageBps: 30,
    });

    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'number') {
        expect(Number.isInteger(value), `${path} is a float: ${value}`).toBe(true);
      } else if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      } else if (value !== null && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`);
      }
    };
    walk(report, 'report');
  });

  it('carries no wall-clock into the report', async () => {
    const { report } = await replaySession({
      session: session(),
      sessionLabel: 'synthetic',
      strategyName: 'mirror',
      slippageBps: 0,
    });
    // Every timestamp-shaped number would be the one field guaranteed to differ
    // between two identical runs.
    expect(JSON.stringify(report)).not.toMatch(/17[0-9]{11}/);
  });

  it('records a position that lost its route while held', async () => {
    const { report } = await replaySession({
      session: parseSession(buildSyntheticSession({ includeNoRoute: true }), 'synthetic'),
      sessionLabel: 'synthetic',
      strategyName: 'mirror',
      slippageBps: 0,
    });

    expect(report.noRouteWhileHeld).toEqual([MINT_B]);
    // Held, not sold: a no-route mint is an alert, never a signal.
    expect(report.trades.roundTrips).toBe(1);
  });

  it('EquationStrategy trades nothing on the same session', async () => {
    const { report } = await replaySession({
      session: session(),
      sessionLabel: 'synthetic',
      strategyName: 'equation',
      slippageBps: 0,
    });
    expect(report.trades).toEqual({ buys: 0, sells: 0, roundTrips: 0 });
    expect(report.ledgerReconcilesClean).toBe(true);
  });

  it('renders a human-readable table', async () => {
    const { report } = await replaySession({
      session: session(),
      sessionLabel: 'synthetic',
      strategyName: 'mirror',
      slippageBps: 0,
    });
    const table = formatTable(report);
    expect(table).toMatch(/realized pnl\s+0\.00013 SOL/);
    expect(table).toMatch(/ledger reconciles clean\s+yes/);
  });
});

// ---------------------------------------------------------------------------
// The two halves fit together
// ---------------------------------------------------------------------------

describe('a session the RECORDER wrote is one the HARNESS can read', () => {
  it('round-trips every kind through the real writer and the real loader', async () => {
    // The builder in `synthetic.ts` writes the format by hand, which is exactly
    // how a format drifts: the producer and the consumer agree with the test
    // fixture and not with each other. This uses `SessionRecorder` itself.
    const dir = tempDir();
    let clock = T0;
    const recorder = new SessionRecorder({ directory: dir, now: () => (clock += 1_000) });

    try {
      recorder.attach(
        Object.assign(new EventEmitter(), {}) as never,
      );
      recorder.write('screen', {
        mint: MINT_A,
        sizeSol: 0.05,
        verdict: 'pass',
        failedChecks: [],
        unknownChecks: [],
      });
      await recorder
        .wrapQuotes({ getQuote: async (request) => quoteOf(request, 1_000_000_000n) })
        .getQuote({
          inMint: WRAPPED_SOL_MINT,
          outMint: MINT_A,
          inAmount: BUY_LAMPORTS,
          slippageBps: 300,
        });
      recorder.write('swap', encodeSwap(swapOf()));
      await recorder
        .wrapDriver({
          onTrackedSwap: async (_swap: TrackedSwap) => undefined,
          onPriceTick: async (_position: Position, _priceSol: number) => undefined,
        })
        .onPriceTick(
          { mint: MINT_A, tokens: 1_000_000_000n, decimals: DECIMALS } as Position,
          0.00005,
        );
      const path = recorder.path;
      await recorder.close();

      const session = parseSession(readFileSync(path, 'utf8'), 'roundtrip');
      expect(session.lines.map((line) => line.kind)).toEqual([
        'screen',
        'quote',
        'swap',
        'price-tick',
      ]);
      expect(session.screens.get(MINT_A)?.verdict).toBe('pass');
      expect(
        session.quotes.get(
          quoteKey({ inMint: WRAPPED_SOL_MINT, outMint: MINT_A, inAmount: BUY_LAMPORTS }),
        )?.quote?.outAmount,
      ).toBe('1000000000');
      // The swap survived the bigint round trip.
      const swap = session.drivable.find((entry) => entry.kind === 'swap');
      expect(swap?.kind === 'swap' && swap.swap.solAmount).toBe(410_000_000n);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a REAL recorded file, truncated mid-line, still replays', async () => {
    // Not a hand-built fragment: written by `SessionRecorder`, then cut at a
    // byte offset inside its last line, which is what a SIGKILL does.
    const dir = tempDir();
    let clock = T0;
    const recorder = new SessionRecorder({ directory: dir, now: () => (clock += 1_000) });
    try {
      for (const raw of buildSyntheticSession().trim().split('\n')) {
        const parsed = JSON.parse(raw) as { kind: SessionKind; payload: unknown };
        recorder.write(parsed.kind, parsed.payload);
      }
      const path = recorder.path;
      await recorder.close();

      const intact = readFileSync(path, 'utf8');
      const cut = intact.slice(0, intact.length - 40);
      expect(cut.endsWith('\n')).toBe(false);
      writeFileSync(path, cut);

      const session = parseSession(readFileSync(path, 'utf8'), 'truncated');
      expect(session.truncatedTail).not.toBeNull();
      // And it is still a replayable session, not merely a readable one.
      const { report } = await replaySession({
        session,
        sessionLabel: 'truncated',
        strategyName: 'mirror',
        slippageBps: 0,
      });
      expect(report.ledgerReconcilesClean).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the committed fixture still replays, so it cannot rot unnoticed', async () => {
    const path = join(import.meta.dirname, 'replay/fixtures/synthetic-mirror.jsonl');
    const { report } = await replaySession({
      session: parseSession(readFileSync(path, 'utf8'), 'fixture'),
      sessionLabel: 'fixture',
      strategyName: 'mirror',
      slippageBps: 0,
    });
    expect(report.realizedPnlLamports).toBe('130000');
    expect(report.noRouteWhileHeld).toEqual([MINT_B]);
    expect(report.ledgerReconcilesClean).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('same session + same strategy + same config = byte-identical', () => {
  async function serialize(): Promise<string> {
    const { report } = await replaySession({
      session: parseSession(buildSyntheticSession({ includeNoRoute: true }), 'synthetic'),
      sessionLabel: 'synthetic',
      strategyName: 'mirror',
      slippageBps: 30,
    });
    return `${JSON.stringify(report, null, 2)}\n`;
  }

  it('two runs produce identical bytes', async () => {
    const first = await serialize();
    const second = await serialize();
    expect(second).toBe(first);
  });

  it('proves it by diffing two files on disk', async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'a.json'), await serialize());
      writeFileSync(join(dir, 'b.json'), await serialize());
      const a = readFileSync(join(dir, 'a.json'));
      const b = readFileSync(join(dir, 'b.json'));
      // Byte-for-byte, not deep-equal: a deep-equal would pass on two objects
      // whose keys serialize in a different order.
      expect(Buffer.compare(a, b)).toBe(0);
      expect(a.length).toBeGreaterThan(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a different slippage produces a DIFFERENT file, so the check is not vacuous', async () => {
    const { report } = await replaySession({
      session: parseSession(buildSyntheticSession({ includeNoRoute: true }), 'synthetic'),
      sessionLabel: 'synthetic',
      strategyName: 'mirror',
      slippageBps: 250,
    });
    expect(`${JSON.stringify(report, null, 2)}\n`).not.toBe(await serialize());
  });
});

// ---------------------------------------------------------------------------
// Quote and screen misses
// ---------------------------------------------------------------------------

describe('a missing input is a hard error, never a synthesized answer', () => {
  it('names the miss when a quote is absent', async () => {
    // A session with the screen and the entry quote, but no exit quote.
    const trimmed = buildSyntheticSession()
      .split('\n')
      .filter((line) => !line.includes(`"inMint":"${MINT_A}"`))
      .join('\n');
    // Re-number so the gap check does not fire first.
    const renumbered = trimmed
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line, index) => JSON.stringify({ ...JSON.parse(line), seq: index + 1 }))
      .join('\n');

    await expect(
      replaySession({
        session: parseSession(`${renumbered}\n`, 'trimmed'),
        sessionLabel: 'trimmed',
        strategyName: 'mirror',
        slippageBps: 0,
      }),
    ).rejects.toThrow(/QUOTE MISS/);
  });

  it('names the miss when a screen verdict is absent', async () => {
    const withoutScreen = buildSyntheticSession()
      .split('\n')
      .filter((line) => line.trim().length > 0 && !line.includes('"kind":"screen"'))
      .map((line, index) => JSON.stringify({ ...JSON.parse(line), seq: index + 1 }))
      .join('\n');

    await expect(
      replaySession({
        session: parseSession(`${withoutScreen}\n`, 'no-screen'),
        sessionLabel: 'no-screen',
        strategyName: 'mirror',
        slippageBps: 0,
      }),
    ).rejects.toThrow(/SCREEN MISS/);
  });
});

// ---------------------------------------------------------------------------
// Slippage sensitivity
// ---------------------------------------------------------------------------

describe('slippage sensitivity', () => {
  it('runs the whole ladder and reports PnL at each point', async () => {
    const sweep = await sweepSlippage({
      session: parseSession(buildSyntheticSession(), 'synthetic'),
      sessionLabel: 'synthetic',
      strategyName: 'mirror',
    });

    expect(sweep.reports.map((report) => report.parameters.paperLatencyPenaltyBps)).toEqual([
      ...SLIPPAGE_SWEEP,
    ]);
    expect(sweep.unreplayable).toEqual([]);
    // The penalty applies to BOTH legs, so it compounds: a buy receives fewer
    // tokens AND the exit for those fewer tokens is discounted again. At 100
    // bps that is 49,299,030 out against a 50,085,000 basis and an 85,000 exit
    // fee. Measured, not derived by hand — the hand version forgot the second
    // leg and was out by a factor of 1.7.
    expect(sweep.reports.map((report) => report.realizedPnlLamports)).toEqual([
      '130000',
      '-171348',
      '-870970',
      '-2353563',
    ]);
  });

  it('SAYS SO IN THE SUMMARY when the edge is smaller than the guess', async () => {
    const sweep = await sweepSlippage({
      session: parseSession(buildSyntheticSession(), 'synthetic'),
      sessionLabel: 'synthetic',
      strategyName: 'mirror',
    });
    // Not a footnote. A strategy that only works below the default latency
    // penalty is a bet on that penalty being generous.
    expect(sweep.verdict).toMatch(/^PROFITABLE ONLY AT OR BELOW 0 bps/);
    expect(sweep.verdict).toMatch(/turns negative by 30 bps/);
    expect(sweep.verdict).toMatch(/is a guess/);
  });

  it('reports a ladder point the session cannot answer for, instead of guessing', async () => {
    // A session recorded at 30 bps holds the exit size THAT run asked for and
    // no other. Replaying it at 0 bps asks for a size that was never quoted.
    const narrow = buildSyntheticSession({ ladder: [30] });
    const sweep = await sweepSlippage({
      session: parseSession(narrow, 'narrow'),
      sessionLabel: 'narrow',
      strategyName: 'mirror',
    });

    expect(sweep.reports.map((report) => report.parameters.paperLatencyPenaltyBps)).toEqual([30]);
    expect(sweep.unreplayable.map((miss) => miss.bps)).toEqual([0, 100, 250]);
    for (const miss of sweep.unreplayable) expect(miss.reason).toMatch(/QUOTE MISS/);
  });

  it('an invariant violation is never swallowed by the sweep', () => {
    // Only a missing input is tolerated. The harness exists to be loud.
    expect(slippageVerdict([])).toBe('UNPROFITABLE AT EVERY SLIPPAGE TESTED');
    expect(slippageVerdict([{ bps: 0, pnl: 1n }])).toBe('profitable at every slippage tested');
  });
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

describe('invariants abort, with the seq and the offending fill', () => {
  function freshLedger() {
    return openLedger({
      path: ':memory:',
      logger: { info: () => undefined, warn: () => undefined },
    });
  }

  it('1. aborts the moment a running token total would go negative', () => {
    const ledger = freshLedger();
    try {
      const checker = new InvariantChecker(ledger);
      checker.applyRecordedFill(1, OVERSELL_FILLS[0]);

      let thrown: InvariantViolation | undefined;
      try {
        checker.applyRecordedFill(2, OVERSELL_FILLS[1]);
      } catch (cause) {
        thrown = cause as InvariantViolation;
      }

      expect(thrown).toBeInstanceOf(InvariantViolation);
      expect(thrown?.invariant).toBe(1);
      // Not a summary at the end: the seq and the fill that caused it.
      expect(thrown?.seq).toBe(2);
      expect(thrown?.detail).toMatchObject({
        mint: MINT_A,
        intentId: 'garbage',
        heldBefore: '1000000000',
        tokensDelta: '-999999999999',
        wouldLeave: '-998999999999',
      });
    } finally {
      ledger.close();
    }
  });

  it('2. aborts on a fill whose intent row is missing', () => {
    const ledger = freshLedger();
    try {
      const checker = new InvariantChecker(ledger);
      expect(() =>
        checker.afterFill(7, {
          intentId: 'ghost',
          side: 'buy',
          mint: MINT_A,
          tokensDelta: 1n,
          lamportsDelta: -1n,
          feesLamports: 0n,
          decimals: DECIMALS,
          slippageBps: 0,
          simulated: true,
          at: T0,
        }),
      ).toThrow(/INVARIANT 2 VIOLATED at seq 7/);
    } finally {
      ledger.close();
    }
  });

  it('2. aborts on a fill whose intent is still pending', () => {
    const ledger = freshLedger();
    try {
      const checker = new InvariantChecker(ledger);
      const intent: OrderIntent = {
        id: 'pending-one',
        side: 'buy',
        mint: MINT_A,
        amountLamports: 1n,
        maxSlippageBps: 300,
        reason: 'r',
      };
      ledger.recordIntent(intent, T0);
      expect(() =>
        checker.afterFill(9, {
          intentId: 'pending-one',
          side: 'buy',
          mint: MINT_A,
          tokensDelta: 1n,
          lamportsDelta: -1n,
          feesLamports: 0n,
          decimals: DECIMALS,
          slippageBps: 0,
          simulated: true,
          at: T0,
        }),
      ).toThrow(/still pending/);
    } finally {
      ledger.close();
    }
  });

  it('3. catches an oversell BEFORE the clamp can absorb it', () => {
    const ledger = freshLedger();
    try {
      const checker = new InvariantChecker(ledger);
      checker.applyRecordedFill(1, OVERSELL_FILLS[0]);

      let thrown: InvariantViolation | undefined;
      try {
        checker.beforeSell(4, MINT_A, 999_999_999_999n);
      } catch (cause) {
        thrown = cause as InvariantViolation;
      }

      expect(thrown?.invariant).toBe(3);
      expect(thrown?.seq).toBe(4);
      expect(thrown?.detail).toMatchObject({
        requested: '999999999999',
        held: '1000000000',
        excess: '998999999999',
      });
      expect(thrown?.message).toMatch(/the clamp would have hidden this/);
    } finally {
      ledger.close();
    }
  });

  it('a well-formed sell passes all three', async () => {
    const { report } = await replaySession({
      session: parseSession(buildSyntheticSession(), 'synthetic'),
      sessionLabel: 'synthetic',
      strategyName: 'mirror',
      slippageBps: 0,
    });
    expect(report.trades.roundTrips).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The 2026-08-03 regression
// ---------------------------------------------------------------------------

/** A strategy that emits whatever the test hands it. Used to force garbage in. */
function emitting(draft: IntentDraft | null): Strategy {
  return {
    name: 'mirror',
    onTrackedSwap: async (_swap: TrackedSwap, _ctx: Context) => draft,
    onPriceTick: async () => null,
  };
}

describe('regression: the 2026-08-03 oversell', () => {
  it('THE HARNESS WOULD HAVE CAUGHT IT — invariant 1, at the offending seq', () => {
    // The fill sequence exactly as the ledger held it that day. The position
    // read zero because `replayMint` clamps `sold`, so every end-of-run check
    // agreed while the fill row asserted a sale of a thousand times the
    // holding. This is why the harness checks at each step and not at the end.
    const ledger = openLedger({
      path: ':memory:',
      logger: { info: () => undefined, warn: () => undefined },
    });
    try {
      const checker = new InvariantChecker(ledger);
      checker.applyRecordedFill(OVERSELL_FILLS[0].seq, OVERSELL_FILLS[0]);
      expect(() => checker.applyRecordedFill(OVERSELL_FILLS[1].seq, OVERSELL_FILLS[1])).toThrow(
        InvariantViolation,
      );
    } finally {
      ledger.close();
    }
  });

  it('CURRENT GUARDS CLAMP the oversell — they do not reject it', async () => {
    // Stated plainly because the brief for this prompt expected
    // MALFORMED_INTENT here. Handoff 11 made the opposite decision on purpose:
    // an exit for more than is held is the one malformed-looking case that must
    // still execute, because refusing it strands exactly the holder whose
    // ledger and chain already disagree. The harness catches the CONDITION
    // (invariant 3); the guard layer clamps and fills.
    const oversell: IntentDraft = {
      side: 'sell',
      mint: MINT_A,
      amountTokens: 999_999_999_999n,
      maxSlippageBps: 300,
      reason: 'oversell',
    };
    expect(malformedIntentReason({ ...oversell, id: 'x' })).toBeNull();

    await expect(
      replaySession({
        session: parseSession(buildSyntheticSession(), 'synthetic'),
        sessionLabel: 'synthetic',
        strategyName: 'mirror',
        slippageBps: 0,
        strategyOverride: emitting(oversell),
      }),
    ).rejects.toThrow(/INVARIANT 3 VIOLATED/);
  });

  it('a genuinely malformed sell IS rejected as MALFORMED_INTENT, before the broker', async () => {
    const malformed: IntentDraft = {
      side: 'sell',
      mint: MINT_A,
      amountTokens: Number.NaN as unknown as bigint,
      maxSlippageBps: 300,
      reason: 'NaN sell',
    };
    expect(malformedIntentReason({ ...malformed, id: 'x' })).toMatch(/must be an exact bigint/);

    const { report } = await replaySession({
      session: parseSession(buildSyntheticSession(), 'synthetic'),
      sessionLabel: 'synthetic',
      strategyName: 'mirror',
      slippageBps: 0,
      strategyOverride: emitting(malformed),
    });

    // It never reached the broker: no fill, and the refusal is counted by code.
    expect(report.trades).toEqual({ buys: 0, sells: 0, roundTrips: 0 });
    expect(report.malformedIntentCount).toBeGreaterThan(0);
    expect(report.guardRejections['MALFORMED_INTENT']).toBe(report.malformedIntentCount);
    expect(report.ledgerReconcilesClean).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

describe('report', () => {
  it('sorts every map, so key order cannot drift between runs', () => {
    const report = buildReport({
      sessionLabel: 's',
      sessionLines: 1,
      strategy: 'mirror',
      paperLatencyPenaltyBps: 30,
      positionSizeSol: 0.05,
      paperStartingSol: 5,
      fills: [],
      rejections: ['NOT_RUNNING', 'ALREADY_HOLDING', 'MALFORMED_INTENT', 'ALREADY_HOLDING'],
      noRouteWhileHeld: ['ZZZ', 'AAA'],
      finalBalanceLamports: 5_000_000_000n,
      ledgerReconcilesClean: true,
    });

    expect(Object.keys(report.guardRejections)).toEqual([
      'ALREADY_HOLDING',
      'MALFORMED_INTENT',
      'NOT_RUNNING',
    ]);
    expect(report.guardRejections['ALREADY_HOLDING']).toBe(2);
    expect(report.malformedIntentCount).toBe(1);
    expect(report.noRouteWhileHeld).toEqual(['AAA', 'ZZZ']);
  });

  it('buckets time-to-exit with fixed edges', () => {
    const buy = (at: number, mint: string) => ({
      mint,
      intentId: `b-${mint}`,
      side: 'buy' as const,
      tokensDelta: 1_000n,
      lamportsDelta: -1_000n,
      feesLamports: 0n,
      at,
    });
    const sell = (at: number, mint: string, out: bigint) => ({
      mint,
      intentId: `s-${mint}`,
      side: 'sell' as const,
      tokensDelta: -1_000n,
      lamportsDelta: out,
      feesLamports: 0n,
      at,
    });

    const report = buildReport({
      sessionLabel: 's',
      sessionLines: 1,
      strategy: 'mirror',
      paperLatencyPenaltyBps: 0,
      positionSizeSol: 0.05,
      paperStartingSol: 5,
      fills: [
        buy(0, 'A'),
        sell(5_000, 'A', 2_000n),
        buy(0, 'B'),
        sell(120_000, 'B', 500n),
        buy(0, 'C'),
        sell(3_600_000, 'C', 1_000n),
      ],
      rejections: [],
      noRouteWhileHeld: [],
      finalBalanceLamports: 0n,
      ledgerReconcilesClean: true,
    });

    expect(report.timeToExitMs).toEqual({
      count: 3,
      minMs: 5_000,
      medianMs: 120_000,
      maxMs: 3_600_000,
      buckets: { '0-10s': 1, '1-5m': 1, '10-60s': 0, '30m+': 1, '5-30m': 0 },
    });
    // One win, one loss, one flat — and the rate as integer bps, not a float.
    expect(report.winRate).toEqual({ wins: 1, losses: 1, flat: 1, bps: 3_333 });
  });

  it('measures drawdown as peak-to-trough of cumulative realized P&L', () => {
    const trade = (mint: string, at: number, out: bigint) => [
      {
        mint,
        intentId: `b-${mint}`,
        side: 'buy' as const,
        tokensDelta: 1_000n,
        lamportsDelta: -1_000n,
        feesLamports: 0n,
        at,
      },
      {
        mint,
        intentId: `s-${mint}`,
        side: 'sell' as const,
        tokensDelta: -1_000n,
        lamportsDelta: out,
        feesLamports: 0n,
        at: at + 1,
      },
    ];

    const report = buildReport({
      sessionLabel: 's',
      sessionLines: 1,
      strategy: 'mirror',
      paperLatencyPenaltyBps: 0,
      positionSizeSol: 0.05,
      paperStartingSol: 5,
      // +2000, then -900, then -900: peak 2000, trough 200, drawdown 1800.
      fills: [...trade('A', 0, 3_000n), ...trade('B', 10, 100n), ...trade('C', 20, 100n)],
      rejections: [],
      noRouteWhileHeld: [],
      finalBalanceLamports: 0n,
      ledgerReconcilesClean: true,
    });

    expect(report.realizedPnlLamports).toBe('200');
    expect(report.maxDrawdownLamports).toBe('1800');
  });
});

// ---------------------------------------------------------------------------
// Provenance survives a recording round trip
// ---------------------------------------------------------------------------

describe('signal provenance in recorded sessions', () => {
  it('round-trips source and observedAt', () => {
    const swap = swapOf({ source: 'gapfill', observedAt: 1_700_000_123_000 });
    expect(decodeSwap(encodeSwap(swap))).toEqual(swap);
  });

  /**
   * The archive-compatibility case, and the reason `SwapPayload` makes these
   * two fields optional while `TrackedSwap` requires them.
   *
   * Two real session files on this machine were recorded before provenance
   * existed. A recording format that invalidated its own archive on every
   * schema addition would not be an archive, so an old payload must still
   * decode — fail-closed, matching `parseSwap`'s unstamped defaults.
   */
  it('decodes a payload recorded before provenance existed', () => {
    const legacy = encodeSwap(swapOf());
    delete (legacy as { source?: unknown }).source;
    delete (legacy as { observedAt?: unknown }).observedAt;

    const decoded = decodeSwap(legacy);
    expect(decoded.source).toBe('gapfill');
    expect(decoded.observedAt).toBe(0);
    // Everything the old format did carry is untouched.
    expect(decoded.signature).toBe(swapOf().signature);
    expect(decoded.solAmount).toBe(swapOf().solAmount);
  });
});
