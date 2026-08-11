# Source manifest — what is and is not in this Project

> Generated from commit `0a078be` on 2026-08-11.

The repo is ~14,000 lines of TypeScript. Bundling all of it would crowd out the
documents that actually explain the system, so the bundle is curated. If a
question turns on a file listed as omitted below, **say so rather than guessing**
— the answer is to ask for that file, not to infer it from its name.

## Included (14 files)

- `src/adapters/swapParser.ts`
- `src/adapters/walletStream.ts`
- `src/cli/orphans.ts`
- `src/cli/soak.ts`
- `src/core/broker.ts`
- `src/core/config.ts`
- `src/core/guards.ts`
- `src/core/types.ts`
- `src/db/cursors.ts`
- `src/db/ledger.ts`
- `src/services/recorder.ts`
- `src/services/soak.ts`
- `src/services/tracker.ts`
- `src/strategies/mirror.ts`

## Omitted (24 files)

- `src/adapters/dexscreener.ts`
- `src/adapters/jupiter.ts`
- `src/adapters/mintInfo.ts`
- `src/adapters/mintMetadata.ts`
- `src/adapters/paperBroker.ts`
- `src/adapters/rpcClient.ts`
- `src/adapters/safety.ts`
- `src/adapters/streamSocket.ts`
- `src/calibration/poolHistory.ts`
- `src/calibration/replayDelays.ts`
- `src/cli/serve.ts`
- `src/core/quoteSource.ts`
- `src/core/strategy.ts`
- `src/core/units.ts`
- `src/db/fillsView.ts`
- `src/db/runtimeState.ts`
- `src/services/analysisParams.ts`
- `src/services/api.ts`
- `src/services/ledgerDurability.ts`
- `src/services/strategyRegistry.ts`
- `src/services/strategyRunner.ts`
- `src/services/walletScores.ts`
- `src/services/walletStore.ts`
- `src/strategies/equation.ts`

## Tests

No test files are bundled. There are ~19,700 lines of them and 923 passing tests.
The ones most likely to matter in conversation:

- `tests/guards.test.ts` — the entry/exit asymmetry
- `tests/walletStream.test.ts` — dedupe, cursor barrier, reconnect
- `tests/deathInjection.test.ts` — socket-death recovery, barrier preconditions
- `tests/soak.test.ts` — the digest and its thresholds
- `tests/replay.test.ts` — byte-identical replay of recorded sessions
