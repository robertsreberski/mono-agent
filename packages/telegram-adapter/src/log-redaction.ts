const REDACTED_TELEGRAM_TOKEN = "[REDACTED_TELEGRAM_BOT_TOKEN]";
const REDACTED_BEARER = "[REDACTED_BEARER_CREDENTIAL]";
const TELEGRAM_URL_TOKEN_PATTERN = /(\/file\/bot|\/bot)([^/?#\s]+)/giu;
const TELEGRAM_TOKEN_PATTERN = /\b\d{5,}:[A-Za-z0-9_-]{8,}\b/gu;
const BEARER_CREDENTIAL_PATTERN = /\b(Bearer\s+)[^\s,;"']+/giu;
const SENSITIVE_NAME_FRAGMENT = "authorization|auth|cookie|token|secret|password|signature|sig|credential|key|code";
const SENSITIVE_LOG_KEY_PATTERN = new RegExp(`(?:^|[-_])(?:${SENSITIVE_NAME_FRAGMENT})(?:$|[-_])`, "iu");
const SECRET_QUERY_PATTERN = new RegExp(
  `([?&][^=&#\\s]*(?:${SENSITIVE_NAME_FRAGMENT})[^=&#\\s]*=)[^&#\\s]+`,
  "giu",
);
const SECRET_HEADER_TEXT_PATTERN = new RegExp(
  `((?:^|[^A-Za-z0-9_-])["']?[A-Za-z0-9_-]*(?:${SENSITIVE_NAME_FRAGMENT})[A-Za-z0-9_-]*["']?\\s*[:=]\\s*)[^\\r\\n]*`,
  "giu",
);
const URL_USERINFO_PATTERN = /\b(https?:\/\/)[^/\s:@]+:[^@\s/]+@/giu;

export interface TelegramLogSink {
  debug?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
  warn?(message: string, metadata?: Record<string, unknown>): void;
  error?(message: string, metadata?: Record<string, unknown>): void;
}

/** Redact configured and recognizable Telegram Bot API tokens from arbitrary text. */
export function redactTelegramSecretText(
  text: string,
  knownSecrets: readonly string[] = [],
): string {
  let redacted = text;
  for (const secret of knownSecrets) {
    const normalized = secret.trim();
    if (normalized.length > 0) {
      redacted = redacted.split(normalized).join(REDACTED_TELEGRAM_TOKEN);
    }
  }
  return redacted
    .replace(TELEGRAM_URL_TOKEN_PATTERN, `$1${REDACTED_TELEGRAM_TOKEN}`)
    .replace(TELEGRAM_TOKEN_PATTERN, REDACTED_TELEGRAM_TOKEN)
    .replace(BEARER_CREDENTIAL_PATTERN, `$1${REDACTED_BEARER}`)
    .replace(SECRET_QUERY_PATTERN, `$1${REDACTED_BEARER}`)
    .replace(SECRET_HEADER_TEXT_PATTERN, `$1${REDACTED_BEARER}`)
    .replace(URL_USERINFO_PATTERN, `$1${REDACTED_BEARER}@`);
}

/** Render one error message without allowing Telegram credentials into logs. */
export function redactTelegramErrorMessage(
  error: unknown,
  knownSecrets: readonly string[] = [],
): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactTelegramSecretText(message, knownSecrets);
}

/**
 * Wrap a logger at the adapter boundary so future log sites are safe even when
 * they pass nested errors, causes, request objects, URLs, or stacks.
 */
export function createSecretSafeTelegramLogger<T extends TelegramLogSink>(
  logger: T | undefined,
  knownSecrets: readonly string[],
): T | undefined {
  if (logger === undefined) {
    return undefined;
  }

  const wrapped: TelegramLogSink = {};
  for (const level of ["debug", "info", "warn", "error"] as const) {
    const sink = logger[level];
    if (sink === undefined) {
      continue;
    }
    wrapped[level] = (message, metadata) => {
      const safeMessage = redactTelegramSecretText(message, knownSecrets);
      const safeMetadata = metadata === undefined
        ? undefined
        : sanitizeTelegramLogRecord(metadata, knownSecrets);
      sink.call(logger, safeMessage, safeMetadata);
    };
  }
  return wrapped as T;
}

/** Return an Error safe to hand to host callbacks that may log it themselves. */
export function redactTelegramError(
  error: unknown,
  knownSecrets: readonly string[],
): Error {
  const safe = new Error(redactTelegramErrorMessage(error, knownSecrets));
  if (error instanceof Error) {
    safe.name = redactTelegramSecretText(error.name, knownSecrets);
    if (error.stack !== undefined) {
      safe.stack = redactTelegramSecretText(error.stack, knownSecrets);
    }
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause !== undefined) {
      Object.defineProperty(safe, "cause", {
        configurable: true,
        enumerable: false,
        value: sanitizeTelegramLogValue(cause, knownSecrets, new WeakSet<object>()),
      });
    }
    for (const [key, value] of Object.entries(error)) {
      if (key === "cause") {
        continue;
      }
      Object.defineProperty(safe, key, {
        configurable: true,
        enumerable: true,
        value: sensitiveLogKey(key)
          ? REDACTED_BEARER
          : sanitizeTelegramLogValue(value, knownSecrets, new WeakSet<object>()),
      });
    }
  }
  return safe;
}

function sanitizeTelegramLogRecord(
  record: Record<string, unknown>,
  knownSecrets: readonly string[],
): Record<string, unknown> {
  const sanitized = sanitizeTelegramLogValue(record, knownSecrets, new WeakSet<object>());
  return isRecord(sanitized) ? sanitized : { value: sanitized };
}

function sanitizeTelegramLogValue(
  value: unknown,
  knownSecrets: readonly string[],
  seen: WeakSet<object>,
  container?: "headers" | "query",
): unknown {
  if (typeof value === "string") {
    return redactTelegramSecretText(value, knownSecrets);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (value instanceof URL) {
    return redactTelegramSecretText(value.href, knownSecrets);
  }
  if (value instanceof Error) {
    const safe: Record<string, unknown> = {
      name: redactTelegramSecretText(value.name, knownSecrets),
      message: redactTelegramSecretText(value.message, knownSecrets),
    };
    if (value.stack !== undefined) {
      safe.stack = redactTelegramSecretText(value.stack, knownSecrets);
    }
    const cause = (value as Error & { cause?: unknown }).cause;
    if (cause !== undefined) {
      safe.cause = sanitizeTelegramLogValue(cause, knownSecrets, seen);
    }
    for (const [key, nested] of Object.entries(value)) {
      if (!(key in safe)) {
        const childContainer = logContainer(key);
        safe[key] = sensitiveLogKey(key)
          ? REDACTED_BEARER
          : sanitizeTelegramLogValue(nested, knownSecrets, seen, childContainer);
      }
    }
    return safe;
  }
  if (Array.isArray(value)) {
    if (container === "headers") {
      if (typeof value[0] === "string" && value.length === 2) {
        return [redactTelegramSecretText(value[0], knownSecrets), REDACTED_BEARER];
      }
      return value.map((entry, index) => {
        if (Array.isArray(entry) && typeof entry[0] === "string") {
          return [redactTelegramSecretText(entry[0], knownSecrets), REDACTED_BEARER];
        }
        if (typeof entry === "string") {
          return index % 2 === 0
            ? redactTelegramSecretText(entry, knownSecrets)
            : REDACTED_BEARER;
        }
        return sanitizeTelegramLogValue(entry, knownSecrets, seen, "headers");
      });
    }
    if (typeof value[0] === "string" && sensitiveLogKey(value[0])) {
      return [redactTelegramSecretText(value[0], knownSecrets), REDACTED_BEARER];
    }
    return value.map((entry) => {
      if (
        Array.isArray(entry)
        && typeof entry[0] === "string"
        && sensitiveLogKey(entry[0])
      ) {
        return [redactTelegramSecretText(entry[0], knownSecrets), REDACTED_BEARER];
      }
      return sanitizeTelegramLogValue(entry, knownSecrets, seen);
    });
  }

  const safe: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const childContainer = logContainer(key);
    safe[key] = container === "headers" || sensitiveLogKey(key)
      ? REDACTED_BEARER
      : sanitizeTelegramLogValue(nested, knownSecrets, seen, childContainer ?? container);
  }
  return safe;
}

function sensitiveLogKey(key: string): boolean {
  const normalized = normalizeLogKey(key);
  return SENSITIVE_LOG_KEY_PATTERN.test(normalized);
}

function logContainer(key: string): "headers" | "query" | undefined {
  const normalized = normalizeLogKey(key).replace(/[-_]/gu, "");
  if (normalized === "headers" || normalized === "header" || normalized === "rawheaders" || normalized === "headerpairs") {
    return "headers";
  }
  if (normalized === "query" || normalized === "params" || normalized === "searchparams") {
    return "query";
  }
  return undefined;
}

function normalizeLogKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLocaleLowerCase("en-US");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
