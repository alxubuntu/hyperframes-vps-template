// Shared between client and server — keep free of server-only imports.

export const FREE_OPENROUTER_MODELS = [
  { id: "nvidia/nemotron-3.5-super-vl-20261015:free", label: "NVIDIA Nemotron 3.5 Super VL" },
  { id: "nvidia/nemotron-3.5-lightning-20260807:free", label: "NVIDIA Nemotron 3.5 Lightning" },
  { id: "recursive/flint-v1.0-20261021:free", label: "Recursive Flint 1.0" },
  { id: "xingchen-agi/xing4.0-29b-a4b-20261015:free", label: "Xingchen Xing 4.0 29B A4B" },
] as const;

export type FreeOpenRouterModel = (typeof FREE_OPENROUTER_MODELS)[number]["id"];
export const DEFAULT_MODEL = FREE_OPENROUTER_MODELS[0].id;

/** Only omission selects the default; invalid explicit values never fall back. */
export function resolveOpenRouterModel(value: unknown): FreeOpenRouterModel | undefined {
  if (value === undefined) return DEFAULT_MODEL;
  return FREE_OPENROUTER_MODELS.find(({ id }) => id === value)?.id;
}

/** 1 initial generation + up to 2 lint-driven self-heal turns. */
export const MAX_GENERATE_ATTEMPTS = 3;

export interface LintError {
  code: string;
  message: string;
}

export function stripMarkdownFence(text: string): string {
  let s = text.trim();
  if (s.startsWith("```html")) s = s.slice(7);
  else if (s.startsWith("```")) s = s.slice(3);
  if (s.endsWith("```")) s = s.slice(0, -3);
  return s.trim();
}

/** The follow-up user turn that asks the model to fix lint failures. */
export function buildFixMessage(lintErrors: LintError[]): string {
  const errorList = lintErrors.map((e, idx) => `${idx + 1}. [${e.code}] ${e.message}`).join("\n");

  return `The composition above failed validation. Fix these errors and return the corrected HTML.

Errors:
${errorList}

Return ONLY the fixed HTML — no explanations, no markdown fences. Start with <!DOCTYPE html>.`;
}
