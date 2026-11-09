import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = resolve(ROOT, "dist/client");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
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
  const useForwarded = process.env.TRUST_PROXY_HEADERS === "true";
  const forwardedHost = useForwarded ? req.headers["x-forwarded-host"] : undefined;
  const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) || req.headers.host || `${HOST}:${PORT}`;
  const forwardedProto = useForwarded ? req.headers["x-forwarded-proto"] : undefined;
  const protocol = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) || "http";
  return `${protocol}://${host}`;
}

async function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(url.pathname);
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

async function handle(req, res) {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end("ok");
    return;
  }

  const origin = requestOrigin(req);
  const url = new URL(req.url || "/", origin);
  if (await serveStatic(req, res, url)) return;

  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const part of value) headers.append(name, part);
      else if (value !== undefined) headers.set(name, value);
    }
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
  } catch (error) {
    console.error("[server] request failed", error);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("internal server error");
  }
}

const server = createServer((req, res) => {
  void handle(req, res);
});

server.listen(PORT, HOST, () => console.log(`[server] listening on http://${HOST}:${PORT}`));
server.on("error", (error) => {
  console.error("[server] failed to start", error);
  process.exitCode = 1;
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
