import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenRouterText } from "@tanstack/ai-openrouter";
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible";
import { chat, toServerSentEventsResponse } from "@tanstack/ai";
import { Route } from "../routes/api/generate";
import { DEEPSEEK_BASE_URL } from "./server/deepseek-catalog";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@tanstack/ai-openrouter", () => ({ createOpenRouterText: vi.fn() }));
vi.mock("@tanstack/ai-openai/compatible", () => ({ openaiCompatibleText: vi.fn() }));
vi.mock("@tanstack/ai", () => ({ chat: vi.fn(), toServerSentEventsResponse: vi.fn() }));
vi.mock("./server/model-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./server/model-catalog")>();
  return { ...actual, resolveRequestedModel: vi.fn() };
});

import { InvalidModelError, resolveRequestedModel } from "./server/model-catalog";

const { POST } = (
  Route as unknown as {
    options: { server: { handlers: { POST: (args: { request: Request }) => Promise<Response> } } };
  }
).options.server.handlers;

function generate(forwardedProps: Record<string, unknown> = {}) {
  return POST({
    request: new Request("https://example.test/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Make a video" }],
        forwardedProps: { apiKey: "test-key", ...forwardedProps },
      }),
    }),
  });
}

describe("generation provider policy", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("ENABLE_AI_GEN", "true");
    vi.mocked(toServerSentEventsResponse).mockReturnValue(new Response("stream"));
    vi.mocked(resolveRequestedModel).mockImplementation(async (provider, value: unknown) => {
      if (provider === "openrouter") {
        if (value === undefined) return "test/free-model:free";
        if (value === "test/paid-model") return value;
        throw new InvalidModelError("invalid OpenRouter model id");
      }
      if (value === undefined) return "deepseek-flash";
      if (value === "deepseek-v4-pro") return value;
      throw new InvalidModelError("invalid DeepSeek model id");
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("defaults to OpenRouter when no provider is sent", async () => {
    expect((await generate()).status).toBe(200);
    expect(resolveRequestedModel).toHaveBeenCalledWith("openrouter", undefined, {
      apiKey: "test-key",
    });
    expect(createOpenRouterText).toHaveBeenCalledExactlyOnceWith(
      "test/free-model:free",
      "test-key",
      expect.any(Object),
    );
    expect(openaiCompatibleText).not.toHaveBeenCalled();
  });

  it("uses OpenRouter for an explicit OpenRouter model", async () => {
    expect((await generate({ model: "test/paid-model" })).status).toBe(200);
    expect(createOpenRouterText).toHaveBeenCalledExactlyOnceWith(
      "test/paid-model",
      "test-key",
      expect.any(Object),
    );
  });

  it("builds the OpenAI-compatible adapter pointed at DeepSeek", async () => {
    expect(
      (await generate({ provider: "deepseek", model: "deepseek-v4-pro" })).status,
    ).toBe(200);
    expect(createOpenRouterText).not.toHaveBeenCalled();
    expect(openaiCompatibleText).toHaveBeenCalledExactlyOnceWith("deepseek-v4-pro", {
      name: "deepseek",
      baseURL: DEEPSEEK_BASE_URL,
      apiKey: "test-key",
      api: "chat-completions",
    });
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        modelOptions: expect.objectContaining({ max_tokens: 16000 }),
      }),
    );
  });

  it("sends reasoning-free DeepSeek requests with snake_case token limits", async () => {
    await generate({ provider: "deepseek", model: "deepseek-v4-pro" });
    const options = vi.mocked(chat).mock.calls[0][0] as {
      modelOptions?: Record<string, unknown>;
    };
    expect(options.modelOptions).toMatchObject({
      temperature: 0.7,
      max_tokens: 16000,
      thinking: { type: "disabled" },
    });
    expect(options.modelOptions).not.toHaveProperty("maxCompletionTokens");
  });

  it("rejects an unsupported provider before creating an adapter", async () => {
    const response = await generate({ provider: "anthropic", model: "claude" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "unsupported provider" });
    expect(resolveRequestedModel).not.toHaveBeenCalled();
    expect(createOpenRouterText).not.toHaveBeenCalled();
    expect(openaiCompatibleText).not.toHaveBeenCalled();
  });

  it("rejects a missing or non-string key", async () => {
    for (const apiKey of [undefined, 42, ""]) {
      const response = await generate({ provider: "deepseek", apiKey });
      expect(response.status).toBe(400);
    }
    expect(openaiCompatibleText).not.toHaveBeenCalled();
  });

  it("rejects an invalid model with the provider's message", async () => {
    const response = await generate({ provider: "deepseek", model: "gpt-4o" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("DeepSeek"),
    });
    expect(openaiCompatibleText).not.toHaveBeenCalled();
  });

  it("does not switch models or providers on an adapter error", async () => {
    vi.mocked(openaiCompatibleText).mockImplementation(() => {
      throw new Error("Model unavailable");
    });

    const response = await generate({ provider: "deepseek", model: "deepseek-v4-pro" });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Model unavailable"),
    });
    expect(createOpenRouterText).not.toHaveBeenCalled();
    expect(openaiCompatibleText).toHaveBeenCalledTimes(1);
  });
});
