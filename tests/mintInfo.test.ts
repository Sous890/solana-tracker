import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MintAccountError,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMintInfoClient,
  decodeMintAccount,
  encodeBase58,
} from '../src/adapters/mintInfo.js';
import { UnknownMintError, createDecimalsResolver } from '../src/adapters/mintMetadata.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, 'fixtures/jupiter');

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';
const RPC = 'https://rpc.example.invalid';

interface AccountFixture {
  body: { result: { value: { data: [string, string]; owner: string } } };
}

function accountFixture(name: string): AccountFixture {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as AccountFixture;
}

function bytesOf(name: string): Uint8Array {
  return Buffer.from(accountFixture(name).body.result.value.data[0], 'base64');
}

/** A fetch that replays one recorded RPC response. */
function stubRpc(fixture: unknown, status = 200) {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return new Response(JSON.stringify(fixture), { status });
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

// ---------------------------------------------------------------------------

describe('encodeBase58', () => {
  it('encodes 32 zero bytes as exactly 32 ones, not 33', () => {
    // A seeded zero digit in the accumulator produced 33 here, which would
    // corrupt every pubkey beginning with a zero byte.
    expect(encodeBase58(new Uint8Array(32))).toBe('1'.repeat(32));
    expect(encodeBase58(new Uint8Array(32))).toHaveLength(32);
  });

  it('preserves leading zero bytes as leading ones', () => {
    expect(encodeBase58(new Uint8Array([0, 0, 1]))).toBe('112');
  });

  it('encodes a single byte', () => {
    expect(encodeBase58(new Uint8Array([0]))).toBe('1');
    expect(encodeBase58(new Uint8Array([57]))).toBe('z');
  });
});

describe('decodeMintAccount', () => {
  it('decodes a real SPL mint (USDC)', () => {
    const info = decodeMintAccount(USDC, bytesOf('mint-account-spl-usdc'), TOKEN_PROGRAM_ID);

    expect(info.decimals).toBe(6);
    expect(info.isInitialized).toBe(true);
    expect(info.programId).toBe(TOKEN_PROGRAM_ID);
    expect(typeof info.supply).toBe('bigint');
    expect(info.supply).toBeGreaterThan(0n);
    // USDC retains both authorities; they are base58 pubkeys, not raw bytes.
    // Exact values, cross-checked with an independent decoder rather than
    // asserted by shape — a regex would pass on a wrongly-encoded key.
    expect(info.mintAuthority).toBe('BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG');
    expect(info.freezeAuthority).toBe('7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar');
    expect(info.supply).toBe(7_917_986_901_408_177n);
  });

  it('decodes a real Token-2022 mint (PYUSD) from the same base layout', () => {
    const info = decodeMintAccount(
      PYUSD,
      bytesOf('mint-account-token2022-pyusd'),
      TOKEN_2022_PROGRAM_ID,
    );

    expect(info.decimals).toBe(6);
    expect(info.isInitialized).toBe(true);
    // The distinguishing fact: extensions follow the 82-byte base layout.
    expect(info.programId).toBe(TOKEN_2022_PROGRAM_ID);
    expect(bytesOf('mint-account-token2022-pyusd').length).toBeGreaterThan(82);
  });

  it('reads a revoked authority as null rather than a zero pubkey', () => {
    const data = new Uint8Array(82);
    const view = new DataView(data.buffer);
    view.setUint32(0, 0, true); // mintAuthority: None
    view.setBigUint64(36, 1_000_000n, true);
    data[44] = 9;
    data[45] = 1;
    view.setUint32(46, 0, true); // freezeAuthority: None

    const info = decodeMintAccount('Test', data, TOKEN_PROGRAM_ID);
    expect(info.mintAuthority).toBeNull();
    expect(info.freezeAuthority).toBeNull();
    expect(info.decimals).toBe(9);
    expect(info.supply).toBe(1_000_000n);
  });

  it('reads a present authority as a base58 address', () => {
    const data = new Uint8Array(82);
    const view = new DataView(data.buffer);
    view.setUint32(0, 1, true); // Some
    data.set(new Uint8Array(32).fill(1), 4);
    data[44] = 6;
    data[45] = 1;
    view.setUint32(46, 1, true);
    data.set(new Uint8Array(32).fill(2), 50);

    const info = decodeMintAccount('Test', data, TOKEN_PROGRAM_ID);
    expect(info.mintAuthority).not.toBeNull();
    expect(info.freezeAuthority).not.toBeNull();
    expect(info.mintAuthority).not.toBe(info.freezeAuthority);
  });

  it('refuses an account too short to be a mint', () => {
    expect(() => decodeMintAccount('Test', new Uint8Array(40), TOKEN_PROGRAM_ID)).toThrow(
      MintAccountError,
    );
  });

  it('refuses implausible decimals rather than passing them on', () => {
    const data = new Uint8Array(82);
    data[44] = 200;
    expect(() => decodeMintAccount('Test', data, TOKEN_PROGRAM_ID)).toThrow(/implausible/);
  });

  it('keeps supply exact above 2^53', () => {
    const data = new Uint8Array(82);
    const view = new DataView(data.buffer);
    view.setBigUint64(36, 18_446_744_073_709_551_000n, true);
    data[44] = 9;
    data[45] = 1;
    expect(decodeMintAccount('Test', data, TOKEN_PROGRAM_ID).supply).toBe(
      18_446_744_073_709_551_000n,
    );
  });
});

describe('createMintInfoClient', () => {
  it('reads and decodes a mint over RPC', async () => {
    const rpc = stubRpc(accountFixture('mint-account-spl-usdc').body);
    const client = createMintInfoClient({ rpcHttpUrl: RPC, fetchImpl: rpc.impl });

    const info = await client.readMintInfo(USDC);
    expect(info.decimals).toBe(6);
    expect(info.programId).toBe(TOKEN_PROGRAM_ID);
  });

  it('never caches authorities — every read hits RPC', async () => {
    const rpc = stubRpc(accountFixture('mint-account-spl-usdc').body);
    const client = createMintInfoClient({ rpcHttpUrl: RPC, fetchImpl: rpc.impl });

    await client.readMintInfo(USDC);
    await client.readMintInfo(USDC);
    await client.readMintInfo(USDC);

    // A stale "authority revoked" is worse than no answer: it is revocable
    // state, and Prompt 8's screener decides safety on it.
    expect(rpc.calls()).toBe(3);
  });

  it('rejects an account owned by something other than a token program', async () => {
    const fixture = structuredClone(accountFixture('mint-account-spl-usdc').body);
    fixture.result.value.owner = '11111111111111111111111111111111';
    const client = createMintInfoClient({
      rpcHttpUrl: RPC,
      fetchImpl: stubRpc(fixture).impl,
    });

    await expect(client.readMintInfo(USDC)).rejects.toThrow(/not a token program/);
  });

  it('rejects a nonexistent account', async () => {
    const client = createMintInfoClient({
      rpcHttpUrl: RPC,
      fetchImpl: stubRpc({ result: { value: null } }).impl,
    });
    await expect(client.readMintInfo(USDC)).rejects.toThrow(/does not exist/);
  });

  it('surfaces an RPC-level error', async () => {
    const client = createMintInfoClient({
      rpcHttpUrl: RPC,
      fetchImpl: stubRpc({ error: { message: 'node behind' } }).impl,
    });
    await expect(client.readMintInfo(USDC)).rejects.toThrow(/node behind/);
  });
});

describe('decimalsSource', () => {
  it('feeds the existing resolver rather than forking its cache', async () => {
    const rpc = stubRpc(accountFixture('mint-account-spl-usdc').body);
    const client = createMintInfoClient({ rpcHttpUrl: RPC, fetchImpl: rpc.impl });
    const resolve_ = createDecimalsResolver(client.decimalsSource());

    expect(await resolve_(USDC)).toBe(6);
    expect(await resolve_(USDC)).toBe(6);
    expect(await resolve_(USDC)).toBe(6);

    // Decimals are immutable, so one lookup is enough — the cache lives in
    // mintMetadata.ts and is not duplicated here.
    expect(rpc.calls()).toBe(1);
  });

  it('raises UnknownMintError rather than defaulting when the account is missing', async () => {
    const client = createMintInfoClient({
      rpcHttpUrl: RPC,
      fetchImpl: stubRpc({ result: { value: null } }).impl,
    });
    const resolve_ = createDecimalsResolver(client.decimalsSource());

    await expect(resolve_(USDC)).rejects.toThrow(UnknownMintError);
    // Specifically not 9.
    await expect(resolve_(USDC)).rejects.toThrow(/Refusing to assume a scale/);
  });

  it('does not cache a failure, so a transient outage does not poison the mint', async () => {
    let fail = true;
    const impl = (async () => {
      if (fail) return new Response(JSON.stringify({ result: { value: null } }), { status: 200 });
      return new Response(JSON.stringify(accountFixture('mint-account-spl-usdc').body), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const client = createMintInfoClient({ rpcHttpUrl: RPC, fetchImpl: impl });
    const resolve_ = createDecimalsResolver(client.decimalsSource());

    await expect(resolve_(USDC)).rejects.toThrow(UnknownMintError);
    fail = false;
    expect(await resolve_(USDC)).toBe(6);
  });
});
