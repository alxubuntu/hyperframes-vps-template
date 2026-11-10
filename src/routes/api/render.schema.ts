import { createFileRoute } from "@tanstack/react-router";
import { ALLOWED_REMOTE_SCRIPTS, CONTRACT_VERSION } from "../../lib/server/preflight.mjs";

// Machine-readable contract. An agent fetches this before building a payload,
// so it does not have to guess the shape or the failure modes.
const SCHEMA = {
  contractVersion: CONTRACT_VERSION,
  purpose:
    "Render an HTML composition to MP4. The render container has no network access, so every asset must travel inside the request.",
  endpoints: {
    dryRun: "POST /api/render?dryRun=1  -> 200 { ok, issues, warnings }; never queues",
    render: "POST /api/render          -> 202 { id, status, statusUrl, warnings, contractVersion }",
    status: "GET /api/render-status?id=<uuid>",
    video: "GET /r/<uuid>  (MP4, supports Range and ?download=1)",
    list: "GET /api/renders",
  },
  renderStatus: {
    phase: "queued, preparing, unknown, rendering, encoding, finalizing, or completed",
    phaseProgress: "0-100 within the current phase only; null when unavailable",
    timestamps: "startedAt, lastActivityAt and progressUpdatedAt are ISO timestamps or null",
  },
  modes: {
    bundled: { body: "{} or no body", description: "Renders the composition shipped with the server." },
    html: {
      body: { html: "<!doctype html>…" },
      description: "One self-contained HTML file. Assets must be data: URIs.",
    },
    files: {
      body: { files: [{ path: "index.html", content: "<base64>" }, { path: "assets/logo.png", content: "<base64>" }] },
      description: "Multi-file composition; every path is relative to the project root.",
    },
  },
  minimalValid:
    '<div data-composition-id="intro" data-root="true" data-width="1920" data-height="1080" data-duration="8">…</div>',
  requirements: [
    "A root element with data-composition-id, data-root=\"true\", data-width, data-height and data-duration (seconds).",
    "No http:// or https:// in src, href or css url(). Download the file and inline it as a data URI, or send it in files[].",
    "Every <img> and @font-face points at a data: URI or at a file present in files[].",
    "Fonts: only fonts sent with the composition render as designed; anything else falls back.",
    `These server-local scripts are allowed and are rewritten automatically: ${[...ALLOWED_REMOTE_SCRIPTS].join(", ")}`,
  ],
  limits: {
    htmlBytes: "MAX_RENDER_HTML_BYTES (default 33554432)",
    requestBytes: "MAX_REQUEST_BYTES (default 67108864)",
    compositionBytes: "MAX_COMPOSITION_BYTES (default 0.75 x request cap)",
    files: 2000,
  },
  errorCodes: {
    "missing-root": { blocking: true, fix: "Add data-composition-id/data-root/data-width/data-height/data-duration to the root element." },
    "external-url": { blocking: true, fix: "Download the asset and inline it as data:<type>;base64,… or send it in files[] and reference it relatively." },
    "missing-asset": { blocking: true, fix: "Add the referenced file to files[] under the same relative path." },
    "bad-base64": { blocking: true, fix: "Re-encode the whole file; the base64 is truncated or corrupt." },
    "bad-font": { blocking: true, fix: "The data URI claims a font format the bytes are not; re-encode the real woff2/woff file." },
    "unsafe-path": { blocking: true, fix: "Use a relative path such as assets/x.png; no .., no absolute paths." },
    "system-font": { blocking: false, fix: "Embed the family with @font-face, or accept the fallback font." },
    "unknown-font": { blocking: false, fix: "Declare the family with @font-face pointing at a data URI or an asset in files[]." },
    "heavy-image": { blocking: false, fix: "Resize and convert to WebP (1920px wide is usually enough)." },
    "long-duration": { blocking: false, fix: "Longer compositions take proportionally longer to render." },
  },
  failureResponse: {
    status: 400,
    body: {
      error: "preflight failed",
      contractVersion: 2,
      docs: "/api/render/schema",
      issues: [{ code: "external-url", file: "index.html", detail: "<img src=\"https://…\">", message: "…", fix: "…" }],
      warnings: [],
    },
  },
} as const;

export const Route = createFileRoute("/api/render/schema")({
  server: {
    handlers: {
      GET: async () =>
        Response.json(SCHEMA, { headers: { "cache-control": "public, max-age=300" } }),
    },
  },
});
