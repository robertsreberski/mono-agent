import { createLogRedactor, type SecretSafeLogSink } from "@mono-agent/agent-contracts";

const TOKEN_MARKER = "[REDACTED_TELEGRAM_BOT_TOKEN]";
const redactor = createLogRedactor({
  tokenMarker: TOKEN_MARKER,
  unavailableMarker: "[TELEGRAM_LOG_DETAILS_UNAVAILABLE]",
  truncatedMarker: "[TELEGRAM_LOG_DETAILS_TRUNCATED]",
  binaryMarker: "[TELEGRAM_LOG_BINARY_DATA_OMITTED]",
  tokenPatterns: [
    { pattern: /(\/file\/bot|\/bot)([^/?#\s]+)/giu, replacement: `$1${TOKEN_MARKER}` },
    { pattern: /\b\d{5,}:[A-Za-z0-9_-]{8,}\b/gu },
  ],
});

export type TelegramLogSink = SecretSafeLogSink;
export const redactTelegramSecretText = redactor.redactText;
export const redactTelegramErrorMessage = redactor.redactErrorMessage;
export const redactTelegramError = redactor.redactError;
export const createSecretSafeTelegramLogger = redactor.createLogger;
