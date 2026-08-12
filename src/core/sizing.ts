/**
 * Gated fractional-Kelly position sizing.
 *
 *     q* = min( A·λ·1{E > τ}·(p̃g − (1−p̃)l) / (g·l),  κ·Q )
 *
 * A TypeScript port of `analysis/master_equation.py`. **Python stays the
 * reference implementation** — calibration lives there, alongside numpy and
 * pandas, and this file exists only so the hot path does not have to spawn a
 * process inside the one latency-sensitive decision the bot makes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PURITY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No I/O, no network, no clock, no module-level mutable state, and no imports.
 * `core/`, like `guards.ts`. Every input arrives as an argument, which is what
 * makes a decision reproducible from its recorded row long after the market
 * state that produced it is gone.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CONFORMANCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tests/fixtures/sizing-conformance.json` pins input vectors against the
 * Python's own answers. Both suites check it:
 *
 *   npx vitest run tests/sizing.test.ts   — this port against the fixture
 *   python3 analysis/conformance.py      — the reference against the fixture
 *
 * They agree to 1e-9 on every numeric field. A divergence is a finding about
 * which implementation is wrong, not a tolerance to widen: both run IEEE-754
 * doubles, so identical operations in an identical order give identical bits,
 * and the arithmetic below is ordered to match the Python line for line even
 * where a different grouping would read better.
 *
 * The tolerance is absolute, so it catches a transcription error from about the
 * ninth significant digit onward — verified by flipping one AS241 exponent and
 * watching `invCdf(0.9)` fail by 0.446. It does NOT catch a slip in the final
 * two digits of a coefficient, which moves a size by ~1e-16 relative. That is
 * the intended sensitivity rather than an oversight.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE DOES NOT KNOW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Where its parameters came from, and whether they are any good. As of this
 * commit the buy path does NOT call it: `edge.wins/edge.trades` is specified as
 * a latency-adjusted win rate for THIS process, and no such measurement exists
 * for eleven of the twelve tracked wallets. Sizing off the wallets' own
 * realised win rates instead refuses every wallet at every swept parameter
 * (see `docs/handoffs/27-sizing-step0.md`). The port is here because it is
 * parameter-independent; the wiring is not, and waits.
 */

// ---------------------------------------------------------------------------
// Inverse normal CDF
// ---------------------------------------------------------------------------

/**
 * Φ⁻¹(p), by Wichura's AS241 (PPND16) rational approximation.
 *
 * Transcribed coefficient-for-coefficient from CPython's
 * `statistics._normal_dist_inv_cdf`, because `EdgeParams.selectionZ` calls
 * `NormalDist().inv_cdf` and the conformance fixture has to agree to 1e-9. This
 * is the single most likely place for the two implementations to drift, so it
 * is exported and pinned directly rather than only through a Decision.
 *
 * Accurate to about 1e-16 over the whole range.
 */
export function normalInvCdf(p: number): number {
  if (!(p > 0 && p < 1)) {
    throw new RangeError(`normalInvCdf requires p in (0, 1), got ${p}`);
  }

  const q = p - 0.5;
  let num: number;
  let den: number;

  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q;
    num =
      (((((((2.5090809287301226727e3 * r +
        3.3430575583588128105e4) * r +
        6.7265770927008700853e4) * r +
        4.5921953931549871457e4) * r +
        1.3731693765509461125e4) * r +
        1.9715909503065514427e3) * r +
        1.3314166789178437745e2) * r +
        3.387132872796366608e0) * q;
    den =
      ((((((5.226495278852854561e3 * r +
        2.8729085735721942674e4) * r +
        3.930789580092710610e4) * r +
        2.1213794301586595867e4) * r +
        5.3941960214247511077e3) * r +
        6.871870074920579083e2) * r +
        4.2313330701600911252e1) * r +
        1.0;
    return num / den;
  }

  let r = q <= 0.0 ? p : 1.0 - p;
  r = Math.sqrt(-Math.log(r));

  if (r <= 5.0) {
    r = r - 1.6;
    num =
      ((((((7.7454501427834140764e-4 * r +
        2.2723844989269184583e-2) * r +
        2.4178072517745061177e-1) * r +
        1.2704582524523683825e0) * r +
        3.6478483247632046050e0) * r +
        5.7694972214606914055e0) * r +
        4.6303378461565452959e0) * r +
        1.4234371107496835773e0;
    den =
      ((((((1.0507500716444168432e-9 * r +
        5.4759380849953449460e-4) * r +
        1.5198666563616457197e-2) * r +
        1.4810397642748007459e-1) * r +
        6.8976733498510000455e-1) * r +
        1.6763848301838038494e0) * r +
        2.0531916266377588219e0) * r +
        1.0;
  } else {
    r = r - 5.0;
    num =
      ((((((2.0103343992922881327e-7 * r +
        2.7115555687434875815e-5) * r +
        1.2426609473880784386e-3) * r +
        2.6532189526576123093e-2) * r +
        2.9656057182850489123e-1) * r +
        1.7848265399172913358e0) * r +
        5.4637849111641143699e0) * r +
        6.6579046435011037772e0;
    den =
      ((((((2.0442631033899397856e-15 * r +
        1.4215117583164458887e-7) * r +
        1.8463183175100546818e-5) * r +
        7.8686913114561329100e-4) * r +
        1.4875361290850614852e-2) * r +
        1.3692988092273580531e-1) * r +
        5.9983220655588793769e-1) * r +
        1.0;
  }

  const x = num / den;
  return q < 0.0 ? -x : x;
}

// ---------------------------------------------------------------------------
// Edge estimation
// ---------------------------------------------------------------------------

/**
 * Win-probability estimate, corrected for shrinkage and selection bias.
 *
 * Two corrections, in sequence:
 *
 *  1. Beta-binomial shrinkage toward `priorMean` with strength `priorStrength`,
 *     in pseudo-trades. Handles small samples.
 *  2. Selection deflation. A wallet picked as the best of `walletsScreened`
 *     candidates has an observed win rate that is an extreme order statistic,
 *     biased upward by roughly `selectionZ` standard errors.
 *
 * `priorStrength: 0` disables shrinkage, `walletsScreened: 1` disables
 * deflation, and both defaults are deliberately conservative.
 *
 * `wins` must be OUR wins, not the tracked wallet's — we do not get their
 * fills, we enter after them and exit after them, and their rate is an upper
 * bound on ours rather than an estimate of it.
 */
export interface EdgeParams {
  readonly wins: number;
  readonly trades: number;
  readonly walletsScreened?: number;
  readonly priorMean?: number;
  readonly priorStrength?: number;
}

interface ResolvedEdge {
  readonly wins: number;
  readonly trades: number;
  readonly walletsScreened: number;
  readonly priorMean: number;
  readonly priorStrength: number;
}

function resolveEdge(edge: EdgeParams): ResolvedEdge {
  const resolved: ResolvedEdge = {
    wins: edge.wins,
    trades: edge.trades,
    walletsScreened: edge.walletsScreened ?? 1,
    priorMean: edge.priorMean ?? 0.5,
    priorStrength: edge.priorStrength ?? 0.0,
  };
  if (!Number.isFinite(resolved.trades) || resolved.trades <= 0) {
    throw new RangeError(`trades must be positive, got ${resolved.trades}`);
  }
  if (!Number.isFinite(resolved.wins) || resolved.wins < 0 || resolved.wins > resolved.trades) {
    throw new RangeError(`wins must lie in [0, ${resolved.trades}], got ${resolved.wins}`);
  }
  if (!Number.isFinite(resolved.walletsScreened) || resolved.walletsScreened < 1) {
    throw new RangeError(`walletsScreened must be >= 1, got ${resolved.walletsScreened}`);
  }
  if (!(resolved.priorMean > 0.0 && resolved.priorMean < 1.0)) {
    throw new RangeError(`priorMean must lie in (0, 1), got ${resolved.priorMean}`);
  }
  if (!Number.isFinite(resolved.priorStrength) || resolved.priorStrength < 0) {
    throw new RangeError(`priorStrength must be non-negative, got ${resolved.priorStrength}`);
  }
  return resolved;
}

export function rawWinRate(edge: EdgeParams): number {
  const e = resolveEdge(edge);
  return e.wins / e.trades;
}

/** Posterior mean under a Beta(a0, b0) prior. */
export function shrunkWinRate(edge: EdgeParams): number {
  const e = resolveEdge(edge);
  const a0 = e.priorMean * e.priorStrength;
  const b0 = (1.0 - e.priorMean) * e.priorStrength;
  return (a0 + e.wins) / (a0 + b0 + e.trades);
}

export function standardError(edge: EdgeParams): number {
  const e = resolveEdge(edge);
  const p = shrunkWinRate(e);
  return Math.sqrt((p * (1.0 - p)) / e.trades);
}

/** Expected inflation of the max of M draws, in standard errors. */
export function selectionZ(edge: EdgeParams): number {
  const e = resolveEdge(edge);
  const m = e.walletsScreened;
  return normalInvCdf(1.0 - 1.0 / (m + 1.0));
}

/** The p̃ used for sizing. Clamped to [0.01, 0.99]. */
export function deflatedWinProb(edge: EdgeParams): number {
  const e = resolveEdge(edge);
  const p = shrunkWinRate(e) - selectionZ(e) * standardError(e);
  return Math.min(0.99, Math.max(0.01, p));
}

// ---------------------------------------------------------------------------
// Cost model
// ---------------------------------------------------------------------------

/**
 * Constant-product pool and the costs of a round trip through it.
 *
 * `depthSol` is the SOL-side reserve, not TVL. Price impact for buying with q
 * into a reserve of Q is q/(Q+q); the exit is modelled the same way against
 * `depthSol * exitDepthRatio`.
 *
 * `exitDepthRatio` below 1.0 models the usual case — exiting into thinner
 * liquidity than you entered against. It is the single most under-modelled cost
 * in copy trading.
 *
 * `priorityFeeSol` and `tipSol` are whole SOL. Lamports convert at the
 * boundary, not here: this module is float arithmetic by construction, and a
 * bigint reaching it would silently become one.
 */
export interface PoolState {
  readonly depthSol: number;
  readonly dexFee?: number;
  readonly priorityFeeSol?: number;
  readonly tipSol?: number;
  readonly exitDepthRatio?: number;
}

interface ResolvedPool {
  readonly depthSol: number;
  readonly dexFee: number;
  readonly priorityFeeSol: number;
  readonly tipSol: number;
  readonly exitDepthRatio: number;
}

function resolvePool(pool: PoolState): ResolvedPool {
  const resolved: ResolvedPool = {
    depthSol: pool.depthSol,
    dexFee: pool.dexFee ?? 0.0025,
    priorityFeeSol: pool.priorityFeeSol ?? 0.0,
    tipSol: pool.tipSol ?? 0.0,
    exitDepthRatio: pool.exitDepthRatio ?? 1.0,
  };
  if (!Number.isFinite(resolved.depthSol) || resolved.depthSol <= 0) {
    throw new RangeError(`depthSol must be positive, got ${resolved.depthSol}`);
  }
  if (!(resolved.exitDepthRatio > 0.0 && resolved.exitDepthRatio <= 1.0)) {
    throw new RangeError(`exitDepthRatio must lie in (0, 1], got ${resolved.exitDepthRatio}`);
  }
  return resolved;
}

/** Round-trip price impact as a fraction of notional. */
export function priceImpact(pool: PoolState, sizeSol: number): number {
  const p = resolvePool(pool);
  if (sizeSol <= 0) return 0.0;
  const entry = sizeSol / (p.depthSol + sizeSol);
  const exitDepth = p.depthSol * p.exitDepthRatio;
  const exit = sizeSol / (exitDepth + sizeSol);
  return entry + exit;
}

/**
 * Total round-trip cost as a fraction of notional.
 *
 * U-shaped: fixed per-transaction costs are amortised over size, so too small
 * and fees dominate, too large and impact does. Returns Infinity at or below
 * zero size, which is what makes `netGain` negative rather than NaN when the
 * fixed point is asked about a size it should never take.
 */
export function roundTripCost(pool: PoolState, sizeSol: number): number {
  const p = resolvePool(pool);
  if (sizeSol <= 0) return Number.POSITIVE_INFINITY;
  const fixed = (2.0 * (p.priorityFeeSol + p.tipSol)) / sizeSol;
  return 2.0 * p.dexFee + priceImpact(p, sizeSol) + fixed;
}

// ---------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------

/**
 * Alpha decay between the wallet's fill and ours.
 *
 * `halfLifeS` is the parameter we know least about and it matters nearly as
 * much as the delay itself. `calibrate.fit_alpha_half_life` REFUSED on this
 * corpus — it returned `inf` at r² 0.000, n=104 — and `inf` here yields
 * `survivingAlpha === 1.0`, the optimistic answer. No value passed to this
 * field is currently a measured one; evaluate across a band and refuse if the
 * verdict flips inside it.
 */
export interface Latency {
  readonly delayS: number;
  readonly halfLifeS: number;
}

function checkLatency(latency: Latency): Latency {
  if (!Number.isFinite(latency.delayS) || latency.delayS < 0) {
    throw new RangeError(`delayS must be non-negative, got ${latency.delayS}`);
  }
  if (!(latency.halfLifeS > 0)) {
    throw new RangeError(`halfLifeS must be positive, got ${latency.halfLifeS}`);
  }
  return latency;
}

/** Fraction of the gross move still available when we land. */
export function survivingAlpha(latency: Latency): number {
  const l = checkLatency(latency);
  return Math.pow(2.0, -l.delayS / l.halfLifeS);
}

/**
 * Gross outcome magnitudes, before costs and latency decay. Both positive
 * fractions.
 *
 * `grossLoss` is the stop distance. `grossWin` is the MEASURED realised payoff,
 * trimmed — never the take-profit target, because the mirror exit fires when
 * the tracked wallet sells, which is usually long before the target. Sourcing
 * `grossWin` from the target instead moves the breakeven win rate from the
 * seventies to about 21%, and that difference is the entire apparent edge.
 */
export interface TradeProfile {
  readonly grossWin: number;
  readonly grossLoss: number;
}

function checkTrade(trade: TradeProfile): TradeProfile {
  if (!(trade.grossWin > 0) || !(trade.grossLoss > 0)) {
    throw new RangeError(
      `grossWin and grossLoss must be positive, got ${trade.grossWin} and ${trade.grossLoss}`,
    );
  }
  return trade;
}

export function payoffRatio(trade: TradeProfile): number {
  const t = checkTrade(trade);
  return t.grossWin / t.grossLoss;
}

// ---------------------------------------------------------------------------
// Master equation
// ---------------------------------------------------------------------------

/** p* = l / (g + l). Returns 1.0 if the trade cannot win. */
export function breakevenWinRate(netGain: number, netLoss: number): number {
  if (netGain <= 0) return 1.0;
  return netLoss / (netGain + netLoss);
}

/**
 * Full audit trail for one sizing decision.
 *
 * Every intermediate is retained so a refusal can be explained without
 * re-running the calculation, which is what lets a recorded decision line be
 * argued with months later.
 */
export interface Decision {
  readonly take: boolean;
  readonly sizeSol: number;
  readonly winProb: number;
  readonly survivingAlpha: number;
  readonly cost: number;
  readonly netGain: number;
  readonly netLoss: number;
  readonly expectedValue: number;
  readonly kellyFull: number;
  readonly breakevenWinRate: number;
  readonly bindingConstraint: string;
  readonly converged: boolean;
}

export function edgeOverBreakeven(decision: Decision): number {
  return decision.winProb - decision.breakevenWinRate;
}

/** Limits on the sizing itself. Defaults match `master_equation.size_position`. */
export interface SizingLimits {
  /** λ. 0.25 is already aggressive on estimated parameters. */
  readonly kellyFraction?: number;
  /** κ. Hard ceiling as a fraction of pool depth. */
  readonly depthCap?: number;
  /** τ. Minimum EV per unit staked to open. Set above zero in production. */
  readonly evThreshold?: number;
  /** Absolute ceiling on any single position, as a fraction of equity. */
  readonly maxEquityFraction?: number;
  readonly maxIterations?: number;
  readonly tolerance?: number;
}

/**
 * Evaluate the master equation for one signal.
 *
 * Cost depends on size and size depends on cost, so the fixed point is found by
 * damped iteration — `size = 0.5·size + 0.5·target`, from a start of the hard
 * cap. The damping is what makes it converge rather than oscillate across the
 * U-shaped cost curve, and `converged` reports whether it actually did.
 *
 * A **faithful** port: `take` and `sizeSol` are whatever the Python returns,
 * including on the non-converged path. The refusal of a non-converged decision
 * lives in `decide`, one layer up, so that this function stays comparable to
 * the reference field for field. See `decide`.
 */
export function sizePosition(
  edge: EdgeParams,
  trade: TradeProfile,
  pool: PoolState,
  latency: Latency,
  equitySol: number,
  limits: SizingLimits = {},
): Decision {
  const kellyFraction = limits.kellyFraction ?? 0.25;
  const depthCap = limits.depthCap ?? 0.01;
  const evThreshold = limits.evThreshold ?? 0.0;
  const maxEquityFraction = limits.maxEquityFraction ?? 0.2;
  const maxIterations = limits.maxIterations ?? 60;
  const tolerance = limits.tolerance ?? 1e-9;

  if (!Number.isFinite(equitySol) || equitySol <= 0) {
    throw new RangeError(`equitySol must be positive, got ${equitySol}`);
  }
  if (!(kellyFraction > 0 && kellyFraction <= 1)) {
    throw new RangeError(`kellyFraction must lie in (0, 1], got ${kellyFraction}`);
  }
  if (!(depthCap > 0 && depthCap <= 1)) {
    throw new RangeError(`depthCap must lie in (0, 1], got ${depthCap}`);
  }
  if (!(maxEquityFraction > 0 && maxEquityFraction <= 1)) {
    throw new RangeError(`maxEquityFraction must lie in (0, 1], got ${maxEquityFraction}`);
  }

  const e = resolveEdge(edge);
  const t = checkTrade(trade);
  const p0 = resolvePool(pool);
  const l = checkLatency(latency);

  const p = deflatedWinProb(e);
  const surviving = survivingAlpha(l);
  const hardCap = Math.min(equitySol * maxEquityFraction, p0.depthSol * depthCap);

  let size = hardCap;
  let kellyFull = 0.0;
  let converged = false;

  for (let i = 0; i < maxIterations; i += 1) {
    const cost = roundTripCost(p0, size);
    const netGain = t.grossWin * surviving - cost;
    const netLoss = t.grossLoss + cost;

    if (netGain <= 0) {
      kellyFull = 0.0;
      size = 0.0;
      converged = true;
      break;
    }

    kellyFull = (p * netGain - (1.0 - p) * netLoss) / (netGain * netLoss);
    const targetFraction = Math.min(Math.max(0.0, kellyFull) * kellyFraction, maxEquityFraction);
    const target = Math.min(targetFraction * equitySol, p0.depthSol * depthCap);

    if (Math.abs(target - size) < tolerance) {
      size = target;
      converged = true;
      break;
    }
    size = 0.5 * size + 0.5 * target;
  }

  const cost = size > 0 ? roundTripCost(p0, size) : roundTripCost(p0, hardCap);
  const netGain = t.grossWin * surviving - cost;
  const netLoss = t.grossLoss + cost;
  const ev = p * netGain - (1.0 - p) * netLoss;
  const be = breakevenWinRate(netGain, netLoss);

  let constraint: string;
  if (netGain <= 0) {
    constraint = 'costs exceed the decayed gross win';
  } else if (ev <= evThreshold) {
    constraint = 'EV gate closed';
  } else if (size >= p0.depthSol * depthCap - tolerance) {
    constraint = 'pool depth cap';
  } else if (size >= equitySol * maxEquityFraction - tolerance) {
    constraint = 'max equity fraction';
  } else {
    constraint = 'Kelly';
  }

  const take = ev > evThreshold && size > 0 && netGain > 0;

  return {
    take,
    sizeSol: take ? size : 0.0,
    winProb: p,
    survivingAlpha: surviving,
    cost,
    netGain,
    netLoss,
    expectedValue: ev,
    kellyFull,
    breakevenWinRate: be,
    bindingConstraint: constraint,
    converged,
  };
}

/** The one constraint string `decide` can produce that `sizePosition` cannot. */
export const DID_NOT_CONVERGE = 'the fixed point did not converge';

/**
 * `sizePosition`, with a non-converged result refused.
 *
 * A decision that did not converge is not a decision: `size` is wherever the
 * damped iteration happened to be when it ran out of passes, and every field
 * derived from it describes that arbitrary point rather than a fixed point. The
 * refusal is here rather than inside `sizePosition` for one reason — forcing
 * `take` to false also forces `sizeSol` to zero, and a port that changed either
 * could not be compared to the reference field for field. `sizePosition` stays
 * conformable; `decide` is what the buy path will call.
 *
 * The damping halves the gap each pass, so 60 iterations reach 2⁻⁶⁰ ≈ 9e-19,
 * well inside the 1e-9 tolerance. This path is defensive, not expected — which
 * is exactly why it must be explicit rather than assumed away.
 */
export function decide(
  edge: EdgeParams,
  trade: TradeProfile,
  pool: PoolState,
  latency: Latency,
  equitySol: number,
  limits: SizingLimits = {},
): Decision {
  const decision = sizePosition(edge, trade, pool, latency, equitySol, limits);
  if (decision.converged) return decision;
  return {
    ...decision,
    take: false,
    sizeSol: 0.0,
    bindingConstraint: DID_NOT_CONVERGE,
  };
}

/**
 * Trim a proposed size so total exposure respects a heat limit.
 *
 * Memecoin positions correlate hard in drawdowns, so the default treats them as
 * perfectly correlated and exposure simply sums. Lower `assumedCorrelation`
 * only on a measurement, and note that measured correlation rises exactly when
 * it hurts.
 *
 * This is NOT `maxConcurrentPositions` and does not replace it. Heat trims a
 * size; the concurrency cap refuses an entry. Both stay.
 */
export function portfolioHeatCap(
  openPositionsSol: readonly number[],
  equitySol: number,
  proposedSol: number,
  maxHeat = 0.3,
  assumedCorrelation = 1.0,
): number {
  if (!Number.isFinite(equitySol) || equitySol <= 0) {
    throw new RangeError(`equitySol must be positive, got ${equitySol}`);
  }
  const effectiveOpen = openPositionsSol.reduce((a, b) => a + b, 0) * assumedCorrelation;
  const remaining = maxHeat * equitySol - effectiveOpen;
  return Math.max(0.0, Math.min(proposedSol, remaining));
}

/** One-line summary for a decision line. Display only; nothing parses it. */
export function explainDecision(decision: Decision): string {
  const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;
  const head = decision.take
    ? `TAKE ${decision.sizeSol.toFixed(4)} SOL`
    : 'SKIP';
  return (
    `${head} | p~=${pct(decision.winProb)} vs breakeven ${pct(decision.breakevenWinRate)} | ` +
    `EV=${pct(decision.expectedValue)} | cost=${pct(decision.cost)} | ` +
    `${decision.take ? `bound by ${decision.bindingConstraint}` : decision.bindingConstraint}`
  );
}
