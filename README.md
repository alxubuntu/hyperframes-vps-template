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
# Optional but recommended: pre-create the bind mounts with the right owner.
# The init-data Compose service repairs them automatically on every start.
sudo chown -R 1000:1000 data
docker compose build
docker compose up -d --wait
docker compose ps
# The host port is assigned by Docker: read it before calling the app.
PORT=$(docker compose port hyperframes 3000 | cut -d: -f2)
curl -fsS "http://127.0.0.1:${PORT}/healthz"
```

The `init-data` service runs before the app and gives the three `data/` bind mounts to UID/GID 1000, which is the user the application runs as. The Dockerfile also changes ownership of HyperFrames' browser and font cache to that user, because the render CLI creates those files during the image build.

Open the application through your reverse proxy. The Compose port is bound to `127.0.0.1` by default so the Node service is not exposed directly to the public Internet. `WEB_PORT` ships empty, so Docker assigns a free host port and two instances on one machine never collide; set a number in `.env` when you need a stable URL (a reverse proxy does).

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
| `BIND_ADDR` | `127.0.0.1` | Host interface the app publishes on. `0.0.0.0` exposes it directly; keep loopback behind a proxy. |
| `WEB_PORT` | *(empty)* | Host port published by Compose. Empty lets Docker assign a free one, which never collides with another instance; read it with `docker compose port hyperframes 3000`. Set a number for a stable URL. |
| `ENABLE_AI_GEN` | `true` | Enables BYOK generation and custom-HTML rendering. Set `false` for a public demo that only renders the bundled composition. |
| `PREVIEW_COMPOSITION_DIR` | `compositions/cloudflare-intro` | Bundled composition directory. It is a Docker build argument; rebuild the image after changing it. |
| `RENDER_CONCURRENCY` | `1` | Simultaneous render jobs in this process; keep at `1` unless you have measured the memory cost. |
| `RENDER_WORKERS` | `2` | HyperFrames workers per render. Each worker starts a Chromium process, so keep it at or below the container's CPU limit (`cpus: 2.0`). |
| `RENDER_TIMEOUT_MS` | `600000` | Maximum time allowed for one render before it is terminated. |
| `MAX_REQUEST_BYTES` | `67108864` (64 MB) | Whole-request body cap, enforced for every route before TanStack sees it. Base64 inflates uploads by ~33%. |
| `MAX_RENDER_HTML_BYTES` | `33554432` (32 MB) | Cap for a single-file `{ "html": "..." }` composition. Base64 costs 4/3, so this bounds ~24 MB of inlined assets. |
| `MAX_COMPOSITION_BYTES` | 0.75 × `MAX_REQUEST_BYTES` (48 MB) | Decoded budget for a multi-file `{ "files": [...] }` composition. Base64 costs 4/3, so this can never exceed 0.75 of the request cap. |
| `PREFLIGHT_MODE` | `strict` | `strict` rejects an invalid composition, `warn` accepts it and reports the issues, `off` disables validation. Operator-only; never settable per request. |
| `TRUST_PROXY_HEADERS` | `false` | Set `true` only when a trusted reverse proxy overwrites forwarded host/protocol headers. |

AI generation is BYOK and supports two providers: OpenRouter and DeepSeek. The user supplies the key in the UI; it is used for that request and is not stored by this application. When AI is enabled, requests to the selected provider are an optional external dependency; previewing and rendering the bundled composition do not depend on them.

Choose the provider above the key field:

- **OpenRouter** — log in with OpenRouter (PKCE, spend-capped key) or paste a key. Entering a key loads OpenRouter's live text-model catalog, fetched by this app's server from the public `/api/v1/models` endpoint, cached for five minutes, and never includes your key. "Free only" is on by default; uncheck it to see paid models, which display an indicative per-million-token price and are billed to your OpenRouter key.
- **DeepSeek** — paste a key from `platform.deepseek.com`. The catalog comes from DeepSeek's authenticated `/models` endpoint, so the key is sent to this app's server for that one call and then to `api.deepseek.com`; it is not logged, persisted, or cached. DeepSeek has no free tier, so the picker hides "Free only" and shows "Billed per token" instead of prices.

`POST /api/generate` takes `forwardedProps.provider` (`openrouter` or `deepseek`; omitted means `openrouter` for backward compatibility) plus `forwardedProps.model`. Omitting the model selects the provider default — the first free OpenRouter model, or `deepseek-flash` for DeepSeek. If a catalog is unreachable, an explicit well-formed model id is still accepted so an outage does not block generation. Unknown ids and ids from the other provider are rejected. If the provider blocks the selected model, the request fails rather than switching to another model or provider.

## What the preflight validates

Every render is validated before it takes the single queue slot. The check runs
inside `enqueueRender`, so it covers the bundled composition, `{ "html": … }` and
`{ "files": […] }` alike, and cannot be skipped from a request.

| Blocking | Non-blocking |
| --- | --- |
| Missing `data-composition-id`, `data-root`, `data-width`, `data-height` or `data-duration` | A font family with no `@font-face` (renders with the fallback font) |
| `http(s)://` in `src`, `href` or `url()` — the render container is offline | An embedded image above 2 MB |
| An `<img>`/`@font-face` target missing from the payload | A composition longer than 60 s |
| A `data:` payload that does not decode, or a font whose bytes are not that format | |
| A path with `..`, absolute, or backslash | |

A rejection returns `400` with the offending `code`, a `message` and a concrete
`fix`. `POST /api/render?dryRun=1` runs the same validation without queueing, and
`GET /api/render/schema` publishes the whole contract for automated clients.
See [docs/render-api.md](docs/render-api.md) and [AGENTS.md](AGENTS.md).

## Reverse proxy example

Pin `WEB_PORT` in `.env` first — a proxy needs a fixed upstream port. Then configure Nginx or Traefik to forward the public site to `http://127.0.0.1:3000` (or whatever you pinned). For Nginx, allow the custom HTML body limit and disable buffering so AI Server-Sent Events stream through:

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

Then set `TRUST_PROXY_HEADERS=true` in `.env` and recreate the service.

### Traefik with labels (no published port needed)

The compose file ships opt-in Traefik labels. With `TRAEFIK_ENABLE=false` nothing
changes. To route by hostname instead of publishing a port:

```env
TRAEFIK_ENABLE=true
TRAEFIK_ROUTER=hf-v4
TRAEFIK_HOST=v4.147.93.12.91.sslip.io
BIND_ADDR=127.0.0.1
```

- `TRAEFIK_ROUTER` must be **unique per instance**: router and service names are
  global to the proxy, and two containers declaring the same name fight over it.
- `TRAEFIK_HOST` is any name that resolves to the host. Without a domain,
  `sslip.io` maps `<label>.<ip>.sslip.io` to that IP for free, so
  `v4.147.93.12.91.sslip.io` works with no DNS setup.
- The labels request a certificate through the `letsencrypt` certresolver
  (`TRAEFIK_CERTRESOLVER` overrides it). If issuance fails the router still
  serves Traefik's self-signed certificate, so the browser warns but the site
  loads.
- Traefik here runs with host networking, so it reaches this container over the
  project's own network: no shared network and no published port are needed. Keep the upstream port private; only the proxy should reach it. The app intentionally adds no authentication layer, so protect it at the proxy/network boundary if it is not intended for public use. Rendering untrusted generated HTML consumes CPU/RAM; turn off AI/custom HTML for a public bundled-only demo.

## Build, run, and update

Build and start the app:

```bash
docker compose build
docker compose up -d --wait
```

Update a VPS deployment in place (pull the revision, rebuild the image, restart):

```bash
git pull
docker compose build --pull
docker compose up -d --wait
```

`--pull` refreshes the base images; the dependency layer still rebuilds when `package.json` or `bun.lock` change. `--wait` returns only after the container passes its `/healthz` check; `docker compose ps` shows the result.

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

The bundled sample composition retains its original Cloudflare-themed creative content and folder name (`cloudflare-intro`); that is sample video content only, not an infrastructure dependency. HyperFrames, React, TanStack Start/AI, the browser preview, OAuth integration, OpenRouter and DeepSeek BYOK generation, and the player are retained.

## Known limits

- The render queue is process-local and intended for one Compose replica. There is no distributed queue or cross-process locking.
- A render actively running during a container restart is not resumed automatically; its job is marked failed. Completed videos and queued job payloads persist.
- AI generation calls OpenRouter or DeepSeek when enabled, depending on the provider selected in the UI. The model picker fetches OpenRouter's public catalog or DeepSeek's authenticated catalog (both cached for five minutes). Disable AI generation with `ENABLE_AI_GEN=false` if you require no outbound AI API use.
- The DeepSeek catalog cache is per process and not keyed per user: the model list is account-independent, so a successful fetch is shared, while a rejected key is still reported on the next refresh or generation.
- Custom HTML can still explicitly request its own external fonts, images, or scripts; those user-authored URLs are not mirrored by the template.
- Existing videos held in a previous Cloudflare R2 bucket are not imported automatically; old R2 URLs do not resolve through the local `/r/<id>` route. Export any videos you need separately before switching links.
- No authentication is added. Use a trusted private network or add protection at your reverse proxy before exposing the application.
