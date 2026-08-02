import { describe, expect, it } from "vitest";
import {
  decodeAcpProviderSessionId,
  decodeAcpSessionCursor,
  encodeAcpProviderSessionId,
  encodeAcpSessionCursor,
  validateAcpProviderSessionId,
} from "../../ai/providers/acp-session-tokens.js";

const TOKEN_KEY = Buffer.alloc(32, 0x11);
const OTHER_TOKEN_KEY = Buffer.alloc(32, 0x22);
const MAX_PROFILE_ID = `p${"x".repeat(127)}`;
const MAX_RAW_TOKEN = "y".repeat(4_096);
const OVER_LIMIT_RAW_TOKEN = `${MAX_RAW_TOKEN}z`;

/** @param {string} value */
function tamperLastCharacter(value) {
  const last = value.at(-1);
  return `${value.slice(0, -1)}${last === "A" ? "B" : "A"}`;
}

describe("ACP opaque token boundaries", () => {
  it("round-trips the exact maximum-size cursor emitted by the v2 encoder", () => {
    const encoded = encodeAcpSessionCursor(MAX_PROFILE_ID, MAX_RAW_TOKEN, TOKEN_KEY);

    expect(encoded).toHaveLength(5_642);
    expect(decodeAcpSessionCursor(MAX_PROFILE_ID, encoded, TOKEN_KEY)).toBe(MAX_RAW_TOKEN);
  });

  it("round-trips an exact maximum-size v2 provider-session handle", () => {
    const encoded = encodeAcpProviderSessionId(MAX_PROFILE_ID, MAX_RAW_TOKEN, TOKEN_KEY);

    expect(encoded).toHaveLength(5_635);
    expect(decodeAcpProviderSessionId(encoded, TOKEN_KEY)).toEqual({
      profileId: MAX_PROFILE_ID,
      sessionId: MAX_RAW_TOKEN,
    });
  });

  it("rejects over-limit raw and sealed values in both directions", () => {
    expect(() => encodeAcpSessionCursor("p", OVER_LIMIT_RAW_TOKEN, TOKEN_KEY))
      .toThrowError(/exceeds 4096 bytes/);
    expect(() => encodeAcpProviderSessionId("p", OVER_LIMIT_RAW_TOKEN, TOKEN_KEY))
      .toThrowError(/exceeds 4096 bytes/);

    const oversizedSealed = Buffer.alloc(12 + 4_097 + 16).toString("base64url");
    expect(() => decodeAcpSessionCursor("p", `acp-cursor:v2:p:${oversizedSealed}`, TOKEN_KEY))
      .toThrowError(/Invalid ACP session cursor/);
    expect(() => decodeAcpProviderSessionId(`acp:v2:p:${oversizedSealed}`, TOKEN_KEY))
      .toThrowError(/Invalid ACP provider session id/);
  });
});

describe("ACP v2 token confidentiality and authenticity", () => {
  it("survives host restart with the same key while hiding the raw session id", () => {
    const raw = "raw-session-sentinel:/with unicode/Ł";
    const first = encodeAcpProviderSessionId("personal-agent", raw, TOKEN_KEY);

    expect(first).toMatch(/^acp:v2:personal-agent:[A-Za-z0-9_-]+$/);
    expect(first).not.toContain(raw);
    expect(first).not.toContain(Buffer.from(raw).toString("base64url"));
    expect(decodeAcpProviderSessionId(first, Buffer.from(TOKEN_KEY)).sessionId).toBe(raw);
  });

  it("uses a fresh random nonce for each handle", () => {
    const first = encodeAcpProviderSessionId("profile", "session-one", TOKEN_KEY);
    const repeated = encodeAcpProviderSessionId("profile", "session-one", TOKEN_KEY);
    const different = encodeAcpProviderSessionId("profile", "session-two", TOKEN_KEY);

    expect(repeated).not.toBe(first);
    expect(different).not.toBe(first);
  });

  it("rejects a wrong key and ciphertext tampering", () => {
    const encoded = encodeAcpProviderSessionId("profile", "session-one", TOKEN_KEY);

    expect(() => decodeAcpProviderSessionId(encoded, OTHER_TOKEN_KEY))
      .toThrowError(/Invalid ACP provider session id/);
    expect(() => decodeAcpProviderSessionId(tamperLastCharacter(encoded), TOKEN_KEY))
      .toThrowError(/Invalid ACP provider session id/);
  });

  it("rejects profile-prefix and token-kind swaps", () => {
    const encoded = encodeAcpProviderSessionId("profile-a", "session-one", TOKEN_KEY);
    const swappedProfile = encoded.replace("acp:v2:profile-a:", "acp:v2:profile-b:");
    const swappedKind = encoded.replace("acp:v2:", "acp-cursor:v2:");

    expect(() => validateAcpProviderSessionId(swappedProfile, "profile-b", TOKEN_KEY))
      .toThrowError(/Invalid ACP provider session id/);
    expect(() => decodeAcpSessionCursor("profile-a", swappedKind, TOKEN_KEY))
      .toThrowError(/Invalid ACP session cursor/);
  });

  it("rejects legacy v1 handles and requires an exact 32-byte binary key", () => {
    const legacy = `acp:v1:profile:${Buffer.from("session-one").toString("base64url")}`;

    expect(() => validateAcpProviderSessionId(legacy, "profile", TOKEN_KEY))
      .toThrowError(/Invalid ACP provider session id/);
    expect(() => encodeAcpProviderSessionId("profile", "session-one", undefined))
      .toThrowError(/exactly 32 bytes/);
    expect(() => encodeAcpProviderSessionId("profile", "session-one", Buffer.alloc(31)))
      .toThrowError(/exactly 32 bytes/);
    expect(() => encodeAcpProviderSessionId("profile", "session-one", "x".repeat(32)))
      .toThrowError(/exactly 32 bytes/);
  });
});
