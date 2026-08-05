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

  const runtime = createTrackerRuntime({
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

  const startedAt = Date.now();
  const digest = new SoakDigest({
    startedAt,
    startingLamports: solToLamports(config.paperStartingSol),
    ledgerNetFlowLamports: () => runtime.ledger.getNetLamportsFlow({ simulated: true }),
    recorderStats: () => {
      const session = runtime.tracker.session;
      return {
        written: session?.stats.written ?? 0,
        dropped: session?.stats.dropped ?? 0,
        droppedByKind: session?.stats.droppedByKind ?? new Map(),
        rotations: session?.stats.rotations ?? 0,
        unmodeled: session?.stats.unmodeled ?? 0,
      };
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
    // the session on disk is complete.
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
