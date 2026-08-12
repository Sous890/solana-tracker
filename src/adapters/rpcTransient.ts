/**
 * Is a JSON-RPC error message a transient failure worth retrying?
 *
 * ── WHY THIS IS A SHARED MODULE AND NOT THREE REGEXES ─────────────────────
 *
 * Helius signals overload as a JSON-RPC error with HTTP **200**. The status
 * check every caller writes first — `429 || >= 500` — therefore never sees it,
 * and the natural next line ("a JSON-RPC error is the node answering, not
 * failing to answer, so do not retry") files a transient as permanent.
 *
 * Three call sites learned this separately:
 *
 *   1. `scripts/calibrate-delays.ts` — "Service overloaded" killed a 40-pool
 *      run at the seven-minute mark. Fixed there, in a local regex.
 *   2. `scripts/export-wallet-history.ts` — carried the narrower
 *      `/too many requests|rate/`, so the same message threw instead of backing
 *      off and killed a 2,174-signature export at the 136th fetch, 2026-08-11.
 *   3. `src/adapters/rpcClient.ts` — the LIVE path, which still does not retry
 *      these at all. Not changed here: its retry budget and `RpcError` contract
 *      are load-bearing for the guard and quote paths, and widening them is a
 *      behavioural change to live trading that deserves its own change and its
 *      own soak. See `docs/handoffs/27-hssjjkhr-replay.md`.
 *
 * The list is deliberately broad. A false positive costs one bounded retry; a
 * false negative costs the whole run, which is the failure actually observed
 * twice.
 */

/**
 * Transient JSON-RPC error messages, matched case-insensitively.
 *
 * `rate` is intentionally loose — it catches "rate limit", "rate exceeded" and
 * provider-specific phrasings without enumerating them.
 */
const TRANSIENT = /too many requests|rate|overloaded|timeout|try again|temporarily/i;

/**
 * True when a JSON-RPC error message describes a condition that may succeed on
 * retry, rather than a malformed request that will fail identically forever.
 */
export function isTransientRpcMessage(message: string | undefined): boolean {
  return message !== undefined && TRANSIENT.test(message);
}

/**
 * A transport-level failure: `fetch` itself threw rather than returning a
 * response.
 *
 * THE THIRD CLASS, and the one that killed a 30-wallet campaign at its second
 * wallet on 2026-08-12 with `fetch failed / read ETIMEDOUT`. There are three
 * ways an RPC call fails and the scripts each handled a different two:
 *
 *   1. HTTP 429 / 5xx                — the status check every caller writes
 *   2. JSON-RPC error at HTTP 200    — `isTransientRpcMessage`
 *   3. `fetch` throws                — this
 *
 * `src/adapters/rpcClient.ts` handles 1 and 3 and not 2; the scripts handled
 * 1 and 2 and not 3. An exact inversion, and each was found the same way: a
 * long run dying partway through.
 *
 * Everything here is retried. A genuinely dead host exhausts the attempt budget
 * and surfaces anyway; the cost of one wasted retry is nothing against losing a
 * multi-hour campaign.
 */
export function isTransportError(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  if (cause.name === 'AbortError') return true;
  const code = (cause as { cause?: { code?: string } }).cause?.code;
  return (
    code !== undefined ||
    /fetch failed|network|socket|ECONN|ETIMEDOUT|EAI_AGAIN|terminated/i.test(cause.message)
  );
}

/**
 * One JSON-RPC call with bounded exponential backoff across all three failure
 * classes. Shared so a fourth script cannot rediscover any of them.
 */
export async function postJsonRpc<T>(
  url: string,
  method: string,
  params: unknown[],
  options: { attempts?: number; onAttempt?: () => void } = {},
): Promise<T> {
  const attempts = options.attempts ?? 6;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  let last = 'no attempt made';
  let permanent: string | undefined;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    options.onAttempt?.();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });

      if (response.status === 429 || response.status >= 500) {
        last = `HTTP ${response.status}`;
        await sleep(500 * 2 ** attempt);
        continue;
      }

      const body = (await response.json()) as { result?: T; error?: { message: string } };
      if (body.error === undefined) return body.result as T;
      if (!isTransientRpcMessage(body.error.message)) {
        // PERMANENT. Thrown outside the try, not inside it: a message
        // containing "terminated" or "socket" would otherwise be caught below
        // and misclassified as a transport error, and retried forever.
        permanent = `${method}: ${body.error.message}`;
        break;
      }
      last = body.error.message;
      await sleep(1_000 * 2 ** attempt);
    } catch (cause) {
      if (!isTransportError(cause)) throw cause;
      last = (cause as Error).message;
      await sleep(1_000 * 2 ** attempt);
    }
  }
  if (permanent !== undefined) throw new Error(permanent);
  throw new Error(`${method}: gave up after ${attempts} attempts (${last})`);
}
