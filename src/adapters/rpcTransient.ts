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
