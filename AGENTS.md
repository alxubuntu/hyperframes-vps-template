# Working in this repo (notes for AI agents)

This is a self-hosted HyperFrames render server: it takes HTML compositions and
returns MP4s. Read this before calling the API or changing the render path.

## Golden rule

**The network is for importing, never for rendering.** The render container runs
offline. An `<img src="https://…">` does not fail loudly — it renders a hole.
Every asset must travel inside the request.

## Deploying

There is no CI/CD, and there are two possible topologies. Check which one you
are in before running anything: `git -C <project dir> status`.

**A git checkout** (the directory has `.git`):

```bash
cd <project dir>
git pull
docker compose build          # required: the app code is compiled into the image
docker compose up -d --force-recreate
```

**A hosting panel** (no `.git`, e.g. Hostinger Docker Manager): the panel clones
the repo to `/tmp`, builds there, and materializes `/docker/<project>/` with only
the compose file, `.env`, `Dockerfile` and `data/`. That directory has **no source**,
so `docker compose build` inside it fails. Deploy from the panel; to recreate with
a newer compose and the same image use `--no-build`:

```bash
cd /docker/<project>
docker compose up -d --force-recreate --no-build
```

The service is always `hyperframes`; the container is `<project>-hyperframes-1`.
Full mechanics, port rules and Traefik routing: [docs/deployment.md](docs/deployment.md).

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

When authentication is enabled, send `Authorization: Bearer <AUTH_API_TOKEN>`
with API requests. Requests without credentials must be rejected before
`server.mjs` reads or buffers their body.

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

## Gotchas that already bit us

- **Compose does not interpolate `${...}` in mapping keys**, only in values. Label
  keys written as `traefik.http.routers.${X}.rule:` keep the placeholder literally
  and Traefik drops the router. Keep such labels in list form.
- **Never put an equals sign in a comment in `.env.example`**: hosting panels import
  that file line by line and turn the comment into a broken variable.
- **A free port is not a reachable port**: publishing a non-standard host port also
  needs the firewall opened, and a timeout (not "connection refused") usually means
  a firewall is dropping the packets.
- **`/docker/<project>` in a panel deployment has no source code**; do not build there.
- **A nested-quantifier regex over multi-megabyte base64 overflows the stack.**
  Validation must stay linear.
- **The render container has no network**, so a font or image referenced by URL
  renders as a hole, not as an error.

## Repo rules

- Do not start a local server or dev server to "check" things; verify against
  the deployed instance or with plain `node` on pure modules.
- `npm run typecheck` and `node node_modules/oxlint/bin/oxlint <files>` must pass.
- Design work that is decided but not yet shipped lives in `docs/plans/`, one
  file per plan, with a `Status:` line instead of a board. Convention:
  [docs/plans/README.md](docs/plans/README.md). A finished plan is marked
  `done` and its behaviour moves into `docs/` — the plan keeps the reasoning,
  the docs keep the truth.
