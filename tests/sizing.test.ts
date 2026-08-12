import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DID_NOT_CONVERGE,
  breakevenWinRate,
  decide,
  deflatedWinProb,
  edgeOverBreakeven,
  explainDecision,
  normalInvCdf,
  payoffRatio,
  portfolioHeatCap,
  priceImpact,
  rawWinRate,
  roundTripCost,
  selectionZ,
  shrunkWinRate,
  sizePosition,
  standardError,
  survivingAlpha,
} from '../src/core/sizing.js';
import type { Decision, EdgeParams, Latency, PoolState, TradeProfile } from '../src/core/sizing.js';

// ---------------------------------------------------------------------------
// The conformance fixture
// ---------------------------------------------------------------------------

interface Fixture {
  tolerance: number;
  normalInvCdf: { p: number; expected: number | string }[];
  portfolioHeatCap: {
    name: string;
    openPositionsSol: number[];
    equitySol: number;
    proposedSol: number;
    maxHeat: number;
    assumedCorrelation: number;
    expected: number | string;
  }[];
  vectors: {
    name: string;
    edge: EdgeParams;
    trade: TradeProfile;
    pool: PoolState;
    latency: Latency;
    equitySol: number;
    limits: Record<string, number>;
    expected: Record<string, number | string | boolean>;
  }[];
}

const fixture: Fixture = JSON.parse(
  readFileSync(new URL('./fixtures/sizing-conformance.json', import.meta.url), 'utf8'),
);

/** JSON has no Infinity; the fixture encodes non-finite numbers as strings. */
function decodeNumber(value: number | string): number {
  if (typeof value === 'number') return value;
  if (value === 'Infinity') return Number.POSITIVE_INFINITY;
  if (value === '-Infinity') return Number.NEGATIVE_INFINITY;
  if (value === 'NaN') return Number.NaN;
  throw new Error(`not a number encoding: ${value}`);
}

/**
 * Dispatch on the field NAME, not the value's type: `bindingConstraint` is a
 * string and so is an encoded Infinity, and nothing in the value distinguishes
 * them. The Python checker makes the same split for the same reason.
 */
const EXACT_FIELDS = new Set(['take', 'converged', 'bindingConstraint']);

function expectClose(got: number, want: number | string, label: string): void {
  const target = decodeNumber(want);
  if (Number.isNaN(target)) {
    expect(got, label).toBeNaN();
    return;
  }
  if (!Number.isFinite(target)) {
    expect(got, label).toBe(target);
    return;
  }
  expect(Math.abs(got - target), `${label}: got ${got}, fixture ${target}`).toBeLessThanOrEqual(
    fixture.tolerance,
  );
}

describe('sizing conformance with analysis/master_equation.py', () => {
  /**
   * Pinned on its own because it is the one hand-transcribed piece. The Python
   * reaches CPython's C `_normal_dist_inv_cdf`; this port writes out Wichura
   * AS241 by hand. A drift here surfaces as an unexplained size mismatch three
   * layers up unless it is checked directly.
   */
  it('normalInvCdf matches NormalDist().inv_cdf at every pinned point', () => {
    expect(fixture.normalInvCdf.length).toBeGreaterThan(10);
    for (const point of fixture.normalInvCdf) {
      expectClose(normalInvCdf(point.p), point.expected, `invCdf(${point.p})`);
    }
  });

  it('portfolioHeatCap matches portfolio_heat_cap', () => {
    for (const h of fixture.portfolioHeatCap) {
      expectClose(
        portfolioHeatCap(
          h.openPositionsSol,
          h.equitySol,
          h.proposedSol,
          h.maxHeat,
          h.assumedCorrelation,
        ),
        h.expected,
        `heatCap[${h.name}]`,
      );
    }
  });

  it('sizePosition matches size_position on every vector, field for field', () => {
    expect(fixture.vectors.length).toBeGreaterThan(10);
    for (const v of fixture.vectors) {
      const got = sizePosition(v.edge, v.trade, v.pool, v.latency, v.equitySol, v.limits);
      for (const [field, want] of Object.entries(v.expected)) {
        const value = got[field as keyof Decision];
        if (EXACT_FIELDS.has(field)) {
          expect(value, `${v.name}: ${field}`).toBe(want);
        } else {
          expectClose(value as number, want as number | string, `${v.name}: ${field}`);
        }
      }
    }
  });

  /**
   * The fixture is written FROM the reference, so a vector set that no longer
   * reaches a branch would still pass while proving nothing about it. Assert
   * the coverage the vectors were chosen for.
   */
  it('the vectors reach every binding constraint', () => {
    const seen = new Set(fixture.vectors.map((v) => v.expected.bindingConstraint));
    for (const constraint of [
      'Kelly',
      'pool depth cap',
      'max equity fraction',
      'EV gate closed',
      'costs exceed the decayed gross win',
    ]) {
      expect(seen, `no vector reaches "${constraint}"`).toContain(constraint);
    }
    expect(fixture.vectors.some((v) => v.expected.converged === false)).toBe(true);
    expect(fixture.vectors.some((v) => v.expected.take === true)).toBe(true);
    expect(fixture.vectors.some((v) => v.expected.take === false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Behaviour the fixture cannot express
// ---------------------------------------------------------------------------

const EDGE: EdgeParams = { wins: 60, trades: 100 };
const TRADE: TradeProfile = { grossWin: 0.5, grossLoss: 0.4 };
const POOL: PoolState = { depthSol: 41.666666666666664, priorityFeeSol: 8e-5, exitDepthRatio: 0.7 };
const FAST: Latency = { delayS: 5.479, halfLifeS: 30 };

describe('decide refuses a non-converged fixed point', () => {
  /**
   * The reference has no such refusal — it returns whatever the iteration
   * reached. That is the one deliberate divergence in this port, and it lives
   * in `decide` rather than `sizePosition` so the port stays comparable to the
   * reference field for field.
   */
  it('sizePosition still returns the unconverged size, as the reference does', () => {
    const shrunk: EdgeParams = { wins: 9, trades: 10, priorStrength: 40, priorMean: 0.45 };
    const raw = sizePosition(
      shrunk,
      { grossWin: 0.8, grossLoss: 0.4 },
      { depthSol: 100, priorityFeeSol: 8e-5 },
      { delayS: 1, halfLifeS: 30 },
      5,
      { maxIterations: 1 },
    );
    expect(raw.converged).toBe(false);
    expect(raw.take).toBe(true);
    expect(raw.sizeSol).toBeGreaterThan(0);
  });

  it('decide zeroes it and says why', () => {
    const shrunk: EdgeParams = { wins: 9, trades: 10, priorStrength: 40, priorMean: 0.45 };
    const d = decide(
      shrunk,
      { grossWin: 0.8, grossLoss: 0.4 },
      { depthSol: 100, priorityFeeSol: 8e-5 },
      { delayS: 1, halfLifeS: 30 },
      5,
      { maxIterations: 1 },
    );
    expect(d.converged).toBe(false);
    expect(d.take).toBe(false);
    expect(d.sizeSol).toBe(0);
    expect(d.bindingConstraint).toBe(DID_NOT_CONVERGE);
  });

  it('decide passes a converged decision through untouched', () => {
    const raw = sizePosition(EDGE, TRADE, POOL, FAST, 5);
    const d = decide(EDGE, TRADE, POOL, FAST, 5);
    expect(raw.converged).toBe(true);
    expect(d).toEqual(raw);
  });

  it('every intermediate survives the refusal, so it can be explained', () => {
    const shrunk: EdgeParams = { wins: 9, trades: 10, priorStrength: 40, priorMean: 0.45 };
    const d = decide(
      shrunk,
      { grossWin: 0.8, grossLoss: 0.4 },
      { depthSol: 100, priorityFeeSol: 8e-5 },
      { delayS: 1, halfLifeS: 30 },
      5,
      { maxIterations: 1 },
    );
    expect(d.winProb).toBeGreaterThan(0);
    expect(d.kellyFull).toBeGreaterThan(0);
    expect(Number.isFinite(d.expectedValue)).toBe(true);
    expect(Number.isFinite(d.cost)).toBe(true);
  });
});

describe('input validation', () => {
  it.each([
    ['trades of zero', () => rawWinRate({ wins: 0, trades: 0 })],
    ['negative trades', () => rawWinRate({ wins: 0, trades: -1 })],
    ['wins above trades', () => rawWinRate({ wins: 11, trades: 10 })],
    ['negative wins', () => rawWinRate({ wins: -1, trades: 10 })],
    ['walletsScreened below one', () => selectionZ({ wins: 1, trades: 10, walletsScreened: 0 })],
    ['priorMean at one', () => shrunkWinRate({ wins: 1, trades: 10, priorMean: 1 })],
    ['priorMean at zero', () => shrunkWinRate({ wins: 1, trades: 10, priorMean: 0 })],
    ['negative priorStrength', () => shrunkWinRate({ wins: 1, trades: 10, priorStrength: -1 })],
    ['depth of zero', () => roundTripCost({ depthSol: 0 }, 1)],
    ['exitDepthRatio above one', () => priceImpact({ depthSol: 10, exitDepthRatio: 1.5 }, 1)],
    ['exitDepthRatio of zero', () => priceImpact({ depthSol: 10, exitDepthRatio: 0 }, 1)],
    ['negative delay', () => survivingAlpha({ delayS: -1, halfLifeS: 30 })],
    ['half-life of zero', () => survivingAlpha({ delayS: 1, halfLifeS: 0 })],
    ['gross win of zero', () => payoffRatio({ grossWin: 0, grossLoss: 0.4 })],
    ['gross loss of zero', () => payoffRatio({ grossWin: 0.5, grossLoss: 0 })],
    ['equity of zero', () => sizePosition(EDGE, TRADE, POOL, FAST, 0)],
    ['kellyFraction above one', () => sizePosition(EDGE, TRADE, POOL, FAST, 5, { kellyFraction: 2 })],
    ['kellyFraction of zero', () => sizePosition(EDGE, TRADE, POOL, FAST, 5, { kellyFraction: 0 })],
    ['depthCap above one', () => sizePosition(EDGE, TRADE, POOL, FAST, 5, { depthCap: 1.5 })],
    [
      'maxEquityFraction of zero',
      () => sizePosition(EDGE, TRADE, POOL, FAST, 5, { maxEquityFraction: 0 }),
    ],
    ['equity that is NaN', () => sizePosition(EDGE, TRADE, POOL, FAST, Number.NaN)],
    ['heat cap with zero equity', () => portfolioHeatCap([], 0, 1)],
  ])('rejects %s', (_label, call) => {
    expect(call).toThrow(RangeError);
  });

  it.each([0, 1, -0.5, 1.5, Number.NaN])('normalInvCdf rejects p = %s', (p) => {
    expect(() => normalInvCdf(p)).toThrow(RangeError);
  });
});

describe('the pieces, independently of the reference', () => {
  it('deflation only ever lowers the win probability', () => {
    const base = deflatedWinProb({ wins: 60, trades: 100, walletsScreened: 1 });
    let previous = base;
    for (const m of [13, 43, 200, 10_000]) {
      const deflated = deflatedWinProb({ wins: 60, trades: 100, walletsScreened: m });
      expect(deflated).toBeLessThan(previous);
      previous = deflated;
    }
    expect(base).toBeLessThanOrEqual(rawWinRate({ wins: 60, trades: 100 }));
  });

  /**
   * The prompt-19 claim that a large sample makes the M sweep inert. It does —
   * but only for M. The half-life band runs through `survivingAlpha`, which
   * never sees `trades`, so sample size cannot swamp it. The two bands are not
   * the same kind of check and this pins the difference.
   */
  it('the M haircut shrinks with sample size, and the half-life is untouched by it', () => {
    const small = 0.6 - deflatedWinProb({ wins: 6, trades: 10, walletsScreened: 43 });
    const large = 0.6 - deflatedWinProb({ wins: 336, trades: 560, walletsScreened: 43 });
    expect(large).toBeLessThan(small);
    expect(large).toBeLessThan(0.05);

    // Same latency, wildly different n: identical surviving alpha.
    expect(survivingAlpha({ delayS: 5.479, halfLifeS: 30 })).toBe(
      survivingAlpha({ delayS: 5.479, halfLifeS: 30 }),
    );
  });

  it('standard error falls as the square root of n', () => {
    const one = standardError({ wins: 50, trades: 100 });
    const four = standardError({ wins: 200, trades: 400 });
    expect(Math.abs(one / four - 2)).toBeLessThan(1e-12);
  });

  it('round-trip cost is U-shaped in size', () => {
    const pool: PoolState = { depthSol: 100, priorityFeeSol: 0.01 };
    const tiny = roundTripCost(pool, 0.001);
    const middle = roundTripCost(pool, 1);
    const huge = roundTripCost(pool, 200);
    expect(middle).toBeLessThan(tiny);
    expect(middle).toBeLessThan(huge);
  });

  it('a thinner exit costs more than a symmetric one', () => {
    const symmetric = priceImpact({ depthSol: 100, exitDepthRatio: 1 }, 10);
    const thin = priceImpact({ depthSol: 100, exitDepthRatio: 0.5 }, 10);
    expect(thin).toBeGreaterThan(symmetric);
  });

  it('surviving alpha halves every half-life', () => {
    expect(survivingAlpha({ delayS: 30, halfLifeS: 30 })).toBeCloseTo(0.5, 12);
    expect(survivingAlpha({ delayS: 60, halfLifeS: 30 })).toBeCloseTo(0.25, 12);
    expect(survivingAlpha({ delayS: 0, halfLifeS: 30 })).toBe(1);
  });

  it('breakeven is 1.0 when the trade cannot win', () => {
    expect(breakevenWinRate(0, 0.4)).toBe(1);
    expect(breakevenWinRate(-0.1, 0.4)).toBe(1);
    expect(breakevenWinRate(0.4, 0.4)).toBeCloseTo(0.5, 12);
  });

  /**
   * The sourcing error prompt 19 forbids, measured. Feeding the +150%
   * take-profit target as `grossWin` instead of the realised payoff moves
   * breakeven from the seventies to about 21%, and that gap is the whole of the
   * apparent edge.
   */
  it('the take-profit target and the realised payoff give different breakevens', () => {
    const fromTarget = breakevenWinRate(1.5, 0.4);
    const fromRealised = breakevenWinRate(0.038, 0.4);
    expect(fromTarget).toBeCloseTo(0.2105, 4);
    expect(fromRealised).toBeGreaterThan(0.9);
  });

  it('heat trims to the remaining room and never below zero', () => {
    expect(portfolioHeatCap([0.5, 0.25], 5, 1)).toBeCloseTo(0.75, 12);
    expect(portfolioHeatCap([0.1], 5, 0.2)).toBeCloseTo(0.2, 12);
    expect(portfolioHeatCap([1.5], 5, 0.5)).toBe(0);
    expect(portfolioHeatCap([], 5, 2)).toBeCloseTo(1.5, 12);
  });

  it('edgeOverBreakeven is the signed distance to the breakeven rate', () => {
    const d = sizePosition(EDGE, TRADE, POOL, FAST, 5);
    expect(edgeOverBreakeven(d)).toBeCloseTo(d.winProb - d.breakevenWinRate, 15);
  });

  it('explainDecision names the constraint on both paths', () => {
    const taken = sizePosition(EDGE, TRADE, POOL, FAST, 5);
    expect(taken.take).toBe(true);
    expect(explainDecision(taken)).toContain('TAKE');
    expect(explainDecision(taken)).toContain(taken.bindingConstraint);

    const skipped = sizePosition(EDGE, TRADE, POOL, FAST, 5, { evThreshold: 10 });
    expect(skipped.take).toBe(false);
    expect(explainDecision(skipped)).toContain('SKIP');
    expect(explainDecision(skipped)).toContain('EV gate closed');
  });

  it('a refused decision reports a size of exactly zero, not a small one', () => {
    const d = sizePosition(EDGE, TRADE, POOL, FAST, 5, { evThreshold: 10 });
    expect(d.sizeSol).toBe(0);
  });
});

describe('purity', () => {
  it('is deterministic across repeated calls', () => {
    const first = sizePosition(EDGE, TRADE, POOL, FAST, 5);
    for (let i = 0; i < 50; i += 1) {
      expect(sizePosition(EDGE, TRADE, POOL, FAST, 5)).toEqual(first);
    }
  });

  it('does not mutate its inputs', () => {
    const edge = { ...EDGE };
    const trade = { ...TRADE };
    const pool = { ...POOL };
    const latency = { ...FAST };
    sizePosition(edge, trade, pool, latency, 5);
    expect(edge).toEqual(EDGE);
    expect(trade).toEqual(TRADE);
    expect(pool).toEqual(POOL);
    expect(latency).toEqual(FAST);
  });

  /**
   * `core/` may not reach a clock, a random source, the network or a service.
   * `equation.ts` is greppped for the same three for the same reason: prompt 12
   * promises byte-identical replays and these are what break that promise.
   */
  it('imports nothing and touches no ambient source of nondeterminism', () => {
    const source = readFileSync(new URL('../src/core/sizing.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of [
      'Date.now',
      'Math.random',
      'fetch(',
      'process.',
      'require(',
      'readFileSync',
    ]) {
      expect(code, `sizing.ts must not use ${forbidden}`).not.toContain(forbidden);
    }
    expect(code, 'sizing.ts must not import anything').not.toMatch(/^\s*import\s/m);
  });
});

// ---------------------------------------------------------------------------
// The buy path must NOT be wired yet
// ---------------------------------------------------------------------------

describe('the sizing module is not yet reachable from the trading path', () => {
  /**
   * Deliberate, and this test is the record of it. `edge.wins/edge.trades` is
   * specified as a latency-adjusted win rate for THIS process, and that
   * measurement exists for one of the twelve tracked wallets, at n=15, on a
   * pre-routing-fix sample. Sizing off the wallets' own realised rates instead
   * refuses every wallet at every swept parameter, and the only parameter set
   * that opens anything is an untrimmed mean carried by a single trade.
   *
   * Delete this test when the delay-replay campaign lands and the buy path is
   * wired — not before, and not to make something else pass.
   */
  it.each(['src/strategies/mirror.ts', 'src/strategies/equation.ts', 'src/services/tracker.ts'])(
    '%s does not import sizing',
    (path) => {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
      expect(source).not.toContain('sizing.js');
    },
  );

  it('no sell path can call sizePosition, because nothing calls it at all', () => {
    // Asserted rather than merely avoided, per the prompt. When the entry path
    // is wired this becomes a narrower assertion about the SELL path only.
    const roots = ['src/strategies/mirror.ts', 'src/strategies/equation.ts'];
    for (const path of roots) {
      const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
      expect(source).not.toContain('sizePosition');
      expect(source).not.toContain('decide(');
    }
  });
});
