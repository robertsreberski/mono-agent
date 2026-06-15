import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { fakeEmbeddings, fakeLlm } from "./helpers.js";
import { createBujoMemoryStore } from "../store.js";
import { dailyFilePath } from "../daily.js";
import { parseDailyFile } from "../grammar.js";

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
});
