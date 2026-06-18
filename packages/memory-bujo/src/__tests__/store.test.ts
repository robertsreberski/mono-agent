import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { openMemoryDb, type MemoryRecord } from "@mono-agent/memory-store";
import { fakeEmbeddings, fakeLlm } from "./helpers.js";
import { createBujoMemoryStore } from "../store.js";
import { appendBullet, dailyFilePath } from "../daily.js";
import { parseDailyFile } from "../grammar.js";
import type { Bullet } from "../types.js";

describe("BujoMemoryStore — tier derivation", () => {
  it("lite tier: no embeddings → tier() === 'lite'; appendHostSummary + load work; capture() returns undefined", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-tier-lite-"));
    const now = new Date("2026-06-16T09:00:00.000Z");
    // No embeddings — FTS-only store
    const store = createBujoMemoryStore({ root, clock: () => now });

    expect(store.tier()).toBe("lite");

    await store.appendHostSummary("s1", "Robert prefers opt-in memory.");
    const block = await store.load("opt-in");
    // FTS recall: keyword must appear in the block
    expect(block?.content).toContain("opt-in memory");

    expect(await store.capture("s1", "some text")).toBeUndefined();

    await store.close();
  });

  it("journal tier: embeddings + no llm → tier() === 'journal'; load works; decay() returns {decayed}; capture() undefined", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-tier-journal-"));
    const now = new Date("2026-06-16T09:00:00.000Z");
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64, clock: () => now });

    expect(store.tier()).toBe("journal");

    await store.appendHostSummary("s1", "Weekly review complete.");
    const block = await store.load("review");
    expect(block?.content).toContain("Weekly review");

    const decayResult = await store.decay();
    expect(decayResult).toHaveProperty("decayed");
    expect(typeof decayResult.decayed).toBe("number");

    expect(await store.capture("s1", "some text")).toBeUndefined();

    await store.close();
  });

  it("bujo tier: embeddings + llm → tier() === 'bujo'; capture() returns {actions, entities}", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-tier-bujo-"));
    const now = new Date("2026-06-16T09:00:00.000Z");
    const llm = fakeLlm([
      [
        "type:name-kebab",
        JSON.stringify({ entities: [{ id: "person:robert", name: "Robert", type: "person" }], relations: [] }),
      ],
      [
        "TEXT:",
        JSON.stringify([{ type: "note", text: "Robert prefers morning routines", salience: 0.8, isInsight: false }]),
      ],
    ]);
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64, llm, clock: () => now });

    expect(store.tier()).toBe("bujo");

    const result = await store.capture("s1", "Robert prefers morning routines for focus.");
    expect(result).toBeDefined();
    expect(result?.actions).toBeGreaterThanOrEqual(1);

    await store.close();
  });

  it("explicit tier override is respected (overrides derivation)", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-tier-override-"));
    // embeddings provided but explicit tier=lite overrides the derivation
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64, tier: "lite" });

    expect(store.tier()).toBe("lite");

    await store.close();
  });

  it("decay() works in lite tier (no embeddings, no throw)", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-tier-lite-decay-"));
    const store = createBujoMemoryStore({ root });

    expect(store.tier()).toBe("lite");

    await store.appendHostSummary("s1", "Something to decay.");
    const result = await store.decay();
    expect(result).toHaveProperty("decayed");
    expect(typeof result.decayed).toBe("number");

    await store.close();
  });
});

describe("BujoMemoryStore", () => {
  it("appendHostSummary writes a canonical daily bullet and indexes it", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-store-"));
    const now = new Date("2026-06-15T09:00:00.000Z");
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64, clock: () => now });

    const result = await store.appendHostSummary("global", "Robert prefers opt-in memory, never silent fallback.");
    expect(result.bytesWritten).toBeGreaterThan(0);

    const file = readFileSync(dailyFilePath(root, now), "utf8");
    const parsed = parseDailyFile(file);
    expect(parsed.bullets).toHaveLength(1);
    expect(parsed.bullets[0]?.text).toContain("opt-in memory");

    const block = await store.load("global");
    expect(block?.content).toContain("opt-in memory");
    await store.close();
  });

  it("conforms to MemoryStore (load returns undefined-safe markdown block)", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-store-"));
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64 });
    const block = await store.load("global");
    expect(block?.kind).toBe("markdown");
    await store.close();
  });

  it("appends multiple summaries: both indexed, single daily header, bytesWritten counts the bullet line", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-store-"));
    const now = new Date("2026-06-15T09:00:00.000Z");
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64, clock: () => now });

    const summary = "decided to adopt opt-in memory";
    const r1 = await store.appendHostSummary("s1", summary);
    await store.appendHostSummary("s2", "lunch was pizza on tuesday");

    // bytesWritten reflects the serialized bullet line (incl. metadata comment), not the raw summary.
    expect(r1.bytesWritten).toBeGreaterThan(Buffer.byteLength(summary, "utf8"));

    const file = readFileSync(dailyFilePath(root, now), "utf8");
    expect(parseDailyFile(file).bullets).toHaveLength(2);
    expect((file.match(/^# 2026-06-15$/gmu) ?? []).length).toBe(1);

    const block = await store.load("memory decision");
    expect(block?.content).toContain("opt-in memory");
    await store.close();
  });

  it("normalizes a multi-line host summary into one bullet line (does not throw)", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-store-"));
    const now = new Date("2026-06-15T09:00:00.000Z");
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64, clock: () => now });
    const multiline = "User asked about memory.\nAssistant proposed opt-in mode.\nAction: drafted the spec.";
    await expect(store.appendHostSummary("s1", multiline)).resolves.toBeDefined();
    const parsed = parseDailyFile(readFileSync(dailyFilePath(root, now), "utf8"));
    expect(parsed.bullets).toHaveLength(1);
    expect(parsed.bullets[0]?.text).not.toContain("\n");
    expect(parsed.bullets[0]?.text).toContain("opt-in mode");
    await store.close();
  });

  it("capture() with llm: distills+reconciles+extracts; memories are recallable and entity present", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-store-capture-"));
    const now = new Date("2026-06-15T10:00:00.000Z");

    // Entity extraction prompt contains "type:name-kebab" — match BEFORE "TEXT:" to avoid the
    // distill reply being routed to extractEntities (both prompts end with TEXT:\n<input>).
    const llm = fakeLlm([
      [
        "type:name-kebab",
        JSON.stringify({
          entities: [{ id: "person:robert", name: "Robert", type: "person" }],
          relations: [],
        }),
      ],
      [
        "TEXT:",
        JSON.stringify([{ type: "note", text: "Robert prefers opt-in memory", salience: 0.8, isInsight: false }]),
      ],
    ]);

    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64, clock: () => now, llm });

    const result = await store.capture("s1", "Robert prefers opt-in memory, never silent fallback.");
    expect(result).toBeDefined();
    expect(result?.actions).toBeGreaterThanOrEqual(1);
    expect(result?.entities).toBe(1);

    // Captured memory must be recallable via load()
    const block = await store.load("s1");
    expect(block?.content).toContain("opt-in memory");

    await store.close();
  });

  it("capture() without llm returns undefined", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-store-nollm-"));
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64 });
    const result = await store.capture("s1", "some text that would be captured if llm was set");
    expect(result).toBeUndefined();
    await store.close();
  });

  it("reflect() returns undefined when no llm configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-store-reflect-nollm-"));
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64 });
    const result = await store.reflect();
    expect(result).toBeUndefined();
    await store.close();
  });

  it("migrate() returns undefined when no llm configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-store-migrate-nollm-"));
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64 });
    const result = await store.migrate();
    expect(result).toBeUndefined();
    await store.close();
  });

  it("reflect() with llm: returns ReflectResult and writes future-log.md + index.md", async () => {
    const DIM = 64;
    const root = mkdtempSync(join(tmpdir(), "bujo-store-reflect-llm-"));
    const now = new Date("2026-06-15T12:00:00.000Z");

    // Seed 3+ memories directly into the db so reflect() can synthesize an insight
    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(DIM), dim: DIM });
    const sourceFile = relative(root, dailyFilePath(root, now));

    interface SeedSpec { id: string; text: string; salience: number }
    const seedSpecs: SeedSpec[] = [
      { id: "S1", text: "Robert prefers morning focused work", salience: 0.7 },
      { id: "S2", text: "Robert blocks calendar for deep work sessions", salience: 0.65 },
      { id: "S3", text: "Robert avoids meetings before noon", salience: 0.6 },
    ];
    for (const spec of seedSpecs) {
      const bullet: Bullet = {
        id: spec.id,
        type: "note",
        status: "open",
        text: spec.text,
        salience: spec.salience,
        isInsight: false,
        createdAt: now.toISOString(),
        refs: [],
      };
      appendBullet(root, bullet, now);
      const record: MemoryRecord = {
        id: spec.id,
        type: "note",
        status: "open",
        text: spec.text,
        salience: spec.salience,
        isInsight: false,
        createdAt: now.toISOString(),
        accessCount: 0,
        tags: [],
        source: { file: sourceFile },
      };
      await db.upsert(record);
    }
    db.close();

    const insightText = "Robert guards his morning focus hours";
    const llm = fakeLlm([
      ["insight", JSON.stringify([{ text: insightText, sourceIds: ["S1", "S2"] }])],
    ]);

    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(DIM), dim: DIM, clock: () => now, llm });

    const result = await store.reflect();

    expect(result).toBeDefined();
    expect(result?.decayed).toBeGreaterThanOrEqual(0);
    expect(result?.insights).toBe(1);
    expect(result?.due).toBeGreaterThanOrEqual(0);

    // future-log.md written by reflect()
    expect(existsSync(join(root, "future-log.md"))).toBe(true);
    // index.md written by reflect()
    expect(existsSync(join(root, "index.md"))).toBe(true);

    // index.md contains a memory entry
    const indexContent = readFileSync(join(root, "index.md"), "utf8");
    expect(indexContent).toContain("# Index");

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

    expect(result).toBeDefined();
    expect(result?.reviewed).toBeGreaterThanOrEqual(1);
    expect(result?.forgotten).toBe(1);

    // future-log.md written by migrate()
    expect(existsSync(join(root, "future-log.md"))).toBe(true);

    await store.close();
  });
});

// ─── Async capture queue tests ───────────────────────────────────────────────

import type { LlmComplete } from "../llm.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "bujo-queue-"));
}

// A fake LLM that records the order of completion calls and yields empty JSON
// (distill/reconcile/entities all tolerate empty arrays → a no-op capture).
function recordingLlm(order: string[], opts: { throwOnText?: string } = {}): LlmComplete {
  return {
    id: "fake",
    async complete(prompt: string): Promise<string> {
      // Push the full prompt so the caller can detect "FIRST" / "SECOND" / "POISON" / "HEALTHY"
      // (these appear in the TEXT: section at the tail of the distill prompt).
      order.push(prompt);
      if (opts.throwOnText !== undefined && prompt.includes(opts.throwOnText)) {
        throw new Error("boom");
      }
      return "[]"; // empty distillation/entities — safe no-op
    },
  };
}

describe("BujoMemoryStore async capture queue", () => {
  it("scheduleCapture runs captures serially (no interleaving) and flush awaits them", async () => {
    const order: string[] = []; // every LLM call pushes its turn tag (FIRST/SECOND)
    const store = createBujoMemoryStore({ root: tmpRoot(), tier: "bujo", llm: recordingLlm(order) });
    store.scheduleCapture("c1", "FIRST user text");
    store.scheduleCapture("c1", "SECOND user text");
    await store.flush();
    // Serialized ⇒ ALL of FIRST's calls precede ALL of SECOND's (the last FIRST < the first SECOND).
    const firstTags = order.map((t, i) => (t.includes("FIRST") ? i : -1)).filter((i) => i >= 0);
    const secondTags = order.map((t, i) => (t.includes("SECOND") ? i : -1)).filter((i) => i >= 0);
    expect(firstTags.length).toBeGreaterThan(0);
    expect(secondTags.length).toBeGreaterThan(0);
    expect(Math.max(...firstTags)).toBeLessThan(Math.min(...secondTags));
    await store.close();
  });

  it("a throwing capture is swallowed and does not block the next capture", async () => {
    const order: string[] = [];
    const warnings: string[] = [];
    const store = createBujoMemoryStore({
      root: tmpRoot(), tier: "bujo",
      llm: recordingLlm(order),
      logger: { warn: (m) => warnings.push(m) },
    });
    // Patch capture() directly so the POISON turn throws from capture() itself — a simple way to
    // exercise the chain's resilience (one failing capture must not block the next) in isolation.
    // The model-failure path that now reaches this same catch is covered separately by the
    // "scheduleCapture surfaces a REAL model failure through the logger" test.
    const original = store.capture.bind(store);
    store.capture = async (convId: string, text: string) => {
      if (text.includes("POISON")) throw new Error("boom");
      order.push(`capture:${text.includes("HEALTHY") ? "HEALTHY" : text}`);
      return original(convId, text);
    };
    store.scheduleCapture("c1", "POISON text");
    store.scheduleCapture("c1", "HEALTHY text");
    await expect(store.flush()).resolves.toBeUndefined();
    expect(warnings.some((w) => /capture/i.test(w))).toBe(true);
    expect(order.some((t) => t.includes("HEALTHY"))).toBe(true);
    await store.close();
  });

  it("a throw in the logging path does not permanently disable the capture chain", async () => {
    const order: string[] = [];
    const store = createBujoMemoryStore({
      root: tmpRoot(), tier: "bujo",
      llm: recordingLlm(order),
      // The logger itself throws — without the terminal guard this would reject captureChain and
      // silently stop every future capture.
      logger: { warn: () => { throw new Error("logger exploded"); } },
    });
    const original = store.capture.bind(store);
    store.capture = async (convId: string, text: string) => {
      if (text.includes("POISON")) throw new Error("boom"); // reaches the catch → logger.warn throws
      order.push(`capture:HEALTHY`);
      return original(convId, text);
    };
    store.scheduleCapture("c1", "POISON text");
    store.scheduleCapture("c1", "HEALTHY text");
    await expect(store.flush()).resolves.toBeUndefined();
    expect(order.some((t) => t.includes("HEALTHY"))).toBe(true);
    await store.close();
  });

  it("scheduleCapture is a no-op without an llm (lite/journal)", async () => {
    const store = createBujoMemoryStore({ root: tmpRoot() }); // lite
    expect(() => store.scheduleCapture("c1", "x")).not.toThrow();
    await expect(store.flush()).resolves.toBeUndefined();
    await store.close();
  });

  it("scheduleCapture surfaces a REAL model failure through the logger (not silent)", async () => {
    // The whole point of the fix: when the AI model is down, the failure must be visible. Previously
    // the LLM error was swallowed inside distill/entities, so capture looked like a successful no-op
    // and the logger never fired. Now a throwing LLM reaches scheduleCapture's catch and is logged
    // with the underlying cause — so an operator can tell "the model failed" from "nothing to capture".
    const warnings: string[] = [];
    const throwingLlm: LlmComplete = { id: "throws", complete: async () => { throw new Error("ollama down"); } };
    const store = createBujoMemoryStore({
      root: tmpRoot(),
      tier: "bujo",
      llm: throwingLlm,
      logger: { warn: (m) => warnings.push(m) },
    });
    store.scheduleCapture("c1", "a sentence genuinely worth distilling into memory");
    await store.flush();
    expect(warnings.some((w) => /capture/i.test(w))).toBe(true);
    expect(warnings.some((w) => /ollama down/i.test(w))).toBe(true);
    await store.close();
  });

  it("recall delegates to db.recall and returns scored hits", async () => {
    const store = createBujoMemoryStore({ root: tmpRoot() });
    await store.appendHostSummary("c1", "The launch date is March 3rd.");
    const hits = await store.recall("launch date", { topK: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(typeof hits[0]!.score).toBe("number");
    expect(hits[0]!.record.text).toMatch(/launch/i);
    await store.close();
  });

  it("close() drains a pending capture before closing the db", async () => {
    const order: string[] = [];
    const store = createBujoMemoryStore({ root: tmpRoot(), tier: "bujo", llm: recordingLlm(order) });
    store.scheduleCapture("c1", "DRAINME user text");
    await store.close(); // must await the queued capture before closing — no explicit flush()
    expect(order.some((t) => t.includes("DRAINME"))).toBe(true);
  });
});
