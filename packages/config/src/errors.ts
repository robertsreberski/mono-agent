

import type { ConfigErrorFactory } from "@mono-agent/contracts";

type MonoAgentConfigErrorCode =
  | "missing_required_env"
  | "invalid_env"
  | "invalid_json"
  | "invalid_model_reference";

interface MonoAgentConfigErrorDetails {
  readonly code?: MonoAgentConfigErrorCode;
  readonly env?: string;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export class MonoAgentConfigError extends Error {
  readonly code: MonoAgentConfigErrorCode;
  readonly details: MonoAgentConfigErrorDetails;

  constructor(code: MonoAgentConfigErrorCode, message: string, details: MonoAgentConfigErrorDetails = {}) {
    super(message);
    this.name = "MonoAgentConfigError";
    this.code = code;
    this.details = { ...details, code };
  }
}

/**
 * Error factory bound to the `invalid_json` code, handed to the shared
 * `@mono-agent/contracts` coercers so their fail-closed throws keep config's
 * typed error shape. The coercers report the field name under `details.env`;
 * every name handed to them is a JSON path (never an environment variable), so
 * it is re-attributed to `details.path` here -- the single translation point
 * between the string coercers and JSON-path diagnostics.
 */
export const invalidJson: ConfigErrorFactory = (message, details) => {
  const { env, ...rest } = details ?? {};
  return new MonoAgentConfigError("invalid_json", message, {
    ...rest,
    ...(typeof env === "string" ? { path: env } : {}),
  });
};
