import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function catalogResponse() {
  return new Response(
    JSON.stringify({
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
        { id: "deepseek-flash", object: "model", owned_by: "deepseek" },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const API_KEY = "sk-test-key";

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
  return import("./deepseek-catalog");
}

describe("getDeepSeekCatalog", () => {
  it("authenticates, normalizes, and sorts the catalog by id", async () => {
    const mod = await loadModule();
    fetchMock.mockResolvedValueOnce(catalogResponse());

    const models = await mod.getDeepSeekCatalog(API_KEY);

    expect(models.map((model) => model.id)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(models.every((model) => model.provider === "deepseek" && !model.free)).toBe(true);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      mod.DEEPSEEK_MODELS_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          accept: "application/json",
          authorization: `Bearer ${API_KEY}`,
        }),
      }),
    );
  });

  it("caches a successful response for five minutes", async () => {
    const mod = await loadModule();
    fetchMock.mockResolvedValue(catalogResponse());

    await mod.getDeepSeekCatalog(API_KEY);
    now += mod.DEEPSEEK_CATALOG_TTL_MS - 1;
    await mod.getDeepSeekCatalog(API_KEY);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent loads into one request", async () => {
    const mod = await loadModule();
    fetchMock.mockResolvedValueOnce(catalogResponse());

    await Promise.all([mod.getDeepSeekCatalog(API_KEY), mod.getDeepSeekCatalog(API_KEY)]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves stale models when a refresh fails", async () => {
    const mod = await loadModule();
    fetchMock.mockResolvedValueOnce(catalogResponse());
    const first = await mod.getDeepSeekCatalog(API_KEY);

    now += mod.DEEPSEEK_CATALOG_TTL_MS + 1;
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    const second = await mod.getDeepSeekCatalog(API_KEY);

    expect(second).toEqual(first);
  });

  it("still reports a rejected key when a list is cached", async () => {
    const mod = await loadModule();
    fetchMock.mockResolvedValueOnce(catalogResponse());
    await mod.getDeepSeekCatalog(API_KEY);

    now += mod.DEEPSEEK_CATALOG_TTL_MS + 1;
    fetchMock.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));

    await expect(mod.getDeepSeekCatalog("sk-revoked")).rejects.toBeInstanceOf(mod.DeepSeekAuthError);
  });

  it("reports a rejected key without echoing it", async () => {
    const mod = await loadModule();
    fetchMock.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));

    const error = await mod.getDeepSeekCatalog(API_KEY).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(mod.DeepSeekAuthError);
    expect((error as Error).message).toContain("platform.deepseek.com");
    expect((error as Error).message).not.toContain(API_KEY);
  });

  it("does not cache failures", async () => {
    const mod = await loadModule();
    fetchMock.mockRejectedValueOnce(new Error("offline"));

    await expect(mod.getDeepSeekCatalog(API_KEY)).rejects.toBeInstanceOf(mod.DeepSeekCatalogError);

    fetchMock.mockResolvedValueOnce(catalogResponse());
    await expect(mod.getDeepSeekCatalog(API_KEY)).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects non-OK responses and invalid JSON", async () => {
    const mod = await loadModule();
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 503 }));
    await expect(mod.getDeepSeekCatalog(API_KEY)).rejects.toThrow("HTTP 503");

    vi.resetModules();
    const fresh = await loadModule();
    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 200 }));
    await expect(fresh.getDeepSeekCatalog(API_KEY)).rejects.toThrow("invalid JSON");
  });
});
