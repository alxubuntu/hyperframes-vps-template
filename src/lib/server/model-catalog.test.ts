import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SelectableModel } from "../models";

const deepseekModels: SelectableModel[] = [
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
];

vi.mock("./deepseek-catalog", () => ({
  getDeepSeekCatalog: vi.fn(),
}));
vi.mock("./openrouter-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openrouter-catalog")>();
  return { ...actual, resolveOpenRouterModel: vi.fn() };
});

import { getDeepSeekCatalog } from "./deepseek-catalog";
import { InvalidOpenRouterModelError, resolveOpenRouterModel } from "./openrouter-catalog";
import { InvalidModelError, resolveRequestedModel } from "./model-catalog";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getDeepSeekCatalog).mockResolvedValue(deepseekModels);
});

describe("resolveRequestedModel", () => {
  it("delegates OpenRouter ids and forwards its rejection message", async () => {
    vi.mocked(resolveOpenRouterModel).mockResolvedValue("vendor/model");

    await expect(resolveRequestedModel("openrouter", "vendor/model")).resolves.toBe("vendor/model");
    expect(resolveOpenRouterModel).toHaveBeenCalledWith("vendor/model");

    vi.mocked(resolveOpenRouterModel).mockRejectedValue(
      new InvalidOpenRouterModelError("unknown OpenRouter model"),
    );
    await expect(resolveRequestedModel("openrouter", "vendor/nope")).rejects.toBeInstanceOf(
      InvalidModelError,
    );
  });

  it("defaults DeepSeek to its documented model", async () => {
    await expect(resolveRequestedModel("deepseek", undefined)).resolves.toBe("deepseek-flash");
    expect(getDeepSeekCatalog).not.toHaveBeenCalled();
  });

  it("validates DeepSeek ids against the authenticated catalog", async () => {
    await expect(
      resolveRequestedModel("deepseek", "deepseek-flash", { apiKey: "sk-test" }),
    ).resolves.toBe("deepseek-flash");

    await expect(
      resolveRequestedModel("deepseek", "deepseek-unknown", { apiKey: "sk-test" }),
    ).rejects.toThrow(/unknown DeepSeek model/);
  });

  it("rejects malformed or cross-provider ids", async () => {
    for (const value of ["vendor/model", "deepseek-flash/extra", "", 42, null, "has space"]) {
      await expect(resolveRequestedModel("deepseek", value)).rejects.toBeInstanceOf(
        InvalidModelError,
      );
    }
  });

  it("accepts a well-formed id when the catalog is unavailable", async () => {
    vi.mocked(getDeepSeekCatalog).mockRejectedValue(new Error("offline"));

    await expect(
      resolveRequestedModel("deepseek", "deepseek-v4-pro", { apiKey: "sk-test" }),
    ).resolves.toBe("deepseek-v4-pro");
  });
});
