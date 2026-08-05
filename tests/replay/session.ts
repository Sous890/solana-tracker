/**
 * Reading a session, and refusing to read a bad one.
 *
 * A session is only useful if it is complete and ordered. Both are checked
 * here, loudly, because every failure this file catches would otherwise show up
 * later as a replay that "worked" against a hole.
 */

import { readFileSync } from 'node:fs';
import { decodeSwap, quoteKey } from '../../src/services/recorder.js';
import type {
  PriceTickPayload,
  QuotePayload,
  ScreenPayload,
  SessionLine,
  SwapPayload,
} from '../../src/services/recorder.js';
import type { QuoteError } from '../../src/core/quoteSource.js';
import type { Address, Quote, TrackedSwap } from '../../src/core/types.js';

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

export interface LoadedSession {
  lines: SessionLine[];
  /**
   * `(inMint, outMint, amount)` -> what the aggregator answered, FIRST answer.
   *
   * First wins, not last. A key can be quoted more than once — the settlement
   * probe added in prompt 13 re-quotes the same request 400ms later to measure
   * decay — and the quote a replay must resolve is the one that motivated the
   * intent, not a later observation of the same pair.
   */
  quotes: Map<string, QuotePayload>;
  /** Every answer for a key, in order. The decay report reads these. */
  quoteHistory: Map<string, QuotePayload[]>;
  /** A final line cut off mid-write by a crash. See `truncatedTail`. */
  truncatedTail: string | null;
  /** mint -> the last screen verdict recorded for it. */
  screens: Map<Address, ScreenPayload>;
  /** Swaps and price ticks, in `seq` order — the things a replay drives. */
  drivable: Array<
    | { seq: number; simClockMs: number; kind: 'swap'; swap: TrackedSwap }
    | { seq: number; simClockMs: number; kind: 'price-tick'; tick: PriceTickPayload }
  >;
}

/**
 * Parse a session, tolerating exactly one kind of damage: a truncated last line.
 *
 * A crash kills the process between `stream.write()` and the kernel flushing
 * it, so the last line on disk is routinely a fragment. That is the normal
 * shape of a session from a bot that died, and it is precisely the session
 * somebody most wants to read — refusing it would mean the recording is
 * unusable in the one case it was written for.
 *
 * So the final line, and ONLY the final line, may be unparseable: it is
 * dropped, reported on `truncatedTail`, and everything before it is used. A
 * fragment anywhere else is a corrupt file and still throws, because a hole in
 * the middle is not a crash, it is a different problem.
 */
export function parseSession(text: string, label: string): LoadedSession {
  const lines: SessionLine[] = [];
  const raws = text.split('\n');
  let truncatedTail: string | null = null;

  raws.forEach((raw, index) => {
    if (raw.trim().length === 0) return;
    const isLast = index === raws.length - 1 || raws.slice(index + 1).every((r) => r.trim() === '');

    let line: SessionLine;
    try {
      line = JSON.parse(raw) as SessionLine;
    } catch (cause) {
      if (isLast) {
        truncatedTail = raw;
        return;
      }
      throw new SessionError(`${label}:${index + 1} is not JSON: ${(cause as Error).message}`);
    }
    if (typeof line.seq !== 'number' || typeof line.kind !== 'string') {
      // A line that parses but is missing its header is also a torn write —
      // JSON happens to be valid at more cut points than one would like.
      if (isLast) {
        truncatedTail = raw;
        return;
      }
      throw new SessionError(`${label}:${index + 1} is missing seq or kind`);
    }
    lines.push(line);
  });

  if (lines.length === 0) throw new SessionError(`${label} is empty`);

  // `seq` must be strictly increasing. A session with a gap has had lines
  // dropped by the recorder's backpressure valve, and replaying it would
  // silently model a run that never happened — a missing quote becomes a miss
  // (loud), but a missing swap becomes a trade that simply never occurs.
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1]!;
    const current = lines[index]!;
    if (current.seq <= previous.seq) {
      throw new SessionError(
        `${label} is out of order at line ${index + 1}: seq ${current.seq} follows ${previous.seq}`,
      );
    }
    if (current.seq !== previous.seq + 1) {
      throw new SessionError(
        `${label} has a gap at line ${index + 1}: seq jumps ${previous.seq} -> ${current.seq}. ` +
          'The recorder drops lines rather than delaying the live path, so a gap means this ' +
          'session is incomplete and cannot be replayed faithfully.',
      );
    }
  }

  const quotes = new Map<string, QuotePayload>();
  const quoteHistory = new Map<string, QuotePayload[]>();
  const screens = new Map<Address, ScreenPayload>();
  const drivable: LoadedSession['drivable'] = [];

  for (const line of lines) {
    switch (line.kind) {
      case 'quote': {
        const payload = line.payload as QuotePayload;
        const key = quoteKey({
          inMint: payload.request.inMint,
          outMint: payload.request.outMint,
          inAmount: BigInt(payload.request.inAmount),
        });
        // First wins — see `quotes`.
        if (!quotes.has(key)) quotes.set(key, payload);
        const history = quoteHistory.get(key);
        if (history === undefined) quoteHistory.set(key, [payload]);
        else history.push(payload);
        break;
      }
      case 'screen': {
        const payload = line.payload as ScreenPayload;
        screens.set(payload.mint, payload);
        break;
      }
      case 'swap':
        drivable.push({
          seq: line.seq,
          simClockMs: line.simClockMs,
          kind: 'swap',
          swap: decodeSwap(line.payload as SwapPayload),
        });
        break;
      case 'price-tick':
        drivable.push({
          seq: line.seq,
          simClockMs: line.simClockMs,
          kind: 'price-tick',
          tick: line.payload as PriceTickPayload,
        });
        break;
      case 'unmodeled':
        // Carried, never driven. It is evidence about the schema, and the soak
        // digest counts it by tag; a replay has nothing to do with it.
        break;
      default:
        throw new SessionError(`${label} has an unknown kind "${String(line.kind)}"`);
    }
  }

  return { lines, quotes, quoteHistory, screens, drivable, truncatedTail };
}

export function loadSession(path: string): LoadedSession {
  return parseSession(readFileSync(path, 'utf8'), path);
}

/** Turn a recorded quote payload back into what a `QuoteSource` returns. */
export function materialiseQuote(
  payload: QuotePayload,
  request: { inMint: Address; outMint: Address; inAmount: bigint },
  fetchedAt: number,
): Quote | QuoteError {
  if (payload.error !== undefined) {
    return { error: payload.error.error as QuoteError['error'], message: payload.error.message };
  }
  const quote = payload.quote!;
  return {
    inMint: request.inMint,
    outMint: request.outMint,
    inAmount: BigInt(quote.inAmount),
    outAmount: BigInt(quote.outAmount),
    priceImpactPct: quote.priceImpactPct,
    // The recorded fetch time, not a fresh one: the paper broker's cost model
    // reads it, and a refreshed timestamp would make a stale quote look new.
    routePlan: [],
    fetchedAt,
  };
}
