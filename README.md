# HyperFrames VPS Template

A self-hosted HyperFrames application built with React, TanStack Start, and TanStack AI. It keeps the browser preview and BYOK AI workflow, renders MP4s in the local Docker container, and stores jobs and videos on persistent host directories. No Cloudflare account, Worker, Durable Object, R2 bucket, Redis, or database is required.

## What runs locally

```text
Browser ──HTTP──▶ Node.js + TanStack Start
                      ├── local preview/composition assets
                      ├── file-backed render queue ──▶ HyperFrames + Chromium + FFmpeg
                      └── /r/<job-id> ──▶ persistent MP4 in ./data/videos
```

The API returns a render-job ID immediately. A bounded in-process queue runs renders in the background, and the UI polls job status without keeping the request open. Completed video metadata is stored in `data/videos/jobs.json`; the MP4 bytes are stored as `data/videos/<job-id>.mp4`. Render inputs are kept under `data/projects` and per-job temporary files under `data/temp`.

The queue is intentionally single-process and local: do not scale this Compose service to multiple replicas. Queued jobs survive restarts; a job interrupted while actively rendering is recorded as failed and can be resubmitted. Completed MP4 files and their metadata survive container recreation.

## Requirements

- Ubuntu 22.04 or 24.04, 64-bit; the VPS should have enough free disk for Chromium, temporary renders, and retained MP4s.
- Docker Engine and the Docker Compose plugin. Install using [Docker's official Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/).
- Git to obtain/update this repository.

The app container includes Node.js 22, HyperFrames, Chromium headless shell, FFmpeg, and locally served GSAP/HyperFrames runtime files. These runtime assets are installed in the image and do not require a public CDN when rendering the bundled composition or standard AI-generated compositions. It does not need host Node.js, Bun, or FFmpeg for production.

## Install and run on Ubuntu

From the repository directory:

```bash
cp .env.example .env
mkdir -p data/projects data/temp data/videos
# The image runs as UID/GID 1000 (`node`); make the bind mounts writable.
sudo chown -R 1000:1000 data
docker compose build
docker compose up -d --wait
docker compose ps
curl -fsS http://127.0.0.1:3000/healthz
```

Open the application through your reverse proxy. The Compose port is bound to `127.0.0.1` by default so the Node service is not exposed directly to the public Internet. Change `WEB_PORT` in `.env` to choose another loopback port.

To stop the service without deleting video data:

```bash
docker compose stop
```

To start it again:

```bash
docker compose up -d
```

Do not remove the `data/` directories when removing or replacing containers. They contain project inputs, temporary files, the job registry, and completed MP4s.

## Configuration

Copy `.env.example` to `.env` and edit the values before the first run:

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEB_PORT` | `3000` | Host loopback port published by Compose. |
| `ENABLE_AI_GEN` | `true` | Enables BYOK generation and custom-HTML rendering. Set `false` for a public demo that only renders the bundled composition. |
| `PREVIEW_COMPOSITION_DIR` | `compositions/cloudflare-intro` | Bundled composition directory. It is a Docker build argument; rebuild the image after changing it. |
| `RENDER_CONCURRENCY` | `1` | Simultaneous render jobs in this process; keep at `1` unless you have measured the memory cost. |
| `RENDER_WORKERS` | `4` | HyperFrames workers per render. Each worker starts a Chromium process. Tune against available CPU and RAM. |
| `RENDER_TIMEOUT_MS` | `600000` | Maximum time allowed for one render before it is terminated. |
| `TRUST_PROXY_HEADERS` | `false` | Set `true` only when a trusted reverse proxy overwrites forwarded host/protocol headers. |

AI generation uses the existing OpenRouter BYOK flow. The user supplies an OpenRouter key in the UI; it is used for that request and is not stored by this application. When AI is enabled, requests to OpenRouter are an optional external dependency; previewing and rendering the bundled composition do not depend on it.

## Reverse proxy example

Configure Nginx or Traefik to forward the public site to `http://127.0.0.1:3000`. For Nginx, allow the custom HTML body limit and disable buffering so AI Server-Sent Events stream through:

```nginx
location / {
    client_max_body_size 3m;
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_read_timeout 15m;
}
```

Then set `TRUST_PROXY_HEADERS=true` in `.env` and recreate the service. Keep the upstream port private; only the proxy should reach it. The app intentionally adds no authentication layer, so protect it at the proxy/network boundary if it is not intended for public use. Rendering untrusted generated HTML consumes CPU/RAM; turn off AI/custom HTML for a public bundled-only demo.

## Build, run, and update

Build and start the app:

```bash
docker compose build
docker compose up -d --wait
```

Update after bringing the desired repository revision onto the VPS:

```bash
docker compose build --pull
docker compose up -d --wait
docker compose ps
```

This replaces the application container but keeps all three bind-mounted `data/` directories. Back them up before changing hosts or rebuilding storage. A basic backup can be made while the app is stopped:

```bash
docker compose stop
tar -czf hyperframes-data-$(date +%F).tar.gz data/
docker compose start
```

## Local development and checks

For development outside Docker, use Node.js 22 and Bun (the repository's `bun.lock` is the dependency lockfile):

```bash
bun install
```

The local render API also needs the HyperFrames CLI and its headless browser. Install the same renderer dependency used by the container and prepare its browser once:

```bash
npm install --prefix renderer --no-package-lock
./renderer/node_modules/.bin/hyperframes browser ensure
# Use that renderer when starting local dev from this directory.
export HYPERFRAMES_BIN=./renderer/node_modules/.bin/hyperframes
npm run dev
```

Run the project checks with:

```bash
npm test
npm run typecheck
npm run build
```

## Cloudflare dependencies removed and replacements

| Original surface | Replacement |
| --- | --- |
| Cloudflare Workers runtime and `cloudflare:workers` environment imports | Node.js 22 HTTP server and `process.env`; TanStack Start requests are forwarded to its fetch handler. |
| Cloudflare Vite plugin / Worker-specific build target | Standard TanStack Start + Vite build, served by `server.mjs`. |
| `RenderContainer` Durable Object and `@cloudflare/containers` | Local bounded render queue in the Node process; job state is stored as JSON on the videos volume. Running renders are marked failed after a process restart rather than left stuck. |
| Cloudflare R2 (`RENDERS`) | MP4 files and job metadata under `data/videos`, persisted by a Compose bind mount. The `/r/<id>` endpoint supports playback, byte ranges, and download. |
| Cloudflare `ASSETS` binding | Read-only local `public/` filesystem access for composition and preview assets. |
| `wrangler.jsonc`, generated Worker types, Wrangler scripts, and Cloudflare container source | Removed; Docker Compose is the production deployment and healthcheck path. |

The bundled sample composition retains its original Cloudflare-themed creative content and folder name (`cloudflare-intro`); that is sample video content only, not an infrastructure dependency. HyperFrames, React, TanStack Start/AI, the browser preview, OAuth integration, OpenRouter BYOK generation, and the player are retained.

## Known limits

- The render queue is process-local and intended for one Compose replica. There is no distributed queue or cross-process locking.
- A render actively running during a container restart is not resumed automatically; its job is marked failed. Completed videos and queued job payloads persist.
- AI generation still calls OpenRouter when enabled. Disable it with `ENABLE_AI_GEN=false` if you require no outbound AI API use.
- Custom HTML can still explicitly request its own external fonts, images, or scripts; those user-authored URLs are not mirrored by the template.
- Existing videos held in a previous Cloudflare R2 bucket are not imported automatically; old R2 URLs do not resolve through the local `/r/<id>` route. Export any videos you need separately before switching links.
- No authentication is added. Use a trusted private network or add protection at your reverse proxy before exposing the application.
