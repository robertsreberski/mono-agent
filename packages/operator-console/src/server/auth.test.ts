import { describe, expect, it } from "vitest";

import { generateToken, readBearerToken, tokensEqual } from "./auth.js";

describe("generateToken", () => {
  it("returns a 64-char hex string", () => {
    const t = generateToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("returns a fresh value each call", () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe("tokensEqual", () => {
  it("returns true for identical tokens", () => {
    const t = generateToken();
    expect(tokensEqual(t, t)).toBe(true);
  });

  it("returns false for different tokens", () => {
    expect(tokensEqual(generateToken(), generateToken())).toBe(false);
  });

  it("returns false for different lengths without throwing", () => {
    expect(tokensEqual("abc", "abcd")).toBe(false);
  });
});

describe("readBearerToken", () => {
  it("reads the Authorization header", () => {
    expect(readBearerToken({ authorization: "Bearer xyz" }, "/api/health")).toBe("xyz");
  });

  it("reads the lowercased Authorization header", () => {
    expect(readBearerToken({ Authorization: "bearer xyz" }, "/api/health")).toBe("xyz");
  });

  it("falls back to the ?t= query parameter", () => {
    expect(readBearerToken({}, "/api/config?t=qry-token")).toBe("qry-token");
  });

  it("prefers Authorization over ?t= when both are present", () => {
    expect(
      readBearerToken({ authorization: "Bearer hdr-token" }, "/api/config?t=qry-token"),
    ).toBe("hdr-token");
  });

  it("returns undefined when neither is present", () => {
    expect(readBearerToken({}, "/api/health")).toBeUndefined();
  });
});
