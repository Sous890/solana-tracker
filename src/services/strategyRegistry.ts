/**
 * Name -> strategy. The one place `config.strategy` becomes code.
 *
 * This lives in `services/` rather than `core/` because it imports concrete
 * strategies, and `core/` may not depend on anything outside itself. That is
 * also why `config.strategy` is validated as a plain non-empty string rather
 * than an enum: an enum in `core/config.ts` would have to know this table,
 * which is an import pointing the wrong way down the dependency chain.
 *
 * The cost of that choice is that a typo'd name fails when the runtime is
 * built, not when the config is parsed. `createStrategy` therefore fails loudly
 * and lists what it does know — a `RuntimeConfigError`-shaped failure at
 * startup, not a bot that silently trades with the wrong logic.
 *
 * Factories, not singletons: a strategy is constructed per runtime so two
 * runtimes in one process (a test suite, a future replay harness) cannot share
 * state through it.
 */

import type { Strategy } from '../core/strategy.js';
import { createMirrorStrategy } from '../strategies/mirror.js';
import { createEquationStrategy } from '../strategies/equation.js';

export type StrategyFactory = () => Strategy;

export const STRATEGY_REGISTRY: Readonly<Record<string, StrategyFactory>> = Object.freeze({
  mirror: createMirrorStrategy,
  equation: createEquationStrategy,
});

/** Names this build knows, sorted, for error messages and for the API. */
export function strategyNames(): string[] {
  return Object.keys(STRATEGY_REGISTRY).sort();
}

export class UnknownStrategyError extends Error {
  readonly requested: string;

  constructor(requested: string) {
    super(
      `Unknown strategy "${requested}". This build knows: ${strategyNames().join(', ')}. ` +
        'Fix `strategy` in config.json — the bot will not start with a strategy it cannot resolve.',
    );
    this.name = 'UnknownStrategyError';
    this.requested = requested;
  }
}

export function createStrategy(name: string): Strategy {
  const factory = STRATEGY_REGISTRY[name];
  if (factory === undefined) throw new UnknownStrategyError(name);

  const strategy = factory();
  // A strategy whose `name` disagrees with its registry key would put a
  // misleading prefix on every intent id it produces, and intent ids are what a
  // later audit reads back.
  if (strategy.name !== name) {
    throw new Error(
      `Strategy registered as "${name}" reports its name as "${strategy.name}"; ` +
        'intent ids are prefixed with the reported name and would not match the config.',
    );
  }
  return strategy;
}
