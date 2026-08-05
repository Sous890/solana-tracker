/**
 * Solana JSON-RPC over HTTP — one client, two frozen port shapes.
 *
 * `SafetyRpc` (the screener, prompt 8) and `RpcClient` (the wallet stream,
 * prompt 7) were both declared structurally where they are consumed, and they
 * overlap: both want `getSignaturesForAddress`. Implementing them from one
 * object means the tracker opens one connection to the provider instead of
 * two, and `getSignaturesForAddress` cannot drift between the mint-age check
 * and the gap fill.
 *
 * Every response shape below was verified live against
 * `https://api.mainnet-beta.solana.com` while writing this — see
 * `docs/handoffs/09-tracker.md` for the captured bodies.
 *
 * Three things drive the code.
 *
 * 1. **`maxSupportedTransactionVersion` is mandatory.** Without it
 *    `getTransaction` errors on every v0 transaction, which is most of them
 *    now. `scripts/record-mints.ts` already sends it; this matches.
 *
 * 2. **A missing account is `null`, not an error.** `getAccountInfo` returns
 *    `result.value === null` for an address that does not exist. That is the
 *    only case that maps to `null` here — everything else that goes wrong
 *    throws, because the screener records a throw as `unknown` with the
 *    message attached, and "account does not exist" is a different claim from
 *    "we could not read it".
 *
 * 3. **Rate limits are the normal case, not the exception.** Public and shared
 *    endpoints answer 429 under any real load. Retries are bounded and honour
 *    `Retry-After`, mirroring `jupiter.ts`; past the budget the call throws
 *    and the screener degrades to `unknown` rather than to a wrong answer.
 */

import type { Address, Signature, UnixMillis } from '../core/types.js';
import type { ParsedMintAccount, SafetyRpc } from './safety.js';
import type { RpcClient, SignatureEntry } from './walletStream.js';
import type { ParsedTransactionWithMeta } from './swapParser.js';

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code?: number; message?: string };
}

interface AccountInfoResult {
  value: {
    owner?: string;
    /** An object under `jsonParsed`; a `[data, encoding]` tuple when unparseable. */
    data?: unknown;
  } | null;
}

interface EpochInfoResult {
  epoch: number;
}

export class RpcError extends Error {
  readonly method: string;

  constructor(method: string, detail: string) {
    super(`${method}: ${detail}`);
    this.name = 'RpcError';
    this.method = method;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface RpcClientDeps {
  /** JSON-RPC HTTP endpoint. A secret from `.env`; never logged. */
  httpUrl: string;
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Attempts per call, including the first. */
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => UnixMillis;
  /**
   * Commitment for every call.
   *
   * `confirmed`, matching the wallet stream's subscription. Reorg-exposed and
   * deliberately so: `finalized` costs ~13 seconds, which is an eternity for a
   * copy-trade signal. See handoff 07.
   */
  commitment?: 'processed' | 'confirmed' | 'finalized';
}

/** Both frozen port shapes, from one connection. */
export type SolanaRpcClient = SafetyRpc & RpcClient;

export function createRpcClient(deps: RpcClientDeps): SolanaRpcClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const maxAttempts = deps.maxAttempts ?? 3;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const commitment = deps.commitment ?? 'confirmed';

  let nextId = 1;

  function retryAfterMs(response: Response): number | undefined {
    const header = response.headers.get('retry-after');
    if (header === null) return undefined;
    const seconds = Number(header);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
  }

  async function call<T>(method: string, params: unknown[]): Promise<T> {
    let lastDetail = 'no attempt completed';

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(deps.httpUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
          signal: controller.signal,
        });

        if (response.status === 429 || response.status >= 500) {
          lastDetail = `HTTP ${response.status}`;
          const suggested = retryAfterMs(response);
          if (attempt === maxAttempts - 1) break;
          await sleep(Math.max(250 * 2 ** attempt, suggested ?? 0));
          continue;
        }

        if (!response.ok) throw new RpcError(method, `HTTP ${response.status}`);

        const body = (await response.json()) as JsonRpcResponse<T>;
        if (body.error !== undefined) {
          // A JSON-RPC error is the node answering, not failing to answer, so
          // it is not retried — a malformed request would only fail again.
          throw new RpcError(method, body.error.message ?? `code ${body.error.code ?? '?'}`);
        }
        if (body.result === undefined) throw new RpcError(method, 'response carried no result');
        return body.result;
      } catch (cause) {
        if (cause instanceof RpcError) throw cause;
        const aborted = (cause as Error).name === 'AbortError';
        lastDetail = aborted ? `no response within ${timeoutMs}ms` : (cause as Error).message;
        if (attempt === maxAttempts - 1) break;
        await sleep(250 * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }

    throw new RpcError(method, `gave up after ${maxAttempts} attempt(s): ${lastDetail}`);
  }

  return {
    /**
     * The `jsonParsed` mint account, or `null` if the address holds nothing.
     *
     * Reads the RPC's own decoder rather than parsing the Token-2022 extension
     * TLV here. Handoff 08 recorded why: an independent TLV decoder got the
     * start offset wrong (166, not 83 — a mint is padded to the 165-byte
     * Account length with an account-type byte at 165), and a wrong offset
     * reads plausible garbage rather than failing.
     */
    async getParsedMintAccount(mint: Address): Promise<ParsedMintAccount | null> {
      const result = await call<AccountInfoResult>('getAccountInfo', [
        mint,
        { encoding: 'jsonParsed', commitment },
      ]);

      const value = result.value;
      if (value === null || value === undefined) return null;

      const data = value.data;
      // Unparseable accounts come back as `[base64, encoding]`. That is not a
      // mint we can screen, and it is not "no such account" either — the
      // screener must record it as unknown with a reason, so it throws.
      if (Array.isArray(data)) {
        throw new RpcError('getAccountInfo', `account ${mint} is not a parseable token mint`);
      }
      const parsed = (data as { parsed?: { type?: string; info?: unknown } } | undefined)?.parsed;
      if (parsed === undefined || parsed.info === undefined) {
        throw new RpcError('getAccountInfo', `account ${mint} carried no parsed info`);
      }
      if (parsed.type !== 'mint') {
        throw new RpcError('getAccountInfo', `account ${mint} is a ${parsed.type}, not a mint`);
      }
      if (value.owner === undefined) {
        throw new RpcError('getAccountInfo', `account ${mint} carried no owner program`);
      }

      return value as unknown as ParsedMintAccount;
    },

    /**
     * Signature page, newest first.
     *
     * Serves both callers: the screener's age check (`limit`, `before`) and the
     * stream's gap fill (`limit`, `before`, `until`). The response is a
     * superset of `SignatureRef`, so one method satisfies both frozen shapes.
     */
    async getSignaturesForAddress(
      address: Address,
      options: { limit: number; before?: Signature; until?: Signature },
      // `SignatureEntry` is the wider of the two: it carries `slot`, `err` and
      // `transactionIndex` on top of what `SignatureRef` asks for, so one
      // return type satisfies both frozen ports without an intersection that
      // would make element access ambiguous.
    ): Promise<SignatureEntry[]> {
      const config: Record<string, unknown> = { limit: options.limit, commitment };
      if (options.before !== undefined) config['before'] = options.before;
      if (options.until !== undefined) config['until'] = options.until;

      const result = await call<
        Array<{
          signature: string;
          slot: number;
          err: unknown | null;
          blockTime?: number | null;
          transactionIndex?: number | null;
        }>
      >('getSignaturesForAddress', [address, config]);

      return result.map((entry) => ({
        signature: entry.signature,
        slot: entry.slot,
        err: entry.err ?? null,
        blockTime: entry.blockTime ?? null,
        transactionIndex: entry.transactionIndex ?? null,
      }));
    },

    /**
     * A confirmed transaction, or `null` while it is still propagating.
     *
     * `maxSupportedTransactionVersion: 0` is not optional — without it the node
     * refuses every versioned transaction outright.
     */
    async getTransaction(signature: Signature): Promise<ParsedTransactionWithMeta | null> {
      const result = await call<ParsedTransactionWithMeta | null>('getTransaction', [
        signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment },
      ]);
      return result ?? null;
    },

    /** Current epoch, for `transferFeeConfig`'s epoch-keyed fee slots. */
    async getEpoch(): Promise<number> {
      const result = await call<EpochInfoResult>('getEpochInfo', [{ commitment }]);
      return result.epoch;
    },
  };
}
