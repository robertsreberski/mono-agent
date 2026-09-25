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
  it("preserves contact addresses, May dates and secret-named entities but drops credential identifiers", async () => {
    const memories = [
      { type: "note", text: "Morgan's contact address is morgan@example.test.", salience: 0.7,
        isInsight: false, entityIds: ["concept:secret-garden"] },
      { type: "note", text: "May is a good month to visit the Secret Garden.", salience: 0.7,
        isInsight: false, entityIds: ["concept:secret-garden"] },
      { type: "note", text: "MY favorite garden is the Secret Garden.", salience: 0.7,
        isInsight: false, entityIds: ["concept:secret-garden"] },
      { type: "note", text: "Morgan's login email is login@example.test.", salience: 0.7,
        isInsight: false, entityIds: ["login:demo"] },
      { type: "note", text: "The test token is sk-ABCDEFGHIJKLMN.", salience: 0.7,
        isInsight: false, entityIds: [] },
    ];
    const plan = await extractCapturePlanStrict("User: Morgan shared contact details for May.", {
      id: "safe-contacts", complete: async () => JSON.stringify({ memories, entities: [
        { id: "concept:secret-garden", name: "Secret Garden", type: "concept" },
        { id: "login:demo", name: "demo@example.test", type: "login" },
      ], relations: [] }),
    });
    expect(plan.candidates.map((candidate) => candidate.text)).toEqual(memories.slice(0, 2).map((memory) => memory.text));
    expect(plan.entities.map((entity) => entity.id)).toEqual(["concept:secret-garden"]);
  });
  it("keeps durable when/how/what/why lead-ins and drops questions or imperative requests", async () => {
    const texts = ["When Morgan moved, the project changed hands.", "How Morgan works has changed.",
      "What Morgan chose became final.", "Why Morgan moved remains documented.",
      "When did Morgan move?", "Please summarize the project.", "Could you check the project?"];
    const plan = await extractCapturePlanStrict("User: Morgan discussed the project move.",
      { id: "requests", complete: async () => planJson(texts) });
    expect(plan.candidates.map((item) => item.text)).toEqual(texts.slice(0, 4));
  });
  it("drops first-person, invented doubt, ages and credential identities without dropping safe siblings", async () => {
    const output = JSON.stringify({ memories: [
      ...["I visited Maple Town.", "Morgan may have moved to Maple Town.",
        "The assistant reports Morgan is 9 years old.", "Morgan's login email is demo@example.test.",
        "Morgan moved to Maple Town."].map((text, index) => ({ type: "note", text,
        salience: 0.7, isInsight: false, entityIds: index === 3 ? ["login:demo"] : [] })),
    ], entities: [{ id: "login:demo", name: "demo@example.test", type: "login" }], relations: [] });
    const plan = await extractCapturePlanStrict("User: Morgan moved to Maple Town.",
      { id: "hygiene", complete: async () => output });
    expect(plan.candidates.map((item) => item.text)).toEqual(["Morgan moved to Maple Town."]);
    expect(plan.entities).toEqual([]);
  });
  it("instructs fake extraction to retain user facts instead of assistant restatements or invented doubt", async () => {
    const prompts: string[] = [];
    for (const [turn, expected] of [
      ["User: Morgan was born on 17 May 2026.\nAssistant: Morgan was born on 17 May 2026.", ["User reported Morgan was born on 17 May 2026."]],
      ["Scheduled task trigger (not a user message; trigger text omitted):\nAssistant: Previously Morgan was born on 17 May 2026.", []],
      ["User: How do I dress for rain?\nAssistant: Wear a raincoat.", []],
    ] as const) {
      const plan = await extractCapturePlanStrict(turn, {
        id: "scripted-attribution",
        complete: async (prompt) => {
          prompts.push(prompt);
          return planJson(expected);
        },
      });
      expect(plan.candidates.map((candidate) => candidate.text)).toEqual(expected);
    }
    expect(prompts[0]).toContain("the Assistant merely repeats or recaps");
    expect(prompts[0]).toContain("Do not add your own doubt");
    expect(prompts[1]).toContain("NOT a User turn");
    expect(prompts[2]).toContain("generic advice/explanations");
  });
  it("instructs anchored absolute dates rather than persistent relative claims", async () => {
    const prompts: string[] = [];
    for (const [text, stored] of [
      ["User: Morgan is 7.5 months old.", "User reported Morgan was 7.5 months old as of 2026-09-08."],
      ["User: The meeting is tomorrow.", "User reported the meeting is on 2026-09-09."],
      ["User: The meeting is next Friday.", "User reported the meeting is next Friday (said on 2026-09-08)."],
    ] as const) {
      const plan = await extractCapturePlanStrict(text, {
        id: "scripted-absolute-dates",
        complete: async (prompt) => { prompts.push(prompt); return planJson([stored]); },
      }, undefined, [], { observedAt: "2026-09-08T12:00:00.000Z" });
      expect(plan.candidates[0]?.text).toBe(text.includes("months old") ? undefined : stored);
    }
    expect(prompts[0]).toContain("Do not store decaying relative time");
    expect(prompts[0]).toContain("2026-09-08T12:00:00.000Z");
    expect(prompts[1]).toContain("never guess an unstated timezone");
    expect(prompts[2]).toContain("ambiguous weekday-relative phrases retain");
  });

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
