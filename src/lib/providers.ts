/**
 * Providers this app can generate compositions with. Shared by the browser and
 * the server, so it must stay free of server-only imports and secrets. Keys are
 * always supplied by the user at runtime (BYOK) and are never stored here.
 */
export type ProviderId = "openrouter" | "deepseek";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Placeholder shown in the manual key field. */
  keyPlaceholder: string;
  /** Where the user creates or revokes their key. */
  keyUrl: string;
  /** Host the key is forwarded to for generation. */
  apiHost: string;
  /** Only OpenRouter supports the browser PKCE login flow. */
  supportsOAuth: boolean;
  /** Whether the catalog can contain zero-cost models. */
  hasFreeModels: boolean;
  /** Preferred initial selection when the model exists in the catalog. */
  defaultModelId?: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    keyPlaceholder: "sk-or-v1-...",
    keyUrl: "https://openrouter.ai/keys",
    apiHost: "openrouter.ai",
    supportsOAuth: true,
    hasFreeModels: true,
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    keyPlaceholder: "sk-...",
    keyUrl: "https://platform.deepseek.com/api_keys",
    apiHost: "api.deepseek.com",
    supportsOAuth: false,
    hasFreeModels: false,
    defaultModelId: "deepseek-flash",
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && Object.hasOwn(PROVIDERS, value);
}
