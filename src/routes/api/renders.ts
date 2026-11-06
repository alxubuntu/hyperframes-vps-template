import { createFileRoute } from "@tanstack/react-router";
import { listCompletedRenders } from "../../lib/server/render-jobs.mjs";

export const Route = createFileRoute("/api/renders")({
  server: {
    handlers: {
      GET: async () => Response.json(await listCompletedRenders()),
    },
  },
});
