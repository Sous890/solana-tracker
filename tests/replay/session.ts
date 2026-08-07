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

/** One recorded answer, tagged with the `seq` it was recorded at. */
export interface RecordedQuote {
  seq: number;
  simClockMs: number;
  payload: QuotePayload;
}

/** One recorded screen verdict, tagged with the `seq` it was recorded at. */
export interface RecordedScreen {
  seq: number;
  simClockMs: number;
  payload: ScreenPayload;
}

export interface LoadedSession {
  lines: SessionLine[];
  /**
   * `(inMint, outMint, amount)` -> the FIRST answer recorded for that key.
   *
   * **Do not resolve a replay against this map.** It cannot distinguish the two
   * reasons a key repeats, and getting that wrong silently prices a trade off
   * the wrong market. Use `resolveQuoteAt`, which takes the `seq` being
   * replayed. Kept because "was this pair ever quoted at all" — the NO_ROUTE
   * latch — is a question with no position in the session.
   */
  quotes: Map<string, QuotePayload>;
  /**
   * Every answer for a key, in `seq` order, with the seq it was recorded at.
   *
   * A key repeats for two unrelated reasons and only the seq tells them apart:
   * the settlement probe re-quotes the same request 400ms later to measure
   * decay, and a strategy buys the same mint again an hour later at the same
   * size. Measured on the 2026-08-05 session: 17 of 41 keys repeat, 10 of those
   * got materially different answers, and `9uNefL6…` was quoted 8 times at
   * 0.05 SOL across a 6.58% spread.
   */
  quoteHistory: Map<string, RecordedQuote[]>;
  /** A final line cut off mid-write by a crash. See `truncatedTail`. */
  truncatedTail: string | null;
  /**
   * mint -> the LAST screen verdict recorded for it.
   *
   * **Do not resolve a replay against this map either** — same defect as
   * `quotes`, same reason. A mint screened three times across a session gets
   * three verdicts, and collapsing them to the last one lets a later `pass`
   * authorise an entry the live run refused. Measured on the 2026-08-05
   * session: `9uNefL6…` screened `unknown` at seq 4898 and the live run opened
   * nothing, then `pass` at 5046 and 6280. Use `resolveScreenAt`.
   */
  screens: Map<Address, ScreenPayload>;
  /** Every verdict for a mint, in `seq` order, with the seq it was recorded at. */
  screenHistory: Map<Address, RecordedScreen[]>;
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
  const quoteHistory = new Map<string, RecordedQuote[]>();
  const screens = new Map<Address, ScreenPayload>();
  const screenHistory = new Map<Address, RecordedScreen[]>();
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
        // First wins — see `quotes`. Every answer is kept in `quoteHistory`,
        // which is what a replay resolves against.
        if (!quotes.has(key)) quotes.set(key, payload);
        const recorded: RecordedQuote = { seq: line.seq, simClockMs: line.simClockMs, payload };
        const history = quoteHistory.get(key);
        if (history === undefined) quoteHistory.set(key, [recorded]);
        else history.push(recorded);
        break;
      }
      case 'screen': {
        const payload = line.payload as ScreenPayload;
        // Last wins — see `screens`. Every verdict is kept in `screenHistory`,
        // which is what a replay resolves against.
        screens.set(payload.mint, payload);
        const seen: RecordedScreen = { seq: line.seq, simClockMs: line.simClockMs, payload };
        const verdicts = screenHistory.get(payload.mint);
        if (verdicts === undefined) screenHistory.set(payload.mint, [seen]);
        else verdicts.push(seen);
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
      case 'decision':
        // Carried, never driven — which is what keeps recording a refusal from
        // letting a session be replayed into agreement with itself. The replay
        // regenerates its own rejections through the real guard layer.
        break;
      case 'unmodeled':
        // Carried, never driven. It is evidence about the schema, and the soak
        // digest counts it by tag; a replay has nothing to do with it.
        break;
      default:
        throw new SessionError(`${label} has an unknown kind "${String(line.kind)}"`);
    }
  }

  return { lines, quotes, quoteHistory, screens, screenHistory, drivable, truncatedTail };
}

export function loadSession(path: string): LoadedSession {
  return parseSession(readFileSync(path, 'utf8'), path);
}

/**
 * The answer for `key` as it stood at `atSeq` — the quote nearest in session
 * time to the event being replayed.
 *
 * ── WHY NOT "FIRST WINS", AND WHY NOT A QUEUE ─────────────────────────────
 *
 * A key repeats for two unrelated reasons, and the fix has to survive both.
 * The settlement probe re-quotes the same request 400ms later, which is one
 * market observed twice. A strategy buying the same mint again an hour later is
 * two markets. First-wins collapsed them: on the 2026-08-05 session it priced
 * the third buy of `9uNefL6…` off the first buy's quote, so the exit then asked
 * to sell an amount no live quote had ever covered and the whole session was
 * unreplayable. 32 of its 73 recorded quote lines were unreachable.
 *
 * Consuming a queue per request does not work either: the live run records
 * quotes the replay never asks for, because `safety.ts` quotes both directions
 * while screening and a replay resolves screens from recorded verdicts instead
 * of re-running the screener. Measured, the recording holds three buy-side
 * quotes per traded occasion where the replay issues two. A queue would drift
 * by one every trade and the drift would be silent.
 *
 * Seq has neither problem. Every request made while replaying event `n` sees
 * the same answer — the earliest one recorded at or after `n` — so the guard's
 * price-impact check and the broker's execution agree, as they did live, and a
 * probe re-quote recorded later cannot displace the quote that motivated the
 * intent. Falling back to the most recent earlier answer covers the tail, where
 * an exit is driven by a price tick recorded after the last quote.
 */
export function resolveQuoteAt(
  session: Pick<LoadedSession, 'quoteHistory'>,
  key: string,
  atSeq: number,
): QuotePayload | undefined {
  const history = session.quoteHistory.get(key);
  if (history === undefined || history.length === 0) return undefined;
  // `history` is in seq order: it is built by one pass over an already-ordered
  // session, which `parseSession` has verified.
  for (const burst of burstsOf(history)) {
    if (burst[0]!.seq >= atSeq) return burst[burst.length - 1]!.payload;
  }
  return history[history.length - 1]!.payload;
}

/**
 * Milliseconds of quiet that end a burst.
 *
 * Measured on the 2026-08-05 session, the two populations do not overlap and
 * are three orders of magnitude apart: gaps inside a burst run 0–2,158ms
 * (26 of 32 are under a second), while the shortest gap between two genuine
 * trading occasions in the same mint is 747,626ms — twelve minutes. Anywhere in
 * between separates them; a minute leaves margin on both sides.
 */
const BURST_QUIET_MS = 60_000;

/**
 * Split one key's answers into bursts — the quotes belonging to a single
 * decision — so `resolveQuoteAt` can return the one the trade executed against.
 *
 * A single entry decision produces SEVERAL quotes for the same key, because the
 * screener quotes the pair before the guard layer and the broker do. Measured,
 * the order is: screener forward, screener reverse, the `screen` verdict, then
 * the execution quote. The live run fills on the LAST of them — verified on
 * three separate occasions in the 2026-08-05 session, where the exit amount is
 * always the last burst member's `outAmount` times the slippage factor and
 * never the first's.
 *
 * That is why this returns the last of a burst rather than the first. Taking
 * the first picks the screener's probe, which is a real quote for the same pair
 * at the same size but is not the price anything traded at, and the exit then
 * asks to sell a quantity no live quote ever covered.
 *
 * **If a settlement probe is ever added that re-quotes AFTER execution**, the
 * last member stops being the execution quote and this rule breaks. The fix
 * then is not another heuristic but a reason tag on the recorded quote line, so
 * a replay can select by intent instead of by position.
 */
function burstsOf(history: readonly RecordedQuote[]): RecordedQuote[][] {
  const bursts: RecordedQuote[][] = [];
  let current: RecordedQuote[] = [];
  let previousAt: number | undefined;
  for (const recorded of history) {
    if (previousAt !== undefined && recorded.simClockMs - previousAt > BURST_QUIET_MS) {
      bursts.push(current);
      current = [];
    }
    current.push(recorded);
    previousAt = recorded.simClockMs;
  }
  if (current.length > 0) bursts.push(current);
  return bursts;
}

/**
 * The screen verdict for `mint` as it stood at `atSeq`.
 *
 * Same rule as `resolveQuoteAt`, for the same reason. A mint is screened once
 * per entry decision, so collapsing a session's verdicts to the last one hands
 * every earlier decision an answer from the future. On the 2026-08-05 session
 * that turned a live `unknown` — which opened nothing — into a `pass`, so the
 * replay took a position the run had refused and then tried to exit it at a
 * size no live quote had ever covered.
 */
export function resolveScreenAt(
  session: Pick<LoadedSession, 'screenHistory'>,
  mint: Address,
  atSeq: number,
): ScreenPayload | undefined {
  const verdicts = session.screenHistory.get(mint);
  if (verdicts === undefined || verdicts.length === 0) return undefined;
  for (const seen of verdicts) {
    if (seen.seq >= atSeq) return seen.payload;
  }
  return verdicts[verdicts.length - 1]!.payload;
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
