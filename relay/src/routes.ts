import { cors } from '@elysiajs/cors';
import { Elysia } from 'elysia';
import type { RelayShareCreateInput, RelayShareCreateResult, RelayTunnelMessage } from '@codex-room/shared';
import { resolve } from 'node:path';
import { parseCookies, serializeCookie } from './services/cookies';
import type { AppLogger } from './services/logger';
import { RateLimiter } from './services/rate-limit';
import { ShareStore } from './services/share-store';
import { TunnelHub } from './services/tunnel-hub';

const VIEWER_COOKIE = 'codex_room_viewer';

const MIME_BY_EXT: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  wasm: 'application/wasm'
};

type CreateAppOptions = {
  host: string;
  port: number;
  publicBaseUrl: string;
  cookieSecure: boolean;
  frontendDist: string;
  logger: AppLogger;
  shareStore: ShareStore;
  tunnelHub: TunnelHub;
  createRateLimiter: RateLimiter;
  joinRateLimiter: RateLimiter;
};

function contentTypeFor(pathname: string, fallback = 'application/octet-stream'): string {
  const ext = pathname.split('.').pop()?.toLowerCase();
  if (!ext) return fallback;
  return MIME_BY_EXT[ext] ?? fallback;
}

async function tryServeStatic(
  frontendDist: string,
  pathname: string,
  cacheControl = 'public, max-age=31536000, immutable'
): Promise<Response | null> {
  const cleanPath = pathname.replace(/^\/+/, '');
  const absolute = resolve(frontendDist, cleanPath);
  const distRoot = resolve(frontendDist);
  if (!absolute.startsWith(distRoot)) return null;

  const file = Bun.file(absolute);
  if (!(await file.exists())) return null;

  return new Response(await file.arrayBuffer(), {
    headers: {
      'Content-Type': contentTypeFor(cleanPath, file.type || undefined),
      'Cache-Control': cacheControl
    }
  });
}

function unauthorizedJson(message = 'Unauthorized') {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 401,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function tooManyRequestsJson(message = 'Too many requests') {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 429,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function readClientIp(request: Request) {
  return (
    request.headers.get('cf-connecting-ip')?.trim() ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

function copyForwardHeaders(request: Request): Record<string, string> {
  const allowed = new Set([
    'accept',
    'accept-language',
    'cache-control',
    'content-language',
    'content-type',
    'if-match',
    'if-modified-since',
    'if-none-match',
    'if-unmodified-since',
    'last-event-id',
    'range'
  ]);
  const headers: Record<string, string> = {};
  for (const [key, value] of request.headers.entries()) {
    const normalized = key.toLowerCase();
    if (!allowed.has(normalized)) continue;
    headers[key] = value;
  }
  return headers;
}

async function encodeBody(request: Request) {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return undefined;
  return Buffer.from(body).toString('base64');
}

function roomIdMatches(pathname: string, expectedRoomId: string) {
  const match = pathname.match(/^\/api\/rooms\/([^/]+)\b/);
  if (!match) return true;
  try {
    return decodeURIComponent(match[1]) === expectedRoomId;
  } catch {
    return false;
  }
}

function isAllowedApiPath(pathname: string) {
  return (
    pathname === '/api/runtime' ||
    pathname === '/api/codex/threads' ||
    pathname === '/api/rooms' ||
    /^\/api\/rooms\/[^/]+\/thread$/.test(pathname) ||
    /^\/api\/rooms\/[^/]+\/state$/.test(pathname) ||
    /^\/api\/rooms\/[^/]+\/messages$/.test(pathname) ||
    /^\/api\/rooms\/[^/]+\/editor$/.test(pathname) ||
    /^\/api\/rooms\/[^/]+\/codex\/rpc$/.test(pathname) ||
    /^\/api\/rooms\/[^/]+\/codex\/respond$/.test(pathname) ||
    /^\/api\/rooms\/[^/]+\/events$/.test(pathname)
  );
}

export function createApp(options: CreateAppOptions) {
  const {
    host,
    port,
    publicBaseUrl,
    cookieSecure,
    frontendDist,
    logger,
    shareStore,
    tunnelHub,
    createRateLimiter,
    joinRateLimiter
  } = options;

  const proxyViewerRequest = async (request: Request, expectedRoomId?: string) => {
    const url = new URL(request.url);
    if (!isAllowedApiPath(url.pathname)) {
      return new Response(JSON.stringify({ ok: false, error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    const cookies = parseCookies(request);
    const share = shareStore.authenticateViewer(cookies[VIEWER_COOKIE] ?? '', expectedRoomId);
    if (!share) {
      return unauthorizedJson('Share access is missing or expired');
    }
    if (!roomIdMatches(url.pathname, share.roomId)) {
      return unauthorizedJson('Share is not allowed to access this room');
    }

    return tunnelHub.proxyHttp(share.id, {
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers: copyForwardHeaders(request),
      bodyBase64: await encodeBody(request),
      signal: request.signal
    });
  };

  return new Elysia()
    .use(cors({ origin: true, credentials: true }))
    .get('/health', () => ({
      ok: true,
      host,
      port,
      publicBaseUrl,
      at: new Date().toISOString()
    }))
    .post('/api/shares', async ({ body, request, set }) => {
      const ip = readClientIp(request);
      if (!createRateLimiter.consume(`create:${ip}`)) {
        set.status = 429;
        return { ok: false, error: 'Share creation is rate limited' };
      }

      try {
        const share = shareStore.createShare(body as RelayShareCreateInput);
        set.status = 201;
        return share satisfies RelayShareCreateResult;
      } catch (error) {
        set.status = 400;
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    })
    .get('/r/:shareSlug', ({ params, request, set }) => {
      const ip = readClientIp(request);
      if (!joinRateLimiter.consume(`join:${ip}`)) {
        set.status = 429;
        return tooManyRequestsJson('Join attempts are rate limited');
      }

      try {
        const created = shareStore.createViewerSession(params.shareSlug);
        if (!created) {
          set.status = 404;
          return new Response('Share not found', { status: 404 });
        }

        set.headers['Set-Cookie'] = serializeCookie(VIEWER_COOKIE, created.cookieValue, {
          httpOnly: true,
          sameSite: 'Lax',
          secure: cookieSecure,
          maxAge: created.maxAgeSeconds
        });
        set.status = 302;
        set.headers.Location = `/?room=${encodeURIComponent(created.share.roomId)}`;
        return '';
      } catch (error) {
        set.status = 403;
        return new Response(error instanceof Error ? error.message : 'Forbidden', {
          status: 403,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }
    })
    .ws('/api/tunnel/connect', {
      open(ws) {
        const query = ((ws.data as { query?: Record<string, string> } | undefined)?.query ?? {}) as Record<string, string>;
        const shareId = query.shareId?.trim() ?? '';
        const hostToken = query.hostToken?.trim() ?? '';
        const share = shareStore.authenticateHost(shareId, hostToken);
        if (!share) {
          ws.close(1008, 'Unauthorized host tunnel');
          return;
        }

        (ws.data as { shareId: string }).shareId = share.id;
        tunnelHub.attachHost(share.id, ws as never);
        ws.send(
          JSON.stringify({
            type: 'host.connected',
            shareId: share.id,
            roomId: share.roomId,
            expiresAt: share.expiresAt
          } satisfies RelayTunnelMessage)
        );
      },
      message(ws, message) {
        const shareId = (ws.data as { shareId?: string } | undefined)?.shareId;
        if (!shareId) {
          ws.close(1008, 'Missing share binding');
          return;
        }
        tunnelHub.handleMessage(shareId, message as string);
      },
      close(ws) {
        const shareId = (ws.data as { shareId?: string } | undefined)?.shareId;
        if (!shareId) return;
        tunnelHub.detachHost(shareId, ws as never);
      }
    })
    .get('/api/runtime', ({ request }) => proxyViewerRequest(request))
    .get('/api/codex/threads', ({ request }) => proxyViewerRequest(request))
    .get('/api/rooms', ({ request }) => proxyViewerRequest(request))
    .post('/api/rooms/:roomId/thread', ({ request, params }) => proxyViewerRequest(request, params.roomId))
    .get('/api/rooms/:roomId/state', ({ request, params }) => proxyViewerRequest(request, params.roomId))
    .post('/api/rooms/:roomId/messages', ({ request, params }) => proxyViewerRequest(request, params.roomId))
    .post('/api/rooms/:roomId/editor', ({ request, params }) => proxyViewerRequest(request, params.roomId))
    .post('/api/rooms/:roomId/codex/rpc', ({ request, params }) => proxyViewerRequest(request, params.roomId))
    .post('/api/rooms/:roomId/codex/respond', ({ request, params }) => proxyViewerRequest(request, params.roomId))
    .post('/api/rooms/:roomId/events', ({ request, params }) => proxyViewerRequest(request, params.roomId))
    .get('/', async () => {
      return (
        (await tryServeStatic(frontendDist, 'index.html', 'no-cache')) ??
        new Response('Frontend build not found', { status: 500 })
      );
    })
    .get('/assets/*', async ({ params }) => {
      return (
        (await tryServeStatic(frontendDist, `assets/${params['*'] ?? ''}`)) ??
        new Response('Not found', { status: 404 })
      );
    })
    .get('/*', async ({ path }) => {
      if (path.startsWith('/api/') || path === '/health') {
        return new Response('Not found', { status: 404 });
      }

      const staticResponse = await tryServeStatic(frontendDist, path);
      if (staticResponse) return staticResponse;

      return (
        (await tryServeStatic(frontendDist, 'index.html', 'no-cache')) ??
        new Response('Frontend build not found', { status: 500 })
      );
    });
}
