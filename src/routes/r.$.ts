import { createFileRoute } from "@tanstack/react-router";
import { serveRenderVideo } from "../lib/server/render-jobs.mjs";

export const Route = createFileRoute("/r/$")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        return serveRenderVideo(params._splat ?? "", request);
      },
    },
  },
});
