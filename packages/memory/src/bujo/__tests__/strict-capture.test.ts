import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../../store/index.js";
import { extractCapturePlanStrict, MAX_CAPTURE_MEMORIES } from "../capture-batch.js";
import { appendBullet } from "../daily.js";
import { reconcileBatch as reconcileBatchImpl } from "../reconcile.js";
import { assertCanonicalGraphRepairBaseParity } from "../rebuild.js";
import type { Bullet, CandidateMemory } from "../types.js";
import { fakeEmbeddings } from "./helpers.js";

const FIXED = new Date("2026-07-12T09:00:00.000Z");

const reconcileBatch: typeof reconcileBatchImpl = async (candidates, deps) => await reconcileBatchImpl(candidates, {
  ...deps,
  canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
});

const validPlan = {
  memories: [{
    type: "note",
    text: "Morgan prefers strict durable capture.",
    salience: 0.8,
    isInsight: false,
    entityIds: ["person:morgan"],
  }],
  entities: [{ id: "person:morgan", name: "Morgan", type: "person" }],
  relations: [],
};

describe("strict completed-turn extraction", () => {
  it("accepts exact empty arrays as an explicit no-op", async () => {
    await expect(extractCapturePlanStrict("completed turn", {
      id: "empty",
      complete: async () => '{"memories":[],"entities":[],"relations":[]}',
    })).resolves.toEqual({ candidates: [], entities: [], relations: [] });
  });

  it("accepts one fully valid exact plan without normalizing fields", async () => {
    await expect(extractCapturePlanStrict("completed turn", {
      id: "valid",
      complete: async () => JSON.stringify(validPlan),
    })).resolves.toEqual({
      candidates: [{
        type: "note",
        text: "Morgan prefers strict durable capture.",
        salience: 0.8,
        isInsight: false,
        entityIds: ["person:morgan"],
      }],
      entities: validPlan.entities,
      relations: [],
    });
  });

  it.each([
    ["prose wrapper", `result: ${JSON.stringify(validPlan)}`],
    ["duplicate root key", '{"memories":[],"memories":[],"entities":[],"relations":[]}'],
    ["missing root array", JSON.stringify({ memories: [], entities: [] })],
    ["unknown root field", JSON.stringify({ ...validPlan, extra: [] })],
    ["wrong root type", JSON.stringify({ ...validPlan, relations: {} })],
    ["unknown memory discriminator", JSON.stringify({ ...validPlan, memories: [{ ...validPlan.memories[0], type: "secret" }] })],
    ["missing memory field", JSON.stringify({ ...validPlan, memories: [{ type: "note", text: "fact", salience: 0.5, entityIds: [] }] })],
    ["unknown memory field", JSON.stringify({ ...validPlan, memories: [{ ...validPlan.memories[0], surprise: true }] })],
    ["wrong memory field type", JSON.stringify({ ...validPlan, memories: [{ ...validPlan.memories[0], isInsight: "false" }] })],
    ["control character", JSON.stringify({ ...validPlan, memories: [{ ...validPlan.memories[0], text: "bad\u0001text" }] })],
    ["Unicode line separator", JSON.stringify({ ...validPlan, memories: [{ ...validPlan.memories[0], text: "bad\u2028text" }] })],
    ["bidi formatting control", JSON.stringify({ ...validPlan, memories: [{ ...validPlan.memories[0], text: "bad\u202etext" }] })],
    ["zero-width formatting control", JSON.stringify({ ...validPlan, entities: [{ ...validPlan.entities[0], name: "Mor\u200bgan" }] })],
    ["unpaired surrogate", '{"memories":[{"type":"note","text":"bad\\ud800","salience":0.5,"isInsight":false,"entityIds":[]}],"entities":[],"relations":[]}'],
    ["overlong text", JSON.stringify({ ...validPlan, memories: [{ ...validPlan.memories[0], text: "x".repeat(161) }] })],
    ["too many memories", JSON.stringify({ ...validPlan, memories: Array.from({ length: MAX_CAPTURE_MEMORIES + 1 }, (_, index) => ({
      type: "note", text: `fact ${index}`, salience: 0.5, isInsight: false, entityIds: [],
    })) })],
    ["unknown entity reference", JSON.stringify({ ...validPlan, memories: [{ ...validPlan.memories[0], entityIds: ["person:unknown"] }] })],
    ["duplicate entity ids", JSON.stringify({ ...validPlan, entities: [...validPlan.entities, ...validPlan.entities] })],
    ["mismatched entity discriminator", JSON.stringify({
      ...validPlan,
      entities: [{ id: "person:morgan", name: "Morgan", type: "project" }],
    })],
    ["ambiguous duplicate memories", JSON.stringify({
      ...validPlan,
      memories: [validPlan.memories[0], { ...validPlan.memories[0], text: "Morgan prefers strict durable capture now." }],
    })],
    ["invalid relation", JSON.stringify({ ...validPlan, relations: [{ src: "person:morgan", dst: "person:unknown", relation: "knows" }] })],
    ["partial invalid item", JSON.stringify({ ...validPlan, memories: [validPlan.memories[0], { type: "note" }] })],
  ] as const)("rejects the whole plan for %s", async (_label, output) => {
    await expect(extractCapturePlanStrict("completed turn", {
      id: "invalid",
      complete: async () => output,
    })).rejects.toMatchObject({ name: "MemoryModelOutputError" });
  });
});

describe("strict completed-turn reconciliation", () => {
  it.each([
    ["malformed JSON", "not json"],
    ["duplicate decision key", '[{"index":0,"index":0,"action":"noop","targetId":"TARGET"}]'],
    ["missing decision", "[]"],
    ["duplicate index", JSON.stringify([
      { index: 0, action: "noop", targetId: "TARGET" },
      { index: 0, action: "noop", targetId: "TARGET" },
    ])],
    ["unknown action", JSON.stringify([{ index: 0, action: "merge", targetId: "TARGET" }])],
    ["unknown target", JSON.stringify([{ index: 0, action: "noop", targetId: "OTHER" }])],
    ["unexpected field", JSON.stringify([{ index: 0, action: "noop", targetId: "TARGET", confidence: 1 }])],
    ["partial update", JSON.stringify([{ index: 0, action: "update", targetId: "TARGET" }])],
    ["control replacement", JSON.stringify([{ index: 0, action: "update", targetId: "TARGET", text: "bad\u0001text" }])],
    ["bidi replacement", JSON.stringify([{ index: 0, action: "update", targetId: "TARGET", text: "bad\u202etext" }])],
  ] as const)("rejects %s without persisting the novel slot", async (_label, reply) => {
    const fixture = await reconcileFixture();
    try {
      await expect(reconcileBatch(fixture.candidates, {
        ...fixture.deps,
        strictModelOutput: true,
        llm: { id: "invalid", complete: async () => reply },
      })).rejects.toMatchObject({ name: "MemoryModelOutputError" });
      expect(fixture.db.count()).toBe(1);
      expect(fixture.db.get("TARGET")?.status).toBe("open");
    } finally {
      fixture.db.close();
    }
  });

  it("requires every close candidate once and rejects conflicting targets as a whole", async () => {
    const fixture = await reconcileFixture(true);
    try {
      await expect(reconcileBatch(fixture.candidates, {
        ...fixture.deps,
        strictModelOutput: true,
        llm: {
          id: "conflict",
          complete: async () => JSON.stringify([
            { index: 0, action: "noop", targetId: "TARGET" },
            { index: 1, action: "noop", targetId: "TARGET" },
          ]),
        },
      })).rejects.toMatchObject({ name: "MemoryModelOutputError" });
      expect(fixture.db.count()).toBe(1);
    } finally {
      fixture.db.close();
    }
  });

  it("accepts one exact decision for every offered close candidate", async () => {
    const fixture = await reconcileFixture();
    try {
      const actions = await reconcileBatch(fixture.candidates, {
        ...fixture.deps,
        strictModelOutput: true,
        llm: {
          id: "valid",
          complete: async () => JSON.stringify([{ index: 0, action: "noop", targetId: "TARGET" }]),
        },
      });
      expect(actions.map((action) => action?.kind)).toEqual(["noop", "add"]);
      expect(fixture.db.count()).toBe(2);
    } finally {
      fixture.db.close();
    }
  });
});

async function reconcileFixture(twoClose = false): Promise<{
  readonly db: ReturnType<typeof openMemoryDb>;
  readonly candidates: CandidateMemory[];
  readonly deps: Parameters<typeof reconcileBatch>[1];
}> {
  const root = mkdtempSync(join(tmpdir(), "strict-reconcile-"));
  const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(64), dim: 64 });
  const bullet: Bullet = {
    id: "TARGET",
    type: "note",
    status: "open",
    text: "Morgan prefers strict durable capture",
    salience: 0.7,
    isInsight: false,
    createdAt: FIXED.toISOString(),
    refs: [],
  };
  appendBullet(root, bullet, FIXED);
  await db.upsert({
    ...bullet,
    accessCount: 0,
    tags: [],
    source: { file: "daily/2026-07-12.md" },
  });
  const close: CandidateMemory = {
    type: "note",
    text: "Morgan prefers strict durable capture now",
    salience: 0.8,
    isInsight: false,
  };
  const candidates: CandidateMemory[] = twoClose
    ? [close, { ...close, text: "Morgan prefers strict durable capture always" }]
    : [close, { type: "task", text: "Schedule the remote retreat catering", salience: 0.6, isInsight: false }];
  db.findSimilarMany = async () => candidates.map((_candidate, index) => index === 0 || twoClose
    ? [{ record: db.get("TARGET")!, distance: 0.1 }]
    : []);
  return {
    db,
    candidates,
    deps: {
      db,
      root,
      llm: { id: "unused", complete: async () => "[]" },
      nextId: (() => { let id = 0; return () => `STRICT-${++id}`; })(),
      now: () => FIXED,
    },
  };
}
