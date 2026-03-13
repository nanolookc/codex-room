FROM oven/bun:1.3.6 AS build
WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY backend/package.json ./backend/package.json
COPY cli/package.json ./cli/package.json
COPY shared/package.json shared/tsconfig.json ./shared/
COPY shared/src ./shared/src
COPY relay/package.json relay/tsconfig.json ./relay/
COPY relay/src ./relay/src
COPY frontend/package.json frontend/tsconfig.json frontend/vite.config.ts ./frontend/
COPY frontend/src ./frontend/src
COPY frontend/index.html ./frontend/index.html
COPY frontend/postcss.config.js ./frontend/postcss.config.js

RUN bun install --frozen-lockfile
RUN bun run --cwd shared build
RUN bun run --cwd relay build
RUN bun run --cwd frontend build

FROM oven/bun:1.3.6-slim AS runtime
WORKDIR /app

COPY --from=build /app/relay/dist ./relay/dist
COPY --from=build /app/frontend/dist ./frontend/dist

ENV HOST=0.0.0.0
ENV PORT=3010
ENV RELAY_COOKIE_SECURE=true
ENV RELAY_PUBLIC_BASE_URL=https://codex-room.hrebeni.uk
ENV RELAY_SESSION_TTL_SECONDS=86400
ENV RELAY_MAX_VIEWERS=4
ENV NLK_FRONTEND_DIST=/app/frontend/dist

EXPOSE 3010

CMD ["bun", "/app/relay/dist/index.js"]
