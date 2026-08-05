/**
 * Mint decimals resolution.
 *
 * Decimals are the scale of every token amount in the system. Get one wrong and
 * a position is misstated by three or nine orders of magnitude — the bot thinks
 * it holds 1,000 tokens when it holds 0.001, or sells a thousand times what it
 * has. So there is **no default**: an unresolvable mint is an error, and the
 * caller must decide what to do about it.
 *
 * The lookup is injectable. Today it is fixture-backed; Prompt 8's screener
 * becomes the real source, since it already reads the mint account and has the
 * value in hand.
 */

import type { Address } from '../core/types.js';

/** The widest scale an SPL mint can declare. */
const MAX_DECIMALS = 18;

/** Where decimals come from. Returns `undefined` for a mint it does not know. */
export interface DecimalsSource {
  lookup(mint: Address): Promise<number | undefined>;
}

export class UnknownMintError extends Error {
  readonly mint: Address;

  constructor(mint: Address) {
    super(
      `Cannot resolve decimals for mint ${mint}. Refusing to assume a scale — ` +
        'guessing wrong misstates the position by orders of magnitude.',
    );
    this.name = 'UnknownMintError';
    this.mint = mint;
  }
}

export class InvalidDecimalsError extends Error {
  constructor(mint: Address, decimals: number) {
    super(`Mint ${mint} reported implausible decimals: ${decimals}`);
    this.name = 'InvalidDecimalsError';
  }
}

export type ResolveDecimals = (mint: Address) => Promise<number>;

/**
 * Build a caching resolver over a source.
 *
 * The cache never expires and is never invalidated: a mint's decimals are fixed
 * at creation and cannot change, so a hit is always correct. In-flight lookups
 * are shared, so a burst of interest in a new mint makes one call rather than
 * one per caller.
 *
 * Failures are deliberately *not* cached — a source that was briefly unreachable
 * must not poison the mint for the life of the process.
 */
export function createDecimalsResolver(source: DecimalsSource): ResolveDecimals {
  const resolved = new Map<Address, number>();
  const inFlight = new Map<Address, Promise<number>>();

  return async function resolveDecimals(mint: Address): Promise<number> {
    const cached = resolved.get(mint);
    if (cached !== undefined) return cached;

    const pending = inFlight.get(mint);
    if (pending !== undefined) return pending;

    const lookup = (async (): Promise<number> => {
      const decimals = await source.lookup(mint);
      if (decimals === undefined) throw new UnknownMintError(mint);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
        throw new InvalidDecimalsError(mint, decimals);
      }
      resolved.set(mint, decimals);
      return decimals;
    })().finally(() => {
      inFlight.delete(mint);
    });

    inFlight.set(mint, lookup);
    return lookup;
  };
}

/**
 * A source backed by a fixed table. Stands in until the screener lands.
 *
 * Unknown mints return `undefined` rather than a plausible-looking default, so
 * the resolver raises `UnknownMintError` instead of inventing a scale.
 */
export function fixtureDecimalsSource(table: Readonly<Record<Address, number>>): DecimalsSource {
  return {
    lookup: async (mint) => table[mint],
  };
}
