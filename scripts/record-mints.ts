/**
 * Capture real mint accounts and screening inputs into
 * `tests/fixtures/mints/`.
 *
 *   RECORD=1 npx tsx scripts/record-mints.ts
 *
 * Mint accounts are stored as raw base64 account data plus the owner program,
 * slot and capture date. A live mint's authorities can be revoked at any time,
 * so the tests replay these bytes through a fake RPC and never reach the
 * network.
 *
 * Both encodings are captured for every mint: `jsonParsed` is what the
 * screener reads, and `base64` is what the independent Python TLV decoder in
 * the test suite cross-checks it against.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '../tests/fixtures/mints');

const RPC = process.env['RPC_HTTP_URL'] ?? 'https://api.mainnet-beta.solana.com';
const JUP = 'https://lite-api.jup.ag/swap/v1/quote';
const SOL = 'So11111111111111111111111111111111111111112';

/** Named for what each one proves, not for the token. */
const MINTS: Record<string, string> = {
  'clean-spl-bonk': 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  'live-authorities-usdc': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'token2022-extensions-pyusd': '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
  'clean-spl-jup': 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function rpc(method: string, params: unknown[]): Promise<any> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await response.json()) as { result?: unknown; error?: { message: string } };
    if (body.error === undefined) return body.result;
    if (!/[Tt]oo many requests|rate/.test(body.error.message)) throw new Error(body.error.message);
    await sleep(1_000 * 2 ** attempt);
  }
  throw new Error(`${method}: rate limited`);
}

async function quote(inMint: string, outMint: string, amount: string): Promise<unknown> {
  const url = `${JUP}?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=300&swapMode=ExactIn&restrictIntermediateTokens=true`;
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

async function main(): Promise<void> {
  if (process.env['RECORD'] !== '1') {
    console.error('Refusing to run without RECORD=1. This script hits live APIs.');
    process.exitCode = 2;
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const epoch = (await rpc('getEpochInfo', [])) as { epoch: number };

  for (const [name, mint] of Object.entries(MINTS)) {
    const parsed = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    await sleep(300);
    const base64 = await rpc('getAccountInfo', [mint, { encoding: 'base64', commitment: 'confirmed' }]);
    await sleep(300);

    const forward = await quote(SOL, mint, '50000000');
    await sleep(500);

    writeFileSync(
      join(OUT_DIR, `${name}.json`),
      `${JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          currentEpochAtCapture: epoch.epoch,
          mint,
          // What the screener reads.
          jsonParsed: parsed,
          // What the independent decoder cross-checks against.
          base64,
          forwardQuote: forward,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`recorded ${name}`);
  }

  // A pair with no route at all.
  const unroutable = await quote(SOL, '11111111111111111111111111111111', '50000000');
  writeFileSync(
    join(OUT_DIR, 'no-jupiter-route.json'),
    `${JSON.stringify({ recordedAt: new Date().toISOString(), mint: '11111111111111111111111111111111', forwardQuote: unroutable }, null, 2)}\n`,
  );
  console.log('recorded no-jupiter-route');

  // A fresh pump.fun mint: real reverse-quote retention on a live thin market.
  const sigs = (await rpc('getSignaturesForAddress', [
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    { limit: 12 },
  ])) as Array<{ signature: string; err: unknown }>;

  for (const entry of sigs.filter((s) => s.err === null).slice(0, 8)) {
    const tx = await rpc('getTransaction', [
      entry.signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
    ]);
    await sleep(250);
    const balance = (tx?.meta?.postTokenBalances ?? []).find((b: any) =>
      String(b.mint).endsWith('pump'),
    );
    if (balance === undefined) continue;

    const mint = String(balance.mint);
    const parsed = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    await sleep(300);
    const base64 = await rpc('getAccountInfo', [mint, { encoding: 'base64', commitment: 'confirmed' }]);
    await sleep(300);

    const forward = (await quote(SOL, mint, '50000000')) as any;
    await sleep(500);
    let reverse: unknown = null;
    if (forward.status === 200) {
      const back = (BigInt(forward.body.outAmount) * 9n) / 10n;
      reverse = await quote(mint, SOL, back.toString());
      await sleep(500);
    }

    const dex = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`).then((r) =>
      r.json(),
    );

    writeFileSync(
      join(OUT_DIR, 'fresh-pump-mint.json'),
      `${JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          currentEpochAtCapture: epoch.epoch,
          mint,
          jsonParsed: parsed,
          base64,
          forwardQuote: forward,
          reverseQuote: reverse,
          dexscreener: dex,
        },
        null,
        2,
      )}\n`,
    );
    console.log('recorded fresh-pump-mint');
    break;
  }

  // DexScreener for a deep, graduated token.
  const bonkDex = await fetch(
    'https://api.dexscreener.com/latest/dex/tokens/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  ).then((r) => r.json());
  writeFileSync(
    join(OUT_DIR, 'dexscreener-deep-bonk.json'),
    `${JSON.stringify({ recordedAt: new Date().toISOString(), dexscreener: bonkDex }, null, 2)}\n`,
  );
  console.log('recorded dexscreener-deep-bonk');
}

await main();
