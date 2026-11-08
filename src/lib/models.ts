import type { ProviderId } from "./providers";

export interface SelectableModel {
  provider: ProviderId;
  id: string;
  name: string;
  free: boolean;
  /** USD per 1M prompt tokens, or null when the provider does not report it. */
  promptPricePerMillion: number | null;
  /** USD per 1M completion tokens, or null when the provider does not report it. */
  completionPricePerMillion: number | null;
  contextLength: number | null;
  /** Maximum output tokens the provider allows, when reported. */
  maxOutputTokens: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pricePerToken(value: unknown): number | null {
  const parsed =
    typeof value === "string"
      ? value.trim() === ""
        ? NaN
        : Number(value)
      : typeof value === "number"
        ? value
        : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function pricePerMillion(value: unknown): number | null {
  const perToken = pricePerToken(value);
  if (perToken === null) return null;
  // Prices arrive as USD per token; round away binary-float noise such as
  // 0.7999999999999999 before the UI formats them per million tokens.
  return Math.round(perToken * 1_000_000 * 1_000_000) / 1_000_000;
}

function outputsText(architecture: Record<string, unknown>): boolean {
  if (
    Array.isArray(architecture.output_modalities) &&
    architecture.output_modalities.includes("text")
  ) {
    return true;
  }
  return typeof architecture.modality === "string" && architecture.modality.endsWith("->text");
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function byNameThenId(a: SelectableModel, b: SelectableModel): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/**
 * Shape OpenRouter's /api/v1/models payload into the small surface the UI
 * needs. Entries that cannot produce text are dropped: they would only fail
 * the generation request later.
 */
export function parseOpenRouterCatalog(payload: unknown): SelectableModel[] {
  const models = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
  const byId = new Map<string, SelectableModel>();

  for (const entry of models) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const architecture = isRecord(entry.architecture) ? entry.architecture : null;
    if (!id || !architecture || !outputsText(architecture)) continue;

    const pricing = isRecord(entry.pricing) ? entry.pricing : {};
    const prompt = pricePerToken(pricing.prompt);
    const completion = pricePerToken(pricing.completion);
    if (byId.has(id)) continue;

    byId.set(id, {
      provider: "openrouter",
      id,
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id,
      free: prompt === 0 && completion === 0,
      promptPricePerMillion: pricePerMillion(pricing.prompt),
      completionPricePerMillion: pricePerMillion(pricing.completion),
      contextLength: positiveInteger(entry.context_length),
      maxOutputTokens: null,
    });
  }

  return [...byId.values()].sort(byNameThenId);
}

/**
 * Shape DeepSeek's /models payload. Every entry is billed per token, so no
 * prices are reported; the metadata that does exist (context window, output
 * limit) is kept for the picker. Output modalities are only filtered when the
 * provider states them.
 */
export function parseDeepSeekCatalog(payload: unknown): SelectableModel[] {
  const models = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
  const byId = new Map<string, SelectableModel>();

  for (const entry of models) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id || byId.has(id)) continue;
    if (Array.isArray(entry.output_modalities) && !entry.output_modalities.includes("text")) {
      continue;
    }

    byId.set(id, {
      provider: "deepseek",
      id,
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id,
      free: false,
      promptPricePerMillion: null,
      completionPricePerMillion: null,
      contextLength: positiveInteger(entry.context_window),
      maxOutputTokens: positiveInteger(entry.max_output_tokens),
    });
  }

  // Id order keeps DeepSeek's short list deterministic across catalog refreshes.
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Client-side narrowing of an already parsed catalog. */
export function filterModels(
  models: SelectableModel[],
  options: { freeOnly?: boolean; query?: string } = {},
): SelectableModel[] {
  const tokens = (options.query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);

  return models.filter((model) => {
    if (options.freeOnly && !model.free) return false;
    if (tokens.length === 0) return true;
    const haystack = `${model.name} ${model.id}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

function formatPerMillion(value: number): string {
  const digits = value < 0.01 ? 4 : value < 1 ? 3 : 2;
  return value.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

/** Human-readable pricing for the picker; informational, not a billing guarantee. */
export function formatModelPrice(model: SelectableModel): string {
  if (model.free) return "Free";
  const parts: string[] = [];
  if (model.promptPricePerMillion !== null) {
    parts.push(`$${formatPerMillion(model.promptPricePerMillion)}/M in`);
  }
  if (model.completionPricePerMillion !== null) {
    parts.push(`$${formatPerMillion(model.completionPricePerMillion)}/M out`);
  }
  if (parts.length > 0) return parts.join(" · ");
  return model.provider === "deepseek" ? "Billed per token" : "Price unavailable";
}

/**
 * Prefer the provider's documented default, then a free model, so a reload
 * never silently selects a paid model when a free one exists.
 */
export function pickDefaultModel(
  models: SelectableModel[],
  preferredId?: string,
): string | undefined {
  if (preferredId) {
    const preferred = models.find((model) => model.id === preferredId);
    if (preferred) return preferred.id;
  }
  return models.find((model) => model.free)?.id ?? models[0]?.id;
}
