import { describe, expect, it } from "vitest";

import { extractCapturePlanStrict } from "../capture-batch.js";
import { fakeLlm } from "./helpers.js";

describe("extractCapturePlanStrict intra-turn precision", () => {
  it("rejects lone surrogates without partially accepting the valid candidate", async () => {
    const response = JSON.stringify({
      memories: [
        { type: "note", text: "alpha\ud83dbeta", salience: 0.8, isInsight: false, entityIds: [] },
        { type: "note", text: "gamma\udc00delta", salience: 0.8, isInsight: false, entityIds: [] },
        { type: "note", text: "\ud83d", salience: 0.8, isInsight: false, entityIds: [] },
        { type: "note", text: "valid 🧠 memory", salience: 0.8, isInsight: false, entityIds: [] },
      ],
      entities: [],
      relations: [],
    });
    expect(response).toContain("\\ud83d");
    expect(response).toContain("\\udc00");

    await expect(extractCapturePlanStrict(
      "The model returned legal JSON escapes.",
      fakeLlm([["Extract one bounded", response]]),
    )).rejects.toThrow(/capture-extract/iu);
  });

  it("rejects exact duplicates without merging contradictory fields", async () => {
    const llm = fakeLlm([["Extract one bounded", JSON.stringify({
      memories: [
        { type: "note", text: "Morgan  prefers tea.", salience: 0.8, isInsight: false, entityIds: ["person:morgan"] },
        { type: "task", text: "morgan prefers tea", salience: 0.2, isInsight: true, entityIds: ["concept:tea"] },
      ],
      entities: [
        { id: "person:morgan", name: "Morgan", type: "person" },
        { id: "concept:tea", name: "Tea", type: "concept" },
      ],
      relations: [],
    })]]);

    await expect(extractCapturePlanStrict("Morgan prefers tea.", llm)).rejects.toThrow(/capture-extract/iu);
  });

  it("rejects ambiguous near duplicates without partially retaining distinct facts", async () => {
    const llm = fakeLlm([["Extract one bounded", JSON.stringify({
      memories: [
        { type: "note", text: "Morgan prefers tea", salience: 0.8, isInsight: false, entityIds: ["person:morgan"] },
        { type: "note", text: "Morgan prefers coffee", salience: 0.8, isInsight: false, entityIds: ["person:morgan", "concept:coffee"] },
        { type: "note", text: "Morgan lives in Amsterdam", salience: 0.8, isInsight: false, entityIds: ["person:morgan", "city:amsterdam"] },
      ],
      entities: [
        { id: "person:morgan", name: "Morgan", type: "person" },
        { id: "concept:coffee", name: "Coffee", type: "concept" },
        { id: "city:amsterdam", name: "Amsterdam", type: "concept" },
      ],
      relations: [],
    })]]);

    await expect(extractCapturePlanStrict("Morgan supplied conflicting preference text and a location.", llm)).rejects.toThrow(/capture-extract/iu);
  });

  it("rejects malformed or oversized graph fields without partially accepting valid ones", async () => {
    const huge = "x".repeat(2_000);
    const llm = fakeLlm([["Extract one bounded", JSON.stringify({
      memories: [
        { type: "note", text: "Morgan keeps the bounded graph fact", salience: 0.8, isInsight: false,
          entityIds: ["Person:Morgan", `person:${huge}`, "person:morgan"] },
      ],
      entities: [
        { id: "Person:Morgan", name: "wrong case", type: "person" },
        { id: "person:bad id", name: "bad slug", type: "person" },
        { id: `person:${huge}`, name: "oversized id", type: "person" },
        { id: "person:morgan", name: `Morgan\n${"R".repeat(200)}`, type: "person" },
        { id: "person:morgan", name: "  Morgan\nReberski  ", type: "PERSON!" },
        { id: "project:mono-agent", name: "mono-agent", type: "project" },
      ],
      relations: [
        { src: "person:morgan", dst: "project:mono-agent", relation: huge },
        { src: "person:morgan", dst: "project:mono-agent", relation: "Maintains!" },
        { src: "person:morgan", dst: "project:mono-agent", relation: "maintains 🔥" },
        { src: "person:morgan", dst: "project:mono-agent", relation: "  maintains\ncarefully  " },
        { src: "Person:Morgan", dst: "project:mono-agent", relation: "invalid endpoint" },
      ],
    })]]);

    await expect(extractCapturePlanStrict("Morgan maintains mono-agent.", llm)).rejects.toThrow(/capture-extract/iu);
  });
});
