// Deterministic, dependency-free preflight for render payloads.
//
// Everything here runs on the decoded bytes the renderer will actually write.
// The render container has no network access, so a composition that points at
// an http(s) URL does not fail: it renders a hole. This module turns that silent
// failure into a 400 with a concrete fix before the job takes the single queue
// slot.
//
// All scanning is linear: manual tag/CSS walkers instead of nested-quantifier
// regular expressions, which overflowed V8's stack above ~2.7 MB of base64.

export const CONTRACT_VERSION = 2;

/** Server-local runtime scripts the renderer rewrites into assets/ on its own. */
export const ALLOWED_REMOTE_SCRIPTS = new Set([
  "/_hyperframes/gsap.min.js",
  "/_hyperframes/hyperframe.runtime.iife.js",
]);

const MAX_ISSUES = 40;
const HEAVY_IMAGE_BYTES = 2 * 1024 * 1024;
const LONG_DURATION_SEC = 60;

const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "inherit",
  "initial",
  "unset",
  "revert",
]);

const SYSTEM_FAMILIES = new Set(["system-ui", "system-ui", "-apple-system", "blinkmacsystemfont"]);

export class PreflightError extends Error {
  constructor(issues, warnings = []) {
    super("preflight failed");
    this.name = "PreflightError";
    this.issues = issues;
    this.warnings = warnings;
  }
}

export function preflight(files) {
  const issues = [];
  const warnings = [];
  const assetPaths = new Set();
  const roots = [];
  const declaredFonts = new Set();
  const usedFamilies = [];
  const seenWarnings = new Set();

  for (const file of files) {
    if (typeof file?.path !== "string" || !file.bytes) continue;
    assetPaths.add(normalizePath(file.path));
  }

  const addIssue = (issue) => {
    if (issues.length < MAX_ISSUES) issues.push(issue);
  };
  const addWarning = (warning) => {
    const key = `${warning.code}:${warning.detail ?? ""}`;
    if (seenWarnings.has(key) || warnings.length >= MAX_ISSUES) return;
    seenWarnings.add(key);
    warnings.push(warning);
  };

  const checkReference = (raw, file, where) => {
    const value = raw.trim();
    if (!value || value.startsWith("#") || value.startsWith("data:")) {
      if (value.startsWith("data:")) checkDataUri(value, file, where, addIssue, addWarning);
      return;
    }
    if (isExternal(value)) {
      addIssue({
        code: "external-url",
        file,
        detail: value.slice(0, 200),
        message: "El render corre sin acceso a internet: esa URL nunca se va a descargar.",
        fix: "Descargá el archivo y embebelo como data URI, o mandalo en files[] y referencialo por ruta relativa (assets/…).",
      });
      return;
    }
    if (value.startsWith("/")) {
      if (ALLOWED_REMOTE_SCRIPTS.has(value.split("?")[0])) return;
      addIssue({
        code: "missing-asset",
        file,
        detail: value.slice(0, 200),
        message: "Las rutas absolutas no existen dentro del proyecto de render.",
        fix: "Usá una ruta relativa al proyecto, por ejemplo assets/logo.png, y mandá ese archivo en files[].",
      });
      return;
    }
    const normalized = normalizePath(value.split("?")[0].split("#")[0]);
    if (!normalized) return;
    if (!assetPaths.has(normalized)) {
      addIssue({
        code: "missing-asset",
        file,
        detail: value.slice(0, 200),
        message: `El archivo "${normalized}" no viaja en el payload.`,
        fix: `Agregá { "path": "${normalized}", "content": "<base64>" } a files[], o embebé el contenido como data URI.`,
      });
    }
  };

  for (const file of files) {
    if (typeof file?.path !== "string" || !file.bytes) continue;
    if (!file.path.toLowerCase().endsWith(".html")) continue;
    const html = file.bytes.toString("utf8");
    const fontFaces = collectFontFaceRanges(html);

    collectDeclaredFonts(html, fontFaces, declaredFonts);

    scanTags(html, (name, attrs) => {
      if (attrs.has("data-composition-id")) {
        roots.push({ file: file.path, tag: name, attrs });
      }
      for (const [attr, value] of attrs) {
        if (attr.startsWith("xmlns")) continue;
        if (attr === "src" || attr === "poster") {
          checkReference(value, file.path, `<${name} ${attr}>`);
          continue;
        }
        if (attr === "srcset") {
          // A data URI contains commas; only a real srcset list is split.
          const parts = value.trim().startsWith("data:") ? [value] : value.split(",");
          for (const part of parts) {
            checkReference(part.trim().split(/\s+/)[0] ?? "", file.path, `<${name} srcset>`);
          }
          continue;
        }
        if (attr === "href" && (name === "link" || name === "use" || name === "image")) {
          checkReference(value, file.path, `<${name} href>`);
        }
      }
    });

    scanCssUrls(html, (value) => checkReference(value, file.path, "css url()"));

    scanFontFamilies(html, fontFaces, (family) => {
      usedFamilies.push(family);
    });
  }

  // Root contract: without these the renderer produces a wrong-length or
  // unmounted composition while still reporting success.
  const root = roots.find((candidate) => candidate.attrs.get("data-root") === "true") ?? roots[0];
  if (!root) {
    addIssue({
      code: "missing-root",
      message: "No hay ningún elemento con data-composition-id.",
      fix: 'Envolvé la composición así: <div data-composition-id="mi-video" data-root="true" data-width="1920" data-height="1080" data-duration="8">…</div>',
    });
  } else {
    const required = ["data-duration"];
    if (root.attrs.get("data-root") === "true") required.push("data-width", "data-height");
    for (const attr of required) {
      if (!root.attrs.get(attr)) {
        addIssue({
          code: "missing-root",
          file: root.file,
          detail: attr,
          message: `Falta ${attr} en el elemento raíz.`,
          fix: `Agregá ${attr}="${attr === "data-duration" ? "8" : "1920"}" al elemento raíz.`,
        });
      }
    }
    const duration = Number(root.attrs.get("data-duration"));
    if (Number.isFinite(duration) && duration > LONG_DURATION_SEC) {
      addWarning({
        code: "long-duration",
        detail: `${duration}s`,
        message: `La composición dura ${duration}s; el render va a tardar bastante.`,
      });
    }
  }

  for (const family of usedFamilies) {
    const key = family.toLowerCase();
    if (GENERIC_FAMILIES.has(key)) continue;
    if (declaredFonts.has(key)) continue;
    if (SYSTEM_FAMILIES.has(key)) {
      addWarning({
        code: "system-font",
        detail: family,
        message: `"${family}" no existe en el contenedor: el texto va a salir con la fuente de reemplazo.`,
      });
      continue;
    }
    addWarning({
      code: "unknown-font",
      detail: family,
      message: `La fuente "${family}" no está declarada con @font-face: el render va a usar una de reemplazo.`,
    });
  }

  return { ok: issues.length === 0, issues, warnings };
}

// Case-insensitive search that never rewrites the source: lowercasing a
// document would destroy base64 payloads, which are case-sensitive.
function indexOfCI(haystack, needle, from = 0) {
  const length = needle.length;
  const first = needle.charCodeAt(0);
  const limit = haystack.length - length;
  for (let i = from; i <= limit; i++) {
    const code = haystack.charCodeAt(i);
    if (code !== first && (code | 32) !== first) continue;
    let j = 1;
    for (; j < length; j++) {
      const a = haystack.charCodeAt(i + j);
      const b = needle.charCodeAt(j);
      if (a !== b && (a | 32) !== b) break;
    }
    if (j === length) return i;
  }
  return -1;
}

function isExternal(value) {
  return /^https?:\/\//i.test(value) || value.startsWith("//");
}

function normalizePath(path) {
  let value = path.trim().replace(/\\/g, "/");
  while (value.startsWith("./")) value = value.slice(2);
  return value;
}

function isSpace(code) {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

function isLetter(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isNameChar(code) {
  return isLetter(code) || (code >= 48 && code <= 57) || code === 45 || code === 58;
}

function findTagEnd(html, from) {
  let quote = 0;
  for (let i = from; i < html.length; i++) {
    const code = html.charCodeAt(i);
    if (quote) {
      if (code === quote) quote = 0;
      continue;
    }
    if (code === 34 || code === 39) {
      quote = code;
      continue;
    }
    if (code === 62) return i;
  }
  return -1;
}

function readAttrs(html, start, end) {
  const attrs = new Map();
  let i = start;
  while (i < end) {
    while (i < end && isSpace(html.charCodeAt(i))) i++;
    if (i >= end) break;
    const nameStart = i;
    while (i < end && !isSpace(html.charCodeAt(i)) && html[i] !== "=") i++;
    const name = html.slice(nameStart, i).toLowerCase();
    while (i < end && isSpace(html.charCodeAt(i))) i++;
    if (html[i] !== "=") {
      if (name) attrs.set(name, "");
      continue;
    }
    i++;
    while (i < end && isSpace(html.charCodeAt(i))) i++;
    const quote = html[i];
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, i + 1);
      const value = close === -1 ? html.slice(i + 1, end) : html.slice(i + 1, close);
      if (name) attrs.set(name, value);
      i = close === -1 ? end : close + 1;
    } else {
      const valueStart = i;
      while (i < end && !isSpace(html.charCodeAt(i))) i++;
      if (name) attrs.set(name, html.slice(valueStart, i));
    }
  }
  return attrs;
}

function scanTags(html, visit) {
  let i = 0;
  while (true) {
    const lt = html.indexOf("<", i);
    if (lt === -1) return;
    if (!isLetter(html.charCodeAt(lt + 1))) {
      i = lt + 1;
      continue;
    }
    let nameEnd = lt + 1;
    while (nameEnd < html.length && isNameChar(html.charCodeAt(nameEnd))) nameEnd++;
    const name = html.slice(lt + 1, nameEnd).toLowerCase();
    const end = findTagEnd(html, nameEnd);
    if (end === -1) return;
    visit(name, readAttrs(html, nameEnd, end));
    i = end + 1;
  }
}

function scanCssUrls(html, visit) {
  let i = 0;
  const needle = "url(";
  while (true) {
    const index = indexOfCI(html, needle, i);
    if (index === -1) return;
    const close = html.indexOf(")", index + needle.length);
    if (close === -1) return;
    let value = html.slice(index + needle.length, close).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    visit(value.trim());
    i = close + 1;
  }
}

function collectFontFaceRanges(html) {
  const ranges = [];
  let i = 0;
  const needle = "@font-face";
  while (true) {
    const index = indexOfCI(html, needle, i);
    if (index === -1) return ranges;
    const close = html.indexOf("}", index);
    ranges.push([index, close === -1 ? html.length : close]);
    i = close === -1 ? html.length : close + 1;
  }
}

function insideRanges(ranges, index) {
  for (const [start, end] of ranges) {
    if (index >= start && index <= end) return true;
  }
  return false;
}

function collectDeclaredFonts(html, ranges, declared) {
  for (const [start, end] of ranges) {
    const block = html.slice(start, end);
    let i = 0;
    while (true) {
      const index = indexOfCI(block, "font-family", i);
      if (index === -1) break;
      const colon = block.indexOf(":", index);
      if (colon === -1) break;
      const semicolon = block.indexOf(";", colon);
      const raw = block.slice(colon + 1, semicolon === -1 ? block.length : semicolon);
      const family = raw.split(",")[0].trim().replace(/^["']|["']$/g, "").toLowerCase();
      if (family) declared.add(family);
      i = colon + 1;
    }
  }
}

function scanFontFamilies(html, ranges, visit) {
  let i = 0;
  while (true) {
    const index = indexOfCI(html, "font-family", i);
    if (index === -1) return;
    if (insideRanges(ranges, index)) {
      i = index + 11;
      continue;
    }
    const colon = html.indexOf(":", index);
    if (colon === -1) return;
    const stop = html.indexOf(";", colon);
    const limit = Math.min(stop === -1 ? html.length : stop, colon + 200);
    const raw = html.slice(colon + 1, limit);
    const family = raw.split(",")[0].trim().replace(/^["']|["']$/g, "");
    if (family) visit(family);
    i = Math.max(colon + 1, index + 11);
  }
}

function checkBase64(value) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (value.length % 4 !== 0) return { ok: false };
  const bodyEnd = value.length - padding;
  for (let i = 0; i < bodyEnd; i++) {
    const code = value.charCodeAt(i);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) return { ok: false };
  }
  return { ok: true, bytes: (value.length / 4) * 3 - padding };
}

function checkDataUri(value, file, where, addIssue, addWarning) {
  const comma = value.indexOf(",");
  if (comma === -1) {
    addIssue({
      code: "bad-base64",
      file,
      detail: where,
      message: "El data URI no tiene la forma data:<tipo>;base64,<datos>.",
      fix: "Recodificá el archivo: data:image/png;base64,<base64>.",
    });
    return;
  }
  const meta = value.slice(5, comma).toLowerCase();
  const payload = value.slice(comma + 1);
  if (!meta.includes(";base64")) return;
  const verdict = checkBase64(payload);
  if (!verdict.ok) {
    addIssue({
      code: "bad-base64",
      file,
      detail: where,
      message: "El contenido base64 del data URI está truncado o corrupto.",
      fix: "Recodificá el archivo completo en base64 y volvé a embeberlo.",
    });
    return;
  }
  if (meta.startsWith("image/") && verdict.bytes > HEAVY_IMAGE_BYTES) {
    addWarning({
      code: "heavy-image",
      detail: `${Math.round(verdict.bytes / 1024)}KB`,
      message: `Hay una imagen de ${Math.round(verdict.bytes / 1048576)} MB embebida; conviene optimizarla a WebP.`,
    });
  }
  if (meta.startsWith("font/")) {
    const magic = Buffer.from(payload.slice(0, 8), "base64").toString("latin1");
    const expected = meta.includes("woff2") ? "wOF2" : meta.includes("woff") ? "wOFF" : "";
    if (expected && !magic.startsWith(expected)) {
      addIssue({
        code: "bad-font",
        file,
        detail: where,
        message: `El data URI dice ${meta.split(";")[0]} pero el contenido no es ese formato.`,
        fix: "Verificá que el archivo sea realmente woff2 (magic wOF2) antes de convertirlo a base64.",
      });
    }
  }
}
