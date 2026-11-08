import { parseOpenRouterCatalog, pickDefaultModel, type SelectableModel } from "../models";

export const CATALOG_URL = "https://openrouter.ai/api/v1/models";
export const CATALOG_TTL_MS = 5 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 8_000;
const MAX_MODEL_ID_LENGTH = 200;

export class OpenRouterCatalogError extends Error {}

export class InvalidOpenRouterModelError extends Error {}

interface CatalogCache {
  models: SelectableModel[];
  fetchedAt: number;
}

let cache: CatalogCache | null = null;
let inFlight: Promise<SelectableModel[]> | null = null;

async function fetchOpenRouterCatalog(): Promise<SelectableModel[]> {
  let response: Response;
  try {
    response = await fetch(CATALOG_URL, {
      headers: {
        accept: "application/json",
        "user-agent": "HyperFrames-VPS-Template",
      },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
  } catch {
    throw new OpenRouterCatalogError("Could not reach OpenRouter's model catalog.");
  }

  if (!response.ok) {
    throw new OpenRouterCatalogError(
      `OpenRouter's model catalog returned HTTP ${response.status}.`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new OpenRouterCatalogError("OpenRouter's model catalog returned invalid JSON.");
  }

  return parseOpenRouterCatalog(payload);
}

/**
 * Return OpenRouter's live text-model catalog. A successful response is cached
 * for five minutes; a failed refresh keeps serving the last good catalog so a
 * transient network error does not empty the picker.
 */
export function getOpenRouterCatalog(): Promise<SelectableModel[]> {
  if (cache && Date.now() - cache.fetchedAt < CATALOG_TTL_MS) {
    return Promise.resolve(cache.models);
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const models = await fetchOpenRouterCatalog();
      cache = { models, fetchedAt: Date.now() };
      return models;
    } catch (err) {
      if (cache) return cache.models;
      throw err instanceof OpenRouterCatalogError
        ? err
        : new OpenRouterCatalogError("Could not load OpenRouter's model catalog.");
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

function isValidModelId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_MODEL_ID_LENGTH &&
    /^[A-Za-z0-9~][A-Za-z0-9._:@+~-]*\/[A-Za-z0-9~][A-Za-z0-9._:/@+~-]*$/.test(value)
  );
}

/**
 * Pick the model for one generation call. When the catalog is reachable the id
 * must be a known text model; when it is not, a syntactically valid id is
 * allowed through so an upstream catalog outage does not break generation.
 */
export async function resolveOpenRouterModel(value: unknown): Promise<string> {
  let models: SelectableModel[] | null = null;
  try {
    models = await getOpenRouterCatalog();
  } catch {
    models = null;
  }

  if (value === undefined) {
    if (!models) {
      throw new InvalidOpenRouterModelError(
        "model is required while OpenRouter's model catalog is unavailable",
      );
    }
    const fallback = pickDefaultModel(models);
    if (!fallback) {
      throw new InvalidOpenRouterModelError("OpenRouter returned no text models");
    }
    return fallback;
  }

  if (typeof value !== "string" || !isValidModelId(value)) {
    throw new InvalidOpenRouterModelError("invalid OpenRouter model id");
  }

  if (models && !models.some((model) => model.id === value)) {
    throw new InvalidOpenRouterModelError(
      `unknown OpenRouter model "${value}"; pick one from the loaded list`,
    );
  }

  return value;
}
