# Source — strategy and entry points

> Generated from commit `0a078be` (feat: refuse a wallet we cannot copy, where the decision is made) on 2026-08-11.
> Regenerate with `npx tsx scripts/bundle-for-claude.ts`. Do not edit by hand.

The only strategy that exists, and how a soak is actually launched.

## Files in this bundle

- `src/strategies/mirror.ts`
- `src/cli/soak.ts`
- `src/cli/orphans.ts`

---

## `src/strategies/mirror.ts`

```typescript
/**
 * MirrorStrategy — copy the tracked wallets, exit on a fixed band.
 *
 * Entries mirror somebody else. Exits do not: a tracked wallet's sell is one
 * exit trigger, and a hard stop / take-profit band is the other, because a
 * wallet that stops trading (or that we stop seeing, at `confirmed` commitment,
 * over a websocket that can drop) must not mean we hold forever.
 *
 * ── PURITY ────────────────────────────────────────────────────────────────
 *
 * No `Date.now`, no `Math.random`, no `fetch`, no module-level mutable state.
 * `tests/strategy.test.ts` greps this directory for the first three and fails
 * on a hit. Everything time-dependent comes from `ctx.now()`. See the header of
 * `core/strategy.ts` for why: Prompt 12's replay promise is only keepable if
 * this file is a pure function of its arguments.
 *
 * ── WHY THE NO-OPS ARE EXPLICIT ───────────────────────────────────────────
 *
 * Several of the cases below would also be caught by `guards.ts` — a duplicate
 * buy is `ALREADY_HOLDING`, a sell with nothing to sell is `NO_OPEN_POSITION`.
 * Returning `null` anyway is not belt-and-braces, it is a different claim.
 *
 * A guard rejection is a *record*: it is written to `intents.rejection_code`
 * and Prompt 12 counts them by code to say how often the risk limits actually
 * bit. A strategy that knowingly emits intents it expects to be rejected fills
 * that table with self-inflicted noise, and the report stops describing the
 * market and starts describing the strategy's sloppiness. So: the strategy does
 * not emit what it already knows is wrong; the runner does not second-guess
 * what the strategy emitted.
 */

import type { Context, IntentDraft, Strategy } from '../core/strategy.js';
import type { Position, TrackedSwap } from '../core/types.js';
import { lamportsToSol, solToLamports } from '../core/units.js';

/**
 * Exit band, as a percentage move from `avgEntrySol`.
 *
 * Both bounds are **inclusive**: exactly -40.00% sells, exactly +150.00% sells.
 * A boundary that sits between the two comparisons is a boundary nobody can
 * state, and the tests pin -39.9 / -40.0 / -40.1 precisely because "at the
 * threshold" is the case a reader will assume and a mutation will flip.
 */
export const STOP_LOSS_PCT = -40;
export const TAKE_PROFIT_PCT = 150;

/**
 * A price with no exponent and no trailing zeros, for the reason string.
 *
 * `String(0.000000123)` is `"1.23e-7"`, which is unreadable in an audit log and
 * — worse — not stable to eyeball against the ledger. Fixed 9 decimal places
 * matches SOL's own scale, then trailing zeros come off.
 */
export function formatPriceSol(price: number): string {
  if (!Number.isFinite(price)) return String(price);
  const fixed = price.toFixed(9);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/** `7xKXtg2C...q2` -> `7xKX..q2`, so a reason line stays readable. */
export function shortAddress(address: string): string {
  return address.length <= 8 ? address : `${address.slice(0, 4)}..${address.slice(-2)}`;
}

/** Signed percentage, one decimal place, always carrying its sign. */
function signedPct(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

/**
 * A position counts as held while it has tokens and is not closed.
 *
 * There is no third state to consider. `PositionState.closing` was deleted on
 * 2026-08-03 — nothing had ever produced it, and it could not be produced
 * without the positions table asserting something the fills do not say.
 *
 * What actually stops a mint being bought back while it is being sold is the
 * guard layer: `sellsInFlight` for the exit (`SELL_IN_FLIGHT`) and
 * `buysInFlight` for the entry (`ALREADY_HOLDING`), both claimed synchronously
 * before any await. A strategy reading a persisted flag could not have been as
 * strong, because the flag would be stale by the time it was read.
 */
function heldPosition(ctx: Context, mint: string): Position | undefined {
  return ctx.positions.find(
    (position) => position.mint === mint && position.state !== 'closed' && position.tokens > 0n,
  );
}

export function createMirrorStrategy(): Strategy {
  return {
    name: 'mirror',

    async onTrackedSwap(swap: TrackedSwap, ctx: Context): Promise<IntentDraft | null> {
      const held = heldPosition(ctx, swap.mint);

      if (swap.side === 'buy') {
        // Already holding it. A second tracked wallet buying the same mint is
        // not a second signal worth acting on — it is the same position.
        if (held !== undefined) return null;

        // ── NO AGE CHECK HERE, DELIBERATELY ─────────────────────────────────
        //
        // A stale swap — a reconnect backlog, a cold-cursor gap fill — must not
        // become a position, and it does not: `guards.ts` refuses it as
        // STALE_SIGNAL on `signalAgeMs`, which `StrategyRunner` stamps from
        // `blockTime` and which a strategy cannot forge.
        //
        // Filtering it *here too* is the obvious instinct and is still wrong,
        // because it would make the filtering invisible. No intent would be
        // created, so no row would reach `intents.rejection_code`, so the
        // STALE_SIGNAL counter would read zero forever — while the bot quietly
        // declined to trade. The only evidence would be a debug line. "How much
        // signal are we dropping as stale, and is the window right?" has to be
        // answerable from the ledger.
        //
        // Same reasoning as the no-ops above, pointed the other way. Those
        // return `null` because the strategy KNOWS the intent is invalid and a
        // self-inflicted rejection is noise. Here it does not know: whether 14s
        // is stale is `maxSignalAgeMs`'s call, that is a risk limit, and a risk
        // limit biting is a measurement rather than noise.

        return {
          side: 'buy',
          mint: swap.mint,
          amountLamports: solToLamports(ctx.config.positionSizeSol),
          maxSlippageBps: ctx.config.maxSlippageBps,
          reason: `mirror: ${shortAddress(swap.wallet)} bought ${formatPriceSol(
            lamportsToSol(swap.solAmount),
          )} SOL`,
        };
      }

      // A tracked wallet sold something we never held. Nothing to mirror — and
      // emitting a sell here would be `NO_OPEN_POSITION`, self-inflicted.
      if (held === undefined) return null;

      // They sold some fraction; we sell all of it. Mirroring the fraction
      // would leave a remainder that occupies a concurrency slot and still has
      // to be exited later, on a signal that may never come.
      return {
        side: 'sell',
        mint: swap.mint,
        amountTokens: held.tokens,
        maxSlippageBps: ctx.config.maxSlippageBps,
        reason: `mirror: ${shortAddress(swap.wallet)} sold ${formatPriceSol(
          lamportsToSol(swap.solAmount),
        )} SOL`,
      };
    },

    async onPriceTick(
      position: Position,
      priceSol: number,
      ctx: Context,
    ): Promise<IntentDraft | null> {
      // Nothing to sell. A concurrent exit is the guard layer's problem, not
      // this one's — `SELL_IN_FLIGHT` is claimed synchronously and a strategy
      // cannot beat it.
      if (position.state !== 'open' || position.tokens <= 0n) return null;

      // No usable price. **Hold — do not panic-sell.** A missing or nonsensical
      // price is a fact about our data, not about the token, and selling on it
      // converts a plumbing failure into a realized loss. A genuinely
      // unroutable position is already surfaced by the tracker's `route-lost`
      // latch, which is an alert for a human, not a signal for a strategy.
      if (!Number.isFinite(priceSol) || priceSol <= 0) return null;

      const entry = position.avgEntrySol;
      if (!Number.isFinite(entry) || entry <= 0) return null;

      const changePct = ((priceSol - entry) / entry) * 100;

      // Inclusive on both bounds; see STOP_LOSS_PCT.
      const trigger =
        changePct <= STOP_LOSS_PCT ? 'stop' : changePct >= TAKE_PROFIT_PCT ? 'take' : null;
      if (trigger === null) return null;

      ctx.log.info(
        { mint: position.mint, trigger, changePct, entry, priceSol, at: ctx.now() },
        `${trigger} triggered on ${position.mint}`,
      );

      return {
        side: 'sell',
        mint: position.mint,
        amountTokens: position.tokens,
        maxSlippageBps: ctx.config.maxSlippageBps,
        reason: `${trigger}: ${signedPct(changePct)} from ${formatPriceSol(entry)}`,
      };
    },
  };
}
```

---

## `src/cli/soak.ts`

```typescript
/**
 * `npm run soak -- --hours=24` — run the tracker in paper mode and report.
 *
 * A digest is written hourly and at exit, to `--digest-dir` (default
 * `./sessions/digests`). It is also printed, because the common case is an
 * operator watching a terminal for the first ten minutes and then walking away.
 *
 * Exits non-zero when the digest has findings. A soak that ends green is a
 * claim; a soak that ends red is the point of running one.
 *
 * ── WHAT THIS NEEDS THAT THIS CHECKOUT DOES NOT HAVE ──────────────────────
 *
 * `RPC_HTTP_URL` and `RPC_WSS_URL`, and at least one entry in
 * `trackedWallets`. There is no `.env` here and no credentials, so this runner
 * has never been executed against a live RPC — see `docs/handoffs/13-soak.md`,
 * which says so rather than implying otherwise.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import pino from 'pino';
import { loadConfig } from '../core/config.js';
import { createTrackerRuntime } from '../services/tracker.js';
import type { TrackerEventRecord, TrackerLogger } from '../services/tracker.js';
import { LedgerLostError } from '../services/ledgerDurability.js';
import { SoakDigest, formatDigest } from '../services/soak.js';
import { solToLamports } from '../core/units.js';

loadEnv();

const HOUR_MS = 3_600_000;

interface Args {
  hours: number;
  digestDir: string;
  configPath: string;
  dbPath: string;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  for (const token of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(token);
    if (match !== null) flags.set(match[1]!, match[2]!);
    else if (token.startsWith('--')) flags.set(token.slice(2), 'true');
  }
  const hours = Number(flags.get('hours') ?? '24');
  if (!Number.isFinite(hours) || hours <= 0) {
    console.error('usage: npm run soak -- --hours=24 [--digest-dir=./sessions/digests]');
    process.exit(2);
  }
  return {
    hours,
    digestDir: flags.get('digest-dir') ?? './sessions/digests',
    configPath: flags.get('config') ?? 'config.json',
    dbPath: flags.get('db') ?? './data/tracker.db',
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    console.error(
      `${name} is not set. A soak runs against a live RPC in PAPER mode; it needs an endpoint.\n` +
        'Copy .env.example to .env and fill it in.',
    );
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.digestDir, { recursive: true });

  const logger: TrackerLogger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' }) as never;
  const config = loadConfig(args.configPath);

  if (config.trackedWallets.length === 0) {
    logger.warn(
      {},
      'trackedWallets is empty — this soak will observe nothing. That is a valid smoke run ' +
        'for the plumbing and a useless one for the strategy.',
    );
  }

  let runtime: ReturnType<typeof createTrackerRuntime>;
  try {
    runtime = createTrackerRuntime({
      config,
      dbPath: args.dbPath,
      rpcHttpUrl: required('RPC_HTTP_URL'),
      rpcWssUrl: required('RPC_WSS_URL'),
      ...(process.env['JUPITER_API_KEY'] === undefined
        ? {}
        : { jupiterApiKey: process.env['JUPITER_API_KEY'] }),
      logger,
      recordSessions: true,
    });
  } catch (cause) {
    // The message IS the remedy — it names the snapshot directory and the
    // override. A stack trace above it buries the one part anybody needs.
    if (cause instanceof LedgerLostError) {
      console.error(`\n${cause.message}\n`);
      process.exit(2);
    }
    throw cause;
  }

  const startedAt = Date.now();

  /**
   * Last net flow read while the ledger connection was open.
   *
   * `finish()` closes the runtime BEFORE the final digest, deliberately, so the
   * recorder's counters are final and the session on disk is complete. But the
   * digest also reads one number out of the ledger, and reading a closed
   * `better-sqlite3` handle throws — so every soak this repo has ever run died
   * with `TypeError: The database connection is not open` at the moment it was
   * supposed to print its findings, and `sessions/digests/` has never contained
   * a `final-*` file. The hourly digests worked, which is what hid it.
   *
   * Latched rather than reordered: moving the close after the digest would undo
   * the guarantee the close ordering exists for.
   */
  let lastNetFlowLamports = 0n;
  let ledgerOpen = true;
  /**
   * The recorder's counters, latched for the same reason the ledger's are.
   *
   * The final digest is taken while the tracker is shutting down, so
   * `tracker.session` is already gone and `?? 0` reported ZERO: the 2026-08-09
   * soak wrote 71,891 lines with 66,395 unmodeled events, and its final digest
   * said `written: 0, unmodeled: 0`. Not a cosmetic slip — `unmodeledTotal` is
   * one of the digest's four zero-threshold findings, so reading 0 meant that
   * alarm COULD NOT FIRE on a final digest, which is the only one anybody reads.
   *
   * `?? 0` over an absent source is the defect. Absence is not a measurement of
   * zero, and the last value actually observed is the honest answer.
   */
  let lastRecorderStats = {
    written: 0,
    dropped: 0,
    droppedByKind: new Map<string, number>(),
    rotations: 0,
    unmodeled: 0,
  };

  const digest = new SoakDigest({
    startedAt,
    startingLamports: solToLamports(config.paperStartingSol),
    ledgerNetFlowLamports: () => {
      if (!ledgerOpen) return lastNetFlowLamports;
      lastNetFlowLamports = runtime.ledger.getNetLamportsFlow({ simulated: true });
      return lastNetFlowLamports;
    },
    barrierStats: () => runtime.cursors.barrierStats(),
    recorderStats: () => {
      const session = runtime.tracker.session;
      if (session !== undefined) {
        lastRecorderStats = {
          written: session.stats.written,
          dropped: session.stats.dropped,
          droppedByKind: session.stats.droppedByKind,
          rotations: session.stats.rotations,
          unmodeled: session.stats.unmodeled,
        };
      }
      return lastRecorderStats;
    },
  });

  runtime.tracker.on('event', (record: TrackerEventRecord) => {
    digest.observe(record.type, record.data);
  });

  let index = 0;
  const emit = (label: string): number => {
    const snapshot = digest.snapshot(Date.now());
    const path = join(args.digestDir, `digest-${String(index).padStart(3, '0')}-${label}.json`);
    // Stable key order and no wall-clock beyond the window, so two digests from
    // equivalent runs can be diffed.
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
    index += 1;
    console.log(`\n── soak digest (${label}) ${'─'.repeat(30)}`);
    console.log(formatDigest(snapshot));
    console.log(`  written to ${path}\n`);
    return snapshot.findings.length;
  };

  const hourly = setInterval(() => emit('hourly'), HOUR_MS);
  const deadline = setTimeout(() => void finish('deadline'), args.hours * HOUR_MS);

  let finishing = false;
  async function finish(reason: string): Promise<void> {
    if (finishing) return;
    finishing = true;
    clearInterval(hourly);
    clearTimeout(deadline);
    logger.info({ reason }, `soak ending: ${reason}`);
    // Closed BEFORE the final digest, so the recorder's counters are final and
    // the session on disk is complete. The one ledger-derived number the digest
    // needs is latched first — see `lastNetFlowLamports`.
    lastNetFlowLamports = runtime.ledger.getNetLamportsFlow({ simulated: true });
    ledgerOpen = false;
    await runtime.close();
    const findings = emit(`final-${reason}`);
    process.exit(findings === 0 ? 0 : 1);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void finish(signal));
  }

  await runtime.tracker.start();
  logger.info(
    { hours: args.hours, wallets: config.trackedWallets.length, strategy: config.strategy },
    `soak started for ${args.hours}h`,
  );
}

await main();
```

---

## `src/cli/orphans.ts`

```typescript
/**
 * `npm run orphans` — the operator tool for crash orphans.
 *
 * A crash orphan is an intent that was pending when the process died, with no
 * fill on disk. The bot may or may not be holding what it was buying; the
 * database cannot tell. Until every orphan is signed off, the guard layer
 * refuses all new entries.
 *
 * This is the only supported way to lift that gate. There is deliberately no
 * clear-all: each orphan is a separate unknown and gets looked at on its own.
 *
 * Usage:
 *   npm run orphans                        list unacknowledged orphans
 *   npm run orphans -- list [--db <path>]
 *   npm run orphans -- ack <intent-id> --operator <name> --resolution <kind>
 *
 *   Resolutions:
 *     no-tx-on-chain   checked the chain; the transaction never landed
 *     manually-closed  the holding was dealt with by hand, outside the bot
 *     tx-confirmed     the transaction confirmed — requires the fill data,
 *                      which is recorded so the position lands on the books.
 *                      Missing values are prompted for.
 *
 *   tx-confirmed flags: --signature --tokens-delta --sol-delta --fees-sol --at
 */

import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import pino from 'pino';
import { baseUnitsToTokens, lamportsToSol } from '../core/units.js';
import { AcknowledgementError, openLedger } from '../db/ledger.js';
import type {
  ConfirmedFillData,
  Ledger,
  LedgerLogger,
  OrphanResolution,
  OrphanResolutionKind,
  OrphanedIntent,
} from '../db/ledger.js';

const DEFAULT_DB = './data/tracker.db';

const RESOLUTIONS: readonly OrphanResolutionKind[] = [
  'no-tx-on-chain',
  'manually-closed',
  'tx-confirmed',
];

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token.startsWith('--')) {
      const next = argv[index + 1];
      // `--flag value`, or `--flag` alone for booleans.
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(token.slice(2), next);
        index += 1;
      } else {
        flags.set(token.slice(2), 'true');
      }
    } else {
      positional.push(token);
    }
  }

  return { command: positional[0] ?? 'list', positional: positional.slice(1), flags };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Compact age, e.g. `3d 4h`, `12m`, `<1m`. */
function formatAge(ms: number): string {
  if (ms < 60_000) return '<1m';
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/**
 * Intended size, rendered for a human.
 *
 * A buy is lamports and converts cleanly to SOL. A sell is token base units,
 * and the intent does not record the mint's decimals — only fills do — so the
 * raw count is shown and labelled as such rather than being scaled by a guess.
 */
function formatSize(orphan: OrphanedIntent): string {
  return orphan.side === 'buy'
    ? `${lamportsToSol(orphan.amount)} SOL`
    : `${orphan.amount} base units`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function printOrphans(orphans: OrphanedIntent[], now: number): void {
  if (orphans.length === 0) {
    console.log('No unacknowledged crash orphans. Entries are not gated.');
    return;
  }

  const rows = orphans.map((orphan) => ({
    id: orphan.id,
    age: formatAge(now - orphan.createdAt),
    side: orphan.side,
    mint: orphan.mint,
    size: formatSize(orphan),
    reason: orphan.reason,
  }));

  const widths = {
    id: Math.max(2, ...rows.map((row) => row.id.length)),
    age: Math.max(3, ...rows.map((row) => row.age.length)),
    side: 4,
    mint: Math.max(4, ...rows.map((row) => row.mint.length)),
    size: Math.max(4, ...rows.map((row) => row.size.length)),
  };

  console.log(
    `${orphans.length} unacknowledged crash orphan(s). NEW ENTRIES ARE BLOCKED until each is signed off.\n`,
  );
  console.log(
    [
      pad('ID', widths.id),
      pad('AGE', widths.age),
      pad('SIDE', widths.side),
      pad('MINT', widths.mint),
      pad('INTENDED', widths.size),
      'REASON',
    ].join('  '),
  );

  for (const row of rows) {
    console.log(
      [
        pad(row.id, widths.id),
        pad(row.age, widths.age),
        pad(row.side, widths.side),
        pad(row.mint, widths.mint),
        pad(row.size, widths.size),
        row.reason,
      ].join('  '),
    );
  }

  console.log(
    '\nCheck each mint against the wallet on chain, then:\n' +
      '  npm run orphans -- ack <id> --operator <name> --resolution <no-tx-on-chain|manually-closed|tx-confirmed>',
  );
}

// ---------------------------------------------------------------------------
// Acknowledgement
// ---------------------------------------------------------------------------

function isResolutionKind(value: string): value is OrphanResolutionKind {
  return (RESOLUTIONS as readonly string[]).includes(value);
}

/** Read a required value from flags, falling back to an interactive prompt. */
async function require_(
  flags: Map<string, string>,
  flag: string,
  prompt: string,
): Promise<string> {
  const supplied = flags.get(flag);
  if (supplied !== undefined && supplied !== 'true') return supplied;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(prompt);
    return answer.trim();
  } finally {
    rl.close();
  }
}

function toNumber(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new AcknowledgementError(`${label} must be a number, got "${raw}"`);
  }
  return value;
}

/**
 * Parse an exact integer quantity.
 *
 * Deliberately strict: no decimal points, no exponents. These are base units
 * and lamports, copied from a transaction, and accepting `1.5e9` here would
 * reintroduce the rounding this representation exists to remove.
 */
function toBigInt(raw: string, label: string): bigint {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new AcknowledgementError(
      `${label} must be a whole number of base units, got "${raw}"`,
    );
  }
  return BigInt(trimmed);
}

/**
 * Gather the on-chain fill, prompting for anything not passed as a flag.
 *
 * Amounts are asked for in base units and lamports — exactly what the
 * transaction shows — rather than in tokens and SOL. Converting a human decimal
 * here would mean rounding at the one point where the operator is repairing the
 * books by hand.
 */
async function collectFill(flags: Map<string, string>): Promise<ConfirmedFillData> {
  console.log(
    '\ntx-confirmed: the transaction landed, so the fill must be recorded.\n' +
      'Take these from the confirmed transaction, not from the intent.\n' +
      'Amounts are RAW: token base units and lamports, exactly as the tx reports them.\n',
  );

  const signature = await require_(flags, 'signature', 'signature: ');
  const tokensDelta = toBigInt(
    await require_(flags, 'tokens-delta', 'tokensDelta (base units, signed, + for a buy): '),
    'tokensDelta',
  );
  const decimals = toNumber(
    await require_(flags, 'decimals', "decimals (the mint's scale, e.g. 6 or 9): "),
    'decimals',
  );
  const lamportsDelta = toBigInt(
    await require_(flags, 'lamports-delta', 'lamportsDelta (signed, - for a buy, excl. fees): '),
    'lamportsDelta',
  );
  const feesLamports = toBigInt(
    await require_(flags, 'fees-lamports', 'feesLamports: '),
    'feesLamports',
  );
  const atRaw = flags.get('at');
  const at = atRaw === undefined || atRaw === 'true' ? Date.now() : toNumber(atRaw, 'at');

  return { signature, tokensDelta, decimals, lamportsDelta, feesLamports, at };
}

async function acknowledge(ledger: Ledger, args: Args): Promise<void> {
  const id = args.positional[0];
  if (id === undefined) throw new AcknowledgementError('ack requires an intent id');

  const operator = args.flags.get('operator');
  if (operator === undefined || operator === 'true') {
    throw new AcknowledgementError('--operator <name> is required; sign-offs are attributable');
  }

  const kindRaw = args.flags.get('resolution');
  if (kindRaw === undefined || kindRaw === 'true' || !isResolutionKind(kindRaw)) {
    throw new AcknowledgementError(
      `--resolution must be one of: ${RESOLUTIONS.join(', ')}`,
    );
  }

  // Check the id before collecting anything. The ledger validates this too, but
  // discovering a typo only after typing out five fields of transaction data is
  // a good way to make an operator give up halfway through an incident.
  if (!ledger.getUnacknowledgedOrphans().some((orphan) => orphan.id === id)) {
    throw new AcknowledgementError(
      `${id} is not an unacknowledged orphan — run \`npm run orphans\` to see the list`,
    );
  }

  const resolution: OrphanResolution =
    kindRaw === 'tx-confirmed'
      ? { kind: 'tx-confirmed', fill: await collectFill(args.flags) }
      : { kind: kindRaw };

  ledger.acknowledgeOrphan(id, operator, resolution);

  console.log(`\nAcknowledged ${id} as ${kindRaw} (by ${operator}).`);

  if (resolution.kind === 'tx-confirmed') {
    const position = ledger.getPosition(ledger.getFillsForIntent(id)[0]?.mint ?? '');
    const held =
      position === undefined
        ? '0'
        : `${baseUnitsToTokens(position.tokens, position.decimals)} tokens (${position.tokens} base units)`;
    console.log(`Fill recorded. Position now: ${held} — ${position?.state ?? 'none'}.`);
  }

  const remaining = ledger.getUnacknowledgedOrphanCount();
  console.log(
    remaining === 0
      ? 'No orphans remain. Entries are no longer gated.'
      : `${remaining} orphan(s) still unacknowledged. Entries remain blocked.`,
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = args.flags.get('db') ?? process.env['LEDGER_DB'] ?? DEFAULT_DB;

  // Logs go to stderr so they never interleave with the table on stdout.
  const log = pino({ level: process.env['LOG_LEVEL'] ?? 'warn' }, pino.destination(2));
  const logger: LedgerLogger = {
    info: (fields, message) => log.info(fields, message),
    warn: (fields, message) => log.warn(fields, message),
  };

  // `openLedger` creates the file if it is missing, which is right for the bot
  // and wrong here: a mistyped path would produce an empty ledger and the
  // reassuring message "no orphans, entries are not gated". Refuse instead.
  if (!existsSync(dbPath)) {
    console.error(
      `No ledger at ${dbPath}.\n` +
        'Pass --db <path> or set LEDGER_DB. This tool never creates a database —\n' +
        'an empty one would look exactly like a clean bill of health.',
    );
    return 1;
  }

  const ledger = openLedger({ path: dbPath, logger });

  try {
    switch (args.command) {
      case 'list':
        printOrphans(ledger.getUnacknowledgedOrphans(), Date.now());
        return 0;

      case 'ack':
        await acknowledge(ledger, args);
        return 0;

      default:
        console.error(`Unknown command "${args.command}". Expected "list" or "ack".`);
        return 2;
    }
  } finally {
    ledger.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof AcknowledgementError) {
      console.error(`Refused: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    console.error(error);
    process.exitCode = 1;
  });
```
