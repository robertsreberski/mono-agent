import { describe, expect, it } from "vitest";

import {
  assertSafeBind,
  bearerTokensEqual,
  hostForUrl,
  isLoopbackHost,
  readAuthorizationBearer,
} from "../index.js";

describe("isLoopbackHost", () => {
  it("recognizes loopback forms including the 127/8 range and IPv6", () => {
    for (const host of ["localhost", "127.0.0.1", "127.5.5.5", "::1", "[::1]", "LOCALHOST"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it("rejects public hosts", () => {
    for (const host of ["0.0.0.0", "10.0.0.1", "example.com", "192.168.1.1"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("hostForUrl", () => {
  it("brackets bare IPv6 hosts only", () => {
    expect(hostForUrl("::1")).toBe("[::1]");
    expect(hostForUrl("[::1]")).toBe("[::1]");
    expect(hostForUrl("127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("assertSafeBind", () => {
  it("allows loopback, allows non-loopback when opted in, else throws", () => {
    const makeError = (host: string): Error => new Error(`unsafe:${host}`);
    expect(() => assertSafeBind("127.0.0.1", false, makeError)).not.toThrow();
    expect(() => assertSafeBind("0.0.0.0", true, makeError)).not.toThrow();
    expect(() => assertSafeBind("0.0.0.0", false, makeError)).toThrow("unsafe:0.0.0.0");
  });
});

describe("bearerTokensEqual", () => {
  it("is true only for identical tokens", () => {
    expect(bearerTokensEqual("abc", "abc")).toBe(true);
    expect(bearerTokensEqual("abc", "abd")).toBe(false);
    expect(bearerTokensEqual("abc", "abcd")).toBe(false);
  });
});

describe("readAuthorizationBearer", () => {
  it("parses the bearer credential case-insensitively", () => {
    expect(readAuthorizationBearer("Bearer xyz")).toBe("xyz");
    expect(readAuthorizationBearer("bearer  xyz ")).toBe("xyz");
    expect(readAuthorizationBearer("Basic xyz")).toBeUndefined();
    expect(readAuthorizationBearer(undefined)).toBeUndefined();
    expect(readAuthorizationBearer("Bearer   ")).toBeUndefined();
  });
});
