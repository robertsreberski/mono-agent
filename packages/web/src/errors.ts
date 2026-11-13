export interface WebConsoleErrorDetails {
  readonly retryAfterSeconds?: number;
  readonly reason?: string;
  readonly operationId?: string;
  readonly pendingSince?: string;
}

export class WebConsoleError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Readonly<WebConsoleErrorDetails>;

  constructor(code: string, message: string, status = 400, details?: WebConsoleErrorDetails) {
    super(message);
    this.name = "WebConsoleError";
    this.code = code;
    this.status = status;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

/**
 * Keep only explicitly typed, safe details for browser error bodies.
 * `retryAfterSeconds` drives `Retry-After`; `reason` is a bounded machine
 * string allowlisted by the operator-client contract.
 */
export function sanitizeWebConsoleDetails(
  details: Readonly<WebConsoleErrorDetails> | undefined,
): Readonly<WebConsoleErrorDetails> | undefined {
  if (details === undefined) return undefined;
  let retryAfterSeconds: number | undefined;
  const candidate = (details as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  if (typeof candidate === "number"
    && Number.isSafeInteger(candidate)
    && candidate > 0
    && candidate <= 3_600) {
    retryAfterSeconds = candidate;
  }
  let reason: string | undefined;
  const reasonCandidate = (details as { reason?: unknown }).reason;
  if (typeof reasonCandidate === "string"
    && reasonCandidate.length >= 1
    && reasonCandidate.length <= 128
    && /^[A-Za-z0-9_.-]+$/u.test(reasonCandidate)) {
    reason = reasonCandidate;
  }
  let operationId: string | undefined;
  const operationCandidate = (details as { operationId?: unknown }).operationId;
  if (typeof operationCandidate === "string"
    && operationCandidate.length >= 1
    && operationCandidate.length <= 128
    && /^[A-Za-z0-9_.-]+$/u.test(operationCandidate)) {
    operationId = operationCandidate;
  }
  let pendingSince: string | undefined;
  const pendingCandidate = (details as { pendingSince?: unknown }).pendingSince;
  if (typeof pendingCandidate === "string"
    && pendingCandidate.length >= 1
    && pendingCandidate.length <= 64
    && Number.isFinite(Date.parse(pendingCandidate))) {
    pendingSince = pendingCandidate;
  }
  if (retryAfterSeconds === undefined && reason === undefined
    && operationId === undefined && pendingSince === undefined) return undefined;
  return {
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    ...(reason === undefined ? {} : { reason }),
    ...(operationId === undefined ? {} : { operationId }),
    ...(pendingSince === undefined ? {} : { pendingSince }),
  };
}

export interface WebErrorResponse {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<WebConsoleErrorDetails>;
  readonly retryAfterSeconds?: number;
}

const INVALID_JSON_MESSAGE = "The request body is not valid JSON.";
const REQUEST_TOO_LARGE_MESSAGE = "The request body exceeds the size limit.";
const INTERNAL_ERROR_MESSAGE = "Internal server error.";

/**
 * Map any thrown value to a fixed, secret-free browser error body.
 * Parser, size and encoding failures get fixed messages with their established
 * codes; recognized `WebConsoleError` values keep their reviewed messages plus
 * only explicitly typed, safe details; everything else is a fixed 500.
 */
export function resolveWebErrorResponse(error: unknown): WebErrorResponse {
  const known = error instanceof WebConsoleError;
  const bodyParserType = typeof error === "object" && error !== null
    ? (error as { type?: unknown }).type
    : undefined;
  const bodyParserStatus = typeof error === "object" && error !== null
    ? (error as { status?: unknown }).status
    : undefined;
  const isBodyParserError = error instanceof SyntaxError
    || typeof bodyParserType === "string"
    || bodyParserStatus === 400
    || bodyParserStatus === 413
    || bodyParserStatus === 415;
  const tooLarge = bodyParserStatus === 413 || bodyParserType === "entity.too.large";
  const malformed = isBodyParserError && !tooLarge;
  if (known) {
    const details = sanitizeWebConsoleDetails(error.details);
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      ...(details === undefined ? {} : { details }),
      ...(details?.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: details.retryAfterSeconds }),
    };
  }
  if (tooLarge) {
    return { status: 413, code: "request_too_large", message: REQUEST_TOO_LARGE_MESSAGE };
  }
  if (malformed) {
    return { status: 400, code: "invalid_json", message: INVALID_JSON_MESSAGE };
  }
  return { status: 500, code: "internal_error", message: INTERNAL_ERROR_MESSAGE };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}
