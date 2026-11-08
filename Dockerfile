FROM oven/bun:1 AS bun

FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
ARG PREVIEW_COMPOSITION_DIR=compositions/cloudflare-intro
ENV PREVIEW_COMPOSITION_DIR=${PREVIEW_COMPOSITION_DIR}
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY renderer/package.json ./renderer/package.json
RUN npm install --prefix /app/renderer --omit=dev --no-package-lock --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    HOME=/home/node \
    PUPPETEER_CACHE_DIR=/home/node/.cache/puppeteer \
    PROJECTS_DIR=/data/projects \
    RENDER_TEMP_DIR=/data/temp \
    RENDERS_DIR=/data/videos \
    HYPERFRAMES_BIN=/app/renderer/node_modules/.bin/hyperframes

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      ffmpeg \
      fonts-liberation \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libatspi2.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libglib2.0-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app /app/renderer /data/projects /data/temp /data/videos /home/node/.cache \
    && chown -R node:node /app /data /home/node

WORKDIR /app
COPY --from=build --chown=node:node /app/renderer/node_modules ./renderer/node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/server.mjs ./server.mjs
COPY --from=build --chown=node:node /app/src/composition-manifest.json ./src/composition-manifest.json
# The CLI writes fonts and browser assets under the node user's cache. It runs
# as root during the build, so hand those files back before switching USER.
RUN /app/renderer/node_modules/.bin/hyperframes browser ensure \
    && chown -R node:node /home/node/.cache

USER node
EXPOSE 3000
VOLUME ["/data/projects", "/data/temp", "/data/videos"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=2m --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.mjs"]
