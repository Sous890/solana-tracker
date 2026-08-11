/**
 * Copyable scores for the wallets tests source swaps from.
 *
 * Every test that exercises the entry path needs these, because a wallet with
 * no score is REFUSED — absence is not a pass, and defaulting a missing share
 * to zero would admit exactly the wallets we know least about. Stating the
 * precondition in each harness is the point, not an inconvenience.
 */
import type { WalletScoresFile } from '../../src/services/walletScores.js';

const COPYABLE = [
  '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  'BCagckXeMChUKrHEd6fKFA1uiWDtcmCXMsqaheLiUPJd',
  'BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9XSiHMY',
  'popo3Rj6arKNttyUFpWfbkv2gG8uS13TGtmH6JPMuHz',
  'HSsJjkHrxezZ1SdhgdivhDGXbxANicWbKvKsVtrMrJvG',
  'AgiGpUAF25B7NL9u8byDcptPcYWi4eFU4kjtcRtaMmdQ',
];

/** Every test wallet, scored comfortably copyable on a sufficient sample. */
export const copyableScores: WalletScoresFile = {
  generatedAt: '2026-08-11T00:00:00.000Z',
  basis: 'test fixture — every wallet copyable on a sample above the floor',
  scores: COPYABLE.map((wallet) => ({
    wallet,
    uncopyableShare: 0,
    roundTrips: 40,
    againstDelayMs: 5_479,
    measuredFrom: '2026-08-11T01:15:35.000Z',
    measuredTo: '2026-08-11T03:28:30.000Z',
  })),
};
