import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError, LIMITS, loadConfig, parseConfig } from '../src/core/config.js';

/** A real base58 mint address, used wherever a valid wallet is needed. */
const VALID_ADDRESS = 'So11111111111111111111111111111111111111112';

/** Collect the `path: message` strings a rejected config produced. */
function issuesOf(input: unknown): readonly string[] {
  try {
    parseConfig(input);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error('expected parseConfig to throw, but it succeeded');
}

describe('defaults', () => {
  it('produces a complete paper-mode config from an empty object', () => {
    expect(parseConfig({})).toEqual({
      mode: 'paper',
      acknowledgeLiveRisk: false,
      trackedWallets: [],
      positionSizeSol: 0.05,
      maxConcurrentPositions: 3,
      maxSlippageBps: 300,
      reservedGasSol: 0.03,
      priorityFeeMicroLamports: 200_000,
      maxDailyLossSol: 0.5,
      maxSignalAgeMs: 15_000,
      minLiquidityUsd: 15_000,
      paperStartingSol: 5,
      computeUnitLimit: 400_000,
      paperLatencyPenaltyBps: 30,
      jupiterBaseUrl: 'https://lite-api.jup.ag/swap/v1',
      jupiterRestrictIntermediateTokens: true,
      quoteTimeoutMs: 2_000,
      quoteTotalDeadlineMs: 6_000,
      quoteCacheTtlMs: 1_500,
      noRouteCacheTtlMs: 500,
      priceProbeLamports: 100_000_000,
      strategy: 'mirror',
    });
  });

  it('rejects unknown keys rather than silently ignoring them', () => {
    expect(() => parseConfig({ positionSizeSOL: 0.1 })).toThrow(ConfigError);
  });
});

describe('strategy selection', () => {
  /**
   * A `config.json` written before strategies existed. Copied verbatim from
   * `config.example.json` as it stood at handoff 09, so this is the real shape
   * an operator already has on disk — not a minimal stand-in for it.
   */
  const PRE_STRATEGY_CONFIG = {
    mode: 'paper',
    acknowledgeLiveRisk: false,
    trackedWallets: [],
    positionSizeSol: 0.05,
    maxConcurrentPositions: 3,
    maxSlippageBps: 300,
    reservedGasSol: 0.03,
    priorityFeeMicroLamports: 200_000,
    maxDailyLossSol: 0.5,
    maxSignalAgeMs: 15_000,
    minLiquidityUsd: 15_000,
    paperStartingSol: 5,
    computeUnitLimit: 400_000,
    paperLatencyPenaltyBps: 30,
    jupiterBaseUrl: 'https://lite-api.jup.ag/swap/v1',
    jupiterRestrictIntermediateTokens: true,
    quoteTimeoutMs: 2_000,
    quoteTotalDeadlineMs: 6_000,
    quoteCacheTtlMs: 1_500,
    noRouteCacheTtlMs: 500,
    priceProbeLamports: 100_000_000,
  };

  it('loads an existing config that predates the field, and defaults to mirror', () => {
    const config = parseConfig(PRE_STRATEGY_CONFIG);
    expect(config.strategy).toBe('mirror');
  });

  it('leaves every other value in that config exactly as written', () => {
    // The additive edit must be additive. A default that also moved something
    // else would change how an existing deployment behaves on upgrade.
    const config = parseConfig(PRE_STRATEGY_CONFIG);
    const { strategy, ...rest } = config;
    void strategy;
    expect(rest).toEqual(PRE_STRATEGY_CONFIG);
  });

  it('still applies every floor to that config', () => {
    // Adding a field must not have created a path that skips `superRefine`.
    expect(() =>
      parseConfig({ ...PRE_STRATEGY_CONFIG, reservedGasSol: 0.019 }),
    ).toThrow(ConfigError);
    expect(() =>
      parseConfig({ ...PRE_STRATEGY_CONFIG, maxSlippageBps: LIMITS.MAX_SLIPPAGE_BPS + 1 }),
    ).toThrow(ConfigError);
    expect(() => parseConfig({ ...PRE_STRATEGY_CONFIG, positionSizeSol: 0 })).toThrow(ConfigError);
    expect(() => parseConfig({ ...PRE_STRATEGY_CONFIG, mode: 'live' })).toThrow(ConfigError);
  });

  it('accepts a named strategy', () => {
    expect(parseConfig({ strategy: 'equation' }).strategy).toBe('equation');
  });

  it('rejects an empty name rather than falling back to the default', () => {
    // An empty string is a mistake, not an instruction to use mirror. Silently
    // defaulting would run a strategy the operator did not ask for.
    expect(() => parseConfig({ strategy: '' })).toThrow(ConfigError);
  });

  it('accepts an unknown name — the registry is what rejects it, at startup', () => {
    // Deliberate: validating the set here would mean `core/` importing the
    // registry from `services/`, which is the wrong way down the dependency
    // chain. `createStrategy` throws by name instead.
    expect(parseConfig({ strategy: 'nonexistent' }).strategy).toBe('nonexistent');
  });
});

describe('floor: reservedGasSol >= 0.02', () => {
  it('rejects a reserve below the floor', () => {
    expect(() => parseConfig({ reservedGasSol: 0.019 })).toThrow(ConfigError);
    expect(issuesOf({ reservedGasSol: 0.019 })).toEqual([
      expect.stringContaining('reservedGasSol'),
    ]);
  });

  it('rejects a zero reserve', () => {
    expect(() => parseConfig({ reservedGasSol: 0 })).toThrow(ConfigError);
  });

  it('rejects a negative reserve', () => {
    expect(() => parseConfig({ reservedGasSol: -0.05 })).toThrow(ConfigError);
  });

  it('accepts exactly the floor', () => {
    expect(parseConfig({ reservedGasSol: LIMITS.MIN_RESERVED_GAS_SOL }).reservedGasSol).toBe(
      0.02,
    );
  });
});

describe('floor: maxSlippageBps <= 2000', () => {
  it('rejects slippage above the ceiling', () => {
    expect(() => parseConfig({ maxSlippageBps: 2_001 })).toThrow(ConfigError);
    expect(issuesOf({ maxSlippageBps: 2_001 })).toEqual([
      expect.stringContaining('maxSlippageBps'),
    ]);
  });

  it('rejects a wildly permissive value', () => {
    expect(() => parseConfig({ maxSlippageBps: 10_000 })).toThrow(ConfigError);
  });

  it('accepts exactly the ceiling', () => {
    expect(parseConfig({ maxSlippageBps: LIMITS.MAX_SLIPPAGE_BPS }).maxSlippageBps).toBe(2_000);
  });
});

describe('band: 5_000 <= maxSignalAgeMs <= 300_000', () => {
  it('defaults to 15 seconds', () => {
    expect(parseConfig({}).maxSignalAgeMs).toBe(15_000);
  });

  it('rejects a window past the ceiling', () => {
    expect(() => parseConfig({ maxSignalAgeMs: 300_001 })).toThrow(ConfigError);
    expect(issuesOf({ maxSignalAgeMs: 300_001 })).toEqual([
      expect.stringContaining('maxSignalAgeMs'),
    ]);
  });

  it('accepts exactly the ceiling', () => {
    expect(parseConfig({ maxSignalAgeMs: LIMITS.MAX_SIGNAL_AGE_MS }).maxSignalAgeMs).toBe(300_000);
  });

  /**
   * The floor is the less obvious half, and the one that would bite silently.
   * `blockTime` is a stake-weighted median rather than a clock, so a genuinely
   * live swap routinely measures several seconds old. A 2s window would refuse
   * it — intermittently, with no error, surfacing only as a bot that quietly
   * stopped trading. Refusing the config is the loud version of that failure.
   */
  it('rejects a window below the floor', () => {
    expect(() => parseConfig({ maxSignalAgeMs: 2_000 })).toThrow(ConfigError);
    expect(issuesOf({ maxSignalAgeMs: 2_000 })).toEqual([
      expect.stringContaining('maxSignalAgeMs'),
    ]);
  });

  it('accepts exactly the floor', () => {
    expect(parseConfig({ maxSignalAgeMs: LIMITS.MIN_SIGNAL_AGE_MS }).maxSignalAgeMs).toBe(5_000);
  });

  it('rejects a non-integer', () => {
    expect(() => parseConfig({ maxSignalAgeMs: 15_000.5 })).toThrow(ConfigError);
  });

  it('rejects zero and negatives', () => {
    expect(() => parseConfig({ maxSignalAgeMs: 0 })).toThrow(ConfigError);
    expect(() => parseConfig({ maxSignalAgeMs: -1 })).toThrow(ConfigError);
  });
});

describe('floor: positionSizeSol > 0', () => {
  it('rejects zero', () => {
    expect(() => parseConfig({ positionSizeSol: 0 })).toThrow(ConfigError);
    expect(issuesOf({ positionSizeSol: 0 })).toEqual([
      expect.stringContaining('positionSizeSol'),
    ]);
  });

  it('rejects a negative size', () => {
    expect(() => parseConfig({ positionSizeSol: -1 })).toThrow(ConfigError);
  });

  it('accepts a small positive size', () => {
    expect(parseConfig({ positionSizeSol: 0.001 }).positionSizeSol).toBe(0.001);
  });
});

describe('floor: live mode requires acknowledgeLiveRisk', () => {
  it('rejects live mode without the acknowledgement', () => {
    expect(() => parseConfig({ mode: 'live' })).toThrow(ConfigError);
    expect(issuesOf({ mode: 'live' })).toEqual([
      expect.stringContaining('acknowledgeLiveRisk'),
    ]);
  });

  it('rejects live mode with the acknowledgement explicitly false', () => {
    expect(() => parseConfig({ mode: 'live', acknowledgeLiveRisk: false })).toThrow(ConfigError);
  });

  it('accepts live mode once acknowledged', () => {
    const config = parseConfig({ mode: 'live', acknowledgeLiveRisk: true });
    expect(config.mode).toBe('live');
  });

  it('does not require the acknowledgement in paper mode', () => {
    expect(parseConfig({ mode: 'paper' }).mode).toBe('paper');
  });
});

describe('field validation', () => {
  it('rejects a non-base58 tracked wallet', () => {
    expect(() => parseConfig({ trackedWallets: ['not-a-wallet'] })).toThrow(ConfigError);
  });

  it('rejects an address containing base58-ambiguous characters', () => {
    expect(() =>
      parseConfig({ trackedWallets: ['0OIl1111111111111111111111111111111111111112'] }),
    ).toThrow(ConfigError);
  });

  it('accepts a valid address', () => {
    expect(parseConfig({ trackedWallets: [VALID_ADDRESS] }).trackedWallets).toEqual([
      VALID_ADDRESS,
    ]);
  });

  it('rejects a fractional maxConcurrentPositions', () => {
    expect(() => parseConfig({ maxConcurrentPositions: 2.5 })).toThrow(ConfigError);
  });

  it('rejects a zero daily loss limit', () => {
    expect(() => parseConfig({ maxDailyLossSol: 0 })).toThrow(ConfigError);
  });
});

describe('error reporting', () => {
  it('reports every violation at once', () => {
    const issues = issuesOf({
      mode: 'live',
      reservedGasSol: 0,
      maxSlippageBps: 5_000,
      positionSizeSol: 0,
    });
    expect(issues).toHaveLength(4);
    expect(issues.join('\n')).toContain('reservedGasSol');
    expect(issues.join('\n')).toContain('maxSlippageBps');
    expect(issues.join('\n')).toContain('positionSizeSol');
    expect(issues.join('\n')).toContain('acknowledgeLiveRisk');
  });
});

describe('loadConfig', () => {
  const dir = mkdtempSync(join(tmpdir(), 'solana-tracker-'));

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, contents: string): string {
    const path = join(dir, name);
    writeFileSync(path, contents, 'utf8');
    return path;
  }

  it('reads and validates a config file', () => {
    const path = write(
      'good.json',
      JSON.stringify({ positionSizeSol: 0.25, trackedWallets: [VALID_ADDRESS] }),
    );
    const config = loadConfig(path);
    expect(config.positionSizeSol).toBe(0.25);
    expect(config.maxConcurrentPositions).toBe(3);
  });

  it('throws on a missing file', () => {
    expect(() => loadConfig(join(dir, 'absent.json'))).toThrow(ConfigError);
  });

  it('throws on malformed JSON', () => {
    const path = write('broken.json', '{ "mode": "paper", }');
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  it('applies the floors to file contents', () => {
    const path = write('unsafe.json', JSON.stringify({ reservedGasSol: 0 }));
    expect(() => loadConfig(path)).toThrow(/reservedGasSol/);
  });
});
