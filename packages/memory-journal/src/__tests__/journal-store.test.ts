import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createJournalMemoryStore, journalDayFor } from "../index.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-journal-test-"));
  tempDirs.push(dir);
  return dir;
}

const FIXED = new Date("2026-06-09T15:30:00.000Z");
const fixedClock = () => FIXED;
const FIXED_DAY = journalDayFor(FIXED);

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("JournalMemoryStore", () => {
  it("returns undefined when today's note does not exist yet", async () => {
    const root = await tempDir();
    const store = createJournalMemoryStore({ rootDir: root, maxBytes: 64_000, clock: fixedClock });

    expect(await store.load("slack:c1")).toBeUndefined();
  });

  it("loads today's note from the daily directory", async () => {
    const root = await tempDir();
    await mkdir(join(root, "daily"), { recursive: true });
    await writeFile(join(root, "daily", `${FIXED_DAY}.md`), "# Journal\n\nremembered fact", "utf8");
    const store = createJournalMemoryStore({ rootDir: root, maxBytes: 64_000, clock: fixedClock });

    const block = await store.load("slack:c1");

    expect(block).toMatchObject({ kind: "markdown", truncated: false });
    expect(block?.source).toBe(store.dailyPathFor(FIXED_DAY));
    expect(block?.content).toContain("remembered fact");
  });

  it("appends a host turn summary to today's note and reads it back", async () => {
    const root = await tempDir();
    const store = createJournalMemoryStore({ rootDir: root, maxBytes: 64_000, clock: fixedClock });

    const result = await store.appendHostSummary("slack:c1", "User asked X. Assistant answered Y.");

    expect(result).toMatchObject({ conversationId: "slack:c1", source: store.dailyPathFor(FIXED_DAY) });
    expect(result.bytesWritten).toBeGreaterThan(0);

    const block = await store.load("slack:c1");
    expect(block?.content).toContain("Conversation: `slack:c1`");
    expect(block?.content).toContain("User asked X. Assistant answered Y.");
    expect(block?.content).toContain(FIXED.toISOString());
  });

  it("appends free-form agent notes via appendEntry", async () => {
    const root = await tempDir();
    const store = createJournalMemoryStore({ rootDir: root, maxBytes: 64_000, clock: fixedClock });

    await store.appendEntry("Robert prefers concise answers.");

    const raw = await readFile(store.dailyPathFor(FIXED_DAY), "utf8");
    expect(raw).toContain("## Note —");
    expect(raw).toContain("Robert prefers concise answers.");
  });

  it("tail-caps today's note at maxBytes", async () => {
    const root = await tempDir();
    await mkdir(join(root, "daily"), { recursive: true });
    await writeFile(join(root, "daily", `${FIXED_DAY}.md`), "alpha\nbeta\ngamma\ndelta", "utf8");
    const store = createJournalMemoryStore({ rootDir: root, maxBytes: 10, clock: fixedClock });

    const block = await store.load("slack:c1");

    expect(block?.truncated).toBe(true);
    expect(block?.content).toContain("journal truncated to last 10 bytes");
  });

  it("prepends the entity digest when a provider is supplied", async () => {
    const root = await tempDir();
    const store = createJournalMemoryStore({
      rootDir: root,
      maxBytes: 64_000,
      clock: fixedClock,
      entityDigest: async (day) => `Salient entities for ${day}: Robert (person).`,
    });

    await store.appendEntry("today's work");
    const block = await store.load("slack:c1");

    expect(block?.content).toContain("### Long-term memory (entity digest)");
    expect(block?.content).toContain(`Salient entities for ${FIXED_DAY}`);
    // digest precedes the day's note content
    expect(block?.content.indexOf("entity digest")).toBeLessThan(block?.content.indexOf("today's work") ?? -1);
  });

  it("returns a digest-only block when there is no note yet", async () => {
    const root = await tempDir();
    const store = createJournalMemoryStore({
      rootDir: root,
      maxBytes: 64_000,
      clock: fixedClock,
      entityDigest: async () => "Robert (person), mono-agent (project).",
    });

    const block = await store.load("slack:c1");
    expect(block?.content).toContain("Robert (person)");
  });

  it("buckets notes by host-local day", async () => {
    const root = await tempDir();
    const dayOne = new Date("2026-06-09T12:00:00.000Z");
    const dayTwo = new Date("2026-06-10T12:00:00.000Z");

    const storeOne = createJournalMemoryStore({ rootDir: root, maxBytes: 64_000, clock: () => dayOne });
    await storeOne.appendEntry("note for day one");

    const storeTwo = createJournalMemoryStore({ rootDir: root, maxBytes: 64_000, clock: () => dayTwo });
    expect(await storeTwo.load("slack:c1")).toBeUndefined();

    const dayOneRaw = await readFile(storeOne.dailyPathFor(journalDayFor(dayOne)), "utf8");
    expect(dayOneRaw).toContain("note for day one");
  });

  it("rejects empty entries and invalid options", async () => {
    const root = await tempDir();
    const store = createJournalMemoryStore({ rootDir: root, maxBytes: 64_000, clock: fixedClock });

    await expect(store.appendEntry("   ")).rejects.toThrow(/must not be empty/u);
    expect(() => createJournalMemoryStore({ rootDir: "", maxBytes: 1 })).toThrow(/non-empty/u);
    expect(() => createJournalMemoryStore({ rootDir: root, maxBytes: 0 })).toThrow(/positive integer/u);
  });
});
