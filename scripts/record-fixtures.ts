/**
 * Capture real Jupiter and RPC responses into `tests/fixtures/`.
 *
 * Manual, never part of the test run:
 *
 *   RECORD=1 npx tsx scripts/record-fixtures.ts
 *
 * The suite itself must never reach the network — `tests/setup.ts` fails any
 * un-mocked fetch. This script is how the recorded bytes get there in the
 * first place.
 *
 * Anything that cannot be captured honestly (a 429 without hammering the API;
 * an outAmount above 2^53, which needs a mint whose base-unit supply exceeds
 * it) lives in `tests/fixtures/synthetic/` instead, clearly separated so no
 * one later mistakes it for observed behaviour.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '../tests/fixtures/jupiter');

const BASE = 'https://lite-api.jup.ag/swap/v1';
const RPC = process.env['RPC_HTTP_URL'] ?? 'https://api.mainnet-beta.solana.com';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
/** Token-2022 mint (PayPal USD). */
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';
/** Not a token account at all — yields TOKEN_NOT_TRADABLE. */
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
/** A thin pump.fun mint: routable in size, no route at 1 lamport. */
const THIN_MINT = '5yzhXXiWmHVjMEnRcAYbHcV8w9Ei5dWKA9JaKFHopump';

interface Capture {
  name: string;
  url: string;
}

const CAPTURES: Capture[] = [
  {
    name: 'quote-single-hop-sol-usdc',
    url: `${BASE}/quote?inputMint=${SOL}&outputMint=${USDC}&amount=100000000&slippageBps=50&swapMode=ExactIn&restrictIntermediateTokens=true`,
  },
  {
    // A parallel split: several legs all producing the output mint.
    name: 'quote-split-route-sol-usdc',
    url: `${BASE}/quote?inputMint=${SOL}&outputMint=${USDC}&amount=999999999999999999&slippageBps=50&swapMode=ExactIn&restrictIntermediateTokens=true`,
  },
  {
    name: 'quote-high-impact-thin',
    url: `${BASE}/quote?inputMint=${SOL}&outputMint=${BONK}&amount=500000000000&slippageBps=5000&swapMode=ExactIn&restrictIntermediateTokens=true`,
  },
  {
    name: 'error-token-not-tradable',
    url: `${BASE}/quote?inputMint=${SOL}&outputMint=${SYSTEM_PROGRAM}&amount=100000000&slippageBps=50&swapMode=ExactIn`,
  },
  {
    // A real mint with no route at this size — the other no-route code.
    name: 'error-no-routes-found',
    url: `${BASE}/quote?inputMint=${SOL}&outputMint=${THIN_MINT}&amount=1&slippageBps=50&swapMode=ExactIn`,
  },
  {
    // Free tier rejects restrictIntermediateTokens=false outright. Recorded so
    // the NOT_SUPPORTED -> UPSTREAM_ERROR mapping is pinned to a real body.
    name: 'error-not-supported-restrict-false',
    url: `${BASE}/quote?inputMint=${SOL}&outputMint=${USDC}&amount=100000000&slippageBps=50&swapMode=ExactIn&restrictIntermediateTokens=false`,
  },
];

async function recordQuote({ name, url }: Capture): Promise<void> {
  const response = await fetch(url);
  const body = await response.text();
  const record = {
    recordedAt: new Date().toISOString(),
    request: { url: url.replace(/([?&])amount=[^&]*/, '$1amount=…') },
    status: response.status,
    body: JSON.parse(body) as unknown,
  };
  writeFileSync(join(OUT_DIR, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`recorded ${name} (HTTP ${response.status})`);
}

async function recordMintAccount(name: string, mint: string): Promise<void> {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [mint, { encoding: 'base64', commitment: 'confirmed' }],
    }),
  });
  const body = (await response.json()) as unknown;
  const record = { recordedAt: new Date().toISOString(), mint, status: response.status, body };
  writeFileSync(join(OUT_DIR, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`recorded ${name}`);
}

async function main(): Promise<void> {
  if (process.env['RECORD'] !== '1') {
    console.error('Refusing to run without RECORD=1. This script hits live APIs.');
    process.exitCode = 2;
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });

  for (const capture of CAPTURES) {
    await recordQuote(capture);
    // Deliberately unhurried. Provoking a 429 to capture it would be abusive;
    // that fixture is synthetic and lives under tests/fixtures/synthetic/.
    await new Promise((r) => setTimeout(r, 400));
  }

  await recordMintAccount('mint-account-spl-usdc', USDC);
  await recordMintAccount('mint-account-token2022-pyusd', PYUSD);
}

await main();
