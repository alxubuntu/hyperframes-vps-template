Status: in-progress
Created: 2026-11-09
Updated: 2026-11-09
Touches: server.mjs, src/lib/server/auth.mjs, src/lib/server/auth.d.mts, src/lib/server/auth.test.mjs, Dockerfile, .env.example, docs/deployment.md, AGENTS.md
Depends on: —
Supersedes: —

# 0001 — Minimal authentication for the UI and API

## Goal

Require authentication to use the app, queue renders, generate content, inspect
history, or download videos. Use one shared password for the browser and a
separate bearer token for scripts / n8n. No users, database, roles, OAuth, or
new dependencies. Authentication does not implement pipeline approval gates.

## Design

### One guard in `server.mjs`

Authenticate before static-file serving, TanStack handling, and request-body
buffering. New routes are protected by default, including `/r/<uuid>`, server
functions, compositions, and runtime assets.

Only these requests are public:

- `GET /healthz` — Docker healthcheck.
- `GET /login` and `POST /login` — standalone login form and password exchange.
- `POST /logout` — clear the session cookie.
- `GET` / `HEAD /assets/*` — existing static client files only; a missing file
  must return `404`, not fall through to an unguarded application route.

For an unauthenticated request:

- API and server-function requests always receive `401`, JSON
  `{"error":"unauthorized"}`, and `WWW-Authenticate: Bearer`.
- Other `GET` requests accepting HTML receive `302 /login?next=…`.
- Everything else receives the same `401`.

Do not read or accumulate rejected request bodies. Send the response with
`Connection: close` and close after flushing it; do not immediately call
`req.destroy()` and risk replacing the response with a connection reset.
This avoids application-level body buffering, not all network or proxy costs.

### Credentials and sessions

- Compare `AUTH_PASSWORD` and `AUTH_API_TOKEN` using SHA-256 digests and
  `timingSafeEqual` so buffer lengths are fixed. Missing bearer configuration
  must never authorize an empty token.
- Browser cookie: `hf_session=<expiryMs>.<hmacSha256Hex>`, `HttpOnly`,
  `SameSite=Lax`, `Path=/`, with a 12-hour lifetime by default.
- Sign with HMAC-SHA256 using a key derived from **both** `AUTH_PASSWORD` and
  `AUTH_SECRET` when provided; otherwise derive from the password with a fixed
  `hyperframes-session-v1` context. Changing either credential invalidates
  existing sessions. Validate the signature and a finite, unexpired timestamp.
- Logout clears the cookie; there is no session store or individual revocation.
- Bearer tokens are independent of browser sessions and rotated manually.
- Use HTTPS for public access. `AUTH_COOKIE_SECURE` defaults to `true`;
  `false` is only for local HTTP or a protected tunnel, not a public HTTP port.

### Configuration

- `AUTH_ENABLED`: unset or `true` enables authentication; only explicit `false`
  disables it and logs a warning. Any other value prevents startup.
- When enabled, require `AUTH_PASSWORD` of at least 16 characters. Optional
  `AUTH_SECRET` and `AUTH_API_TOKEN`, if configured, must have at least 32
  characters; use randomly generated values. An unset API token disables bearer
  access, not browser login.
- `AUTH_SESSION_HOURS`: positive finite number, default `12`.
- `AUTH_COOKIE_SECURE`: strict `true` / `false`, default `true`.
- Validate configuration before accepting requests; invalid values stop startup.

### Login and logout

Serve minimal HTML directly from `server.mjs`, with inline CSS, one password
field, and a hidden `next`. Use `Cache-Control: no-store` for auth responses.
Escape values placed in HTML. Accept only a same-origin path for `next`, checking
the resolved URL's origin; reject external URLs, protocol-relative URLs,
backslashes, and control characters. Default to `/`.

For `POST /login`, accept form data with a **4 KiB** body limit enforced while
reading, not just from `Content-Length`. Apply a fixed-window limiter before
reading: 10 attempts per IP per 5 minutes, then `429`. Expire old entries and cap
the map at 10,000 IPs; reject new entries while full rather than growing forever.

Use the socket IP by default. Only use forwarded client IPs when
`TRUST_PROXY_HEADERS=true` and deployment ensures requests arrive through a
trusted proxy that sanitizes those headers. Document that a shared proxy IP
otherwise produces a shared limit.

`SameSite=Lax` is a baseline, not complete CSRF protection. For login, logout,
and state-changing requests authorized by a cookie, require a matching `Origin`.
Bearer-authenticated requests do not need this browser check. Use the configured
public origin or the existing request-origin logic behind a trusted proxy.

## Tasks

- [x] **Auth module:** add `auth.mjs`, declarations, and pure `node:test` tests
  for configuration, comparisons, signed sessions, revocation, and the limiter.
  Use Node built-ins only.
- [x] **Server integration:** guard before static serving and body buffering;
  add the login/logout handlers, bounded login body, safe redirects, and response
  handling described above.
- [x] **Docker:** copy the runtime module into the final image; copying
  `server.mjs` alone is insufficient for its new direct import:

  ```dockerfile
  COPY --from=build --chown=node:node /app/src/lib/server/auth.mjs ./src/lib/server/auth.mjs
  ```

- [x] **Configuration and docs:** add the variables to `.env.example` without
  equals signs in comments; document HTTPS, proxy trust, explicit opt-out,
  credential rotation, and authenticated API examples in `docs/deployment.md`.
  Add the guard-before-body rule to `AGENTS.md`. Existing Compose `env_file`
  already passes the variables; no Compose change is required.
- [x] **Local verification:** run pure tests with `node --test`,
  `npm run typecheck`, and oxlint on changed code.
- [ ] **Deployment verification:** verify against the deployed instance without
  starting a local server.

## Acceptance

- Missing credentials yield a readable `401` for APIs, even with HTML Accept,
  and a `302` for browser navigation; valid cookie or bearer grants access.
- Tampered or expired cookies fail; changing the password invalidates cookies
  both with and without `AUTH_SECRET` configured.
- Invalid configuration prevents startup; explicit `AUTH_ENABLED=false` is
  the only unauthenticated mode.
- Login attempt 11 returns `429`; an oversized login body returns `413`.
- A 30 MB unauthenticated render request is rejected before application body
  buffering and receives a response, not merely a connection reset.
- External `next` values and cross-origin cookie-authenticated writes fail.
- The built Docker image starts successfully with authentication enabled.
- Browser playback/downloads and a full bearer-authenticated render still work.

## Accepted limits

One shared identity and history, no audit trail, manual bearer rotation, and no
individual session revocation. Download links require authentication and are
not publicly shareable. These limits keep this first version minimal.
