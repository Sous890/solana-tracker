/**
 * DexScreener token endpoint — the screener's independent liquidity opinion.
 *
 * `GET https://api.dexscreener.com/latest/dex/tokens/{mint}`. No key, no auth.
 * Verified live while writing this:
 *
 *   indexed:     {"schemaVersion":"1.0.0","pairs":[{ ..., "liquidity":{"usd":110705.89},
 *                 "quoteToken":{"address":"So111...112"}, "dexId":"orca" }]}
 *   not indexed: {"schemaVersion":"1.0.0","pairs":null}
 *
 * That `null` is the whole reason `DexScreenerClient.getPairs` is typed
 * `Promise<DexPair[] | null>`. "Not indexed" is **unknown**, never zero — and
 * `unknown` blocks a buy with `SCREEN_UNKNOWN` rather than libelling the mint
 * as illiquid. An empty array is treated the same way.
 *
 * A zero-liquidity *pair*, on the other hand, is a real answer. Handoff 08
 * measured every fresh pump.fun mint reporting `liquidity.usd = 0`, because a
 * pre-graduation token trades on a bonding curve and has no pool depth to
 * report. That is a confident `fail` against the floor, and it is left to
 * `safety.ts` to apply — this module reports what the API said and nothing
 * more.
 *
 * Rate limiting lives in the screener, not here: `safety.ts` holds a 250ms
 * floor between calls, capping the module at 240/min against DexScreener's
 * published 300. Putting a second limiter here would make the effective rate a
 * function of two constants that nobody would keep in step.
 */

import type { Address } from '../core/types.js';
import type { DexPair, DexScreenerClient } from './safety.js';

export const DEXSCREENER_BASE_URL = 'https://api.dexscreener.com/latest/dex';

interface WireResponse {
  /** `null` for a mint DexScreener has never indexed. */
  pairs?: DexPair[] | null;
}

export class DexScreenerError extends Error {
  constructor(detail: string) {
    super(`DexScreener: ${detail}`);
    this.name = 'DexScreenerError';
  }
}

export interface DexScreenerDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
}

export function createDexScreenerClient(deps: DexScreenerDeps = {}): DexScreenerClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 5_000;
  const baseUrl = (deps.baseUrl ?? DEXSCREENER_BASE_URL).replace(/\/$/, '');

  return {
    async getPairs(mint: Address): Promise<DexPair[] | null> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImpl(`${baseUrl}/tokens/${encodeURIComponent(mint)}`, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });

        // Every failure throws. The screener turns a throw into
        // `LIQUIDITY_UNAVAILABLE` (unknown) with the message attached; returning
        // `null` here would report the same thing as "not indexed", losing the
        // distinction between a mint nobody has heard of and an outage.
        if (!response.ok) throw new DexScreenerError(`HTTP ${response.status} for ${mint}`);

        const body = (await response.json()) as WireResponse;
        return body.pairs ?? null;
      } catch (cause) {
        if (cause instanceof DexScreenerError) throw cause;
        const aborted = (cause as Error).name === 'AbortError';
        throw new DexScreenerError(
          aborted ? `no response within ${timeoutMs}ms for ${mint}` : (cause as Error).message,
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
