import type { ProviderId } from "../providers";
import { PROVIDERS } from "../providers";
import { getDeepSeekCatalog } from "./deepseek-catalog";
import { InvalidOpenRouterModelError, resolveOpenRouterModel } from "./openrouter-catalog";

/** Raised for any model id a provider will not accept. Message is user-facing. */
export class InvalidModelError extends Error {}

const DEEPSEEK_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function isValidDeepSeekModelId(value: string): boolean {
  return DEEPSEEK_MODEL_ID_PATTERN.test(value);
}

/**
 * Pick the model for one generation call, per provider. DeepSeek's catalog
 * requires the caller's key, so it is only consulted when one is supplied; a
 * well-formed id is accepted when the catalog is unavailable, mirroring the
 * OpenRouter policy so a catalog outage does not block generation.
 */
export async function resolveRequestedModel(
  provider: ProviderId,
  value: unknown,
  options: { apiKey?: string } = {},
): Promise<string> {
  if (provider === "openrouter") {
    try {
      return await resolveOpenRouterModel(value);
    } catch (err) {
      if (err instanceof InvalidOpenRouterModelError) throw new InvalidModelError(err.message);
      throw err;
    }
  }

  return resolveDeepSeekModel(value, options.apiKey);
}

async function resolveDeepSeekModel(value: unknown, apiKey: string | undefined): Promise<string> {
  const defaultModel = PROVIDERS.deepseek.defaultModelId;

  if (value === undefined) {
    if (defaultModel) return defaultModel;
    throw new InvalidModelError("model is required for DeepSeek");
  }

  if (typeof value !== "string" || !isValidDeepSeekModelId(value)) {
    throw new InvalidModelError("invalid DeepSeek model id");
  }

  if (!apiKey) return value;

  let models: Awaited<ReturnType<typeof getDeepSeekCatalog>> | null = null;
  try {
    models = await getDeepSeekCatalog(apiKey);
  } catch {
    models = null;
  }

  if (models && !models.some((model) => model.id === value)) {
    throw new InvalidModelError(
      `unknown DeepSeek model "${value}"; pick one from the loaded list`,
    );
  }

  return value;
}
