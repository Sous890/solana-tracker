/**
 * `StreamSocket` over Node's built-in WebSocket.
 *
 * Node 24 ships a global `WebSocket` (undici's), so there is no `ws`
 * dependency — verified in this runtime: text frames arrive with
 * `event.data` already a `string`, which is what `StreamSocket.onMessage`
 * promises its handler.
 *
 * `connect()` resolves on `open` and rejects if the socket fails before
 * opening. That matters: `WalletStream.connect()` subscribes immediately after
 * the promise resolves, and `send()` on a CONNECTING socket throws. A rejected
 * connect is caught by the stream and routed into its backoff, which is the
 * behaviour that keeps a provider outage from becoming a crash.
 *
 * The handlers are stored rather than registered directly so a listener
 * attached after a frame has already arrived still sees subsequent frames, and
 * so that at most one of each is ever installed on the underlying socket.
 */

import type { StreamSocket } from './walletStream.js';

export class SocketConnectError extends Error {
  constructor(detail: string) {
    super(`WebSocket connect failed: ${detail}`);
    this.name = 'SocketConnectError';
  }
}

export interface StreamSocketDeps {
  /** `RPC_WSS_URL` from `.env`. Carries the API key; never logged. */
  wssUrl: string;
  /** How long to wait for the socket to open. */
  connectTimeoutMs?: number;
  /** Injectable constructor, so tests never open a real socket. */
  WebSocketImpl?: typeof WebSocket;
}

export function createStreamSocketFactory(
  deps: StreamSocketDeps,
): () => Promise<StreamSocket> {
  const Impl = deps.WebSocketImpl ?? WebSocket;
  const connectTimeoutMs = deps.connectTimeoutMs ?? 15_000;

  return function connect(): Promise<StreamSocket> {
    return new Promise<StreamSocket>((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new Impl(deps.wssUrl);
      } catch (cause) {
        reject(new SocketConnectError((cause as Error).message));
        return;
      }

      let settled = false;
      let messageHandler: ((data: string) => void) | undefined;
      let closeHandler: (() => void) | undefined;
      let errorHandler: ((error: Error) => void) | undefined;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Close before rejecting: a socket left CONNECTING holds the handle and
        // would eventually open into a stream nobody is reading.
        try {
          socket.close();
        } catch {
          // Already closing or never opened. Nothing to release.
        }
        reject(new SocketConnectError(`did not open within ${connectTimeoutMs}ms`));
      }, connectTimeoutMs);

      socket.addEventListener('message', (event: MessageEvent) => {
        // Binary frames are not something the JSON-RPC subscription produces;
        // coercing rather than dropping means a surprise arrives at the stream's
        // parser, which reports it, instead of vanishing here.
        messageHandler?.(typeof event.data === 'string' ? event.data : String(event.data));
      });

      socket.addEventListener('close', () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new SocketConnectError('closed before opening'));
          return;
        }
        closeHandler?.();
      });

      socket.addEventListener('error', () => {
        // The browser-shaped `error` event carries no cause, by design. There is
        // nothing more specific to report than that it failed.
        const error = new Error('websocket error');
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new SocketConnectError('errored before opening'));
          return;
        }
        errorHandler?.(error);
      });

      socket.addEventListener('open', () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({
          send: (payload) => socket.send(payload),
          close: () => socket.close(),
          onMessage: (handler) => {
            messageHandler = handler;
          },
          onClose: (handler) => {
            closeHandler = handler;
          },
          onError: (handler) => {
            errorHandler = handler;
          },
        });
      });
    });
  };
}
