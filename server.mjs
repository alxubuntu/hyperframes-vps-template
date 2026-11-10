import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createLoginLimiter,
  isAuthorized,
  isPublicPath,
  issueSession,
  loadAuthConfig,
  SESSION_COOKIE_NAME,
  verifyPassword,
  resolveRequestOrigin,
  handleRequestError,
  isWithinPublicAssets,
  requiresOriginCheck,
} from "./src/lib/server/auth.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = resolve(ROOT, "dist/client");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const AUTH = loadAuthConfig();
const loginAllowed = createLoginLimiter();
if (!AUTH.enabled) console.warn("[auth] WARNING: authentication is disabled");
// Whole-request cap, enforced for every route before TanStack sees the body.
// Base64 inflates a composition by ~33%, so size this against the largest
// upload you intend to submit, not the MP4 you expect back.
const MAX_REQUEST_BYTES =
  Number.parseInt(process.env.MAX_REQUEST_BYTES ?? "", 10) || 64 * 1024 * 1024;
const TYPES = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function loadStartHandler() {
  for (const relativePath of ["dist/server/server.js", "dist/server/index.js"]) {
    const entry = resolve(ROOT, relativePath);
    try {
      await access(entry);
      const module = await import(pathToFileURL(entry).href);
      if (typeof module.default?.fetch === "function") return module.default;
      throw new Error(`${relativePath} does not export a fetch handler`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error("TanStack Start server bundle not found. Run `npm run build` first.");
}

const startHandler = await loadStartHandler();

function requestOrigin(req) {
  return resolveRequestOrigin(req.headers, process.env.TRUST_PROXY_HEADERS === "true");
}

async function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(url.pathname);
    if (decodedPath.includes("\0")) throw new URIError("invalid path");
  } catch {
    res.writeHead(400).end("invalid path");
    return true;
  }
  const filePath = resolve(CLIENT_ROOT, `.${decodedPath}`);
  if (filePath === CLIENT_ROOT) return false;
  if (!filePath.startsWith(`${CLIENT_ROOT}${sep}`)) {
    res.writeHead(404).end("not found");
    return true;
  }
  // A public URL must remain inside the public directory after decoding and
  // path normalization, not merely start with /assets/ before decoding.
  if (url.pathname.startsWith("/assets/") && !isWithinPublicAssets(CLIENT_ROOT, filePath)) {
    res.writeHead(404).end("not found");
    return true;
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    res.writeHead(200, {
      "content-type": TYPES[extname(filePath)] || "application/octet-stream",
      "content-length": info.size,
      "cache-control": /\.[a-f0-9]{8,}\./i.test(filePath)
        ? "public, max-age=31536000, immutable"
        : "public, max-age=300",
    });
    if (req.method === "HEAD") res.end();
    else createReadStream(filePath).on("error", (error) => res.destroy(error)).pipe(res);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

function sendAuthError(res, status, message, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
    ...headers,
  });
  res.end(JSON.stringify({ error: message }));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function safeNext(value, origin) {
  if (!value || value.includes("\\") || [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return "/";
  try {
    const resolved = new URL(value, origin);
    return resolved.origin === origin && value.startsWith("/") && !value.startsWith("//")
      ? `${resolved.pathname}${resolved.search}${resolved.hash}` : "/";
  } catch { return "/"; }
}

async function readLoginBody(req, res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) {
      res.writeHead(413, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", connection: "close" }).end("login body too large");
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function clientIp(req) {
  if (process.env.TRUST_PROXY_HEADERS === "true") {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function sameOrigin(req, expectedOrigin) {
  const origin = req.headers.origin;
  if (typeof origin !== "string") return false;
  try { return new URL(origin).origin === expectedOrigin; } catch { return false; }
}

async function handleLogin(req, res, url, origin) {
  if (req.method === "GET") {
    const next = safeNext(url.searchParams.get("next") || "/", origin);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" });
    res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sign in</title><style>body{font:16px system-ui;max-width:24rem;margin:15vh auto;padding:1rem}input,button{font:inherit;width:100%;padding:.7rem;margin:.4rem 0}</style><h1>Sign in</h1><form method="post" action="/login"><input type="hidden" name="next" value="${escapeHtml(next)}"><label>Password<input type="password" name="password" autocomplete="current-password" required autofocus></label><button>Sign in</button></form></html>`);
    return;
  }
  if (req.method !== "POST") return sendAuthError(res, 405, "method_not_allowed", { allow: "GET, POST" });
  if (!sameOrigin(req, origin)) return sendAuthError(res, 403, "invalid_origin");
  if (!loginAllowed(clientIp(req))) return sendAuthError(res, 429, "too_many_attempts");
  if (!(req.headers["content-type"] || "").startsWith("application/x-www-form-urlencoded")) return sendAuthError(res, 415, "unsupported_media_type");
  const raw = await readLoginBody(req, res);
  if (raw === null) return;
  const fields = new URLSearchParams(raw);
  if (!verifyPassword(fields.get("password") || "", AUTH)) return sendAuthError(res, 401, "invalid_credentials");
  const next = safeNext(fields.get("next") || "/", origin);
  const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(issueSession(AUTH))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(AUTH.sessionHours * 3600)}${AUTH.cookieSecure ? "; Secure" : ""}`;
  res.writeHead(303, { location: next, "set-cookie": cookie, "cache-control": "no-store" });
  res.end();
}

async function handle(req, res) {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end("ok");
    return;
  }

  const origin = requestOrigin(req);
  const url = new URL(req.url || "/", origin);
  if (url.pathname === "/login") return handleLogin(req, res, url, origin);
  if (req.method === "POST" && url.pathname === "/logout") {
    if (!sameOrigin(req, origin)) return sendAuthError(res, 403, "invalid_origin");
    const secure = AUTH.cookieSecure ? "; Secure" : "";
    res.writeHead(303, { location: "/login", "set-cookie": `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`, "cache-control": "no-store" }).end();
    return;
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const part of value) headers.append(name, part);
    else if (value !== undefined) headers.set(name, value);
  }
  const authorized = !AUTH.enabled || isAuthorized(headers, AUTH);
  const publicRequest = isPublicPath(req.method || "GET", url.pathname);
  if (!publicRequest && !authorized) {
    if (req.method === "GET" && (req.headers.accept || "").includes("text/html") && !url.pathname.startsWith("/api/")) {
      const next = `${url.pathname}${url.search}`;
      res.writeHead(302, { location: `/login?next=${encodeURIComponent(next)}`, "cache-control": "no-store", connection: "close" }).end();
    } else {
      sendAuthError(res, 401, "unauthorized", { "www-authenticate": "Bearer" });
    }
    return;
  }
  if (authorized && requiresOriginCheck(headers, AUTH) &&
      req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req, origin)) {
    return sendAuthError(res, 403, "invalid_origin");
  }
  if (url.pathname.startsWith("/assets/") && (req.method === "GET" || req.method === "HEAD")) {
    if (await serveStatic(req, res, url)) return;
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
    return;
  }
  if (await serveStatic(req, res, url)) return;

    let body;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) {
          res.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
          res.end("request body too large");
          return;
        }
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    }
    const request = new Request(url, {
      method: req.method,
      headers,
      ...(body ? { body } : {}),
    });
    const response = await startHandler.fetch(request);
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    res.writeHead(response.status, responseHeaders);
    if (!response.body || req.method === "HEAD") {
      res.end();
      return;
    }
    Readable.fromWeb(response.body).on("error", (error) => res.destroy(error)).pipe(res);
}

const server = createServer((req, res) => {
  void handle(req, res).catch((error) => handleRequestError(req, res, error));
});

server.listen(PORT, HOST, () => console.log(`[server] listening on http://${HOST}:${PORT}`));
server.on("error", (error) => {
  console.error("[server] failed to start", error);
  process.exitCode = 1;
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
