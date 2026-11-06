export type RenderStatus = "queued" | "running" | "completed" | "failed";

export interface RenderJob {
  id: string;
  source: "bundled" | "html";
  status: RenderStatus;
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
  render?: (projectDir: string, outputPath: string) => Promise<void>;
}): {
  enqueue(files: CompositionFile[], source: "bundled" | "html"): Promise<RenderJob>;
  get(id: string): Promise<RenderJob | null>;
  listCompleted(): Promise<Array<RenderJob & { fileName: string }>>;
  serveVideo(id: string, request: Request): Promise<Response>;
  ready(): Promise<void>;
};

export function enqueueRender(files: CompositionFile[], source: "bundled" | "html"): Promise<RenderJob>;
export function getRenderJob(id: string): Promise<RenderJob | null>;
export function listCompletedRenders(): Promise<Array<RenderJob & { fileName: string }>>;
export function serveRenderVideo(id: string, request: Request): Promise<Response>;
export function renderJobsReady(): Promise<void>;
