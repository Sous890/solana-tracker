/**
 * Config loading and validation.
 *
 * Two entry points, deliberately split:
 *  - `parseConfig(unknown)` is pure — it is the whole validation surface and
 *    is what the tests exercise.
 *  - `loadConfig(path)` is the single filesystem read in `core/`, kept here so
 *    that "where does config come from" has exactly one answer. Everything
 *    downstream receives an already-validated `Config` by argument.
 *
 * Secrets never live in `config.json` — RPC URLs and API keys come from `.env`
 * and are read by adapters. This file holds tuning parameters only.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** Base58, no `0OIl`. Solana public keys land in 32-44 characters. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ---------------------------------------------------------------------------
// Hard floors
// ---------------------------------------------------------------------------

/**
 * Safety limits that a config file may not cross, checked at load time.
 *
 * These are deliberately *not* spread through the field definitions: they are
 * the rules an operator would want to audit in one place before trusting the
 * bot with a funded wallet. Widening one is a code change and a review, not a
 * config edit.
 */
export const LIMITS = {
  /** SOL held back for fees. Below this the bot can lose its ability to sell. */
  MIN_RESERVED_GAS_SOL: 0.02,
  /** 20%. Above this, "slippage tolerance" is just consent to being drained. */
  MAX_SLIPPAGE_BPS: 2_000,
  /**
   * 5 minutes. Above this the copy-trade premise is gone: a five-minute-old
   * memecoin signal is indistinguishable from buying a mint at random.
   */
  MAX_SIGNAL_AGE_MS: 300_000,
  /**
   * 5 seconds, and this floor matters more than it looks.
   *
   * Signal age is measured against `blockTime`, which is **not a clock**. It is
   * a stake-weighted median of what the cluster's validators claimed the time
   * was, so it drifts from wall clock by seconds in normal operation and
   * further under load — and it can move backwards between adjacent slots.
   *
   * That means the measured age of a genuinely live swap is
   * `network latency + RPC round trip + blockTime drift`, and the last term
   * dominates the first two. A tuning value like 2000 would not be "a tighter
   * copy window"; it would reject signal that arrived instantly, intermittently,
   * for a reason nobody watching the rejection counter would guess. Better to
   * refuse the config than to ship a bot that silently declines to trade.
   */
  MIN_SIGNAL_AGE_MS: 5_000,
} as const;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ConfigObject = z
  .object({
    /** `paper` simulates every fill. `live` submits real transactions. */
    mode: z.enum(['paper', 'live']).default('paper'),

    /**
     * Opt-in required to run in `live` mode. Defaults false so that flipping
     * `mode` alone is never sufficient to start spending real SOL.
     */
    acknowledgeLiveRisk: z.boolean().default(false),

    /** Base58 wallet addresses to mirror. */
    trackedWallets: z
      .array(
        z
          .string()
          .regex(BASE58_ADDRESS, 'must be a base58 Solana address (32-44 chars)'),
      )
      .default([]),

    /** SOL committed per entry. */
    positionSizeSol: z.number().finite().default(0.05),

    /** Hard cap on concurrently open positions. */
    maxConcurrentPositions: z.number().int().positive().default(3),

    /** Slippage ceiling applied to every swap, basis points. */
    maxSlippageBps: z.number().int().nonnegative().default(300),

    /**
     * SOL never available to the trading logic. This is the bot's guaranteed
     * ability to sell: exits cost fees too, and a wallet that spent its last
     * lamport on an entry cannot close the position it just opened.
     */
    reservedGasSol: z.number().finite().default(0.03),

    /** Priority fee attached to swap transactions. Ignored in paper mode. */
    priorityFeeMicroLamports: z.number().int().nonnegative().default(200_000),

    /** Realized loss in a UTC day that trips the kill switch. */
    maxDailyLossSol: z.number().positive().default(0.5),

    /** Skip any pair whose pool holds less than this, in USD. */
    minLiquidityUsd: z.number().nonnegative().default(15_000),

    /**
     * How old a tracked wallet's swap may be and still be worth mirroring, ms.
     *
     * A copy-trading entry is a bet that the price has not yet moved to reflect
     * what the tracked wallet did. That bet has a shelf life measured in
     * seconds; past it the trade is not a worse version of the same strategy,
     * it is a different strategy nobody chose — buying into a move that has
     * already happened.
     *
     * The gate this feeds exists for one specific failure: the websocket drops,
     * reconnects twenty minutes later, and the gap fill hands the strategy the
     * whole backlog at once, at full position size, against prices that are
     * twenty minutes stale. Startup is safe from this today only because the
     * status flip happens to land after the first gap fill — an accident of
     * initialisation order rather than a rule. This is the rule.
     *
     * The 300 s ceiling below is a hard floor-style limit, not advice. A value
     * above it is not "a longer copy window"; it is the check having been
     * disabled by accident.
     */
    maxSignalAgeMs: z.number().int().positive().default(15_000),

    /**
     * Which strategy decides what to trade. Resolved by
     * `services/strategyRegistry.ts` at the composition root.
     *
     * A plain string, **not** an enum, and that is deliberate. Validating the
     * name here would mean `core/` knowing the set of strategies, which lives
     * in `services/` — an import pointing the wrong way down the dependency
     * chain. The cost is that a typo is caught when the runtime is built rather
     * than when the config is parsed; the registry throws by name and lists
     * what it does know, so the failure is loud and immediate either way.
     *
     * Optional in the file: an existing `config.json` written before strategies
     * existed still loads, and still gets `mirror`.
     */
    strategy: z.string().min(1).default('mirror'),

    /** Starting balance for the simulated wallet in paper mode. */
    paperStartingSol: z.number().positive().default(5),

    /**
     * Compute-unit limit assumed for a swap transaction.
     *
     * Turns `priorityFeeMicroLamports` (which is per compute unit) into a
     * lamport cost: `ceil(microLamports * computeUnitLimit / 1e6)`. 400,000 is
     * realistic for a single-hop Jupiter swap through Raydium or Pump.fun;
     * multi-hop routes exceed it.
     *
     * **A recalibration knob, alongside `paperLatencyPenaltyBps`.** The live
     * broker should eventually set this limit explicitly from simulation, and
     * paper should track whatever it sets. Until then it is an estimate.
     */
    computeUnitLimit: z.number().int().positive().default(400_000),

    /**
     * Adverse price movement assumed between quoting and landing, in bps,
     * applied to whatever the bot receives.
     *
     * **This is a guess.** 30 bps is a placeholder for the latency between a
     * quote and a confirmed transaction, and it has not been measured against
     * anything. Until it is recalibrated from live fills, **paper P&L is an
     * upper bound on real P&L** — the real cost of being late is whatever the
     * market did in that window, which on a moving memecoin is routinely worse
     * than 30 bps and is never better in expectation.
     */
    paperLatencyPenaltyBps: z.number().int().nonnegative().max(10_000).default(30),

    // --- quote adapter -----------------------------------------------------

    /** Jupiter Swap API base. The paid host is selected by `JUPITER_API_KEY`. */
    jupiterBaseUrl: z.string().url().default('https://lite-api.jup.ag/swap/v1'),

    /**
     * Restrict routes to liquid intermediate tokens.
     *
     * Exotic multi-hop routes quote well and fill badly. Configurable so the
     * Prompt 12 replay harness can measure both settings rather than assume.
     */
    jupiterRestrictIntermediateTokens: z.boolean().default(true),

    /** Per-attempt HTTP timeout for a quote. */
    quoteTimeoutMs: z.number().int().positive().default(2_000),

    /**
     * Ceiling across all retries of one quote.
     *
     * A caller budgets latency once; retries must not silently exceed it.
     */
    quoteTotalDeadlineMs: z.number().int().positive().default(6_000),

    /** How long a successful quote stays reusable. */
    quoteCacheTtlMs: z.number().int().nonnegative().default(1_500),

    /**
     * How long a NO_ROUTE answer stays reusable. Deliberately shorter than
     * `quoteCacheTtlMs`: a freshly launched mint becomes routable within
     * seconds, and caching "unroutable" for too long makes the bot blind to it.
     */
    noRouteCacheTtlMs: z.number().int().nonnegative().default(500),

    /**
     * Probe size for deriving a price, in lamports.
     *
     * A price is taken from a real quote of this size so it reflects routable
     * liquidity rather than an oracle print. A number here (not a bigint)
     * because config is JSON; it is converted at the adapter boundary.
     */
    priceProbeLamports: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .default(100_000_000),
  })
  .strict();

/**
 * The floors above, applied after field parsing.
 *
 * `superRefine` rather than chained `.refine`s so that a config violating
 * several limits reports all of them at once — an operator fixing a config
 * file should not have to rerun to discover the next problem.
 */
export const ConfigSchema = ConfigObject.superRefine((config, ctx) => {
  if (config.reservedGasSol < LIMITS.MIN_RESERVED_GAS_SOL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reservedGasSol'],
      message: `must be at least ${LIMITS.MIN_RESERVED_GAS_SOL} SOL — below this the bot may be unable to pay for its own exits`,
    });
  }

  if (config.maxSlippageBps > LIMITS.MAX_SLIPPAGE_BPS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxSlippageBps'],
      message: `must be at most ${LIMITS.MAX_SLIPPAGE_BPS} bps (${LIMITS.MAX_SLIPPAGE_BPS / 100}%)`,
    });
  }

  if (config.maxSignalAgeMs > LIMITS.MAX_SIGNAL_AGE_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxSignalAgeMs'],
      message: `must be at most ${LIMITS.MAX_SIGNAL_AGE_MS} ms (${LIMITS.MAX_SIGNAL_AGE_MS / 1_000}s) — beyond that the copy-trade premise no longer holds`,
    });
  }

  if (config.maxSignalAgeMs < LIMITS.MIN_SIGNAL_AGE_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxSignalAgeMs'],
      message: `must be at least ${LIMITS.MIN_SIGNAL_AGE_MS} ms — blockTime drifts seconds from wall clock, so a tighter window rejects live signal as stale`,
    });
  }

  if (config.positionSizeSol <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['positionSizeSol'],
      message: 'must be greater than 0',
    });
  }

  if (config.mode === 'live' && config.acknowledgeLiveRisk !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['acknowledgeLiveRisk'],
      message:
        'must be true to run in live mode — live mode spends real SOL and can lose all of it',
    });
  }
});

export type Config = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown for any config problem: unreadable file, bad JSON, failed validation. */
export class ConfigError extends Error {
  /** One entry per validation failure, `path: message`. Empty for I/O errors. */
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(issues.length > 0 ? `${message}\n  - ${issues.join('\n  - ')}` : message);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Validate an already-parsed config object and apply defaults.
 * Pure. Throws `ConfigError` listing every violation.
 */
export function parseConfig(input: unknown): Config {
  const result = ConfigSchema.safeParse(input);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  });
  throw new ConfigError('Invalid config', issues);
}

/**
 * Read, parse, and validate `config.json`.
 * Throws `ConfigError` if the file is missing, malformed, or invalid.
 */
export function loadConfig(path = 'config.json'): Config {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(
      `Cannot read config file at ${path} — copy config.example.json to get started`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ConfigError(
      `Config file at ${path} is not valid JSON: ${(cause as Error).message}`,
    );
  }

  return parseConfig(parsed);
}
