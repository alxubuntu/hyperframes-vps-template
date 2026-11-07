import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRenderManager } from "./render-jobs.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoots() {
  const root = await mkdtemp(join(tmpdir(), "hyperframes-jobs-test-"));
  roots.push(root);
  return {
    root,
    projectsDir: join(root, "projects"),
    tempDir: join(root, "temp"),
    rendersDir: join(root, "renders"),
  };
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("render job did not reach a terminal state");
}

describe("local render jobs", () => {
  it("queues a render, persists its MP4 and metadata, and restores completed jobs", async () => {
    const roots = await makeRoots();
    const manager = createRenderManager({
      ...roots,
      render: async (_projectDir, outputPath) => {
        await writeFile(outputPath, new TextEncoder().encode("0000ftypisom"));
      },
    });

    const queued = await manager.enqueue(
      [{ path: "index.html", content: btoa("<html/>") }],
      "html",
    );
    expect(queued.status).toBe("queued");

    const completed = await waitFor(() => manager.get(queued.id), (job) => job?.status === "completed");
    expect(completed?.videoUrl).toBe(`/r/${queued.id}`);
    expect(await readFile(join(roots.rendersDir, `${queued.id}.mp4`))).toEqual(
      new TextEncoder().encode("0000ftypisom"),
    );

    const restored = createRenderManager({ ...roots, render: async () => {} });
    expect(await restored.get(queued.id)).toMatchObject({ id: queued.id, status: "completed" });
    expect(await readFile(join(roots.rendersDir, "jobs.json"), "utf8")).toContain(queued.id);
  });

  it("stages the MP4 in the renders directory before finalizing it", async () => {
    const roots = await makeRoots();
    let outputPath = "";
    const manager = createRenderManager({
      ...roots,
      render: async (_projectDir, path) => {
        outputPath = path;
        await writeFile(path, new TextEncoder().encode("0000ftypisom"));
      },
    });

    const queued = await manager.enqueue(
      [{ path: "index.html", content: btoa("<html/>") }],
      "html",
    );
    await waitFor(() => manager.get(queued.id), (job) => job?.status === "completed");

    expect(outputPath).toBe(join(roots.rendersDir, `${queued.id}.tmp.mp4`));
    expect(await readFile(join(roots.rendersDir, `${queued.id}.mp4`), "utf8")).toBe("0000ftypisom");
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans the staged MP4 when rendering fails", async () => {
    const roots = await makeRoots();
    let outputPath = "";
    const manager = createRenderManager({
      ...roots,
      render: async (_projectDir, path) => {
        outputPath = path;
        await writeFile(path, "partial");
        throw new Error("renderer failed");
      },
    });

    const queued = await manager.enqueue(
      [{ path: "index.html", content: btoa("<html/>") }],
      "html",
    );
    const failed = await waitFor(() => manager.get(queued.id), (job) => job?.status === "failed");

    expect(failed?.error).toContain("renderer failed");
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(roots.rendersDir, `${queued.id}.mp4`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects project file paths that escape the persistent projects directory", async () => {
    const roots = await makeRoots();
    const manager = createRenderManager({ ...roots, render: async () => {} });

    await expect(
      manager.enqueue([{ path: "../outside.html", content: btoa("x") }], "html"),
    ).rejects.toThrow(/invalid file path/i);
  });

  it("rewrites the template's public CDN asset URLs to local files before rendering", async () => {
    const roots = await makeRoots();
    let renderedHtml = "";
    const manager = createRenderManager({
      ...roots,
      render: async (projectDir, outputPath) => {
        renderedHtml = await readFile(join(projectDir, "index.html"), "utf8");
        await writeFile(outputPath, new TextEncoder().encode("0000ftypisom"));
      },
    });

    const queued = await manager.enqueue(
      [{
        path: "index.html",
        content: btoa('<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script><script src="/_hyperframes/hyperframe.runtime.iife.js"></script>'),
      }],
      "html",
    );
    await waitFor(() => manager.get(queued.id), (job) => job?.status === "completed");
    expect(renderedHtml).toContain('src="assets/gsap.min.js"');
    expect(renderedHtml).toContain('src="assets/hyperframe.runtime.iife.js"');
    expect(renderedHtml).not.toContain("cdn.jsdelivr.net");
  });

  it("marks interrupted jobs failed after a process restart instead of leaving them running", async () => {
    const roots = await makeRoots();
    await Promise.all([roots.projectsDir, roots.tempDir, roots.rendersDir].map((path) => mkdir(path, { recursive: true })));
    await writeFile(
      join(roots.rendersDir, "jobs.json"),
      JSON.stringify([{
        id: "123e4567-e89b-42d3-a456-426614174000",
        source: "html",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
      }]),
    );

    const manager = createRenderManager({ ...roots, render: async () => {} });
    await expect(manager.get("123e4567-e89b-42d3-a456-426614174000")).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("server restarted"),
    });
  });

  it("recovers an MP4 when the process stopped after writing the video but before recording completion", async () => {
    const roots = await makeRoots();
    await Promise.all([roots.projectsDir, roots.tempDir, roots.rendersDir].map((path) => mkdir(path, { recursive: true })));
    const id = "123e4567-e89b-42d3-a456-426614174001";
    await writeFile(join(roots.rendersDir, `${id}.mp4`), new TextEncoder().encode("0000ftypisom"));
    await writeFile(
      join(roots.rendersDir, "jobs.json"),
      JSON.stringify([{ id, source: "html", status: "running", createdAt: "2026-01-01T00:00:00.000Z" }]),
    );

    const manager = createRenderManager({ ...roots, render: async () => {} });
    await expect(manager.get(id)).resolves.toMatchObject({ status: "completed", videoUrl: `/r/${id}` });
  });
});
