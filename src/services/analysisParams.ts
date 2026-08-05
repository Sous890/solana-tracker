/**
 * The decision parameters `master_equation.py` is run with.
 *
 * ── WHY THESE LIVE HERE AND NOT IN config.json ────────────────────────────
 *
 * They are not tracker settings. Nothing in the trading path reads them — the
 * bot does not size positions from `master_equation.py`, it runs `mirror` and
 * the guard layer. These are inputs to the OFFLINE decision about whether a
 * wallet is worth tracking at all, and they are kept beside the watchlist
 * because that is the decision they inform.
 *
 * ── WHY THERE IS A LOCK ───────────────────────────────────────────────────
 *
 * `size_position`'s own docstring asks for `ev_threshold` above zero to leave
 * margin for parameter uncertainty, and prompt 17 required TAU to be locked
 * *before* the run. That ordering is the whole point: a threshold chosen after
 * seeing the EV is not a threshold, it is a rationalisation, and the failure
 * mode of copy trading is optimistic parameters rather than conservative ones.
 *
 * So this file records `lockedAt` and `changeLog`. It does not prevent an edit —
 * it makes an edit visible, including one made between seeing a rejection and
 * re-running. That is a weaker guarantee than immutability and a more useful one
 * than none.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AnalysisParams {
  /**
   * `wallets_screened`. Every wallet that COULD have surfaced, not the number
   * you clicked — a leaderboard's length is M even if you never saw the losers.
   * Drives the selection deflation in `EdgeParams.deflated_win_prob`.
   */
  wallets_screened: number;
  /** `ev_threshold`. Minimum EV per unit staked to open. */
  ev_threshold: number;
  /** When these values were last changed, and to what. Append-only. */
  lockedAt: number;
  changeLog: Array<{ at: number; wallets_screened: number; ev_threshold: number; note: string }>;
}

/** Prompt 17's locked values. Changing them is a decision, not a default. */
export const DEFAULT_PARAMS: Omit<AnalysisParams, 'lockedAt' | 'changeLog'> = {
  wallets_screened: 50,
  ev_threshold: 0.005,
};

export class ParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParamsError';
  }
}

/**
 * Bounds, and each one exists because the value outside it is meaningless
 * rather than merely unusual.
 */
export function validate(input: Record<string, unknown>): {
  wallets_screened: number;
  ev_threshold: number;
} {
  const m = Number(input['wallets_screened']);
  if (!Number.isInteger(m) || m < 1) {
    throw new ParamsError('wallets_screened must be an integer >= 1 (1 disables deflation)');
  }
  if (m > 100_000) {
    throw new ParamsError('wallets_screened above 100000 is not a screening process');
  }

  const tau = Number(input['ev_threshold']);
  if (!Number.isFinite(tau)) throw new ParamsError('ev_threshold must be a number');
  if (tau < 0) {
    // Negative tau opens the gate on trades the equation says lose money.
    throw new ParamsError('ev_threshold must be >= 0 — a negative threshold takes negative-EV trades');
  }
  if (tau > 1) throw new ParamsError('ev_threshold is a fraction of notional; > 1 is never satisfiable');

  return { wallets_screened: m, ev_threshold: tau };
}

function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

export class AnalysisParamsStore {
  private params: AnalysisParams;

  constructor(
    private readonly path: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.params = this.load();
  }

  private load(): AnalysisParams {
    if (existsSync(this.path)) {
      try {
        const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<AnalysisParams>;
        const checked = validate(raw as Record<string, unknown>);
        return {
          ...checked,
          lockedAt: typeof raw.lockedAt === 'number' ? raw.lockedAt : this.now(),
          changeLog: Array.isArray(raw.changeLog) ? raw.changeLog : [],
        };
      } catch {
        // A corrupt file must not silently become permissive defaults. Falling
        // back is right; doing it quietly is not, so the reset is logged.
        const fresh = { ...DEFAULT_PARAMS, lockedAt: this.now(), changeLog: [] };
        return {
          ...fresh,
          changeLog: [{ at: this.now(), ...DEFAULT_PARAMS, note: 'reset: params file was unreadable' }],
        };
      }
    }
    return { ...DEFAULT_PARAMS, lockedAt: this.now(), changeLog: [] };
  }

  get(): AnalysisParams {
    return { ...this.params, changeLog: [...this.params.changeLog] };
  }

  set(input: Record<string, unknown>, note = ''): AnalysisParams {
    const checked = validate(input);
    const at = this.now();
    this.params = {
      ...checked,
      lockedAt: at,
      changeLog: [...this.params.changeLog, { at, ...checked, note }].slice(-50),
    };
    writeAtomic(this.path, this.params);
    return this.get();
  }
}

export function openAnalysisParams(path: string, now?: () => number): AnalysisParamsStore {
  return new AnalysisParamsStore(path, now);
}
