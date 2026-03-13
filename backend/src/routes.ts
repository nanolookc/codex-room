import { Elysia, sse } from 'elysia';
import { cors } from '@elysiajs/cors';
import { resolve } from 'node:path';
import type {
  CodexRpcCallInput,
  CodexRpcRespondInput,
  SendMessageInput,
  UpdateEditorInput
} from '@codex-room/shared';
import { AppServerSession } from './services/codex-app-server-session';
import { CodexRoomProxyManager } from './services/codex-room-proxy';
import { EditorConflictError, RoomStore } from './services/room-store';
import { AppLogger } from './services/logger';

type CodexThreadSummary = {
  id: string;
  preview?: string;
  updatedAt?: number;
  createdAt?: number;
  model?: string;
  cwd?: string;
  source?: string;
};

type CreateAppOptions = {
  host: string;
  port: number;
  workingDirectory: string;
  sessionKey: string;
  codexModel: string;
  codexReasoningEffort: string;
  serveFrontend: boolean;
  frontendDist: string;
  logger: AppLogger;
  roomStore: RoomStore;
  codexProxy: CodexRoomProxyManager;
};

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

function readRequestSessionKey(request: Request): string {
  const fromHeader = request.headers.get('x-codex-room-key')?.trim();
  if (fromHeader) return fromHeader;
  try {
    const url = new URL(request.url);
    return url.searchParams.get('key')?.trim() ?? '';
  } catch {
    return '';
  }
}

function unauthorizedJson(message = 'Unauthorized'): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 401,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function contentTypeFor(pathname: string, fallback = 'application/octet-stream'): string {
  const ext = pathname.split('.').pop()?.toLowerCase();
  if (!ext) return fallback;
  return MIME_BY_EXT[ext] ?? fallback;
}

async function listCodexThreads(
  logger: AppLogger,
  workingDirectory: string,
  limit: number
): Promise<CodexThreadSummary[]> {
  const session = await AppServerSession.start(logger);
  try {
    const response = await session.request('thread/list', {
      limit,
      sortKey: 'updated_at',
      sourceKinds: ['appServer', 'cli', 'vscode'],
      ...(workingDirectory ? { cwd: workingDirectory } : {})
    });
    const data = Array.isArray(response?.data) ? response.data : [];
    return data
      .map((entry: any): CodexThreadSummary | null => {
        const id = typeof entry?.id === 'string' ? entry.id : '';
        if (!id) return null;
        return {
          id,
          preview: typeof entry?.preview === 'string' ? entry.preview : undefined,
          updatedAt:
            typeof entry?.updatedAt === 'number'
              ? entry.updatedAt
              : typeof entry?.updated_at === 'number'
                ? entry.updated_at
                : undefined,
          createdAt:
            typeof entry?.createdAt === 'number'
              ? entry.createdAt
              : typeof entry?.created_at === 'number'
                ? entry.created_at
                : undefined,
          model:
            typeof entry?.model === 'string'
              ? entry.model
              : typeof entry?.modelProvider === 'string'
                ? entry.modelProvider
                : undefined,
          cwd: typeof entry?.cwd === 'string' ? entry.cwd : undefined,
          source: typeof entry?.source === 'string' ? entry.source : undefined
        };
      })
      .filter((entry): entry is CodexThreadSummary => Boolean(entry));
  } finally {
    session.close();
  }
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

  const bytes = await file.arrayBuffer();
  return new Response(bytes, {
    headers: {
      'Content-Type': contentTypeFor(cleanPath, file.type || undefined),
      'Cache-Control': cacheControl
    }
  });
}

export function createApp(options: CreateAppOptions) {
  const {
    host,
    port,
    workingDirectory,
    sessionKey,
    codexModel,
    codexReasoningEffort,
    serveFrontend,
    frontendDist,
    logger,
    roomStore,
    codexProxy
  } = options;

  const app = new Elysia()
    .use(cors({ origin: true }))
    .onBeforeHandle(({ request, path }) => {
      logger.debug('http.request', {
        method: request.method,
        path
      });
      if (!sessionKey) return;
      if (request.method === 'OPTIONS') return;
      if (!path.startsWith('/api/')) return;
      const provided = readRequestSessionKey(request);
      if (provided && provided === sessionKey) return;
      logger.warn('http.request.unauthorized', {
        method: request.method,
        path
      });
      return unauthorizedJson('Missing or invalid session key');
    })
    .get('/health', () => ({ ok: true, at: new Date().toISOString() }))
    .get('/api/runtime', () => ({
      host,
      port,
      workingDirectory,
      servingFrontend: serveFrontend,
      requiresSessionKey: Boolean(sessionKey),
      codexModel,
      codexReasoningEffort
    }))
    .post('/api/logout', () => ({ ok: true }))
    .get('/api/codex/threads', async ({ query }) => {
      const limit = Number(query.limit ?? 30);
      const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 30;
      logger.info('codex.threads.requested', { limit: safeLimit, scope: 'app_server' });
      const data = await listCodexThreads(logger, workingDirectory, safeLimit);
      return { data };
    })
    .get('/api/rooms', () => roomStore.listRooms())
    .post('/api/rooms/:roomId/thread', async ({ params, body }) => {
      const input = body as { threadId?: string };
      const threadId = input.threadId?.trim();
      if (!threadId) return { ok: false, error: 'threadId is required' };
      try {
        await codexProxy.call(params.roomId, 'thread/resume', { threadId });
        roomStore.setThreadId(params.roomId, threadId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('outside allowed workspace scope')) {
          logger.warn('codex.thread.hydration.scope_denied', {
            roomId: params.roomId,
            threadId,
            error: message
          });
          return new Response(JSON.stringify({ ok: false, error: 'Thread is outside this project' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
          });
        }
        const isExpectedNewThread =
          message.includes('thread not loaded') ||
          message.includes('no rollout found') ||
          message.includes('not found');
        logger[isExpectedNewThread ? 'debug' : 'warn']('codex.thread.hydration.failed', {
          roomId: params.roomId,
          threadId,
          error: message
        });
        return new Response(
          JSON.stringify({
            ok: false,
            error: isExpectedNewThread ? 'Thread was not found in this project' : message
          }),
          {
            status: isExpectedNewThread ? 404 : 502,
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
          }
        );
      }
      return { ok: true, roomId: params.roomId, threadId, imported: 0 };
    })
    .get('/api/rooms/:roomId/state', ({ params }) => {
      logger.info('room.state.requested', { roomId: params.roomId });
      return roomStore.getSnapshot(params.roomId);
    })
    .post('/api/rooms/:roomId/messages', ({ params, body }) => {
      const input = body as SendMessageInput;
      logger.info('room.message.requested', {
        roomId: params.roomId,
        userId: input.userId,
        userName: input.userName,
        length: input.text?.length ?? 0
      });
      return roomStore.addMessage(params.roomId, input.userId, input.userName, input.text);
    })
    .post('/api/rooms/:roomId/editor', ({ params, body }) => {
      const input = body as UpdateEditorInput;
      logger.debug('room.editor.requested', {
        roomId: params.roomId,
        userId: input.userId,
        length: input.text?.length ?? 0,
        selectionStart: input.selectionStart ?? null,
        selectionEnd: input.selectionEnd ?? null
      });
      try {
        return roomStore.updateEditor(params.roomId, input.userId, input.text, {
          userName: input.userName,
          baseVersion: input.baseVersion,
          selectionStart: input.selectionStart,
          selectionEnd: input.selectionEnd
        });
      } catch (error) {
        if (error instanceof EditorConflictError) {
          return new Response(
            JSON.stringify({ ok: false, error: error.message, code: 'EDITOR_CONFLICT', editor: error.editor }),
            {
              status: 409,
              headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }
          );
        }
        throw error;
      }
    })
    .post('/api/rooms/:roomId/codex/rpc', async ({ params, body, set }) => {
      const input = body as CodexRpcCallInput;
      try {
        const result = await codexProxy.call(params.roomId, input.method, input.params);
        return { ok: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status =
          message.includes('outside allowed workspace scope')
            ? 403
            : message.includes('managed by the backend')
              ? 400
              : 500;
        set.status = status;
        logger.warn('codex.rpc.call.failed', {
          roomId: params.roomId,
          method: input?.method,
          error: message,
          status
        });
        return { ok: false, error: message };
      }
    })
    .post('/api/rooms/:roomId/codex/respond', async ({ params, body, set }) => {
      const input = body as CodexRpcRespondInput;
      try {
        await codexProxy.respond(params.roomId, input.requestId, {
          result: input.result,
          error: input.error
        });
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('Unknown or already resolved server request')) {
          logger.debug('codex.rpc.respond.duplicate_ignored', {
            roomId: params.roomId,
            requestId: input?.requestId
          });
          return { ok: true, alreadyResolved: true };
        }
        set.status = 400;
        logger.warn('codex.rpc.respond.failed', {
          roomId: params.roomId,
          requestId: input?.requestId,
          error: message
        });
        return { ok: false, error: message };
      }
    })
    .post('/api/rooms/:roomId/events', async function* ({ params, request, set }) {
      logger.info('room.events.connected', { roomId: params.roomId });
      set.headers['Cache-Control'] = 'no-cache';
      set.headers.Connection = 'keep-alive';

      const queue: string[] = [];
      const maxQueueSize = 500;
      let resolveNext: (() => void) | null = null;
      const push = (payload: unknown) => {
        if (queue.length >= maxQueueSize) {
          const dropped = queue.length - maxQueueSize + 1;
          queue.splice(0, dropped);
          queue.push(
            JSON.stringify({
              type: 'system.queueOverflow',
              dropped,
              at: new Date().toISOString()
            })
          );
        }
        queue.push(JSON.stringify(payload));
        if (resolveNext) {
          resolveNext();
          resolveNext = null;
        }
      };

      const unsubscribe = roomStore.subscribe(params.roomId, (event) => {
        push(event);
      });

      push({ type: 'system.connected', at: new Date().toISOString() });
      const heartbeat = setInterval(() => {
        push({ type: 'system.heartbeat', at: new Date().toISOString() });
      }, 15_000);
      heartbeat.unref?.();
      try {
        while (!request.signal.aborted) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              resolveNext = resolve;
            });
          }

          while (queue.length > 0) {
            const data = queue.shift();
            if (!data) break;
            yield sse(data);
          }
        }
      } finally {
        clearInterval(heartbeat);
        logger.info('room.events.disconnected', { roomId: params.roomId });
        unsubscribe();
      }
    });

  if (serveFrontend) {
    app
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

  return app;
}
