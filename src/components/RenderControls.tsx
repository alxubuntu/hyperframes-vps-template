import { useEffect, useRef, useState } from "react";

type Hint = { kind: "link"; url: string } | { kind: "message"; className: string; text: string };
type SavedRender = { id: string; completedAt: string; videoUrl: string; fileName: string };

type RenderJob = { status: string; videoUrl?: string; error?: string; phase?: string; phaseProgress?: number | null; startedAt?: string | null; lastActivityAt?: string | null; progressUpdatedAt?: string | null };

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
  const [job, setJob] = useState<RenderJob | null>(null);
  const [clock, setClock] = useState(Date.now());
  const request = useRef<AbortController | null>(null);

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
    return () => request.current?.abort();
  }, []);

  useEffect(() => {
    if (!rendering) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [rendering]);

  async function handleRender() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setJob(null);
    setRendering(true);
    setHint({
      kind: "message",
      className: "hint",
      text: "Render queued. You can keep using the app while it runs.",
    });

    try {
      const init: RequestInit = { method: "POST", signal: controller.signal };
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
      while (!controller.signal.aborted) {
        const statusResponse = await fetch(accepted.statusUrl, { signal: controller.signal, cache: "no-store" });
        if (!statusResponse.ok) throw new Error(statusResponse.status === 401 ? "Session expired. Sign in again to check the render." : `Could not check render status (${statusResponse.status})`);
        const current = (await statusResponse.json()) as RenderJob;
        if (controller.signal.aborted) return;
        setJob(current);
        if (current.status === "completed" && current.videoUrl) {
          setHint({ kind: "link", url: current.videoUrl });
          void refreshRenders();
          return;
        }
        if (current.status === "failed") throw new Error(current.error || "Render failed");
        setHint(null);
        await new Promise<void>((resolve) => {
          const finish = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", finish); resolve(); };
          const timer = setTimeout(finish, 2000);
          controller.signal.addEventListener("abort", finish, { once: true });
        });
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setHint({
        kind: "message",
        className: "hint error",
        text: err instanceof Error ? err.message : "Render failed",
      });
    } finally {
      if (!controller.signal.aborted) setRendering(false);
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
      {rendering && job && (
        <div className="hint" aria-live="polite">
          <p>{job.status === "queued" ? "Render queued" : ({ preparing: "Preparing", rendering: "Rendering frames", encoding: "Encoding", finalizing: "Finalizing" } as Record<string, string>)[job.phase ?? ""] ?? "Render running"}
            {job.phaseProgress != null ? `: ${job.phaseProgress}%` : "…"}</p>
          {job.phaseProgress != null && <progress max={100} value={job.phaseProgress} />}
          {job.startedAt && <p>Elapsed: {Math.max(0, Math.floor((clock - Date.parse(job.startedAt)) / 1000))}s</p>}
          {job.progressUpdatedAt && <p>No progress signal for {Math.max(0, Math.floor((clock - Date.parse(job.progressUpdatedAt)) / 1000))}s</p>}
          {job.lastActivityAt && <p>Last activity: {Math.max(0, Math.floor((clock - Date.parse(job.lastActivityAt)) / 1000))}s ago</p>}
        </div>
      )}
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
