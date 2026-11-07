import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenRouterText } from "@tanstack/ai-openrouter";
import { chat, toServerSentEventsResponse } from "@tanstack/ai";
import { DEFAULT_MODEL, FREE_OPENROUTER_MODELS } from "./generation";
import { Route } from "../routes/api/generate";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@tanstack/ai-openrouter", () => ({ createOpenRouterText: vi.fn() }));
vi.mock("@tanstack/ai", () => ({ chat: vi.fn(), toServerSentEventsResponse: vi.fn() }));

const { POST } = (Route as unknown as {
  options: { server: { handlers: { POST: (args: { request: Request }) => Promise<Response> } } };
}).options.server.handlers;

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
  });

  afterEach(() => vi.unstubAllEnvs());

  it("uses the free default when a legacy request omits the model", async () => {
    expect((await generate()).status).toBe(200);
    expect(createOpenRouterText).toHaveBeenCalledExactlyOnceWith(DEFAULT_MODEL, "test-key", expect.any(Object));
  });

  it.each(FREE_OPENROUTER_MODELS)("uses $id when requested", async ({ id }) => {
    expect((await generate(id)).status).toBe(200);
    expect(createOpenRouterText).toHaveBeenCalledExactlyOnceWith(id, "test-key", expect.any(Object));
  });

  it.each(["google/gemini-3-flash-preview", "unlisted/model:free", "openrouter/free", "", null, 42])(
    "rejects an unsupported or malformed model (%s) before creating the adapter",
    async (model) => {
      expect((await generate(model)).status).toBe(400);
      expect(createOpenRouterText).not.toHaveBeenCalled();
      expect(chat).not.toHaveBeenCalled();
    },
  );

  it("does not switch models on a provider error", async () => {
    const { id } = FREE_OPENROUTER_MODELS[1];
    vi.mocked(createOpenRouterText).mockImplementation(() => {
      throw new Error("Model unavailable");
    });

    const response = await generate(id);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("Model unavailable") });
    expect(createOpenRouterText).toHaveBeenCalledExactlyOnceWith(id, "test-key", expect.any(Object));
  });
});
