import { createFileRoute } from "@tanstack/react-router";
import { chat, toServerSentEventsResponse, type AnyTextAdapter } from "@tanstack/ai";
import { createOpenRouterText } from "@tanstack/ai-openrouter";
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible";

type OpenRouterModel = Parameters<typeof createOpenRouterText>[0];
import { SYSTEM_PROMPT_WITH_EXAMPLE, buildUserPrompt } from "../../lib/hyperframes-skill";
import { InvalidModelError, resolveRequestedModel } from "../../lib/server/model-catalog";
import { DEEPSEEK_BASE_URL } from "../../lib/server/deepseek-catalog";
import { isProviderId, PROVIDERS, type ProviderId } from "../../lib/providers";
import { isJsonRequest, jsonError, msg, utf8ByteLength } from "../../lib/server/assets";

const MAX_PROMPT_BYTES = 8 * 1024;
const MAX_KEY_BYTES = 1024;
const MAX_OUTPUT_TOKENS = 16000;
// DeepSeek streams `reasoning_content` before the answer when thinking is on.
// The composition prompt is already prescriptive, so thinking is disabled for
// predictable latency and cost; flip this to "enabled" to opt back in.
const DEEPSEEK_THINKING = { type: "disabled" } as const;
// durationSec is only a prompt hint, but an absurd value could steer the
// model toward a very long composition that inflates render time/cost.
const MAX_DURATION_SEC = 120;

interface GenerateRequestBody {
  messages?: Array<Record<string, unknown>>;
  forwardedProps?: {
    apiKey?: unknown;
    model?: unknown;
    provider?: unknown;
    durationSec?: unknown;
  };
}

/**
 * Wrap the first user message (the raw prompt from the panel) in the
 * HyperFrames task template. Later user turns are lint-fix requests and pass
 * through untouched, as does everything the model said.
 */
function wrapFirstUserMessage(
  messages: Array<Record<string, unknown>>,
  durationSec: number | undefined,
): Array<Record<string, unknown>> {
  let wrapped = false;
  return messages.map((m) => {
    if (wrapped || m.role !== "user") return m;
    wrapped = true;
    if (typeof m.content === "string") {
      return { ...m, content: buildUserPrompt(m.content, durationSec) };
    }
    if (Array.isArray(m.parts)) {
      return {
        ...m,
        parts: m.parts.map((p: Record<string, unknown>) =>
          p.type === "text" && typeof p.content === "string"
            ? { ...p, content: buildUserPrompt(p.content, durationSec) }
            : p,
        ),
      };
    }
    return m;
  });
}

function createAdapter(
  provider: ProviderId,
  model: string,
  apiKey: string,
  origin: string,
): AnyTextAdapter {
  if (provider === "deepseek") {
    return openaiCompatibleText(model, {
      name: "deepseek",
      baseURL: DEEPSEEK_BASE_URL,
      apiKey,
      api: "chat-completions",
    }) as AnyTextAdapter;
  }

  return createOpenRouterText(model as OpenRouterModel, apiKey, {
    httpReferer: origin,
    appTitle: "HyperFrames VPS Template",
  }) as AnyTextAdapter;
}

export const Route = createFileRoute("/api/generate")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (process.env.ENABLE_AI_GEN !== "true") {
          return jsonError(
            'AI generation is disabled. Set ENABLE_AI_GEN="true" in your .env file to enable BYOK generation.',
            403,
          );
        }

        if (!isJsonRequest(request)) {
          return jsonError("expected application/json", 415);
        }

        let body: GenerateRequestBody;
        try {
          body = (await request.json()) as GenerateRequestBody;
        } catch {
          return jsonError("invalid JSON body", 400);
        }

        const props = body.forwardedProps ?? {};
        const provider = props.provider === undefined ? "openrouter" : props.provider;
        if (!isProviderId(provider)) {
          return jsonError("unsupported provider", 400);
        }

        const apiKey = props.apiKey;
        if (!apiKey || typeof apiKey !== "string") {
          return jsonError(`missing apiKey (your ${PROVIDERS[provider].label} key)`, 400);
        }
        if (apiKey.length > MAX_KEY_BYTES) {
          return jsonError("apiKey too long", 400);
        }

        let model: string;
        try {
          model = await resolveRequestedModel(provider, props.model, { apiKey });
        } catch (err) {
          if (err instanceof InvalidModelError) {
            return jsonError(err.message, 400);
          }
          return jsonError(`could not resolve a ${PROVIDERS[provider].label} model`, 400);
        }

        const messages = body.messages;
        if (!Array.isArray(messages) || messages.length === 0) {
          return jsonError("missing messages", 400);
        }
        for (const m of messages) {
          if (m.role !== "user" && m.role !== "assistant") {
            return jsonError("invalid message role", 400);
          }
          if (m.role !== "user") continue;
          const text =
            typeof m.content === "string"
              ? m.content
              : Array.isArray(m.parts)
                ? m.parts
                    .map((p: Record<string, unknown>) =>
                      typeof p.content === "string" ? p.content : "",
                    )
                    .join("")
                : "";
          if (utf8ByteLength(text) > MAX_PROMPT_BYTES) {
            return jsonError(`prompt exceeds ${MAX_PROMPT_BYTES} bytes`, 413);
          }
        }

        const durationSec =
          typeof props.durationSec === "number" &&
          Number.isFinite(props.durationSec) &&
          props.durationSec > 0
            ? Math.min(props.durationSec, MAX_DURATION_SEC)
            : undefined;

        // Fix turns (any conversation with more than one user message) run
        // cooler than the initial creative pass.
        const userTurns = messages.filter((m) => m.role === "user").length;
        const temperature = userTurns > 1 ? 0.3 : 0.7;

        try {
          // The validated IDs can be newer than the installed adapter's model union.
          // The user's key is used for this one upstream call and never stored.
          const adapter = createAdapter(
            provider,
            model,
            apiKey,
            request.headers.get("origin") ?? new URL(request.url).origin,
          );
          // The OpenAI-compatible adapter spreads modelOptions straight into the
          // request body, so DeepSeek needs its snake_case field name there.
          const modelOptions =
            provider === "deepseek"
              ? {
                  temperature,
                  max_tokens: MAX_OUTPUT_TOKENS,
                  thinking: DEEPSEEK_THINKING,
                }
              : { temperature, maxCompletionTokens: MAX_OUTPUT_TOKENS };

          const stream = chat({
            adapter,
            messages: wrapFirstUserMessage(messages, durationSec) as Parameters<
              typeof chat
            >[0]["messages"],
            systemPrompts: [SYSTEM_PROMPT_WITH_EXAMPLE],
            modelOptions,
          });

          return toServerSentEventsResponse(stream);
        } catch (err) {
          return jsonError(`generation failed: ${msg(err)}`, 500);
        }
      },
    },
  },
});
