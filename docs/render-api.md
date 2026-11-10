# Render API

Base URL: `http://<host>:3000`. Machine-readable contract: `GET /api/render/schema`.

The render container has **no network access**. Anything referenced by URL does
not load; the render still "succeeds" and produces a hole. Send every asset with
the request.

## Flow

```
GET  /api/render/schema              → contract, limits, error codes
POST /api/render?dryRun=1            → { ok, issues, warnings }   (no queue)
POST /api/render                     → 202 { id, statusUrl, warnings }
GET  /api/render-status?id=<uuid>    → { status: queued|running|completed|failed }
GET  /r/<uuid>                       → video/mp4 (Range supported, ?download=1)
GET  /api/renders                    → completed renders
```

Status responses are `no-store`. They include `phase` and `phaseProgress`
(0–100 for that phase only, or null when unknown). Frame progress is based on
HyperFrames 0.4.14 global frame counters; it is not overall render completion.
`startedAt`, `lastActivityAt`, and `progressUpdatedAt` are timestamps or null.
Activity can be log output without forward progress. A completed phase is not a
completed video: only `status: completed` confirms the MP4 is ready. Clients
should poll until a terminal state and handle missing fields from older servers.

## Payloads

| Mode | Body | Notes |
|---|---|---|
| Bundled | `{}` or empty | The composition shipped with the server |
| Single file | `{ "html": "<!doctype html>…" }` | Assets must be `data:` URIs |
| Multi file | `{ "files": [{ "path", "content" }] }` | `content` is base64; paths are relative |

```bash
curl -sS -X POST http://127.0.0.1:3000/api/render?dryRun=1 \
  -H 'content-type: application/json' \
  -d '{"html":"<div data-composition-id=\"a\" data-root=\"true\" data-width=\"1280\" data-height=\"720\" data-duration=\"3\">hi</div>"}'
```

## Required structure

```html
<div data-composition-id="intro" data-root="true"
     data-width="1920" data-height="1080" data-duration="8">…</div>
```

`data-duration` is the video length in seconds. Missing root attributes are
**blocking**: without them the renderer produces a wrong-length or unmounted
composition while reporting success.

## Allowed local scripts

`/_hyperframes/gsap.min.js` and `/_hyperframes/hyperframe.runtime.iife.js` are
rewritten to `assets/` by the server before rendering. Any other absolute path
is rejected.

## Errors

`400` responses:

```json
{
  "error": "preflight failed",
  "contractVersion": 2,
  "docs": "/api/render/schema",
  "issues": [{ "code": "external-url", "file": "index.html",
               "detail": "https://cdn…/a.png",
               "message": "El render corre sin acceso a internet…",
               "fix": "Descargá el archivo y embebelo como data URI…" }],
  "warnings": []
}
```

| Code | Blocking | Meaning |
|---|---|---|
| `missing-root` | yes | Root element or one of its `data-*` attributes is missing |
| `external-url` | yes | `http(s)://` in `src`, `href` or `url()` |
| `missing-asset` | yes | Referenced file is not in the payload |
| `bad-base64` | yes | `data:` payload does not decode |
| `bad-font` | yes | Font data URI whose bytes are not that font format |
| `unsafe-path` | yes | `..`, absolute path, or backslash |
| `system-font` | no | Family is not in the container; fallback will be used |
| `unknown-font` | no | Family has no `@font-face`; fallback will be used |
| `heavy-image` | no | Embedded image above 2 MB |
| `long-duration` | no | Composition longer than 60 s |

## Limits

Base64 costs 4/3, so the decoded composition is at most 0.75 x the request cap.

| Variable | Default |
|---|---|
| `MAX_RENDER_HTML_BYTES` | 32 MB |
| `MAX_REQUEST_BYTES` | 64 MB |
| `MAX_COMPOSITION_BYTES` | 0.75 x request cap |
| `PREFLIGHT_MODE` | `strict` (`warn` / `off` for operators) |

## Operational notes

- `RENDER_CONCURRENCY=1`: renders run one at a time. A bad job occupies the queue,
  which is why validation happens before enqueue.
- No authentication: protect the port at the proxy or network boundary.
