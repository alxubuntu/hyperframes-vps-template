import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import manifest from "../../composition-manifest.json";
import { bufferToBase64, utf8Encode } from "../encoding";

export { bufferToBase64, utf8ByteLength } from "../encoding";

/** One file of a composition as the render container expects it. */
export interface CompositionFile {
  path: string;
  /** base64-encoded file bytes */
  content: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
};

export async function fetchAsset(path: string): Promise<Response> {
  const publicRoot = resolve(process.cwd(), "public");
  const assetPath = resolve(publicRoot, path);
  if (!assetPath.startsWith(`${publicRoot}${sep}`)) return new Response("not found", { status: 404 });
  try {
    const bytes = await readFile(assetPath);
    return new Response(bytes as BodyInit, {
      headers: { "content-type": CONTENT_TYPES[extname(assetPath)] ?? "application/octet-stream" },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

export async function loadBundledCompositionFiles(): Promise<CompositionFile[]> {
  return Promise.all(
    manifest.files.map(async (rel) => {
      const res = await fetchAsset(`${manifest.dir}/${rel}`);
      if (!res.ok) throw new Error(`asset missing: ${rel} (${res.status})`);
      const buf = new Uint8Array(await res.arrayBuffer());
      return { path: rel, content: bufferToBase64(buf) };
    }),
  );
}

export function htmlToFiles(html: string): CompositionFile[] {
  return [{ path: "index.html", content: bufferToBase64(utf8Encode(html)) }];
}

export function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

export function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isJsonRequest(req: Request): boolean {
  return req.headers.get("content-type")?.includes("application/json") ?? false;
}
