import { describe, expect, it } from "vitest";

import { MIN_ASSISTANT_CAPTURE_SALIENCE, extractCapturePlanStrict } from "../capture-batch.js";
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
  it("keeps owner-stated facts and standing preferences even when the wording resembles an instruction", async () => {
    const standing = await extractCapturePlanStrict("User: Never book the Maple room again.\nAssistant: Understood.",
      { id: "standing-preference", complete: async () => planJson(["The assistant should never book the Maple room again."]) });
    expect(standing.candidates.map(({ text }) => text)).toEqual(["The assistant should never book the Maple room again."]);
    const factual = await extractCapturePlanStrict("User: Morgan chose the Maple build log as the final artifact.\nAssistant: Noted.",
      { id: "durable-decision", complete: async () => planJson(["Morgan chose the Maple build log as the final artifact."]) });
    expect(factual.candidates).toHaveLength(1);
    const ownerRequest = "User: Please remember Morgan completed the Maple migration on 2026-07-12 after a successful review.\nAssistant: Morgan completed the Maple migration on 2026-07-12 after a successful review.";
    const preserved = await extractCapturePlanStrict(ownerRequest, { id: "owner-request", complete: async (prompt) => {
      expect(prompt).toContain("preserve each durable fact");
      expect(prompt).toContain("even when the Assistant merely restates it");
      expect(prompt).toContain("additional acceptance message is not required");
      return planJson(["Morgan completed the Maple migration on 2026-07-12 after a successful review."]);
    } });
    expect(preserved.candidates).toHaveLength(1);
  });
  it("does not pretend an omitted trigger can be compared with an instruction", async () => {
    const turn = "Scheduled task trigger (not a user message; trigger text omitted):\nAssistant: The Maple build completed on 2026-07-12.";
    const plan = await extractCapturePlanStrict(turn, { id: "trigger-outcome", complete: async (prompt) => {
      expect(prompt).toContain("require verified outcomes or dated consequential state changes");
      return planJson(["The Maple build completed on 2026-07-12."]);
    } }, undefined, [], { observedAt: "2026-07-12T10:00:00.000Z", captureSpeakerKind: "trigger" });
    expect(plan.candidates).toHaveLength(1);
  });
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
    expect(plan.candidates.map((candidate) => candidate.text)).toEqual(memories.slice(0, 3).map((memory) => memory.text));
    expect(plan.entities.map((entity) => entity.id)).toEqual(["concept:secret-garden"]);
  });
  it("drops questions by their trailing mark in any language, leaving requests to the model", async () => {
    const texts = ["When Morgan moved, the project changed hands.", "How Morgan works has changed.",
      "Please summarize the project.", "When did Morgan move?", "¿Cuándo se mudó Morgan?", "Kiedy Morgan się przeprowadził?"];
    const plan = await extractCapturePlanStrict("User: Morgan discussed the project move.",
      { id: "requests", complete: async () => planJson(texts) });
    expect(plan.candidates.map((item) => item.text)).toEqual(texts.slice(0, 3));
  });
  it("keeps only credential safety on the host: narration, doubt and age are the model's rubric", async () => {
    const output = JSON.stringify({ memories: [
      ...["Morgan may have moved to Maple Town.", "Morgan's login email is demo@example.test.",
        "Morgan moved to Maple Town."].map((text, index) => ({ type: "note", text,
        salience: 0.7, isInsight: false, entityIds: index === 1 ? ["login:demo"] : [] })),
    ], entities: [{ id: "login:demo", name: "demo@example.test", type: "login" }], relations: [] });
    const plan = await extractCapturePlanStrict("User: Morgan moved to Maple Town.",
      { id: "hygiene", complete: async (prompt) => {
        expect(prompt).toContain("NEVER store a line beginning with first-person I/my");
        expect(prompt).toContain("Do not invent meta-doubt");
        expect(prompt).toContain("Never store an assistant-stated age or a relative age as a fact");
        return output;
      } });
    expect(plan.candidates.map((item) => item.text)).toEqual(["Morgan may have moved to Maple Town.", "Morgan moved to Maple Town."]);
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
      ["User: Biscuit is 14.5 months old.", "User reported Biscuit was 14.5 months old as of 2026-09-08."],
      ["User: The meeting is tomorrow.", "User reported the meeting is on 2026-09-09."],
      ["User: The meeting is next Friday.", "User reported the meeting is next Friday (said on 2026-09-08)."],
    ] as const) {
      const plan = await extractCapturePlanStrict(text, {
        id: "scripted-absolute-dates",
        complete: async (prompt) => { prompts.push(prompt); return planJson([stored]); },
      }, undefined, [], { observedAt: "2026-09-08T12:00:00.000Z" });
      expect(plan.candidates[0]?.text).toBe(stored);
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
        { type: "note", text: "Morgan lives in Quillmere", salience: 0.8, isInsight: false, entityIds: ["person:morgan", "city:quillmere"] },
      ],
      entities: [
        { id: "person:morgan", name: "Morgan", type: "person" },
        { id: "concept:coffee", name: "Coffee", type: "concept" },
        { id: "city:quillmere", name: "Quillmere", type: "concept" },
      ],
      relations: [],
    })]]);

    await expect(extractCapturePlanStrict("Morgan supplied conflicting preference text and a location.", llm))
      .rejects.toThrow(/capture-extract/iu);
  });

  it("keeps independent attributed facts and rejects a competing attributed variant as one batch", async () => {
    const schedule = "The user reports that Project Atlas's production migration is scheduled for 20 November 2026 at 08:30 CET.";
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
        { id: "person:morgan", name: "  Morgan\nQuillson  ", type: "PERSON!" },
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

describe("extractCapturePlanStrict assistant salience floor", () => {
  const human = (user: string) => ({ observedAt: "2026-07-12T10:00:00.000Z", captureSpeakerKind: "human-turn" as const,
    conversationId: "web:fictional", captureEvidence: { userText: user, toolOutcomes: [] } });
  const memory = (text: string, source: string | undefined, salience: number, entityIds: string[] = []) => ({
    type: "note", text, salience, isInsight: false, entityIds, ...(source === undefined ? {} : { source }) });

  it.each([
    ["en", "Can you check the Maple job?", "The assistant restarted the Maple job at 17:18.", "The assistant found the Maple job fails when Quillmere is offline."],
    ["pl", "Sprawdzisz zadanie Maple?", "Asystent zrestartował zadanie Maple o 17:18.", "Asystent ustalił, że zadanie Maple nie działa bez Quillmere."],
    ["es", "¿Puedes revisar la tarea Maple?", "El asistente reinició la tarea Maple a las 17:18.", "El asistente descubrió que la tarea Maple falla sin Quillmere."],
  ])("drops only low-salience assistant lines (%s), whatever the language", async (_lang, user, status, finding) => {
    const plan = await extractCapturePlanStrict(`User: ${user}\nAssistant: ${finding}`, {
      id: "salience-floor", complete: async () => JSON.stringify({ memories: [
        memory(status, "assistant", 0.45),
        memory(finding, "assistant", MIN_ASSISTANT_CAPTURE_SALIENCE),
        memory("Morgan asked about the Maple job on 2026-07-12.", "user", 0.2),
        memory("A document lists the Maple job owner as Morgan.", "document", 0.2),
      ], entities: [], relations: [] }),
    }, undefined, [], human(user));
    expect(plan.candidates.map((candidate) => candidate.text)).toEqual([
      finding, "Morgan asked about the Maple job on 2026-07-12.", "A document lists the Maple job owner as Morgan.",
    ]);
  });

  it("applies the floor to a user claim the host bounds to assistant, but not to a plan without source", async () => {
    const trigger = { observedAt: "2026-07-12T10:00:00.000Z", captureSpeakerKind: "trigger" as const };
    const bounded = await extractCapturePlanStrict("Scheduled task trigger (trigger text omitted):\nAssistant: Maple sync ran.", {
      id: "trigger-floor", complete: async () => JSON.stringify({ memories: [
        memory("The Maple sync ran at 06:00.", "user", 0.3),
        memory("The Maple sync moved to Quillmere storage on 2026-07-12.", "user", 0.7),
      ], entities: [], relations: [] }),
    }, undefined, [], trigger);
    expect(bounded.candidates.map(({ text, source }) => [text, source]))
      .toEqual([["The Maple sync moved to Quillmere storage on 2026-07-12.", "assistant"]]);
    const legacy = await extractCapturePlanStrict("User: Maple sync?\nAssistant: It ran.", {
      id: "no-source", complete: async () => JSON.stringify({ memories: [memory("The Maple sync ran at 06:00.", undefined, 0.2)],
        entities: [], relations: [] }),
    });
    expect(legacy.candidates.map(({ text }) => text)).toEqual(["The Maple sync ran at 06:00."]);
  });

  it("does not persist an entity or relation named only by a dropped line", async () => {
    const user = "How is Morgan's Maple project going?";
    const plan = await extractCapturePlanStrict(`User: ${user}\nAssistant: Status only.`, {
      id: "floor-graph", complete: async () => JSON.stringify({ memories: [
        memory("The assistant said the Quillmere service schedule is unchanged.", "assistant", 0.3, ["service:quillmere"]),
        memory("Morgan leads the Maple project.", "user", 0.8, ["person:morgan", "project:maple"]),
      ], entities: [
        { id: "person:morgan", name: "Morgan", type: "person" },
        { id: "project:maple", name: "Maple", type: "project" },
        { id: "service:quillmere", name: "Quillmere", type: "service" },
      ], relations: [
        { src: "person:morgan", dst: "project:maple", relation: "leads" },
        { src: "project:maple", dst: "service:quillmere", relation: "uses" },
      ] }),
    }, undefined, [], human(user));
    expect(plan.candidates.map(({ text }) => text)).toEqual(["Morgan leads the Maple project."]);
    expect(plan.entities.map(({ id }) => id)).toEqual(["person:morgan", "project:maple"]);
    expect(plan.relations).toEqual([{ src: "person:morgan", dst: "project:maple", relation: "leads" }]);
  });
});
