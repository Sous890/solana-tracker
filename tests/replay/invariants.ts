/**
 * The three things that must hold at every step, and abort the run when they do
 * not.
 *
 * ── WHY THIS ABORTS INSTEAD OF SUMMARISING ────────────────────────────────
 *
 * The 2026-08-03 oversell survived an entire prompt because the ledger's replay
 * clamps `sold` to what was held. The position came out right, so every
 * end-of-run check agreed, while the fill row asserted a sale of a thousand
 * times the holding and the paper wallet was credited for it. A summary
 * computed from final state cannot see that; only a check that runs at the
 * moment the fill is written can.
 *
 * So: a violation throws immediately, naming the `seq` it happened at and the
 * fill that caused it. Not a count at the end, not a warning.
 */

import type { Address, Fill } from '../../src/core/types.js';
import type { Ledger } from '../../src/db/ledger.js';

export class InvariantViolation extends Error {
  readonly invariant: 1 | 2 | 3;
  readonly seq: number;
  readonly detail: Record<string, string>;

  constructor(invariant: 1 | 2 | 3, seq: number, message: string, detail: Record<string, string>) {
    super(
      `INVARIANT ${invariant} VIOLATED at seq ${seq}: ${message}\n` +
        Object.entries(detail)
          .map(([key, value]) => `    ${key}: ${value}`)
          .join('\n'),
    );
    this.name = 'InvariantViolation';
    this.invariant = invariant;
    this.seq = seq;
    this.detail = detail;
  }
}

/**
 * Running token totals, maintained independently of the ledger's projection.
 *
 * Independent on purpose. The ledger derives `position.tokens` by replaying the
 * same fills, so asking it whether the fills add up is asking a question it
 * cannot answer wrongly. This adds them up separately and then compares.
 */
export class InvariantChecker {
  private readonly running = new Map<Address, bigint>();
  readonly checks = { fills: 0, sells: 0, ticks: 0 };

  constructor(private readonly ledger: Ledger) {}

  held(mint: Address): bigint {
    return this.running.get(mint) ?? 0n;
  }

  /**
   * Invariant 3, checked BEFORE the intent is submitted.
   *
   * `guards.clampSellToPosition` reduces an oversell to the holding and
   * executes it — correct behaviour, and it is what makes the condition
   * invisible downstream. The harness therefore has to look before the clamp
   * gets to absorb it.
   */
  beforeSell(seq: number, mint: Address, requested: bigint): void {
    this.checks.sells += 1;
    const held = this.held(mint);
    if (requested > held) {
      throw new InvariantViolation(
        3,
        seq,
        'a sell asked for more than the position holds; the clamp would have hidden this',
        {
          mint,
          requested: requested.toString(),
          held: held.toString(),
          excess: (requested - held).toString(),
        },
      );
    }
  }

  /**
   * Invariants 1 and 2, checked after every fill the broker returns.
   */
  afterFill(seq: number, fill: Fill): void {
    this.checks.fills += 1;

    // 2. No fill without a resolved intent row preceding it.
    const status = this.ledger.getIntentStatus(fill.intentId);
    if (status === undefined) {
      throw new InvariantViolation(2, seq, 'a fill exists with no intents row', {
        intentId: fill.intentId,
        mint: fill.mint,
        tokensDelta: fill.tokensDelta.toString(),
      });
    }
    if (status === 'pending' || status === 'orphaned') {
      throw new InvariantViolation(2, seq, `a fill exists whose intent is still ${status}`, {
        intentId: fill.intentId,
        mint: fill.mint,
        status,
      });
    }

    // 1. Token conservation.
    const before = this.held(fill.mint);
    const after = before + fill.tokensDelta;
    if (after < 0n) {
      throw new InvariantViolation(
        1,
        seq,
        'a fill drove the running token total negative — tokens were sold that were never held',
        {
          mint: fill.mint,
          intentId: fill.intentId,
          heldBefore: before.toString(),
          tokensDelta: fill.tokensDelta.toString(),
          wouldLeave: after.toString(),
        },
      );
    }
    this.running.set(fill.mint, after);

    // ...and it must agree with the ledger's own projection, every step.
    const projected = this.ledger.getPosition(fill.mint)?.tokens ?? 0n;
    if (projected !== after) {
      throw new InvariantViolation(
        1,
        seq,
        'the running token total disagrees with the ledger projection',
        {
          mint: fill.mint,
          intentId: fill.intentId,
          running: after.toString(),
          projection: projected.toString(),
          // This is exactly the shape the 2026-08-03 defect had: the clamp made
          // the projection right while the fill row said something else.
          note: 'a fill row that does not match the position it produced',
        },
      );
    }
  }

  /** Replay a recorded fill sequence with no broker, for the regression fixture. */
  applyRecordedFill(seq: number, fill: Pick<Fill, 'mint' | 'tokensDelta' | 'intentId'>): void {
    const before = this.held(fill.mint);
    const after = before + fill.tokensDelta;
    if (after < 0n) {
      throw new InvariantViolation(
        1,
        seq,
        'a fill drove the running token total negative — tokens were sold that were never held',
        {
          mint: fill.mint,
          intentId: fill.intentId,
          heldBefore: before.toString(),
          tokensDelta: fill.tokensDelta.toString(),
          wouldLeave: after.toString(),
        },
      );
    }
    this.running.set(fill.mint, after);
  }

  /** End of run: every running total must equal the position it produced. */
  finalise(): void {
    for (const [mint, running] of this.running) {
      const projected = this.ledger.getPosition(mint)?.tokens ?? 0n;
      if (projected !== running) {
        throw new InvariantViolation(1, -1, 'final token totals disagree with the ledger', {
          mint,
          running: running.toString(),
          projection: projected.toString(),
        });
      }
    }
  }
}
