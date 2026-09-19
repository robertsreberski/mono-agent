import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openMemoryDb, type MemoryDb, type MemoryRecord } from "../../store/index.js";
import { isRememberedMemoryId, REMEMBER_ID_PREFIX } from "../canonical-lookup.js";
import { writeCaptureIntent, replayCaptureIntent } from "../capture-outbox.js";
import {
  appendBullet,
  dailyFilePath,
  normalizeMemoryText,
  normalizedContentHash,
} from "../daily.js";
import { parseDailyFile } from "../grammar.js";
import { createIdFactory } from "../ids.js";
import { assertCanonicalGraphRepairBaseParity, safeRebuildMemoryIndex } from "../rebuild.js";
import { reconcile, reconcileBatch, type ReconcileDeps } from "../reconcile.js";
import { createBujoMemoryStore } from "../store.js";
import type { Bullet } from "../types.js";
import { fakeEmbeddings, fakeLlm } from "./helpers.js";

/**
 * A `Remember` write is content-addressed: its id is `RM-<sha256(normalized text)>`,
 * and `isRememberedMemoryId` treats that pairing as a self-verifying claim
 * (see canonical-lookup.ts). Reconciliation must therefore never rewrite the
 * text of such a bullet in place, or the id would assert a hash of text it no
 * longer holds — which silently makes the remembered fact unstorable again.
 */

const DIM = 64;
const FIXED = new Date("2026-06-15T12:00:00.000Z");

const REMEMBERED = "Robert prefers deployments on Tuesday mornings.";
const CANDIDATE = "Robert prefers deployments on Tuesday mornings with review.";
const MERGED = "Robert prefers deployments on Tuesday mornings with manual review.";

const openDbs: MemoryDb[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function newRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `bujo-remember-identity-${label}-`));
}

function openDb(root: string): MemoryDb {
  const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(DIM), dim: DIM });
  openDbs.push(db);
  return db;
}

function rememberedIdFor(text: string): string {
  return `${REMEMBER_ID_PREFIX}${normalizedContentHash(normalizeMemoryText(text))}`;
}

function makeDeps(db: MemoryDb, root: string, llm: ReconcileDeps["llm"]): ReconcileDeps {
  return {
    db,
    root,
    llm,
    nextId: createIdFactory({ clock: () => FIXED, random: () => 0 }),
    now: () => FIXED,
    canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
  };
}

/** Seed a bullet plus its index row directly, mirroring reconcile.test.ts. */
async function seedBullet(db: MemoryDb, root: string, id: string, text: string): Promise<void> {
  const bullet: Bullet = {
    id,
    type: "note",
    status: "open",
    text,
    salience: 0.5,
    isInsight: false,
    createdAt: FIXED.toISOString(),
    refs: [],
  };
  appendBullet(root, bullet, FIXED);
  const record: MemoryRecord = {
    id,
    type: "note",
    status: "open",
    text,
    salience: 0.5,
    isInsight: false,
    createdAt: FIXED.toISOString(),
    accessCount: 0,
    tags: [],
    source: { file: relative(root, dailyFilePath(root, FIXED)) },
  };
  await db.upsertMany([record]);
}

function bulletById(root: string, id: string): Bullet | undefined {
  return parseDailyFile(readFileSync(dailyFilePath(root, FIXED), "utf8"))
    .bullets.find((bullet) => bullet.id === id);
}

function batchUpdateLlm(targetId: string): ReconcileDeps["llm"] {
  return fakeLlm([
    ["Classify each candidate", JSON.stringify([{ index: 0, action: "update", targetId, text: MERGED }])],
    ["CLASSIFY a new candidate", JSON.stringify({ action: "update", targetId, text: MERGED })],
  ]);
}

describe("remembered-fact identity is preserved through reconciliation", () => {
  it("store.capture must not rewrite a remembered bullet in place (full pipeline)", async () => {
    const root = newRoot("capture");
    const rememberedId = rememberedIdFor(REMEMBERED);
    const store = createBujoMemoryStore({
      root,
      clock: () => FIXED,
      embeddings: fakeEmbeddings(DIM),
      dim: DIM,
      tier: "bujo",
      llm: fakeLlm([
        ["Extract one bounded", JSON.stringify({
          memories: [{ type: "note", text: CANDIDATE, salience: 0.6, isInsight: false, entityIds: [] }],
          entities: [],
          relations: [],
        })],
        ["Classify each candidate", JSON.stringify([
          { index: 0, action: "update", targetId: rememberedId, text: MERGED },
        ])],
      ]),
    });

    try {
      const written = await store.remember("conv-1", REMEMBERED);
      expect(written.id).toBe(rememberedId);
      expect(isRememberedMemoryId(rememberedId, REMEMBERED)).toBe(true);

      await store.capture("conv-1", `User: ${CANDIDATE}\nAssistant: noted.`);

      // The remembered bullet still holds the exact text its id hashes.
      const bullet = bulletById(root, rememberedId);
      expect(bullet?.text).toBe(REMEMBERED);
      expect(isRememberedMemoryId(rememberedId, bullet?.text ?? "")).toBe(true);

      // …so remembering the same fact again is still a truthful duplicate.
      const again = await store.remember("conv-1", REMEMBERED);
      expect(again.duplicate).toBe(true);
      expect(again.text).toBe(REMEMBERED);
    } finally {
      await store.close();
    }
  });

  it.each([
    ["batch", reconcileBatch],
    ["legacy", reconcile],
  ] as const)(
    "%s reconcile keeps a remembered bullet's text and still records the new information",
    async (_label, run) => {
      const root = newRoot("paths");
      const db = openDb(root);
      const rememberedId = rememberedIdFor(REMEMBERED);
      await seedBullet(db, root, rememberedId, REMEMBERED);
      const before = db.count();

      // This candidate is inside the default thread threshold (0.35), so the
      // redirected ADD is expected to thread to its neighbour. Assert the
      // precondition rather than assuming it, since threading is conditional.
      const [neighbour] = await db.findSimilar(CANDIDATE, 5);
      expect(neighbour?.record.id).toBe(rememberedId);
      expect(neighbour!.distance).toBeLessThanOrEqual(0.35);

      const actions = await run(
        [{ type: "note", text: CANDIDATE, salience: 0.6, isInsight: false }],
        makeDeps(db, root, batchUpdateLlm(rememberedId)),
      );

      // The UPDATE decision is redirected to an ADD, not applied in place.
      const action = actions[0];
      expect(action?.kind).toBe("add");
      const addedId = action?.kind === "add" ? action.id : "";
      expect(addedId).not.toBe(rememberedId);

      // Identity invariant holds in canonical source and in the index.
      expect(bulletById(root, rememberedId)?.text).toBe(REMEMBERED);
      expect(db.get(rememberedId)?.text).toBe(REMEMBERED);
      expect(isRememberedMemoryId(rememberedId, db.get(rememberedId)?.text ?? "")).toBe(true);

      // The new row carries the CANDIDATE text, not the model's merged text:
      // nothing is rewritten, so there is nothing to merge into.
      expect(db.get(addedId)?.text).toBe(CANDIDATE);
      expect(db.get(addedId)?.text).not.toBe(MERGED);
      expect(bulletById(root, addedId)?.text).toBe(CANDIDATE);

      // The refinement is not discarded: it lands as its own memory, and the
      // remembered fact is NOT marked invalidated/superseded (no invented
      // contradiction — an update is a refinement, not a reversal).
      expect(db.count()).toBe(before + 1);
      expect(db.get(rememberedId)?.status).toBe("open");
      expect(db.get(rememberedId)?.supersededBy).toBeUndefined();

      // Related, not replaced: an in-threshold neighbour gets a thread edge.
      expect(db.allEdges()).toContainEqual(expect.objectContaining({
        src: addedId,
        dst: rememberedId,
        kind: "thread",
      }));
      expect(db.allEdges().some((edge) => edge.kind === "supersedes")).toBe(false);
    },
  );

  it("leaves an already hash-mismatched RM- bullet on the ordinary update path", async () => {
    // Only a bullet whose id genuinely hashes its own text carries the
    // self-verifying claim. A hash-mismatched or hand-authored `RM-…` id does
    // not, so it keeps ordinary behaviour. This fix protects new
    // reconciliation; it deliberately does NOT detect or repair records that
    // are already broken.
    const root = newRoot("mismatch");
    const db = openDb(root);
    const mismatchedId = `${REMEMBER_ID_PREFIX}${"0".repeat(64)}`;
    await seedBullet(db, root, mismatchedId, REMEMBERED);
    expect(isRememberedMemoryId(mismatchedId, REMEMBERED)).toBe(false);
    const before = db.count();

    await reconcileBatch(
      [{ type: "note", text: CANDIDATE, salience: 0.6, isInsight: false }],
      makeDeps(db, root, batchUpdateLlm(mismatchedId)),
    );

    expect(db.get(mismatchedId)?.text).toBe(MERGED);
    expect(bulletById(root, mismatchedId)?.text).toBe(MERGED);
    expect(db.count()).toBe(before);
  });

  it("still merges text in place for an ordinary (non-remembered) target", async () => {
    const root = newRoot("nonrm");
    const db = openDb(root);
    await seedBullet(db, root, "UPD1", REMEMBERED);
    const before = db.count();

    await reconcileBatch(
      [{ type: "note", text: CANDIDATE, salience: 0.6, isInsight: false }],
      makeDeps(db, root, batchUpdateLlm("UPD1")),
    );

    expect(db.get("UPD1")?.text).toBe(MERGED);
    expect(bulletById(root, "UPD1")?.text).toBe(MERGED);
    expect(db.count()).toBe(before);
  });

  it("survives a rebuild and a later remember of the same fact", async () => {
    const root = newRoot("rebuild");
    const db = openDb(root);
    const rememberedId = rememberedIdFor(REMEMBERED);
    await seedBullet(db, root, rememberedId, REMEMBERED);

    await reconcileBatch(
      [{ type: "note", text: CANDIDATE, salience: 0.6, isInsight: false }],
      makeDeps(db, root, batchUpdateLlm(rememberedId)),
    );
    db.close();
    openDbs.length = 0;

    await safeRebuildMemoryIndex({
      root,
      embeddings: fakeEmbeddings(DIM),
      dim: DIM,
      tier: "bujo",
    });

    const store = createBujoMemoryStore({
      root,
      clock: () => FIXED,
      embeddings: fakeEmbeddings(DIM),
      dim: DIM,
      tier: "bujo",
      llm: fakeLlm([]),
    });
    try {
      const again = await store.remember("conv-1", REMEMBERED);
      expect(again.duplicate).toBe(true);
      expect(again.text).toBe(REMEMBERED);
    } finally {
      await store.close();
    }
  });

  it("replays a pre-existing durable UPDATE intent against a remembered bullet", async () => {
    // An intent committed before this guard existed is already a durable
    // decision. Recovery must complete it rather than throw forever.
    const root = newRoot("replay");
    const db = openDb(root);
    const rememberedId = rememberedIdFor(REMEMBERED);
    await seedBullet(db, root, rememberedId, REMEMBERED);

    const file = relative(root, dailyFilePath(root, FIXED));
    const before = bulletById(root, rememberedId)!;
    const updatedRecord = { ...db.get(rememberedId)!, text: MERGED };
    const [vector] = await db.prepareUpsertVectors([updatedRecord]);
    const handle = writeCaptureIntent(
      root,
      [{
        candidateIndex: 0,
        kind: "update",
        id: rememberedId,
        before: { file, bullet: before },
        after: { file, bullet: { ...before, text: MERGED } },
        record: updatedRecord,
        ...(vector === undefined ? {} : { vector }),
      }],
      { entities: [], relations: [], associations: [] },
      FIXED.toISOString(),
    );

    expect(() => replayCaptureIntent(root, handle, db, {
      canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
    })).not.toThrow();
    expect(db.get(rememberedId)?.text).toBe(MERGED);
  });
});
