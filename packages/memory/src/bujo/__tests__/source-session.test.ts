import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers";

import { afterEach, describe, expect, it } from "vitest";

import { openMemoryDb, type MemoryDb } from "../../store/index.js";
import { auditBujoMemoryHealth } from "../audit.js";
import { appendBullet, dailyFilePath } from "../daily.js";
import { parseDailyFile } from "../grammar.js";
import { assertCanonicalGraphRepairBaseParity, safeRebuildMemoryIndex } from "../rebuild.js";
import { reconcile, type ReconcileDeps } from "../reconcile.js";
import { createBujoMemoryStore } from "../store.js";
import type { Bullet, CandidateMemory } from "../types.js";
import { fakeEmbeddings, fakeLlm } from "./helpers.js";

const DIM = 64;
const FIXED = new Date("2031-05-17T12:00:00.000Z");
const roots: string[] = [];
const dbs: MemoryDb[] = [];

afterEach(async () => {
  for (const db of dbs.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
});

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bujo-source-session-"));
  roots.push(root);
  return root;
}

async function rebuildAndOpen(root: string): Promise<MemoryDb> {
  const provider = fakeEmbeddings(DIM);
  const rebuilt = await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: DIM });
  const db = openMemoryDb({ path: rebuilt.active, embeddings: provider, dim: DIM });
  dbs.push(db);
  return db;
}

function canonicalBullets(root: string): Bullet[] {
  return readdirSync(join(root, "daily")).filter((name) => name.endsWith(".md"))
    .flatMap((name) => parseDailyFile(readFileSync(join(root, "daily", name), "utf8")).bullets);
}

/** Every canonical line and its index row name the same source session (or both none). */
function expectIndexAgreesWithCanonical(root: string, db: MemoryDb): void {
  const bullets = canonicalBullets(root);
  expect(bullets.length).toBeGreaterThan(0);
  for (const bullet of bullets) {
    const record = db.get(bullet.id);
    expect(record, bullet.id).toBeDefined();
    expect(record?.source.session, bullet.id).toBe(bullet.sourceSession);
  }
}

function legacy(id: string, text: string): Bullet {
  return { id, type: "note", status: "open", text, salience: 0.5, isInsight: false,
    createdAt: FIXED.toISOString(), refs: [] };
}

describe("durable source-session provenance", () => {
  it("records add/update/supersede sessions, keeps noop and superseded provenance, and survives safe rebuild", async () => {
    const root = newRoot();
    appendBullet(root, legacy("LEGACY-A", "Morgan stores the canoe paddles in the shed."), FIXED);
    appendBullet(root, legacy("LEGACY-B", "Morgan waters the fictional fern on Sundays."), FIXED);
    const before = readFileSync(dailyFilePath(root, FIXED), "utf8");
    let db = await rebuildAndOpen(root);
    expect(db.get("LEGACY-A")?.source.session).toBeUndefined();

    let next = 0;
    const deps = (conversationId: string | undefined, llm: ReconcileDeps["llm"]): ReconcileDeps => ({
      db, root, llm, ...(conversationId === undefined ? {} : { conversationId }), now: () => FIXED,
      nextId: () => `C-SOURCE-${String(next++).padStart(2, "0")}`, canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity,
    });
    const note = (text: string): CandidateMemory => ({ type: "note", text, salience: 0.7, isInsight: false });

    // ADD stamps the host conversation id; the untouched legacy lines keep their exact bytes.
    db.findSimilar = async () => [];
    const added = await reconcile([note("Morgan booked a fictional pottery class.")], deps("web:chat-one", fakeLlm([])));
    const addedId = added[0]?.kind === "add" ? added[0].id : "";
    expect(readFileSync(dailyFilePath(root, FIXED), "utf8").startsWith(before)).toBe(true);
    expect(readFileSync(dailyFilePath(root, FIXED), "utf8")).toContain("source_session=web:chat-one-->");
    expect(db.get(addedId)?.source.session).toBe("web:chat-one");

    // NOOP from another conversation is not a contribution: provenance stays.
    db.findSimilar = async () => [{ record: db.get(addedId)!, distance: 0.1 }];
    expect(await reconcile([note("Morgan booked a pottery class.")], deps("web:chat-two",
      fakeLlm([["CLASSIFY", JSON.stringify({ action: "noop", targetId: addedId })]]))))
      .toEqual([{ kind: "noop", id: addedId }]);
    expect(canonicalBullets(root).find((bullet) => bullet.id === addedId)?.sourceSession).toBe("web:chat-one");
    expect(db.get(addedId)?.source.session).toBe("web:chat-one");

    // SUPERSEDE stamps the replacement and keeps the old line's provenance.
    const superseded = await reconcile([note("Morgan moved the pottery class to Friday.")], deps("web:chat-three",
      fakeLlm([["CLASSIFY", JSON.stringify({ action: "supersede", targetId: addedId, text: "Morgan moved the pottery class to Friday." })]])));
    const replacementId = superseded[0]?.kind === "supersede" ? superseded[0].newId : "";
    expect(replacementId).not.toBe("");
    const afterSupersede = canonicalBullets(root);
    expect(afterSupersede.find((bullet) => bullet.id === addedId)).toMatchObject({ status: "invalidated", sourceSession: "web:chat-one" });
    expect(afterSupersede.find((bullet) => bullet.id === replacementId)?.sourceSession).toBe("web:chat-three");
    expect(db.get(addedId)?.source.session).toBe("web:chat-one");
    expect(db.get(replacementId)?.source.session).toBe("web:chat-three");

    // UPDATE with changed text names the session that changed it, in both stores.
    db.findSimilar = async () => [{ record: db.get("LEGACY-A")!, distance: 0.1 }];
    const merged = "Morgan stores the canoe paddles and life vests in the shed.";
    expect(await reconcile([note("Morgan also keeps life vests in the shed.")], deps("web:chat-four",
      fakeLlm([["CLASSIFY", JSON.stringify({ action: "update", targetId: "LEGACY-A", text: merged })]]))))
      .toEqual([{ kind: "update", id: "LEGACY-A" }]);
    expect(canonicalBullets(root).find((bullet) => bullet.id === "LEGACY-A")).toMatchObject({ text: merged, sourceSession: "web:chat-four" });
    expect(db.get("LEGACY-A")?.source.session).toBe("web:chat-four");

    // Without a host conversation id nothing is invented.
    db.findSimilar = async () => [];
    const anonymous = await reconcile([note("Morgan repainted the fictional gate.")], deps(undefined, fakeLlm([])));
    const anonymousId = anonymous[0]?.kind === "add" ? anonymous[0].id : "";
    expect(canonicalBullets(root).find((bullet) => bullet.id === anonymousId)).not.toHaveProperty("sourceSession");

    expectIndexAgreesWithCanonical(root, db);
    expect(auditBujoMemoryHealth({ root, mode: "bujo", configuredEmbeddingModel: fakeEmbeddings(DIM).id,
      configuredDimension: DIM, now: FIXED }).issues).not.toContain("canonical_mismatch");

    // A safe rebuild restores every recorded session from markdown alone and backfills none.
    db = await rebuildAndOpen(root);
    expectIndexAgreesWithCanonical(root, db);
    expect(db.get("LEGACY-B")?.source.session).toBeUndefined();
    expect(db.get(addedId)?.source.session).toBe("web:chat-one");
    expect(db.get(replacementId)?.source.session).toBe("web:chat-three");
    expect(db.get("LEGACY-A")?.source.session).toBe("web:chat-four");
  });

  it("rebuilds a line whose provenance metadata is repeated or malformed as unknown instead of dropping it", async () => {
    const root = newRoot();
    const day = dailyFilePath(root, FIXED);
    appendBullet(root, legacy("SEED", "Morgan keeps a fictional herb garden."), FIXED);
    const meta = (id: string, extra: string): string => `  <!--mem id=${id} type=note status=open salience=0.5 isInsight=0 created=${FIXED.toISOString()} refs= ${extra}-->`;
    writeFileSync(day, `${readFileSync(day, "utf8")}${[
      "- – Morgan prefers tomatoes over peppers.", meta("REPEATED", "source_session=web:one source_session=web:two"),
      "- – Morgan uses a blue watering can.", meta("MALFORMED", "source_session=web%ZZ"),
      "- – Morgan harvests basil in July.", meta("VALID", "source_session=web:three"),
    ].join("\n")}\n`);
    const db = await rebuildAndOpen(root);
    expect(db.get("REPEATED")?.source.session).toBeUndefined();
    expect(db.get("MALFORMED")?.source.session).toBeUndefined();
    expect(db.get("VALID")?.source.session).toBe("web:three");
    expect(db.get("REPEATED")?.text).toBe("Morgan prefers tomatoes over peppers.");
  });

  it("records the completed-turn conversation through the production store and keeps it across reopen and rebuild", async () => {
    const root = newRoot();
    const extraction = JSON.stringify({ memories: [{ type: "note", text: "Owner prefers numbered repair steps.", source: "user",
      salience: 0.8, isInsight: false, entityIds: [], labels: [{ v: 1, kind: "preference", scope: "agent", attribution: "user-stated" }] }],
    entities: [], relations: [] });
    const store = createBujoMemoryStore({ root, tier: "bujo", clock: () => FIXED,
      embeddings: fakeEmbeddings(DIM), dim: DIM, llm: { id: "fictional-capture", complete: async () => extraction } });
    try {
      await store.persistCompletedTurn({ runId: "fictional-run-1", conversationId: "web:chat-capture",
        summary: "A repair was discussed.", captureText: "User: Owner prefers numbered repair steps.",
        captureSpeakerKind: "human-turn", captureEvidence: { ownerTurn: true, userText: "Owner prefers numbered repair steps.", toolOutcomes: [] } });
      await store.flush();
      const outcome = await store.recallWithOutcome("numbered repair steps", { topK: 5, trackAccess: false });
      expect(outcome.hits[0]?.record.source.session).toBe("web:chat-capture");
    } finally {
      await store.close();
    }
    expect(readFileSync(dailyFilePath(root, FIXED), "utf8")).toContain("source_session=web:chat-capture-->");
    const reopened = createBujoMemoryStore({ root, tier: "bujo", clock: () => FIXED, embeddings: fakeEmbeddings(DIM), dim: DIM, readOnly: true });
    try {
      const outcome = await reopened.recallWithOutcome("numbered repair steps", { topK: 5, trackAccess: false });
      expect(outcome.hits[0]?.record.source.session).toBe("web:chat-capture");
    } finally {
      await reopened.close();
    }
    const db = await rebuildAndOpen(root);
    expectIndexAgreesWithCanonical(root, db);
  });
});
