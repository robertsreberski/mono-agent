import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendPostedMessage,
  compactPostedMessageIndex,
  lookupProducingConversation,
  resolvePostedMessageIndexPath,
} from "../posted-message-index.js";

let dir: string;
let indexPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-post-index-"));
  indexPath = resolvePostedMessageIndexPath(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const at = (iso: string) => () => new Date(iso);
const DEFAULT_COMPACT_MAX_ENTRIES = 5000;

function deterministicEntries(count: number): string {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  return `${Array.from({ length: count }, (_, index) =>
    JSON.stringify({
      channelId: `C${String(index)}`,
      ts: `${String(index)}.0`,
      conversationId: `conv-${String(index)}`,
      writtenAt: new Date(start + index).toISOString(),
    }),
  ).join("\n")}\n`;
}

function nonEmptyLineCount(raw: string): number {
  return raw.split("\n").filter((line) => line.trim().length > 0).length;
}

describe("posted-message-index", () => {
  it("round-trips a (channel, ts) → producing conversationId", async () => {
    await appendPostedMessage(indexPath, {
      channelId: "C100",
      ts: "170.000100",
      conversationId: "scheduled-scan",
    });

    expect(await lookupProducingConversation(indexPath, "C100", "170.000100")).toBe("scheduled-scan");
    expect(await lookupProducingConversation(indexPath, "C100", "999.000000")).toBeUndefined();
    expect(await lookupProducingConversation(indexPath, "C200", "170.000100")).toBeUndefined();
  });

  it("stores the de-bucketed base producing id", async () => {
    await appendPostedMessage(indexPath, {
      channelId: "C1",
      ts: "100.1",
      conversationId: "scheduled-scan#2026-06-22",
    });

    expect(await lookupProducingConversation(indexPath, "C1", "100.1")).toBe("scheduled-scan");
  });

  it("newest write wins for the same (channel, ts)", async () => {
    await appendPostedMessage(indexPath, { channelId: "C1", ts: "1.1", conversationId: "conv-old" }, at("2026-06-22T10:00:00Z"));
    await appendPostedMessage(indexPath, { channelId: "C1", ts: "1.1", conversationId: "conv-new" }, at("2026-06-22T11:00:00Z"));

    expect(await lookupProducingConversation(indexPath, "C1", "1.1")).toBe("conv-new");
  });

  it("returns undefined when the file is missing", async () => {
    expect(await lookupProducingConversation(indexPath, "C1", "1.1")).toBeUndefined();
  });

  it("skips malformed lines but still returns valid ones", async () => {
    await writeFile(
      indexPath,
      [
        "not json at all",
        JSON.stringify({ channelId: "C1", ts: "1.1", conversationId: "conv-a", writtenAt: "2026-06-22T10:00:00Z" }),
        "{ partial",
        "",
      ].join("\n"),
    );

    expect(await lookupProducingConversation(indexPath, "C1", "1.1")).toBe("conv-a");
  });

  it("creates the artifact dir on first append when it does not exist yet", async () => {
    const nested = resolvePostedMessageIndexPath(join(dir, "not", "made", "yet"));
    await appendPostedMessage(nested, { channelId: "C1", ts: "1.1", conversationId: "conv-a" });

    expect(await lookupProducingConversation(nested, "C1", "1.1")).toBe("conv-a");
  });

  it("two interleaved writers are both readable", async () => {
    await Promise.all([
      appendPostedMessage(indexPath, { channelId: "C1", ts: "1.1", conversationId: "conv-a" }),
      appendPostedMessage(indexPath, { channelId: "C2", ts: "2.2", conversationId: "conv-b" }),
    ]);

    expect(await lookupProducingConversation(indexPath, "C1", "1.1")).toBe("conv-a");
    expect(await lookupProducingConversation(indexPath, "C2", "2.2")).toBe("conv-b");
  });

  it("waits for the same OS lock when another process owns the index", async () => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          'import { DatabaseSync } from "node:sqlite";',
          "const database = new DatabaseSync(process.argv[1]);",
          'database.exec("BEGIN IMMEDIATE");',
          'process.stdout.write("locked\\n");',
          "setTimeout(() => { database.exec(\"ROLLBACK\"); database.close(); }, 180);",
        ].join("\n"),
        `${indexPath}.lock.sqlite`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const exit = once(child, "exit");
    const [ready] = await once(child.stdout!, "data");
    expect(String(ready)).toContain("locked");

    const startedAt = Date.now();
    await appendPostedMessage(indexPath, {
      channelId: "C-process",
      ts: "process.1",
      conversationId: "conv-process",
    });
    const elapsedMs = Date.now() - startedAt;
    const [exitCode] = await exit;

    expect(exitCode).toBe(0);
    expect(elapsedMs).toBeGreaterThanOrEqual(75);
    expect(await lookupProducingConversation(indexPath, "C-process", "process.1")).toBe("conv-process");
  });

  it("compaction keeps the newest entries, de-dupes, and stays parseable", async () => {
    for (let i = 0; i < 10; i++) {
      const minute = String(i).padStart(2, "0");
      await appendPostedMessage(
        indexPath,
        { channelId: "C1", ts: `${String(i)}.0`, conversationId: `conv-${String(i)}` },
        at(`2026-06-22T10:${minute}:00Z`),
      );
    }
    // A newer re-sighting of an older ts must survive de-dup.
    await appendPostedMessage(indexPath, { channelId: "C1", ts: "0.0", conversationId: "conv-0-new" }, at("2026-06-22T12:00:00Z"));

    await compactPostedMessageIndex(indexPath, 3);

    const lines = (await readFile(indexPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    // Newest three by write time: the re-sighting (12:00), then 10:09, then 10:08.
    expect(await lookupProducingConversation(indexPath, "C1", "0.0")).toBe("conv-0-new");
    expect(await lookupProducingConversation(indexPath, "C1", "9.0")).toBe("conv-9");
    expect(await lookupProducingConversation(indexPath, "C1", "8.0")).toBe("conv-8");
    // Trimmed out.
    expect(await lookupProducingConversation(indexPath, "C1", "5.0")).toBeUndefined();
  });

  it("compaction is a no-op below the cap", async () => {
    await appendPostedMessage(indexPath, { channelId: "C1", ts: "1.1", conversationId: "conv-a" });
    await compactPostedMessageIndex(indexPath, 100);
    expect(await lookupProducingConversation(indexPath, "C1", "1.1")).toBe("conv-a");
  });

  it("enforces the default cap in the production append path after reopening a full index", async () => {
    await writeFile(indexPath, deterministicEntries(DEFAULT_COMPACT_MAX_ENTRIES), "utf8");

    await appendPostedMessage(
      indexPath,
      { channelId: "C-reopen", ts: "reopen.1", conversationId: "conv-reopen" },
      at("2027-01-01T00:00:00.000Z"),
    );

    const count = nonEmptyLineCount(await readFile(indexPath, "utf8"));
    expect(count).toBeLessThanOrEqual(DEFAULT_COMPACT_MAX_ENTRIES);
    expect(count).toBeLessThan(DEFAULT_COMPACT_MAX_ENTRIES);
    expect(await lookupProducingConversation(indexPath, "C-reopen", "reopen.1")).toBe("conv-reopen");
    expect(await lookupProducingConversation(indexPath, "C0", "0.0")).toBeUndefined();
  });

  it("stays bounded across many completed writes and multiple amortized compactions", async () => {
    const cap = 50;
    const observedCounts: number[] = [];
    for (let index = 0; index < 120; index++) {
      await appendPostedMessage(
        indexPath,
        {
          channelId: `C-long-${String(index)}`,
          ts: `long.${String(index)}`,
          conversationId: `conv-long-${String(index)}`,
        },
        at(new Date(Date.parse("2027-02-01T00:00:00.000Z") + index).toISOString()),
        cap,
      );
      const count = nonEmptyLineCount(await readFile(indexPath, "utf8"));
      observedCounts.push(count);
      expect(count).toBeLessThanOrEqual(cap);
    }

    const compactionCount = observedCounts.filter(
      (count, index) => index > 0 && count < (observedCounts[index - 1] ?? 0),
    ).length;
    expect(compactionCount).toBeGreaterThan(1);
    expect(await lookupProducingConversation(indexPath, "C-long-119", "long.119")).toBe("conv-long-119");
    expect(await lookupProducingConversation(indexPath, "C-long-0", "long.0")).toBeUndefined();
  });

  it("serializes an append behind compaction so atomic replacement cannot lose it", async () => {
    await writeFile(indexPath, deterministicEntries(10), "utf8");
    let releaseReplace!: () => void;
    const replaceGate = new Promise<void>((resolve) => {
      releaseReplace = resolve;
    });
    let reachedReplace!: () => void;
    const replaceReached = new Promise<void>((resolve) => {
      reachedReplace = resolve;
    });
    const compaction = compactPostedMessageIndex(indexPath, 3, {
      beforeReplace: async () => {
        reachedReplace();
        await replaceGate;
      },
    });
    await replaceReached;

    let appendSettled = false;
    const append = appendPostedMessage(
      indexPath,
      { channelId: "C-race", ts: "race.1", conversationId: "conv-race" },
      at("2027-03-01T00:00:00.000Z"),
      3,
    ).finally(() => {
      appendSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const settledWhileReplacePaused = appendSettled;
    releaseReplace();
    await Promise.all([compaction, append]);

    expect(settledWhileReplacePaused).toBe(false);
    expect(nonEmptyLineCount(await readFile(indexPath, "utf8"))).toBeLessThanOrEqual(3);
    expect(await lookupProducingConversation(indexPath, "C-race", "race.1")).toBe("conv-race");
  });

  it("preserves the original index when compaction fails", async () => {
    const original = deterministicEntries(DEFAULT_COMPACT_MAX_ENTRIES + 1);
    await writeFile(indexPath, original, "utf8");
    // The compactor's deterministic temp path cannot be opened as a file, forcing
    // its best-effort failure path without permissions or timing dependencies.
    await mkdir(`${indexPath}.tmp-${String(DEFAULT_COMPACT_MAX_ENTRIES)}`);

    await compactPostedMessageIndex(indexPath);

    expect(await readFile(indexPath, "utf8")).toBe(original);
  });

  it("does not append past the cap when amortized compaction fails", async () => {
    const original = deterministicEntries(DEFAULT_COMPACT_MAX_ENTRIES);
    await writeFile(indexPath, original, "utf8");
    const amortizedRetainCount = 4500;
    await mkdir(`${indexPath}.tmp-${String(amortizedRetainCount)}`);

    await appendPostedMessage(
      indexPath,
      { channelId: "C-failed", ts: "failed.1", conversationId: "conv-failed" },
      at("2027-04-01T00:00:00.000Z"),
    );

    expect(await readFile(indexPath, "utf8")).toBe(original);
    expect(nonEmptyLineCount(await readFile(indexPath, "utf8"))).toBe(DEFAULT_COMPACT_MAX_ENTRIES);
    expect(await lookupProducingConversation(indexPath, "C-failed", "failed.1")).toBeUndefined();
  });
});
