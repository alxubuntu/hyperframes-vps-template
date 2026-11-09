export const CONTRACT_VERSION: number;
export const ALLOWED_REMOTE_SCRIPTS: Set<string>;

export interface PreflightIssue {
  code: string;
  message: string;
  fix?: string;
  file?: string;
  detail?: string;
}

export interface PreflightWarning {
  code: string;
  message: string;
  detail?: string;
}

export interface PreflightResult {
  ok: boolean;
  issues: PreflightIssue[];
  warnings: PreflightWarning[];
}

export declare class PreflightError extends Error {
  issues: PreflightIssue[];
  warnings: PreflightWarning[];
  constructor(issues: PreflightIssue[], warnings?: PreflightWarning[]);
}

export function preflight(files: Array<{ path: string; bytes: Uint8Array }>): PreflightResult;
