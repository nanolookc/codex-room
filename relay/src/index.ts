import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createApp } from './routes';
import { AppLogger } from './services/logger';
import { RateLimiter } from './services/rate-limit';
import { ShareStore } from './services/share-store';
import { TunnelHub } from './services/tunnel-hub';

const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3010);
const PUBLIC_BASE_URL = (process.env.RELAY_PUBLIC_BASE_URL ?? `http://${HOST}:${PORT}`).replace(/\/+$/, '');
const FRONTEND_DIST = process.env.NLK_FRONTEND_DIST ?? resolve(import.meta.dir, '../../frontend/dist');
const COOKIE_SECURE =
  (process.env.RELAY_COOKIE_SECURE?.trim() ?? '') === '1' ||
  (process.env.RELAY_COOKIE_SECURE?.trim() ?? '') === 'true' ||
  PUBLIC_BASE_URL.startsWith('https://');
const SESSION_TTL_SECONDS = Number(process.env.RELAY_SESSION_TTL_SECONDS ?? 24 * 60 * 60);
const MAX_VIEWERS = Number(process.env.RELAY_MAX_VIEWERS ?? 4);

if (!existsSync(resolve(FRONTEND_DIST, 'index.html'))) {
  console.error('frontend/dist not found. Build it manually: `bun run --cwd frontend build`.');
  process.exit(1);
}

const logger = new AppLogger();
const shareStore = new ShareStore(logger, PUBLIC_BASE_URL, SESSION_TTL_SECONDS, MAX_VIEWERS);
const tunnelHub = new TunnelHub(logger);
const createRateLimiter = new RateLimiter(20, 60_000);
const joinRateLimiter = new RateLimiter(60, 60_000);

const app = createApp({
  host: HOST,
  port: PORT,
  publicBaseUrl: PUBLIC_BASE_URL,
  cookieSecure: COOKIE_SECURE,
  frontendDist: FRONTEND_DIST,
  logger,
  shareStore,
  tunnelHub,
  createRateLimiter,
  joinRateLimiter
});

app.listen({
  hostname: HOST,
  port: PORT
});

logger.info('relay.started', {
  host: HOST,
  port: PORT,
  publicBaseUrl: PUBLIC_BASE_URL,
  frontendDist: FRONTEND_DIST
});
