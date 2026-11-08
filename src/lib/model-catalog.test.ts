import { describe, expect, it } from "vitest";
import {
  filterModels,
  formatModelPrice,
  parseDeepSeekCatalog,
  parseOpenRouterCatalog,
  pickDefaultModel,
  type SelectableModel,
} from "./models";

const payload = {
  data: [
    {
      id: "vendor/paid-model",
      name: "Paid Model",
      pricing: { prompt: "0.000001", completion: "0.000002" },
      architecture: { output_modalities: ["text"], modality: "text->text" },
      context_length: 128000,
    },
    {
      id: "vendor/free-model:free",
      name: "Free Model",
      pricing: { prompt: "0", completion: "0" },
      architecture: { output_modalities: ["text"], modality: "text->text" },
    },
    {
      id: "vendor/image-model",
      name: "Image Model",
      pricing: { prompt: "0", completion: "0" },
      architecture: { output_modalities: ["image"], modality: "text->image" },
    },
    {
      id: "vendor/vision-model",
      name: "Vision Model",
      pricing: { prompt: "0.0000005", completion: "0.0000015" },
      architecture: { output_modalities: ["text"], modality: "image+text->text" },
    },
    { id: "", name: "Missing id", architecture: { output_modalities: ["text"] } },
    { id: "vendor/no-architecture", name: "No architecture" },
    null,
    "nope",
  ],
};

describe("parseOpenRouterCatalog", () => {
  it("keeps text-output models and normalizes prices per million tokens", () => {
    expect(parseOpenRouterCatalog(payload)).toEqual([
      {
        provider: "openrouter",
        id: "vendor/free-model:free",
        name: "Free Model",
        free: true,
        promptPricePerMillion: 0,
        completionPricePerMillion: 0,
        contextLength: null,
        maxOutputTokens: null,
      },
      {
        provider: "openrouter",
        id: "vendor/paid-model",
        name: "Paid Model",
        free: false,
        promptPricePerMillion: 1,
        completionPricePerMillion: 2,
        contextLength: 128000,
        maxOutputTokens: null,
      },
      {
        provider: "openrouter",
        id: "vendor/vision-model",
        name: "Vision Model",
        free: false,
        promptPricePerMillion: 0.5,
        completionPricePerMillion: 1.5,
        contextLength: null,
        maxOutputTokens: null,
      },
    ]);
  });

  it("deduplicates ids and treats unknown or negative prices as not free", () => {
    expect(
      parseOpenRouterCatalog({
        data: [
          {
            id: "vendor/dup",
            name: "First",
            pricing: { prompt: "-1", completion: "nope" },
            architecture: { modality: "text->text" },
          },
          {
            id: "vendor/dup",
            name: "Second",
            pricing: { prompt: "0", completion: "0" },
            architecture: { modality: "text->text" },
          },
        ],
      }),
    ).toEqual([
      {
        provider: "openrouter",
        id: "vendor/dup",
        name: "First",
        free: false,
        promptPricePerMillion: null,
        completionPricePerMillion: null,
        contextLength: null,
        maxOutputTokens: null,
      },
    ]);
  });

  it("returns an empty list for malformed payloads", () => {
    expect(parseOpenRouterCatalog(null)).toEqual([]);
    expect(parseOpenRouterCatalog({ data: "no" })).toEqual([]);
  });

  it("rounds binary-float noise and treats blank prices as unknown", () => {
    const models = parseOpenRouterCatalog({
      data: [
        {
          id: "vendor/rounded",
          name: "Rounded",
          pricing: { prompt: "0.0000008", completion: "0.0000016" },
          architecture: { output_modalities: ["text"] },
        },
        {
          id: "vendor/blank-price",
          name: "Blank price",
          pricing: { prompt: " ", completion: "" },
          architecture: { output_modalities: ["text"] },
        },
      ],
    });
    const rounded = models.find((model) => model.id === "vendor/rounded");
    const blank = models.find((model) => model.id === "vendor/blank-price");
    expect(rounded?.promptPricePerMillion).toBe(0.8);
    expect(rounded?.completionPricePerMillion).toBe(1.6);
    expect(blank?.free).toBe(false);
    expect(blank?.promptPricePerMillion).toBeNull();
    expect(blank?.completionPricePerMillion).toBeNull();
  });
});

describe("parseDeepSeekCatalog", () => {
  it("keeps text models, defaults the name to the id, and reads limits", () => {
    expect(
      parseDeepSeekCatalog({
        object: "list",
        data: [
          {
            id: "deepseek-v4-pro",
            object: "model",
            owned_by: "deepseek",
            name: "DeepSeek V4 Pro",
            context_window: 256000,
            max_output_tokens: 64000,
            output_modalities: ["text"],
          },
          {
            id: "deepseek-flash",
            object: "model",
            owned_by: "deepseek",
            context_window: 128000,
            max_output_tokens: 8192,
            output_modalities: ["text"],
          },
          {
            id: "image-only",
            object: "model",
            owned_by: "deepseek",
            output_modalities: ["image"],
          },
          { id: "", name: "Missing id" },
          { id: "deepseek-flash", name: "Duplicate" },
          null,
        ],
      }),
    ).toEqual([
      {
        provider: "deepseek",
        id: "deepseek-flash",
        name: "deepseek-flash",
        free: false,
        promptPricePerMillion: null,
        completionPricePerMillion: null,
        contextLength: 128000,
        maxOutputTokens: 8192,
      },
      {
        provider: "deepseek",
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        free: false,
        promptPricePerMillion: null,
        completionPricePerMillion: null,
        contextLength: 256000,
        maxOutputTokens: 64000,
      },
    ]);
  });

  it("keeps models that do not state output modalities", () => {
    expect(parseDeepSeekCatalog({ data: [{ id: "deepseek-flash" }] })).toEqual([
      {
        provider: "deepseek",
        id: "deepseek-flash",
        name: "deepseek-flash",
        free: false,
        promptPricePerMillion: null,
        completionPricePerMillion: null,
        contextLength: null,
        maxOutputTokens: null,
      },
    ]);
  });

  it("returns an empty list for malformed payloads", () => {
    expect(parseDeepSeekCatalog(null)).toEqual([]);
    expect(parseDeepSeekCatalog({ data: "no" })).toEqual([]);
  });
});

describe("filterModels", () => {
  const models = parseOpenRouterCatalog(payload);

  it("filters free models and matches by id or display name", () => {
    expect(filterModels(models, { freeOnly: true }).map((m) => m.id)).toEqual([
      "vendor/free-model:free",
    ]);
    expect(filterModels(models, { query: "paid" }).map((m) => m.id)).toEqual([
      "vendor/paid-model",
    ]);
    expect(filterModels(models, { query: "vendor/" })).toHaveLength(3);
  });

  it("matches all search tokens in any order, case-insensitively", () => {
    expect(filterModels(models, { query: "MODEL paid" }).map((m) => m.id)).toEqual([
      "vendor/paid-model",
    ]);
    expect(filterModels(models, { query: "paid vision" })).toEqual([]);
  });
});

describe("formatModelPrice", () => {
  const [free, paid, vision] = parseOpenRouterCatalog(payload);
  const deepseek: SelectableModel = {
    provider: "deepseek",
    id: "deepseek-flash",
    name: "DeepSeek Flash",
    free: false,
    promptPricePerMillion: null,
    completionPricePerMillion: null,
    contextLength: null,
    maxOutputTokens: null,
  };

  it("formats free, paid, and unknown prices", () => {
    expect(formatModelPrice(free)).toBe("Free");
    expect(formatModelPrice(paid)).toBe("$1/M in · $2/M out");
    expect(formatModelPrice(vision)).toBe("$0.5/M in · $1.5/M out");
    expect(
      formatModelPrice({
        provider: "openrouter",
        id: "vendor/unknown",
        name: "Unknown",
        free: false,
        promptPricePerMillion: null,
        completionPricePerMillion: null,
        contextLength: null,
        maxOutputTokens: null,
      }),
    ).toBe("Price unavailable");
  });

  it("labels DeepSeek models without published prices as billed per token", () => {
    expect(formatModelPrice(deepseek)).toBe("Billed per token");
  });
});

describe("pickDefaultModel", () => {
  it("prefers a free model and falls back to the first entry", () => {
    const models = parseOpenRouterCatalog(payload);
    expect(pickDefaultModel(models)).toBe("vendor/free-model:free");
    expect(pickDefaultModel(models.filter((m) => !m.free))).toBe("vendor/paid-model");
    expect(pickDefaultModel([])).toBeUndefined();
  });

  it("honours the provider default when it exists in the catalog", () => {
    const models = parseDeepSeekCatalog({
      data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-flash" }],
    });
    expect(pickDefaultModel(models, "deepseek-flash")).toBe("deepseek-flash");
    expect(pickDefaultModel(models, "deepseek-unknown")).toBe("deepseek-flash");
  });
});
