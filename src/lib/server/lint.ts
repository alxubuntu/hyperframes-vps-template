import { lintHyperframeHtml } from "@hyperframes/core/lint";
import type { LintError } from "../generation";

export function lintFiltered(html: string): LintError[] {
  const result = lintHyperframeHtml(html, { filePath: "composition.html" });
  return result.findings
    .filter((f) => f.severity === "error")
    .map((f) => ({ code: f.code, message: f.message }));
}
