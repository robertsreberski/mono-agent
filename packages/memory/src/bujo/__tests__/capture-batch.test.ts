import { describe, expect, it } from "vitest";

import { extractCapturePlan } from "../capture-batch.js";
import { fakeLlm } from "./helpers.js";

describe("extractCapturePlan intra-turn precision", () => {
  it("merges normalized exact duplicates and unions only their explicit entity ids", async () => {
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

    const plan = await extractCapturePlan("Morgan prefers tea.", llm);

    expect(plan.candidates).toEqual([expect.objectContaining({
      type: "note",
      text: "Morgan prefers tea.",
      salience: 0.8,
      isInsight: false,
      entityIds: ["concept:tea", "person:morgan"],
    })]);
  });

  it("retains one near-duplicate ambiguity but preserves distinct facts", async () => {
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

    const plan = await extractCapturePlan("Morgan supplied conflicting preference text and a location.", llm);

    expect(plan.candidates.map((candidate) => candidate.text)).toEqual([
      "Morgan prefers tea",
      "Morgan lives in Amsterdam",
    ]);
    expect(plan.candidates[0]?.entityIds).toEqual(["person:morgan"]);
  });
});
