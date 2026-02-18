import { Elysia, sse } from 'elysia';
import { cors } from '@elysiajs/cors';
import { resolve } from 'node:path';
import type { RunCodexInput, SendMessageInput, UpdateEditorInput } from '@nlk/shared';
import { RoomStore } from './services/room-store';
import { CodexRunner } from './services/codex-runner';
import { AppLogger } from './services/logger';

const HOST = process.env.HOST ?? '0.0.0.0';
const PORT = Number(process.env.PORT ?? 3001);
const WORKING_DIRECTORY = process.env.NLK_WORKDIR ?? process.cwd();
const CODEX_MODEL = process.env.CODEX_MODEL ?? 'default';
const CODEX_REASONING_EFFORT = process.env.CODEX_REASONING_EFFORT ?? 'medium';
const SERVE_FRONTEND = true;
const FRONTEND_DIST =
  process.env.NLK_FRONTEND_DIST ?? resolve(import.meta.dir, '../../frontend/dist');

const logger = new AppLogger();
const roomStore = new RoomStore(logger, WORKING_DIRECTORY);
const codexRunner = new CodexRunner(
  logger,
  WORKING_DIRECTORY,
  CODEX_MODEL,
  CODEX_REASONING_EFFORT
);

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

function contentTypeFor(pathname: string, fallback = 'application/octet-stream'): string {
  const ext = pathname.split('.').pop()?.toLowerCase();
  if (!ext) return fallback;
  return MIME_BY_EXT[ext] ?? fallback;
}

async function tryServeStatic(
  pathname: string,
  cacheControl = 'public, max-age=31536000, immutable'
): Promise<Response | null> {
  const cleanPath = pathname.replace(/^\/+/, '');
  const absolute = resolve(FRONTEND_DIST, cleanPath);
  const distRoot = resolve(FRONTEND_DIST);
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

const app = new Elysia()
  .use(cors({ origin: true }))
  .onBeforeHandle(({ request, path }) => {
    logger.debug('http.request', {
      method: request.method,
      path
    });
  })
  .get('/health', () => ({ ok: true, at: new Date().toISOString() }))
  .get('/api/runtime', () => ({
    host: HOST,
    port: PORT,
    workingDirectory: WORKING_DIRECTORY,
    servingFrontend: SERVE_FRONTEND,
    codexModel: CODEX_MODEL,
    codexReasoningEffort: CODEX_REASONING_EFFORT
  }))
  .get('/api/codex/threads', async ({ query }) => {
    const limit = Number(query.limit ?? 30);
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 30;
    logger.info('codex.threads.requested', { limit: safeLimit, scope: 'room_store' });
    const data = roomStore.listRoomThreads(safeLimit);
    return { data };
  })
  .post('/api/codex/threads/start', async () => {
    const thread = await codexRunner.startThread();
    logger.info('codex.thread.created', { threadId: thread.id });
    return { threadId: thread.id };
  })
  .get('/api/rooms', () => roomStore.listRooms())
  .post('/api/rooms/:roomId/thread', async ({ params, body }) => {
    const input = body as { threadId?: string };
    const threadId = input.threadId?.trim();
    if (!threadId) return { ok: false, error: 'threadId is required' };
    roomStore.setThreadId(params.roomId, threadId);
    let imported = 0;
    try {
      const thread = await codexRunner.readThread(threadId);
      if (thread) {
        imported = roomStore.hydrateFromThreadRead(params.roomId, thread, { replace: true });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isExpectedNewThread =
        message.includes('thread not loaded') || message.includes('no rollout found');
      logger[isExpectedNewThread ? 'debug' : 'warn']('codex.thread.hydration.failed', {
        roomId: params.roomId,
        threadId,
        error: message
      });
    }
    return { ok: true, roomId: params.roomId, threadId, imported };
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
      length: input.text?.length ?? 0
    });
    return roomStore.updateEditor(params.roomId, input.userId, input.text);
  })
  .post('/api/rooms/:roomId/codex/run', async ({ params, body, set }) => {
    const input = body as RunCodexInput;
    const state = roomStore.getSnapshot(params.roomId);

    const prompt = (input.prompt ?? state.editor.text).trim();
    if (!prompt) return { ok: false, error: 'Prompt is empty' };
    if (codexRunner.isRoomRunning(params.roomId)) {
      logger.warn('codex.run.rejected.running', { roomId: params.roomId });
      set.status = 409;
      return { ok: false, error: 'Turn is already running for this room' };
    }

    logger.info('codex.run.requested', {
      roomId: params.roomId,
      userId: input.userId,
      userName: input.userName,
      promptLength: prompt.length,
      hasThreadId: Boolean(state.threadId)
    });

    roomStore.addMessage(params.roomId, input.userId, input.userName, prompt);

    void codexRunner
      .runRoomTurn({
        roomId: params.roomId,
        prompt,
        threadId: state.threadId,
        onThreadId: (threadId) => roomStore.setThreadId(params.roomId, threadId),
        publish: (event) => roomStore.publish(params.roomId, event)
      })
      .catch(() => {
        // Event with failure details is already published by CodexRunner.
      });

    return { ok: true };
  })
  .post('/api/rooms/:roomId/events', async function* ({ params, request, set }) {
    logger.info('room.events.connected', { roomId: params.roomId });
    set.headers['Cache-Control'] = 'no-cache';
    set.headers.Connection = 'keep-alive';

    const queue: string[] = [];
    let resolveNext: (() => void) | null = null;
    const push = (payload: unknown) => {
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
      logger.info('room.events.disconnected', { roomId: params.roomId });
      unsubscribe();
    }
  });

if (SERVE_FRONTEND) {
  app
    .get('/', async () => {
      return (
        (await tryServeStatic('index.html', 'no-cache')) ??
        new Response('Frontend build not found', { status: 500 })
      );
    })
    .get('/assets/*', async ({ params }) => {
      return (
        (await tryServeStatic(`assets/${params['*'] ?? ''}`)) ??
        new Response('Not found', { status: 404 })
      );
    })
    .get('/*', async ({ path }) => {
      if (path.startsWith('/api/') || path === '/health') {
        return new Response('Not found', { status: 404 });
      }

      const staticResponse = await tryServeStatic(path);
      if (staticResponse) return staticResponse;

      return (
        (await tryServeStatic('index.html', 'no-cache')) ??
        new Response('Frontend build not found', { status: 500 })
      );
    });
}

app.listen({
  hostname: HOST,
  port: PORT
});

logger.info('server.started', {
  url: `http://${HOST}:${PORT}`,
  workingDirectory: WORKING_DIRECTORY,
  servingFrontend: SERVE_FRONTEND,
  frontendDist: FRONTEND_DIST
});
