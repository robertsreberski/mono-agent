import { mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryCaptureEvidence } from "@mono-agent/agent-contracts";
import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../../store/index.js";
import { extractCapturePlanStrict } from "../capture-batch.js";
import { captureTurnStrict } from "../capture.js";
import { capturePlanInputHash, retainCapturePlan } from "../capture-plan-cache.js";
import { boundedCaptureSource, captureLabels, deriveCoarseFactLabels } from "../capture-labels.js";
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
}, user = "User: Morgan was born 1990-05-17.", source = "user") {
  const people = [...new Set(labels.flatMap((label) => label && typeof label === "object" && "entityId" in label
    && typeof label.entityId === "string" ? [label.entityId] : []))];
  return await extractCapturePlanStrict(`${user}\nAssistant: Noted.`, {
    id: "fake", complete: async () => JSON.stringify({
      memories: [{ type: "note", text, salience: 0.8, isInsight: false, entityIds: people, source, labels }],
      entities: people.map((id) => ({ id, name: id === "person:owner" ? "Owner"
        : id.slice(7).split("-")[0]!.replace(/^./u, (char) => char.toUpperCase()), type: "person" })), relations: [],
    }),
  }, undefined, [], { observedAt: at.toISOString(), ...context });
}

describe("host-validated capture labels", () => {
  it("degrades legacy relationship proposals to a person-only fact without trusting a different subject", async () => {
    const relation = { v: 1, kind: "fact", entityId: "person:morgan", key: "relationship",
      value: { type: "relationship", role: "zorbel", targetEntityId: "person:maple" }, attribution: "user-stated" };
    const coarse = { v: 1, kind: "fact", entityId: "person:morgan", attribution: "user-stated" };
    expect((await extract("Morgan accompanies Maple to art class.", [relation], {
      captureSpeakerKind: "human-turn", captureEvidence: evidence("Morgan accompanies Maple to art class."),
    })).candidates[0]?.labels).toEqual([coarse]);
    expect((await extract("Maple attends art class.", [relation], {})).candidates[0]?.labels).toBeUndefined();
    const owner = { ...relation, entityId: "person:owner" };
    const context = { captureSpeakerKind: "human-turn" as const,
      captureEvidence: evidence("I attend art class.", { ownerTurn: true }) };
    expect((await extract("The user attends art class.", [owner], context)).candidates[0]?.labels)
      .toEqual([{ v: 1, kind: "fact", entityId: "person:owner", attribution: "user-stated" }]);
    expect((await extract("The user attends art class.", [owner], context, undefined, "assistant")).candidates[0]?.labels)
      .toBeUndefined();
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
    expect(prompt).toContain("A preference about how the assistant should work is a preference label, not a fact about the user");
    expect(prompt).toContain('"source":"user"');
    expect(prompt).toContain("The host labels person facts itself; propose a fact label only for a built-in key");
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
        const user = "Morgan prefers concise notes. Morgan was born 1990-05-17.";
        let id = 0;
        const result = await captureTurnStrict(`User: ${user}\nAssistant: A retry fixed the failure.`, {
          db, root, llm: { id: "fake-filter", complete: async () => JSON.stringify({ memories: [
            { type: "note", text: "Morgan prefers concise notes.", salience: 0.8, isInsight: false, source: "user", entityIds: [], labels: [preference] },
            { type: "note", text: "A retry fixed the failed operation by using the fallback.", salience: 0.8, isInsight: false, source: "user", entityIds: [], labels: [lesson] },
            { type: "note", text: "Morgan was born 1990-05-17.", salience: 0.8, isInsight: false, source: "user", entityIds: ["person:morgan"], labels: [fact] },
            { type: "note", text: "A fictional CI check is pending.", salience: 0.8, isInsight: false, source: "user", entityIds: [], labels: [] },
            { type: "note", text: "Use verbose summaries for Taylor.", salience: 0.8, isInsight: false, source: "assistant", entityIds: [], labels: [preference] },
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
        expect(db.get("FOCUS-1")?.text).toBe(only?.length === 0 ? undefined : "A retry fixed the failed operation by using the fallback.");
        expect(db.get("FOCUS-2")?.text).toBe(only === undefined ? "Morgan was born 1990-05-17." : undefined);
        expect(db.get("FOCUS-3")?.text).toBe(only === undefined ? "A fictional CI check is pending." : undefined);
        expect(db.get("FOCUS-4")?.text).toBe(only === undefined ? "Use verbose summaries for Taylor." : undefined);
        expect(readGraph(root).entities).toHaveLength(only === undefined ? 1 : 0);
      } finally { db.close(); }
    }
  });
  it("attributes only host-supported human facts, accepts written dates, rejects ambiguous dates and assistant recap", async () => {
    const user = "Morgan was born on 1990-05-17.";
    const trusted = { captureSpeakerKind: "human-turn" as const, captureEvidence: evidence(user) };
    expect((await extract("Morgan was born 1990-05-17.", [fact], trusted)).candidates[0]?.labels)
      .toEqual([fact]);
    expect((await extract("Morgan was born 1990-05-17.", [fact], {
      captureSpeakerKind: "trigger", captureEvidence: evidence(user),
    })).candidates[0]?.labels).toBeUndefined();
    expect((await extract("Morgan was born 1990-05-17.", [fact], {
      captureSpeakerKind: "human-turn", captureEvidence: evidence("Morgan said hello."),
    })).candidates[0]?.labels).toEqual([{ ...fact, attribution: "assistant-inferred" }]);
    const ambiguous = { ...fact, value: { type: "date", date: "1990-06-05" } };
    expect((await extract("Morgan was born 05/06/1990.", [ambiguous], trusted)).candidates[0]?.labels)
      .toEqual([{ v: 1, kind: "fact", entityId: "person:morgan", attribution: "user-stated" }]);
    expect((await extract("Morgan was born 17/05/1990.", [fact], trusted)).candidates[0]?.labels).toEqual([fact]);
    expect((await extract("Morgan was born 1990-05-17.", [fact, { ...fact, value: { type: "date", date: "1990-02-30" } }], trusted))
      .candidates[0]?.labels).toEqual([fact]);
  });

  it("supports Polish and Spanish preferences; a month in words never validates a structured date", async () => {
    const cases = [
      { text: "Morgan urodziła się 17 maja 1990.", preference: "Morgan chce zwięzłe odpowiedzi." },
      { text: "Morgan nació el 17 de mayo de 1990.", preference: "Morgan prefiere respuestas breves." },
    ];
    for (const item of cases) {
      const context = { captureSpeakerKind: "human-turn" as const, conversationId: "conv-1",
        captureEvidence: evidence(item.preference) };
      expect((await extract(item.preference, [preference], context)).candidates[0]?.labels)
        .toEqual([{ ...preference, scope: "conversation:conv-1" }]);
      // Day and year match, but the written month cannot be compared structurally: coarse only.
      expect((await extract(item.text, [fact], { ...context, captureEvidence: evidence(item.text) }))
        .candidates[0]?.labels).toEqual([{ v: 1, kind: "fact", entityId: "person:morgan", attribution: "user-stated" }]);
    }
    // A wrong written month with the right day and year must not validate either.
    expect((await extract("Morgan was born on June 17, 1990.", [fact], {})).candidates[0]?.labels)
      .toEqual([{ v: 1, kind: "fact", entityId: "person:morgan", attribution: "assistant-inferred" }]);
    expect((await extract("Morgan was born 17.05.1990.", [fact], {})).candidates[0]?.labels)
      .toEqual([{ ...fact, attribution: "assistant-inferred" }]);
    expect((await extract("Morgan was born 17-05-1990.", [fact], {})).candidates[0]?.labels)
      .toEqual([{ ...fact, attribution: "assistant-inferred" }]);
    expect((await extract("Morgan was born 17-06-1990.", [fact], {})).candidates[0]?.labels)
      .toEqual([{ v: 1, kind: "fact", entityId: "person:morgan", attribution: "assistant-inferred" }]);
  });

  it("matches diacritics and display names while requiring a named non-owner in the user's words", async () => {
    const named = { ...fact, entityId: "person:fictional-alias" };
    const label = { v: 1, kind: "fact", entityId: "person:fictional-alias", key: "preferred_name",
      value: { type: "text", text: "Élodie" }, attribution: "user-stated" };
    const human = { observedAt: at.toISOString(), captureSpeakerKind: "human-turn" as const,
      captureEvidence: evidence("I prefer to be called Elodie."), conversationId: "conv-1" };
    const plan = await extractCapturePlanStrict("User: I prefer to be called Elodie.", {
      id: "display", complete: async () => JSON.stringify({
        memories: [{ type: "note", text: "Morgan prefers the name Elodie.", salience: 0.8,
          isInsight: false, source: "user", entityIds: [named.entityId], labels: [label] }],
        entities: [{ id: named.entityId, name: "Morgan", type: "person" }], relations: [],
      }),
    }, undefined, [], human);
    expect(plan.candidates[0]?.labels).toEqual([{ ...label, attribution: "assistant-inferred" }]);
    const slugLabel = { ...fact, entityId: "person:marie-smith" };
    expect((await extract("Marie was born 1990-05-17.", [slugLabel], {})).candidates[0]?.labels)
      .toEqual([{ ...slugLabel, attribution: "assistant-inferred" }]);
  });

  it("downgrades document and unsupported first-party attribution rather than trusting the model", async () => {
    const context = { captureSpeakerKind: "human-turn" as const, captureEvidence: evidence("Hello there.") };
    expect((await extract("Morgan was born 1990-05-17.", [{ ...fact, attribution: "document" }], context))
      .candidates[0]?.labels).toEqual([{ ...fact, attribution: "assistant-inferred" }]);
    expect((await extract("Morgan was born 1990-05-17.", [{ ...fact, attribution: "unknown" }], context))
      .candidates[0]?.labels).toEqual([{ ...fact, attribution: "assistant-inferred" }]);
  });

  it("binds owner facts by association and user source on an owner turn, without subject grammar", async () => {
    const label = { v: 1, kind: "fact", entityId: "person:owner", key: "birth_date",
      value: { type: "date", date: "1990-05-17" }, attribution: "user-stated" };
    const owner = (userText: string) => ({ captureSpeakerKind: "human-turn" as const, conversationId: "acp:fictional",
      captureEvidence: evidence(userText, { ownerTurn: true }) });
    for (const [line, user] of [
      ["The user was born 1990-05-17.", "I was born 1990-05-17."],
      ["Użytkownik urodził się 17.05.1990.", "Urodziłem się 17.05.1990."],
      ["El usuario nació el 17/05/1990.", "Nací el 17/05/1990."],
    ] as const) {
      expect((await extract(line, [label], owner(user))).candidates[0]?.labels).toEqual([label]);
    }
    // The value must appear in the user's text to stay user-stated.
    expect((await extract("The user was born 1990-05-17.", [label], owner("I was born abroad.")))
      .candidates[0]?.labels).toEqual([{ ...label, attribution: "assistant-inferred" }]);
    // An assistant-sourced claim about the owner is never an owner fact.
    expect((await extract("The user was born 1990-05-17.", [label], owner("When was I born?"), undefined, "assistant"))
      .candidates[0]?.labels).toBeUndefined();
    // A human turn that is not the verified owner cannot bind the owner.
    expect((await extract("The user was born 1990-05-17.", [label], {
      captureSpeakerKind: "human-turn", captureEvidence: evidence("I was born 1990-05-17."),
    })).candidates[0]?.labels).toBeUndefined();
    // F3: a structured owner property needs an unambiguous subject. When the line
    // is also associated with, or names, another person, keep only the coarse owner fact.
    const coarseOwner = [{ v: 1, kind: "fact", entityId: "person:owner", attribution: "user-stated" }];
    const shared = await extractCapturePlanStrict("User: Morgan and I were born 1990-05-17.", {
      id: "owner-shared", complete: async () => JSON.stringify({
        memories: [{ type: "note", text: "The user and Morgan were born 1990-05-17.", salience: 0.8, isInsight: false,
          entityIds: ["person:owner", "person:morgan"], source: "user", labels: [label] }],
        entities: [{ id: "person:owner", name: "Owner", type: "person" }, { id: "person:morgan", name: "Morgan", type: "person" }],
        relations: [] }),
    }, undefined, [], { observedAt: at.toISOString(), ...owner("Morgan and I were born 1990-05-17.") });
    expect(shared.candidates[0]?.labels?.filter((item) => item.kind === "fact" && item.entityId === "person:owner")).toEqual(coarseOwner);
    const named = await extractCapturePlanStrict("User: Morgan was born 1990-05-17.", {
      id: "owner-named", complete: async () => JSON.stringify({
        memories: [{ type: "note", text: "The user noted Morgan was born 1990-05-17.", salience: 0.8, isInsight: false,
          entityIds: ["person:owner"], source: "user", labels: [label] }],
        entities: [{ id: "person:owner", name: "Owner", type: "person" }, { id: "person:morgan", name: "Morgan", type: "person" }],
        relations: [] }),
    }, undefined, [], { observedAt: at.toISOString(), ...owner("I noted Morgan was born 1990-05-17.") });
    expect(named.candidates[0]?.labels).toEqual(coarseOwner);
    const location = { ...label, key: "home_location", value: { type: "text", text: "Maple Harbor" } };
    expect((await extract("The user is based in Maple Harbor.", [location],
      owner("Mieszkam w Maple Harbor."))).candidates[0]?.labels).toEqual([location]);
  });

  it("binds owner-reported facts to the stable owner entity without trusting unidentified turns", async () => {
    const ownerFact = { v: 1, kind: "fact", entityId: "person:owner", key: "other:favorite-color",
      value: { type: "text", text: "blue" }, attribution: "user-stated" };
    const ownerText = "The user prefers blue for fictional sketches.";
    const ownerContext = { captureSpeakerKind: "human-turn" as const, conversationId: "acp:fictional",
      captureEvidence: evidence("I prefer blue for fictional sketches.", { ownerTurn: true }) };
    expect((await extract(ownerText, [ownerFact], ownerContext)).candidates[0]?.labels)
      .toEqual([{ v: 1, kind: "fact", entityId: "person:owner", attribution: "user-stated" }]);
    expect((await extract(ownerText, [ownerFact], { ...ownerContext, captureEvidence: evidence("I prefer blue.") }))
      .candidates[0]?.labels).toBeUndefined();
  });

  it("keeps standing negative instructions in the owner's own words but not assistant suggestions", async () => {
    const line = "The assistant should not fetch the fictional work calendar while the user is on leave.";
    const user = "Don't fetch the fictional work calendar while I'm on leave.";
    const context = { captureSpeakerKind: "human-turn" as const,
      captureEvidence: evidence(user, { ownerTurn: true }) };
    expect((await extract(line, [preference], context)).candidates[0]?.labels).toEqual([preference]);
    expect((await extract(line, [preference], { ...context,
      captureEvidence: evidence("Please check the calendar.", { ownerTurn: true }),
    }, undefined, "assistant")).candidates[0]?.labels).toBeUndefined();
  });

  it("does not copy a preference onto a sibling split sentence", async () => {
    const first = "The user prefers concise fictional project notes.";
    const sibling = "Morgan archives detailed fictional catalog records and diagrams for the team.";
    const plan = await extractCapturePlanStrict("completed turn", {
      id: "preference-split", complete: async () => JSON.stringify({
        memories: [{ type: "note", text: `${first} ${sibling} ${"The archive records many old maps. ".repeat(3)}`.trim(),
          salience: 0.8, isInsight: false, source: "user", entityIds: [], labels: [preference] }],
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
    }, undefined, "assistant")).candidates[0]?.labels).toBeUndefined();
    expect((await extract(sentence, [preference], { ...context,
      captureEvidence: evidence(user, { senderToken: "a".repeat(32) }) })).candidates[0]?.labels)
      .toEqual([{ ...preference, scope: `user:${"a".repeat(32)}` }]);
    expect((await extract(sentence, [preference], { ...context, captureSpeakerKind: "trigger" })).candidates[0]?.labels)
      .toBeUndefined();
    // The model judged the assistant as the source: no preference, in any wording.
    expect((await extract(sentence, [preference], context, undefined, "assistant")).candidates[0]?.labels).toBeUndefined();
  });

  it("keeps only a uniquely host-proven successful retry; malformed label never drops the memory", async () => {
    const sentence = "A retry succeeded by using the alternate path after an earlier tool failure.";
    const context = { captureEvidence: evidence("Please check the task.", { toolOutcomes: [
      { category: "execute", outcome: "failed" }, { category: "execute", outcome: "succeeded" },
    ] }) };
    const plan = await extract(sentence, [lesson, { ...lesson, verified: false }, { kind: "bogus" }], context);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]?.labels).toEqual([lesson]);
    expect((await extract(sentence, [lesson], {})).candidates[0]?.labels).toBeUndefined();
    expect((await extract(sentence, [lesson], { captureEvidence: evidence("Hi", { toolOutcomes: [
      { category: "execute", outcome: "succeeded" }, { category: "execute", outcome: "failed" },
    ] }) })).candidates[0]?.labels).toEqual([lesson]);
    expect((await extract(sentence, [lesson], { captureEvidence: evidence("Hi", { toolOutcomes: [
      { category: "execute", outcome: "failed" }, { category: "execute", outcome: "failed" },
      { category: "execute", outcome: "succeeded" },
    ] }) })).candidates[0]?.labels).toEqual([lesson]);
    // No connective-word gate: the model's lesson label plus host tool outcomes decide.
    expect((await extract("La reintentona funcionó con la ruta alternativa.", [lesson], context)).candidates[0]?.labels)
      .toEqual([lesson]);
    expect((await extract("The check passed by using the fallback.", [lesson], {
      captureEvidence: evidence("Please check the result.", { toolOutcomes: [{ category: "execute", outcome: "succeeded" }] }),
    })).candidates[0]?.labels).toEqual([lesson]);
  });

  it("bounds lessons to one per proven retry and forces scope unless user names a project", async () => {
    const context = { observedAt: at.toISOString(), captureSpeakerKind: "human-turn" as const,
      captureEvidence: evidence("Please fix the fictional project.", { toolOutcomes: [
        { category: "execute", outcome: "failed" }, { category: "execute", outcome: "succeeded" },
      ] }) };
    const plan = await extractCapturePlanStrict("User: Please fix the fictional project.", {
      id: "multi-lessons", complete: async () => JSON.stringify({ memories: [
        { type: "note", text: "A retry resolved the failed operation by using a fallback.", salience: 0.8, isInsight: false, source: "user", entityIds: [], labels: [{ ...lesson, scope: "project:fictional-project" }] },
        { type: "note", text: "Another retry fixed the earlier problem by using a different route.", salience: 0.7, isInsight: false, source: "user", entityIds: [], labels: [{ ...lesson, scope: "user:someone" }] },
      ], entities: [], relations: [] }),
    }, undefined, [], context);
    expect(plan.candidates[0]?.labels).toEqual([{ ...lesson, scope: "project:fictional-project" }]);
    expect(plan.candidates[1]?.labels).toBeUndefined();
    expect((await extract("A retry succeeded by using an alternate path after a failure.", [{ ...lesson, scope: "user:someone" }], {
      captureEvidence: context.captureEvidence,
    })).candidates[0]?.labels).toEqual([lesson]);
  });

  it("retains a supported fact from a separate tail sentence and rejects malformed label arrays", async () => {
    const text = `${"Morgan keeps fictional archive notes on a deliberately long bounded opening sentence with extensive references to safe written examples and fictional projects."} Morgan was born 1990-05-17.`;
    const plan = await extract(text, [fact], { captureSpeakerKind: "human-turn",
      captureEvidence: evidence("Morgan was born 1990-05-17.") });
    // The structured value is only in the tail; the opening sentence keeps a coarse fact.
    expect(plan.candidates[0]?.labels)
      .toEqual([{ v: 1, kind: "fact", entityId: "person:morgan", attribution: "user-stated" }]);
    expect(plan.candidates[1]?.labels).toEqual([fact]);
    await expect(extractCapturePlanStrict("turn", { id: "bad-structure", complete: async () => JSON.stringify({
      memories: [{ type: "note", text: "Morgan keeps notes.", salience: 0.8, isInsight: false, source: "user", entityIds: [], labels: {} }], entities: [], relations: [],
    }) })).rejects.toThrow(/labels structure/u);
  });

  it("supersedes with an explicit replacement label and leaves the old label as history", async () => {
    const root = mkdtempSync(join(tmpdir(), "capture-labelled-supersede-"));
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(8), dim: 8 });
    const firstText = "Morgan was born 1990-05-17.";
    const correctedText = "Morgan was born 1990-05-18.";
    const corrected = { ...fact, value: { type: "date", date: "1990-05-18" } };
    let nextId = 0;
    try {
      for (const [text, label, decision] of [
        [firstText, fact, ""], [correctedText, corrected, "supersede"],
      ] as const) {
        const output = await captureTurnStrict(`User: ${text}\nAssistant: Noted.`, {
          db, root, llm: { id: "fake", complete: async (_prompt, options) => {
            if (options?.label === "capture:extract") return JSON.stringify({ memories: [
              { type: "note", text, salience: 0.8, isInsight: false, source: "user", entityIds: ["person:morgan"], labels: [label] },
            ], entities: [{ id: "person:morgan", name: "Morgan", type: "person" }], relations: [] });
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
      const candidateText = "Morgan was born 1990-05-19.";
      const finalText = "Morgan was born 1990-05-20.";
      const offered = { ...fact, value: { type: "date", date: "1990-05-19" } };
      const changed = await captureTurnStrict(`User: ${candidateText}\nAssistant: Noted.`, {
        db, root, llm: { id: "fake-final-text", complete: async (_prompt, options) => options?.label === "capture:extract"
          ? JSON.stringify({ memories: [{ type: "note", text: candidateText, salience: 0.8,
            isInsight: false, source: "user", entityIds: ["person:morgan"], labels: [offered] }],
            entities: [{ id: "person:morgan", name: "Morgan", type: "person" }], relations: [] })
          : JSON.stringify([{ index: 0, action: "supersede", targetId: "LABEL-1", text: finalText }]) },
        nextId: () => `LABEL-${nextId++}`, now: () => at, conversationId: "conv-1",
        captureSpeakerKind: "human-turn", captureEvidence: evidence(candidateText),
        canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
      });
      expect(changed.actions[0]?.kind).toBe("supersede");
      expect(db.get("LABEL-2")?.text).toBe(finalText);
      expect(db.labelProjection().map((entry) => entry.memoryId)).toEqual(["LABEL-0", "LABEL-1", "LABEL-2"]);
      expect(db.labelsForEntity("person:morgan").at(-1)?.label)
        .toEqual({ v: 1, kind: "fact", entityId: "person:morgan", attribution: "user-stated" });
      expect(auditCanonicalGraphParity(root, db).labels.matched).toBe(3);
      const discarded = await captureTurnStrict("User: Morgan was born 1990-05-21.\nAssistant: Noted.", {
        db, root, llm: { id: "fake-only-final", complete: async (_prompt, options) => options?.label === "capture:extract"
          ? JSON.stringify({ memories: [{ type: "note", text: "Morgan was born 1990-05-21.", salience: 0.8,
            isInsight: false, source: "user", entityIds: ["person:morgan"], labels: [{ ...fact, value: { type: "date", date: "1990-05-21" } }] }],
            entities: [{ id: "person:morgan", name: "Morgan", type: "person" }], relations: [] })
          : JSON.stringify([{ index: 0, action: "supersede", targetId: "LABEL-2", text: "Morgan was born 1990-05-22." }]) },
        nextId: () => `LABEL-${nextId++}`, now: () => at, conversationId: "conv-1",
        captureSpeakerKind: "human-turn", captureEvidence: evidence("Morgan was born 1990-05-21."),
        captureSettings: { only: ["fact"] }, canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
      });
      expect(discarded.actions).toEqual([{ kind: "supersede", oldId: "LABEL-2", newId: "LABEL-3" }]);
      expect(db.get("LABEL-2")?.text).toBe(finalText);
      expect(db.get("LABEL-3")?.text).toBe("Morgan was born 1990-05-22.");
      expect(db.labelsForEntity("person:morgan").at(-1)?.label)
        .toEqual({ v: 1, kind: "fact", entityId: "person:morgan", attribution: "user-stated" });
    } finally { db.close(); }
  });

  it("persists owner custom facts and preferences as queryable labels without labelling chatter", async () => {
    const root = mkdtempSync(join(tmpdir(), "capture-owner-query-"));
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(8), dim: 8 });
    const owner = { v: 1, kind: "fact", entityId: "person:owner", key: "other:favorite-animal",
      value: { type: "text", text: "otter" }, attribution: "user-stated" };
    const classFact = { v: 1, kind: "fact", entityId: "person:maple", key: "other:art-class",
      value: { type: "text", text: "art class" }, attribution: "user-stated" };
    const user = "My favorite animal is otter. Never use long fictional summaries. Maple attends art class on Monday mornings.";
    try {
      await captureTurnStrict(`User: ${user}\nAssistant: Noted.`, {
        db, root, llm: { id: "fake", complete: async () => JSON.stringify({ memories: [
          { type: "note", text: "The user favors otter as a favorite animal.", salience: 0.8, isInsight: false, source: "user", entityIds: ["person:owner"], labels: [owner] },
          { type: "note", text: "Never use long fictional summaries.", salience: 0.8, isInsight: false, source: "user", entityIds: [], labels: [preference] },
          { type: "note", text: "Maple attends art class on Monday mornings.", salience: 0.8, isInsight: false, source: "user", entityIds: ["person:maple"], labels: [classFact] },
          { type: "note", text: "The assistant said hello.", salience: 0.3, isInsight: false, source: "assistant", entityIds: [], labels: [preference] },
        ], entities: [{ id: "person:owner", name: "Owner", type: "person" },
          { id: "person:maple", name: "Maple", type: "person" }], relations: [] }) },
        nextId: (() => { let id = 0; return () => `OWNER-${id++}`; })(), now: () => at,
        conversationId: "web:fictional", captureSpeakerKind: "human-turn",
        captureEvidence: evidence(user, { ownerTurn: true }),
        canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
      });
      expect(db.listLabels({}, 20).hits.map((hit) => hit.label.kind).sort()).toEqual(["fact", "fact", "preference"]);
      expect(db.labelsForEntity("person:owner")[0]?.label)
        .toEqual({ v: 1, kind: "fact", entityId: "person:owner", attribution: "user-stated" });
      expect(db.labelsForEntity("person:maple")[0]?.label)
        .toEqual({ v: 1, kind: "fact", entityId: "person:maple", attribution: "user-stated" });
      const source = parseDailyFile(readFileSync(join(root, "daily", "2026-07-12.md"), "utf8"));
      expect(source.bullets.flatMap(labelsOf).map((label) => label.kind).sort()).toEqual(["fact", "fact", "preference"]);
    } finally { db.close(); }
  });

  it("derives coarse facts without model labels and excludes task lines", async () => {
    const root = mkdtempSync(join(tmpdir(), "capture-host-coarse-"));
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(8), dim: 8 });
    try {
      const user = "Maple attends art class on Mondays.";
      await captureTurnStrict(`User: ${user}\nAssistant: Noted.`, {
        db, root, llm: { id: "fake", complete: async () => JSON.stringify({ memories: [
          { type: "note", text: user, salience: 0.8, isInsight: false, source: "user", entityIds: ["person:maple"], labels: [] },
          { type: "task", text: "Maple should check the art class list.", salience: 0.8,
            isInsight: false, source: "user", entityIds: ["person:maple"], labels: [] },
        ], entities: [{ id: "person:maple", name: "Maple", type: "person" }], relations: [] }) },
        nextId: (() => { let id = 0; return () => `COARSE-${id++}`; })(), now: () => at,
        conversationId: "conv-1", captureSpeakerKind: "human-turn", captureEvidence: evidence(user),
        canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
      });
      expect(db.listLabels({ kind: "fact" }, 20).hits.map((hit) => hit.label)).toEqual([
        { v: 1, kind: "fact", entityId: "person:maple", attribution: "user-stated" },
      ]);
      const source = parseDailyFile(readFileSync(join(root, "daily", "2026-07-12.md"), "utf8"));
      expect(source.bullets.flatMap(labelsOf)).toHaveLength(1);
    } finally { db.close(); }
  });

  it("keeps a coarse fact user-stated only for a user source whose text names the person", () => {
    const context = (userText: string, source?: "user" | "assistant" | "tool" | "document") => ({
      captureSpeakerKind: "human-turn" as const, entityIds: ["person:morgan"],
      entityNames: new Map([["person:morgan", "Morgan"]]), captureEvidence: evidence(userText),
      ...(source === undefined ? {} : { source }) });
    const line = "Morgan attends art class on Mondays.";
    const stated = [{ v: 1, kind: "fact", entityId: "person:morgan", attribution: "user-stated" }];
    const inferred = [{ v: 1, kind: "fact", entityId: "person:morgan", attribution: "assistant-inferred" }];
    for (const user of ["Morgan has an art class every Monday.", "Morgan chodzi na plastykę w poniedziałki.",
      "Morgan va a clase de arte los lunes."]) {
      expect(deriveCoarseFactLabels(line, "note", context(user, "user"))).toEqual(stated);
    }
    // The model judged that the assistant, not the user, made the claim.
    expect(deriveCoarseFactLabels(line, "note", context("¿Qué hace Morgan los lunes?", "assistant"))).toEqual(inferred);
    expect(deriveCoarseFactLabels(line, "note", context("Morgan has an art class.", "document"))).toEqual(inferred);
    expect(deriveCoarseFactLabels(line, "note", context("Morgan has an art class."))).toEqual(inferred);
    // A user source whose own text never names the person stays inferred.
    expect(deriveCoarseFactLabels(line, "note", context("Tell me about the class.", "user"))).toEqual(inferred);
    // A user source is bounded to a human turn with user text.
    const { captureSpeakerKind: _kind, ...unverified } = context("Morgan has an art class.", "user");
    expect(deriveCoarseFactLabels(line, "note", unverified)).toEqual(inferred);
    expect(captureLabels(stated, line, context("Czy Morgan chodzi na plastykę?", "assistant"))).toEqual(inferred);
    expect(captureLabels(stated, line, context("Morgan attends an art class.", "user"))).toEqual(stated);
  });

  it("bounds the model's source by host evidence", () => {
    const human = { captureSpeakerKind: "human-turn" as const, captureEvidence: evidence("Morgan is here.") };
    expect(boundedCaptureSource("user", human)).toBe("user");
    expect(boundedCaptureSource("user", { ...human, captureEvidence: evidence("  ") })).toBe("assistant");
    expect(boundedCaptureSource("user", { captureSpeakerKind: "trigger", captureEvidence: evidence("Morgan") })).toBe("assistant");
    expect(boundedCaptureSource("tool", human)).toBe("assistant");
    expect(boundedCaptureSource("tool", { captureEvidence: evidence("", { toolOutcomes: [{ category: "execute", outcome: "succeeded" }] }) }))
      .toBe("tool");
    expect(boundedCaptureSource("document", human)).toBe("document");
    expect(boundedCaptureSource(undefined, human)).toBeUndefined();
  });

  it("keeps a retained legacy plan's already-validated labels while its text is unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "capture-legacy-plan-"));
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(8), dim: 8 });
    const turn = "User: I prefer concise fictional notes.\nAssistant: Noted.";
    const owner = { v: 1, kind: "fact", entityId: "person:owner", attribution: "user-stated" } as const;
    // Retained before `source` existed: no source field, labels validated by the old gates.
    retainCapturePlan(root, "b".repeat(64), capturePlanInputHash(turn), { candidates: [
      { type: "note", text: "The user prefers concise fictional notes.", salience: 0.8, isInsight: false,
        entityIds: ["person:owner"], labels: [owner, preference as never] },
    ], entities: [{ id: "person:owner", name: "Owner", type: "person" }], relations: [] });
    try {
      await captureTurnStrict(turn, {
        db, root, llm: { id: "no-extract", complete: async () => { throw new Error("must not re-extract"); } },
        nextId: () => "LEGACY-0", now: () => at, conversationId: "web:fictional", captureSpeakerKind: "human-turn",
        captureEvidence: evidence("I prefer concise fictional notes.", { ownerTurn: true }),
        captureRetentionKey: "b".repeat(64), canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
      });
      expect(db.listLabels({}, 20).hits.map((hit) => hit.label).sort((a, b) => a.kind.localeCompare(b.kind)))
        .toEqual([owner, preference]);
    } finally { db.close(); }
  });

  it("writes one validated label with its canonical bullet and restores parity on rebuild", async () => {
    const root = mkdtempSync(join(tmpdir(), "capture-labels-integration-"));
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(8), dim: 8 });
    try {
      const user = "Morgan was born 1990-05-17.";
      const result = await captureTurnStrict(`User: ${user}\nAssistant: Noted.`, {
        db, root, llm: { id: "fake", complete: async () => JSON.stringify({
          memories: [{ type: "note", text: user, salience: 0.8, isInsight: false, source: "user", entityIds: ["person:morgan"], labels: [fact] }],
          entities: [{ id: "person:morgan", name: "Morgan", type: "person" }], relations: [],
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
