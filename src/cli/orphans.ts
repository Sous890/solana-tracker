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
