/**
 * Collapse per-tranche FIFO round trips into ONE ROW PER DECISION.
 *
 * `export-wallet-history.ts` emits one row per FIFO pairing, so a mint the
 * wallet scaled out of in five tranches contributes five rows. Anything that
 * takes an unweighted mean over those rows — `realised_stats`, and
 * `EdgeParams(wins, trades)` behind it — is measuring EXITS, not DECISIONS, and
 * weights the estimate toward heavily-traded mints.
 *
 * Measured on HSsJjkHr…: win rate 55.11% per row vs 48.78% per decision. The
 * 50% line falls between them, so the counting convention alone decides whether
 * the wallet looks profitable.
 *
 * Emits `{wallet}.decisions.csv` in the same schema, one row per entry
 * signature, with `sol_in`/`sol_out` summed across that entry's tranches. Feed
 * THIS to `realised_stats`.
 *
 * The descriptive statistics printed below are computed here, directly. They
 * are NOT `realised_stats` output — that module is not present in this repo —
 * and the two may differ on `filter_realised`'s exact open-position handling.
 * Re-run the real thing when it is available.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Row { token: string; signalTs: number; entryTs: number; exitTs: number; solIn: number; solOut: number; sig: string }

function read(path: string): { closed: Row[]; open: number } {
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  const h = (lines[0] as string).split(',');
  const i = (n: string): number => h.indexOf(n);
  const closed: Row[] = [];
  let open = 0;
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    if (c[i('sol_out')] === '') { open += 1; continue; }
    const solIn = Number(c[i('sol_in')]);
    if (!(solIn > 0)) continue;
    closed.push({
      token: c[i('token')] as string,
      signalTs: Number(c[i('signal_ts')]), entryTs: Number(c[i('entry_ts')]),
      exitTs: Number(c[i('exit_ts')]), solIn, solOut: Number(c[i('sol_out')]),
      sig: c[i('entry_signature')] as string,
    });
  }
  return { closed, open };
}

/** Sum both legs across an entry's tranches. Sign-correct by construction. */
function byDecision(rows: Row[]): Row[] {
  const map = new Map<string, Row>();
  for (const r of rows) {
    const held = map.get(r.sig);
    if (held === undefined) { map.set(r.sig, { ...r }); continue; }
    held.solIn += r.solIn;
    held.solOut += r.solOut;
    held.exitTs = Math.max(held.exitTs, r.exitTs);
    held.signalTs = Math.min(held.signalTs, r.signalTs);
  }
  return [...map.values()].sort((a, b) => a.signalTs - b.signalTs);
}

function stats(rows: Row[], droppedOpen: number) {
  const rets = rows.map((r) => r.solOut / r.solIn - 1);
  const wins = rets.filter((r) => r > 0);
  const losses = rets.filter((r) => r <= 0);
  const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  const med = (a: number[]): number => {
    if (!a.length) return NaN;
    const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2);
    return s.length % 2 ? (s[m] as number) : (((s[m - 1] as number) + (s[m] as number)) / 2);
  };

  const avgWin = mean(wins);
  const avgLoss = Math.abs(mean(losses));
  const payoff = avgLoss > 0 ? avgWin / avgLoss : Infinity;

  // Gross PROFIT in SOL, so top_trade_share is about money and not percentages.
  const profits = rows.map((r) => r.solOut - r.solIn).filter((p) => p > 0).sort((a, b) => b - a);
  const grossProfit = profits.reduce((a, b) => a + b, 0);
  const topShare = grossProfit > 0 ? (profits[0] as number) / grossProfit : NaN;

  return {
    n: rows.length, winRate: wins.length / rows.length,
    avgWin, avgLoss, payoff, medianReturn: med(rets), meanReturn: mean(rets),
    topTradeShare: topShare, nDroppedOpen: droppedOpen,
    // breakeven_win_rate = l / (g + l). Above 0.5 whenever costs push l up.
    breakevenZeroCost: avgLoss / (avgWin + avgLoss),
    grossProfitSol: grossProfit,
  };
}

const pct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : '—');

for (const wallet of process.argv.slice(2)) {
  const { closed, open } = read(resolve('exports', `${wallet}.csv`));
  const decisions = byDecision(closed);

  const out = resolve('exports', `${wallet}.decisions.csv`);
  writeFileSync(out,
    'token,signal_ts,entry_ts,exit_ts,sol_in,sol_out,entry_signature\n' +
    decisions.map((r) => [r.token, r.signalTs, r.entryTs, r.exitTs, r.solIn, r.solOut, r.sig].join(',')).join('\n') + '\n',
    'utf8');

  const perRow = stats(closed, open);
  const perDec = stats(decisions, open);

  console.log(`\n══ ${wallet}`);
  console.log(`   tranche rows ${closed.length}   decisions ${decisions.length}   dropped open ${open}`);
  console.log(`   -> ${out}`);
  console.log('');
  console.log('                       per TRANCHE row      per DECISION');
  const line = (label: string, a: string, b: string): void =>
    console.log('   ' + label.padEnd(20) + a.padStart(16) + b.padStart(18));
  line('n', String(perRow.n), String(perDec.n));
  line('win_rate', pct(perRow.winRate), pct(perDec.winRate));
  line('avg_win', pct(perRow.avgWin), pct(perDec.avgWin));
  line('avg_loss', pct(perRow.avgLoss), pct(perDec.avgLoss));
  line('payoff_ratio', perRow.payoff.toFixed(4), perDec.payoff.toFixed(4));
  line('median_return', pct(perRow.medianReturn), pct(perDec.medianReturn));
  line('mean_return', pct(perRow.meanReturn), pct(perDec.meanReturn));
  line('top_trade_share', pct(perRow.topTradeShare), pct(perDec.topTradeShare));
  line('n_dropped_open', String(perRow.nDroppedOpen), String(perDec.nDroppedOpen));
  console.log('');
  line('breakeven @ c=0', pct(perRow.breakevenZeroCost), pct(perDec.breakevenZeroCost));
  const margin = perDec.winRate - perDec.breakevenZeroCost;
  console.log('');
  console.log(`   PER DECISION: p̃ ${pct(perDec.winRate)} vs breakeven ${pct(perDec.breakevenZeroCost)} at ZERO cost`);
  console.log(`   margin ${margin >= 0 ? '+' : ''}${(margin * 100).toFixed(2)}pp  ->  ${margin >= 0 ? 'clears breakeven before costs' : 'BELOW BREAKEVEN BEFORE ANY COST'}`);
}
