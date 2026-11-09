import { createFileRoute } from "@tanstack/react-router";
import {
  htmlToFiles,
  isJsonRequest,
  jsonError,
  loadBundledCompositionFiles,
  msg,
  utf8ByteLength,
  type CompositionFile,
} from "../../lib/server/assets";
import { enqueueRender } from "../../lib/server/render-jobs.mjs";

const MAX_RENDER_HTML_BYTES =
  Number.parseInt(process.env.MAX_RENDER_HTML_BYTES ?? "", 10) || 2 * 1024 * 1024;
// Mirrors the enqueue-side limit; validated again there with the real byte count.
const MAX_COMPOSITION_FILES = 2_000;

interface RenderRequestBody {
  html?: string;
  /** Multi-file composition; each entry is a relative path plus base64 bytes. */
  files?: unknown;
}

export const Route = createFileRoute("/api/render")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let files: CompositionFile[];
        let source: "bundled" | "html" | "files" = "bundled";

        // Empty body falls through to the bundled composition for back-compat
        // with the original "click Render" flow that doesn't post any body.
        let body: RenderRequestBody | null = null;
        if (isJsonRequest(request)) {
          try {
            body = (await request.json()) as RenderRequestBody;
          } catch {
            return jsonError("invalid JSON body", 400);
          }
        }

        if (body?.html) {
          // Keep custom HTML rendering behind the same opt-in as AI generation.
          if (process.env.ENABLE_AI_GEN !== "true") {
            return jsonError(
              'Rendering custom HTML is disabled. Set ENABLE_AI_GEN="true" in your .env file to enable it.',
              403,
            );
          }
          if (typeof body.html !== "string") {
            return jsonError("html must be a string", 400);
          }
          if (utf8ByteLength(body.html) > MAX_RENDER_HTML_BYTES) {
            return jsonError(`html exceeds ${MAX_RENDER_HTML_BYTES} bytes`, 413);
          }
          files = htmlToFiles(body.html);
          source = "html";
        } else if (body?.files !== undefined) {
          // Multi-file uploads share the custom-HTML opt-in and go through the
          // same path validator that guards the render directory.
          if (process.env.ENABLE_AI_GEN !== "true") {
            return jsonError(
              'Rendering custom HTML is disabled. Set ENABLE_AI_GEN="true" in your .env file to enable it.',
              403,
            );
          }
          if (!Array.isArray(body.files)) {
            return jsonError("files must be an array of { path, content }", 400);
          }
          if (body.files.length === 0 || body.files.length > MAX_COMPOSITION_FILES) {
            return jsonError(`files must contain between 1 and ${MAX_COMPOSITION_FILES} items`, 400);
          }
          files = body.files as CompositionFile[];
          source = "files";
        } else {
          try {
            files = await loadBundledCompositionFiles();
          } catch (err) {
            return jsonError(`failed to load composition: ${msg(err)}`, 500);
          }
        }

        let job;
        try {
          job = await enqueueRender(files, source);
        } catch (err) {
          return jsonError(`failed to queue render: ${msg(err)}`, 400);
        }
        return Response.json(
          { id: job.id, status: job.status, statusUrl: `/api/render-status?id=${job.id}` },
          { status: 202 },
        );
      },
    },
  },
});
