/**
 * Global test setup.
 *
 * The suite must never reach the network. A test that silently hits the
 * internet passes for the wrong reason, is slow, and fails in CI or on a plane
 * for reasons unrelated to the code — so `fetch` is replaced with something
 * that fails loudly and names the URL it was asked for.
 *
 * Tests that need HTTP inject their own `fetchImpl`; they never touch the
 * global. If you see this error, something is missing a stub.
 */

import { beforeEach } from 'vitest';

/**
 * Rejects rather than throwing synchronously, matching real `fetch`: code that
 * does `fetch(...).catch(...)` must fail the same way it would in production.
 */
async function forbiddenFetch(input: Parameters<typeof fetch>[0]): Promise<never> {
  throw new Error(
    `Network access from a test: ${String(input)}\n` +
      'The suite is offline by design. Inject a fetchImpl (see tests/jupiter.test.ts) ' +
      'or add a recorded fixture via `RECORD=1 npx tsx scripts/record-fixtures.ts`.',
  );
}

beforeEach(() => {
  globalThis.fetch = forbiddenFetch as unknown as typeof fetch;
});
