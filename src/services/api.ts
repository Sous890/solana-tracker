/**
 * The local control API.
 *
 * ── LOOPBACK ONLY, AND NOT CONFIGURABLE ───────────────────────────────────
 *
 * The host is the literal `127.0.0.1` and there is no option to change it.
 * This API has no authentication, and it exposes `POST /flatten` — one
 * unauthenticated request that liquidates the entire book. A `host` option
 * would be a single config typo away from putting that on a LAN, so the
 * decision is made in code where changing it requires a review. Anyone who
 * genuinely needs remote access should put an authenticating proxy in front of
 * it and keep the origin on loopback.
 *
 * ── AMOUNTS CROSS AS STRINGS ──────────────────────────────────────────────
 *
 * Every `bigint` is serialised as a decimal **string**, never a JSON number.
 * The reason is the reason the whole codebase uses bigint: a 9-decimal mint
 * with 1e9 supply has 1e18 base units, and float64 holds exact integers only to
 * ~9e15. Emitting those as numbers would silently round a position's size at
 * the last hop, after all the care taken to keep it exact for the first eight.
 *
 * ── START IS STRICT, STOP IS NOT ──────────────────────────────────────────
 *
 * `POST /start` answers 409 when the bot is not idle, because a second start
 * is a caller bug. `POST /stop` answers 200 whatever the state, because asking
 * a stopped bot to stop is satisfied. This mirrors `Tracker`, which mirrors
 * `guards.ts`. `POST /flatten` is the only route that sells, and it is the only
 * one that demands a body.
 */

import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../core/config.js';
import type { Ledger } from '../db/ledger.js';
import type { FillsView } from '../db/fillsView.js';
import { MAX_FILL_PAGE } from '../db/fillsView.js';
import { Tracker, TrackerStateError, markSol } from './tracker.js';
import type { TrackerEventRecord } from './tracker.js';
import { WalletStoreError } from './walletStore.js';
import type { WalletStore } from './walletStore.js';
import { ParamsError } from './analysisParams.js';
import type { AnalysisParamsStore } from './analysisParams.js';

/** Not an option. See the module header. */
export const API_HOST = '127.0.0.1';

export const DEFAULT_FILL_LIMIT = 50;

/**
 * The screener page, read from source rather than bundled.
 *
 * `tsc` copies no assets, so a path relative to the compiled module would break
 * the built output. Every entry point runs from the project root, so the root
 * is the anchor; `UI_PATH` overrides it for anyone who runs from elsewhere.
 */
export const DEFAULT_UI_PATH = 'src/ui/index.html';

/** SSE comment frame interval, to keep an idle connection from being reaped. */
export const SSE_KEEPALIVE_MS = 15_000;

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * Deep-convert to something `JSON.stringify` accepts, turning every `bigint`
 * into a decimal string.
 *
 * Applied at the route rather than installed as a global replacer so that the
 * conversion is visible at each site — a future route that forgets it fails
 * loudly (`JSON.stringify` throws on a BigInt) instead of quietly emitting a
 * rounded number.
 */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toJsonSafe(inner);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface ApiDeps {
  tracker: Tracker;
  ledger: Ledger;
  fills: FillsView;
  config: Config;
  /**
   * The tracked-wallet registry. Absent disables `/wallets` and the UI, which
   * is what the existing tests construct — an API without a store is still a
   * complete control API, it just cannot edit the watchlist.
   */
  wallets?: WalletStore;
  /**
   * Decision parameters for the OFFLINE analysis. Absent hides the routes.
   * Nothing in the trading path reads these — see `analysisParams.ts`.
   */
  analysisParams?: AnalysisParamsStore;
  /** Where to read the screener page from. Ignored when `wallets` is absent. */
  uiPath?: string;
  /** Fastify's own logging. Off by default; the tracker's pino logger is the record. */
  fastifyLogger?: boolean;
  keepaliveMs?: number;
}

export function createApi(deps: ApiDeps): FastifyInstance {
  const { tracker, ledger, fills, wallets, analysisParams } = deps;
  const app = Fastify({ logger: deps.fastifyLogger ?? false });

  const send = (reply: FastifyReply, status: number, body: unknown): FastifyReply =>
    reply.code(status).type('application/json').send(toJsonSafe(body));

  // -- state ----------------------------------------------------------------

  app.get('/state', async (_request, reply) => {
    const state = tracker.getState();
    return send(reply, 200, {
      mode: state.mode,
      status: state.status,
      killSwitchEngaged: state.killSwitchEngaged,
      startedAt: state.startedAt ?? null,
      openPositions: ledger.getOpenPositions().length,
      // Surfaced because it is the gate that silently refuses every buy. A
      // client showing "running" while this is non-zero is showing a lie.
      unacknowledgedOrphans: ledger.getUnacknowledgedOrphanCount(),
    });
  });

  // -- lifecycle ------------------------------------------------------------

  app.post('/start', async (_request, reply) => {
    try {
      const report = await tracker.start();
      // The stream has now subscribed, and to whatever the live array held at
      // that instant. Snapshotting here rather than inside `Tracker` keeps the
      // tracker unaware of the store: this is the only path that starts a run.
      wallets?.markApplied();
      return send(reply, 200, {
        status: tracker.getState().status,
        reconciled: {
          openPositions: report.openPositions.map((position) => position.mint),
          orphaned: report.orphaned.map((orphan) => orphan.id),
          recovered: report.recovered.map((intent) => intent.id),
          dirty: report.dirty,
        },
      });
    } catch (cause) {
      if (cause instanceof TrackerStateError) {
        return send(reply, 409, { error: 'INVALID_STATE', status: cause.status, message: cause.message });
      }
      return send(reply, 500, { error: 'START_FAILED', message: (cause as Error).message });
    }
  });

  app.post('/stop', async (_request, reply) => {
    await tracker.stop();
    // Deliberately explicit in the response: an operator hitting stop during an
    // incident should not have to remember that it is not an exit.
    return send(reply, 200, {
      status: tracker.getState().status,
      soldNothing: true,
      openPositions: ledger.getOpenPositions().length,
    });
  });

  app.post('/kill', async (_request, reply) => {
    tracker.killSwitch();
    return send(reply, 200, {
      killSwitchEngaged: true,
      // Releasing is not exposed. See `Tracker.releaseKillSwitch`.
      releasedBy: 'operator action at the console, not this API',
    });
  });

  app.post('/flatten', async (request: FastifyRequest, reply) => {
    const body = request.body as { confirm?: unknown } | undefined;
    if (body?.confirm !== true) {
      return send(reply, 400, {
        error: 'CONFIRMATION_REQUIRED',
        message: 'POST /flatten sells every open position. Send {"confirm": true}.',
      });
    }

    const result = await tracker.flatten();
    // 207 when some position could not be exited: the request neither succeeded
    // nor failed, and the mints still held are the part that matters.
    return send(reply, result.failures.length > 0 ? 207 : 200, {
      completed: result.completed,
      failures: result.failures,
      stillHeld: ledger.getOpenPositions().map((position) => position.mint),
    });
  });

  // -- reads ----------------------------------------------------------------

  app.get('/positions', async (_request, reply) => {
    const positions = tracker.positions();
    return send(reply, 200, {
      positions: positions.map((position) => ({
        ...position,
        markSol: markSol(position),
      })),
    });
  });

  app.get('/fills', async (request, reply) => {
    const query = request.query as { limit?: string; mint?: string };
    const requested = Number(query.limit ?? DEFAULT_FILL_LIMIT);
    const limit = Number.isFinite(requested) ? requested : DEFAULT_FILL_LIMIT;
    const rows = fills.recent(limit, query.mint === undefined ? {} : { mint: query.mint });
    return send(reply, 200, { fills: rows, limit: Math.min(Math.max(1, Math.floor(limit)), MAX_FILL_PAGE) });
  });

  // -- wallets --------------------------------------------------------------

  /**
   * The watchlist, and the screener page that edits it.
   *
   * Registered only when a store was supplied. Writes land in `config.json`
   * immediately but reach the RPC subscriptions only at the next `start()`;
   * `pendingRestart` is how a client learns that the two have diverged, and it
   * is the reason these routes are worth having over hand-editing the file.
   */
  if (wallets !== undefined) {
    const walletError = (reply: FastifyReply, cause: unknown): FastifyReply => {
      if (!(cause instanceof WalletStoreError)) throw cause;
      const status =
        cause.code === 'NOT_FOUND' ? 404 : cause.code === 'DUPLICATE' ? 409 : cause.code === 'WRITE_FAILED' ? 500 : 400;
      return send(reply, status, { error: cause.code, message: cause.message });
    };

    const snapshot = (): unknown => ({
      wallets: wallets.list(),
      applied: wallets.appliedAddresses(),
      pendingRestart: wallets.pendingRestart(tracker.getState().status !== 'idle'),
    });

    app.get('/wallets', async (_request, reply) => send(reply, 200, snapshot()));

    app.post('/wallets', async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      try {
        const added = wallets.add(body);
        return send(reply, 201, { wallet: added, ...(snapshot() as object) });
      } catch (cause) {
        return walletError(reply, cause);
      }
    });

    app.patch('/wallets/:address', async (request, reply) => {
      const { address } = request.params as { address: string };
      const body = (request.body ?? {}) as Record<string, unknown>;
      try {
        const updated = wallets.update(address, body);
        return send(reply, 200, { wallet: updated, ...(snapshot() as object) });
      } catch (cause) {
        return walletError(reply, cause);
      }
    });

    app.delete('/wallets/:address', async (request, reply) => {
      const { address } = request.params as { address: string };
      try {
        const removed = wallets.remove(address);
        // Said explicitly because it is the thing an operator will worry about
        // at the moment they click Remove: untracking is not an exit.
        return send(reply, 200, {
          removed: removed.address,
          soldNothing: true,
          ...(snapshot() as object),
        });
      } catch (cause) {
        return walletError(reply, cause);
      }
    });

    if (analysisParams !== undefined) {
      app.get('/analysis-params', async (_request, reply) =>
        send(reply, 200, analysisParams.get()),
      );

      app.put('/analysis-params', async (request, reply) => {
        const body = (request.body ?? {}) as Record<string, unknown>;
        try {
          const note = typeof body['note'] === 'string' ? body['note'] : '';
          return send(reply, 200, analysisParams.set(body, note));
        } catch (cause) {
          if (cause instanceof ParamsError) {
            return send(reply, 400, { error: 'INVALID_PARAM', message: cause.message });
          }
          throw cause;
        }
      });
    }

    const uiPath = deps.uiPath ?? process.env['UI_PATH'] ?? DEFAULT_UI_PATH;
    const serveUi = async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      let html: string;
      try {
        html = readFileSync(uiPath, 'utf8');
      } catch {
        return send(reply, 404, {
          error: 'UI_NOT_FOUND',
          message: `Cannot read the screener page at ${uiPath}. Run from the project root or set UI_PATH.`,
        });
      }
      // Read per request rather than cached at boot: editing the page and
      // reloading the browser should be one step, not two.
      return reply.code(200).type('text/html; charset=utf-8').send(html);
    };

    app.get('/', serveUi);
    app.get('/ui', serveUi);
  }

  // -- events ---------------------------------------------------------------

  /**
   * Server-sent events, with replay.
   *
   * A client attaching mid-run is blind to everything that already happened, so
   * the buffered tail is written before the live subscription starts. `id:`
   * carries the tracker's sequence number and `Last-Event-ID` is honoured, so a
   * reconnecting client resumes rather than re-reading — the same distinction
   * the wallet stream's cursor makes, for the same reason.
   */
  app.get('/events', (request, reply) => {
    // Fastify must not try to send a body of its own once the raw socket is in
    // use for the stream.
    reply.hijack();

    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    // Flush the headers immediately with a comment frame. Without it a client
    // attaching to a quiet tracker — nothing buffered, nothing happening — sees
    // no response at all until the first event, because the headers sit in the
    // socket buffer waiting for a body. The connection looks hung exactly when
    // the bot is behaving.
    raw.write(': connected\n\n');

    const write = (event: TrackerEventRecord): void => {
      raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(toJsonSafe(event))}\n\n`);
    };

    const header = request.headers['last-event-id'];
    const since = Number(Array.isArray(header) ? header[0] : header);
    for (const event of tracker.recentEvents(Number.isFinite(since) ? since : undefined)) {
      write(event);
    }

    const onEvent = (event: TrackerEventRecord): void => write(event);
    tracker.on('event', onEvent);

    const keepalive = setInterval(() => {
      raw.write(': keepalive\n\n');
    }, deps.keepaliveMs ?? SSE_KEEPALIVE_MS);
    // The heartbeat must not be the reason the process refuses to exit.
    (keepalive as unknown as { unref?: () => void }).unref?.();

    const cleanup = (): void => {
      clearInterval(keepalive);
      tracker.off('event', onEvent);
    };
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });

  return app;
}

export interface RunningApi {
  app: FastifyInstance;
  /** The bound origin, e.g. `http://127.0.0.1:8787`. Always loopback. */
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Bind the API. Port 0 asks the OS for a free one, which is what tests use. */
export async function startApi(deps: ApiDeps & { port?: number }): Promise<RunningApi> {
  const app = createApi(deps);
  await app.listen({ host: API_HOST, port: deps.port ?? 8787 });

  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : (deps.port ?? 8787);

  return {
    app,
    url: `http://${API_HOST}:${port}`,
    port,
    close: () => app.close(),
  };
}
