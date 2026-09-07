import { projectSummary, projectCapture } from "./helpers.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { openMemoryDb, type MemoryRecord } from "../../store/index.js";
import { fakeEmbeddings, fakeLlm } from "./helpers.js";
import { writeCaptureIntent } from "../capture-outbox.js";
import { createBujoMemoryStore } from "../store.js";
import { appendBullet, auditFilePath, dailyFilePath, normalizedContentHash } from "../daily.js";
import { auditCanonicalGraphParity, appendGraphBatch } from "../index.js";
import { parseDailyFile } from "../grammar.js";
import { migrate } from "../migrate.js";
import { readBujoRuntimeSnapshot } from "../runtime-snapshot.js";
import type { Bullet } from "../types.js";

describe("BujoMemoryStore — tier derivation", () => {
  it("lite tier: no embeddings → tier() === 'lite'; completed-turn summary and recall work", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-tier-lite-"));
    const now = new Date("2026-06-16T09:00:00.000Z");
    // No embeddings — FTS-only store
    const store = createBujoMemoryStore({ root, clock: () => now });

    expect(store.tier()).toBe("lite");

    await projectSummary(store, "s1", "Morgan's memory preference is opt-in.");
    const block = await store.load("What is Morgan's memory preference?");
    // FTS recall: keyword must appear in the block
    expect(block?.content).toContain("memory preference is opt-in");

    await projectCapture(store, "s1", "some text");
    expect(store.queueSnapshot().intake).toMatchObject({ resolved: 2, pending: 0, dead: 0 });
    expect(parseDailyFile(readFileSync(dailyFilePath(root, now), "utf8")).bullets.map(({ text }) => text)).toContain("some text");

    await store.close();
  });

  it("journal tier: embeddings + no llm → tier() === 'journal'; completed-turn summary and recall work", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-tier-journal-"));
    const now = new Date("2026-06-16T09:00:00.000Z");
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64, clock: () => now });

    expect(store.tier()).toBe("journal");

    await projectSummary(store, "s1", "Morgan's weekly review status is complete.");
    const block = await store.load("What is Morgan's weekly review status?");
    expect(block?.content).toContain("weekly review");

    await projectCapture(store, "s1", "some text");
    expect(store.queueSnapshot().intake).toMatchObject({ resolved: 2, pending: 0, dead: 0 });
    expect(parseDailyFile(readFileSync(dailyFilePath(root, now), "utf8")).bullets.map(({ text }) => text)).toContain("some text");

    await store.close();
  });

  it("bujo tier: embeddings + llm → tier() === 'bujo'; completed-turn capture curates memories", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-tier-bujo-"));
    const now = new Date("2026-06-16T09:00:00.000Z");
    const llm = fakeLlm([
      [
        "Extract one bounded",
        JSON.stringify({
          memories: [{ type: "note", text: "Morgan prefers morning routines", salience: 0.8, isInsight: false, entityIds: ["person:morgan"] }],
          entities: [{ id: "person:morgan", name: "Morgan", type: "person" }],
          relations: [],
        }),
      ],
    ]);
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64, llm, clock: () => now });

    expect(store.tier()).toBe("bujo");

    await projectCapture(store, "s1", "Morgan prefers morning routines for focus.");
    expect(store.queueSnapshot().intake?.resolved).toBe(1);

    await store.flush();
    const running = readBujoRuntimeSnapshot(root);
    expect(running).toMatchObject({
      available: true,
      stale: false,
      processAlive: true,
      snapshot: {
        pid: process.pid,
        tier: "bujo",
        state: "running",
        counters: { embeddingCalls: 2, embeddingTexts: 2, llmCalls: 1 },
      },
    });
    expect(running.snapshot?.queues.intake?.resolved).toBe(1);

    await store.flush();
    await store.close();
    expect(readBujoRuntimeSnapshot(root)).toMatchObject({
      available: true,
      stale: true,
      snapshot: { state: "closed" },
    });

    const runtimePath = join(root, ".index", "runtime.json");
    const injected = JSON.parse(readFileSync(runtimePath, "utf8")) as {
      queues: { intake: Record<string, unknown> };
    };
    injected.queues.intake["privateText"] = "must never pass through audit";
    writeFileSync(runtimePath, `${JSON.stringify(injected)}\n`, "utf8");
    expect(readBujoRuntimeSnapshot(root)).toEqual({
      available: false,
      stale: true,
      reason: "invalid",
    });
  });

  it("recovers an already-paid migration synchronously before exposing writable startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-startup-migrate-"));
    const now = new Date("2026-06-16T09:00:00.000Z");
    const created = new Date("2026-04-01T09:00:00.000Z");
    const embeddings = fakeEmbeddings(64);
    const bullet: Bullet = {
      id: "MIG-STARTUP",
      type: "note",
      status: "open",
      text: "startup must finish this already-paid migration",
      salience: 0.2,
      isInsight: false,
      createdAt: created.toISOString(),
      refs: [],
    };
    appendBullet(root, bullet, created);
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings, dim: 64 });
    await db.upsert({
      ...bullet,
      accessCount: 0,
      tags: [],
      source: { file: relative(root, dailyFilePath(root, created)) },
    });
    await expect(migrate({
      db,
      root,
      llm: { id: "paid", complete: async () => JSON.stringify({ action: "promote" }) },
      now: () => now,
      hooks: { afterDecisionDurable: () => { throw new Error("fault-after-paid-decision"); } },
    })).rejects.toThrow("fault-after-paid-decision");
    db.close();
    const startupLlm = vi.fn(async () => { throw new Error("startup recovery must not call the LLM"); });

    const store = createBujoMemoryStore({
      root,
      tier: "bujo",
      embeddings,
      dim: 64,
      llm: { id: "startup", complete: startupLlm },
      clock: () => now,
    });

    expect(startupLlm).not.toHaveBeenCalled();
    expect(readFileSync(join(root, "monthly", "2026-06.md"), "utf8")).not.toContain("mono-agent-migrate:");
    await store.close();
    const inspected = openMemoryDb({ path: join(root, "memory.db"), readOnly: true, dim: 64 });
    expect(inspected.get(bullet.id)?.salience).toBe(0.5);
    inspected.close();
  });

  it("repairs canonical relation and association drift during synchronous outbox recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-startup-capture-graph-"));
    const now = new Date("2026-07-11T09:00:00.000Z");
    const canonicalAt = "2026-01-01T00:00:00.000Z";
    const driftedAt = "2026-06-01T00:00:00.000Z";
    const embeddings = fakeEmbeddings(64);
    const item: Bullet = {
      id: "CAPTURE-GRAPH-RECOVERY",
      type: "note",
      status: "open",
      text: "Morgan maintains mono-agent.",
      salience: 0.7,
      isInsight: false,
      createdAt: now.toISOString(),
      refs: [],
    };
    appendBullet(root, item, now);
    const file = relative(root, dailyFilePath(root, now));
    const record: MemoryRecord = {
      ...item,
      accessCount: 0,
      tags: [],
      source: { file },
    };
    appendGraphBatch(root, {
      entities: [
        { id: "person:morgan", name: "Morgan", type: "person", createdAt: canonicalAt },
        { id: "project:mono-agent", name: "mono-agent", type: "project", createdAt: canonicalAt },
      ],
      relations: [{
        src: "person:morgan",
        dst: "project:mono-agent",
        relation: "maintains",
        createdAt: canonicalAt,
      }],
      associations: [{
        memoryId: item.id,
        entityId: "person:morgan",
        provenance: "capture",
        createdAt: canonicalAt,
      }],
    });
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings, dim: 64 });
    await db.upsert(record);
    db.upsertEntity({ id: "person:morgan", name: "Morgan", type: "person", createdAt: canonicalAt });
    db.upsertEntity({ id: "project:mono-agent", name: "mono-agent", type: "project", createdAt: canonicalAt });
    db.addEntityRelation("person:morgan", "project:mono-agent", "maintains", driftedAt);
    db.associateMemory({
      memoryId: item.id,
      entityId: "person:morgan",
      provenance: "legacy-name-match",
      createdAt: driftedAt,
    });
    expect(auditCanonicalGraphParity(root, db)).toMatchObject({
      matches: false,
      relations: { timestampMismatches: 1 },
      associations: { timestampMismatches: 1, provenanceMismatches: 1 },
    });
    db.close();
    writeCaptureIntent(root, [{
      candidateIndex: 0,
      kind: "noop",
      id: item.id,
      expected: { file, bullet: item },
    }], {
      entities: [
        { id: "person:morgan", name: "Morgan", type: "person", createdAt: now.toISOString() },
        { id: "project:mono-agent", name: "mono-agent", type: "project", createdAt: now.toISOString() },
      ],
      relations: [{
        src: "person:morgan",
        dst: "project:mono-agent",
        relation: "maintains",
        createdAt: now.toISOString(),
      }],
      associations: [{
        memoryId: item.id,
        entityId: "person:morgan",
        provenance: "capture",
        createdAt: now.toISOString(),
      }],
    }, now.toISOString());

    const startupLlm = vi.fn(async () => { throw new Error("startup recovery must not call the LLM"); });
    const store = createBujoMemoryStore({
      root,
      tier: "bujo",
      embeddings,
      dim: 64,
      llm: { id: "startup", complete: startupLlm },
      clock: () => now,
    });
    expect(startupLlm).not.toHaveBeenCalled();
    await store.close();

    const inspected = openMemoryDb({ path: join(root, "memory.db"), readOnly: true, dim: 64 });
    expect(auditCanonicalGraphParity(root, inspected).matches).toBe(true);
    expect(inspected.relationsFor("person:morgan")[0]?.createdAt).toBe(canonicalAt);
    expect(inspected.associationsForMemory(item.id)).toEqual([{
      memoryId: item.id,
      entityId: "person:morgan",
      provenance: "capture",
      createdAt: canonicalAt,
    }]);
    expect(readdirSync(join(root, ".capture-outbox"))).toEqual([]);
    inspected.close();
  });

  it("fails and releases writable startup when paid migration canonical identity is duplicated", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-startup-migrate-duplicate-"));
    const now = new Date("2026-06-16T09:00:00.000Z");
    const created = new Date("2026-04-01T09:00:00.000Z");
    const embeddings = fakeEmbeddings(64);
    const bullet: Bullet = {
      id: "MIG-STARTUP-DUPLICATE",
      type: "note",
      status: "open",
      text: "duplicate migration startup sentinel",
      salience: 0.2,
      isInsight: false,
      createdAt: created.toISOString(),
      refs: [],
    };
    appendBullet(root, bullet, created);
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings, dim: 64 });
    await db.upsert({
      ...bullet,
      accessCount: 0,
      tags: [],
      source: { file: relative(root, dailyFilePath(root, created)) },
    });
    await expect(migrate({
      db,
      root,
      llm: { id: "paid", complete: async () => JSON.stringify({ action: "promote" }) },
      now: () => now,
      hooks: { afterDecisionDurable: () => { throw new Error("fault-after-paid-decision"); } },
    })).rejects.toThrow("fault-after-paid-decision");
    db.close();
    appendBullet(root, bullet, created);
    const startupLlm = vi.fn(async () => { throw new Error("startup recovery must not call the LLM"); });
    const start = () => createBujoMemoryStore({
      root,
      tier: "bujo",
      embeddings,
      dim: 64,
      llm: { id: "startup", complete: startupLlm },
      clock: () => now,
    });

    expect(start).toThrow(/contains 2 bullets.*exactly one/iu);
    // A failed constructor must release the writer lease; the same canonical
    // fence, rather than a stale lock, is observed on the next attempt.
    expect(start).toThrow(/contains 2 bullets.*exactly one/iu);
    expect(startupLlm).not.toHaveBeenCalled();
    expect(readFileSync(join(root, "monthly", "2026-06.md"), "utf8")).toContain("mono-agent-migrate:");
    const inspected = openMemoryDb({ path: join(root, "memory.db"), readOnly: true, dim: 64 });
    expect(inspected.get(bullet.id)?.salience).toBe(0.2);
    inspected.close();
  });

  it("rejects writable BuJo startup when a nonempty active index has partial vector coverage", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-startup-partial-vectors-"));
    const now = new Date("2026-06-16T09:00:00.000Z");
    const bullet = journalBullet("PARTIAL-VECTOR", "This curated row is missing its vector", now);
    appendBullet(root, bullet, now);
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(64), dim: 64 });
    db.upsertLexical({
      ...bullet,
      accessCount: 0,
      tags: [],
      source: { file: relative(root, dailyFilePath(root, now)) },
    });
    db.close();
    const start = () => createBujoMemoryStore({
      root,
      tier: "bujo",
      embeddings: fakeEmbeddings(64),
      dim: 64,
      llm: fakeLlm([]),
      clock: () => now,
    });

    expect(start).toThrow(/complete vector coverage.*0\/1 vectors/iu);
    // Constructor failure releases the writer lease and repeats the same
    // coverage guard instead of degrading into a stale-lock error.
    expect(start).toThrow(/complete vector coverage.*0\/1 vectors/iu);
  });

  it("rejects an explicit tier that would silently downshift configured prerequisites", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-tier-override-"));
    expect(() => createBujoMemoryStore({
      root,
      embeddings: fakeEmbeddings(64),
      dim: 64,
      tier: "lite",
    })).toThrow(/lexical-only/i);
  });

  it("consolidate() is available without an llm and preserves derived tier semantics", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-tier-consolidate-"));
    let now = new Date("2026-06-01T09:00:00.000Z");
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64, clock: () => now });

    expect(store.tier()).toBe("journal");
    await projectSummary(store, "s1", "Morgan prefers opt-in memory.");
    now = new Date("2026-06-02T09:00:00.000Z");
    await projectSummary(store, "s2", "morgan prefers opt in memory");
    now = new Date("2026-07-06T09:00:00.000Z");

    const result = await store.consolidate();

    expect(store.tier()).toBe("journal");
    expect(result).toEqual({ duplicateGroups: 1 });
    expect(readFileSync(join(root, "future-log.md"), "utf8")).toBe("# Future Log\n");
    const hits = await store.recall("opt-in memory", { topK: 5 });
    expect(hits).toHaveLength(2);

    await store.close();
  });
});

describe("BujoMemoryStore", () => {
  it("completed-turn summary projects a canonical daily bullet and indexes it", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-store-"));
    const now = new Date("2026-06-15T09:00:00.000Z");
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64, clock: () => now });

    const result = await projectSummary(store, "global", "Morgan's memory preference is opt-in.");
    expect(result.bytesWritten).toBeGreaterThan(0);

    const file = readFileSync(dailyFilePath(root, now), "utf8");
    const parsed = parseDailyFile(file);
    expect(parsed.bullets).toHaveLength(1);
    expect(parsed.bullets[0]?.text).toContain("memory preference is opt-in");

    const block = await store.load("global", "What is Morgan's memory preference?");
    expect(block?.content).toContain("memory preference is opt-in");
    await store.close();
  });

  it("conforms to MemoryStore (markdown block on a hit, undefined on no hits)", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-store-"));
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64 });
    // No hits → no block (a header-only block carries no signal).
    expect(await store.load("global")).toBeUndefined();
    // With a hit, load returns a markdown block.
    await projectSummary(store, "s1", "Morgan's memory preference is opt-in.");
    const block = await store.load("What is Morgan's memory preference?");
    expect(block?.kind).toBe("markdown");
    expect(block?.content).toContain("memory preference is opt-in");
    await store.close();
  });

  it("loads a qualifying block from a read-only store without access writes", async () => {
    const root = tmpRoot();
    const writable = createBujoMemoryStore({ root });
    await projectSummary(writable, "seed", "Morgan's memory preference is opt-in.");
    await writable.close();

    const readOnly = createBujoMemoryStore({ root, readOnly: true });
    await expect(readOnly.load("seed", "What is Morgan's memory preference?")).resolves.toMatchObject({
      kind: "markdown",
      content: expect.stringContaining("Morgan's memory preference is opt-in."),
    });
    await readOnly.close();

    const inspected = openMemoryDb({ path: join(root, "memory.db"), readOnly: true });
    try {
      const [hit] = await inspected.recall("What is Morgan's memory preference?", { trackAccess: false });
      expect(hit?.record.accessCount).toBe(0);
    } finally {
      inspected.close();
    }
  });

  it("appends multiple summaries: both indexed, single daily header, bytesWritten counts durable admission", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-store-"));
    const now = new Date("2026-06-15T09:00:00.000Z");
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64, clock: () => now });

    const summary = "Morgan's memory preference is opt-in.";
    const r1 = await projectSummary(store, "s1", summary);
    await projectSummary(store, "s2", "lunch was pizza on tuesday");

    // bytesWritten reflects durable intake metadata plus the host summary.
    expect(r1.bytesWritten).toBeGreaterThan(Buffer.byteLength(summary, "utf8"));

    const file = readFileSync(dailyFilePath(root, now), "utf8");
    expect(parseDailyFile(file).bullets).toHaveLength(2);
    expect((file.match(/^# 2026-06-15$/gmu) ?? []).length).toBe(1);

    const block = await store.load("What is Morgan's memory preference?");
    expect(block?.content).toContain("memory preference is opt-in");
    await store.close();
  });

  it("normalizes a multi-line host summary into one bullet line (does not throw)", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-store-"));
    const now = new Date("2026-06-15T09:00:00.000Z");
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64, clock: () => now });
    const multiline = "User asked about memory.\nAssistant proposed opt-in mode.\nAction: drafted the spec.";
    await expect(projectSummary(store, "s1", multiline)).resolves.toBeDefined();
    const parsed = parseDailyFile(readFileSync(dailyFilePath(root, now), "utf8"));
    expect(parsed.bullets).toHaveLength(1);
    expect(parsed.bullets[0]?.text).not.toContain("\n");
    expect(parsed.bullets[0]?.text).toContain("opt-in mode");
    await store.close();
  });

  it("completed-turn capture extracts, reconciles, and makes memories recallable", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-store-capture-"));
    const now = new Date("2026-06-15T10:00:00.000Z");

    const llm = fakeLlm([
      [
        "Extract one bounded",
        JSON.stringify({
          memories: [{
            type: "note",
            text: "Morgan's memory preference is opt-in",
            salience: 0.8,
            isInsight: false,
            entityIds: ["person:morgan"],
          }],
          entities: [{ id: "person:morgan", name: "Morgan", type: "person" }],
          relations: [],
        }),
      ],
    ]);

    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64, clock: () => now, llm });

    await projectCapture(store, "s1", "Morgan prefers opt-in memory, never silent fallback.");
    expect(store.queueSnapshot().intake?.resolved).toBe(1);


    // Captured memory must be recallable via load()
    const block = await store.load("s1", "What is Morgan's memory preference?");
    expect(block?.content).toContain("memory preference is opt-in");

    await store.close();
  });

  it("completed-turn capture without an llm persists only its summary", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-store-nollm-"));
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64 });
    const summary = "Deterministic summary remains durable without a capture model.";
    const admission = await store.persistCompletedTurn({
      runId: "no-model-capture", conversationId: "s1", summary,
      captureText: "A different detailed conversation that must not become a curated fact.",
    });
    await store.flush();
    const receipt = JSON.parse(readFileSync(join(root, ".capture-intake", "resolved", `${admission.id}.json`), "utf8"));
    expect(receipt).toMatchObject({ state: "resolved", outcome: "summary_only" });
    expect(parseDailyFile(readFileSync(dailyFilePath(root, new Date()), "utf8")).bullets.map(({ text }) => text)).toEqual([summary]);
    const db = openMemoryDb({ path: join(root, "memory.db"), readOnly: true });
    try {
      expect(db.allMemories().map(({ text }) => text)).toEqual([summary]);
      expect(db.countEntities()).toBe(0);
    } finally {
      db.close();
    }
    await store.close();
  });

  it("migrate() returns undefined when no llm configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-store-migrate-nollm-"));
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64 });
    const result = await store.migrate();
    expect(result).toBeUndefined();
    await store.close();
  });

  it("migrate() with llm: returns MigrateResult and writes future-log.md", async () => {
    const DIM = 64;
    const root = mkdtempSync(join(tmpdir(), "bujo-store-migrate-llm-"));
    const now = new Date("2026-06-15T12:00:00.000Z");
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 86_400_000);

    // Seed an aging memory directly into the db
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(DIM), dim: DIM });
    const bullet: Bullet = {
      id: "STORE-MIG-1",
      type: "note",
      status: "open",
      text: "buy milk from the corner store",
      salience: 0.2,
      isInsight: false,
      createdAt: sixtyDaysAgo.toISOString(),
      refs: [],
    };
    appendBullet(root, bullet, sixtyDaysAgo);
    await db.upsert({
      id: "STORE-MIG-1",
      type: "note",
      status: "open",
      text: "buy milk from the corner store",
      salience: 0.2,
      isInsight: false,
      createdAt: sixtyDaysAgo.toISOString(),
      accessCount: 0,
      tags: [],
      source: { file: relative(root, dailyFilePath(root, sixtyDaysAgo)) },
    });
    db.close();

    const llm = fakeLlm([["buy milk", JSON.stringify({ action: "forget" })]]);
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(DIM), dim: DIM, clock: () => now, llm });

    const result = await store.migrate();

    expect(result?.reviewed).toBeGreaterThanOrEqual(1);
    expect(result?.forgotten).toBe(1);

    // future-log.md written by migrate()
    expect(existsSync(join(root, "future-log.md"))).toBe(true);

    await store.close();
  });
});

describe("BujoMemoryStore — recall query (load 2nd arg)", () => {
  it("recalls against the query argument, not the conversation id", async () => {
    const store = createBujoMemoryStore({ root: mkdtempSync(join(tmpdir(), "bujo-recall-q-")) });
    await projectSummary(store, "c1", "The launch date is March 3rd.");
    await projectSummary(store, "c1", "Team lunch was pizza on Tuesday.");

    // The query drives recall even when the conversation id shares nothing with the memories.
    const block = await store.load("unrelated-conversation-id", "When is the launch date?");
    expect(block?.content).toContain("launch");
    expect(block?.content).not.toContain("pizza");

    await store.close();
  });

  it("skips recall (returns undefined) when the query is empty/whitespace", async () => {
    const store = createBujoMemoryStore({ root: mkdtempSync(join(tmpdir(), "bujo-recall-empty-")) });
    await projectSummary(store, "c1", "The launch date is March 3rd.");
    expect(await store.load("c1", "   ")).toBeUndefined();
    await store.close();
  });

  it("falls back to the conversation id as a coarse seed when no query is supplied (back-compat)", async () => {
    const store = createBujoMemoryStore({ root: mkdtempSync(join(tmpdir(), "bujo-recall-seed-")) });
    await projectSummary(store, "c1", "The launch date is March 3rd.");
    const block = await store.load("When is the launch date?");
    expect(block?.content).toContain("launch");
    await store.close();
  });
});

// ─── Async capture queue tests ───────────────────────────────────────────────

import type { LlmComplete } from "../llm.js";
import type { EmbeddingProvider } from "../../search/index.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "bujo-queue-"));
}

// A fake LLM that records completion order and yields an empty capture plan.
function recordingLlm(order: string[], opts: { throwOnText?: string } = {}): LlmComplete {
  return {
    id: "fake",
    async complete(prompt: string): Promise<string> {
      // Push the full prompt so the caller can detect "FIRST" / "SECOND" / "POISON" / "HEALTHY"
      // (these appear in the TURN section at the tail of the capture prompt).
      order.push(prompt);
      if (opts.throwOnText !== undefined && prompt.includes(opts.throwOnText)) {
        throw new Error("boom");
      }
      return "[]"; // no capture plan — safe no-op
    },
  };
}

describe("BujoMemoryStore lifecycle", () => {

  it("recall delegates to db.recall and returns scored hits", async () => {
    const store = createBujoMemoryStore({ root: tmpRoot() });
    await projectSummary(store, "c1", "The launch date is March 3rd.");
    const hits = await store.recall("launch date", { topK: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(typeof hits[0]!.score).toBe("number");
    expect(hits[0]!.record.text).toMatch(/launch/i);
    await store.close();
  });

  it.each(["recall", "load"] as const)(
    "blocks an abort-ignoring semantic %s reply before post-close SQLite access",
    async (surface) => {
      const root = tmpRoot();
      const stableEmbeddings: EmbeddingProvider = {
        id: "semantic-read-close-race:64",
        embed: async (texts) => await fakeEmbeddings(64).embed(texts),
      };
      const seed = openMemoryDb({ path: join(root, "memory.db"), embeddings: stableEmbeddings, dim: 64 });
      await seed.upsert({
        id: "READ-RACE",
        type: "note",
        status: "open",
        text: "The semantic shutdown sentinel is durable.",
        salience: 0.8,
        isInsight: false,
        createdAt: new Date().toISOString(),
        accessCount: 0,
        tags: [],
        source: {},
      });
      seed.close();

      let entered = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const gatedEmbeddings: EmbeddingProvider = {
        id: stableEmbeddings.id,
        embed: async (texts) => {
          entered = true;
          await gate; // deliberately ignore store shutdown
          return await fakeEmbeddings(64).embed(texts);
        },
      };
      const store = createBujoMemoryStore({
        root,
        tier: "journal",
        embeddings: gatedEmbeddings,
        dim: 64,
        backgroundDrainTimeoutMs: 20,
      });

      const reading = surface === "recall"
        ? store.recall("semantic shutdown sentinel", { trackAccess: false })
        : store.load("read-race", "What is the semantic shutdown sentinel?");
      await waitUntil(() => entered);
      await store.close();
      // The closed store releases its writer lease while the provider remains
      // pending; its eventual reply must observe abort before touching SQLite.
      await createBujoMemoryStore({
        root,
        tier: "journal",
        embeddings: stableEmbeddings,
        dim: 64,
      }).close();

      const rejected = expect(reading).rejects.toThrow(/operation drain deadline/iu);
      release();
      await rejected;
    },
  );

  it("bounds close around migration and blocks a late decision before source rewrite", async () => {
    const root = tmpRoot();
    const now = new Date("2026-06-15T12:00:00.000Z");
    const createdAt = new Date(now.getTime() - 60 * 86_400_000);
    const source = dailyFilePath(root, createdAt);
    const bullet = { ...journalBullet("MIGRATE-RACE", "Old migration candidate.", createdAt), salience: 0.2 };
    appendBullet(root, bullet, createdAt);
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsert({
      id: bullet.id,
      type: bullet.type,
      status: bullet.status,
      text: bullet.text,
      salience: bullet.salience,
      isInsight: bullet.isInsight,
      createdAt: bullet.createdAt,
      accessCount: 0,
      tags: [],
      source: { file: relative(root, source) },
    });
    db.close();
    const sourceBefore = readFileSync(source, "utf8");
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const llm: LlmComplete = {
      id: "migrate-close-race",
      complete: async () => {
        entered = true;
        await gate; // deliberately ignore abortSignal
        return JSON.stringify({ action: "forget" });
      },
    };
    const store = createBujoMemoryStore({
      root,
      tier: "bujo",
      embeddings: fakeEmbeddings(64),
      dim: 64,
      llm,
      clock: () => now,
      backgroundDrainTimeoutMs: 20,
    });

    const migrating = store.migrate();
    await waitUntil(() => entered);
    await store.close();
    const rejected = expect(migrating).rejects.toThrow(/operation drain deadline/iu);
    release();
    await rejected;
    expect(readFileSync(source, "utf8")).toBe(sourceBefore);
    expect(existsSync(join(root, "monthly"))).toBe(false);
    expect(existsSync(join(root, "future-log.md"))).toBe(false);
  });

  it("drains an admitted Journal host-summary write before freezing its semantic queue", async () => {
    const root = tmpRoot();
    const store = createBujoMemoryStore({ root, tier: "journal", embeddings: fakeEmbeddings(64), dim: 64 });
    const lockPath = join(root, ".journal-write.lock");
    writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, token: "direct-close-race" })}\n`, { mode: 0o600 });

    const writing = projectSummary(store, "accepted", "An admitted Journal write survives graceful close.");
    const closing = store.close();
    let closeSettled = false;
    void closing.then(() => { closeSettled = true; });
    // Cross one event-loop turn so the admitted write reaches the live lock;
    // close must still be waiting on its admission barrier, without a timing threshold.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeSettled).toBe(false);

    unlinkSync(lockPath);
    const [write] = await Promise.all([writing, closing.then(() => undefined)]);
    expect(write.bytesWritten).toBeGreaterThan(0);
    expect(readFileSync(dailyFilePath(root, new Date()), "utf8")).toContain("admitted Journal write");
    expect(store.queueSnapshot().index).toMatchObject({ accepting: false, remainingBacklog: 0 });
  });

  it("rejects reads, writes, queue admission, capture, and maintenance after close without changing source", async () => {
    const root = tmpRoot();
    const store = createBujoMemoryStore({
      root,
      tier: "bujo",
      embeddings: fakeEmbeddings(64),
      dim: 64,
      llm: fakeLlm([]),
    });
    await projectSummary(store, "c", "Durable audit before close.");
    await store.close();
    const sourceBefore = readFileSync(auditFilePath(root, new Date()), "utf8");
    const queueBefore = store.queueSnapshot();

    await expect(projectSummary(store, "late", "must not escape after close")).rejects.toThrow(/closing or closed/iu);
    await expect(projectCapture(store, "late", "must not capture")).rejects.toThrow(/closing or closed/iu);
    await expect(store.migrate()).rejects.toThrow(/closing or closed/iu);
    await expect(store.consolidate()).rejects.toThrow(/closing or closed/iu);
    await expect(store.load("late", "audit")).rejects.toThrow(/closing or closed/iu);
    await expect(store.recall("audit")).rejects.toThrow(/closing or closed/iu);

    expect(readFileSync(auditFilePath(root, new Date()), "utf8")).toBe(sourceBefore);
    expect(store.queueSnapshot()).toEqual(queueBefore);
  });
});

describe("BujoMemoryStore strict tiers and background Journal indexing", () => {
  it("rejects every incomplete or cross-tier store shape", () => {
    expect(() => createBujoMemoryStore({ root: tmpRoot(), tier: "journal" })).toThrow(/requires embeddings/i);
    expect(() => createBujoMemoryStore({
      root: tmpRoot(), tier: "journal", embeddings: fakeEmbeddings(64), dim: 64, llm: recordingLlm([]),
    })).toThrow(/rejects capture llms/i);
    expect(() => createBujoMemoryStore({
      root: tmpRoot(), tier: "bujo", embeddings: fakeEmbeddings(64), dim: 64,
    })).toThrow(/requires a capture llm/i);
  });

  it("rejects a dangling legacy memory.db symlink before SQLite can create its outside target", () => {
    const root = tmpRoot();
    const outsideRoot = tmpRoot();
    const outside = join(outsideRoot, "escaped.db");
    symlinkSync(outside, join(root, "memory.db"));

    expect(() => createBujoMemoryStore({ root })).toThrow(/memory database.*symlink|symlink.*memory database/iu);
    expect(existsSync(outside)).toBe(false);
  });

  it("rejects a configured memory root that is itself a symlink before creating runtime state", () => {
    const parent = tmpRoot();
    const outside = tmpRoot();
    const linkedRoot = join(parent, "linked-memory");
    symlinkSync(outside, linkedRoot, "dir");

    expect(() => createBujoMemoryStore({ root: linkedRoot })).toThrow(/memory root.*symlink/iu);
    expect(existsSync(join(outside, ".index"))).toBe(false);
    expect(existsSync(join(outside, "memory.db"))).toBe(false);
  });

  it("never indexes or recalls Journal content through a symlinked daily directory", async () => {
    const root = tmpRoot();
    const outsideRoot = tmpRoot();
    const outsideDay = new Date("2026-01-03T09:00:00.000Z");
    appendBullet(outsideRoot, journalBullet("outside", "Outside recovery sentinel must stay private.", outsideDay), outsideDay);
    symlinkSync(join(outsideRoot, "daily"), join(root, "daily"), "dir");

    expect(() => createBujoMemoryStore({
      root,
      tier: "journal",
      embeddings: fakeEmbeddings(64),
      dim: 64,
    })).toThrow(/canonical directory.*daily.*symlink|daily.*real directory/iu);

    unlinkSync(join(root, "daily"));
    mkdirSync(join(root, "daily"));
    const clean = createBujoMemoryStore({ root, tier: "journal", embeddings: fakeEmbeddings(64), dim: 64 });
    await clean.flush();
    expect(await clean.recall("Outside recovery sentinel", { topK: 10, trackAccess: false })).toEqual([]);
    await clean.close();
  });

  it("rejects SQLite sidecar symlinks and read-only dbPath escapes", () => {
    const root = tmpRoot();
    const outsideRoot = tmpRoot();
    const outsideWal = join(outsideRoot, "escaped-wal");
    symlinkSync(outsideWal, join(root, "memory.db-wal"));
    expect(() => createBujoMemoryStore({ root })).toThrow(/wal sidecar.*symlink/iu);
    expect(existsSync(outsideWal)).toBe(false);
    unlinkSync(join(root, "memory.db-wal"));

    const outsideDb = join(outsideRoot, "outside.db");
    const seed = openMemoryDb({ path: outsideDb });
    seed.close();
    expect(() => createBujoMemoryStore({ root, readOnly: true, dbPath: outsideDb })).toThrow(/escapes.*memory root/iu);
  });

  it("returns before embeddings, coalesces 65 writes into 32-sized batches, and drains observably", async () => {
    const root = tmpRoot();
    const calls: number[] = [];
    const releases: Array<() => void> = [];
    const embeddings: EmbeddingProvider = {
      id: "deferred:64",
      async embed(texts) {
        calls.push(texts.length);
        await new Promise<void>((resolve) => releases.push(resolve));
        return texts.map(() => Array.from({ length: 64 }, (_, index) => index === 0 ? 1 : 0));
      },
    };
    const store = createBujoMemoryStore({ root, tier: "journal", embeddings, dim: 64 });
    const writes = await Promise.all(Array.from({ length: 65 }, (_, index) =>
      projectSummary(store, `c-${index}`, `Journal fact ${index} is durable.`)));
    expect(writes.every((write) => write.bytesWritten > 0)).toBe(true);
    expect(calls).toEqual([]);
    expect(parseDailyFile(readFileSync(dailyFilePath(root, new Date()), "utf8")).bullets).toHaveLength(65);

    const flushing = store.flush();
    for (let expected = 1; expected <= 3; expected += 1) {
      await waitUntil(() => releases.length >= expected);
      releases[expected - 1]!();
    }
    await flushing;
    expect(calls).toEqual([32, 32, 1]);
    expect(store.queueSnapshot().index).toMatchObject({
      queued: 0,
      inFlight: 0,
      completed: 65,
      remainingBacklog: 0,
      highWaterItems: 65,
      coalesced: 0,
    });
    await store.close();
  });

  it("keeps the final Journal queue snapshot readable after close", async () => {
    const store = createBujoMemoryStore({ root: tmpRoot(), tier: "journal", embeddings: fakeEmbeddings(64), dim: 64 });
    await projectSummary(store, "c", "The final queue snapshot remains observable.");
    await store.flush();
    await store.close();

    expect(store.queueSnapshot()).toMatchObject({
      index: { remainingBacklog: 0, queued: 0, inFlight: 0 },
      shutdown: { timedOut: false },
    });
  });

  // Seed an overflow-sized durable backlog so this test measures Journal queue
  // paging independently of completed-turn admission throughput.
  it("pages overflow recovery without rescanning active queue rows", async () => {
    const root = tmpRoot();
    const calls: number[] = [];
    const embeddings: EmbeddingProvider = {
      id: "paged:64",
      async embed(texts) {
        calls.push(texts.length);
        return texts.map(() => Array.from({ length: 64 }, (_, index) => index === 0 ? 1 : 0));
      },
    };
    const now = new Date();
    for (let index = 0; index < 300; index += 1) {
      appendBullet(root, journalBullet(`overflow-${index}`, `Overflow recovery fact ${index}.`, now), now);
    }
    const store = createBujoMemoryStore({ root, tier: "journal", embeddings, dim: 64 });
    await store.flush();
    expect(calls).toHaveLength(Math.ceil(300 / 32));
    expect(store.queueSnapshot().index).toMatchObject({
      completed: 300,
      dropped: 0,
      coalesced: 0,
      remainingBacklog: 0,
      recoveryRowsScanned: 300,
      highWaterItems: 256,
    });
    await store.close();
  }, 30_000);

  it("canonicalizes whitespace-equivalent legacy bullets to one recallable Journal row", async () => {
    const root = tmpRoot();
    const now = new Date("2026-01-02T09:00:00.000Z");
    appendBullet(root, journalBullet("legacy-a", "Project Atlas ships Friday.", now), now);
    appendBullet(root, journalBullet("legacy-b", "Project   Atlas ships Friday.", now), now);

    const store = createBujoMemoryStore({ root, tier: "journal", embeddings: fakeEmbeddings(64), dim: 64 });
    await store.flush();
    const hits = await store.recall("Project Atlas ships Friday", { topK: 10, trackAccess: false });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.record.id).toBe(`J-${normalizedContentHash("Project Atlas ships Friday.")}`);
    expect(readFileSync(dailyFilePath(root, now), "utf8")).toContain("legacy-a");
    expect(readFileSync(dailyFilePath(root, now), "utf8")).toContain("legacy-b");
    await store.close();
  });

  it("keeps canonical row and hash provenance on the earliest source in either creation order", async () => {
    const hash = normalizedContentHash("Project Atlas ships Friday.");
    const early = new Date("2026-01-01T09:00:00.000Z");
    const late = new Date("2026-01-02T09:00:00.000Z");
    for (const reversed of [false, true]) {
      const root = tmpRoot();
      const entries = [
        { id: "early", text: "Project Atlas ships Friday.", when: early },
        { id: "late", text: "Project   Atlas ships Friday.", when: late },
      ];
      for (const entry of reversed ? [...entries].reverse() : entries) {
        appendBullet(root, journalBullet(entry.id, entry.text, entry.when), entry.when);
      }
      const store = createBujoMemoryStore({ root, tier: "journal", embeddings: fakeEmbeddings(64), dim: 64 });
      await store.flush();
      await store.close();

      const db = openMemoryDb({ path: join(root, "memory.db"), dim: 64 });
      expect(db.get(`J-${hash}`)?.source).toMatchObject({ file: "daily/2026-01-01.md", line: 3 });
      expect(db.contentHashRecord(hash)).toMatchObject({
        memoryId: `J-${hash}`,
        sourceFile: "daily/2026-01-01.md",
        createdAt: early.toISOString(),
      });
      db.close();
    }
  });

  it("does not gate a first Journal write on startup recovery", async () => {
    const root = tmpRoot();
    for (let day = 1; day <= 3; day += 1) {
      const when = new Date(`2026-01-0${day}T09:00:00.000Z`);
      appendBullet(root, journalBullet(`legacy-${day}`, `Legacy fact ${day}.`, when), when);
    }
    const store = createBujoMemoryStore({ root, tier: "journal", embeddings: fakeEmbeddings(64), dim: 64 });

    const write = await projectSummary(store, "new", "A new turn stays off the recovery path.");

    expect(write.bytesWritten).toBeGreaterThan(0);
    expect(store.queueSnapshot().index?.recoveryFilesRemaining).toBeGreaterThan(0);
    await store.flush();
    await store.close();
  });

  it("keeps one recall row when an immediate append races a fresh legacy hash migration", async () => {
    const root = tmpRoot();
    const legacyDay = new Date("2026-01-01T09:00:00.000Z");
    const writeDay = new Date("2026-01-02T09:00:00.000Z");
    appendBullet(root, journalBullet("legacy-atlas", "Project Atlas ships Friday.", legacyDay), legacyDay);
    const store = createBujoMemoryStore({
      root,
      tier: "journal",
      embeddings: fakeEmbeddings(64),
      dim: 64,
      clock: () => writeDay,
    });

    // A fresh old index has no hash manifest yet. Preserve the append-only source
    // rather than waiting on all history; recovery still collapses the index.
    const write = await projectSummary(store, "migration-window", "Project Atlas ships Friday.");
    await store.flush();
    const hits = await store.recall("Project Atlas ships Friday", { topK: 10, trackAccess: false });

    expect(write.bytesWritten).toBeGreaterThan(0);
    expect(hits).toHaveLength(1);
    expect(existsSync(dailyFilePath(root, legacyDay))).toBe(true);
    expect(existsSync(dailyFilePath(root, writeDay))).toBe(true);
    await store.close();
  });

  it("waits through a live cross-process lock for the SQLite writer budget", async () => {
    const root = tmpRoot();
    const store = createBujoMemoryStore({ root, tier: "journal", embeddings: fakeEmbeddings(64), dim: 64 });
    const lockPath = join(root, ".journal-write.lock");
    writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, token: "test-owner" })}\n`, { mode: 0o600 });
    const writing = projectSummary(store, "contended", "The contended write remains durable.");
    let writeSettled = false;
    void writing.then(() => { writeSettled = true; });
    try {
      // An event-loop barrier is enough to prove the first live-lock attempt
      // blocked; no wall-clock lower bound is part of the contract.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(writeSettled).toBe(false);
      unlinkSync(lockPath);
      const write = await writing;
      expect(write.bytesWritten).toBeGreaterThan(0);
    } finally {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    }
    await store.flush();
    await store.close();
  });

  it("deduplicates representation-equivalent Journal content but preserves case-sensitive facts", async () => {
    const root = tmpRoot();
    const store = createBujoMemoryStore({ root, tier: "journal", embeddings: fakeEmbeddings(64), dim: 64 });
    const [first, duplicate] = await Promise.all([
      projectSummary(store, "a", "Token  ABC   is active."),
      projectSummary(store, "b", "Token ABC is active."),
    ]);
    await projectSummary(store, "c", "Token abc is active.");
    await store.flush();
    const bullets = parseDailyFile(readFileSync(dailyFilePath(root, new Date()), "utf8")).bullets;
    // Each provider run retains its own audit bullet; equivalent text converges
    // to one Journal index row without erasing the separate run admissions.
    expect([first.admissionStatus, duplicate.admissionStatus]).toEqual(["admitted", "admitted"]);
    expect(bullets.map((bullet) => bullet.text)).toEqual(["Token ABC is active.", "Token ABC is active.", "Token abc is active."]);
    const db = openMemoryDb({ path: join(root, "memory.db"), readOnly: true });
    try {
      expect(db.allMemories().map(({ text }) => text).sort()).toEqual(["Token ABC is active.", "Token abc is active."]);
    } finally {
      db.close();
    }
    await store.close();
  });

  it("recovers a failed semantic backlog on restart without replaying an LLM", async () => {
    const root = tmpRoot();
    const warnings: string[] = [];
    const failing: EmbeddingProvider = {
      id: "stable:64",
      embed: async () => { throw new Error("embedding offline"); },
    };
    const first = createBujoMemoryStore({
      root, tier: "journal", embeddings: failing, dim: 64, logger: { warn: (message) => warnings.push(message) },
    });
    await projectSummary(first, "c", "The restart backlog fact is durable.");
    await first.flush();
    expect(first.queueSnapshot().index).toMatchObject({
      failed: 1,
      remainingBacklog: 1,
      recoveryPaused: true,
      retryDelayMs: 1_000,
      nextRetryDelayMs: 2_000,
      nextRetryAt: expect.any(String),
    });
    expect(warnings.join(" ")).toContain("embedding offline");
    await first.close();

    const calls: number[] = [];
    const healthy: EmbeddingProvider = {
      id: "stable:64",
      embed: async (texts) => {
        calls.push(texts.length);
        return texts.map(() => Array.from({ length: 64 }, (_, index) => index === 0 ? 1 : 0));
      },
    };
    const second = createBujoMemoryStore({ root, tier: "journal", embeddings: healthy, dim: 64 });
    await second.flush();
    expect(calls).toEqual([1]);
    expect(second.queueSnapshot().index?.remainingBacklog).toBe(0);
    await second.close();
  });

  it("pauses queued Journal batches after the first provider failure", async () => {
    const root = tmpRoot();
    const calls: number[] = [];
    const warnings: string[] = [];
    const failing: EmbeddingProvider = {
      id: "offline-batch:64",
      async embed(texts) {
        calls.push(texts.length);
        throw new Error("batch embedding offline");
      },
    };
    const store = createBujoMemoryStore({
      root,
      tier: "journal",
      embeddings: failing,
      dim: 64,
      logger: { warn: (message) => warnings.push(message) },
    });
    await Promise.all(Array.from({ length: 65 }, (_, index) =>
      projectSummary(store, `offline-${index}`, `Offline batch fact ${index} stays durable.`)));

    await store.flush();

    expect(calls).toEqual([32]);
    expect(warnings.filter((message) => message.includes("batch embedding offline"))).toHaveLength(1);
    expect(store.queueSnapshot().index).toMatchObject({
      failed: 32,
      discarded: 33,
      queued: 0,
      inFlight: 0,
      remainingBacklog: 65,
      recoveryPaused: true,
      retryDelayMs: 1_000,
    });
    await store.close();
  });
});

function journalBullet(id: string, text: string, when: Date): Bullet {
  return {
    id,
    type: "note",
    status: "open",
    text,
    salience: 0.5,
    isInsight: false,
    createdAt: when.toISOString(),
    refs: [],
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}
