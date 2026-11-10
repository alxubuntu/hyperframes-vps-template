import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import {
  createLoginLimiter,
  isAuthorized,
  isPublicPath,
  issueSession,
  loadAuthConfig,
  verifyPassword,
  verifySession,
  resolveRequestOrigin,
  handleRequestError,
  isWithinPublicAssets,
  requiresOriginCheck,
} from "./auth.mjs";

const env = {
  AUTH_ENABLED: "true",
  AUTH_PASSWORD: "correct horse battery staple",
  AUTH_API_TOKEN: "x".repeat(32),
};

test("public assets cannot escape through encoded separators", () => {
  const root = resolve("dist/client");
  for (const path of ["/assets/..%2fcompositions/example.html", "/assets/..%2fassets-other/file.js"]) {
    const url = new URL(path, "http://localhost");
    const file = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    assert.equal(isWithinPublicAssets(root, file), false);
  }
  assert.equal(isWithinPublicAssets(root, resolve(root, "assets/app.js")), true);
});

test("origin check depends on cookie authentication, not incidental cookies", () => {
  const config = loadAuthConfig(env);
  const bearer = new Headers({ authorization: `Bearer ${env.AUTH_API_TOKEN}`, cookie: "other=value" });
  assert.equal(requiresOriginCheck(bearer, config), false);
  const cookie = new Headers({ cookie: `hf_session=${issueSession(config)}` });
  assert.equal(isAuthorized(cookie, config), true);
  assert.equal(requiresOriginCheck(cookie, config), true);
  cookie.set("authorization", "Bearer wrong");
  assert.equal(requiresOriginCheck(cookie, config), true);
  assert.equal(requiresOriginCheck(cookie, loadAuthConfig({ AUTH_ENABLED: "false" })), false);
});

test("TLS proxy origin matches browser HTTPS only when proxy headers are trusted", () => {
  const headers = { host: "internal:3000", "x-forwarded-host": "video.example", "x-forwarded-proto": "https" };
  assert.equal(resolveRequestOrigin(headers, true), new URL("https://video.example").origin);
  assert.equal(resolveRequestOrigin(headers, false), "http://internal:3000");
  assert.throws(() => new URL("//[", resolveRequestOrigin(headers, true)), { code: "ERR_INVALID_URL" });
});

test("request failures return 400 for invalid URLs and do not write to closed connections", () => {
  const res = {
    destroyed: false, writableEnded: false, headersSent: false,
    writeHead(status) { this.status = status; },
    end(body) { this.body = body; },
  };
  let invalid;
  try { new URL("//[", "http://localhost"); } catch (error) { invalid = error; }
  handleRequestError({ destroyed: false }, res, invalid);
  assert.equal(res.status, 400);
  assert.equal(res.body, "invalid request");
  const closed = { destroyed: true, writeHead() { assert.fail("must not write"); } };
  handleRequestError({ destroyed: true }, closed, Object.assign(new Error("aborted"), { code: "ECONNRESET" }));
});

test("configuration is explicit and validates credentials", () => {
  assert.throws(() => loadAuthConfig({ AUTH_ENABLED: "treu" }));
  assert.throws(() => loadAuthConfig({ AUTH_ENABLED: "true", AUTH_PASSWORD: "short" }));
  assert.equal(loadAuthConfig({ ...env }).enabled, true);
  assert.equal(loadAuthConfig({ AUTH_ENABLED: "false" }).enabled, false);
});

test("password and bearer checks authorize only configured credentials", () => {
  const config = loadAuthConfig(env);
  assert.equal(verifyPassword(env.AUTH_PASSWORD, config), true);
  assert.equal(verifyPassword("wrong", config), false);
  assert.equal(isAuthorized(new Headers({ authorization: `Bearer ${env.AUTH_API_TOKEN}` }), config), true);
  assert.equal(isAuthorized(new Headers({ authorization: "Bearer " }), config), false);
});

test("session is signed, expires, and password or secret rotation revokes it", () => {
  const config = loadAuthConfig(env);
  const token = issueSession(config, 1000);
  assert.equal(verifySession(token, config, 1001), true);
  assert.equal(verifySession(token, config, 1000 + 12 * 60 * 60 * 1000), false);
  assert.equal(verifySession(`${token}x`, config, 1001), false);
  assert.equal(verifySession(token, loadAuthConfig({ ...env, AUTH_PASSWORD: "a different long password" }), 1001), false);
  const withSecret = loadAuthConfig({ ...env, AUTH_SECRET: "s".repeat(32) });
  assert.equal(verifySession(issueSession(withSecret, 1000), loadAuthConfig(env), 1001), false);
});

test("login limiter bounds attempts and entries", () => {
  const allow = createLoginLimiter({ windowMs: 100, maxAttempts: 2, maxEntries: 1 });
  assert.equal(allow("a", 0), true);
  assert.equal(allow("a", 1), true);
  assert.equal(allow("a", 2), false);
  assert.equal(allow("b", 3), false);
  assert.equal(allow("a", 101), true);
});

test("public paths are a strict allowlist", () => {
  assert.equal(isPublicPath("GET", "/healthz"), true);
  assert.equal(isPublicPath("POST", "/login"), true);
  assert.equal(isPublicPath("GET", "/assets/app.js"), true);
  assert.equal(isPublicPath("GET", "/api/render"), false);
  assert.equal(isPublicPath("GET", "/r/123"), false);
});
