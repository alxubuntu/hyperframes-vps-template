import { useEffect, useState } from "react";

type Hint = { kind: "link"; url: string } | { kind: "message"; className: string; text: string };
type SavedRender = { id: string; completedAt: string; videoUrl: string; fileName: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function RenderControls({
  generatedHtml,
  onReset,
}: {
  generatedHtml: string | null;
  onReset: () => void;
}) {
  const [rendering, setRendering] = useState(false);
  const [hint, setHint] = useState<Hint | null>(null);
  const [renders, setRenders] = useState<SavedRender[]>([]);

  async function refreshRenders() {
    try {
      const response = await fetch("/api/renders");
      if (response.ok) setRenders((await response.json()) as SavedRender[]);
    } catch {
      // Render history is best-effort; new render requests still work.
    }
  }

  useEffect(() => {
    void refreshRenders();
  }, []);

  async function handleRender() {
    setRendering(true);
    setHint({
      kind: "message",
      className: "hint",
      text: "Render queued. You can keep using the app while it runs.",
    });

    try {
      const init: RequestInit = { method: "POST" };
      if (generatedHtml) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify({ html: generatedHtml });
      }
      const res = await fetch("/api/render", init);
      if (!res.ok) {
        const raw = await res.text();
        let message = raw || `Render failed (${res.status})`;
        try {
          // /api/render errors are {"error": "..."} — show the message, not the envelope.
          const parsed = JSON.parse(raw) as { error?: string };
          if (parsed.error) message = parsed.error;
        } catch {
          /* non-JSON error body — show as-is */
        }
        throw new Error(message);
      }
      const accepted = (await res.json()) as { id: string; statusUrl: string };
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        await sleep(1500);
        const statusResponse = await fetch(accepted.statusUrl);
        if (!statusResponse.ok) throw new Error(`Could not check render status (${statusResponse.status})`);
        const job = (await statusResponse.json()) as { status: string; videoUrl?: string; error?: string };
        if (job.status === "completed" && job.videoUrl) {
          setHint({ kind: "link", url: job.videoUrl });
          void refreshRenders();
          return;
        }
        if (job.status === "failed") throw new Error(job.error || "Render failed");
        setHint({
          kind: "message",
          className: "hint",
          text: job.status === "queued" ? "Render queued…" : "Rendering MP4…",
        });
      }
      throw new Error("Render is still running. Reload the page to check saved renders.");
    } catch (err) {
      setHint({
        kind: "message",
        className: "hint error",
        text: err instanceof Error ? err.message : "Render failed",
      });
    } finally {
      setRendering(false);
    }
  }

  return (
    <section className="controls">
      <button onClick={handleRender} disabled={rendering}>
        Render MP4
      </button>
      {generatedHtml && (
        <button
          className="secondary"
          onClick={() => {
            setHint(null);
            onReset();
          }}
        >
          Reset to bundled composition
        </button>
      )}
      {hint &&
        (hint.kind === "link" ? (
          <p className="hint">
            Done —{" "}
            <a href={hint.url} target="_blank" rel="noopener noreferrer">
              open MP4
            </a>
          </p>
        ) : (
          <p className={hint.className}>{hint.text}</p>
        ))}
      {renders.length > 0 && (
        <div className="render-history" aria-live="polite">
          <h2>Saved videos</h2>
          <ul>
            {renders.map((render) => (
              <li key={render.id}>
                <a href={render.videoUrl} target="_blank" rel="noopener noreferrer">
                  {new Date(render.completedAt).toLocaleString()} — play
                </a>
                {" · "}
                <a href={`${render.videoUrl}?download=1`} download={render.fileName}>
                  download MP4
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
