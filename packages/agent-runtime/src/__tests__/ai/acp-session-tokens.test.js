import { describe, expect, it } from "vitest";
import {
  decodeAcpProviderSessionId,
  decodeAcpSessionCursor,
  encodeAcpProviderSessionId,
  encodeAcpSessionCursor,
} from "../../ai/providers/acp-session-tokens.js";

const MAX_PROFILE_ID = `p${"x".repeat(127)}`;
const MAX_RAW_TOKEN = "y".repeat(4_096);
const OVER_LIMIT_RAW_TOKEN = `${MAX_RAW_TOKEN}z`;

describe("ACP opaque token boundaries", () => {
  it("round-trips the exact maximum-size cursor emitted by the encoder", () => {
    const encoded = encodeAcpSessionCursor(MAX_PROFILE_ID, MAX_RAW_TOKEN);

    expect(encoded).toHaveLength(5_605);
    expect(decodeAcpSessionCursor(MAX_PROFILE_ID, encoded)).toBe(MAX_RAW_TOKEN);
  });

  it("round-trips an exact maximum-size provider-session handle", () => {
    const encoded = encodeAcpProviderSessionId(MAX_PROFILE_ID, MAX_RAW_TOKEN);

    expect(encoded).toHaveLength(5_598);
    expect(decodeAcpProviderSessionId(encoded)).toEqual({
      profileId: MAX_PROFILE_ID,
      sessionId: MAX_RAW_TOKEN,
    });
  });

  it("rejects over-limit raw values in both encoder and decoder directions", () => {
    expect(() => encodeAcpSessionCursor("p", OVER_LIMIT_RAW_TOKEN))
      .toThrowError(/exceeds 4096 bytes/);
    expect(() => encodeAcpProviderSessionId("p", OVER_LIMIT_RAW_TOKEN))
      .toThrowError(/exceeds 4096 bytes/);

    const encoded = Buffer.from(OVER_LIMIT_RAW_TOKEN, "utf8").toString("base64url");
    expect(() => decodeAcpSessionCursor("p", `acp-cursor:v1:p:${encoded}`))
      .toThrowError(/exceeds 4096 bytes/);
    expect(() => decodeAcpProviderSessionId(`acp:v1:p:${encoded}`))
      .toThrowError(/exceeds 4096 bytes/);
  });
});
