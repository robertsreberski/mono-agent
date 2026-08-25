import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openMemoryDb, type MemoryRecord } from "../../store/index.js";
import {
  captureIntentAuthorityId,
  decodeLegacyCaptureClockRepairIntent,
  writeCaptureIntent,
  type CaptureIntentAction,
} from "../capture-outbox.js";
import { repairLegacyCaptureClockDriftAtStartup } from "../capture-clock-repair.js";
import { appendBullet, rewriteBullet } from "../daily.js";
import {
  cleanupSqliteCoordination,
  createDurableRootSwapBackup,
  MEMORY_CAPTURE_CLOCK_REPAIR_SWAP_OPERATION,
  memoryTreeFingerprint,
  readDurableRootSwapBackup,
  replaceJsonDurable,
  rootFingerprint,
  writeJsonExclusiveDurable,
} from "../durable-root-swap.js";
import { acquireMemoryWriterLeaseForMaintenance } from "../generations.js";
import { parseDailyFile } from "../grammar.js";
import { acquireMemoryMaintenanceLease, memoryMaintenanceTransactionPath } from "../maintenance.js";
import {
  readCanonicalFileSnapshot,
  writeCanonicalFileAtomic,
} from "../path-safety.js";
import { auditCanonicalIndexHealth } from "../rebuild.js";
import {
  assertReplayProjectionMatchesDb,
  initializeReplayProjection,
  readBujoCanonicalSourceFingerprint,
  readReplayProjectionStrict,
  serializeReplayProjection,
} from "../replay-projection.js";
import { createBujoMemoryStore } from "../store.js";
import type { Bullet } from "../types.js";
import { fakeEmbeddings, fakeLlm } from "./helpers.js";

const DIM = 64;
const ADMITTED_AT = "2026-06-15T23:59:00.000Z";
const EFFECTIVE_AT = "2026-06-16T00:01:00.000Z";
const LEGACY_FILE = "daily/2026-06-15.md";
const EFFECTIVE_FILE = "daily/2026-06-16.md";
const RETENTION_KEY = "a".repeat(64);
const VECTOR = Object.freeze(Array.from({ length: DIM }, (_, index) => index === 0 ? 1 : 0));

interface LegacyFixture {
  readonly root: string;
  readonly intentFile: string;
  readonly old: Bullet;
  readonly replacementId: string;
}

describe("legacy capture supersede clock repair", () => {
  it("repairs a retained cross-midnight half-state automatically without provider calls", async () => {
    const fixture = seedLegacyFixture();
    const before = memoryTreeFingerprint(fixture.root);
    let embeddingCalls = 0;
    let llmCalls = 0;
    const store = createBujoMemoryStore({
      root: fixture.root,
      tier: "bujo",
      embeddings: {
        id: `fake-${DIM}`,
        embed: async () => {
          embeddingCalls += 1;
          throw new Error("startup clock repair must not call embeddings");
        },
      },
      dim: DIM,
      llm: {
        id: "no-startup-model",
        complete: async () => {
          llmCalls += 1;
          throw new Error("startup clock repair must not call the model");
        },
      },
    });
    await store.close();

    expect(embeddingCalls).toBe(0);
    expect(llmCalls).toBe(0);
    expect(memoryTreeFingerprint(fixture.root)).not.toBe(before);
    assertRepairedFixture(fixture);
    const retained = JSON.parse(readFileSync(join(fixture.root, fixture.intentFile), "utf8")) as {
      state: string;
      actions: Array<{ kind: string; at?: string }>;
    };
    expect(retained.state).toBe("complete");
    expect(retained.actions.find((action) => action.kind === "supersede")?.at).toBe(EFFECTIVE_AT);
  });

  it("restores the exact original tree after an injected failure and succeeds on retry", () => {
    const fixture = seedLegacyFixture();
    const before = memoryTreeFingerprint(fixture.root);

    expect(() => repairLegacyCaptureClockDriftAtStartup({
      root: fixture.root,
      dimension: DIM,
      hooks: { afterDatabaseRepair: () => { throw new Error("injected repair failure"); } },
    })).toThrow("injected repair failure");
    expect(memoryTreeFingerprint(fixture.root)).toBe(before);
    expect(existsSync(memoryMaintenanceTransactionPath(fixture.root))).toBe(false);
    expect(decodeLegacyCaptureClockRepairIntent(
      readFileSync(join(fixture.root, fixture.intentFile), "utf8"),
    )).toBeDefined();

    expect(repairLegacyCaptureClockDriftAtStartup({
      root: fixture.root,
      dimension: DIM,
    })).toMatchObject({ repairedIntents: 1, repairedSupersedes: 1 });
    assertRepairedFixture(fixture);
  });

  it("recovers an applying whole-root transaction before retrying the repair", () => {
    const fixture = seedLegacyFixture();
    const originalTree = memoryTreeFingerprint(fixture.root);
    const decoded = decodeLegacyCaptureClockRepairIntent(
      readFileSync(join(fixture.root, fixture.intentFile), "utf8"),
    )!;
    const batchDigest = createHash("sha256")
      .update("mono-agent-memory-capture-clock-repair-batch-v1\0", "utf8")
      .update(JSON.stringify([{ file: fixture.intentFile, planDigest: decoded.planDigest }]), "utf8")
      .digest("hex");
    const planDigest = createHash("sha256")
      .update("mono-agent-memory-capture-clock-repair-attempt-v1\0", "utf8")
      .update(batchDigest, "utf8")
      .update("\0", "utf8")
      .update("0", "utf8")
      .digest("hex");
    const maintenance = acquireMemoryMaintenanceLease(fixture.root);
    const writer = acquireMemoryWriterLeaseForMaintenance(fixture.root);
    const backup = createDurableRootSwapBackup({
      root: writer.root,
      dbPath: join(writer.root, "memory.db"),
      operation: MEMORY_CAPTURE_CLOCK_REPAIR_SWAP_OPERATION,
      expectedRootFingerprint: rootFingerprint(writer.root),
      expectedSourceFingerprint: readBujoCanonicalSourceFingerprint(writer.root),
      planDigest,
      dimension: DIM,
    });
    writeJsonExclusiveDurable(maintenance.transactionPath, {
      schemaVersion: 1,
      operation: MEMORY_CAPTURE_CLOCK_REPAIR_SWAP_OPERATION.transactionOperation,
      phase: "applying",
      rootFingerprint: rootFingerprint(writer.root),
      backupPath: backup.path,
      planDigest,
      originalTreeFingerprint: backup.manifest.treeFingerprint,
    });
    backup.manifest = { ...backup.manifest, status: "applying" };
    replaceJsonDurable(backup.manifestPath, backup.manifest);
    const intent = readCanonicalFileSnapshot(writer.root, fixture.intentFile)!;
    writeCanonicalFileAtomic(writer.root, fixture.intentFile, "{}\n", intent.identity);
    writer.release();
    maintenance.release();
    expect(existsSync(memoryMaintenanceTransactionPath(fixture.root))).toBe(true);

    expect(repairLegacyCaptureClockDriftAtStartup({
      root: fixture.root,
      dimension: DIM,
    })).toMatchObject({ repairedIntents: 1, repairedSupersedes: 1 });
    expect(readDurableRootSwapBackup(
      backup.path,
      MEMORY_CAPTURE_CLOCK_REPAIR_SWAP_OPERATION,
    ).manifest.status).toBe("recovered");
    expect(memoryTreeFingerprint(fixture.root)).not.toBe(originalTree);
    assertRepairedFixture(fixture);
  });

  it("retries safely when a crash leaves only a prepared backup", () => {
    const fixture = seedLegacyFixture();
    const before = memoryTreeFingerprint(fixture.root);
    expect(() => repairLegacyCaptureClockDriftAtStartup({
      root: fixture.root,
      dimension: DIM,
      hooks: { afterBackupDurable: () => { throw new Error("prepared backup crash"); } },
    })).toThrow("prepared backup crash");
    expect(memoryTreeFingerprint(fixture.root)).toBe(before);
    expect(existsSync(memoryMaintenanceTransactionPath(fixture.root))).toBe(false);

    expect(repairLegacyCaptureClockDriftAtStartup({ root: fixture.root, dimension: DIM }))
      .toMatchObject({ repairedIntents: 1, repairedSupersedes: 1 });
    assertRepairedFixture(fixture);
  });

  it("rejects a backward-clock intent outside the exact retained pending shape", () => {
    const fixture = seedLegacyFixture();
    const snapshot = readCanonicalFileSnapshot(fixture.root, fixture.intentFile)!;
    const value = JSON.parse(snapshot.content) as { retentionKey?: string };
    delete value.retentionKey;
    writeCanonicalFileAtomic(fixture.root, fixture.intentFile, `${JSON.stringify(value)}\n`, snapshot.identity);
    const before = memoryTreeFingerprint(fixture.root);

    expect(() => repairLegacyCaptureClockDriftAtStartup({ root: fixture.root, dimension: DIM }))
      .toThrow(/predates its prior memory/iu);
    expect(memoryTreeFingerprint(fixture.root)).toBe(before);
  });

  it("never mutates the repairable legacy state for a read-only store", async () => {
    const fixture = seedLegacyFixture();
    const before = memoryTreeFingerprint(fixture.root);
    expect(() => createBujoMemoryStore({
        root: fixture.root,
        tier: "bujo",
        readOnly: true,
        embeddings: fakeEmbeddings(DIM),
        dim: DIM,
        llm: fakeLlm([]),
      })).toThrow(/supersede mismatch|exact canonical memory/iu);
    cleanupSqliteCoordination(join(fixture.root, "memory.db"));
    expect(memoryTreeFingerprint(fixture.root)).toBe(before);
  });
});

function seedLegacyFixture(): LegacyFixture {
  const root = mkdtempSync(join(tmpdir(), "capture-clock-repair-"));
  mkdirSync(join(root, ".index", "generations"), { recursive: true, mode: 0o700 });
  const old: Bullet = {
    id: "CLOCK-OLD",
    type: "note",
    status: "open",
    text: "Atlas launches in July",
    salience: 0.7,
    isInsight: false,
    createdAt: EFFECTIVE_AT,
    refs: [],
  };
  const replacement: Bullet = {
    ...old,
    id: "CLOCK-NEW",
    text: "Atlas launches in August",
    salience: 0.8,
  };
  appendBullet(root, old, new Date(EFFECTIVE_AT));
  expect(rewriteBullet(root, EFFECTIVE_FILE, old.id, { status: "invalidated" })).toBe(true);
  initializeReplayProjection(root);
  const dbPath = join(root, "memory.db");
  const db = openMemoryDb({ path: dbPath, embeddings: fakeEmbeddings(DIM), dim: DIM });
  const oldRecord = recordFor(old, EFFECTIVE_FILE);
  const action: CaptureIntentAction = {
    candidateIndex: 0,
    kind: "supersede",
    oldId: old.id,
    newId: replacement.id,
    beforeOld: { file: EFFECTIVE_FILE, bullet: old },
    afterOld: { file: EFFECTIVE_FILE, bullet: { ...old, status: "invalidated" } },
    afterNew: { file: EFFECTIVE_FILE, bullet: replacement },
    record: recordFor(replacement, EFFECTIVE_FILE),
    vector: VECTOR,
    at: EFFECTIVE_AT,
  };
  const handle = writeCaptureIntent(root, [action], {}, ADMITTED_AT, { retentionKey: RETENTION_KEY });

  const intentSnapshot = readCanonicalFileSnapshot(root, handle.file)!;
  const encoded = JSON.parse(intentSnapshot.content) as {
    state: "pending" | "complete";
    actions: Array<{
      kind: string;
      at?: string;
      afterNew?: { file: string; bullet: Bullet };
      record?: MemoryRecord;
    }>;
  };
  const supersede = encoded.actions.find((candidate) => candidate.kind === "supersede")!;
  encoded.state = "pending";
  supersede.at = ADMITTED_AT;
  supersede.afterNew = {
    file: LEGACY_FILE,
    bullet: { ...supersede.afterNew!.bullet, createdAt: ADMITTED_AT },
  };
  supersede.record = {
    ...supersede.record!,
    createdAt: ADMITTED_AT,
    source: { ...supersede.record!.source, file: LEGACY_FILE },
  };
  const legacyRaw = `${JSON.stringify(encoded)}\n`;
  writeCanonicalFileAtomic(root, handle.file, legacyRaw, intentSnapshot.identity);
  const plan = decodeLegacyCaptureClockRepairIntent(legacyRaw)!;
  expect(captureIntentAuthorityId(plan.repaired)).toBe(plan.repairedAuthorityId);

  appendBullet(root, plan.legacy.actions.find((candidate) => candidate.kind === "supersede")!.afterNew.bullet,
    new Date(ADMITTED_AT));

  const currentReplay = readReplayProjectionStrict(root);
  if (currentReplay.state.kind !== "present") throw new Error("fixture replay sidecar is missing");
  const legacyReplay = {
    ...currentReplay.projection,
    supersedes: [{
      src: old.id,
      dst: replacement.id,
      at: ADMITTED_AT,
      authorityKind: "capture" as const,
      authorityId: plan.legacyAuthorityId,
    }],
  };
  writeCanonicalFileAtomic(
    root,
    ".replay-projection-v1.json",
    serializeReplayProjection(legacyReplay),
    currentReplay.state.identity,
  );
  const legacyAction = plan.legacy.actions.find((candidate) => candidate.kind === "supersede")!;
  db.commitPreparedUpserts([oldRecord, legacyAction.record], [VECTOR, VECTOR]);
  db.markSuperseded(legacyAction.oldId, legacyAction.newId, ADMITTED_AT);
  db.checkpoint();
  db.close();
  cleanupSqliteCoordination(dbPath);
  return { root, intentFile: handle.file, old, replacementId: replacement.id };
}

function assertRepairedFixture(fixture: LegacyFixture): void {
  expect(decodeLegacyCaptureClockRepairIntent(
    readFileSync(join(fixture.root, fixture.intentFile), "utf8"),
  )).toBeUndefined();
  expect(parseDailyFile(readFileSync(join(fixture.root, LEGACY_FILE), "utf8")).bullets)
    .not.toContainEqual(expect.objectContaining({ id: fixture.replacementId }));
  expect(parseDailyFile(readFileSync(join(fixture.root, EFFECTIVE_FILE), "utf8")).bullets)
    .toContainEqual(expect.objectContaining({ id: fixture.replacementId, createdAt: EFFECTIVE_AT }));
  const dbPath = join(fixture.root, "memory.db");
  const db = openMemoryDb({ path: dbPath, readOnly: true, dim: DIM });
  try {
    expect(db.get(fixture.replacementId)).toMatchObject({
      createdAt: EFFECTIVE_AT,
      source: { file: EFFECTIVE_FILE },
    });
    expect(db.get(fixture.old.id)).toMatchObject({
      supersededAt: EFFECTIVE_AT,
      validTo: EFFECTIVE_AT,
    });
    const replay = readReplayProjectionStrict(fixture.root);
    expect(replay.projection.supersedes).toContainEqual(expect.objectContaining({
      src: fixture.old.id,
      dst: fixture.replacementId,
      at: EFFECTIVE_AT,
    }));
    assertReplayProjectionMatchesDb(db, replay.projection);
    // The repaired run-owned receipt intentionally remains until completed-turn
    // intake resolves it, so public health reports an in-progress mutation.
    expect(auditCanonicalIndexHealth(fixture.root, "bujo", db)).toEqual({ status: "in_progress" });
  } finally {
    db.close();
  }
  cleanupSqliteCoordination(dbPath);
  expect(existsSync(memoryMaintenanceTransactionPath(fixture.root))).toBe(false);
}

function recordFor(bullet: Bullet, file: string): MemoryRecord {
  return {
    id: bullet.id,
    type: bullet.type,
    status: bullet.status,
    text: bullet.text,
    salience: bullet.salience,
    isInsight: bullet.isInsight,
    createdAt: bullet.createdAt,
    accessCount: 0,
    tags: [],
    source: { file },
  };
}
