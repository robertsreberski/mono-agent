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
    { pattern: /\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/giu },
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

/** Render an error safe for local diagnostics (never for browser bodies). */
export const redactWebError = (
  error: unknown,
  knownSecrets: readonly string[] = [],
): Error => webRedactor.redactError(error, knownSecrets);

/** Hostname allowlist keys hold non-secret routing config, never credentials. */
const NON_SECRET_ENV_KEYS = new Set([
  "MONO_AGENT_WEB_ALLOWED_HOSTS",
]);

/**
 * Credential words must end the key (as its final `_`/`-` segment), so
 * settings such as `CLAUDE_CODE_MAX_OUTPUT_TOKENS` or `SESSION_TIMEOUT_MS` are
 * never mistaken for credentials and their values never blank diagnostics.
 */
const SENSITIVE_ENV_KEY = /(?:^|[_-])(?:token|secret|password|passwd|api[_-]?key|client[_-]?secret|access[_-]?key|credential|private[_-]?key|bearer|cookie|session|auth[_-]?(?:token|secret|key))$/iu;

/**
 * Keys that name an explicit credential: any non-empty value is collected,
 * since discovery accepts short keys (e.g. a short `MONO_AGENT_TUI_API_KEY` is
 * still forwarded as a bearer credential).
 */
const EXPLICIT_CREDENTIAL_KEY = /(?:^|[_-])(?:api[_-]?key|client[_-]?secret|access[_-]?key|token|secret|password|passwd|credential|private[_-]?key)$/iu;

/** Collect bounded credential values from the environment for log redaction. */
export function collectKnownWebSecrets(
  env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> | undefined,
): readonly string[] {
  if (env === undefined) return [];
  const collected: string[] = [];
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (NON_SECRET_ENV_KEYS.has(key)) continue;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > 1024) continue;
    if (!SENSITIVE_ENV_KEY.test(key)) continue;
    // Short values mangle diagnostics when redacted, so only explicitly
    // credential-named keys are collected below eight characters.
    if (trimmed.length < 8 && !EXPLICIT_CREDENTIAL_KEY.test(key)) continue;
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
