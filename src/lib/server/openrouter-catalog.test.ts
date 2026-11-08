import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rawModel = (
  id: string,
  name: string,
  prompt: string,
  completion: string,
  contextLength = 128000,
) => ({
  id,
  name,
  pricing: { prompt, completion },
  architecture: { output_modalities: ["text"], modality: "text->text" },
  context_length: contextLength,
});

function catalogResponse() {
  return new Response(
    JSON.stringify({
      data: [
        rawModel("vendor/paid-model", "Paid Model", "0.000001", "0.000002"),
        rawModel("vendor/free-model:free", "Free Model", "0", "0"),
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

let fetchMock: ReturnType<typeof vi.fn>;
let now: number;

beforeEach(() => {
  vi.resetModules();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function loadModule() {
  return import("./openrouter-catalog");
}

describe("getOpenRouterCatalog", () => {
  it("fetches and normalizes the public catalog", async () => {
    const mod = await loadModule();
    fetchMock.mockResolvedValueOnce(catalogResponse());

    const models = await mod.getOpenRouterCatalog();

    expect(models.map((model) => model.id)).toEqual([
      "vendor/free-model:free",
      "vendor/paid-model",
    ]);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      mod.CATALOG_URL,
      expect.objectContaining({ headers: expect.objectContaining({ accept: "application/json" }) }),
    );
  });

  it("caches a successful response for five minutes", async () => {
    const mod = await loadModule();
    fetchMock.mockResolvedValue(catalogResponse());

    await mod.getOpenRouterCatalog();
    now += mod.CATALOG_TTL_MS - 1;
    await mod.getOpenRouterCatalog();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent loads into one request", async () => {
    const mod = await loadModule();
    fetchMock.mockResolvedValueOnce(catalogResponse());

    await Promise.all([mod.getOpenRouterCatalog(), mod.getOpenRouterCatalog()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves stale models when a refresh fails", async () => {
    const mod = await loadModule();
    fetchMock.mockResolvedValueOnce(catalogResponse());
    const first = await mod.getOpenRouterCatalog();

    now += mod.CATALOG_TTL_MS + 1;
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const second = await mod.getOpenRouterCatalog();

    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails with a safe message when the first load fails", async () => {
    const mod = await loadModule();
    fetchMock.mockRejectedValueOnce(new Error("offline"));

    await expect(mod.getOpenRouterCatalog()).rejects.toBeInstanceOf(mod.OpenRouterCatalogError);
  });

  it("rejects non-OK responses and invalid JSON", async () => {
    const mod = await loadModule();
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 503 }));
    await expect(mod.getOpenRouterCatalog()).rejects.toThrow("HTTP 503");

    vi.resetModules();
    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 200 }));
    const fresh = await loadModule();
    await expect(fresh.getOpenRouterCatalog()).rejects.toThrow("invalid JSON");
  });
});

describe("resolveRequestedModel", () => {
  it("accepts a known model and defaults to the first free one", async () => {
    const mod = await loadModule();
    fetchMock.mockResolvedValue(catalogResponse());

    await expect(mod.resolveRequestedModel("vendor/paid-model")).resolves.toBe("vendor/paid-model");
    await expect(mod.resolveRequestedModel(undefined)).resolves.toBe("vendor/free-model:free");
  });

  it("rejects unknown and malformed ids when the catalog is available", async () => {
    const mod = await loadModule();
    fetchMock.mockResolvedValue(catalogResponse());

    await expect(mod.resolveRequestedModel("vendor/unknown")).rejects.toBeInstanceOf(
      mod.InvalidOpenRouterModelError,
    );
    for (const value of [null, "", "no-slash", 42, "vendor/space model"]) {
      await expect(mod.resolveRequestedModel(value)).rejects.toBeInstanceOf(
        mod.InvalidOpenRouterModelError,
      );
    }
  });

  it("allows a well-formed id through when the catalog is unreachable", async () => {
    const mod = await loadModule();
    fetchMock.mockRejectedValue(new Error("offline"));

    await expect(mod.resolveRequestedModel("~vendor/paid-model:free")).resolves.toBe(
      "~vendor/paid-model:free",
    );
    await expect(mod.resolveRequestedModel(undefined)).rejects.toBeInstanceOf(
      mod.InvalidOpenRouterModelError,
    );
  });
});
