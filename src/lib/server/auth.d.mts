export interface AuthConfig {
  enabled: boolean;
  password: string;
  apiToken: string;
  sessionHours: number;
  cookieSecure: boolean;
  signingKey: Buffer;
}
export function loadAuthConfig(env?: NodeJS.ProcessEnv): AuthConfig;
export function verifyPassword(candidate: string, config: AuthConfig): boolean;
export function verifyBearer(header: string | null, config: AuthConfig): boolean;
export function issueSession(config: AuthConfig, now?: number): string;
export function verifySession(value: string | undefined, config: AuthConfig, now?: number): boolean;
export function sessionFromCookie(header: string | null): string;
export function isAuthorized(headers: Headers, config: AuthConfig): boolean;
export function isPublicPath(method: string, pathname: string): boolean;
export function createLoginLimiter(options?: { windowMs?: number; maxAttempts?: number; maxEntries?: number }): (ip: string, now?: number) => boolean;
export const SESSION_COOKIE_NAME: string;
export function isWithinPublicAssets(clientRoot: string, filePath: string): boolean;
export function requiresOriginCheck(headers: Headers, config: AuthConfig): boolean;
export function resolveRequestOrigin(headers: Record<string, string | string[] | undefined>, trustProxy?: boolean): string;
export function handleRequestError(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, error: unknown): void;
