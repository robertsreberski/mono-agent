import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listSeenNotifyDestinations } from "../seen-conversations.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-seen-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function summary(name: string, conversationId: string, updatedAt: string): Promise<void> {
  await writeFile(join(dir, `${name}.summary.json`), JSON.stringify({ runId: name, conversationId, status: "succeeded", updatedAt }));
}

describe("listSeenNotifyDestinations", () => {
  it("returns deduped, de-bucketed push-channel ids sorted by last seen (newest first)", async () => {
    await summary("run-a", "telegram:42#2026-06-18", "2026-06-18T10:00:00Z");
    await summary("run-b", "telegram:42#2026-06-19", "2026-06-19T07:00:00Z"); // same base, newer
    await summary("run-c", "slack:C1:171.5#2026-06-19", "2026-06-19T09:00:00Z"); // thread segment preserved
    await summary("run-d", "cron:morning-brief", "2026-06-19T07:00:01Z"); // synthetic → filtered out
    await summary("run-e", "webhook:req-1", "2026-06-19T08:00:00Z"); // synthetic → filtered out
    await summary("run-f", "telegram:-1001234567890", "2026-06-17T00:00:00Z");

    const result = await listSeenNotifyDestinations(dir);

    expect(result).toEqual([
      { conversationId: "slack:C1:171.5", channelId: "slack", lastSeen: "2026-06-19T09:00:00Z" },
      { conversationId: "telegram:42", channelId: "telegram", lastSeen: "2026-06-19T07:00:00Z" },
      { conversationId: "telegram:-1001234567890", channelId: "telegram", lastSeen: "2026-06-17T00:00:00Z" },
    ]);
  });

  it("returns an empty list when the artifacts dir does not exist", async () => {
    expect(await listSeenNotifyDestinations(join(dir, "does-not-exist"))).toEqual([]);
  });
});
