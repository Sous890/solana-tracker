/**
 * `npm run serve` — bring the process up and put the control API on loopback.
 *
 * Deliberately boots **idle**. Starting the process and starting the bot are
 * two decisions, and conflating them means a restart for an unrelated reason —
 * a config edit, a reboot, an accidental `up` in a process manager — silently
 * resumes trading. `POST /start` is the second decision, made explicitly.
 *
 * The same applies on the way down: SIGINT and SIGTERM run `stop()`, which
 * closes the subscriptions and lets in-flight intents finish. **Neither sells.**
 * A process manager restarting the bot must not liquidate the book; that is
 * `POST /flatten`, and it takes a confirmation.
 */

import 'dotenv/config';
import { loadConfig } from '../core/config.js';
import { ConfigError } from '../core/config.js';
import { createTrackerRuntime, RuntimeConfigError } from '../services/tracker.js';
import { LedgerLostError } from '../services/ledgerDurability.js';
import { startApi } from '../services/api.js';
import { openWalletStore } from '../services/walletStore.js';
import { openAnalysisParams } from '../services/analysisParams.js';

const DEFAULT_DB = './data/tracker.db';
const DEFAULT_WALLETS = './data/wallets.json';
const DEFAULT_PARAMS_PATH = './data/analysis-params.json';
const DEFAULT_PORT = 8787;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  const configPath = process.env['CONFIG_PATH'] ?? 'config.json';

  let config;
  try {
    config = loadConfig(configPath);
  } catch (cause) {
    console.error(cause instanceof ConfigError ? cause.message : String(cause));
    process.exit(2);
  }

  // Built before the runtime, because the runtime subscribes from the array it
  // owns. Handing `WalletStream` the store's live array is what lets the
  // screener edit the watchlist and have the next `POST /start` honour it.
  const wallets = openWalletStore({
    configPath,
    walletsPath: process.env['WALLETS_PATH'] ?? DEFAULT_WALLETS,
  });

  let runtime;
  try {
    runtime = createTrackerRuntime({
      config,
      dbPath: process.env['DB_PATH'] ?? DEFAULT_DB,
      rpcHttpUrl: required('RPC_HTTP_URL'),
      rpcWssUrl: required('RPC_WSS_URL'),
      walletAddresses: wallets.liveAddresses,
      ...(process.env['JUPITER_API_KEY'] === undefined
        ? {}
        : { jupiterApiKey: process.env['JUPITER_API_KEY'] }),
    });
  } catch (cause) {
    // `LedgerLostError`'s message names the snapshot directory and the override,
    // so it is printed on its own rather than stringified into one line.
    if (cause instanceof LedgerLostError) {
      console.error(`\n${cause.message}\n`);
      process.exit(2);
    }
    console.error(cause instanceof RuntimeConfigError ? cause.message : String(cause));
    process.exit(2);
  }

  const api = await startApi({
    tracker: runtime.tracker,
    ledger: runtime.ledger,
    fills: runtime.fills,
    config: runtime.config,
    wallets,
    analysisParams: openAnalysisParams(
      process.env['ANALYSIS_PARAMS_PATH'] ?? DEFAULT_PARAMS_PATH,
    ),
    port: Number(process.env['PORT'] ?? DEFAULT_PORT),
  });

  const state = runtime.tracker.getState();
  console.error(`solana-tracker listening on ${api.url} (mode=${state.mode}, status=${state.status})`);
  console.error(`Wallet screener: ${api.url}/  (${wallets.liveAddresses.length} wallet(s) watched)`);
  if (state.killSwitchEngaged) {
    // Persisted, so it survived whatever brought the last process down. Saying
    // so at boot is the difference between "the bot is quiet" and "the bot is
    // quiet because someone killed it and nobody remembers".
    console.error('KILL SWITCH IS ENGAGED (persisted) — no new positions will be opened.');
  }
  console.error('Idle by design. POST /start to begin; POST /flatten {"confirm":true} to liquidate.');

  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.error(`\n${signal}: stopping (this sells nothing) …`);
      void (async () => {
        await api.close();
        await runtime.close();
        process.exit(0);
      })();
    });
  }
}

await main();
