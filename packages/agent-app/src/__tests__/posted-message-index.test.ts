import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
});
