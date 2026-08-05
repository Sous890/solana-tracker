/**
 * Decision parameters for the offline analysis.
 *
 * The bounds matter more than the storage: every one of them exists because the
 * value outside it silently opens a gate that the master equation closed.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PARAMS,
  ParamsError,
  openAnalysisParams,
  validate,
} from '../src/services/analysisParams.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'params-'));
  dirs.push(dir);
  return join(dir, 'analysis-params.json');
}

const NOW = 1_700_000_000_000;

describe('validate', () => {
  it('accepts the locked prompt-17 values', () => {
    expect(validate({ wallets_screened: 50, ev_threshold: 0.005 })).toEqual({
      wallets_screened: 50,
      ev_threshold: 0.005,
    });
  });

  it('accepts M = 1, which disables selection deflation', () => {
    expect(validate({ wallets_screened: 1, ev_threshold: 0 }).wallets_screened).toBe(1);
  });

  it('rejects M below 1 — EdgeParams raises on it anyway', () => {
    expect(() => validate({ wallets_screened: 0, ev_threshold: 0.005 })).toThrow(ParamsError);
    expect(() => validate({ wallets_screened: -3, ev_threshold: 0.005 })).toThrow(/>= 1/);
  });

  it('rejects a non-integer M', () => {
    expect(() => validate({ wallets_screened: 2.5, ev_threshold: 0.005 })).toThrow(/integer/);
  });

  /**
   * The one that matters. A negative threshold does not "loosen" the gate — it
   * instructs the equation to open positions whose expected value it has just
   * computed as negative.
   */
  it('rejects a negative TAU', () => {
    expect(() => validate({ wallets_screened: 50, ev_threshold: -0.01 })).toThrow(
      /negative threshold takes negative-EV/,
    );
  });

  it('rejects a TAU above 1, which is never satisfiable', () => {
    expect(() => validate({ wallets_screened: 50, ev_threshold: 1.5 })).toThrow(/never satisfiable/);
  });

  it('rejects non-numeric input rather than coercing it', () => {
    expect(() => validate({ wallets_screened: 50, ev_threshold: 'low' })).toThrow(ParamsError);
  });
});

describe('AnalysisParamsStore', () => {
  it('starts at the locked defaults when no file exists', () => {
    const store = openAnalysisParams(tempPath(), () => NOW);
    expect(store.get()).toMatchObject(DEFAULT_PARAMS);
    expect(store.get().changeLog).toEqual([]);
  });

  it('persists a change and survives a reopen', () => {
    const path = tempPath();
    const store = openAnalysisParams(path, () => NOW);
    store.set({ wallets_screened: 12, ev_threshold: 0.02 }, 'tightened');

    const reopened = openAnalysisParams(path, () => NOW);
    expect(reopened.get()).toMatchObject({ wallets_screened: 12, ev_threshold: 0.02 });
  });

  /**
   * The audit trail is the whole reason this is a store rather than two numbers.
   * Prompt 17 required TAU locked BEFORE the run; an edit made after seeing a
   * rejection must leave a trace even though nothing can prevent it.
   */
  it('records every change with a timestamp and note', () => {
    const store = openAnalysisParams(tempPath(), () => NOW);
    store.set({ wallets_screened: 10, ev_threshold: 0.01 }, 'first');
    store.set({ wallets_screened: 1, ev_threshold: 0 }, 'loosened after a rejection');

    const log = store.get().changeLog;
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({
      at: NOW,
      wallets_screened: 1,
      ev_threshold: 0,
      note: 'loosened after a rejection',
    });
  });

  it('does not persist a rejected change', () => {
    const path = tempPath();
    const store = openAnalysisParams(path, () => NOW);
    store.set({ wallets_screened: 50, ev_threshold: 0.005 }, 'locked');
    expect(() => store.set({ wallets_screened: 50, ev_threshold: -1 })).toThrow(ParamsError);

    expect(openAnalysisParams(path, () => NOW).get().ev_threshold).toBe(0.005);
  });

  /**
   * A corrupt file must not become permissive defaults in silence — the reset
   * itself is logged, so a run cannot later be explained by a file nobody knew
   * had been discarded.
   */
  it('logs the reset when the file is unreadable', () => {
    const path = tempPath();
    writeFileSync(path, '{ not json', 'utf8');

    const store = openAnalysisParams(path, () => NOW);
    expect(store.get()).toMatchObject(DEFAULT_PARAMS);
    expect(store.get().changeLog[0]?.note).toContain('unreadable');
  });

  it('caps the change log rather than growing without bound', () => {
    const store = openAnalysisParams(tempPath(), () => NOW);
    for (let i = 0; i < 60; i += 1) store.set({ wallets_screened: 1 + i, ev_threshold: 0.001 });
    expect(store.get().changeLog).toHaveLength(50);
  });

  it('writes JSON the Python side can read', () => {
    const path = tempPath();
    openAnalysisParams(path, () => NOW).set({ wallets_screened: 50, ev_threshold: 0.005 });
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(raw['wallets_screened']).toBe(50);
    expect(raw['ev_threshold']).toBe(0.005);
  });
});
