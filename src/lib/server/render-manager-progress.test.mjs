import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRenderManager } from "./render-jobs.mjs";

test("job reports phase-scoped progress, ignores regression and persists completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "hf-progress-"));
  let report;
  let finish;
  const wait = new Promise((resolve) => { finish = resolve; });
  const manager = createRenderManager({
    projectsDir: join(root, "projects"), tempDir: join(root, "temp"), rendersDir: join(root, "videos"),
    render: async (_project, output, onProgress) => {
      report = onProgress;
      await wait;
      await writeFile(output, "0000ftypisom");
    },
  });
  try {
    const queued = await manager.enqueue([{ path: "index.html", content: Buffer.from('<div data-composition-id="x" data-root="true" data-width="1280" data-height="720" data-duration="1"></div>').toString("base64") }], "html");
    for (let i = 0; i < 100 && !report; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(report);
    report({ phase: "rendering", phaseProgress: 40 });
    report({ phase: "rendering", phaseProgress: 30 });
    const running = await manager.get(queued.id);
    assert.equal(running.phase, "rendering");
    assert.equal(running.phaseProgress, 40);
    assert.ok(running.startedAt && running.lastActivityAt && running.progressUpdatedAt);
    finish();
    let completed;
    for (let i = 0; i < 100; i++) {
      completed = await manager.get(queued.id);
      if (completed.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(completed.status, "completed");
    assert.equal(completed.phaseProgress, 100);
    // Wait for final persistence before inspecting or removing the test directory.
    for (let i = 0; i < 100; i++) {
      const saved = JSON.parse(await readFile(join(root, "videos", "jobs.json"), "utf8"));
      if (saved[0].status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const saved = JSON.parse(await readFile(join(root, "videos", "jobs.json"), "utf8"));
    assert.equal(saved[0].phase, "completed");
  } finally {
    finish();
    await rm(root, { recursive: true, force: true });
  }
});
