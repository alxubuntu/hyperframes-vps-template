export type RenderStatus = "queued" | "running" | "completed" | "failed";
export type RenderPhase = "queued" | "preparing" | "unknown" | "rendering" | "encoding" | "finalizing" | "completed";

import type { PreflightResult, PreflightWarning } from "./preflight.d.mts";

export interface RenderJob {
  id: string;
  warnings?: PreflightWarning[];
  source: "bundled" | "html" | "files";
  status: RenderStatus;
  phase: RenderPhase;
  phaseProgress: number | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  progressUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  videoUrl?: string;
  error?: string;
}

export interface CompositionFile {
  path: string;
  content: string;
}

export function createRenderManager(options?: {
  projectsDir?: string;
  tempDir?: string;
  rendersDir?: string;
  concurrency?: number;
  render?: (projectDir: string, outputPath: string, onProgress: (event: { phase?: RenderPhase; phaseProgress?: number | null }) => void) => Promise<void>;
}): {
  enqueue(files: CompositionFile[], source: "bundled" | "html" | "files"): Promise<RenderJob>;
  get(id: string): Promise<RenderJob | null>;
  listCompleted(): Promise<Array<RenderJob & { fileName: string }>>;
  serveVideo(id: string, request: Request): Promise<Response>;
  ready(): Promise<void>;
};

export function checkRender(files: CompositionFile[]): Promise<PreflightResult>;
export function enqueueRender(
  files: CompositionFile[],
  source: "bundled" | "html" | "files",
): Promise<RenderJob>;
export function getRenderJob(id: string): Promise<RenderJob | null>;
export function listCompletedRenders(): Promise<Array<RenderJob & { fileName: string }>>;
export function serveRenderVideo(id: string, request: Request): Promise<Response>;
export function renderJobsReady(): Promise<void>;
