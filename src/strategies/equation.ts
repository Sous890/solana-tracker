/**
 * EquationStrategy — the reserved slot. Both hooks return `null`.
 *
 * This is a working strategy that never trades, not a placeholder that would
 * crash if selected. `strategy: "equation"` in `config.json` produces a bot
 * that observes, marks, screens and alerts, and opens nothing — which is a
 * genuinely useful setting while an equation is being developed, and a safe
 * default to fall back to.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE MAY READ
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Context`, and its hook arguments. That is the complete list:
 *
 *   ctx.positions      Open positions, frozen. `state` is 'open' | 'closed';
 *                      there is no "exit in flight" state to read, and the
 *                      guard layer refuses a duplicate exit anyway. Writing to
 *                      one throws.
 *   ctx.balanceSol     Whole SOL, derived, for heuristics. The gas reserve is
 *                      enforced on exact lamports at guard gate 3 — this number
 *                      is not that check and must not be treated as one.
 *   ctx.config         Frozen. Read tuning parameters; writing throws.
 *   ctx.getPriceSol()  SOL per whole token from a real routable probe. Returns
 *                      a `QuoteError` when there is no route — handle it,
 *                      because a token with no route is exactly the case an
 *                      equation is most likely to produce a confident number
 *                      for.
 *   ctx.now()          The injected clock.
 *   ctx.log            info / warn.
 *   swap, position, priceSol  The hook arguments.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE MAY NOT DO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   Date.now(), Math.random(), fetch()  — a test greps this directory for all
 *                      three and fails the build on a hit. Prompt 12 promises
 *                      byte-identical replays; these three are the only things
 *                      that can break that promise from inside a strategy.
 *   Module-level mutable state — a counter, a cache, a "last seen" map. It
 *                      survives between calls, so the same inputs stop
 *                      producing the same output and the replay diverges.
 *                      Everything an equation needs about the past is either in
 *                      `ctx.positions` or belongs in the ledger.
 *   `import` anything from `adapters/`, `db/`, or `services/`  — a strategy
 *                      that can reach a broker can bypass `guards.ts`, and the
 *                      guard layer is only total because `Broker` is the one
 *                      door to funds. `core/` and nothing else.
 *   Assign an intent `id` — `IntentDraft` has no `id` field. The runner assigns
 *                      it so ids stay monotonic and replayable.
 *   Return more than one draft — one hook call, at most one intent. Wanting two
 *                      things means doing the more urgent one; the next tick is
 *                      2 seconds away.
 *   Throw as control flow — a throw is caught, counted, reported as
 *                      `strategy-error`, and treated as `null`. It costs an
 *                      alert and buys nothing that returning `null` would not.
 *   Block — 500ms hard timeout, after which the answer is discarded and the
 *                      mint stays locked until the call actually finishes.
 */

import type { Context, IntentDraft, Strategy } from '../core/strategy.js';
import type { Position, TrackedSwap } from '../core/types.js';

export function createEquationStrategy(): Strategy {
  return {
    name: 'equation',

    async onTrackedSwap(_swap: TrackedSwap, _ctx: Context): Promise<IntentDraft | null> {
      return null;
    },

    async onPriceTick(
      _position: Position,
      _priceSol: number,
      _ctx: Context,
    ): Promise<IntentDraft | null> {
      return null;
    },
  };
}
