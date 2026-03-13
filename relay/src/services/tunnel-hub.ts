import { nanoid } from 'nanoid';
import type { RelayTunnelMessage } from '@codex-room/shared';
import type { ServerWebSocket } from 'bun';
import type { AppLogger } from './logger';

type TunnelSocket = ServerWebSocket<{
  shareId: string;
}>;

type PendingRequest = {
  requestId: string;
  shareId: string;
  started: boolean;
  status: number;
  headers: Headers;
  startResolve: (value: { status: number; headers: Headers }) => void;
  startReject: (error: Error) => void;
  responseStream: ReadableStream<Uint8Array>;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
};

function encodeJson(message: RelayTunnelMessage) {
  return JSON.stringify(message);
}

function decodeChunk(chunkBase64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(chunkBase64, 'base64'));
}

export class TunnelHub {
  private readonly sockets = new Map<string, TunnelSocket>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly pingInterval: ReturnType<typeof setInterval>;

  constructor(private readonly logger: AppLogger) {
    this.pingInterval = setInterval(() => this.pingHosts(), 30_000);
    this.pingInterval.unref?.();
  }

  attachHost(shareId: string, socket: TunnelSocket) {
    const existing = this.sockets.get(shareId);
    if (existing && existing !== socket) {
      existing.close(1012, 'Replaced by a newer tunnel connection');
    }
    this.sockets.set(shareId, socket);
    this.logger.info('relay.tunnel.connected', { shareId });
  }

  detachHost(shareId: string, socket?: TunnelSocket) {
    const existing = this.sockets.get(shareId);
    if (!existing) return;
    if (socket && existing !== socket) return;
    this.sockets.delete(shareId);
    this.logger.warn('relay.tunnel.disconnected', { shareId });

    for (const request of this.pending.values()) {
      if (request.shareId !== shareId) continue;
      this.failRequest(request.requestId, new Error('Host tunnel disconnected'));
    }
  }

  async proxyHttp(
    shareId: string,
    request: {
      method: string;
      path: string;
      headers: Record<string, string>;
      bodyBase64?: string;
      signal?: AbortSignal;
    }
  ): Promise<Response> {
    const socket = this.sockets.get(shareId);
    if (!socket) {
      return new Response(JSON.stringify({ ok: false, error: 'Share host is offline' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    const requestId = `req_${nanoid(18)}`;
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    const responseStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
      },
      cancel: () => {
        socket.send(
          encodeJson({
            type: 'relay.request.cancel',
            requestId
          })
        );
      }
    });

    const started = new Promise<{ status: number; headers: Headers }>((resolve, reject) => {
      this.pending.set(requestId, {
        requestId,
        shareId,
        started: false,
        status: 200,
        headers: new Headers(),
        startResolve: resolve,
        startReject: reject,
        responseStream,
        controller: controllerRef
      });
    });

    const pending = this.pending.get(requestId);
    if (pending) pending.controller = controllerRef;

    if (request.signal) {
      request.signal.addEventListener(
        'abort',
        () => {
          this.cancelRequest(requestId);
        },
        { once: true }
      );
    }

    this.send(socket, {
      type: 'relay.request',
      requestId,
      method: request.method,
      path: request.path,
      headers: request.headers,
      ...(request.bodyBase64 ? { bodyBase64: request.bodyBase64 } : {})
    });

    const { status, headers } = await started;
    return new Response(responseStream, {
      status,
      headers
    });
  }

  handleMessage(shareId: string, raw: unknown) {
    let message: RelayTunnelMessage;
    try {
      if (typeof raw === 'string') {
        message = JSON.parse(raw) as RelayTunnelMessage;
      } else if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
        message = JSON.parse(Buffer.from(raw).toString('utf8')) as RelayTunnelMessage;
      } else if (raw && typeof raw === 'object') {
        message = raw as RelayTunnelMessage;
      } else {
        throw new Error('Unsupported tunnel message payload');
      }
    } catch {
      this.logger.warn('relay.tunnel.message.invalid', { shareId });
      return;
    }

    switch (message.type) {
      case 'relay.response.start': {
        const pending = this.pending.get(message.requestId);
        if (!pending) return;
        pending.started = true;
        pending.status = message.status;
        pending.headers = new Headers(message.headers);
        pending.startResolve({
          status: message.status,
          headers: pending.headers
        });
        return;
      }
      case 'relay.response.chunk': {
        const pending = this.pending.get(message.requestId);
        if (!pending?.controller) return;
        pending.controller.enqueue(decodeChunk(message.chunkBase64));
        return;
      }
      case 'relay.response.end': {
        const pending = this.pending.get(message.requestId);
        if (!pending) return;
        pending.controller?.close();
        this.pending.delete(message.requestId);
        return;
      }
      case 'relay.response.error': {
        this.failRequest(message.requestId, new Error(message.error), message.status);
        return;
      }
      case 'pong':
        return;
      case 'host.connected':
      case 'relay.request':
      case 'relay.request.cancel':
      case 'ping':
        return;
    }
  }

  private cancelRequest(requestId: string) {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    const socket = this.sockets.get(pending.shareId);
    if (socket) {
      this.send(socket, {
        type: 'relay.request.cancel',
        requestId
      });
    }
    if (!pending.started) {
      pending.startReject(new Error('Request aborted'));
    } else {
      pending.controller?.close();
    }
    this.pending.delete(requestId);
  }

  private failRequest(requestId: string, error: Error, status = 502) {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    if (!pending.started) {
      pending.startReject(error);
    } else {
      pending.controller?.error(error);
    }
    this.pending.delete(requestId);
    this.logger.warn('relay.request.failed', {
      requestId,
      status,
      error: error.message
    });
  }

  private pingHosts() {
    const at = new Date().toISOString();
    for (const [shareId, socket] of this.sockets) {
      if (socket.readyState !== 1) continue;
      this.send(socket, {
        type: 'ping',
        at
      });
      this.logger.debug('relay.tunnel.ping', { shareId });
    }
  }

  private send(socket: TunnelSocket, message: RelayTunnelMessage) {
    socket.send(encodeJson(message));
  }
}
