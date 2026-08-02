// @ts-check

const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_PROFILE_ID_LENGTH = 128;
const MAX_RAW_TOKEN_BYTES = 4_096;
const MAX_ENCODED_TOKEN_LENGTH = Math.ceil(MAX_RAW_TOKEN_BYTES * 4 / 3);
const PROVIDER_SESSION_PREFIX = "acp:v1:";
const SESSION_CURSOR_PREFIX = "acp-cursor:v1:";
const MAX_PROVIDER_SESSION_ID_LENGTH = PROVIDER_SESSION_PREFIX.length
  + MAX_PROFILE_ID_LENGTH + 1 + MAX_ENCODED_TOKEN_LENGTH;
const MAX_SESSION_CURSOR_LENGTH = SESSION_CURSOR_PREFIX.length
  + MAX_PROFILE_ID_LENGTH + 1 + MAX_ENCODED_TOKEN_LENGTH;

export class AcpClientError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AcpClientError";
    this.code = code;
    this.details = { ...details, code };
  }
}

/** @param {string} profileId @returns {string} */
export function validateAcpProfileId(profileId) {
  if (typeof profileId !== "string" || !PROFILE_ID_RE.test(profileId)) {
    throw new AcpClientError(
      "invalid_profile_id",
      "ACP profile id must use 1-128 ASCII letters, digits, dots, underscores, or hyphens and start alphanumeric.",
    );
  }
  return profileId;
}

/** @param {unknown} value @param {string} code @param {string} label */
function requiredTokenString(value, code, label) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.includes("\0")) {
    throw new AcpClientError(code, `${label} must be a non-empty trimmed string without NUL bytes.`);
  }
  return value;
}

/** @param {string} encoded @param {string} code @param {string} label */
function decodeToken(encoded, code, label) {
  if (!BASE64URL_RE.test(encoded)) throw new AcpClientError(code, `Invalid ${label} encoding.`);
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length === 0 || bytes.toString("base64url") !== encoded) {
    throw new AcpClientError(code, `Non-canonical ${label} encoding.`);
  }
  if (bytes.length > MAX_RAW_TOKEN_BYTES) {
    throw new AcpClientError(code, `${label} exceeds ${MAX_RAW_TOKEN_BYTES} bytes.`);
  }
  try {
    return requiredTokenString(new TextDecoder("utf-8", { fatal: true }).decode(bytes), code, label);
  } catch (error) {
    if (error instanceof AcpClientError) throw error;
    throw new AcpClientError(code, `${label} is not valid UTF-8.`);
  }
}

/** @param {string} profileId @param {string} sessionId */
export function encodeAcpProviderSessionId(profileId, sessionId) {
  validateAcpProfileId(profileId);
  requiredTokenString(sessionId, "invalid_session_id", "ACP session id");
  if (Buffer.byteLength(sessionId, "utf8") > MAX_RAW_TOKEN_BYTES) {
    throw new AcpClientError("invalid_session_id", `ACP session id exceeds ${MAX_RAW_TOKEN_BYTES} bytes.`);
  }
  return `${PROVIDER_SESSION_PREFIX}${profileId}:${Buffer.from(sessionId, "utf8").toString("base64url")}`;
}

/** Internal protocol-state decoder. This module is not a package export. @param {string} providerSessionId */
export function decodeAcpProviderSessionId(providerSessionId) {
  if (typeof providerSessionId !== "string") {
    throw new AcpClientError("invalid_session_id", "ACP provider session id must be a string.");
  }
  if (providerSessionId.length > MAX_PROVIDER_SESSION_ID_LENGTH) {
    throw new AcpClientError("invalid_session_id", "ACP provider session id exceeds the supported length.");
  }
  const match = /^acp:v1:([^:]+):([^:]+)$/.exec(providerSessionId);
  if (!match) throw new AcpClientError("invalid_session_id", "Invalid ACP provider session id.");
  const profileId = validateAcpProfileId(match[1]);
  const sessionId = decodeToken(match[2], "invalid_session_id", "ACP session id");
  return { profileId, sessionId };
}

/**
 * Validate an opaque provider-session handle and its profile binding without
 * exposing the remote agent's protocol session id.
 *
 * @param {string} providerSessionId
 * @param {string} expectedProfileId
 * @returns {string}
 */
export function validateAcpProviderSessionId(providerSessionId, expectedProfileId) {
  const profileId = validateAcpProfileId(expectedProfileId);
  const decoded = decodeAcpProviderSessionId(providerSessionId);
  if (decoded.profileId !== profileId) {
    throw new AcpClientError("invalid_session_id", "ACP provider session belongs to a different profile.");
  }
  return providerSessionId;
}

/** @param {string} profileId @param {string} cursor */
export function encodeAcpSessionCursor(profileId, cursor) {
  validateAcpProfileId(profileId);
  requiredTokenString(cursor, "invalid_cursor", "ACP session cursor");
  if (Buffer.byteLength(cursor, "utf8") > MAX_RAW_TOKEN_BYTES) {
    throw new AcpClientError("invalid_cursor", `ACP session cursor exceeds ${MAX_RAW_TOKEN_BYTES} bytes.`);
  }
  return `${SESSION_CURSOR_PREFIX}${profileId}:${Buffer.from(cursor, "utf8").toString("base64url")}`;
}

/** @param {string} profileId @param {unknown} cursor */
export function decodeAcpSessionCursor(profileId, cursor) {
  validateAcpProfileId(profileId);
  if (typeof cursor !== "string" || cursor.length > MAX_SESSION_CURSOR_LENGTH) {
    throw new AcpClientError("invalid_cursor", "ACP session cursor must be an opaque cursor returned by listAcpSessions.");
  }
  const match = /^acp-cursor:v1:([^:]+):([^:]+)$/.exec(cursor);
  if (!match || match[1] !== profileId) {
    throw new AcpClientError("invalid_cursor", "ACP session cursor is invalid for this profile.");
  }
  return decodeToken(match[2], "invalid_cursor", "ACP session cursor");
}
