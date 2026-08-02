// @ts-check

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_PROFILE_ID_LENGTH = 128;
const MAX_RAW_TOKEN_BYTES = 4_096;
const TOKEN_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_SEALED_TOKEN_BYTES = NONCE_BYTES + MAX_RAW_TOKEN_BYTES + AUTH_TAG_BYTES;
const MAX_ENCODED_TOKEN_LENGTH = Math.ceil(MAX_SEALED_TOKEN_BYTES * 4 / 3);
const PROVIDER_SESSION_PREFIX = "acp:v2:";
const SESSION_CURSOR_PREFIX = "acp-cursor:v2:";
const MAX_PROVIDER_SESSION_ID_LENGTH = PROVIDER_SESSION_PREFIX.length
  + MAX_PROFILE_ID_LENGTH + 1 + MAX_ENCODED_TOKEN_LENGTH;
const MAX_SESSION_CURSOR_LENGTH = SESSION_CURSOR_PREFIX.length
  + MAX_PROFILE_ID_LENGTH + 1 + MAX_ENCODED_TOKEN_LENGTH;
const TOKEN_DOMAIN = Buffer.from("mono-agent/acp-session-token", "utf8");
const TOKEN_VERSION = Buffer.from("v2", "utf8");
const HKDF_SALT = Buffer.from("mono-agent/acp-session-token/v2/hkdf", "utf8");
const ENCRYPTION_INFO = Buffer.from("mono-agent/acp-session-token/v2/encryption", "utf8");

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

/**
 * The token key is binary on purpose: accepting textual secrets here would
 * make encoding, truncation, and cross-host persistence ambiguous.
 * @param {unknown} value
 */
function sessionTokenKey(value) {
  if (!(value instanceof Uint8Array) || value.byteLength !== TOKEN_KEY_BYTES) {
    throw new AcpClientError(
      "invalid_token_key",
      `ACP session token key must be exactly ${TOKEN_KEY_BYTES} bytes.`,
    );
  }
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** @param {unknown} key @returns {Uint8Array} */
export function validateAcpSessionTokenKey(key) {
  sessionTokenKey(key);
  return /** @type {Uint8Array} */ (key);
}

/** @param {ReadonlyArray<Uint8Array>} parts */
function frame(parts) {
  const size = parts.reduce((total, part) => total + 4 + part.byteLength, 0);
  const result = Buffer.allocUnsafe(size);
  let offset = 0;
  for (const part of parts) {
    result.writeUInt32BE(part.byteLength, offset);
    offset += 4;
    Buffer.from(part.buffer, part.byteOffset, part.byteLength).copy(result, offset);
    offset += part.byteLength;
  }
  return result;
}

/** @param {"session"|"cursor"} kind @param {string} profileId */
function tokenAad(kind, profileId) {
  return frame([
    TOKEN_DOMAIN,
    TOKEN_VERSION,
    Buffer.from(kind, "utf8"),
    Buffer.from(profileId, "utf8"),
  ]);
}

/** @param {Uint8Array} key */
function encryptionKey(key) {
  const rawKey = Buffer.from(sessionTokenKey(key));
  try {
    return Buffer.from(hkdfSync("sha256", rawKey, HKDF_SALT, ENCRYPTION_INFO, TOKEN_KEY_BYTES));
  } finally {
    rawKey.fill(0);
  }
}

/** @param {string} profileId @param {string} raw @param {string} code @param {string} label */
function rawTokenBytes(profileId, raw, code, label) {
  validateAcpProfileId(profileId);
  requiredTokenString(raw, code, label);
  const plaintext = Buffer.from(raw, "utf8");
  if (plaintext.byteLength > MAX_RAW_TOKEN_BYTES) {
    throw new AcpClientError(code, `${label} exceeds ${MAX_RAW_TOKEN_BYTES} bytes.`);
  }
  return plaintext;
}

/**
 * @param {"session"|"cursor"} kind
 * @param {string} profileId
 * @param {string} raw
 * @param {Uint8Array} key
 * @param {string} code
 * @param {string} label
 */
function sealToken(kind, profileId, raw, key, code, label) {
  const plaintext = rawTokenBytes(profileId, raw, code, label);
  const aad = tokenAad(kind, profileId);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(key), nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64url");
}

/** @param {string} profileId @param {string} code @param {string} label */
function tokenProfileId(profileId, code, label) {
  try {
    return validateAcpProfileId(profileId);
  } catch {
    throw new AcpClientError(code, `Invalid ${label}.`);
  }
}

/**
 * @param {string} encoded
 * @param {string} code
 * @param {string} label
 */
function sealedTokenBytes(encoded, code, label) {
  if (!BASE64URL_RE.test(encoded)) throw new AcpClientError(code, `Invalid ${label}.`);
  const sealed = Buffer.from(encoded, "base64url");
  if (sealed.toString("base64url") !== encoded
    || sealed.byteLength <= NONCE_BYTES + AUTH_TAG_BYTES
    || sealed.byteLength > MAX_SEALED_TOKEN_BYTES) {
    throw new AcpClientError(code, `Invalid ${label}.`);
  }
  return sealed;
}

/**
 * @param {"session"|"cursor"} kind
 * @param {string} profileId
 * @param {string} encoded
 * @param {Uint8Array} key
 * @param {string} code
 * @param {string} label
 */
function openToken(kind, profileId, encoded, key, code, label) {
  const sealed = sealedTokenBytes(encoded, code, label);
  const aad = tokenAad(kind, profileId);
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const ciphertext = sealed.subarray(NONCE_BYTES, -AUTH_TAG_BYTES);
  const authTag = sealed.subarray(-AUTH_TAG_BYTES);
  const derivedKey = encryptionKey(key);
  let plaintext;
  try {
    const decipher = createDecipheriv("aes-256-gcm", derivedKey, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new AcpClientError(code, `Invalid ${label}.`);
  }
  try {
    return requiredTokenString(
      new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
      code,
      label,
    );
  } catch (error) {
    if (error instanceof AcpClientError) throw error;
    throw new AcpClientError(code, `Invalid ${label}.`);
  }
}

/** @param {string} profileId @param {string} sessionId @param {Uint8Array} key */
export function encodeAcpProviderSessionId(profileId, sessionId, key) {
  const encoded = sealToken("session", profileId, sessionId, key, "invalid_session_id", "ACP session id");
  return `${PROVIDER_SESSION_PREFIX}${profileId}:${encoded}`;
}

/**
 * Internal protocol-state decoder. This module is not a package export.
 * @param {string} providerSessionId
 * @param {Uint8Array} key
 */
export function decodeAcpProviderSessionId(providerSessionId, key) {
  if (typeof providerSessionId !== "string" || providerSessionId.length > MAX_PROVIDER_SESSION_ID_LENGTH) {
    throw new AcpClientError("invalid_session_id", "Invalid ACP provider session id.");
  }
  const match = /^acp:v2:([^:]+):([^:]+)$/.exec(providerSessionId);
  if (!match) throw new AcpClientError("invalid_session_id", "Invalid ACP provider session id.");
  const profileId = tokenProfileId(match[1], "invalid_session_id", "ACP provider session id");
  const sessionId = openToken(
    "session",
    profileId,
    match[2],
    key,
    "invalid_session_id",
    "ACP provider session id",
  );
  return { profileId, sessionId };
}

/**
 * Validate an opaque provider-session handle and its profile binding without
 * exposing the remote agent's protocol session id.
 *
 * @param {string} providerSessionId
 * @param {string} expectedProfileId
 * @param {Uint8Array} key Host-owned 32-byte ACP session-token key.
 * @returns {string}
 */
export function validateAcpProviderSessionId(providerSessionId, expectedProfileId, key) {
  const profileId = validateAcpProfileId(expectedProfileId);
  const decoded = decodeAcpProviderSessionId(providerSessionId, key);
  if (decoded.profileId !== profileId) {
    throw new AcpClientError("invalid_session_id", "ACP provider session belongs to a different profile.");
  }
  return providerSessionId;
}

/** @param {string} profileId @param {string} cursor @param {Uint8Array} key */
export function encodeAcpSessionCursor(profileId, cursor, key) {
  const encoded = sealToken("cursor", profileId, cursor, key, "invalid_cursor", "ACP session cursor");
  return `${SESSION_CURSOR_PREFIX}${profileId}:${encoded}`;
}

/** @param {string} profileId @param {unknown} cursor @param {Uint8Array} key */
export function decodeAcpSessionCursor(profileId, cursor, key) {
  validateAcpProfileId(profileId);
  if (typeof cursor !== "string" || cursor.length > MAX_SESSION_CURSOR_LENGTH) {
    throw new AcpClientError("invalid_cursor", "ACP session cursor must be an opaque cursor returned by listAcpSessions.");
  }
  const match = /^acp-cursor:v2:([^:]+):([^:]+)$/.exec(cursor);
  if (!match || tokenProfileId(match[1], "invalid_cursor", "ACP session cursor") !== profileId) {
    throw new AcpClientError("invalid_cursor", "ACP session cursor is invalid for this profile.");
  }
  return openToken("cursor", profileId, match[2], key, "invalid_cursor", "ACP session cursor");
}
