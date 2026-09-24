import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryCaptureEvidence } from "@mono-agent/agent-contracts";
import { describe, expect, it } from "vitest";
import { openMemoryDb } from "../../store/index.js";
import { extractCapturePlanStrict } from "../capture-batch.js";
import { captureTurnStrict } from "../capture.js";
import { auditCanonicalGraphParity } from "../graph-parity.js";
import { labelsOf } from "../labels.js";
import { parseDailyFile } from "../grammar.js";
import { assertCanonicalGraphRepairBaseParity, rebuildFromMarkdown } from "../rebuild.js";
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
    expect((await extract("Morgan was born 05/06/1990.", [fact], trusted)).candidates[0]?.labels).toBeUndefined();
    expect((await extract("Morgan was born 17/05/1990.", [fact], trusted)).candidates[0]?.labels).toEqual([fact]);
    expect((await extract("Morgan was born May 17, 1990.", [fact, { ...fact, value: { type: "date", date: "1990-02-30" } }], trusted))
      .candidates[0]?.labels).toEqual([fact]);
  });

  it("forces unidentified human preferences to conversation scope and drops trigger preferences", async () => {
    const sentence = "Morgan prefers concise project notes.";
    const user = "Morgan prefers concise project notes.";
    const context = { captureSpeakerKind: "human-turn" as const, conversationId: "conv-1",
      captureEvidence: evidence(user) };
    expect((await extract(sentence, [preference], context)).candidates[0]?.labels)
      .toEqual([{ ...preference, scope: "conversation:conv-1" }]);
    expect((await extract(sentence, [preference], { ...context,
      captureEvidence: evidence(user, { senderToken: "a".repeat(32) }) })).candidates[0]?.labels)
      .toEqual([{ ...preference, scope: `user:${"a".repeat(32)}` }]);
    expect((await extract(sentence, [preference], { ...context, captureSpeakerKind: "trigger" })).candidates[0]?.labels)
      .toBeUndefined();
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

  it("drops a fact whose supported value was clamped away and rejects malformed label array structure", async () => {
    const text = `${"Morgan keeps notes. ".repeat(12)} Morgan was born May 17, 1990.`;
    const plan = await extract(text, [fact], { captureSpeakerKind: "human-turn",
      captureEvidence: evidence("Morgan was born May 17, 1990.") });
    expect(plan.candidates[0]?.labels).toBeUndefined();
    await expect(extractCapturePlanStrict("turn", { id: "bad-structure", complete: async () => JSON.stringify({
      memories: [{ type: "note", text: "Morgan keeps notes.", salience: 0.8, isInsight: false,
        entityIds: [], labels: {} }], entities: [], relations: [],
    }) })).rejects.toThrow(/labels structure/u);
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
