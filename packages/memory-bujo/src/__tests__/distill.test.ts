import { describe, expect, it } from "vitest";
import { distill } from "../distill.js";
import { serializeBullet } from "../grammar.js";
import { fakeLlm } from "./helpers.js";

describe("distill", () => {
  it("parses well-formed candidates and normalizes/clamps fields", async () => {
    const llm = fakeLlm([["TEXT:", '```json\n[{"type":"note","text":"Morgan prefers opt-in memory","salience":1.4,"isInsight":true},{"type":"task","text":"ship P2","salience":-1,"isInsight":false}]\n```']]);
    const out = await distill("the team discussed memory", llm);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: "note", isInsight: true });
    expect(out[0]?.salience).toBeLessThanOrEqual(1);
    expect(out[1]?.salience).toBeGreaterThanOrEqual(0);
  });
  it("drops malformed items and returns [] on non-array/empty", async () => {
    expect(await distill("", fakeLlm([]))).toEqual([]);
    const llm = fakeLlm([["TEXT:", '[{"text":""},{"type":"note","text":"valid one","salience":0.5,"isInsight":false}]']]);
    expect((await distill("x", llm)).map((c) => c.text)).toEqual(["valid one"]);
  });
  it("surfaces (rethrows) a model failure from the LLM instead of swallowing to []", async () => {
    // A dead/erroring model must NOT look like "nothing to remember". The error propagates so the
    // capture boundary can log it; the failure names the stage and preserves the underlying cause.
    const throwingLlm = { id: "throws", complete: async () => { throw new Error("ECONNREFUSED"); } };
    await expect(distill("some text", throwingLlm)).rejects.toThrow(/distill/i);
    await expect(distill("some text", throwingLlm)).rejects.toThrow(/ECONNREFUSED/);
  });

  it("normalizes candidate text to a bullet-safe single line (no newlines, no delimiter)", async () => {
    const llm = fakeLlm([["TEXT:", '[{"type":"note","text":"line one\\nline two with <!--mem x stuff","salience":0.5,"isInsight":false}]']]);
    const out = await distill("x", llm);
    expect(out).toHaveLength(1);
    const text = out[0]?.text ?? "";
    expect(text).not.toContain("\n");
    expect(text).not.toContain("<!--mem");
    // The candidate survives normalization and round-trips through serializeBullet without throwing.
    expect(() => serializeBullet({ id: "x", type: "note", status: "open", text, salience: 0.5, isInsight: false, createdAt: "2026-06-15T00:00:00.000Z", refs: [] })).not.toThrow();
  });
});
