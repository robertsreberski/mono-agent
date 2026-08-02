import { describe, expect, it } from "vitest";
import { sanitizeAcpHostValue } from "../../ai/providers/acp-privacy.js";

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
    const result = sanitizeAcpHostValue(wide);

    expect(result.length).toBeLessThan(wide.length);
    expect(result.length).toBeGreaterThan(0);
  });
});
