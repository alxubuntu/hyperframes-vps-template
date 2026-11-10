import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { resolve, sep } from "node:path";

export function isWithinPublicAssets(clientRoot, filePath) {
  return filePath.startsWith(`${resolve(clientRoot, "assets")}${sep}`);
}

export function requiresOriginCheck(headers, config) {
  return config.enabled && !verifyBearer(headers.get("authorization"), config);
}

const COOKIE_NAME = "hf_session";
const PASSWORD_MIN = 16;
const SECRET_MIN = 32;

export function resolveRequestOrigin(headers, trustProxy = false) {
  const first = (value) => (Array.isArray(value) ? value[0] : value)?.split(",")[0].trim();
  const host = (trustProxy && first(headers["x-forwarded-host"])) || headers.host;
  const protocol = (trustProxy && first(headers["x-forwarded-proto"])) || "http";
  if (!host || (protocol !== "http" && protocol !== "https")) throw new TypeError("Invalid request origin");
  return new URL(`${protocol}://${host}`).origin;
}

export function handleRequestError(req, res, error) {
  if (req.destroyed || res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const badRequest = error?.code === "ERR_INVALID_URL" || error?.code === "ERR_INVALID_ARG_VALUE" || error instanceof URIError;
  if (!badRequest) console.error("[server] request failed", error);
  res.writeHead(badRequest ? 400 : 500, {
    "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", connection: "close",
  });
  res.end(badRequest ? "invalid request" : "internal server error");
}

export function loadAuthConfig(env = process.env) {
  const enabledValue = env.AUTH_ENABLED;
  if (enabledValue !== undefined && enabledValue !== "true" && enabledValue !== "false") {
    throw new Error("AUTH_ENABLED must be true or false");
  }
  const enabled = enabledValue !== "false";
  const password = env.AUTH_PASSWORD || "";
  const apiToken = env.AUTH_API_TOKEN || "";
  const secret = env.AUTH_SECRET || "";
  if (enabled && password.length < PASSWORD_MIN) {
    throw new Error(`AUTH_PASSWORD must be at least ${PASSWORD_MIN} characters when authentication is enabled`);
  }
  for (const [name, value] of [["AUTH_SECRET", secret], ["AUTH_API_TOKEN", apiToken]]) {
    if (value && value.length < SECRET_MIN) throw new Error(`${name} must be at least ${SECRET_MIN} characters`);
  }
  const hours = Number(env.AUTH_SESSION_HOURS ?? 12);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error("AUTH_SESSION_HOURS must be a positive finite number");
  const secureValue = env.AUTH_COOKIE_SECURE ?? "true";
  if (secureValue !== "true" && secureValue !== "false") throw new Error("AUTH_COOKIE_SECURE must be true or false");
  return {
    enabled, password, apiToken, sessionHours: hours,
    cookieSecure: secureValue === "true",
    signingKey: createHmac("sha256", password || "hyperframes-auth-disabled")
      .update(`hyperframes-session-v1:${secret}`).digest(),
  };
}

function fixedEqual(a, b) {
  const left = createHash("sha256").update(String(a)).digest();
  const right = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(left, right);
}

export function verifyPassword(candidate, config) {
  return fixedEqual(candidate, config.password);
}

export function verifyBearer(header, config) {
  const match = /^Bearer\s+(.+)$/i.exec(header || "");
  return Boolean(config.apiToken) && Boolean(match) && fixedEqual(match[1], config.apiToken);
}

export function issueSession(config, now = Date.now()) {
  const expiry = Math.floor(now + config.sessionHours * 60 * 60 * 1000);
  const signature = createHmac("sha256", config.signingKey).update(String(expiry)).digest("hex");
  return `${expiry}.${signature}`;
}

export function verifySession(value, config, now = Date.now()) {
  if (typeof value !== "string") return false;
  const match = /^(\d{1,16})\.([a-f0-9]{64})$/.exec(value);
  if (!match) return false;
  const expiry = Number(match[1]);
  if (!Number.isFinite(expiry) || expiry <= now) return false;
  const expected = createHmac("sha256", config.signingKey).update(match[1]).digest("hex");
  return fixedEqual(match[2], expected);
}

export function sessionFromCookie(header) {
  for (const part of (header || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== COOKIE_NAME) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return ""; }
  }
  return "";
}

export function isAuthorized(headers, config) {
  return verifyBearer(headers.get("authorization"), config) ||
    verifySession(sessionFromCookie(headers.get("cookie")), config);
}

export function isPublicPath(method, pathname) {
  if (method === "GET" && pathname === "/healthz") return true;
  if (method === "GET" && pathname === "/login") return true;
  if (method === "POST" && (pathname === "/login" || pathname === "/logout")) return true;
  return (method === "GET" || method === "HEAD") && pathname.startsWith("/assets/");
}

export function createLoginLimiter({ windowMs = 5 * 60_000, maxAttempts = 10, maxEntries = 10_000 } = {}) {
  const entries = new Map();
  return (ip, now = Date.now()) => {
    for (const [key, value] of entries) if (value.until <= now) entries.delete(key);
    let entry = entries.get(ip);
    if (!entry) {
      if (entries.size >= maxEntries) return false;
      entry = { count: 0, until: now + windowMs };
      entries.set(ip, entry);
    }
    if (entry.count >= maxAttempts) return false;
    entry.count += 1;
    return true;
  };
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
