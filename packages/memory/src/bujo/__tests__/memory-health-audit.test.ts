import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openMemoryDb, type MemoryRecord } from "../../store/index.js";
import { loadVec } from "../../store/vec.js";
import {
  auditBujoMemoryHealth,
  BUJO_MEMORY_HEALTH_SCHEMA_VERSION,
} from "../audit.js";
import { CompletedTurnIntakeManager } from "../capture-intake.js";
import { writeCaptureIntent } from "../capture-outbox.js";
import { appendBullet } from "../daily.js";
import { safeRebuildMemoryIndex } from "../rebuild.js";
import { createBujoMemoryStore } from "../store.js";
import {
  BUJO_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
  writeBujoRuntimeSnapshot,
} from "../runtime-snapshot.js";
import type { BujoTier, Bullet } from "../types.js";
import { fakeEmbeddings } from "./helpers.js";

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

      const result = auditBujoMemoryHealth({ root, mode: "lite", now: new Date() });

      expect(result.status).toBe("healthy");
      expect(result.issues).toEqual([]);
      expect(JSON.stringify(result)).not.toContain("private-conversation");
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
