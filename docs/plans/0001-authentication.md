# 0001 — Authentication for the web UI and the API

Status: draft
Created: 2026-11-09
Updated: 2026-11-09
Touches: server.mjs, src/lib/server/auth.mjs, src/lib/server/auth.d.mts, .env.example, docker-compose.yml, docs/deployment.md
Depends on: —
Supersedes: —

## Problem

The app has no authentication. Every route is open: the UI, `/api/render`,
`/api/generate`, `/api/renders`, `/api/render-status`, and the `/r/<uuid>`
downloads. Two distinct consequences:

1. **Anyone who reaches the port can use the machine.** Queue renders that pin
   both CPUs for minutes, drive AI generation, and download everything in
   `data/videos`.
2. **The open path also carries the memory-DoS surface.** `server.mjs` buffers
   the body up to `MAX_REQUEST_BYTES` (36 MB in the compose file, 64 MB by code
   default) before any route sees it.

It also blocks the planned five-stage pipeline: an approval gate that lives
behind an open endpoint is not a gate, because anyone can bypass it by calling
`POST /api/render` directly. See the pipeline discussion — stage 4 only has
meaning once the server can tell who is calling.

## Non-goals

- Multiple users, roles, per-user history, or an audit trail.
- OAuth / OIDC / SSO.
- Replacing the render queue's own limits, or the preflight.
- Protecting `/healthz` (Docker healthcheck and certificate probes need it open).

## Decisions

### D1 — Enforce in `server.mjs`, not in TanStack middleware

`createStart` and `requestMiddleware` exist in the installed
`@tanstack/start-client-core@1.170.14`, but the project does not use them, and
`@tanstack/react-start` sits at `1.168.32`. Betting the only access control on a
version-skewed framework API is avoidable risk.

`server.mjs` already wraps **every** request — SSR, API routes, server
functions, file downloads — in one `handle()` function, and already declares
itself the choke point for the request-size cap. It is plain Node, and it needs
no new dependency.

### D2 — One shared password, no user database

A single `AUTH_PASSWORD`, compared in constant time. No registration, no
per-user table, no password hashing at rest (there is nothing to store).

Accepted cost: everyone shares one identity, and `/api/renders` is common to
all. Correct for a single-owner VPS; wrong the day there is a second human, at
which point this plan is superseded rather than extended.

### D3 — Stateless session cookie, signed with an HMAC

Format `<expiryMs>.<hmacSha256Hex>`, `HttpOnly`, `SameSite=Lax`, `Path=/`,
`Secure` when `AUTH_COOKIE_SECURE=true`.

No session store: nothing to clean up, nothing to lose on restart. The signing
key is `AUTH_SECRET` when set, otherwise derived as
`hmac(AUTH_PASSWORD, "hyperframes-session-v1")` — so **changing the password
revokes every session for free**.

`SameSite=Lax` is the CSRF defence: the browser does not attach the cookie to a
cross-site `POST`. That is why no CSRF token is in scope.

### D4 — Two credentials, one guard

| Caller        | Credential                            |
| ------------- | ------------------------------------- |
| Browser       | `Cookie: hf_session=…`                 |
| Script / n8n  | `Authorization: Bearer <AUTH_API_TOKEN>` |

Both are accepted on any guarded path, which keeps `curl` able to fetch the UI
too. The token is deliberately **separate** from the password so it does not end
up in shell history or in a workflow log. It does not expire; rotation is manual.

### D5 — Fail closed at boot

`AUTH_ENABLED` is explicit. If it is `true` and `AUTH_PASSWORD` is missing or
under a minimum length, the process must **refuse to start**. If it is unset or
`false`, the server starts open and logs a loud one-line warning on every boot.
A typo in `.env` must never silently open the instance.

### D6 — Authenticate before the body is read

The guard runs before the `for await (const chunk of req)` loop that fills the
body buffer, and a rejection calls `req.destroy()`. A rejected request
therefore costs no memory and downloads no body. This is what closes the DoS
surface in the Problem section, and it depends entirely on the ordering.

## Design

### Public surface

Exactly four things are reachable without a credential:

| Path          | Why                                                     |
| ------------- | ------------------------------------------------------- |
| `/healthz`    | Docker `HEALTHCHECK`, Traefik and ACME probes           |
| `GET /login`  | the form                                                |
| `POST /login` | credential exchange, rate limited                        |
| `POST /logout`| clears the cookie                                       |
| `/assets/*`   | hashed client bundles (no secrets; checked — `dist/client` holds no app shell HTML, so a public asset path cannot serve the SPA and skip auth) |

Everything else — including `/_hyperframes/*`, `/compositions/*`,
`/_bundled/*`, all of `/api/*` and all server functions — is guarded. A
whitelist, never a blacklist: a route added tomorrow is protected by default.

### Rejection shape

This is what makes the same door work for a browser and for `curl`:

| Request without a credential          | Response                                            |
| ------------------------------------- | --------------------------------------------------- |
| `GET` with `Accept: text/html`        | `302 /login?next=<path>`                            |
| anything else (`/api/*`, server fns)   | `401` `{"error":"unauthorized"}` + `WWW-Authenticate: Bearer` |

Without that split, a script receives an HTML redirect and cannot tell
authentication from a bug.

### Login page

Minimal HTML served from `server.mjs` with inline CSS: one password field, a
hidden `next`, `Cache-Control: no-store`, `X-Robots-Tag: noindex`. It does not
go through React, so it keeps working even if the client bundle is broken, and
it does not touch `src/routeTree.gen.ts`.

Rate limit: in-memory fixed window per IP, 10 attempts / 5 minutes → `429`.
Behind Traefik the peer address is the proxy, so the client IP is read from
`x-forwarded-for` **only** when `TRUST_PROXY_HEADERS=true`; otherwise the socket
address, or the limiter degrades into a global lock for everyone.

## Tasks

- [ ] **1. `src/lib/server/auth.mjs` + `auth.d.mts`** — `issueSession`,
      `verifySession`, `verifyPassword`, `verifyBearer`, `isAuthorized`,
      `createLoginLimiter`, `isPublicPath`. Only `node:crypto`; no request
      object, no filesystem. Compare by hashing both sides first so
      `timingSafeEqual` always sees equal-length buffers (it throws otherwise,
      and the throw leaks length).
- [ ] **2. Wire into `server.mjs`** — the guard after the `/healthz` branch and
      before the body loop; `401`/`302`/`req.destroy()`.
- [ ] **3. Login + logout handlers and the limiter** — inline page, cookie set
      and clear, `next` sanitised to a same-origin path (reject `//host` and
      `http:` to avoid an open redirect).
- [ ] **4. Configuration and docs** — new `.env.example` block (no `=` inside
      comments), `AUTH_COOKIE_SECURE` note in `docs/deployment.md` per topology
      (direct port = `false`, Traefik = `true`), `AGENTS.md` rule that an
      unauthenticated request must be refused before the body is read.
- [ ] **5. Verify on the deployed instance** — `401` with no credential, `302`
      with `Accept: text/html`, `200` with the bearer token, `200` after the
      cookie, `429` on attempt 11, and a full render through `curl` with
      `Authorization`.

Acceptance: identical behaviour for the UI and the API, no route reachable
without a credential except the list above, and `POST` of a 30 MB body without
a credential rejected without buffering it.

## Open decisions

1. **Shared password now, or users now?** Recommendation: shared password, since
   nothing else in the app is per-user and the pipeline does not need identity.
2. **Protect `/r/<uuid>`?** Recommendation: yes — otherwise a leaked download
   URL is permanent access, and the cookie makes the in-app `<video>` work
   unchanged. The cost is that links stop being shareable outside a session.

## Not covered

- **Shared identity is not auditable.** No idea who queued what.
- **The token never expires**, so rotation is a manual deploy.
- **Not defence in depth by itself.** Traefik `BasicAuth` would be a second
  layer, but it breaks the bearer flow and forces duplicate credentials for
  every script; one lock in the right place is the choice here.
- **A stolen cookie is valid until it expires** (`AUTH_SESSION_HOURS`, default
  12). No device list, no revocation beyond rotating the password.

## Verification notes

`npm test` fails in the development environment (`EPERM` creating the SSR
directory), so task 1's tests are expected to be run on the VPS. Everything else
is verified against the deployed instance with `curl`; per `AGENTS.md`, no local
server is started to check this.
