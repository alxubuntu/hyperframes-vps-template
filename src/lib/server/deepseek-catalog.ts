import { parseDeepSeekCatalog, type SelectableModel } from "../models";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_MODELS_URL = `${DEEPSEEK_BASE_URL}/models`;
export const DEEPSEEK_CATALOG_TTL_MS = 5 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 8_000;

export class DeepSeekCatalogError extends Error {}

/** The provider rejected the caller's key; never echo the key back. */
export class DeepSeekAuthError extends Error {}

interface CatalogCache {
  models: SelectableModel[];
  fetchedAt: number;
}

let cache: CatalogCache | null = null;
let inFlight: Promise<SelectableModel[]> | null = null;

async function fetchDeepSeekCatalog(apiKey: string): Promise<SelectableModel[]> {
  let response: Response;
  try {
    response = await fetch(DEEPSEEK_MODELS_URL, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "user-agent": "HyperFrames-VPS-Template",
      },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
  } catch {
    throw new DeepSeekCatalogError("Could not reach DeepSeek's model catalog.");
  }

  if (response.status === 401 || response.status === 403) {
    throw new DeepSeekAuthError(
      "DeepSeek rejected this API key. Check it at platform.deepseek.com and try again.",
    );
  }

  if (!response.ok) {
    throw new DeepSeekCatalogError(`DeepSeek's model catalog returned HTTP ${response.status}.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new DeepSeekCatalogError("DeepSeek's model catalog returned invalid JSON.");
  }

  return parseDeepSeekCatalog(payload);
}

/**
 * Return DeepSeek's live model catalog for the supplied key. The listing is
 * account-independent, so a success is cached for five minutes and a failed
 * refresh keeps serving the last good list. Failures are never cached, so a
 * corrected key is picked up immediately. The key is used for this one call
 * and is not stored with the cache.
 */
export function getDeepSeekCatalog(apiKey: string): Promise<SelectableModel[]> {
  if (cache && Date.now() - cache.fetchedAt < DEEPSEEK_CATALOG_TTL_MS) {
    return Promise.resolve(cache.models);
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const models = await fetchDeepSeekCatalog(apiKey);
      cache = { models, fetchedAt: Date.now() };
      return models;
    } catch (err) {
      // A rejected key is actionable even when an older list is cached;
      // network and server errors keep the last good catalog instead.
      if (err instanceof DeepSeekAuthError) throw err;
      if (cache) return cache.models;
      throw err instanceof DeepSeekCatalogError
        ? err
        : new DeepSeekCatalogError("Could not load DeepSeek's model catalog.");
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}
