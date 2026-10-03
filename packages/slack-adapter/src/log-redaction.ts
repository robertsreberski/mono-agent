import {
  createLogRedactor,
  isSafePrototypeInstance,
  readSafeDataProperty,
  type SecretSafeLogSink,
} from "@mono-agent/agent-contracts";

const redactor = createLogRedactor({
  tokenMarker: "[REDACTED_SLACK_TOKEN]",
  unavailableMarker: "[SLACK_LOG_DETAILS_UNAVAILABLE]",
  truncatedMarker: "[SLACK_LOG_DETAILS_TRUNCATED]",
  binaryMarker: "[SLACK_LOG_BINARY_DATA_OMITTED]",
  tokenPatterns: [{ pattern: /\b(?:xox[a-z]|xapp)-[A-Za-z0-9_-]{8,}\b/giu }],
});

export type SlackLogSink = SecretSafeLogSink;
export const redactSlackSecretText = redactor.redactText;
export const redactSlackErrorMessage = redactor.redactErrorMessage;
export const createSecretSafeSlackLogger = redactor.createLogger;
export const isSafeSlackPrototypeInstance = isSafePrototypeInstance;
export const readSafeSlackDataProperty = readSafeDataProperty;
