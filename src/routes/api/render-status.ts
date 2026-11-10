import { createFileRoute } from "@tanstack/react-router";
import { getRenderJob } from "../../lib/server/render-jobs.mjs";
import { jsonError } from "../../lib/server/assets";

export const Route = createFileRoute("/api/render-status")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const id = new URL(request.url).searchParams.get("id") ?? "";
        if (!/^[0-9a-f-]{36}$/i.test(id)) {
          const response = jsonError("invalid render job id", 400);
          response.headers.set("cache-control", "no-store");
          return response;
        }
        const job = await getRenderJob(id);
        if (!job) {
          const response = jsonError("render job not found", 404);
          response.headers.set("cache-control", "no-store");
          return response;
        }
        return Response.json(job, { headers: { "cache-control": "no-store" } });
      },
    },
  },
});
