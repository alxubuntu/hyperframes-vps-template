import { describe, expect, it } from "vitest";
import {
  filterOpenRouterModels,
  formatModelPrice,
  parseOpenRouterCatalog,
  pickDefaultModel,
} from "./openrouter-models";

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
        id: "vendor/free-model:free",
        name: "Free Model",
        free: true,
        promptPricePerMillion: 0,
        completionPricePerMillion: 0,
        contextLength: null,
      },
      {
        id: "vendor/paid-model",
        name: "Paid Model",
        free: false,
        promptPricePerMillion: 1,
        completionPricePerMillion: 2,
        contextLength: 128000,
      },
      {
        id: "vendor/vision-model",
        name: "Vision Model",
        free: false,
        promptPricePerMillion: 0.5,
        completionPricePerMillion: 1.5,
        contextLength: null,
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
        id: "vendor/dup",
        name: "First",
        free: false,
        promptPricePerMillion: null,
        completionPricePerMillion: null,
        contextLength: null,
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

describe("filterOpenRouterModels", () => {
  const models = parseOpenRouterCatalog(payload);

  it("filters free models and matches by id or display name", () => {
    expect(filterOpenRouterModels(models, { freeOnly: true }).map((m) => m.id)).toEqual([
      "vendor/free-model:free",
    ]);
    expect(filterOpenRouterModels(models, { query: "paid" }).map((m) => m.id)).toEqual([
      "vendor/paid-model",
    ]);
    expect(filterOpenRouterModels(models, { query: "vendor/" })).toHaveLength(3);
  });

  it("matches all search tokens in any order, case-insensitively", () => {
    expect(filterOpenRouterModels(models, { query: "MODEL paid" }).map((m) => m.id)).toEqual([
      "vendor/paid-model",
    ]);
    expect(filterOpenRouterModels(models, { query: "paid vision" })).toEqual([]);
  });
});

describe("formatModelPrice", () => {
  const [free, paid, vision] = parseOpenRouterCatalog(payload);

  it("formats free, paid, and unknown prices", () => {
    expect(formatModelPrice(free)).toBe("Free");
    expect(formatModelPrice(paid)).toBe("$1/M in · $2/M out");
    expect(formatModelPrice(vision)).toBe("$0.5/M in · $1.5/M out");
    expect(
      formatModelPrice({
        id: "vendor/unknown",
        name: "Unknown",
        free: false,
        promptPricePerMillion: null,
        completionPricePerMillion: null,
        contextLength: null,
      }),
    ).toBe("Price unavailable");
  });
});

describe("pickDefaultModel", () => {
  it("prefers a free model and falls back to the first entry", () => {
    const models = parseOpenRouterCatalog(payload);
    expect(pickDefaultModel(models)).toBe("vendor/free-model:free");
    expect(pickDefaultModel(models.filter((m) => !m.free))).toBe("vendor/paid-model");
    expect(pickDefaultModel([])).toBeUndefined();
  });
});
