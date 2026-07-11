import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { openMemoryDb, type MemoryRecord } from "../../store/index.js";
import { fakeEmbeddings, fakeLlm } from "./helpers.js";
import { createBujoMemoryStore } from "../store.js";
import { appendBullet, dailyFilePath, normalizedContentHash } from "../daily.js";
import { parseDailyFile } from "../grammar.js";
import type { Bullet } from "../types.js";

describe("BujoMemoryStore — tier derivation", () => {
  it("lite tier: no embeddings → tier() === 'lite'; appendHostSummary + load work; capture() returns undefined", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-tier-lite-"));
    const now = new Date("2026-06-16T09:00:00.000Z");
    // No embeddings — FTS-only store
    const store = createBujoMemoryStore({ root, clock: () => now });

    expect(store.tier()).toBe("lite");

    await store.appendHostSummary("s1", "Morgan's memory preference is opt-in.");
    const block = await store.load("What is Morgan's memory preference?");
    // FTS recall: keyword must appear in the block
    expect(block?.content).toContain("memory preference is opt-in");

    expect(await store.capture("s1", "some text")).toBeUndefined();

    await store.close();
  });

  it("journal tier: embeddings + no llm → tier() === 'journal'; load works; decay() returns {decayed}; capture() undefined", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-tier-journal-"));
    const now = new Date("2026-06-16T09:00:00.000Z");
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64, clock: () => now });

    expect(store.tier()).toBe("journal");

    await store.appendHostSummary("s1", "Morgan's weekly review status is complete.");
    const block = await store.load("What is Morgan's weekly review status?");
    expect(block?.content).toContain("weekly review");

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
        JSON.stringify({ entities: [{ id: "person:morgan", name: "Morgan", type: "person" }], relations: [] }),
      ],
      [
        "TEXT:",
        JSON.stringify([{ type: "note", text: "Morgan prefers morning routines", salience: 0.8, isInsight: false }]),
      ],
    ]);
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64, llm, clock: () => now });

    expect(store.tier()).toBe("bujo");

    const result = await store.capture("s1", "Morgan prefers morning routines for focus.");
    expect(result).toBeDefined();
    expect(result?.actions).toBeGreaterThanOrEqual(1);

    await store.close();
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

  it("consolidate() is available without an llm and preserves derived tier semantics", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-tier-consolidate-"));
    let now = new Date("2026-06-01T09:00:00.000Z");
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64, clock: () => now });

    expect(store.tier()).toBe("journal");
    await store.appendHostSummary("s1", "Morgan prefers opt-in memory.");
    now = new Date("2026-06-02T09:00:00.000Z");
    await store.appendHostSummary("s2", "morgan prefers opt in memory");
    now = new Date("2026-07-06T09:00:00.000Z");

    const result = await store.consolidate();

    expect(store.tier()).toBe("journal");
    expect(result.superseded).toBe(1);
    expect(readFileSync(join(root, "future-log.md"), "utf8")).toBe("# Future Log\n");
    const hits = await store.recall("opt-in memory", { topK: 5 });
    expect(hits).toHaveLength(1);

    await store.close();
  });
});

describe("BujoMemoryStore", () => {
  it("appendHostSummary writes a canonical daily bullet and indexes it", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-store-"));
    const now = new Date("2026-06-15T09:00:00.000Z");
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64, clock: () => now });

    const result = await store.appendHostSummary("global", "Morgan's memory preference is opt-in.");
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
    await store.appendHostSummary("s1", "Morgan's memory preference is opt-in.");
    const block = await store.load("What is Morgan's memory preference?");
    expect(block?.kind).toBe("markdown");
    expect(block?.content).toContain("memory preference is opt-in");
    await store.close();
  });

  it("appends multiple summaries: both indexed, single daily header, bytesWritten counts the bullet line", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-store-"));
    const now = new Date("2026-06-15T09:00:00.000Z");
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64, clock: () => now });

    const summary = "Morgan's memory preference is opt-in.";
    const r1 = await store.appendHostSummary("s1", summary);
    await store.appendHostSummary("s2", "lunch was pizza on tuesday");

    // bytesWritten reflects the serialized bullet line (incl. metadata comment), not the raw summary.
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
          entities: [{ id: "person:morgan", name: "Morgan", type: "person" }],
          relations: [],
        }),
      ],
      [
        "TEXT:",
        JSON.stringify([{ type: "note", text: "Morgan's memory preference is opt-in", salience: 0.8, isInsight: false }]),
      ],
    ]);

    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64, clock: () => now, llm });

    const result = await store.capture("s1", "Morgan prefers opt-in memory, never silent fallback.");
    expect(result).toBeDefined();
    expect(result?.actions).toBeGreaterThanOrEqual(1);
    expect(result?.entities).toBe(1);

    // Captured memory must be recallable via load()
    const block = await store.load("s1", "What is Morgan's memory preference?");
    expect(block?.content).toContain("memory preference is opt-in");

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
      { id: "S1", text: "Morgan prefers morning focused work", salience: 0.7 },
      { id: "S2", text: "Morgan blocks calendar for deep work sessions", salience: 0.65 },
      { id: "S3", text: "Morgan avoids meetings before noon", salience: 0.6 },
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

    const insightText = "Morgan guards his morning focus hours";
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

describe("BujoMemoryStore — recall query (load 2nd arg)", () => {
  it("recalls against the query argument, not the conversation id", async () => {
    const store = createBujoMemoryStore({ root: mkdtempSync(join(tmpdir(), "bujo-recall-q-")) });
    await store.appendHostSummary("c1", "The launch date is March 3rd.");
    await store.appendHostSummary("c1", "Team lunch was pizza on Tuesday.");

    // The query drives recall even when the conversation id shares nothing with the memories.
    const block = await store.load("unrelated-conversation-id", "When is the launch date?");
    expect(block?.content).toContain("launch");
    expect(block?.content).not.toContain("pizza");

    await store.close();
  });

  it("skips recall (returns undefined) when the query is empty/whitespace", async () => {
    const store = createBujoMemoryStore({ root: mkdtempSync(join(tmpdir(), "bujo-recall-empty-")) });
    await store.appendHostSummary("c1", "The launch date is March 3rd.");
    expect(await store.load("c1", "   ")).toBeUndefined();
    await store.close();
  });

  it("falls back to the conversation id as a coarse seed when no query is supplied (back-compat)", async () => {
    const store = createBujoMemoryStore({ root: mkdtempSync(join(tmpdir(), "bujo-recall-seed-")) });
    await store.appendHostSummary("c1", "The launch date is March 3rd.");
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
    const store = createBujoMemoryStore({ root: tmpRoot(), tier: "bujo", embeddings: fakeEmbeddings(64), dim: 64, llm: recordingLlm(order) });
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
      root: tmpRoot(), tier: "bujo", embeddings: fakeEmbeddings(64), dim: 64,
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
      root: tmpRoot(), tier: "bujo", embeddings: fakeEmbeddings(64), dim: 64,
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
      embeddings: fakeEmbeddings(64),
      dim: 64,
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
    const store = createBujoMemoryStore({ root: tmpRoot(), tier: "bujo", embeddings: fakeEmbeddings(64), dim: 64, llm: recordingLlm(order) });
    store.scheduleCapture("c1", "DRAINME user text");
    await store.close(); // must await the queued capture before closing — no explicit flush()
    expect(order.some((t) => t.includes("DRAINME"))).toBe(true);
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
      store.appendHostSummary(`c-${index}`, `Journal fact ${index} is durable.`)));
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
    const store = createBujoMemoryStore({ root, tier: "journal", embeddings, dim: 64 });
    await Promise.all(Array.from({ length: 300 }, (_, index) =>
      store.appendHostSummary(`overflow-${index}`, `Overflow recovery fact ${index}.`)));

    await store.flush();
    expect(calls).toHaveLength(Math.ceil(300 / 32));
    expect(store.queueSnapshot().index).toMatchObject({
      completed: 300,
      dropped: 44,
      coalesced: 0,
      remainingBacklog: 0,
      recoveryRowsScanned: 44,
      highWaterItems: 256,
    });
    await store.close();
  });

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

    const write = await store.appendHostSummary("new", "A new turn stays off the recovery path.");

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
    const write = await store.appendHostSummary("migration-window", "Project Atlas ships Friday.");
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
    const release = setTimeout(() => {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    }, 650);
    const started = Date.now();
    try {
      const write = await store.appendHostSummary("contended", "The contended write remains durable.");
      expect(write.bytesWritten).toBeGreaterThan(0);
      expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    } finally {
      clearTimeout(release);
      if (existsSync(lockPath)) unlinkSync(lockPath);
    }
    await store.flush();
    await store.close();
  });

  it("deduplicates representation-equivalent Journal content but preserves case-sensitive facts", async () => {
    const root = tmpRoot();
    const store = createBujoMemoryStore({ root, tier: "journal", embeddings: fakeEmbeddings(64), dim: 64 });
    const [first, duplicate] = await Promise.all([
      store.appendHostSummary("a", "Token  ABC   is active."),
      store.appendHostSummary("b", "Token ABC is active."),
    ]);
    await store.appendHostSummary("c", "Token abc is active.");
    await store.flush();
    const bullets = parseDailyFile(readFileSync(dailyFilePath(root, new Date()), "utf8")).bullets;
    expect([first.bytesWritten, duplicate.bytesWritten].filter((bytes) => bytes > 0)).toHaveLength(1);
    expect(bullets.map((bullet) => bullet.text)).toEqual(["Token ABC is active.", "Token abc is active."]);
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
    await first.appendHostSummary("c", "The restart backlog fact is durable.");
    await first.flush();
    expect(first.queueSnapshot().index).toMatchObject({
      failed: 1,
      remainingBacklog: 1,
      recoveryPaused: true,
      retryDelayMs: 1_000,
      nextRetryDelayMs: 2_000,
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

  it("keeps BuJo compact raw audit outside curated daily recall on capture failure", async () => {
    const root = tmpRoot();
    const warnings: string[] = [];
    const llm: LlmComplete = { id: "down", complete: async () => { throw new Error("capture offline"); } };
    const store = createBujoMemoryStore({
      root,
      tier: "bujo",
      embeddings: fakeEmbeddings(64),
      dim: 64,
      llm,
      logger: { warn: (message) => warnings.push(message) },
    });
    const write = await store.appendHostSummary("c", "Host-observed completed turn. User: hello. Assistant: hi.");
    store.scheduleCapture("c", "User: hello\nAssistant: hi");
    await store.flush();
    expect(write.source).toContain("/audit/");
    expect(readFileSync(write.source, "utf8")).toContain("Host-observed completed turn");
    expect(existsSync(join(root, "daily"))).toBe(false);
    expect(warnings.join(" ")).toContain("capture offline");
    await store.close();
  });

  it("bounds BuJo capture overflow while preserving every compact raw audit entry", async () => {
    const root = tmpRoot();
    const llm = recordingLlm([]);
    const store = createBujoMemoryStore({
      root, tier: "bujo", embeddings: fakeEmbeddings(64), dim: 64, llm,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    store.capture = async () => {
      calls += 1;
      if (calls === 1) await gate;
      return { actions: 0, entities: 0 };
    };

    for (let index = 0; index < 33; index += 1) {
      await store.appendHostSummary(`c-${index}`, `Host-observed completed turn ${index}.`);
      store.scheduleCapture(`c-${index}`, `User: turn ${index}\nAssistant: done ${index}`);
    }
    expect(store.queueSnapshot().capture).toMatchObject({ queued: 32, dropped: 1, highWaterItems: 32 });
    const audit = readFileSync(join(root, "audit", `${new Date().toISOString().slice(0, 10)}.md`), "utf8");
    expect(parseDailyFile(audit).bullets).toHaveLength(33);

    const flushing = store.flush();
    await waitUntil(() => calls === 1);
    release();
    await flushing;
    expect(store.queueSnapshot().capture).toMatchObject({ queued: 0, inFlight: 0, completed: 32, dropped: 1 });
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
