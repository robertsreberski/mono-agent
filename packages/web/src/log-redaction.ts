import { createLogRedactor } from "@mono-agent/contracts";

export interface WebLogSink {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

const WEB_TOKEN_MARKER = "[REDACTED_WEB_CREDENTIAL]";

const webRedactor = createLogRedactor({
  tokenMarker: WEB_TOKEN_MARKER,
  unavailableMarker: "[WEB_LOG_DETAILS_UNAVAILABLE]",
  truncatedMarker: "[WEB_LOG_DETAILS_TRUNCATED]",
  binaryMarker: "[WEB_LOG_BINARY_DATA_OMITTED]",
  tokenPatterns: [
    { pattern: /\b(sk-[A-Za-z0-9_-]{8,}|gh[opur]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/giu },
  ],
});

export const redactWebSecretText = (
  text: string,
  knownSecrets: readonly string[] = [],
): string => webRedactor.redactText(text, knownSecrets);

export const redactWebErrorMessage = (
  error: unknown,
  knownSecrets: readonly string[] = [],
): string => webRedactor.redactErrorMessage(error, knownSecrets);

const SENSITIVE_ENV_KEY = /(?:token|secret|password|passwd|pwd|api[_-]?key|client[_-]?secret|access[_-]?key|auth|credential|private[_-]?key|bearer|cookie|session)/iu;

const ORIGIN_LIST_TOKEN = /^https?:\/\/[^/\s,;]+(\/\S*)?$/iu;

/** Plain origin/URL lists (e.g. authorized-origins) are allowlists, not secrets. */
function looksLikeOriginList(value: string): boolean {
  if (!value.includes("://")) return false;
  const tokens = value.split(/[\s,;]+/u).filter((token) => token.length > 0);
  if (tokens.length === 0) return false;
  return tokens.every((token) => ORIGIN_LIST_TOKEN.test(token));
}

/** Collect bounded credential values from the environment for log redaction. */
export function collectKnownWebSecrets(
  env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> | undefined,
): readonly string[] {
  if (env === undefined) return [];
  const collected: string[] = [];
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length < 8 || trimmed.length > 1024) continue;
    if (!SENSITIVE_ENV_KEY.test(key)) continue;
    if (looksLikeOriginList(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    collected.push(trimmed);
    if (collected.length >= 32) break;
  }
  return collected;
}

/** Wrap a diagnostic sink so future log sites stay safe even with error input. */
export function createSecretSafeWebLogger<T extends WebLogSink | undefined>(
  logger: T,
  knownSecrets: readonly string[],
): T {
  if (logger === undefined) return logger;
  const wrapped = webRedactor.createLogger(logger, knownSecrets);
  return (wrapped ?? undefined) as T;
}
