import { describe, expect, it } from "vitest";
import { distill } from "../distill.js";
import { fakeLlm } from "./helpers.js";

describe("distill", () => {
  it("parses well-formed candidates and normalizes/clamps fields", async () => {
    const llm = fakeLlm([["TEXT:", '```json\n[{"type":"note","text":"Robert prefers opt-in memory","salience":1.4,"isInsight":true},{"type":"task","text":"ship P2","salience":-1,"isInsight":false}]\n```']]);
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
});
