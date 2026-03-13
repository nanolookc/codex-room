import { resolve } from 'node:path';
import { createApp } from './routes';
import { CodexRoomProxyManager } from './services/codex-room-proxy';
import { AppLogger } from './services/logger';
import { RoomStore } from './services/room-store';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3001);
const WORKING_DIRECTORY = process.env.NLK_WORKDIR ?? process.cwd();
const SESSION_KEY = process.env.NLK_SESSION_KEY?.trim() ?? '';
const CODEX_MODEL = process.env.CODEX_MODEL ?? 'default';
const CODEX_REASONING_EFFORT = process.env.CODEX_REASONING_EFFORT ?? 'medium';
const SERVE_FRONTEND = true;
const FRONTEND_DIST =
  process.env.NLK_FRONTEND_DIST ?? resolve(import.meta.dir, '../../frontend/dist');

const logger = new AppLogger();
const roomStore = new RoomStore(logger, WORKING_DIRECTORY);
const codexProxy = new CodexRoomProxyManager(
  logger,
  {
    publish: (roomId, event) => roomStore.publish(roomId, event),
    getThreadId: (roomId) => roomStore.getSnapshot(roomId).threadId,
    setThreadId: (roomId, threadId) => roomStore.setThreadId(roomId, threadId)
  },
  WORKING_DIRECTORY,
  CODEX_MODEL,
  CODEX_REASONING_EFFORT
);

const app = createApp({
  host: HOST,
  port: PORT,
  workingDirectory: WORKING_DIRECTORY,
  sessionKey: SESSION_KEY,
  codexModel: CODEX_MODEL,
  codexReasoningEffort: CODEX_REASONING_EFFORT,
  serveFrontend: SERVE_FRONTEND,
  frontendDist: FRONTEND_DIST,
  logger,
  roomStore,
  codexProxy
});

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
