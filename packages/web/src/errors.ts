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

  constructor(
    code: string,
    message: string,
    status = 400,
    details?: WebConsoleErrorDetails,
    init?: { cause?: unknown },
  ) {
    super(message, init === undefined ? undefined : { cause: init.cause });
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
 * `retryAfterSeconds` drives `Retry-After`; `reason` is a permitted
 * human-readable field bounded to 128 chars with no control characters or
 * newlines (also enforced where the operator-client contract forwards it);
 * `operationId` stays a machine string and `pendingSince` a valid date string.
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
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(reasonCandidate)) {
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
const UNSUPPORTED_ENCODING_MESSAGE = "The request body uses an unsupported content encoding.";
const INTERNAL_ERROR_MESSAGE = "Internal server error.";

/** Express body-parser error types that map to fixed request-body responses. */
const BODY_PARSER_ERROR_TYPES = new Set([
  "entity.parse.failed",
  "entity.parse.invalid",
  "entity.verify.failed",
  "entity.too.large",
  "charset.unsupported",
  "encoding.unsupported",
]);

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
  // Only genuine body-parser failures count: a known parser `type`, or a
  // SyntaxError carrying the parsed `body` the parser attaches. Any other
  // SyntaxError or typed/statused error is an internal failure, not malformed
  // request JSON.
  const typeText = typeof bodyParserType === "string" ? bodyParserType : undefined;
  const hasParserBody = typeof error === "object" && error !== null
    && typeof (error as { body?: unknown }).body === "string";
  const isBodyParserError = (typeText !== undefined && BODY_PARSER_ERROR_TYPES.has(typeText))
    || (error instanceof SyntaxError && hasParserBody);
  const tooLarge = bodyParserStatus === 413 || typeText === "entity.too.large";
  const unsupportedEncoding = !tooLarge
    && (bodyParserStatus === 415
      || typeText === "charset.unsupported"
      || typeText === "encoding.unsupported");
  const malformed = isBodyParserError && !tooLarge && !unsupportedEncoding;
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
  if (unsupportedEncoding) {
    return { status: 415, code: "unsupported_content_encoding", message: UNSUPPORTED_ENCODING_MESSAGE };
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
