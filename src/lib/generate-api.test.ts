import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenRouterText } from "@tanstack/ai-openrouter";
import { chat, toServerSentEventsResponse } from "@tanstack/ai";
import type { SelectableOpenRouterModel } from "./openrouter-models";
import { Route } from "../routes/api/generate";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@tanstack/ai-openrouter", () => ({ createOpenRouterText: vi.fn() }));
vi.mock("@tanstack/ai", () => ({ chat: vi.fn(), toServerSentEventsResponse: vi.fn() }));
vi.mock("./server/openrouter-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server/openrouter-catalog")>();
  return { ...actual, resolveRequestedModel: vi.fn() };
});

import { InvalidOpenRouterModelError, resolveRequestedModel } from "./server/openrouter-catalog";

const MODELS: SelectableOpenRouterModel[] = [
  {
    id: "test/free-model:free",
    name: "Free Model",
    free: true,
    promptPricePerMillion: 0,
    completionPricePerMillion: 0,
    contextLength: 128000,
  },
  {
    id: "test/paid-model",
    name: "Paid Model",
    free: false,
    promptPricePerMillion: 1,
    completionPricePerMillion: 2,
    contextLength: 128000,
  },
];

const { POST } = (
  Route as unknown as {
    options: { server: { handlers: { POST: (args: { request: Request }) => Promise<Response> } } };
  }
).options.server.handlers;

function generate(model?: unknown) {
  return POST({
    request: new Request("https://example.test/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Make a video" }],
        forwardedProps: { apiKey: "test-key", model },
      }),
    }),
  });
}

describe("OpenRouter model policy", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("ENABLE_AI_GEN", "true");
    vi.mocked(toServerSentEventsResponse).mockReturnValue(new Response("stream"));
    vi.mocked(resolveRequestedModel).mockImplementation(async (value: unknown) => {
      if (value === undefined) return MODELS[0].id;
      if (typeof value !== "string" || !MODELS.some((model) => model.id === value)) {
        throw new InvalidOpenRouterModelError("unsupported test model");
      }
      return value;
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("uses the first free catalog model when a legacy request omits the model", async () => {
    expect((await generate()).status).toBe(200);
    expect(createOpenRouterText).toHaveBeenCalledExactlyOnceWith(
      "test/free-model:free",
      "test-key",
      expect.any(Object),
    );
  });

  it.each(MODELS)("uses $id when requested", async ({ id }) => {
    expect((await generate(id)).status).toBe(200);
    expect(createOpenRouterText).toHaveBeenCalledExactlyOnceWith(
      id,
      "test-key",
      expect.any(Object),
    );
  });

  it.each([
    "test/unknown",
    "google/gemini-3-flash-preview",
    "unlisted/model:free",
    "openrouter/free",
    "",
    null,
    42,
  ])(
    "rejects an unsupported or malformed model (%s) before creating the adapter",
    async (model) => {
      expect((await generate(model)).status).toBe(400);
      expect(createOpenRouterText).not.toHaveBeenCalled();
      expect(chat).not.toHaveBeenCalled();
    },
  );

  it("keeps a valid explicit model usable when the catalog is unreachable", async () => {
    vi.mocked(resolveRequestedModel).mockImplementation(async (value: unknown) => {
      if (typeof value === "string" && value.includes("/")) return value;
      throw new InvalidOpenRouterModelError("model is required");
    });

    expect((await generate("test/paid-model")).status).toBe(200);
    expect(createOpenRouterText).toHaveBeenCalledExactlyOnceWith(
      "test/paid-model",
      "test-key",
      expect.any(Object),
    );

    vi.mocked(createOpenRouterText).mockClear();
    expect((await generate()).status).toBe(400);
    expect(createOpenRouterText).not.toHaveBeenCalled();
  });

  it("does not switch models on a provider error", async () => {
    vi.mocked(createOpenRouterText).mockImplementation(() => {
      throw new Error("Model unavailable");
    });

    const response = await generate(MODELS[1].id);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Model unavailable"),
    });
    expect(createOpenRouterText).toHaveBeenCalledExactlyOnceWith(
      MODELS[1].id,
      "test-key",
      expect.any(Object),
    );
  });
});
