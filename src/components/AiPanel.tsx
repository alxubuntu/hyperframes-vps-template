import { useEffect, useRef, useState } from "react";
import { useChat } from "@tanstack/ai-react";
import {
  MAX_GENERATE_ATTEMPTS,
  buildFixMessage,
  stripMarkdownFence,
  type LintError,
} from "../lib/generation";
import { pickDefaultModel, type SelectableModel } from "../lib/models";
import { PROVIDER_IDS, PROVIDERS, type ProviderId } from "../lib/providers";
import { lintComposition, listModels } from "../lib/server-fns";
import { consumeOAuthCallback, startOpenRouterLogin } from "../lib/openrouter-oauth";
import { ModelPicker } from "./ModelPicker";

// The BYOK key is deliberately kept in React state only — never in
// sessionStorage/localStorage. Generated compositions execute in the player's
// iframe with allow-same-origin, so anything in origin storage would be one
// getItem() away from model-generated code. Note this is a bar-raiser, not an
// isolation boundary: same-origin code can still reach window.parent and dig
// the key out of React state or intercept the next request. The real
// blast-radius control is the spend-capped, revocable key. (The OAuth PKCE
// verifier briefly uses sessionStorage across the login redirect — see
// openrouter-oauth.ts for why that's safe.)
interface Hint {
  className: string;
  text: string;
}

interface GenerationRun {
  apiKey: string;
  model: string;
  provider: ProviderId;
  attempts: number;
  startedAt: number;
}

export interface GenerationResult {
  html: string;
  attempts: number;
  lintErrors: LintError[];
}

const EXAMPLE_PROMPTS: Array<{ label: string; prompt: string }> = [
  {
    label: "Startup intro card",
    prompt:
      "A cinematic intro card for a startup called 'Northwind' — deep navy gradient, kinetic typography, the tagline 'we build wind' appears in DM Sans bold, accent in amber.",
  },
  {
    label: "Stats count-up",
    prompt:
      "A punchy stats reveal for a developer tool: three big numbers count up in sequence — '12ms cold starts', '99.99% uptime', '3M requests/day' — dark charcoal background, electric green accents, monospace digits, each stat punches in with a subtle camera shake.",
  },
  {
    label: "Quote reveal",
    prompt:
      "An elegant kinetic-typography quote card: the words 'Simplicity is the ultimate sophistication' appear one word at a time in a large serif face, cream background, ink-black text, a thin gold rule draws itself under the attribution '— Leonardo da Vinci' at the end.",
  },
];

export function AiPanel({ onGenerated }: { onGenerated: (result: GenerationResult) => void }) {
  const [provider, setProvider] = useState<ProviderId>("openrouter");
  const [keys, setKeys] = useState<Record<ProviderId, string>>({ openrouter: "", deepseek: "" });
  const [oauthConnected, setOauthConnected] = useState(false);
  const [showManualKey, setShowManualKey] = useState(false);
  const [models, setModels] = useState<SelectableModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [catalogStatus, setCatalogStatus] = useState<"idle" | "loading" | "ready" | "error">(
    "idle",
  );
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [freeOnly, setFreeOnly] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [hint, setHint] = useState<Hint | null>(null);

  const providerInfo = PROVIDERS[provider];
  const apiKey = keys[provider];

  // Keep the model and key fixed for the initial request and all lint retries.
  const runRef = useRef<GenerationRun | null>(null);

  function updateApiKey(value: string) {
    setKeys((current) => ({ ...current, [provider]: value }));
  }

  // Returning from the OpenRouter consent page: exchange the one-time code
  // for a runtime key. The exchange is memoized in openrouter-oauth.ts, so a
  // second effect run (React strict mode, remount) awaits the same promise
  // and still receives the key even though the one-time code is consumed.
  useEffect(() => {
    let cancelled = false;
    consumeOAuthCallback()
      .then((key) => {
        if (cancelled || !key) return;
        setKeys((current) => ({ ...current, openrouter: key }));
        setProvider("openrouter");
        setOauthConnected(true);
        setHint({
          className: "hint",
          text: "Connected to OpenRouter — describe your video below.",
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setHint({
          className: "hint error",
          text: err instanceof Error ? err.message : "OpenRouter login failed — please try again.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the selected provider's catalog once a key is available. OpenRouter's
  // catalog is public, so its key never leaves the browser for that request;
  // DeepSeek's listing requires auth, so its key is forwarded for that call.
  useEffect(() => {
    const key = apiKey.trim();
    if (!key) {
      setModels([]);
      setSelectedModel("");
      setCatalogStatus("idle");
      setCatalogError(null);
      return;
    }

    let cancelled = false;
    setCatalogStatus("loading");
    setCatalogError(null);
    const timer = setTimeout(() => {
      void listModels({ data: { provider, apiKey: key } })
        .then((result) => {
          if (cancelled) return;
          if (result.ok) {
            setModels(result.models);
            setCatalogStatus("ready");
            return;
          }
          setModels([]);
          setCatalogStatus("error");
          setCatalogError(result.error);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setModels([]);
          setCatalogStatus("error");
          setCatalogError(
            err instanceof Error
              ? err.message
              : `Could not load ${providerInfo.label}'s model list.`,
          );
        });
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [apiKey, provider, providerInfo.label, reloadToken]);

  // Keep the selection valid when the catalog is refreshed or the model is
  // delisted; never silently flip to a paid model when a free one exists.
  useEffect(() => {
    if (models.length === 0) return;
    setSelectedModel((current) => {
      const currentModel = models.find((model) => model.id === current);
      if (currentModel && (!freeOnly || currentModel.free || !providerInfo.hasFreeModels)) {
        return current;
      }
      const candidates =
        freeOnly && providerInfo.hasFreeModels ? models.filter((model) => model.free) : models;
      return pickDefaultModel(candidates, providerInfo.defaultModelId) ?? "";
    });
  }, [models, freeOnly, providerInfo.defaultModelId, providerInfo.hasFreeModels]);

  function handleProviderChange(next: ProviderId) {
    if (next === provider) return;
    setProvider(next);
    setModels([]);
    setSelectedModel("");
    setCatalogStatus("idle");
    setCatalogError(null);
    setFreeOnly(PROVIDERS[next].hasFreeModels);
    setShowManualKey(false);
    setHint(null);
  }

  function handleLogin() {
    setHint({ className: "hint", text: "Redirecting to OpenRouter…" });
    void startOpenRouterLogin();
  }

  function handleDisconnect() {
    setKeys((current) => ({ ...current, openrouter: "" }));
    setOauthConnected(false);
    setModels([]);
    setSelectedModel("");
    setCatalogStatus("idle");
    setCatalogError(null);
    setHint(null);
  }

  function finishGeneration() {
    runRef.current = null;
    setIsGenerating(false);
  }

  // A custom fetcher reads the current generation without recreating the client.
  const { messages, sendMessage, isLoading, error, clear } = useChat({
    fetcher: async ({ messages: history, threadId, runId }, { signal }) => {
      const run = runRef.current;
      if (!run) throw new Error("No active generation.");
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: history,
          threadId,
          runId,
          forwardedProps: {
            apiKey: run.apiKey,
            model: run.model,
            provider: run.provider,
          },
        }),
        signal,
      });
      if (!res.ok) {
        // The library's own non-ok handling throws "HTTP error! status: N"
        // without reading the body, discarding the server's actionable message.
        let message = `Request failed (${res.status})`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          /* non-JSON error body — keep the status message */
        }
        throw new Error(message);
      }
      return res;
    },
    onError: finishGeneration,
    onFinish: (message) => {
      const html = stripMarkdownFence(
        message.parts
          .filter((p) => p.type === "text")
          .map((p) => ("content" in p && typeof p.content === "string" ? p.content : ""))
          .join(""),
      );
      void handleAssistantTurn(html);
    },
  });

  async function handleAssistantTurn(html: string) {
    const run = runRef.current;
    if (!run) return;
    if (!html) {
      setHint({ className: "hint error", text: "The model returned no HTML. Try again." });
      finishGeneration();
      return;
    }

    setHint({ className: "hint", text: "Validating composition…" });
    let errors: LintError[];
    try {
      ({ errors } = await lintComposition({ data: { html } }));
    } catch (err) {
      if (runRef.current !== run) return;
      console.error("lint server fn failed:", err);
      setHint({
        className: "hint warn",
        text: `Validation unavailable (model: ${run.model}) — skipping self-heal. Preview anyway; render may fail.`,
      });
      finishGeneration();
      onGenerated({ html, attempts: run.attempts, lintErrors: [] });
      return;
    }
    if (runRef.current !== run) return;

    if (errors.length > 0 && run.attempts < MAX_GENERATE_ATTEMPTS) {
      run.attempts += 1;
      setHint({
        className: "hint",
        text: `Lint found ${errors.length} error${errors.length > 1 ? "s" : ""} — self-healing (attempt ${run.attempts}/${MAX_GENERATE_ATTEMPTS})…`,
      });
      void sendMessage(buildFixMessage(errors));
      return;
    }

    const secs = ((Date.now() - run.startedAt) / 1000).toFixed(1);
    const { attempts } = run;
    if (errors.length === 0) {
      setHint({
        className: "hint",
        text: `Done in ${secs}s (${attempts} pass${attempts > 1 ? "es" : ""}, model: ${run.model}). Click "Render MP4" to capture.`,
      });
    } else {
      setHint({
        className: "hint warn",
        text: `Generated with ${errors.length} lint error${errors.length > 1 ? "s" : ""} after ${attempts} attempts (model: ${run.model}). Preview anyway — render may fail.`,
      });
    }
    finishGeneration();
    onGenerated({ html, attempts, lintErrors: errors });
  }

  function handleGenerate() {
    if (runRef.current) return;
    const key = apiKey.trim();
    const p = prompt.trim();
    if (!key) {
      setHint({
        className: "hint error",
        text:
          provider === "openrouter"
            ? "Log in with OpenRouter (or paste a key) first."
            : `Enter your ${providerInfo.label} API key first.`,
      });
      return;
    }
    if (!selectedModel) {
      setHint({
        className: "hint error",
        text: `Load the model list and select a ${providerInfo.label} model first.`,
      });
      return;
    }
    if (!p) {
      setHint({ className: "hint error", text: "Add a prompt describing the video." });
      return;
    }
    runRef.current = { apiKey: key, model: selectedModel, provider, attempts: 1, startedAt: Date.now() };
    setIsGenerating(true);
    setHint({ className: "hint", text: "Generating composition — streaming…" });
    clear();
    void sendMessage(p);
  }

  // Live view of the composition streaming in from the model.
  const streamingText = isLoading
    ? (messages.findLast((m) => m.role === "assistant")?.parts ?? [])
        .filter((p) => p.type === "text")
        .map((p) => ("content" in p && typeof p.content === "string" ? p.content : ""))
        .join("")
    : "";

  const hintText = error && !isLoading ? { className: "hint error", text: error.message } : hint;

  return (
    <details className="ai-panel" open>
      <summary>
        Generate from a prompt
        <span className="badge">BYOK</span>
      </summary>
      <div className="ai-body">
        <div className="provider-tabs" role="group" aria-label="AI provider">
          {PROVIDER_IDS.map((id) => (
            <button
              key={id}
              type="button"
              className={`provider-tab${id === provider ? " active" : ""}`}
              aria-pressed={id === provider}
              onClick={() => handleProviderChange(id)}
              disabled={isGenerating}
            >
              {PROVIDERS[id].label}
            </button>
          ))}
        </div>

        {provider === "deepseek" ? (
          <p className="security-note">
            Generate with{" "}
            <a href="https://platform.deepseek.com" target="_blank" rel="noopener noreferrer">
              DeepSeek
            </a>{" "}
            by pasting an API key from{" "}
            <a
              href={providerInfo.keyUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              platform.deepseek.com
            </a>
            .{" "}
            <strong>Your key is forwarded only to {providerInfo.apiHost} and discarded</strong> — this
            server does not log, persist, or cache it. The key is sent to this app&apos;s server for
            each generation and for the model list, because DeepSeek requires authentication to
            list models. In the browser it is held in memory for this tab only and cleared on
            reload — but generated compositions run with same-origin access in the preview, so
            treat the key as reachable by generated code.{" "}
            <strong>Use a spend-limited key and revoke it when done</strong>. DeepSeek has no free
            tier: usage is billed to your key and the picker does not show per-token prices.
          </p>
        ) : (
          <p className="security-note">
            Log in with{" "}
            <a href="https://openrouter.ai" target="_blank" rel="noopener noreferrer">
              OpenRouter
            </a>{" "}
            to mint a key scoped to this app — you can revoke it anytime from your OpenRouter
            dashboard.{" "}
            <strong>Your key is forwarded once to OpenRouter per request and discarded</strong> —
            this worker does not log, persist, or cache it. In the browser it is held in memory for
            this tab only and cleared on reload — but generated compositions run with same-origin
            access in the preview, so treat the key as reachable by generated code. Loading the
            model list asks this app&apos;s server for OpenRouter&apos;s public catalog; your key is
            not sent with that request.{" "}
            <strong>Use a spend-capped key and revoke it when done</strong> — that cap, not where the
            key is stored, is what limits your exposure. Paid models are selected only after you
            uncheck <em>Free only</em>, and their usage is billed to your key.
          </p>
        )}

        {providerInfo.supportsOAuth &&
          (oauthConnected ? (
            <div className="ai-actions">
              <p className="hint">✓ Connected to OpenRouter</p>
              <button type="button" onClick={handleDisconnect} disabled={isGenerating}>
                Disconnect
              </button>
            </div>
          ) : (
            <div className="ai-actions">
              <button type="button" onClick={handleLogin} disabled={isGenerating}>
                Log in with OpenRouter
              </button>
              <button
                type="button"
                className="link-btn"
                onClick={() => setShowManualKey((v) => !v)}
              >
                {showManualKey ? "Hide manual key entry" : "…or paste an API key instead"}
              </button>
            </div>
          ))}

        {(!providerInfo.supportsOAuth || (showManualKey && !oauthConnected)) && (
          <div>
            <label htmlFor="api-key">
              <span className="lbl-detail">{providerInfo.label} API key</span>{" "}
              <a href={providerInfo.keyUrl} target="_blank" rel="noopener noreferrer">
                Get a key
              </a>
            </label>
            <input
              id="api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={providerInfo.keyPlaceholder}
              value={apiKey}
              onChange={(e) => updateApiKey(e.target.value)}
            />
          </div>
        )}

        <div>
          <label htmlFor="model-search">
            <span className="lbl-detail">{providerInfo.label} model</span>
          </label>
          {apiKey.trim() ? (
            <ModelPicker
              inputId="model-search"
              providerLabel={providerInfo.label}
              showFreeOnly={providerInfo.hasFreeModels}
              models={models}
              value={selectedModel}
              onSelect={setSelectedModel}
              freeOnly={freeOnly}
              onFreeOnlyChange={setFreeOnly}
              disabled={isGenerating}
              loading={catalogStatus === "loading"}
              error={catalogStatus === "error" ? catalogError : null}
              onRetry={() => setReloadToken((value) => value + 1)}
            />
          ) : (
            <p className="model-locked">
              Enter your {providerInfo.label} key to load the available models.
            </p>
          )}
          {catalogStatus === "ready" && models.length === 0 && (
            <p className="model-empty">{providerInfo.label} returned no text models.</p>
          )}
        </div>

        <div>
          <label htmlFor="prompt">
            <span className="lbl-detail">Prompt</span> — describe the video you want
          </label>
          <div className="example-prompts">
            <span className="lbl-detail">Try:</span>
            {EXAMPLE_PROMPTS.map((ex) => (
              <button
                key={ex.label}
                type="button"
                className="example-chip"
                disabled={isLoading}
                onClick={() => setPrompt(ex.prompt)}
              >
                {ex.label}
              </button>
            ))}
          </div>
          <textarea
            id="prompt"
            placeholder="e.g. A cinematic intro card for a startup called 'Northwind' — deep navy gradient, kinetic typography, the tagline 'we build wind' appears in DM Sans bold, accent in amber."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>

        <div className="ai-actions">
          <button onClick={handleGenerate} disabled={isGenerating || !selectedModel}>
            Generate composition
          </button>
          {hintText && <p className={hintText.className}>{hintText.text}</p>}
        </div>

        {isLoading && streamingText && (
          <div className="stream-view">
            <pre>{streamingText.slice(-2000)}</pre>
          </div>
        )}
      </div>
    </details>
  );
}
