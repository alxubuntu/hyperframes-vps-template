# Deploying this stack

Two deployment styles exist. Know which one you are in before changing anything.

| | Git checkout | Hosting panel |
| --- | --- | --- |
| compose comes from | `git pull` | the panel, re-cloned from this repo |
| `.env` comes from | you edit it | seeded from `.env.example`, edited in the UI |
| update with | `git pull && docker compose build && docker compose up -d` | the panel redeploy button |

## Panel mechanics

1. The panel clones the repo into `/tmp/<random>` and builds the image there.
2. It materializes `/docker/<project>/` with only `docker-compose.yml`, `.env`,
   `Dockerfile`, `data/` and build logs. That directory has no source code.
3. Containers run from that directory, so `./data/...` resolves to
   `/docker/<project>/data/...` and survives redeploys.
4. The compose it uses is the one in this repo, so changes here do reach panel
   deployments on their next deploy. The `.env` is re-seeded from `.env.example`.

Consequences:

- Never run `docker compose build` inside `/docker/<project>`: the build context
  has no source. Build through the panel.
- To pick up a newer compose with the same image, recreate only:
  `docker compose up -d --force-recreate --no-build`.

## `.env.example` is imported line by line

Some panels split every line on the first `=` and keep the rest as a value, so a
comment containing an equals sign becomes a broken variable. Never put one in a
comment in that file. The file header repeats this rule.

## Authentication

Authentication is enabled by default. Set `AUTH_PASSWORD` to a random value of
at least 16 characters before starting; otherwise the server refuses to start.
`AUTH_ENABLED=false` is the only opt-out and logs a warning. Optional
`AUTH_API_TOKEN` enables bearer access for scripts, separate from browser login;
optional `AUTH_SECRET` signs sessions and rotating it invalidates existing
browser sessions. Changing the password also invalidates sessions. Rotate the
bearer token manually when needed.

Use HTTPS for public access and keep `AUTH_COOKIE_SECURE=true`. Set it to false
only for local HTTP or a protected tunnel. The browser login is at `/login`;
API clients send `Authorization: Bearer <AUTH_API_TOKEN>`. Missing credentials
receive `401` on APIs and a login redirect for browser navigation. `/healthz`
and static `/assets/*` remain public.

Set `TRUST_PROXY_HEADERS=true` only when requests reach the app through a trusted
proxy that overwrites forwarded headers. It is used for login rate limiting and
the external origin; do not expose the app directly while trusting client-supplied
forwarded headers. Login allows 10 attempts per IP per five minutes.

**Required behind Traefik/TLS termination:** set `TRUST_PROXY_HEADERS=true`
and keep the application port inaccessible to untrusted direct clients.
Without it, the app sees HTTP while the browser sends an HTTPS `Origin`, and
every browser login POST fails with `403 invalid_origin`. Do not solve this
by removing the origin check or disabling secure cookies.

## Ports

- `BIND_ADDR` defaults to `127.0.0.1`: nothing is public unless you set `0.0.0.0`,
  and that is only for a direct exposure with no proxy in front.
- `WEB_PORT` ships empty and the compose uses the single-dash form, so unset and
  empty both mean "let Docker pick a free port". Two instances never collide.
  Read it back with `docker compose port hyperframes 3000`.
- Pin a number when the URL must survive a recreate or a proxy needs a fixed
  upstream. A public non-standard port also needs the host firewall opened;
  80 and 443 usually already are.

## Traefik

Labels are opt-in and inert while `TRAEFIK_ENABLE` is false. Set:

```env
TRAEFIK_ENABLE=true
TRAEFIK_ROUTER=hf-v5
TRAEFIK_HOST=v5.147.93.12.91.sslip.io
TRUST_PROXY_HEADERS=true
```

Router and service names are global to the proxy, so `TRAEFIK_ROUTER` must be
unique per instance. Two containers using the same name fight over one router and
one of them stops answering.

The labels use list syntax on purpose. Compose interpolates `${...}` in values
only, never in mapping keys: written as a map, the placeholder stays literal,
Traefik builds a router whose service never exists, drops it silently and answers
`404 page not found`. A certificate for the domain may still have been issued,
which makes the failure look like TLS when it is not.

Without a domain, `sslip.io` maps `v5.147.93.12.91.sslip.io` to that IP for free
and the `letsencrypt` certresolver issues a real certificate via HTTP challenge.
Let's Encrypt limits are per registered domain, so `*.sslip.io` shares them.

## Diagnosing

| Symptom | Meaning |
| --- | --- |
| `404 page not found`, plain text | Traefik: no router matched. Inspect the container labels for a literal `${` and check `TRAEFIK_HOST` is not empty. |
| `TRAEFIK DEFAULT CERT` | ACME did not run or failed; the router works but TLS is self-signed. |
| `502` | The router exists but cannot reach the container. |
| `connection refused` vs timeout | Refused means nothing is listening; timeout usually means a firewall drops the packets. |

## New instance checklist

1. Create the project from this repo in the panel.
2. Set `TRAEFIK_ENABLE=true`, a unique `TRAEFIK_ROUTER`, and `TRAEFIK_HOST`.
3. Keep `BIND_ADDR=127.0.0.1` and leave `WEB_PORT` empty.
4. Verify:

```bash
docker inspect <container> --format '{{json .Config.Labels}}' | tr ',' '\n' | grep traefik
curl -skS -o /dev/null -w '%{http_code}\n' https://<host>/healthz
curl -skS https://<host>/api/render/schema | head -c 80
```

Labels must contain no `${`, and both requests must answer `200`.
