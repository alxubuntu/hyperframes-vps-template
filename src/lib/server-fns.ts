import { createServerFn } from "@tanstack/react-start";
import type { LintError } from "./generation";
import type { SelectableModel } from "./models";
import { isProviderId } from "./providers";
import { getDeepSeekCatalog, DeepSeekAuthError } from "./server/deepseek-catalog";
import { getOpenRouterCatalog } from "./server/openrouter-catalog";
import { lintFiltered } from "./server/lint";

export const getAppConfig = createServerFn({ method: "GET" }).handler(async () => {
  return { aiGenEnabled: process.env.ENABLE_AI_GEN === "true" };
});

export type ModelListResult =
  | { ok: true; models: SelectableModel[] }
  | { ok: false; error: string };

/**
 * Serve the selected provider's model catalog. OpenRouter's list is public, so
 * its key is never accepted here. DeepSeek's list requires auth, so the caller
 * forwards the key for that one request; it is used for the upstream call and
 * never stored.
 */
export const listModels = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const d = data as { provider?: unknown; apiKey?: unknown } | null | undefined;
    if (!d || !isProviderId(d.provider)) throw new Error("unsupported provider");
    if (d.apiKey !== undefined && typeof d.apiKey !== "string") {
      throw new Error("apiKey must be a string");
    }
    return { provider: d.provider, apiKey: typeof d.apiKey === "string" ? d.apiKey : undefined };
  })
  .handler(async ({ data }): Promise<ModelListResult> => {
    if (data.provider === "openrouter") {
      try {
        return { ok: true, models: await getOpenRouterCatalog() };
      } catch {
        return {
          ok: false,
          error:
            "Could not load OpenRouter's model list. Check the server's network access and try again.",
        };
      }
    }

    const apiKey = data.apiKey?.trim() ?? "";
    if (!apiKey) {
      return { ok: false, error: "Enter your DeepSeek API key to load models." };
    }

    try {
      return { ok: true, models: await getDeepSeekCatalog(apiKey) };
    } catch (err) {
      if (err instanceof DeepSeekAuthError) {
        return { ok: false, error: err.message };
      }
      return {
        ok: false,
        error:
          "Could not load DeepSeek's model list. Check the server's network access and try again.",
      };
    }
  });

export const lintComposition = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const d = data as { html?: unknown } | null | undefined;
    if (!d || typeof d.html !== "string") throw new Error("html must be a string");
    return { html: d.html };
  })
  .handler(async ({ data }): Promise<{ errors: LintError[] }> => {
    return { errors: lintFiltered(data.html) };
  });
