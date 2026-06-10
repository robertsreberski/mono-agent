import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createMarkdownMemoryStore, MarkdownMemoryError, safeConversationFileName } from "../index.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-md-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("MarkdownMemoryStore", () => {
  it("returns undefined when optional memory is missing", async () => {
    const dir = await tempDir();
    const store = createMarkdownMemoryStore({ path: join(dir, "memory.md"), maxBytes: 100 });
    await expect(store.load("telegram:1")).resolves.toBeUndefined();
  });

  it("loads memory with capped tail reads", async () => {
    const dir = await tempDir();
    const memoryPath = join(dir, "memory.md");
    await writeFile(memoryPath, "alpha\nbeta\ngamma\ndelta", "utf8");
    const store = createMarkdownMemoryStore({ path: memoryPath, maxBytes: 10 });

    const block = await store.load("telegram:1");

    expect(block).toMatchObject({ kind: "markdown", source: memoryPath, truncated: true });
    expect(block?.content).toContain("truncated to last 10 bytes");
    expect(block?.content).toContain("amma\ndelta");
  });

  it("appends host summaries explicitly without model-driven rewrites", async () => {
    const dir = await tempDir();
    const memoryPath = join(dir, "memory.md");
    const store = createMarkdownMemoryStore({
      path: memoryPath,
      maxBytes: 10_000,
      clock: () => new Date("2026-05-15T18:00:00Z"),
    });

    const result = await store.appendHostSummary("telegram:42", "User prefers concise answers.");

    expect(result.source).toBe(memoryPath);
    const content = await readFile(memoryPath, "utf8");
    expect(content).toContain("## Host Summary — 2026-05-15T18:00:00.000Z");
    expect(content).toContain("Conversation: `telegram:42`");
    expect(content).toContain("User prefers concise answers.");
  });

  it("uses safe per-conversation file names", async () => {
    const dir = await tempDir();
    const store = createMarkdownMemoryStore({ path: dir, maxBytes: 10_000, scope: "per-conversation" });

    const result = await store.appendHostSummary("Telegram:../Danger Chat", "Safe.");

    expect(result.source.startsWith(dir)).toBe(true);
    expect(result.source).toContain("telegram-danger-chat-");
    expect(result.source.endsWith(".memory.md")).toBe(true);
  });

  it("normalizes conversation ids deterministically", () => {
    expect(safeConversationFileName("Telegram:../Danger Chat")).toMatch(/^telegram-danger-chat-[a-f0-9]{10}$/u);
    expect(safeConversationFileName("Telegram:../Danger Chat")).toBe(safeConversationFileName("Telegram:../Danger Chat"));
  });
});

describe("MarkdownMemoryStore fail-closed guards", () => {
  it("rejects an empty path at construction", () => {
    expect(() => createMarkdownMemoryStore({ path: "   ", maxBytes: 100 })).toThrow(
      "Memory path must be a non-empty string.",
    );
    try {
      createMarkdownMemoryStore({ path: "", maxBytes: 100 });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MarkdownMemoryError);
      expect((error as MarkdownMemoryError).code).toBe("invalid_memory_options");
      expect((error as MarkdownMemoryError).details.code).toBe("invalid_memory_options");
    }
  });

  it("rejects maxBytes=0 (must be a positive integer)", () => {
    expect(() => createMarkdownMemoryStore({ path: "/tmp/memory.md", maxBytes: 0 })).toThrow(
      "maxBytes must be a positive integer.",
    );
  });

  it("rejects an unknown scope", () => {
    expect(() =>
      createMarkdownMemoryStore({
        path: "/tmp/memory.md",
        maxBytes: 100,
        // @ts-expect-error intentionally invalid scope literal
        scope: "global",
      }),
    ).toThrow("Memory scope must be single-file or per-conversation.");
  });

  it("rejects a blank conversation id when loading or writing", async () => {
    const dir = await tempDir();
    const store = createMarkdownMemoryStore({ path: join(dir, "memory.md"), maxBytes: 100 });
    await expect(store.load("   ")).rejects.toMatchObject({ code: "invalid_conversation_id" });
    await expect(store.appendHostSummary("", "x")).rejects.toMatchObject({ code: "invalid_conversation_id" });
  });

  it("rejects an empty summary", async () => {
    const dir = await tempDir();
    const store = createMarkdownMemoryStore({ path: join(dir, "memory.md"), maxBytes: 1000 });
    await expect(store.appendHostSummary("telegram:1", "   \n")).rejects.toMatchObject({
      code: "invalid_memory_summary",
    });
  });

  it("fails closed when load() resolves to a directory", async () => {
    const dir = await tempDir();
    const asDir = join(dir, "memory.md");
    await mkdir(asDir, { recursive: true });
    const store = createMarkdownMemoryStore({ path: asDir, maxBytes: 100 });
    await expect(store.load("telegram:1")).rejects.toMatchObject({
      code: "memory_read_failed",
      details: { source: asDir },
    });
  });

  it("surfaces memory_write_failed when the append target cannot be created", async () => {
    const dir = await tempDir();
    // Place a regular file where the store needs a parent directory, so mkdir fails.
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "x", "utf8");
    const store = createMarkdownMemoryStore({ path: join(blocker, "memory.md"), maxBytes: 1000 });
    await expect(store.appendHostSummary("telegram:1", "hello")).rejects.toMatchObject({
      code: "memory_write_failed",
    });
  });
});
