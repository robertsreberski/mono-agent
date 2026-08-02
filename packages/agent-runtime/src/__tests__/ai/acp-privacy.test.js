import { describe, expect, it } from "vitest";
import {
  ownAcpSessionUpdateKind,
  sanitizeAcpHostValue,
  sanitizeAcpHostValueWithStatus,
} from "../../ai/providers/acp-privacy.js";

describe("ACP host-value privacy sanitizer", () => {
  it("drops protocol metadata and redacts raw-id copies in keys and values", () => {
    const raw = "raw-session-private";
    const result = sanitizeAcpHostValue({
      sessionId: raw,
      session_id: raw,
      title: `Session ${raw}`,
      [`copy-${raw}`]: { value: raw },
      _meta: { nested: raw },
    }, [raw]);

    expect(result).toEqual({
      title: "Session [redacted]",
      "copy-[redacted]": { value: "[redacted]" },
    });
    expect(JSON.stringify(result)).not.toContain(raw);
  });

  it("fails closed on cyclic and over-depth agent values", () => {
    const cyclic = { visible: "ok" };
    cyclic.self = cyclic;
    let deep = { leaf: "raw-session-private" };
    for (let index = 0; index < 80; index += 1) deep = { child: deep };

    const result = sanitizeAcpHostValue({ cyclic, deep }, ["raw-session-private"]);

    expect(result.cyclic).toEqual({ visible: "ok", self: null });
    let cursor = result.deep;
    for (let index = 0; index <= 32 && cursor !== null; index += 1) cursor = cursor.child;
    expect(cursor).toBeNull();
    expect(JSON.stringify(result)).not.toContain("raw-session-private");
  });

  it("stops walking wide agent values at a fixed node budget", () => {
    const wide = Array.from({ length: 10_000 }, (_, index) => ({ index }));
    const { value: result, truncated } = sanitizeAcpHostValueWithStatus(wide);

    expect(truncated).toBe(true);
    expect(result.length).toBeLessThan(wide.length);
    expect(result.length).toBeGreaterThan(0);
  });

  it("copies __proto__ as inert own data on null-prototype objects", () => {
    const source = JSON.parse('{"__proto__":{"polluted":true},"visible":"ok"}');
    const result = sanitizeAcpHostValue(source);

    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result.__proto__).toEqual({ polluted: true });
    expect({}.polluted).toBeUndefined();
  });

  it("never accepts an inherited session-update discriminator", () => {
    const inherited = Object.create({ sessionUpdate: "tool_call" });
    inherited.rawInput = { command: "unsafe" };

    expect(ownAcpSessionUpdateKind(inherited)).toBeNull();
    expect(ownAcpSessionUpdateKind({ sessionUpdate: "tool_call" })).toBe("tool_call");
  });
});
