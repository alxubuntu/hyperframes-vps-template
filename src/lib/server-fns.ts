import { createServerFn } from "@tanstack/react-start";
import type { LintError } from "./generation";
import type { SelectableOpenRouterModel } from "./openrouter-models";
import { getOpenRouterCatalog } from "./server/openrouter-catalog";
import { lintFiltered } from "./server/lint";

export const getAppConfig = createServerFn({ method: "GET" }).handler(async () => {
  return { aiGenEnabled: process.env.ENABLE_AI_GEN === "true" };
});

export type OpenRouterModelsResult =
  | { ok: true; models: SelectableOpenRouterModel[] }
  | { ok: false; error: string };

/**
 * Serve OpenRouter's public text-model catalog. The BYOK key is deliberately
 * not accepted here: listing models needs no credential, and keeping it out of
 * this request preserves the "key only goes to OpenRouter" promise.
 */
export const listOpenRouterModels = createServerFn({ method: "GET" }).handler(
  async (): Promise<OpenRouterModelsResult> => {
    try {
      return { ok: true, models: await getOpenRouterCatalog() };
    } catch {
      return {
        ok: false,
        error:
          "Could not load OpenRouter's model list. Check the server's network access and try again.",
      };
    }
  },
);

export const lintComposition = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const d = data as { html?: unknown } | null | undefined;
    if (!d || typeof d.html !== "string") throw new Error("html must be a string");
    return { html: d.html };
  })
  .handler(async ({ data }): Promise<{ errors: LintError[] }> => {
    return { errors: lintFiltered(data.html) };
  });
