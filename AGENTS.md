# Working in this repo (notes for AI agents)

This is a self-hosted HyperFrames render server: it takes HTML compositions and
returns MP4s. Read this before calling the API or changing the render path.

## Golden rule

**The network is for importing, never for rendering.** The render container runs
offline. An `<img src="https://…">` does not fail loudly — it renders a hole.
Every asset must travel inside the request.

## Deploy is manual

There is no CI/CD. After committing and pushing to `main`:

```bash
cd /docker/hyperframes-app
git pull
docker compose build          # required: the app code is compiled into the image
docker compose up -d --force-recreate
```

The container is `hyperframes-app-hyperframes-1`; the service is `hyperframes`.

## Calling the API

1. **Read the contract first:** `GET /api/render/schema` returns the payload
   shapes, limits, and every error code with its fix.
2. **Validate before queueing:** `POST /api/render?dryRun=1` returns
   `{ ok, issues, warnings }` and never queues a render. Iterate until `ok: true`.
3. **Then render:** `POST /api/render` with one of:

   ```json
   { "html": "<!doctype html>…" }
   ```

   ```json
   { "files": [{ "path": "index.html", "content": "<base64>" },
               { "path": "assets/logo.png", "content": "<base64>" }] }
   ```

   `{}` renders the bundled composition.
4. **Poll** `GET /api/render-status?id=<uuid>` until `completed` or `failed`.
5. **Download** `GET /r/<uuid>`.

## A composition that passes

```html
<div data-composition-id="intro" data-root="true"
     data-width="1920" data-height="1080" data-duration="8">
  <img src="data:image/webp;base64,…">
</div>
```

- All five `data-*` attributes on the root, or the render is silently wrong.
- `/_hyperframes/gsap.min.js` and `/_hyperframes/hyperframe.runtime.iife.js` are
  allowed and rewritten by the server.
- Fonts: embed a `.woff2` as `data:font/woff2;base64,…` in `@font-face`, or the
  text renders with the container's fallback font.

## When a request is rejected

A `400` carries `issues[]`, each with `code`, `message` and `fix`. Read the
`fix` — it names the exact replacement payload. Do not retry unchanged.

## Repo rules

- Do not start a local server or dev server to "check" things; verify against
  the deployed instance or with plain `node` on pure modules.
- Keep validation linear: a nested-quantifier regex over multi-megabyte base64
  overflows the stack (this already happened once).
- `npm run typecheck` and `node node_modules/oxlint/bin/oxlint <files>` must pass.
