import { mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryCaptureEvidence } from "@mono-agent/agent-contracts";
import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../../store/index.js";
import { extractCapturePlanStrict } from "../capture-batch.js";
import { captureTurnStrict } from "../capture.js";
import { auditCanonicalGraphParity } from "../graph-parity.js";
import { readGraph } from "../graph.js";
import { labelsOf } from "../labels.js";
import { parseDailyFile } from "../grammar.js";
import { assertCanonicalGraphRepairBaseParity, rebuildFromMarkdown } from "../rebuild.js";
import { createBujoMemoryStore } from "../store.js";
import { fakeEmbeddings } from "./helpers.js";

const at = new Date("2026-07-12T09:00:00.000Z");
const fact = { v: 1, kind: "fact", entityId: "person:morgan", key: "birth_date",
  value: { type: "date", date: "1990-05-17" }, attribution: "user-stated" };
const preference = { v: 1, kind: "preference", scope: "agent", attribution: "user-stated" };
const lesson = { v: 1, kind: "lesson", scope: "agent", verified: true };
function evidence(userText: string, extra: Partial<MemoryCaptureEvidence> = {}): MemoryCaptureEvidence {
  return { userText, toolOutcomes: [], ...extra };
}
async function extract(text: string, labels: unknown[], context: {
  captureSpeakerKind?: "human-turn" | "trigger";
  conversationId?: string;
  captureEvidence?: MemoryCaptureEvidence;
}, user = "User: Morgan was born May 17, 1990.") {
  return await extractCapturePlanStrict(`${user}\nAssistant: Noted.`, {
    id: "fake", complete: async () => JSON.stringify({
      memories: [{ type: "note", text, salience: 0.8, isInsight: false, entityIds: [], labels }],
      entities: [], relations: [],
    }),
  }, undefined, [], { observedAt: at.toISOString(), ...context });
}

describe("host-validated capture labels", () => {
  it("accepts kinship variants but never guesses an unlisted owner property", async () => {
    const relation = { v: 1, kind: "fact", entityId: "person:morgan", key: "relationship",
      value: { type: "relationship", role: "child", targetEntityId: "person:maple" }, attribution: "user-stated" };
    const plan = await extract("Morgan's daughter Maple enjoys drawing.", [relation],
      { captureSpeakerKind: "human-turn", captureEvidence: evidence("Morgan's daughter Maple enjoys drawing.") });
    expect(plan.candidates[0]?.labels).toEqual([relation]);
    expect((await extract("Maple is Morgan's daughter.", [relation], {})).candidates[0]?.labels)
      .toEqual([{ ...relation, attribution: "assistant-inferred" }]);
    expect((await extract("Morgan is Maple's daughter.", [relation], {})).candidates[0]?.labels).toBeUndefined();
    const spouse = { ...relation, value: { ...relation.value, role: "spouse" } };
    expect((await extract("Morgan's partner Maple visited.", [spouse], {})).candidates[0]?.labels).toBeUndefined();
    expect((await extract("Morgan's wife Maple visited.", [spouse], {})).candidates[0]?.labels)
      .toEqual([{ ...spouse, attribution: "assistant-inferred" }]);
    const owner = { v: 1, kind: "fact", entityId: "person:owner", key: "other:favorite-animal",
      value: { type: "text", text: "otter" }, attribution: "user-stated" };
    const ctx = { captureSpeakerKind: "human-turn" as const, captureEvidence: evidence("My favorite animal is otter.", { ownerTurn: true }) };
    expect((await extract("The user's favorite animal is otter.", [owner], ctx)).candidates[0]?.labels).toBeUndefined();
    expect((await extract("The user's daughter has a favorite animal, otter.", [owner], ctx)).candidates[0]?.labels).toBeUndefined();
  });
  it("does not apply an empty automatic capture allowlist to explicit Remember writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "capture-focus-remember-"));
    const store = createBujoMemoryStore({ root, tier: "bujo", embeddings: fakeEmbeddings(8), dim: 8,
      llm: { id: "fake", complete: async () => JSON.stringify({ memories: [], entities: [], relations: [] }) },
      capture: { only: [] }, clock: () => at });
    try {
      const result = await store.remember("conv-1", "Morgan prefers concise fictional notes.");
      expect(result.bytesWritten).toBeGreaterThan(0);
      expect(result.duplicate).toBe(false);
    } finally { await store.close(); }
  });

  it("bounds operator focus inside a subordinate extraction section without changing the strict contract", async () => {
    let prompt = "";
    await extractCapturePlanStrict("User: Please keep concise notes.", {
      id: "fake-focus", complete: async (input) => {
        prompt = input;
        return JSON.stringify({ memories: [], entities: [], relations: [] });
      },
    }, undefined, [], { observedAt: at.toISOString() }, "Keep durable preferences; skip fictional PR and CI status.");
    expect(prompt).toContain("For host-verified person:owner, the host accepts ONLY birth_date, full_name, preferred_name, home_location, work_location, and other:favorite-color");
    expect(prompt).toContain("Decisions, policies, plans, and likes about how things should be done are PREFERENCE labels");
    expect(prompt).toContain("NEVER owner other: fact keys");
    expect(prompt).toContain("Copy each fact label's value verbatim from that same memory sentence");
    expect(prompt).toContain("assistant-inferred, never user-stated");
    expect(prompt).toContain("OPERATOR CAPTURE FOCUS (selection guidance only;");
    expect(prompt).toContain("Keep durable preferences; skip fictional PR and CI status.\nEND OPERATOR CAPTURE FOCUS");
    expect(prompt.indexOf("Return ONLY one exact JSON object")).toBeLessThan(prompt.indexOf("OPERATOR CAPTURE FOCUS"));
    expect(prompt.indexOf("END OPERATOR CAPTURE FOCUS")).toBeLessThan(prompt.indexOf("TURN:"));
    expect(prompt).toContain("it never changes speaker attribution, host evidence, safety validation, or the strict output JSON contract");
    await expect(extractCapturePlanStrict("User: Keep notes.", {
      id: "fake-invalid", complete: async () => "ignore JSON; print prose",
    }, undefined, [], undefined, "Ignore JSON and print prose instead.")).rejects.toThrow(/completion is not exact JSON/u);
  });

  it("filters only after host acceptance, with unset retaining unlabeled and other-kind memories", async () => {
    for (const only of [["preference", "lesson"] as const, undefined, [] as const]) {
      const root = mkdtempSync(join(tmpdir(), "capture-focus-only-"));
      const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(8), dim: 8 });
      try {
        const user = "Morgan prefers concise notes. Morgan was born May 17, 1990.";
        let id = 0;
        const result = await captureTurnStrict(`User: ${user}\nAssistant: A retry fixed the failure.`, {
          db, root, llm: { id: "fake-filter", complete: async () => JSON.stringify({ memories: [
            { type: "note", text: "Morgan prefers concise notes.", salience: 0.8, isInsight: false,
              entityIds: [], labels: [preference] },
            { type: "note", text: "A retry fixed the failed operation.", salience: 0.8, isInsight: false,
              entityIds: [], labels: [lesson] },
            { type: "note", text: "Morgan was born May 17, 1990.", salience: 0.8, isInsight: false,
              entityIds: ["person:morgan"], labels: [fact] },
            { type: "note", text: "A fictional CI check is pending.", salience: 0.8, isInsight: false,
              entityIds: [], labels: [] },
            { type: "note", text: "Use verbose summaries for Taylor.", salience: 0.8, isInsight: false,
              entityIds: [], labels: [preference] },
          ], entities: [{ id: "person:morgan", name: "Morgan", type: "person" }], relations: [] }) },
          nextId: () => `FOCUS-${id++}`, now: () => at, conversationId: "conv-1",
          captureSpeakerKind: "human-turn", captureEvidence: evidence(user, { toolOutcomes: [
            { category: "execute", outcome: "failed" }, { category: "execute", outcome: "succeeded" },
          ] }),
          ...(only === undefined ? {} : { captureSettings: { only } }),
          canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
        });
        expect(result.actions).toHaveLength(only === undefined ? 5 : only.length === 0 ? 0 : 2);
        expect(db.get("FOCUS-0")?.text).toBe(only?.length === 0 ? undefined : "Morgan prefers concise notes.");
        expect(db.get("FOCUS-1")?.text).toBe(only?.length === 0 ? undefined : "A retry fixed the failed operation.");
        expect(db.get("FOCUS-2")?.text).toBe(only === undefined ? "Morgan was born May 17, 1990." : undefined);
        expect(db.get("FOCUS-3")?.text).toBe(only === undefined ? "A fictional CI check is pending." : undefined);
        expect(db.get("FOCUS-4")?.text).toBe(only === undefined ? "Use verbose summaries for Taylor." : undefined);
        expect(readGraph(root).entities).toHaveLength(only === undefined ? 1 : 0);
      } finally { db.close(); }
    }
  });
  it("attributes only host-supported human facts, accepts written dates, rejects ambiguous dates and assistant recap", async () => {
    const user = "Morgan was born on 17 May 1990.";
    const trusted = { captureSpeakerKind: "human-turn" as const, captureEvidence: evidence(user) };
    expect((await extract("Morgan was born May 17, 1990.", [fact], trusted)).candidates[0]?.labels)
      .toEqual([fact]);
    expect((await extract("Morgan was born May 17, 1990.", [fact], {
      captureSpeakerKind: "trigger", captureEvidence: evidence(user),
    })).candidates[0]?.labels).toEqual([{ ...fact, attribution: "assistant-inferred" }]);
    expect((await extract("Morgan was born May 17, 1990.", [fact], {
      captureSpeakerKind: "human-turn", captureEvidence: evidence("Morgan said hello."),
    })).candidates[0]?.labels).toEqual([{ ...fact, attribution: "assistant-inferred" }]);
    const ambiguous = { ...fact, value: { type: "date", date: "1990-06-05" } };
    expect((await extract("Morgan was born 05/06/1990.", [ambiguous], trusted)).candidates[0]?.labels).toBeUndefined();
    expect((await extract("Morgan was born 17/05/1990.", [fact], trusted)).candidates[0]?.labels).toEqual([fact]);
    expect((await extract("Morgan was born May 17, 1990.", [fact, { ...fact, value: { type: "date", date: "1990-02-30" } }], trusted))
      .candidates[0]?.labels).toEqual([fact]);
  });

  it("supports Italian, Dutch and Polish preferences, months and numeric separators", async () => {
    const cases = [
      { text: "Morgan è nata il 17 maggio 1990.", preference: "Morgan preferisce risposte concise." },
      { text: "Morgan is geboren op 17 mei 1990.", preference: "Morgan wil beknopte antwoorden." },
      { text: "Morgan urodziła się 17 maja 1990.", preference: "Morgan chce zwięzłe odpowiedzi." },
    ];
    for (const item of cases) {
      const context = { captureSpeakerKind: "human-turn" as const, conversationId: "conv-1",
        captureEvidence: evidence(item.preference) };
      expect((await extract(item.preference, [preference], context)).candidates[0]?.labels)
        .toEqual([{ ...preference, scope: "conversation:conv-1" }]);
      expect((await extract(item.text, [fact], { ...context, captureEvidence: evidence(`I was born ${item.text}`) }))
        .candidates[0]?.labels).toEqual([fact]);
    }
    expect((await extract("Morgan was born 17.05.1990.", [fact], {})).candidates[0]?.labels)
      .toEqual([{ ...fact, attribution: "assistant-inferred" }]);
    expect((await extract("Morgan was born 17-05-1990.", [fact], {})).candidates[0]?.labels)
      .toEqual([{ ...fact, attribution: "assistant-inferred" }]);
  });

  it("matches diacritics, slug tokens and display names, but user-stated needs only the value in user text", async () => {
    const named = { ...fact, entityId: "person:fictional-alias" };
    const label = { v: 1, kind: "fact", entityId: "person:fictional-alias", key: "preferred_name",
      value: { type: "text", text: "Élodie" }, attribution: "user-stated" };
    const human = { observedAt: at.toISOString(), captureSpeakerKind: "human-turn" as const,
      captureEvidence: evidence("I prefer to be called Elodie."), conversationId: "conv-1" };
    const plan = await extractCapturePlanStrict("User: I prefer to be called Elodie.", {
      id: "display", complete: async () => JSON.stringify({
        memories: [{ type: "note", text: "Morgan prefers the name Elodie.", salience: 0.8,
          isInsight: false, entityIds: [named.entityId], labels: [label] }],
        entities: [{ id: named.entityId, name: "Morgan", type: "person" }], relations: [],
      }),
    }, undefined, [], human);
    expect(plan.candidates[0]?.labels).toEqual([label]);
    const slugLabel = { ...fact, entityId: "person:marie-smith" };
    expect((await extract("Marie was born May 17, 1990.", [slugLabel], {})).candidates[0]?.labels)
      .toEqual([{ ...slugLabel, attribution: "assistant-inferred" }]);
  });

  it("downgrades document and unsupported first-party attribution rather than trusting the model", async () => {
    const context = { captureSpeakerKind: "human-turn" as const, captureEvidence: evidence("Hello there.") };
    expect((await extract("Morgan was born May 17, 1990.", [{ ...fact, attribution: "document" }], context))
      .candidates[0]?.labels).toEqual([{ ...fact, attribution: "assistant-inferred" }]);
    expect((await extract("Morgan was born May 17, 1990.", [{ ...fact, attribution: "unknown" }], context))
      .candidates[0]?.labels).toEqual([{ ...fact, attribution: "unknown" }]);
  });

  it("does not bind an owner turn about a relative to the owner entity", async () => {
    const label = { v: 1, kind: "fact", entityId: "person:owner", key: "birth_date",
      value: { type: "date", date: "1990-05-17" }, attribution: "user-stated" };
    const text = "The user's son was born May 17, 1990.";
    expect((await extract(text, [label], { captureSpeakerKind: "human-turn", conversationId: "acp:fictional",
      captureEvidence: evidence("My son was born May 17, 1990.", { ownerTurn: true }) })).candidates[0]?.labels)
      .toBeUndefined();
    expect((await extract("The user was born May 17, 1990.", [label], {
      captureSpeakerKind: "human-turn", conversationId: "acp:fictional",
      captureEvidence: evidence("I was born May 17, 1990.", { ownerTurn: true }),
    })).candidates[0]?.labels).toEqual([label]);
    expect((await extract("The user was born May 17, 1990.", [label], {
      captureSpeakerKind: "human-turn", conversationId: "acp:fictional",
      captureEvidence: evidence("I was born abroad, but did not mention a date.", { ownerTurn: true }),
    })).candidates[0]?.labels).toEqual([{ ...label, attribution: "assistant-inferred" }]);
  });

  it("binds an owner property only in the sentence with its value", async () => {
    const label = { v: 1, kind: "fact", entityId: "person:owner", key: "birth_date",
      value: { type: "date", date: "1990-05-17" }, attribution: "user-stated" };
    const owner = (userText: string) => ({ captureSpeakerKind: "human-turn" as const,
      captureEvidence: evidence(userText, { ownerTurn: true }) });
    for (const relation of ["wife", "sons", "children", "daughter", "brother", "sister", "friend", "boss"]) {
      const sentence = `The user's ${relation} was born May 17, 1990.`;
      expect((await extract(sentence, [label], owner(`My ${relation} was born May 17, 1990.`)))
        .candidates[0]?.labels).toBeUndefined();
    }
    expect((await extract("The user has a daughter born May 17, 1990.", [label],
      owner("I have a daughter born May 17, 1990."))).candidates[0]?.labels).toBeUndefined();
    expect((await extract("The user told Taylor her birthday is May 17, 1990.", [label],
      owner("I told Taylor her birthday is May 17, 1990."))).candidates[0]?.labels).toBeUndefined();
    expect((await extract("The user's birthday is May 17, 1990.", [label],
      owner("My wife likes cake. My birthday is May 17, 1990."))).candidates[0]?.labels).toEqual([label]);
    expect((await extract("The user was born May 17, 1990. Their son was born in 2010.", [label],
      owner("My birthday is May 17, 1990. My son likes cake."))).candidates[0]?.labels).toEqual([label]);
    const location = { ...label, key: "home_location", value: { type: "text", text: "Lisbon" } };
    expect((await extract("The user is based in Lisbon.", [location],
      owner("I'm based in Lisbon."))).candidates[0]?.labels).toEqual([location]);
  });

  it("binds owner-reported facts to the stable owner entity without trusting unidentified turns", async () => {
    const ownerFact = { v: 1, kind: "fact", entityId: "person:owner", key: "other:favorite-color",
      value: { type: "text", text: "blue" }, attribution: "user-stated" };
    const ownerText = "The user prefers blue for fictional sketches.";
    const ownerContext = { captureSpeakerKind: "human-turn" as const, conversationId: "acp:fictional",
      captureEvidence: evidence("I prefer blue for fictional sketches.", { ownerTurn: true }) };
    expect((await extract(ownerText, [ownerFact], ownerContext)).candidates[0]?.labels).toEqual([ownerFact]);
    expect((await extract(ownerText, [ownerFact], { ...ownerContext, captureEvidence: evidence("I prefer blue.") }))
      .candidates[0]?.labels).toBeUndefined();
  });

  it("does not copy a preference onto a sibling split sentence", async () => {
    const first = "The user prefers concise fictional project notes.";
    const sibling = "Morgan archives detailed fictional catalog records and diagrams for the team.";
    const plan = await extractCapturePlanStrict("completed turn", {
      id: "preference-split", complete: async () => JSON.stringify({
        memories: [{ type: "note", text: `${first} ${sibling} ${"The archive records many old maps. ".repeat(3)}`.trim(),
          salience: 0.8, isInsight: false, entityIds: [], labels: [preference] }],
        entities: [], relations: [],
      }),
    }, undefined, [], { observedAt: at.toISOString(), captureSpeakerKind: "human-turn",
      conversationId: "conv-1", captureEvidence: evidence("I prefer concise fictional project notes.", { ownerTurn: true }) });
    expect(plan.candidates[0]?.labels).toEqual([preference]);
    expect(plan.candidates.find((candidate) => candidate.text === sibling)?.labels).toBeUndefined();
  });

  it("keeps host-verified senderless owner agent guidance and hashes colon conversations", async () => {
    const sentence = "The assistant should keep concise fictional notes.";
    const context = { captureSpeakerKind: "human-turn" as const, conversationId: "web:fictional-thread",
      captureEvidence: evidence(sentence, { ownerTurn: true }) };
    expect((await extract(sentence, [preference], context)).candidates[0]?.labels).toEqual([preference]);
    expect((await extract("The user prefers concise fictional notes.", [preference], {
      ...context, captureEvidence: evidence("I prefer concise fictional notes.", { ownerTurn: true }),
    })).candidates[0]?.labels).toEqual([preference]);
    const unknown = { ...context, captureEvidence: evidence(sentence) };
    const expectedScope = `conversation:h_${createHash("sha256").update("web:fictional-thread").digest("hex")}`;
    expect((await extract(sentence, [preference], unknown)).candidates[0]?.labels)
      .toEqual([{ ...preference, scope: expectedScope }]);
  });

  it("forces unidentified human preferences to conversation scope and drops trigger preferences", async () => {
    const sentence = "Morgan prefers concise project notes.";
    const user = "Morgan prefers concise project notes.";
    const context = { captureSpeakerKind: "human-turn" as const, conversationId: "conv-1",
      captureEvidence: evidence(user) };
    expect((await extract(sentence, [preference], context)).candidates[0]?.labels)
      .toEqual([{ ...preference, scope: "conversation:conv-1" }]);
    expect((await extract("Taylor prefers concise project notes.", [preference], {
      ...context, captureEvidence: evidence("Taylor prefers concise project notes."),
    })).candidates[0]?.labels).toEqual([{ ...preference, scope: "conversation:conv-1" }]);
    expect((await extract("Taylor prefers lengthy essays.", [preference], {
      ...context, captureEvidence: evidence("Taylor prefers concise project notes."),
    })).candidates[0]?.labels).toBeUndefined();
    expect((await extract(sentence, [preference], { ...context,
      captureEvidence: evidence(user, { senderToken: "a".repeat(32) }) })).candidates[0]?.labels)
      .toEqual([{ ...preference, scope: `user:${"a".repeat(32)}` }]);
    expect((await extract(sentence, [preference], { ...context, captureSpeakerKind: "trigger" })).candidates[0]?.labels)
      .toBeUndefined();
    const token = "a".repeat(32);
    const addressed = { ...context, captureEvidence: evidence("You should keep concise notes.", { senderToken: token }) };
    expect((await extract("Morgan keeps concise notes.", [preference], addressed)).candidates[0]?.labels)
      .toBeUndefined();
    const explicitAgent = { ...context, captureEvidence: evidence("The assistant should keep concise notes.", { senderToken: token }) };
    expect((await extract("Morgan keeps concise notes.", [preference], explicitAgent)).candidates[0]?.labels)
      .toBeUndefined();
    expect((await extract("Morgan keeps concise notes.", [preference], {
      ...explicitAgent, captureEvidence: { ...explicitAgent.captureEvidence, ownerTurn: true as const },
    })).candidates[0]?.labels).toBeUndefined();
  });

  it("keeps only a uniquely host-proven successful retry; malformed label never drops the memory", async () => {
    const sentence = "A retry succeeded after an earlier tool failure.";
    const context = { captureEvidence: evidence("Please check the task.", { toolOutcomes: [
      { category: "execute", outcome: "failed" }, { category: "execute", outcome: "succeeded" },
    ] }) };
    const plan = await extract(sentence, [lesson, { ...lesson, verified: false }, { kind: "bogus" }], context);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]?.labels).toEqual([lesson]);
    expect((await extract(sentence, [lesson], {})).candidates[0]?.labels).toBeUndefined();
    expect((await extract(sentence, [lesson], { captureEvidence: evidence("Hi", { toolOutcomes: [
      { category: "execute", outcome: "succeeded" }, { category: "execute", outcome: "failed" },
    ] }) })).candidates[0]?.labels).toBeUndefined();
    expect((await extract(sentence, [lesson], { captureEvidence: evidence("Hi", { toolOutcomes: [
      { category: "execute", outcome: "failed" }, { category: "execute", outcome: "failed" },
      { category: "execute", outcome: "succeeded" },
    ] }) })).candidates[0]?.labels).toBeUndefined();
  });

  it("bounds lessons to one per proven retry and forces scope unless user names a project", async () => {
    const context = { observedAt: at.toISOString(), captureSpeakerKind: "human-turn" as const,
      captureEvidence: evidence("Please fix the fictional project.", { toolOutcomes: [
        { category: "execute", outcome: "failed" }, { category: "execute", outcome: "succeeded" },
      ] }) };
    const plan = await extractCapturePlanStrict("User: Please fix the fictional project.", {
      id: "multi-lessons", complete: async () => JSON.stringify({ memories: [
        { type: "note", text: "A retry resolved the failed operation.", salience: 0.8, isInsight: false,
          entityIds: [], labels: [{ ...lesson, scope: "project:fictional-project" }] },
        { type: "note", text: "Another retry fixed the earlier problem.", salience: 0.7, isInsight: false,
          entityIds: [], labels: [{ ...lesson, scope: "user:someone" }] },
      ], entities: [], relations: [] }),
    }, undefined, [], context);
    expect(plan.candidates[0]?.labels).toEqual([{ ...lesson, scope: "project:fictional-project" }]);
    expect(plan.candidates[1]?.labels).toBeUndefined();
    expect((await extract("A retry succeeded after a failure.", [{ ...lesson, scope: "user:someone" }], {
      captureEvidence: context.captureEvidence,
    })).candidates[0]?.labels).toEqual([lesson]);
  });

  it("retains a supported fact from a separate tail sentence and rejects malformed label arrays", async () => {
    const text = `${"Morgan keeps fictional archive notes on a deliberately long bounded opening sentence with extensive references to safe written examples and fictional projects."} Morgan was born May 17, 1990.`;
    const plan = await extract(text, [fact], { captureSpeakerKind: "human-turn",
      captureEvidence: evidence("Morgan was born May 17, 1990.") });
    expect(plan.candidates[0]?.labels).toBeUndefined();
    expect(plan.candidates[1]?.labels).toEqual([fact]);
    await expect(extractCapturePlanStrict("turn", { id: "bad-structure", complete: async () => JSON.stringify({
      memories: [{ type: "note", text: "Morgan keeps notes.", salience: 0.8, isInsight: false,
        entityIds: [], labels: {} }], entities: [], relations: [],
    }) })).rejects.toThrow(/labels structure/u);
  });

  it("supersedes with an explicit replacement label and leaves the old label as history", async () => {
    const root = mkdtempSync(join(tmpdir(), "capture-labelled-supersede-"));
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(8), dim: 8 });
    const firstText = "Morgan was born May 17, 1990.";
    const correctedText = "Morgan was born May 18, 1990.";
    const corrected = { ...fact, value: { type: "date", date: "1990-05-18" } };
    let nextId = 0;
    try {
      for (const [text, label, decision] of [
        [firstText, fact, ""], [correctedText, corrected, "supersede"],
      ] as const) {
        const output = await captureTurnStrict(`User: ${text}\nAssistant: Noted.`, {
          db, root, llm: { id: "fake", complete: async (_prompt, options) => {
            if (options?.label === "capture:extract") return JSON.stringify({ memories: [
              { type: "note", text, salience: 0.8, isInsight: false, entityIds: [], labels: [label] },
            ], entities: [], relations: [] });
            return JSON.stringify([{ index: 0, action: decision, targetId: "LABEL-0", text }]);
          } }, nextId: () => `LABEL-${nextId++}`, now: () => at,
          conversationId: "conv-1", captureSpeakerKind: "human-turn", captureEvidence: evidence(text),
          canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
        });
        expect(output.actions[0]?.kind).toBe(decision || "add");
      }
      expect(db.labelsForEntity("person:morgan").map((hit) => [hit.memoryId, hit.active, hit.label]))
        .toEqual([["LABEL-0", false, fact], ["LABEL-1", true, corrected]]);
      expect(auditCanonicalGraphParity(root, db).labels.matched).toBe(2);
      const candidateText = "Morgan was born May 19, 1990.";
      const finalText = "Morgan was born May 20, 1990.";
      const offered = { ...fact, value: { type: "date", date: "1990-05-19" } };
      const changed = await captureTurnStrict(`User: ${candidateText}\nAssistant: Noted.`, {
        db, root, llm: { id: "fake-final-text", complete: async (_prompt, options) => options?.label === "capture:extract"
          ? JSON.stringify({ memories: [{ type: "note", text: candidateText, salience: 0.8,
            isInsight: false, entityIds: [], labels: [offered] }], entities: [], relations: [] })
          : JSON.stringify([{ index: 0, action: "supersede", targetId: "LABEL-1", text: finalText }]) },
        nextId: () => `LABEL-${nextId++}`, now: () => at, conversationId: "conv-1",
        captureSpeakerKind: "human-turn", captureEvidence: evidence(candidateText),
        canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
      });
      expect(changed.actions[0]?.kind).toBe("supersede");
      expect(db.get("LABEL-2")?.text).toBe(finalText);
      expect(db.labelProjection().map((entry) => entry.memoryId)).toEqual(["LABEL-0", "LABEL-1"]);
      expect(auditCanonicalGraphParity(root, db).labels.matched).toBe(2);
      const discarded = await captureTurnStrict("User: Morgan was born May 21, 1990.\nAssistant: Noted.", {
        db, root, llm: { id: "fake-only-final", complete: async (_prompt, options) => options?.label === "capture:extract"
          ? JSON.stringify({ memories: [{ type: "note", text: "Morgan was born May 21, 1990.", salience: 0.8,
            isInsight: false, entityIds: [], labels: [{ ...fact, value: { type: "date", date: "1990-05-21" } }] }],
            entities: [], relations: [] })
          : JSON.stringify([{ index: 0, action: "supersede", targetId: "LABEL-2", text: "Morgan was born May 22, 1990." }]) },
        nextId: () => `LABEL-${nextId++}`, now: () => at, conversationId: "conv-1",
        captureSpeakerKind: "human-turn", captureEvidence: evidence("Morgan was born May 21, 1990."),
        captureSettings: { only: ["fact"] }, canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
      });
      expect(discarded.actions).toEqual([]);
      expect(db.get("LABEL-2")?.text).toBe(finalText);
      expect(db.get("LABEL-3")).toBeUndefined();
    } finally { db.close(); }
  });

  it("writes one validated label with its canonical bullet and restores parity on rebuild", async () => {
    const root = mkdtempSync(join(tmpdir(), "capture-labels-integration-"));
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(8), dim: 8 });
    try {
      const user = "Morgan was born May 17, 1990.";
      const result = await captureTurnStrict(`User: ${user}\nAssistant: Noted.`, {
        db, root, llm: { id: "fake", complete: async () => JSON.stringify({
          memories: [{ type: "note", text: user, salience: 0.8, isInsight: false,
            entityIds: [], labels: [fact] }], entities: [], relations: [],
        }) }, nextId: () => "LABELLED-CAPTURE", now: () => at,
        conversationId: "conv-1", captureSpeakerKind: "human-turn", captureEvidence: evidence(user),
        canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
      });
      expect(result.actions[0]?.kind).toBe("add");
      const source = readFileSync(join(root, "daily", "2026-07-12.md"), "utf8");
      expect(labelsOf(parseDailyFile(source).bullets.find((bullet) => bullet.id === "LABELLED-CAPTURE")!)).toEqual([fact]);
      expect(db.labelsForEntity("person:morgan")[0]?.label).toEqual(fact);
      expect(auditCanonicalGraphParity(root, db).labels.matched).toBe(1);
      await rebuildFromMarkdown(root, db);
      expect(db.labelsForEntity("person:morgan")[0]?.label).toEqual(fact);
    } finally { db.close(); }
  });
});
