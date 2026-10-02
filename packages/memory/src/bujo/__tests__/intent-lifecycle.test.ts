import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findRetainedCaptureIntent, replayCaptureIntent } from "../capture-outbox.js";
import { appendBullet } from "../daily.js";
import { capturePlanInputHash, retainCapturePlan } from "../capture-plan-cache.js";
import { reconcile, reconcileBatch } from "../reconcile.js";
import { captureTurnStrict } from "../capture.js";
import { openMemoryDb } from "../../store/index.js";
import { assertCanonicalGraphRepairBaseParity } from "../rebuild.js";
import { extractCapturePlanStrict } from "../capture-batch.js";
import { createBujoMemoryStore } from "../store.js";
import { parseDailyFile, parseBullet, serializeBullet } from "../grammar.js";
import { recallLineEndDate, selectPossiblyRelevantRecallHits } from "../recall.js";
import { safeRebuildMemoryIndex } from "../rebuild.js";
import { fakeEmbeddings } from "./helpers.js";
import type { CandidateMemory } from "../distill.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const observedAt = "2032-06-10T23:30:00.000Z";
const observation = (text: string) => ({ observedAt, captureSpeakerKind: "human-turn" as const,
  captureEvidence: { ownerTurn: true as const, userText: text, toolOutcomes: [] } });
const memory = (text: string, intentState?: CandidateMemory["intentState"], validTo?: string) => ({
  type: "note", text, source: "user", entityIds: ["person:owner"], salience: 0.8, isInsight: false,
  ...(intentState === undefined ? {} : { intentState }), ...(validTo === undefined ? {} : { validTo }),
});
const stateText = (state: CandidateMemory["intentState"]) => state === "planned" ? "Owner plans a canoe lesson."
  : state === "pending" ? "Owner awaits a canoe lesson." : state === "done" ? "Owner completed the canoe lesson." : "Owner abandoned the canoe lesson.";
const response = (item: ReturnType<typeof memory>) => JSON.stringify({ memories: [item],
  entities: [{ id: "person:owner", name: "Owner", type: "person" }], relations: [] });
const texts = ["Owner plans a canoe lesson.", "Właściciel planuje lekcję gry na flecie.",
  "Il proprietario attende una lezione di mosaico.", "La persona ha abandonado el curso de vela."];

describe("supported intention lifecycle", () => {
  it("primitive capture proposal round trip", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-primitive-")); roots.push(root);
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(16), dim: 16 });
    try {
      await captureTurnStrict(texts[0]!, { root, db, now: () => new Date(observedAt), nextId: () => "fixture-primitive",
        captureRetentionKey: "a".repeat(64), captureSettings: { intentLifecycle: true }, canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
        captureSpeakerKind: "human-turn", captureEvidence: observation(texts[0]!).captureEvidence,
        llm: { id: "fixture", complete: async (_prompt, opts) => opts?.label === "capture:review"
          ? '{"decisions":[{"index":0,"decision":"none"}]}' : response(memory(texts[0]!, "pending", "2032-06-09")) },
      });
      const handle = findRetainedCaptureIntent(root, "a".repeat(64))!;
      expect(handle).toBeDefined();
      replayCaptureIntent(root, handle, db, { canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity });
      replayCaptureIntent(root, handle, db, { canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity });
      expect(parseDailyFile(readFileSync(join(root, "daily", "2032-06-10.md"), "utf8")).bullets).toHaveLength(1);
      expect(db.get("fixture-primitive")).toMatchObject({ status: "open", dueAt: "2032-06-09" });
      expect(db.get("fixture-primitive")?.validTo).toBeUndefined();
    } finally { db.close(); }
  });

  it.each([
    ["Owner plans a canoe lesson.", "Owner awaits a canoe lesson.", "Owner completed the canoe lesson.", "Owner abandoned the canoe lesson."],
    ["Właściciel planuje kurs gry na flecie.", "Właściciel czeka na kurs gry na flecie.", "Właściciel ukończył kurs gry na flecie.", "Właściciel porzucił kurs gry na flecie."],
    ["Il proprietario pianifica un corso di mosaico.", "Il proprietario attende un corso di mosaico.", "Il proprietario ha completato il corso di mosaico.", "Il proprietario ha abbandonato il corso di mosaico."],
    ["La persona planea un curso de vela.", "La persona espera un curso de vela.", "La persona ha completado el curso de vela.", "La persona ha abandonado el curso de vela."],
  ])("maps supported structured proposals in any language: %s", async (...sentences) => {
    for (const [index, state] of (["planned", "pending", "done", "abandoned"] as const).entries()) {
      const text = sentences[index]!;
      const plan = await extractCapturePlanStrict(text, { id: "fictional", complete: async () => response(memory(text, state)) },
        undefined, [], observation(text), undefined, false, true);
      expect(plan.candidates[0]).toMatchObject({ type: "note", intentState: state });
      expect(plan.candidates[0]).not.toHaveProperty("validTo");
    }
  });

  it("accepts a supported past end but never infers completion, anchors relative dates only in the opt-in prompt", async () => {
    const llm = { id: "fictional-end", complete: async (prompt: string) => {
      expect(prompt).toContain(observedAt); expect(prompt).toContain("Never invent an unstated date or timezone");
      expect(prompt).toContain("Undated plans/pending intentions have no validTo");
      return response(memory(texts[0]!, "pending", "2032-06-09"));
    } };
    const plan = await extractCapturePlanStrict(texts[0]!, llm, undefined, [], observation(texts[0]!), undefined, false, true);
    expect(plan.candidates[0]).toMatchObject({ intentState: "pending", validTo: "2032-06-09" });
  });

  it("preserves an explicitly supported offset civil end through its last millisecond", async () => {
    const end = "2032-06-10T23:59:59.999+02:00";
    const text = "Owner awaits a canoe lesson through June 10 in UTC+02:00.";
    const plan = await extractCapturePlanStrict(text, { id: "fixture-zone", complete: async () => response(memory(text, "pending", end)) },
      undefined, [], observation(text), undefined, false, true);
    expect(plan.candidates[0]?.validTo).toBe(end);
    const record = { type: "note" as const, text, dueAt: end };
    expect(recallLineEndDate(record, "2032-06-10", "2032-06-10T21:59:59.999Z", true)).toBeUndefined();
    expect(recallLineEndDate(record, "2032-06-10", "2032-06-10T22:00:00.000Z", true)).toBe(end);
  });

  it("rejects impossible/non-civil ends and ungated proposal fields", async () => {
    for (const validTo of ["2032-02-30", "2032-06-10T12:00:00Z", "tomorrow"]) {
      await expect(extractCapturePlanStrict(texts[0]!, { id: "invalid", complete: async () => response(memory(texts[0]!, "pending", validTo)) },
        undefined, [], observation(texts[0]!), undefined, false, true)).rejects.toThrow("intent_end_invalid");
    }
    await expect(extractCapturePlanStrict(texts[0]!, { id: "off", complete: async () => response(memory(texts[0]!, "done")) },
      undefined, [], observation(texts[0]!))).rejects.toThrow("missing or unknown fields");
  });

  it.each([null, ["done"], { state: "done" }, 1, "unknown"])("rejects an invalid state without coercion: %s", async (intentState) => {
    await expect(extractCapturePlanStrict(texts[0]!, { id: "invalid-state", complete: async () => response({ ...memory(texts[0]!), intentState } as ReturnType<typeof memory>) },
      undefined, [], observation(texts[0]!), undefined, false, true)).rejects.toThrow("intent_proposal_invalid");
  });

  it.each(["assistant", "tool", "document", "user"] as const)("requires verified owner evidence, not just model source %s", async (source) => {
    const plan = await extractCapturePlanStrict(texts[0]!, { id: "untrusted", complete: async () => response({ ...memory(texts[0]!, "done", "2032-06-10"), source }) },
      undefined, [], { observedAt, captureSpeakerKind: "human-turn", captureEvidence: { userText: texts[0]!, toolOutcomes: [] } }, undefined, false, true);
    expect(plan.candidates[0]).not.toHaveProperty("intentState"); expect(plan.candidates[0]).not.toHaveProperty("validTo");
  });

  it("keeps flags-off prompt, schema and candidates exactly identical", async () => {
    const prompts: string[] = [], schemas: unknown[] = [];
    const llm = { id: "off", complete: async (prompt: string, opts?: { outputSchema?: Readonly<Record<string, unknown>> }) => {
      prompts.push(prompt); schemas.push(opts?.outputSchema); return response(memory(texts[0]!));
    } };
    const absent = await extractCapturePlanStrict(texts[0]!, llm, undefined, [], observation(texts[0]!));
    const off = await extractCapturePlanStrict(texts[0]!, llm, undefined, [], observation(texts[0]!), undefined, false, false);
    expect(off).toEqual(absent); expect(prompts[1]).toBe(prompts[0]); expect(schemas[1]).toEqual(schemas[0]);
    expect(JSON.stringify(schemas[0])).toContain('"validTo":{"type":"string","pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"}');
    expect(prompts[0]).not.toContain("INTENTION LIFECYCLE POLICY");
  });

  it.each([["planned", "scheduled"], ["pending", "open"], ["done", "done"], ["abandoned", "dropped"]] as const)(
    "persists %s as %s, using due= only and canonical rebuild", async (state, status) => {
      const root = mkdtempSync(join(tmpdir(), "intent-roundtrip-")); roots.push(root);
      const embeddings = fakeEmbeddings(16);
      const text = `${stateText(state).slice(0, -1)} (end 2032-06-09).`;
      const store = createBujoMemoryStore({ root, tier: "bujo", embeddings, dim: 16, clock: () => new Date(observedAt),
        capture: { intentLifecycle: true }, recall: { intentExpiry: true }, llm: { id: "fixture", complete: async (_prompt, opts) =>
          opts?.label === "capture:review" ? '{"decisions":[{"index":0,"decision":"none"}]}' : response(memory(text, state, "2032-06-09")) } });
      await store.persistCompletedTurn({ runId: `fictional-${state}`, conversationId: "fictional-chat", summary: "A lesson was discussed.",
        captureText: text, captureSpeakerKind: "human-turn", captureEvidence: observation(text).captureEvidence });
      await store.flush();
      const source = readFileSync(join(root, "daily", "2032-06-10.md"), "utf8");
      const bullet = parseDailyFile(source).bullets[0]!;
      expect(bullet).toMatchObject({ type: "note", status, dueAt: "2032-06-09" });
      expect(parseBullet(serializeBullet(bullet))).toEqual(bullet);
      expect(source).not.toContain("validTo="); expect(source).not.toContain("intentState=");
      if (state !== "abandoned") {
        const record = (await store.recallWithOutcome(text, { trackAccess: false })).hits[0]!.record;
        expect(record).toMatchObject({ status, dueAt: "2032-06-09" }); expect(record.validTo).toBeUndefined();
      }
      expect(await store.load("fictional-chat", text)).toBeUndefined();
      await store.close();
      await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings, dim: 16 });
      expect(readFileSync(join(root, "daily", "2032-06-10.md"), "utf8")).toBe(source);
      const reader = createBujoMemoryStore({ root, tier: "bujo", readOnly: true, embeddings, dim: 16 });
      if (state !== "abandoned") expect((await reader.recallWithOutcome(text, { trackAccess: false })).hits[0]!.record).toMatchObject({ status, dueAt: "2032-06-09" });
      await reader.close();
    });

  it.each([reconcile, reconcileBatch])("validates public lifecycle proposals before publication: %s", async (run) => {
    const root = mkdtempSync(join(tmpdir(), "intent-invalid-api-")); roots.push(root);
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(16), dim: 16 });
    try {
      for (const validTo of ["tomorrow", "2032-06-31", "2032-06-10T24:00:00Z"]) {
        await expect(run([{ type: "note", text: texts[0]!, salience: 0.8, isInsight: false,
          source: "user", intentState: "pending", validTo }], { root, db, nextId: () => "invalid-api",
          now: () => new Date(observedAt), captureSpeakerKind: "human-turn", captureEvidence: observation(texts[0]!).captureEvidence,
          llm: { id: "unused", complete: async () => { throw new Error("fictional model must not run"); } } })).rejects.toThrow("intent_end_invalid");
      }
      expect(db.topSalient(10)).toEqual([]); expect(existsSync(join(root, "daily"))).toBe(false);
      expect(existsSync(join(root, ".capture-outbox"))).toBe(false);
    } finally { db.close(); }
  });

  it("rejects a malformed retained lifecycle plan before any canonical/outbox publication", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-invalid-retained-")); roots.push(root);
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(16), dim: 16 });
    const key = "b".repeat(64);
    retainCapturePlan(root, key, capturePlanInputHash(texts[0]!), { entities: [], relations: [], candidates: [{
      type: "note", text: texts[0]!, salience: 0.8, isInsight: false, source: "user", intentState: "pending", validTo: "tomorrow",
    }] });
    try {
      await expect(captureTurnStrict(texts[0]!, { root, db, captureRetentionKey: key,
        nextId: () => "invalid-retained", now: () => new Date(observedAt), captureSettings: { intentLifecycle: true },
        captureSpeakerKind: "human-turn", captureEvidence: observation(texts[0]!).captureEvidence,
        llm: { id: "unused", complete: async () => { throw new Error("fictional model must not run"); } } })).rejects.toThrow("intent_end_invalid");
      expect(findRetainedCaptureIntent(root, key)).toBeUndefined();
      expect(db.topSalient(10)).toEqual([]); expect(existsSync(join(root, "daily"))).toBe(false);
    } finally { db.close(); }
  });

  it.each([
    ["noop", "pending", undefined, "noop"], ["update", "pending", undefined, "supersede"],
    ["supersede", "pending", undefined, "supersede"], ["noop", "done", undefined, "supersede"],
    ["noop", "pending", "2032-06-12", "supersede"],
  ] as const)("preserves an omitted supported end during %s/%s (new end %s)", async (action, intentState, validTo, expected) => {
    const root = mkdtempSync(join(tmpdir(), "intent-repeat-")); roots.push(root);
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(16), dim: 16 });
    const createdAt = "2032-06-01T12:00:00.000Z", oldText = "Owner awaits a canoe lesson through June 9.";
    appendBullet(root, { id: "earlier-intention", type: "note", status: "open", text: oldText, createdAt,
      dueAt: "2032-06-09", salience: 0.8, isInsight: false, refs: [] }, new Date(createdAt));
    try {
      await db.upsert({ id: "earlier-intention", type: "note", status: "open", text: oldText, createdAt,
        dueAt: "2032-06-09", salience: 0.8, isInsight: false, accessCount: 0, tags: [], source: { file: "daily/2032-06-01.md" } });
      db.findSimilarMany = async () => [[{ record: db.get("earlier-intention")!, distance: 0.1 }]];
      const text = stateText(intentState);
      const result = await reconcileBatch([{ type: "note", text, salience: 0.8, isInsight: false, source: "user", intentState,
        ...(validTo === undefined ? {} : { validTo }) }], { root, db, nextId: () => "repeated-intention", now: () => new Date(observedAt),
        captureSettings: { intentLifecycle: true }, captureSpeakerKind: "human-turn", captureEvidence: observation(text).captureEvidence,
        canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity, strictModelOutput: true,
        llm: { id: "repeat", complete: async () => JSON.stringify([{ index: 0, action, targetId: "earlier-intention",
          ...(action === "noop" ? {} : { text }) }]) } });
      expect(result[0]?.kind).toBe(expected);
      const record = db.get(expected === "noop" ? "earlier-intention" : "repeated-intention")!;
      expect(record.dueAt).toBe(validTo ?? "2032-06-09");
      expect(selectPossiblyRelevantRecallHits([{ score: 0.9, record }], { intentExpiry: true, asOf: "2032-06-10" })).toEqual([]);
    } finally { db.close(); }
  });

  it("UPDATE of a supported intention uses SUPERSEDE and preserves the old sentence and date", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-supersede-")); roots.push(root);
    const embeddings = fakeEmbeddings(16); let now = observedAt; let completed = false; const warnings: string[] = [];
    const done = "Owner completed the canoe lesson.";
    const store = createBujoMemoryStore({ root, tier: "bujo", embeddings, dim: 16, clock: () => new Date(now),
      logger: { warn: (code) => { warnings.push(code); } }, capture: { intentLifecycle: true }, recall: { semanticOnly: true, intentExpiry: true }, llm: { id: "fixture", complete: async (prompt, opts) => {
        if (opts?.label === "capture:review") return '{"decisions":[{"index":0,"decision":"none"}]}';
        if (opts?.label === "capture:reconcile-batch") {
          const input = JSON.parse(prompt.split("INPUT:\n").at(-1)!) as Array<{ existing: Array<{ id: string }> }>;
          return JSON.stringify([{ index: 0, action: "update", targetId: input[0]!.existing[0]!.id, text: done }]);
        }
        return response(memory(completed ? done : texts[0]!, completed ? "done" : "pending"));
      } } });
    const capture = async (runId: string, text: string) => {
      await store.persistCompletedTurn({ runId, conversationId: "fictional-chat", summary: "A lesson state was reported.", captureText: text,
        captureSpeakerKind: "human-turn", captureEvidence: observation(text).captureEvidence }); await store.flush();
    };
    await capture("fictional-pending", texts[0]!);
    expect(warnings).toEqual([]);
    completed = true; now = "2032-06-11T12:00:00.000Z";
    await capture("fictional-done", done);
    const bullets = readdirSync(join(root, "daily")).flatMap((file) => parseDailyFile(readFileSync(join(root, "daily", file), "utf8")).bullets);
    expect(bullets).toHaveLength(2);
    expect(bullets.find((bullet) => bullet.text === texts[0]!)).toMatchObject({ status: "invalidated", createdAt: observedAt });
    expect(bullets.find((bullet) => bullet.text === done)).toMatchObject({ status: "done", createdAt: now });
    expect(await store.load("fictional-chat", done)).toBeUndefined();
    await store.close();
    await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings, dim: 16 });
    const reader = createBujoMemoryStore({ root, tier: "bujo", readOnly: true, embeddings, dim: 16 });
    expect((await reader.recallWithOutcome(done, { trackAccess: false })).hits[0]!.record.status).toBe("done"); await reader.close();
  });
});

describe("inclusive ends and conservative automatic policy", () => {
  it("uses the trusted host civil date at timezone boundaries, never timestamp midnight for civil ends", () => {
    const record = { type: "note" as const, text: texts[0]!, dueAt: "2032-06-10" };
    expect(recallLineEndDate(record, "2032-06-10", "2032-06-11T06:59:59.999Z", true)).toBeUndefined();
    expect(recallLineEndDate(record, "2032-06-11", "2032-06-11T07:00:00.000Z", true)).toBe("2032-06-10");
    expect(recallLineEndDate(record, "2032-06-11", undefined, false)).toBeUndefined();
    expect(recallLineEndDate({ ...record, type: "task" }, "2032-06-11", undefined, true)).toBeUndefined();
    const instant = { ...record, dueAt: "2032-06-10T23:00:00-07:00" };
    expect(recallLineEndDate(instant, "2032-06-10", "2032-06-11T06:00:00.000Z", true)).toBeUndefined();
    expect(recallLineEndDate(instant, "2032-06-10", "2032-06-11T06:00:00.001Z", true)).toBe(instant.dueAt);
  });
  it.each(texts)("injects no done, abandoned, expired or ambiguous legacy dated note: %s", (text) => {
    for (const dueAt of [undefined, "2032-06-09", "2032-06-10", "2032-06-12", "legacy-ambiguous"]) {
      for (const status of ["open", "done", "dropped"] as const) {
        const hit = { score: 0.9, record: { id: "intention", text, type: "note" as const, status, ...(dueAt === undefined ? {} : { dueAt }) } };
        expect(selectPossiblyRelevantRecallHits([hit], { intentExpiry: true, asOf: "2032-06-10" })).toHaveLength(status === "open" && dueAt === undefined ? 1 : 0);
      }
    }
  });
});
