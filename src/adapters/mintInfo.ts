/**
 * Reads and decodes the SPL Mint account.
 *
 * Prompt 8's screener consumes the same struct, so it is built once here.
 * `mintAuthority` and `freezeAuthority` are the fields that matter for
 * honeypot detection — a live mint authority means supply can be inflated
 * under you, and a live freeze authority means your position can be frozen in
 * place — so they are **never cached**. They are revocable, and a stale "safe"
 * answer is worse than no answer.
 *
 * `decimals` is immutable and is cached, but by the existing resolver in
 * `mintMetadata.ts` rather than by a second cache here.
 */

import type { Address } from '../core/types.js';
import type { DecimalsSource } from './mintMetadata.js';

/** SPL Token program. */
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** Token-2022 program — extensions live past the 82-byte base layout. */
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** The base Mint layout is 82 bytes in both programs. */
const MINT_ACCOUNT_SIZE = 82;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Encode bytes as base58. Small enough not to warrant a dependency. */
export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  // Starts empty, not [0]: a seeded zero digit would emit one spurious leading
  // '1' on top of the leading-zero handling below, corrupting any pubkey whose
  // first byte is zero.
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += (digits[index] ?? 0) << 8;
      digits[index] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  // Leading zero bytes become leading '1's.
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros += 1;

  return (
    '1'.repeat(leadingZeros) +
    digits
      .reverse()
      .map((digit) => BASE58_ALPHABET[digit] ?? '')
      .join('')
  );
}

export interface MintInfo {
  mint: Address;
  /** Immutable scale. Safe to cache forever. */
  decimals: number;
  /** Total supply in base units. */
  supply: bigint;
  /**
   * Who may mint more. `null` means revoked.
   * **Not cached** — revocable at any time, and Prompt 8 needs it fresh.
   */
  mintAuthority: Address | null;
  /**
   * Who may freeze token accounts. `null` means revoked.
   * A live freeze authority can trap a position; never cache it.
   */
  freezeAuthority: Address | null;
  /** Owning program — distinguishes Token-2022 mints, which may carry extensions. */
  programId: Address;
  isInitialized: boolean;
}

export class MintAccountError extends Error {
  readonly mint: Address;

  constructor(mint: Address, detail: string) {
    super(`Cannot read mint ${mint}: ${detail}`);
    this.name = 'MintAccountError';
    this.mint = mint;
  }
}

/**
 * Decode the 82-byte base Mint layout.
 *
 *   0..4   mintAuthority COption tag (u32 LE, 0 = None, 1 = Some)
 *   4..36  mintAuthority pubkey
 *   36..44 supply (u64 LE)
 *   44     decimals (u8)
 *   45     isInitialized (u8)
 *   46..50 freezeAuthority COption tag (u32 LE)
 *   50..82 freezeAuthority pubkey
 *
 * Token-2022 accounts are longer; the base layout occupies the same first 82
 * bytes, so extensions are simply ignored here.
 */
export function decodeMintAccount(
  mint: Address,
  data: Uint8Array,
  programId: Address,
): MintInfo {
  if (data.length < MINT_ACCOUNT_SIZE) {
    throw new MintAccountError(mint, `account is ${data.length} bytes, need ${MINT_ACCOUNT_SIZE}`);
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const hasMintAuthority = view.getUint32(0, true) === 1;
  const mintAuthority = hasMintAuthority ? encodeBase58(data.subarray(4, 36)) : null;

  const supply = view.getBigUint64(36, true);
  const decimals = data[44] ?? 0;
  const isInitialized = data[45] === 1;

  const hasFreezeAuthority = view.getUint32(46, true) === 1;
  const freezeAuthority = hasFreezeAuthority ? encodeBase58(data.subarray(50, 82)) : null;

  if (decimals > 18) {
    throw new MintAccountError(mint, `implausible decimals ${decimals}`);
  }

  return { mint, decimals, supply, mintAuthority, freezeAuthority, programId, isInitialized };
}

export interface MintInfoClientDeps {
  /** Solana JSON-RPC HTTP endpoint. Injected — it is a secret from `.env`. */
  rpcHttpUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface MintInfoClient {
  /** Always hits RPC. Authorities must be fresh; see the module note. */
  readMintInfo(mint: Address): Promise<MintInfo>;
  /** Adapter onto the existing decimals cache in `mintMetadata.ts`. */
  decimalsSource(): DecimalsSource;
}

interface RpcAccountResponse {
  result?: {
    value?: {
      data?: [string, string];
      owner?: string;
    } | null;
  };
  error?: { message?: string };
}

export function createMintInfoClient(deps: MintInfoClientDeps): MintInfoClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 5_000;

  async function readMintInfo(mint: Address): Promise<MintInfo> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let body: RpcAccountResponse;
    try {
      const response = await fetchImpl(deps.rpcHttpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [mint, { encoding: 'base64', commitment: 'confirmed' }],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new MintAccountError(mint, `RPC returned HTTP ${response.status}`);
      }
      body = (await response.json()) as RpcAccountResponse;
    } catch (cause) {
      if (cause instanceof MintAccountError) throw cause;
      throw new MintAccountError(mint, (cause as Error).message);
    } finally {
      clearTimeout(timer);
    }

    if (body.error !== undefined) {
      throw new MintAccountError(mint, body.error.message ?? 'RPC error');
    }

    const value = body.result?.value;
    if (value === null || value === undefined) {
      throw new MintAccountError(mint, 'account does not exist');
    }

    const encoded = value.data?.[0];
    const programId = value.owner;
    if (encoded === undefined || programId === undefined) {
      throw new MintAccountError(mint, 'response missing account data or owner');
    }
    if (programId !== TOKEN_PROGRAM_ID && programId !== TOKEN_2022_PROGRAM_ID) {
      throw new MintAccountError(mint, `owner ${programId} is not a token program`);
    }

    return decodeMintAccount(mint, Buffer.from(encoded, 'base64'), programId);
  }

  return {
    readMintInfo,
    decimalsSource: () => ({
      // Returning undefined (rather than throwing) lets the resolver raise
      // `UnknownMintError`, keeping one error vocabulary for "no scale known".
      lookup: async (mint) => {
        try {
          return (await readMintInfo(mint)).decimals;
        } catch {
          return undefined;
        }
      },
    }),
  };
}
