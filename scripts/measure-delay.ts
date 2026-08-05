/**
 * Measure THIS bot's detection-to-ready latency. Paper only, submits nothing.
 *
 * Three legs, which is the whole budget before a transaction could be sent:
 *   detect  — websocket notification received, minus the block's own timestamp
 *   fetch   — getTransaction, which is what turns a signature into a swap
 *   quote   — Jupiter round trip for the mirrored buy
 *
 * ── THE MEASUREMENT'S OWN ERROR BAR ───────────────────────────────────────
 *
 * `detect` is measured against `blockTime`, which is a stake-weighted median in
 * WHOLE SECONDS. So a single sample carries up to ~1s of quantisation on its
 * own, and the median across many samples is the only number worth reading.
 * Reported with the raw spread so the noise is visible rather than implied.
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';


const HTTP = process.env['RPC_HTTP_URL'] as string;
const WSS = process.env['RPC_WSS_URL'] as string;
const WSOL = 'So11111111111111111111111111111111111111112';

const wallets = (JSON.parse(readFileSync('config.json', 'utf8')) as { trackedWallets: string[] })
  .trackedWallets;

const runMs = Number(process.argv[2] ?? 240_000);

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(HTTP, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const b = (await r.json()) as { result?: T; error?: { message: string } };
  if (b.error) throw new Error(b.error.message);
  return b.result as T;
}

let frames = 0;
let notifications = 0;
const detect: number[] = [];
const fetchMs: number[] = [];
const quoteMs: number[] = [];

const pctl = (a: number[], p: number): number => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] as number;
};

async function timeQuote(mint: string): Promise<void> {
  const t0 = Date.now();
  try {
    const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${WSOL}&outputMint=${mint}&amount=50000000&slippageBps=300&restrictIntermediateTokens=true`;
    await fetch(url, { signal: AbortSignal.timeout(5_000) });
    quoteMs.push(Date.now() - t0);
  } catch { /* a timeout is itself a latency fact; excluded rather than fabricated */ }
}

const ws = new (globalThis as unknown as { WebSocket: typeof globalThis.WebSocket }).WebSocket(WSS);

ws.addEventListener('open', () => {
  for (const w of wallets) {
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
      params: [{ mentions: [w] }, { commitment: 'confirmed' }],
    }));
  }
  console.error(`subscribed to ${wallets.length} wallet(s); sampling for ${runMs / 1000}s\n`);
});

ws.addEventListener('message', (event: MessageEvent) => {
  const receivedAt = Date.now();
  let payload: { params?: { result?: { value?: { signature?: string; err?: unknown } } } };
  try { payload = JSON.parse(String(event.data)); } catch { return; }
  const sig = payload.params?.result?.value?.signature;
  if (sig === undefined) { frames += 1; return; }
  notifications += 1;
  // A FAILED transaction still measures detection latency perfectly well — the
  // block landed and we were told about it. Excluding them threw away 46% of
  // popo3Rj6's traffic and produced a run with zero samples.
  const failed = payload.params?.result?.value?.err != null;

  void (async () => {
    const t0 = Date.now();
    try {
      const tx = await rpc<{ blockTime?: number | null; meta?: { postTokenBalances?: Array<{ mint?: string }> } } | null>(
        'getTransaction', [sig, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }]);
      fetchMs.push(Date.now() - t0);
      if (tx?.blockTime == null) return;

      detect.push(receivedAt - tx.blockTime * 1_000);

      if (failed) return;
      const mint = (tx.meta?.postTokenBalances ?? []).map((b) => b.mint).find((m) => m && m !== WSOL);
      if (mint !== undefined && quoteMs.length < 40) await timeQuote(mint);

      process.stderr.write(`\r  detect n=${detect.length}  fetch n=${fetchMs.length}  quote n=${quoteMs.length}`);
    } catch { /* transient */ }
  })();
});

setTimeout(() => {
  process.stderr.write('\r');
  const row = (label: string, a: number[]): void =>
    console.log('  ' + label.padEnd(10) + String(a.length).padStart(5) +
      [pctl(a, 0.1), pctl(a, 0.5), pctl(a, 0.9), Math.max(...a)]
        .map((v) => `${Math.round(v)}ms`.padStart(10)).join(''));

  console.log(`\n  non-notification frames ${frames}, log notifications ${notifications}`);
  console.log('\n              n       p10       p50       p90       max');
  if (detect.length) row('detect', detect);
  if (fetchMs.length) row('fetch', fetchMs);
  if (quoteMs.length) row('quote', quoteMs);

  if (detect.length && fetchMs.length && quoteMs.length) {
    const total = pctl(detect, 0.5) + pctl(fetchMs, 0.5) + pctl(quoteMs, 0.5);
    console.log(`\n  MEDIAN detection -> signed-and-ready : ${Math.round(total)}ms`);
    console.log(`  (detect ${Math.round(pctl(detect, 0.5))} + fetch ${Math.round(pctl(fetchMs, 0.5))} + quote ${Math.round(pctl(quoteMs, 0.5))})`);
    console.log(`\n  blockTime is whole-second, so single samples carry ~1s quantisation;`);
    console.log(`  read the median, not any one number.`);
  }
  ws.close();
  process.exit(0);
}, runMs);
