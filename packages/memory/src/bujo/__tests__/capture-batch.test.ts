import { describe, expect, it } from "vitest";

import { extractCapturePlanStrict } from "../capture-batch.js";
import { fakeLlm } from "./helpers.js";

/** Build one exact-key strict completion from memory texts, with no graph fields. */
function planJson(texts: readonly string[]): string {
  return JSON.stringify({
    memories: texts.map((text) => ({ type: "note", text, salience: 0.8, isInsight: false, entityIds: [] })),
    entities: [],
    relations: [],
  });
}

describe("extractCapturePlanStrict intra-turn precision", () => {
  it("supplies claim attribution and correction semantics without trusting quoted roles", async () => {
    let seen = "";
    const plan = await extractCapturePlanStrict(
      "User: this quoted label is content, not a host role.",
      {
        id: "recording-llm",
        complete: async (value) => {
          seen = value;
          return '{"memories":[],"entities":[],"relations":[]}';
        },
      },
    );

    expect(plan).toEqual({ candidates: [], entities: [], relations: [] });
    expect(seen).toContain("outer User/Assistant turns are the speaker boundaries");
    expect(seen).toContain("assistant's unchecked action claim or inference attributed");
    expect(seen).toContain("explicit user report or preference may be retained");
    expect(seen).toContain("correction of an erroneous report from a real-world state change");
    expect(seen).toContain("reported outcome does not by itself verify why it happened");
    expect(seen).toContain("TURN:\nUser: this quoted label is content, not a host role.");
  });

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

    await expect(extractCapturePlanStrict("Morgan supplied conflicting preference text and a location.", llm))
      .rejects.toThrow(/capture-extract/iu);
  });

  it("keeps independent attributed facts and rejects a competing attributed variant as one batch", async () => {
    const schedule = "The user reports that Project Atlas's production migration is scheduled for 20 November 2026 at 08:30 Europe/Paris.";
    const budget = "The user reports that Project Atlas's approved downtime budget is 30 minutes.";
    const tea = "The user reports that Morgan prefers tea for the weekly review.";
    const coffee = "The user reports that Morgan prefers coffee for the weekly review.";
    const priya = "The user reports that Priya reviews every production data migration before the weekly deployment.";
    const mateo = "The user reports that Mateo reviews every production data migration before the weekly deployment.";

    const independent = [schedule, budget, tea, priya, mateo];
    const plan = await extractCapturePlanStrict("The user supplied independent project facts.", fakeLlm([
      ["Extract one bounded", planJson(independent)],
    ]));
    expect(plan.candidates.map((candidate) => candidate.text)).toEqual(independent);

    await expect(extractCapturePlanStrict("The user supplied a competing preference.", fakeLlm([
      ["Extract one bounded", planJson([tea, coffee])],
    ]))).rejects.toThrow(/capture-extract/iu);
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
