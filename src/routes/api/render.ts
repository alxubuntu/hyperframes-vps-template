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

const MAX_RENDER_HTML_BYTES = 2 * 1024 * 1024;

interface RenderRequestBody {
  html?: string;
}

export const Route = createFileRoute("/api/render")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let files: CompositionFile[];
        let source: "bundled" | "html" = "bundled";

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
