import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryDb, openMemoryDb, type MemoryRecord } from "../../store/index.js";
import { loadVec } from "../../store/vec.js";
import {
  auditBujoMemoryHealth,
  BUJO_MEMORY_HEALTH_SCHEMA_VERSION,
} from "../audit.js";
import { CompletedTurnIntakeManager } from "../capture-intake.js";
import { writeCaptureIntent } from "../capture-outbox.js";
import { appendBullet } from "../daily.js";
import { appendGraphBatch } from "../graph.js";
import {
  readManagedIndexManifest,
  withManagedRollbackRetirement,
} from "../generations.js";
import { safeRebuildMemoryIndex } from "../rebuild.js";
import { createBujoMemoryStore } from "../store.js";
import {
  BUJO_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
  BUJO_RUNTIME_SNAPSHOT_STALE_AFTER_MS,
  writeBujoRuntimeSnapshot,
} from "../runtime-snapshot.js";
import type { BujoTier, Bullet } from "../types.js";
import { fakeEmbeddings, fakeLlm } from "./helpers.js";

const NOW = new Date("2026-07-12T10:00:00.000Z");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("strict BuJo memory health", () => {
  it("reports an exact healthy metadata-only contract for unmanaged Lite", () => {
    const root = tempRoot();
    const db = openMemoryDb({ path: join(root, "memory.db") });
    db.close();
    publishRuntime(root, "lite");

    const result = auditBujoMemoryHealth({ root, mode: "lite", now: NOW });

    expect(Object.keys(result)).toEqual([
      "schemaVersion",
      "backend",
      "mode",
      "status",
      "checkedAt",
      "issues",
      "counts",
    ]);
    expect(result).toEqual({
      schemaVersion: BUJO_MEMORY_HEALTH_SCHEMA_VERSION,
      backend: "bujo",
      mode: "lite",
      status: "healthy",
      checkedAt: NOW.toISOString(),
      issues: [],
      counts: {
        pending: 0,
        due: 0,
        dead: 0,
        outbox: 0,
        temporary: 0,
        memories: 0,
        vectors: 0,
        missingVectors: 0,
      },
    });
  });

  it("keeps a normal live Lite append healthy despite repairable source provenance", async () => {
    const root = tempRoot();
    const store = createBujoMemoryStore({ root, clock: () => NOW });
    try {
      await store.appendHostSummary("private-conversation", "A normal live fact is canonical.");

      const result = auditBujoMemoryHealth({ root, mode: "lite", now: NOW });

      expect(result.status).toBe("healthy");
      expect(result.issues).toEqual([]);
      expect(JSON.stringify(result)).not.toContain("private-conversation");
    } finally {
      await store.close();
    }
  });

  it("retires a retained Lite rollback before a successful live append changes its source", async () => {
    const root = tempRoot();
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    const second = await safeRebuildMemoryIndex({ root, tier: "lite" });
    expect(second.rollback).toBeDefined();
    expect(readManagedIndexManifest(root)?.rollback).toBeDefined();

    const store = createBujoMemoryStore({ root, clock: () => NOW });
    try {
      await store.appendHostSummary("private-conversation", "The live append advances canonical truth.");

      expect(readManagedIndexManifest(root)?.rollback).toBeUndefined();
      const result = auditBujoMemoryHealth({ root, mode: "lite", now: NOW });
      expect(["healthy", "in_progress"]).toContain(result.status);
      expect(result.issues).not.toContain("canonical_mismatch");
      expect(result.issues).not.toContain("manifest_invalid");
    } finally {
      await store.close();
    }
  });

  it("retires a retained BuJo rollback at the canonical commit of a successful capture", async () => {
    const root = tempRoot();
    const provider = fakeEmbeddings(4);
    await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 });
    const second = await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 });
    expect(second.rollback).toBeDefined();
    const llm = fakeLlm([["Extract one bounded", JSON.stringify({
      memories: [{
        type: "note",
        text: "A captured fact advances canonical truth",
        salience: 0.8,
        isInsight: false,
        entityIds: ["project:truth"],
      }],
      entities: [{ id: "project:truth", name: "Truth", type: "project" }],
      relations: [],
    })]]);
    const store = createBujoMemoryStore({
      root,
      tier: "bujo",
      embeddings: provider,
      dim: 4,
      llm,
      clock: () => NOW,
    });
    try {
      await expect(store.capture("private-conversation", "Remember the captured fact.")).resolves.toMatchObject({
        actions: 1,
        entities: 1,
      });

      expect(readManagedIndexManifest(root)?.rollback).toBeUndefined();
      const result = auditBujoMemoryHealth({
        root,
        mode: "bujo",
        configuredEmbeddingModel: provider.id,
        configuredDimension: 4,
        now: NOW,
      });
      expect(["healthy", "in_progress"]).toContain(result.status);
      expect(result.issues).not.toContain("canonical_mismatch");
      expect(result.issues).not.toContain("manifest_invalid");
    } finally {
      await store.close();
    }
  });

  it("does not enter a canonical commit when rollback retirement fails before publication", async () => {
    const root = tempRoot();
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    const beforeManifest = readFileSync(join(root, ".index", "manifest.json"), "utf8");
    let committed = false;

    expect(() => withManagedRollbackRetirement(root, "daily", () => {
      committed = true;
      writeFileSync(join(root, "daily", "2026-07-12.md"), "unsafe commit\n", "utf8");
    }, {
      beforeManifestRename: () => { throw new Error("simulated retirement failure"); },
    })).toThrow(/simulated retirement failure/iu);

    expect(committed).toBe(false);
    expect(readManagedIndexManifest(root)?.rollback).toBeDefined();
    expect(readFileSync(join(root, ".index", "manifest.json"), "utf8")).toBe(beforeManifest);
    expect(readdirSync(join(root, ".index")).filter((name) => name.includes("manifest-retire"))).toEqual([]);
  });

  it("preserves a retained rollback across reads, projections, audit-only writes, and exact graph no-ops", async () => {
    const root = tempRoot();
    const provider = fakeEmbeddings(4);
    await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 });
    await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 });
    const rollbackName = readManagedIndexManifest(root)?.rollback?.name;
    expect(rollbackName).toBeDefined();
    const store = createBujoMemoryStore({
      root,
      tier: "bujo",
      embeddings: provider,
      dim: 4,
      llm: fakeLlm([]),
      clock: () => NOW,
    });
    try {
      await store.load("private-conversation", "nothing yet");
      await store.reflect();
      await store.consolidate();
      await store.appendHostSummary("private-conversation", "BuJo raw audit is outside rollback source truth.");
      appendGraphBatch(root, { entities: [], relations: [], associations: [] });

      expect(readManagedIndexManifest(root)?.rollback?.name).toBe(rollbackName);
    } finally {
      await store.close();
    }
  });

  it("preserves a Lite rollback when a real graph append is outside its source domain", async () => {
    const root = tempRoot();
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    const rollbackName = readManagedIndexManifest(root)?.rollback?.name;
    expect(rollbackName).toBeDefined();

    appendGraphBatch(root, {
      entities: [{ id: "project:outside-lite", name: "Outside Lite", createdAt: NOW.toISOString() }],
    });

    expect(readManagedIndexManifest(root)?.rollback?.name).toBe(rollbackName);
    publishRuntime(root, "lite");
    const result = auditBujoMemoryHealth({ root, mode: "lite", now: NOW });
    expect(result.status).toBe("healthy");
    expect(result.issues).toEqual([]);
  });

  it("serializes concurrent live appends while retiring one rollback exactly once", async () => {
    const root = tempRoot();
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    const store = createBujoMemoryStore({ root, clock: () => NOW });
    try {
      await Promise.all([
        store.appendHostSummary("one", "Concurrent fact one is durable."),
        store.appendHostSummary("two", "Concurrent fact two is durable."),
      ]);

      expect(readManagedIndexManifest(root)?.rollback).toBeUndefined();
      expect(readdirSync(join(root, ".index")).filter((name) => name.includes("manifest-retire"))).toEqual([]);
      const result = auditBujoMemoryHealth({ root, mode: "lite", now: NOW });
      expect(result.issues).not.toContain("canonical_mismatch");
      expect(result.issues).not.toContain("manifest_invalid");
    } finally {
      await store.close();
    }
  });

  it("reports a just-admitted real Lite turn as in progress without runtime drift", async () => {
    const root = tempRoot();
    const store = createBujoMemoryStore({ root, clock: () => NOW });
    try {
      await store.persistCompletedTurn({
        runId: "immediate-health-admission",
        conversationId: "private-conversation",
        summary: "A newly admitted turn is still being projected.",
      });

      const result = auditBujoMemoryHealth({ root, mode: "lite", now: NOW });

      expect(result.status).toBe("in_progress");
      expect(result.issues).toEqual(["intake_pending"]);
      expect(result.counts.pending).toBe(1);
      expect(result.issues).not.toContain("runtime_invalid");
    } finally {
      await store.close();
    }
  });

  it("keeps a flushed normal live Journal append healthy after provenance repair", async () => {
    const root = tempRoot();
    const provider = fakeEmbeddings(4);
    await safeRebuildMemoryIndex({ root, tier: "journal", embeddings: provider, dim: 4 });
    const store = createBujoMemoryStore({ root, embeddings: provider, dim: 4, clock: () => NOW });
    try {
      await store.appendHostSummary("private-conversation", "A normal Journal fact is canonical.");
      await store.flush();

      const result = auditBujoMemoryHealth({
        root,
        mode: "journal",
        configuredEmbeddingModel: provider.id,
        configuredDimension: 4,
        now: new Date(),
      });

      expect(result.status).toBe("healthy");
      expect(result.issues).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("requires a managed identity for Journal while preserving unmanaged Lite", () => {
    const root = tempRoot();
    const db = openMemoryDb({ path: join(root, "memory.db"), dim: 4 });
    db.close();
    publishRuntime(root, "journal");

    const result = auditBujoMemoryHealth({
      root,
      mode: "journal",
      configuredEmbeddingModel: "fake-4",
      configuredDimension: 4,
      now: NOW,
    });

    expect(result.status).toBe("unhealthy");
    expect(result.issues).toContain("manifest_missing");
    expect(result.issues).not.toContain("database_missing");
  });

  it("does not call a valid active Lite descriptor malformed merely because config requests Journal", async () => {
    const root = tempRoot();
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    publishRuntime(root, "journal");

    const result = auditBujoMemoryHealth({ root, mode: "journal", now: NOW });

    expect(result.status).toBe("unhealthy");
    expect(result.issues).toContain("configured_identity_mismatch");
    expect(result.issues).not.toContain("manifest_invalid");
  });

  it("validates a managed BuJo generation without calling its provider", async () => {
    const root = tempRoot();
    const provider = fakeEmbeddings(4);
    await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 });
    publishRuntime(root, "bujo");

    const result = auditBujoMemoryHealth({
      root,
      mode: "bujo",
      configuredEmbeddingModel: provider.id,
      configuredDimension: 4,
      now: NOW,
    });

    expect(result.status).toBe("healthy");
    expect(result.issues).toEqual([]);
  });

  it("detects FTS/canonical drift without comparing the mutable DB to the manifest digest", async () => {
    const root = tempRoot();
    const provider = fakeEmbeddings(4);
    appendBullet(root, bullet(), NOW);
    const rebuilt = await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 });
    const raw = new BetterSqlite3(rebuilt.active);
    raw.exec("DELETE FROM memories_fts");
    raw.close();
    publishRuntime(root, "bujo");

    const result = auditBujoMemoryHealth({
      root,
      mode: "bujo",
      configuredEmbeddingModel: provider.id,
      configuredDimension: 4,
      now: NOW,
    });

    expect(result.status).toBe("unhealthy");
    expect(result.issues).toContain("fts_mismatch");
    expect(result.issues).toContain("canonical_mismatch");
    expect(result.issues).not.toContain("sqlite_integrity_failed");
  });

  it("reports BuJo vector coverage loss from the WAL-visible active state", async () => {
    const root = tempRoot();
    const provider = fakeEmbeddings(4);
    appendBullet(root, bullet(), NOW);
    const rebuilt = await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 });
    const raw = new BetterSqlite3(rebuilt.active);
    loadVec(raw);
    raw.exec("DELETE FROM memories_vec");
    raw.close();
    publishRuntime(root, "bujo");

    const result = auditBujoMemoryHealth({
      root,
      mode: "bujo",
      configuredEmbeddingModel: provider.id,
      configuredDimension: 4,
      now: NOW,
    });

    expect(result.status).toBe("unhealthy");
    expect(result.issues).toContain("vector_mismatch");
    expect(result.counts).toMatchObject({ memories: 1, vectors: 0, missingVectors: 1 });
  });

  it("classifies an exact Journal recovery backlog as in progress", async () => {
    const root = tempRoot();
    const provider = fakeEmbeddings(4);
    appendBullet(root, bullet(), NOW);
    const rebuilt = await safeRebuildMemoryIndex({ root, tier: "journal", embeddings: provider, dim: 4 });
    const raw = new BetterSqlite3(rebuilt.active);
    loadVec(raw);
    raw.exec("DELETE FROM memories_vec");
    raw.close();
    publishRuntime(root, "journal", 1);

    const result = auditBujoMemoryHealth({
      root,
      mode: "journal",
      configuredEmbeddingModel: provider.id,
      configuredDimension: 4,
      now: NOW,
    });

    expect(result.status).toBe("in_progress");
    expect(result.issues).toEqual(["mutation_in_progress"]);
    expect(result.counts).toMatchObject({ memories: 1, vectors: 0, missingVectors: 1 });
  });

  it("degrades a paused Journal recovery instead of treating backlog equality as healthy", async () => {
    const root = tempRoot();
    const provider = fakeEmbeddings(4);
    appendBullet(root, bullet(), NOW);
    const rebuilt = await safeRebuildMemoryIndex({ root, tier: "journal", embeddings: provider, dim: 4 });
    const raw = new BetterSqlite3(rebuilt.active);
    loadVec(raw);
    raw.exec("DELETE FROM memories_vec");
    raw.close();
    publishRuntime(root, "journal", 1, true);

    const result = auditBujoMemoryHealth({
      root,
      mode: "journal",
      configuredEmbeddingModel: provider.id,
      configuredDimension: 4,
      now: NOW,
    });

    expect(result.status).toBe("degraded");
    expect(result.issues).toEqual(expect.arrayContaining(["mutation_in_progress", "runtime_invalid"]));
  });

  it("treats a safe Journal writer lock as in progress, not canonical divergence", async () => {
    const root = tempRoot();
    const provider = fakeEmbeddings(4);
    await safeRebuildMemoryIndex({ root, tier: "journal", embeddings: provider, dim: 4 });
    appendBullet(root, bullet(), NOW);
    writeFileSync(join(root, ".journal-write.lock"), "{}\n", { mode: 0o600 });
    publishRuntime(root, "journal");

    const result = auditBujoMemoryHealth({
      root,
      mode: "journal",
      configuredEmbeddingModel: provider.id,
      configuredDimension: 4,
      now: NOW,
    });

    expect(result.status).toBe("in_progress");
    expect(result.issues).toContain("mutation_in_progress");
    expect(result.issues).not.toContain("canonical_mismatch");
  });

  it("does not let a stale malformed Journal lock suppress canonical parity", async () => {
    const root = tempRoot();
    const provider = fakeEmbeddings(4);
    await safeRebuildMemoryIndex({ root, tier: "journal", embeddings: provider, dim: 4 });
    appendBullet(root, bullet(), NOW);
    const lockPath = join(root, ".journal-write.lock");
    writeFileSync(lockPath, "{}\n", { mode: 0o600 });
    const staleAt = new Date(NOW.getTime() - 30_000);
    utimesSync(lockPath, staleAt, staleAt);
    publishRuntime(root, "journal");

    const result = auditBujoMemoryHealth({
      root,
      mode: "journal",
      configuredEmbeddingModel: provider.id,
      configuredDimension: 4,
      now: NOW,
    });

    expect(result.status).toBe("unhealthy");
    expect(result.issues).toEqual(expect.arrayContaining(["canonical_mismatch", "canonical_invalid"]));
    expect(result.issues).not.toContain("mutation_in_progress");
    expect(readFileSync(lockPath, "utf8")).toBe("{}\n");
  });

  it("fails a manifest whose advertised rollback database disappeared", async () => {
    const root = tempRoot();
    const provider = fakeEmbeddings(4);
    await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 });
    const second = await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 });
    expect(second.rollback).toBeDefined();
    rmSync(second.rollback!);
    publishRuntime(root, "bujo");

    const result = auditBujoMemoryHealth({
      root,
      mode: "bujo",
      configuredEmbeddingModel: provider.id,
      configuredDimension: 4,
      now: NOW,
    });

    expect(result.status).toBe("unhealthy");
    expect(result.issues).toContain("manifest_invalid");
  });

  it("rejects logical tampering in an immutable retained rollback generation", async () => {
    const root = tempRoot();
    const provider = fakeEmbeddings(4);
    await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 });
    const second = await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 });
    expect(second.rollback).toBeDefined();
    const rollback = new BetterSqlite3(second.rollback!);
    loadVec(rollback);
    rollback.prepare("UPDATE index_metadata SET value = ? WHERE key = 'createdAt'")
      .run("2026-07-12T09:00:00.000Z");
    rollback.close();
    publishRuntime(root, "bujo");

    const result = auditBujoMemoryHealth({
      root,
      mode: "bujo",
      configuredEmbeddingModel: provider.id,
      configuredDimension: 4,
      now: NOW,
    });

    expect(result.status).toBe("unhealthy");
    expect(result.issues).toContain("sqlite_integrity_failed");
    expect(result.issues).not.toContain("manifest_invalid");
  });

  it("rejects rollback descriptor metadata tampering even when its database digest is unchanged", async () => {
    const root = tempRoot();
    const provider = fakeEmbeddings(4);
    await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 });
    const second = await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 });
    expect(second.rollback).toBeDefined();
    const manifestPath = join(root, ".index", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      rollback?: { createdAt: string };
    };
    expect(manifest.rollback).toBeDefined();
    manifest.rollback!.createdAt = "2026-07-12T09:00:00.000Z";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    publishRuntime(root, "bujo");

    const result = auditBujoMemoryHealth({
      root,
      mode: "bujo",
      configuredEmbeddingModel: provider.id,
      configuredDimension: 4,
      now: NOW,
    });

    expect(result.status).toBe("unhealthy");
    expect(result.issues).toContain("metadata_mismatch");
    expect(result.issues).not.toContain("sqlite_integrity_failed");
  });

  it("detects out-of-band canonical drift in an advertised rollback tier outside the active tier source domain", async () => {
    const root = tempRoot();
    const provider = fakeEmbeddings(4);
    appendBullet(root, bullet(), NOW);
    appendGraphBatch(root, {
      entities: [{ id: "project:one", name: "One", createdAt: NOW.toISOString() }],
    });
    await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings: provider, dim: 4 });
    const lite = await safeRebuildMemoryIndex({ root, tier: "lite" });
    expect(lite.rollback).toBeDefined();
    // Deliberately bypass the normal graph mutation boundary: supported writes
    // retire the BuJo rollback before appending, while strict audit must still
    // detect operator/out-of-band tampering.
    writeFileSync(
      join(root, "graph.jsonl"),
      `${readFileSync(join(root, "graph.jsonl"), "utf8")}${JSON.stringify({
        kind: "entity",
        id: "project:two",
        name: "Two",
        createdAt: NOW.toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    publishRuntime(root, "lite");

    const result = auditBujoMemoryHealth({ root, mode: "lite", now: NOW });

    expect(result.status).toBe("unhealthy");
    expect(result.issues).toContain("canonical_mismatch");
    expect(result.issues).not.toContain("metadata_mismatch");
    expect(result.issues).not.toContain("sqlite_integrity_failed");
  });

  it("detects stable canonical divergence through the rebuild parity rules", () => {
    const root = tempRoot();
    const db = openMemoryDb({ path: join(root, "memory.db") });
    db.upsertLexical(memory());
    db.close();
    publishRuntime(root, "lite");

    const result = auditBujoMemoryHealth({ root, mode: "lite", now: NOW });

    expect(result.status).toBe("unhealthy");
    expect(result.issues).toContain("canonical_mismatch");
    expect(result.counts).toMatchObject({ memories: 1, vectors: 0, missingVectors: 0 });
  });

  it("returns a fingerprint-stable canonical mismatch after one bulk parity pass", () => {
    const root = tempRoot();
    appendBullet(root, bullet(), NOW);
    const db = openMemoryDb({ path: join(root, "memory.db") });
    db.upsertLexical({
      ...memory(),
      id: "M-HEALTH",
      source: { file: "daily/2026-07-12.md", line: 3 },
    });
    db.close();
    publishRuntime(root, "lite");
    const inventory = vi.spyOn(MemoryDb.prototype, "allMemories");
    try {
      const result = auditBujoMemoryHealth({ root, mode: "lite", now: NOW });

      expect(result.issues).toContain("canonical_mismatch");
      expect(inventory).toHaveBeenCalledTimes(1);
    } finally {
      inventory.mockRestore();
    }
  });

  it("fails closed on malformed canonical memory without returning its bytes", () => {
    const root = tempRoot();
    const db = openMemoryDb({ path: join(root, "memory.db") });
    db.close();
    mkdirSync(join(root, "daily"));
    writeFileSync(
      join(root, "daily", "2026-07-12.md"),
      "- ◦ private malformed memory <!--mem id=M-BAD type=note-->\n",
      { mode: 0o600 },
    );
    publishRuntime(root, "lite");

    const result = auditBujoMemoryHealth({ root, mode: "lite", now: NOW });

    expect(result.status).toBe("unhealthy");
    expect(result.issues).toContain("canonical_invalid");
    expect(JSON.stringify(result)).not.toContain("private malformed memory");
  });

  it("counts malformed outbox state and temporary artifacts while failing closed", () => {
    const root = tempRoot();
    const db = openMemoryDb({ path: join(root, "memory.db") });
    db.close();
    publishRuntime(root, "lite");
    const handle = writeCaptureIntent(root, [], {}, NOW.toISOString());
    writeFileSync(join(root, handle.file), "{private-memory-text\n", { mode: 0o600 });
    writeFileSync(
      join(root, ".capture-outbox", ".intent-00000000-0000-4000-8000-000000000000.json-00000000-0000-4000-8000-000000000001.tmp"),
      "{private-temp-text",
      { mode: 0o600 },
    );

    const result = auditBujoMemoryHealth({ root, mode: "lite", now: NOW });

    expect(result.status).toBe("unhealthy");
    expect(result.issues).toEqual(expect.arrayContaining(["outbox_invalid", "outbox_pending", "temporary_artifacts"]));
    expect(result.counts).toMatchObject({ outbox: 1, temporary: 1 });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("keeps a freshly published outbox intent in progress", () => {
    const root = tempRoot();
    const db = openMemoryDb({ path: join(root, "memory.db") });
    db.close();
    writeCaptureIntent(root, [], {}, NOW.toISOString());
    publishRuntime(root, "lite");

    const result = auditBujoMemoryHealth({ root, mode: "lite", now: NOW });

    expect(result.status).toBe("in_progress");
    expect(result.issues).toEqual(expect.arrayContaining(["mutation_in_progress", "outbox_pending"]));
    expect(result.issues).not.toContain("work_stalled");
  });

  it("degrades an outbox intent at the exact stall boundary without exposing private age metadata", () => {
    const root = tempRoot();
    const db = openMemoryDb({ path: join(root, "memory.db") });
    db.close();
    const handle = writeCaptureIntent(root, [], {}, NOW.toISOString());
    const file = join(root, handle.file);
    const intent = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(typeof intent.publishedAt).toBe("string");
    intent.publishedAt = new Date(NOW.getTime() - BUJO_RUNTIME_SNAPSHOT_STALE_AFTER_MS).toISOString();
    writeFileSync(file, `${JSON.stringify(intent)}\n`, { mode: 0o600 });
    publishRuntime(root, "lite");

    const result = auditBujoMemoryHealth({ root, mode: "lite", now: NOW });

    expect(result.status).toBe("degraded");
    expect(result.issues).toContain("work_stalled");
    expect(JSON.stringify(result)).not.toContain(String(intent.publishedAt));
    expect(JSON.stringify(result)).not.toContain(String(intent.id));
  });

  it("uses pinned file mtime, never semantic createdAt, for a legacy outbox stall", () => {
    const root = tempRoot();
    const db = openMemoryDb({ path: join(root, "memory.db") });
    db.close();
    const handle = writeCaptureIntent(root, [], {}, "2020-01-01T00:00:00.000Z");
    const file = join(root, handle.file);
    const intent = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    delete intent.publishedAt;
    writeFileSync(file, `${JSON.stringify(intent)}\n`, { mode: 0o600 });
    publishRuntime(root, "lite");

    const semanticallyOld = auditBujoMemoryHealth({ root, mode: "lite", now: NOW });
    expect(semanticallyOld.status).toBe("in_progress");
    expect(semanticallyOld.issues).not.toContain("work_stalled");

    const staleAt = new Date(NOW.getTime() - BUJO_RUNTIME_SNAPSHOT_STALE_AFTER_MS);
    utimesSync(file, staleAt, staleAt);

    const result = auditBujoMemoryHealth({ root, mode: "lite", now: NOW });

    expect(result.status).toBe("degraded");
    expect(result.issues).toContain("work_stalled");
  });

  it("degrades an aged due intake at exactly 90 seconds but not a future scheduled retry", async () => {
    const agedRoot = tempRoot();
    const agedDb = openMemoryDb({ path: join(agedRoot, "memory.db") });
    agedDb.close();
    const dueAt = new Date(NOW.getTime() - BUJO_RUNTIME_SNAPSHOT_STALE_AFTER_MS);
    const aged = new CompletedTurnIntakeManager({
      root: agedRoot,
      clock: () => dueAt,
      writeSummary: async () => undefined,
      capture: async () => "summary_only",
    });
    aged.admit({ runId: "aged-due", conversationId: "private", summary: "private" });
    aged.finishShutdown();
    publishRuntime(agedRoot, "lite", 0, false, false, { pending: 1, due: 1 });

    const stalled = auditBujoMemoryHealth({ root: agedRoot, mode: "lite", now: NOW });
    expect(stalled.status).toBe("degraded");
    expect(stalled.issues).toContain("work_stalled");

    const futureRoot = tempRoot();
    const futureDb = openMemoryDb({ path: join(futureRoot, "memory.db") });
    futureDb.close();
    const future = new CompletedTurnIntakeManager({
      root: futureRoot,
      clock: () => NOW,
      writeSummary: async () => undefined,
      capture: async () => { throw new Error("provider unavailable"); },
      retryBaseMs: 60_000,
      retryMaxMs: 60_000,
    });
    future.admit({ runId: "future-retry", conversationId: "private", summary: "private" });
    await future.flush();
    future.finishShutdown();
    publishRuntime(futureRoot, "lite", 0, false, false, { pending: 1, due: 0 });

    const scheduled = auditBujoMemoryHealth({ root: futureRoot, mode: "lite", now: NOW });
    expect(scheduled.status).toBe("in_progress");
    expect(scheduled.issues).toContain("intake_pending");
    expect(scheduled.issues).not.toContain("work_stalled");
  });

  it("publishes retrying immediately so an aged due intake is not briefly reported stalled", async () => {
    const root = tempRoot();
    const db = openMemoryDb({ path: join(root, "memory.db") });
    db.close();
    const dueAt = new Date(NOW.getTime() - BUJO_RUNTIME_SNAPSHOT_STALE_AFTER_MS);
    let current = dueAt;
    let releaseSummary!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseSummary = resolve; });
    let started!: () => void;
    const processing = new Promise<void>((resolve) => { started = resolve; });
    let intake!: CompletedTurnIntakeManager;
    intake = new CompletedTurnIntakeManager({
      root,
      clock: () => current,
      writeSummary: async () => {
        started();
        await blocked;
      },
      capture: async () => "summary_only",
      onChange: (urgency) => {
        if (urgency === "urgent") publishRuntime(root, "lite", 0, false, false, intake.snapshot());
      },
    });
    intake.admit({ runId: "active-aged-retry", conversationId: "private", summary: "private" });
    current = NOW;
    await processing;

    const result = auditBujoMemoryHealth({ root, mode: "lite", now: NOW });

    expect(result.status).toBe("in_progress");
    expect(result.issues).toContain("intake_pending");
    expect(result.issues).not.toContain("work_stalled");
    expect(result.issues).not.toContain("runtime_invalid");
    releaseSummary();
    await intake.flush();
    intake.finishShutdown();
  });

  it("projects a recoverable ledger-catalog temp into strict aggregate counts", () => {
    const root = tempRoot();
    const db = openMemoryDb({ path: join(root, "memory.db") });
    db.close();
    const intake = new CompletedTurnIntakeManager({
      root,
      clock: () => NOW,
      writeSummary: async () => undefined,
      capture: async () => "summary_only",
    });
    intake.admit({
      runId: "private-run-id",
      conversationId: "private-conversation-id",
      summary: "private summary text",
    });
    intake.finishShutdown();
    writeFileSync(
      join(root, ".capture-intake", ".ledger-v1.catalog-00000000-0000-4000-8000-000000000000.tmp"),
      "private partial catalog",
      { mode: 0o600 },
    );
    publishRuntime(root, "lite");

    const result = auditBujoMemoryHealth({ root, mode: "lite", now: NOW });

    expect(result.status).toBe("unhealthy");
    expect(result.issues).toEqual(expect.arrayContaining(["intake_invalid", "intake_pending", "temporary_artifacts"]));
    expect(result.counts).toMatchObject({ pending: 1, temporary: 1 });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("never exposes malformed manifest or SQLite error text", () => {
    const root = tempRoot();
    publishRuntime(root, "bujo");
    writeFileSync(join(root, ".index", "manifest.json"), "private-manifest-payload\n", { mode: 0o600 });

    const manifest = auditBujoMemoryHealth({ root, mode: "bujo", now: NOW });
    expect(manifest.status).toBe("unhealthy");
    expect(manifest.issues).toContain("manifest_invalid");
    expect(JSON.stringify(manifest)).not.toContain("private-manifest-payload");

    rmSync(join(root, ".index", "manifest.json"));
    writeFileSync(join(root, "memory.db"), "private-sqlite-payload\n", { mode: 0o600 });
    const database = auditBujoMemoryHealth({ root, mode: "lite", now: NOW });
    expect(database.status).toBe("unknown");
    expect(database.issues).toContain("database_unavailable");
    expect(JSON.stringify(database)).not.toContain("private-sqlite-payload");
  });

  it("classifies runtime tier disagreement as degraded metadata", () => {
    const root = tempRoot();
    const db = openMemoryDb({ path: join(root, "memory.db") });
    db.close();
    publishRuntime(root, "bujo");

    const result = auditBujoMemoryHealth({ root, mode: "lite", now: NOW });

    expect(result.status).toBe("degraded");
    expect(result.issues).toEqual(["runtime_invalid"]);
  });

  it("degrades a structurally valid but operationally failed runtime snapshot", () => {
    const root = tempRoot();
    const db = openMemoryDb({ path: join(root, "memory.db") });
    db.close();
    publishRuntime(root, "lite", 0, false, true);

    const result = auditBujoMemoryHealth({ root, mode: "lite", now: NOW });

    expect(result.status).toBe("degraded");
    expect(result.issues).toEqual(["runtime_invalid"]);
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memory-health-audit-"));
  roots.push(root);
  return root;
}

function publishRuntime(
  root: string,
  tier: BujoTier,
  indexBacklog = 0,
  recoveryPaused = false,
  runtimeFault = false,
  intakeOverrides: Partial<ReturnType<CompletedTurnIntakeManager["snapshot"]>> = {},
): void {
  const queue = {
    capacity: { items: 64, bytes: 1024 * 1024, batchSize: 32 },
    queued: 0,
    queuedBytes: 0,
    inFlight: 0,
    inFlightBytes: 0,
    highWaterItems: 0,
    highWaterBytes: 0,
    enqueued: 0,
    completed: 0,
    failed: recoveryPaused ? 1 : 0,
    dropped: 0,
    discarded: 0,
    coalesced: 0,
    draining: false,
    accepting: true,
  };
  writeBujoRuntimeSnapshot(root, {
    schemaVersion: BUJO_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    pid: process.pid,
    tier,
    state: "running",
    startedAt: "2026-07-12T09:59:00.000Z",
    updatedAt: "2026-07-12T09:59:59.000Z",
    queues: {
      ...(tier === "journal" ? {
        index: {
          ...queue,
          remainingBacklog: indexBacklog,
          recoveryFilesRemaining: 0,
          recoveryPaused,
          retryDelayMs: recoveryPaused ? 1_000 : 0,
          nextRetryDelayMs: recoveryPaused ? 2_000 : 0,
          recoveryRowsScanned: 0,
          recoveryRefillQueries: 0,
        },
      } : {}),
      ...(tier === "bujo" ? { capture: queue } : {}),
      intake: {
        pending: 0,
        dead: 0,
        resolved: 0,
        due: 0,
        transitioning: 0,
        retrying: runtimeFault ? 7 : 0,
        accepting: !runtimeFault,
        shutdown: runtimeFault ? "timed_out" : "running",
        ...intakeOverrides,
      },
      shutdown: { drainTimeoutMs: 10_000, discarded: runtimeFault ? 3 : 0, timedOut: runtimeFault },
    },
    counters: { embeddingCalls: 0, embeddingTexts: 0, llmCalls: 0, llmInputChars: 0 },
  });
}

function bullet(): Bullet {
  return {
    id: "M-HEALTH",
    type: "note",
    status: "open",
    text: "Strict health follows canonical source.",
    salience: 0.7,
    isInsight: false,
    createdAt: NOW.toISOString(),
    refs: [],
  };
}

function memory(): MemoryRecord {
  return {
    id: "M-DB-ONLY",
    type: "note",
    status: "open",
    text: "This row has no canonical source.",
    salience: 0.5,
    isInsight: false,
    createdAt: NOW.toISOString(),
    accessCount: 0,
    tags: [],
    source: { file: "daily/2026-07-12.md", line: 1 },
  };
}
