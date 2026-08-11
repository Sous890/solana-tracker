/**
 * Per-wallet copyability, measured rather than configured.
 *
 * A tracked wallet is a source of signals; whether those signals can be ACTED ON
 * is a property of that wallet's behaviour against this process's latency, and
 * it is not something config.json can assert. `config.trackedWallets` says who
 * to watch. This says who is worth acting on, and it is derived from what they
 * actually did.
 *
 * ── SHAPE OF THE ARTIFACT ─────────────────────────────────────────────────
 *
 * Written by the slow loop, read by the fast loop, and never computed on the
 * signal path — pairing round trips is a corpus-scale operation and the fast
 * loop has ~5 seconds of total budget before gate 3 refuses the signal anyway.
 * The file is the seam: the fast loop does a map lookup and nothing more.
 *
 * Nothing here does I/O. `loadWalletScores` takes the parsed object so the gate
 * stays testable without a filesystem, which is the same reason `guards.ts`
 * takes its deps rather than importing them.
 */

import type { Address } from '../core/types.js';

/**
 * How much of a wallet's activity may be unreachable before it is refused.
 *
 * ── DERIVED IN SESSION 26, AND THE BAND IS WIDE ───────────────────────────
 *
 * `uncopyableShare` is the fraction of a wallet's paired round trips that CLOSE
 * at or before this process's measured chain-to-fill. Those are trades we would
 * pay round-trip cost to enter and be unable to exit in time — a loss taken for
 * a position the source has already left.
 *
 * Measured over **n=147 paired round trips across 13 wallets** in the 2026-08-11
 * run, against a chain-to-fill of **5,479ms** (~14 slots):
 *
 *     popo3Rj6   14/14 = 100%   p50 hold 3 slots
 *     AgiGpUAF    8/23 =  35%   p50 hold 29 slots
 *     C86oRMyU    3/16 =  19%   p50 hold 51 slots, MINIMUM HOLD 0 SLOTS
 *     6ww5Lc3u    2/16 =  13%
 *     2JptG7VJ    1/12 =   8%
 *     CT9dekyf    0/40 =   0%   CbpnbXAD 0/18 = 0%
 *
 * Re-measured over the WHOLE post-routing-fix corpus — 11 session files,
 * **n=3,520 paired round trips**, 2026-08-06 to 2026-08-11 — the shares move,
 * and one of them moves a lot:
 *
 *     popo3Rj6  100.0%  n=465     BCagckXe 10.3%   CT9dekyf  4.8%
 *     C86oRMyU   45.2%  n=564     2nHsHJpk  7.5%   6ww5Lc3u  2.5%
 *     AgiGpUAF   20.1%  n=428     2JptG7VJ  5.8%   HSsJjkHr  0.9%
 *                                 yVrqX84d  5.3%   CbpnbXAD  0.0%
 *
 * Sessions before the subscription-routing fix are excluded: they fanned one
 * notification to every tracked wallet, so their per-wallet attribution is wrong
 * rather than merely noisy.
 *
 * **The population has a hole in it, and the hole is what picks the number.**
 * Every wallet sits at or below 45.2% except one at 100.0%, so ANY threshold in
 * the open interval (45.2%, 100.0%) separates `popo3Rj6` alone and no choice
 * inside it changes a single verdict. This constant is therefore NOT tight, and
 * 50% is not evidence of anything except that the current set is bimodal. A
 * different wallet set will land inside the hole and force a real derivation.
 *
 * The larger sample also CORRECTS the session-26 figure for `C86oRMyU`: 19% over
 * 16 round trips, but **45.2% over 564**. It is admitted, and only just. That is
 * the wallet that sourced the one completed trade, and it has a minimum hold of
 * zero slots — admission means "worth acting on", never "we will be fast
 * enough".
 *
 * 50% is taken for what it says rather than where it sits: refuse a wallet when
 * the MAJORITY of its round trips are unreachable. That is a claim a reader can
 * evaluate without this table.
 *
 * NOT a P&L threshold, deliberately. `popo3Rj6`'s median round trip is -49.1%,
 * which is corroboration and not the criterion: a wallet with an excellent
 * median and a p50 hold of 3 slots is just as unreachable and must be refused
 * just the same. The gate is about our latency, not their skill.
 */
export const MAX_UNCOPYABLE_SHARE = 0.5;

/**
 * Round trips a score must rest on before it is allowed to admit anybody.
 *
 * ── DERIVED FROM WHAT A SMALL SAMPLE CAN RULE OUT ─────────────────────────
 *
 * A wallet observed at 0% uncopyable over n round trips has an upper 95% bound
 * of roughly 3/n on the true share — the rule of three for zero observed events.
 * For that bound to sit clear of `MAX_UNCOPYABLE_SHARE`:
 *
 *     n=6    3/6  = 50%   exactly at the threshold; rules nothing out
 *     n=12   3/12 = 25%   half the threshold
 *     n=20   3/20 = 15%
 *
 * 12 is the smallest sample at which a clean observation is distinguishable from
 * the threshold with margin. Below it, "0% uncopyable" and "50% uncopyable" are
 * the same measurement.
 *
 * On the current artifact this refuses nobody — the thinnest score rests on 97
 * round trips. It bites on a wallet that has just been added, which is exactly
 * when a share of 0% means "we have not watched it yet" rather than "it is
 * clean". **Absence of evidence must not read as a pass**, and defaulting a
 * missing share to 0 would admit precisely the wallets we know least about.
 *
 * Note the direction this cuts: the thirty candidate wallets waiting to be
 * sampled will ALL be refused as `WALLET_UNSCORED` until the slow loop has
 * watched them, and that is the intended behaviour rather than an obstacle to
 * route around.
 */
export const MIN_SCORED_ROUND_TRIPS = 12;

/** One wallet's measured copyability. Every field carries its own provenance. */
export interface WalletScore {
  wallet: Address;
  /** Paired round trips closing at or before `againstDelayMs`, as a fraction. */
  uncopyableShare: number;
  /** `n`. A share without it is not a measurement. */
  roundTrips: number;
  /** The chain-to-fill this was measured against. The share is meaningless without it. */
  againstDelayMs: number;
  /** The corpus window, so a stale score is visible as stale. */
  measuredFrom: string;
  measuredTo: string;
}

export interface WalletScoresFile {
  generatedAt: string;
  /** How the shares were derived, carried so the artifact explains itself. */
  basis: string;
  scores: WalletScore[];
}

/** Why a signal from this wallet will not be acted on. */
export type AdmissionRefusal =
  /**
   * The wallet trades faster than this process can follow. Distinct from every
   * `GuardCode` on purpose: nothing about the mint was wrong, and no intent was
   * ever created to refuse.
   */
  | { code: 'WALLET_NOT_COPYABLE'; uncopyableShare: number; roundTrips: number; reason: string }
  /**
   * No score, or one resting on too few round trips to distinguish from the
   * threshold. Reported separately because "we know this is bad" and "we do not
   * know" are different facts and only the second one is fixed by waiting.
   */
  | { code: 'WALLET_UNSCORED'; roundTrips: number; reason: string };

export interface WalletScoreIndex {
  get(wallet: Address): WalletScore | undefined;
  /** `null` admits. Pure — the fast loop calls this per signal. */
  admit(wallet: Address): AdmissionRefusal | null;
  size: number;
}

/**
 * Index a scores file for the fast loop.
 *
 * Takes the parsed object rather than a path: this module stays I/O-free so the
 * gate can be tested without a filesystem, and so a caller that already has the
 * file in memory does not read it twice.
 */
export function loadWalletScores(file: WalletScoresFile | undefined): WalletScoreIndex {
  const byWallet = new Map<Address, WalletScore>();
  for (const score of file?.scores ?? []) byWallet.set(score.wallet, score);

  return {
    size: byWallet.size,
    get: (wallet) => byWallet.get(wallet),
    admit(wallet) {
      const score = byWallet.get(wallet);
      if (score === undefined) {
        return {
          code: 'WALLET_UNSCORED',
          roundTrips: 0,
          reason: 'no copyability score for this wallet',
        };
      }
      if (score.roundTrips < MIN_SCORED_ROUND_TRIPS) {
        return {
          code: 'WALLET_UNSCORED',
          roundTrips: score.roundTrips,
          reason:
            `scored on ${score.roundTrips} round trip(s), under the ${MIN_SCORED_ROUND_TRIPS} ` +
            'needed to tell a clean wallet from the threshold',
        };
      }
      if (score.uncopyableShare > MAX_UNCOPYABLE_SHARE) {
        return {
          code: 'WALLET_NOT_COPYABLE',
          uncopyableShare: score.uncopyableShare,
          roundTrips: score.roundTrips,
          reason:
            `${(score.uncopyableShare * 100).toFixed(1)}% of ${score.roundTrips} round trips ` +
            `close within ${score.againstDelayMs}ms, past the ` +
            `${(MAX_UNCOPYABLE_SHARE * 100).toFixed(0)}% limit — we cannot follow this wallet`,
        };
      }
      return null;
    },
  };
}
