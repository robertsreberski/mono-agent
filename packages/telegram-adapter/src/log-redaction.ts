const REDACTED_TELEGRAM_TOKEN = "[REDACTED_TELEGRAM_BOT_TOKEN]";
const TELEGRAM_URL_TOKEN_PATTERN = /(\/file\/bot|\/bot)([^/?#\s]+)/giu;
const TELEGRAM_TOKEN_PATTERN = /\b\d{5,}:[A-Za-z0-9_-]{8,}\b/gu;

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
    .replace(TELEGRAM_TOKEN_PATTERN, REDACTED_TELEGRAM_TOKEN);
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
        value: sanitizeTelegramLogValue(value, knownSecrets, new WeakSet<object>()),
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
        safe[key] = sanitizeTelegramLogValue(nested, knownSecrets, seen);
      }
    }
    return safe;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeTelegramLogValue(entry, knownSecrets, seen));
  }

  const safe: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    safe[key] = sanitizeTelegramLogValue(nested, knownSecrets, seen);
  }
  return safe;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
