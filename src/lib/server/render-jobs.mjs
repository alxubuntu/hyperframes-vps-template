import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { PreflightError, preflight } from "./preflight.mjs";
import { createProgressParser } from "./render-progress.mjs";

const MAX_FILES = 2_000;
const REQUEST_BYTES =
  Number.parseInt(process.env.MAX_REQUEST_BYTES ?? "", 10) || 64 * 1024 * 1024;
// Base64 inflates a payload by 4/3, so a request can never carry more than 0.75
// of its bytes as decoded composition. Derive the default from the request cap
// instead of hard-coding a number the body limit can never reach.
const MAX_FILES_BYTES =
  Number.parseInt(process.env.MAX_COMPOSITION_BYTES ?? "", 10) || Math.floor(REQUEST_BYTES * 0.75);
const MAX_ERROR_CHARS = 16_000;
// strict: reject an invalid composition. warn: accept it but report the issues.
// off: skip validation entirely. Only an operator changes this, never a request.
const PREFLIGHT_MODE = process.env.PREFLIGHT_MODE || "strict";
const DEFAULT_RENDER_TIMEOUT_MS = 10 * 60 * 1_000;

function inside(root, candidate) {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  return absoluteCandidate.startsWith(`${absoluteRoot}${sep}`);
}

function assertSafePath(relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    relativePath.startsWith("/") ||
    relativePath.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`invalid file path: ${String(relativePath).slice(0, 80)}`);
  }
}

function safeJoin(root, relativePath) {
  assertSafePath(relativePath);
  const target = resolve(root, relativePath);
  if (!inside(root, target)) throw new Error("invalid file path");
  return target;
}

// A nested quantifier like (?:[A-Za-z0-9+/]{4})* recurses per group and
// overflows V8's stack on a multi-megabyte string, so validation stays linear.
const BASE64_BODY = /^[A-Za-z0-9+/]*$/;

function assertBase64(value, path) {
  const body = value.endsWith("==") ? value.slice(0, -2) : value.endsWith("=") ? value.slice(0, -1) : value;
  if (value.length % 4 !== 0 || !BASE64_BODY.test(body)) {
    throw new Error(`invalid base64 content for ${path}`);
  }
}

function runPreflight(files) {
  if (PREFLIGHT_MODE === "off") return { ok: true, issues: [], warnings: [] };
  const verdict = preflight(files);
  if (!verdict.ok && PREFLIGHT_MODE !== "warn") {
    throw new PreflightError(verdict.issues, verdict.warnings);
  }
  return verdict;
}

/** Validate without queueing: backs POST /api/render?dryRun=1. */
export async function checkRender(files) {
  return preflight(validateFiles(files));
}

function validateFiles(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) {
    throw new Error(`files must contain between 1 and ${MAX_FILES} items`);
  }
  let totalBytes = 0;
  const validated = files.map((file) => {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") {
      throw new Error("each file must have a path and base64 content");
    }
    // Reject an unsafe path at enqueue time so the caller gets a 400 instead of
    // a queued job that fails later inside the render sandbox.
    assertSafePath(file.path);
    assertBase64(file.content, file.path);
    const bytes = Buffer.from(file.content, "base64");
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_FILES_BYTES) throw new Error(`composition exceeds ${MAX_FILES_BYTES} bytes`);
    return { path: file.path, bytes };
  });
  return validated;
}

async function localizeRendererDependencies(files) {
  const names = ["gsap.min.js", "hyperframe.runtime.iife.js"];
  const localized = files.map(({ path, bytes }) => {
    if (!path.toLowerCase().endsWith(".html")) return { path, bytes };
    const html = bytes.toString("utf8")
      .replace(/(?:https:\/\/cdn\.jsdelivr\.net\/npm\/gsap@[^/]+\/dist\/gsap\.min\.js|\/_hyperframes\/gsap\.min\.js)/g, "assets/gsap.min.js")
      .replace(/(?:https:\/\/cdn\.jsdelivr\.net\/npm\/@hyperframes\/core\/dist\/hyperframe\.runtime\.iife\.js|\/_hyperframes\/hyperframe\.runtime\.iife\.js)/g, "assets/hyperframe.runtime.iife.js");
    return { path, bytes: Buffer.from(html, "utf8") };
  });
  const present = new Set(localized.map((file) => file.path));
  for (const name of names) {
    const path = `assets/${name}`;
    if (present.has(path)) continue;
    try {
      const bytes = await readFile(resolve(process.cwd(), "public", "_hyperframes", name));
      localized.push({ path, bytes });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return localized;
}

function readEnvPath(name, fallback) {
  return process.env[name] || fallback;
}

async function hasValidMp4(filePath) {
  try {
    const details = await stat(filePath);
    if (details.size < 12) return false;
    const video = await open(filePath, "r");
    const header = Buffer.alloc(12);
    try {
      const { bytesRead } = await video.read(header, 0, header.length, 0);
      return bytesRead === header.length && header.subarray(4, 8).toString("ascii") === "ftyp";
    } finally {
      await video.close();
    }
  } catch {
    return false;
  }
}

export function createRenderManager(options = {}) {
  const projectsDir = resolve(options.projectsDir || readEnvPath("PROJECTS_DIR", "./data/projects"));
  const tempDir = resolve(options.tempDir || readEnvPath("RENDER_TEMP_DIR", "./data/temp"));
  const rendersDir = resolve(options.rendersDir || readEnvPath("RENDERS_DIR", "./data/videos"));
  const jobsFile = join(rendersDir, "jobs.json");
  const configuredConcurrency = Number(options.concurrency || process.env.RENDER_CONCURRENCY || 1);
  const maxConcurrent = Number.isFinite(configuredConcurrency)
    ? Math.max(1, Math.min(4, configuredConcurrency))
    : 1;
  const jobs = new Map();
  const queue = [];
  let active = 0;
  let saveTail = Promise.resolve();
  let initPromise;
  const progressTimers = new Map();

  function scheduleProgressSave(id) {
    if (progressTimers.has(id)) return;
    const timer = setTimeout(() => {
      progressTimers.delete(id);
      void persist().catch((error) => console.error("Could not save render progress", error));
    }, 2000);
    timer.unref();
    progressTimers.set(id, timer);
  }

  function cancelProgressSave(id) {
    const timer = progressTimers.get(id);
    if (timer) clearTimeout(timer);
    progressTimers.delete(id);
  }

  function updateProgress(job, event = {}) {
    if (job.status !== "running") return;
    const now = new Date().toISOString();
    job.lastActivityAt = now;
    const phases = ["preparing", "unknown", "rendering", "encoding", "finalizing"];
    const next = event.phase;
    let advanced = false;
    if (phases.includes(next) && (phases.indexOf(next) > phases.indexOf(job.phase) || (job.phase === "unknown" && next === "preparing"))) {
      job.phase = next;
      job.phaseProgress = null;
      advanced = true;
    }
    if (next === job.phase && Number.isFinite(event.phaseProgress) && event.phaseProgress >= 0 && event.phaseProgress <= 100 &&
        (job.phaseProgress === null || event.phaseProgress > job.phaseProgress)) {
      job.phaseProgress = event.phaseProgress;
      advanced = true;
    }
    if (advanced) job.progressUpdatedAt = now;
    job.updatedAt = now;
    scheduleProgressSave(job.id);
  }

  function persist() {
    const snapshot = JSON.stringify([...jobs.values()], null, 2);
    saveTail = saveTail
      .catch(() => {})
      .then(async () => {
        await mkdir(rendersDir, { recursive: true });
        const tempFile = `${jobsFile}.${randomUUID()}.tmp`;
        await writeFile(tempFile, `${snapshot}\n`, "utf8");
        await rename(tempFile, jobsFile);
      });
    return saveTail;
  }

  function pump() {
    while (active < maxConcurrent && queue.length > 0) {
      const id = queue.shift();
      active += 1;
      execute(id)
        .catch((error) => console.error(`[render:${id}] unexpected job failure`, error))
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }

  async function initialize() {
    await Promise.all([
      mkdir(projectsDir, { recursive: true }),
      mkdir(tempDir, { recursive: true }),
      mkdir(rendersDir, { recursive: true }),
    ]);
    let restored = [];
    try {
      restored = JSON.parse(await readFile(jobsFile, "utf8"));
      if (!Array.isArray(restored)) restored = [];
    } catch (error) {
      if (error?.code !== "ENOENT") console.error("Could not read render job registry", error);
    }

    let changed = false;
    for (const job of restored) {
      if (!job || typeof job.id !== "string" || !/^[0-9a-f-]{36}$/i.test(job.id)) continue;
      job.phase ??= job.status === "completed" ? "completed" : job.status === "queued" ? "queued" : "unknown";
      job.phaseProgress ??= job.status === "completed" ? 100 : null;
      job.startedAt ??= null;
      job.lastActivityAt ??= null;
      job.progressUpdatedAt ??= null;
      if (job.status === "running") {
        job.updatedAt = new Date().toISOString();
        if (await hasValidMp4(join(rendersDir, `${job.id}.mp4`))) {
          job.status = "completed";
          job.phase = "completed";
          job.phaseProgress = 100;
          job.completedAt = job.updatedAt;
          job.videoUrl = `/r/${job.id}`;
          job.error = undefined;
        } else {
          job.status = "failed";
          job.error = "Render interrupted because the server restarted before it completed.";
        }
        changed = true;
      }
      jobs.set(job.id, job);
      if (job.status === "queued") queue.push(job.id);
    }
    if (changed) await persist();
    pump();
  }

  function ready() {
    if (!initPromise) initPromise = initialize();
    return initPromise;
  }

  async function execute(id) {
    await ready();
    const job = jobs.get(id);
    if (!job || job.status !== "queued") return;
    job.status = "running";
    job.updatedAt = new Date().toISOString();
    job.startedAt = job.updatedAt;
    job.phase = "preparing";
    job.phaseProgress = null;
    job.lastActivityAt = job.updatedAt;
    job.progressUpdatedAt = job.updatedAt;
    await persist();

    const workDir = join(tempDir, id);
    const projectDir = join(projectsDir, id);
    // Stage the MP4 on the persistent video volume so the final rename stays
    // within one filesystem even when temp and video directories are mounts.
    const outputTemp = join(rendersDir, `${id}.tmp.mp4`);
    const outputFinal = join(rendersDir, `${id}.mp4`);
    try {
      await mkdir(projectDir, { recursive: true });
      await mkdir(workDir, { recursive: true });
      const files = await localizeRendererDependencies(validateFiles(job.files));
      await Promise.all(
        files.map(async ({ path, bytes }) => {
          const target = safeJoin(projectDir, path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, bytes);
        }),
      );
      delete job.files;
      await persist();

      updateProgress(job, { phase: "unknown" });
      if (options.render) {
        await options.render(projectDir, outputTemp, (event) => updateProgress(job, event));
      } else {
        await runHyperFrames(projectDir, outputTemp, (event) => updateProgress(job, event));
      }
      updateProgress(job, { phase: "finalizing" });
      if (!(await hasValidMp4(outputTemp))) {
        throw new Error("renderer output does not have a valid MP4 file signature");
      }
      await rename(outputTemp, outputFinal);
      job.status = "completed";
      job.updatedAt = new Date().toISOString();
      job.phase = "completed";
      job.phaseProgress = 100;
      job.lastActivityAt = job.updatedAt;
      job.progressUpdatedAt = job.updatedAt;
      job.completedAt = job.updatedAt;
      job.videoUrl = `/r/${id}`;
      job.error = undefined;
    } catch (error) {
      job.status = "failed";
      job.updatedAt = new Date().toISOString();
      job.error = error instanceof Error ? error.message.slice(0, MAX_ERROR_CHARS) : String(error);
      console.error(`[render:${id}] failed`, job.error);
    } finally {
      cancelProgressSave(id);
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
      await rm(outputTemp, { force: true }).catch(() => {});
      await persist();
    }
  }

  async function enqueue(files, source) {
    await ready();
    const checkedFiles = validateFiles(files);
    // Mandatory here, not in the route: every input path (html, files, bundled)
    // goes through this function, so nothing can skip the check.
    const verdict = runPreflight(checkedFiles);
    const id = randomUUID();
    const now = new Date().toISOString();
    const job = {
      id,
      source,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      phase: "queued",
      phaseProgress: null,
      startedAt: null,
      lastActivityAt: null,
      progressUpdatedAt: null,
      warnings: verdict.warnings,
      files: checkedFiles.map(({ path, bytes }) => ({ path, content: bytes.toString("base64") })),
    };
    jobs.set(id, job);
    queue.push(id);
    await persist();
    pump();
    return structuredClone(job);
  }

  async function get(id) {
    await ready();
    const job = jobs.get(id);
    if (!job) return null;
    const { files: _files, ...publicJob } = job;
    return structuredClone(publicJob);
  }

  async function listCompleted() {
    await ready();
    return [...jobs.values()]
      .filter((job) => job.status === "completed")
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
      .map(({ files: _files, ...job }) => ({ ...job, fileName: `${job.id}.mp4` }));
  }

  async function serveVideo(id, request) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("not found", { status: 404 });
    await ready();
    const job = jobs.get(id);
    if (!job || job.status !== "completed") return new Response("not found", { status: 404 });
    const filePath = safeJoin(rendersDir, `${id}.mp4`);
    let details;
    try {
      details = await stat(filePath);
    } catch {
      return new Response("not found", { status: 404 });
    }
    const download = new URL(request.url).searchParams.get("download") === "1";
    const headers = new Headers({
      "content-type": "video/mp4",
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=0, must-revalidate",
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${id}.mp4"`,
    });
    const range = request.headers.get("range");
    let start = 0;
    let end = details.size - 1;
    let status = 200;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) {
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${details.size}` } });
      }
      if (!match[1]) {
        const suffix = Number(match[2]);
        start = Math.max(0, details.size - suffix);
      } else {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= details.size) {
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${details.size}` } });
      }
      status = 206;
      headers.set("content-range", `bytes ${start}-${end}/${details.size}`);
    }
    headers.set("content-length", String(end - start + 1));
    const stream = createReadStream(filePath, { start, end });
    return new Response(Readable.toWeb(stream), { status, headers });
  }

  return { enqueue, get, listCompleted, serveVideo, ready };
}

async function runHyperFrames(projectDir, outputPath, onProgress) {
  const binary = process.env.HYPERFRAMES_BIN || join(process.cwd(), "node_modules", ".bin", "hyperframes");
  const configuredWorkers = Number(process.env.RENDER_WORKERS || 2);
  const workers = String(Number.isFinite(configuredWorkers) ? Math.max(1, Math.min(16, configuredWorkers)) : 2);
  const configuredTimeout = Number(process.env.RENDER_TIMEOUT_MS || DEFAULT_RENDER_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.max(30_000, configuredTimeout)
    : DEFAULT_RENDER_TIMEOUT_MS;
  await new Promise((resolveRun, reject) => {
    const child = spawn(binary, ["render", projectDir, "--output", outputPath, "--workers", workers], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parser = createProgressParser(onProgress);
    child.stdout.on("data", (chunk) => { onProgress({}); parser.write(chunk); });
    child.stdout.on("end", () => parser.end());
    const stderr = [];
    let stderrSize = 0;
    child.stderr.on("data", (chunk) => {
      onProgress({});
      const bytes = Buffer.from(chunk);
      stderr.push(bytes);
      stderrSize += bytes.length;
      while (stderrSize > MAX_ERROR_CHARS && stderr.length > 0) stderrSize -= stderr.shift().length;
    });
    let timedOut = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref();
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) reject(new Error(`render timed out after ${timeoutMs}ms`));
      else if (code === 0) resolveRun();
      else reject(new Error(`hyperframes render exited with code ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
}

const manager = createRenderManager();

export const enqueueRender = manager.enqueue;
export const getRenderJob = manager.get;
export const listCompletedRenders = manager.listCompleted;
export const serveRenderVideo = manager.serveVideo;
export const renderJobsReady = manager.ready;
