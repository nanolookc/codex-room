import type { RelayShareCreateResult, RelayTunnelMessage } from '@codex-room/shared';

type PublishOptions = {
  relayUrl: string;
  localBaseUrl: string;
  sessionKey: string;
  roomId: string;
  workspace?: string;
  hostName?: string;
  ttlSeconds?: number;
  maxViewers?: number;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
};

type TunnelClient = {
  share: RelayShareCreateResult;
  close: () => void;
  done: Promise<void>;
};

function normalizeRelayUrl(url: string) {
  return url.replace(/\/+$/, '');
}

function relayWebSocketUrl(relayUrl: string, shareId: string, hostToken: string) {
  const parsed = new URL(normalizeRelayUrl(relayUrl));
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.pathname = '/api/tunnel/connect';
  parsed.search = '';
  parsed.searchParams.set('shareId', shareId);
  parsed.searchParams.set('hostToken', hostToken);
  return parsed.toString();
}

function encodeBase64(bytes: Uint8Array | ArrayBuffer) {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64');
}

function decodeBase64(payload: string) {
  return Buffer.from(payload, 'base64');
}

function copyResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    const normalized = key.toLowerCase();
    if (normalized === 'content-length' || normalized === 'connection' || normalized === 'transfer-encoding') {
      continue;
    }
    result[key] = value;
  }
  return result;
}

async function waitForBackend(localBaseUrl: string, signal?: AbortSignal) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Publish aborted');
    try {
      const response = await fetch(`${localBaseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Backend is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Local codex-room backend did not become ready in time');
}

async function createShare(options: PublishOptions): Promise<RelayShareCreateResult> {
  const response = await fetch(`${normalizeRelayUrl(options.relayUrl)}/api/shares`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roomId: options.roomId,
      workspace: options.workspace,
      hostName: options.hostName,
      ...(typeof options.ttlSeconds === 'number' ? { ttlSeconds: options.ttlSeconds } : {}),
      ...(typeof options.maxViewers === 'number' ? { maxViewers: options.maxViewers } : {})
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Relay share creation failed (${response.status}): ${text || 'unknown error'}`);
  }

  return (await response.json()) as RelayShareCreateResult;
}

export async function startRelayTunnel(options: PublishOptions): Promise<TunnelClient> {
  await waitForBackend(options.localBaseUrl, options.signal);
  const share = await createShare(options);
  const pendingRequests = new Map<string, AbortController>();
  let closed = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const cleanClose = () => {
    if (closed) return;
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    for (const controller of pendingRequests.values()) controller.abort();
    pendingRequests.clear();
    socket?.close();
    resolveDone();
  };

  options.signal?.addEventListener('abort', cleanClose, { once: true });

  const handleTunnelRequest = async (message: Extract<RelayTunnelMessage, { type: 'relay.request' }>) => {
    const controller = new AbortController();
    pendingRequests.set(message.requestId, controller);

    try {
      const headers = new Headers(message.headers);
      headers.set('x-codex-room-key', options.sessionKey);
      const response = await fetch(`${options.localBaseUrl}${message.path}`, {
        method: message.method,
        headers,
        ...(message.bodyBase64 ? { body: decodeBase64(message.bodyBase64) } : {}),
        signal: controller.signal
      });

      socket?.send(
        JSON.stringify({
          type: 'relay.response.start',
          requestId: message.requestId,
          status: response.status,
          headers: copyResponseHeaders(response.headers)
        } satisfies RelayTunnelMessage)
      );

      if (response.body) {
        const reader = response.body.getReader();
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          socket?.send(
            JSON.stringify({
              type: 'relay.response.chunk',
              requestId: message.requestId,
              chunkBase64: encodeBase64(value)
            } satisfies RelayTunnelMessage)
          );
        }
      }

      socket?.send(
        JSON.stringify({
          type: 'relay.response.end',
          requestId: message.requestId
        } satisfies RelayTunnelMessage)
      );
    } catch (error) {
      if (!closed) {
        socket?.send(
          JSON.stringify({
            type: 'relay.response.error',
            requestId: message.requestId,
            status: 502,
            error: error instanceof Error ? error.message : String(error)
          } satisfies RelayTunnelMessage)
        );
      }
    } finally {
      pendingRequests.delete(message.requestId);
    }
  };

  const connect = () => {
    if (closed) return;
    socket = new WebSocket(relayWebSocketUrl(options.relayUrl, share.shareId, share.hostToken));

    socket.addEventListener('open', () => {
      reconnectAttempts = 0;
      options.onStatus?.(`Relay tunnel connected: ${share.viewerUrl}`);
    });

    socket.addEventListener('message', (event) => {
      let message: RelayTunnelMessage;
      try {
        message = JSON.parse(String(event.data)) as RelayTunnelMessage;
      } catch {
        return;
      }

      switch (message.type) {
        case 'relay.request':
          void handleTunnelRequest(message);
          return;
        case 'relay.request.cancel': {
          const controller = pendingRequests.get(message.requestId);
          controller?.abort();
          pendingRequests.delete(message.requestId);
          return;
        }
        case 'ping':
          socket?.send(JSON.stringify({ type: 'pong', at: message.at } satisfies RelayTunnelMessage));
          return;
        case 'host.connected':
        case 'relay.response.start':
        case 'relay.response.chunk':
        case 'relay.response.end':
        case 'relay.response.error':
        case 'pong':
          return;
      }
    });

    socket.addEventListener('close', () => {
      if (closed) return;
      reconnectAttempts += 1;
      const delayMs = Math.min(10_000, 500 * 2 ** Math.min(reconnectAttempts, 4));
      options.onStatus?.(`Relay tunnel disconnected, retrying in ${Math.round(delayMs / 1000)}s`);
      reconnectTimer = setTimeout(connect, delayMs);
    });

    socket.addEventListener('error', () => {
      // The close event handles reconnects.
    });
  };

  connect();

  return {
    share,
    close: cleanClose,
    done
  };
}
