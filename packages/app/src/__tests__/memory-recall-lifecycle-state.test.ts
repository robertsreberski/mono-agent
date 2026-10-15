import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MARKER_FOR } from "@mono-agent/memory/bujo";
import { openMemoryDb } from "@mono-agent/memory/store";
import type { MemoryRecord } from "@mono-agent/memory/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMemoryRecallServer } from "../memory-recall.js";
import type { MemoryRecallHit, RecallCapableStore } from "../memory-recall.js";

/**
 * `composeRecallBlock` renders every automatic hit with a marker encoding type
 * AND status, because "recall surfaces done/scheduled/migrated records, so a
 * type-only marker would misrepresent their state" (memory/src/bujo/recall.ts).
 *
 * The explicit `MemoryRecall` tool is the surface the model actually queries.
 * These tests pin that it carries the same lifecycle state.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-app-recall-state-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface ToolResult {
  readonly content: Array<{ type: string; text: string }>;
  readonly structuredContent?: {
    readonly hits: Array<{ id: string; score: number; text: string; type?: string; status?: string }>;
    readonly degraded?: boolean;
  };
}

async function callRecall(store: RecallCapableStore, query = "release"): Promise<ToolResult> {
  const server = createMemoryRecallServer(store);
  const client = new Client({ name: "recall-state-test", version: "0.1.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return (await client.callTool({ name: "MemoryRecall", arguments: { query } })) as unknown as ToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

function stubStore(hits: readonly MemoryRecallHit[], degraded = false): RecallCapableStore {
  return {
    async recall() {
      return hits;
    },
    ...(degraded
      ? {
          async recallWithOutcome() {
            return {
              hits,
              retrievalMode: "lexical_only" as const,
              degradation: { code: "embedding_unavailable" as const },
            };
          },
        }
      : {}),
    async close() {},
  };
}

const LIFECYCLE_HITS: readonly MemoryRecallHit[] = [
  { score: 0.9, record: { id: "m-open", text: "Release notes live in CHANGELOG.md.", type: "note", status: "open" } },
  { score: 0.8, record: { id: "m-done", text: "Ship the 0.9 release.", type: "task", status: "done" } },
  { score: 0.7, record: { id: "m-sched", text: "Cut the 1.0 release.", type: "task", status: "scheduled" } },
  { score: 0.6, record: { id: "m-migrated", text: "Plan the release retro.", type: "task", status: "migrated" } },
];

describe("MemoryRecall carries lifecycle state to the model", () => {
  it("annotates non-open records in the model-visible text and structured hits", async () => {
    const result = await callRecall(stubStore(LIFECYCLE_HITS));
    const text = result.content[0]?.text ?? "";

    // A completed/scheduled/migrated record must not read as a current fact.
    expect(text).toContain("[done]");
    expect(text).toContain("[scheduled]");
    expect(text).toContain("[migrated]");
    // An ordinary open record stays unannotated: no token cost in the common case.
    expect(text).not.toContain("[open]");

    expect(result.structuredContent?.hits).toEqual([
      { id: "m-open", score: 0.9, text: LIFECYCLE_HITS[0]!.record.text, type: "note", status: "open" },
      { id: "m-done", score: 0.8, text: LIFECYCLE_HITS[1]!.record.text, type: "task", status: "done" },
      { id: "m-sched", score: 0.7, text: LIFECYCLE_HITS[2]!.record.text, type: "task", status: "scheduled" },
      { id: "m-migrated", score: 0.6, text: LIFECYCLE_HITS[3]!.record.text, type: "task", status: "migrated" },
    ]);
  });

  it("pins the exact rendered bytes so token growth stays measurable", async () => {
    const result = await callRecall(stubStore(LIFECYCLE_HITS));
    expect(result.content[0]?.text).toBe(
      [
        "0.900  Release notes live in CHANGELOG.md.",
        "0.800  [done] Ship the 0.9 release.",
        "0.700  [scheduled] Cut the 1.0 release.",
        "0.600  [migrated] Plan the release retro.",
      ].join("\n"),
    );
  });

  it("makes the same open/done distinction the automatic marker renderer makes", async () => {
    // The automatic block renders `MARKER_FOR(type, status)`, which encodes
    // status: an open task and a done task are visibly different there.
    expect(MARKER_FOR("task", "open")).toBe("[ ]");
    expect(MARKER_FOR("task", "done")).toBe("[x]");
    expect(MARKER_FOR("task", "done")).not.toBe(MARKER_FOR("task", "open"));

    // The explicit tool must draw that same distinction, in its own concise form.
    const explicit = (await callRecall(stubStore(LIFECYCLE_HITS))).content[0]?.text ?? "";
    expect(explicit).toMatch(/\[done\] Ship the 0\.9 release\./u);
    expect(explicit).toMatch(/0\.900 {2}Release notes live in CHANGELOG\.md\./u);
  });

  it("omits unknown lifecycle fields for a backend that does not supply them", async () => {
    // Remote/external recall backends legitimately return id/score/text only;
    // `type`/`status` are optional on MemoryRecallHit.
    const remote = stubStore([{ score: 0.5, record: { id: "r-1", text: "A remote memory." } }]);
    const result = await callRecall(remote);

    expect(result.content[0]?.text).toBe("0.500  A remote memory.");
    expect(result.structuredContent?.hits).toEqual([{ id: "r-1", score: 0.5, text: "A remote memory." }]);
    expect(result.structuredContent?.hits[0]).not.toHaveProperty("status");
    expect(result.structuredContent?.hits[0]).not.toHaveProperty("type");
  });

  it("still annotates state on the degraded lexical-only path", async () => {
    const result = await callRecall(stubStore(LIFECYCLE_HITS.slice(1, 2), true));
    expect(result.structuredContent?.degraded).toBe(true);
    expect(result.content[0]?.text).toContain("Memory recall is degraded");
    expect(result.content[0]?.text).toContain("[done] Ship the 0.9 release.");
    expect(result.structuredContent?.hits[0]).toMatchObject({ id: "m-done", status: "done", type: "task" });
  });

  it("reports state from a real store and still excludes invalidated/dropped records", async () => {
    const db = openMemoryDb({ path: join(dir, "memory.db") });
    const base = {
      salience: 0.5,
      isInsight: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      accessCount: 0,
      tags: [] as string[],
      source: {},
    };
    const records: MemoryRecord[] = [
      { ...base, id: "live-open", type: "note", status: "open", text: "The release train departs on Thursday." },
      { ...base, id: "live-done", type: "task", status: "done", text: "Publish the release announcement." },
      { ...base, id: "gone-dropped", type: "task", status: "dropped", text: "Cancel the release party." },
      { ...base, id: "gone-invalid", type: "note", status: "invalidated", text: "The release train departs on Tuesday." },
    ];
    await db.upsertMany(records);

    const store: RecallCapableStore = {
      recall: async (query, options) => await db.recall(query, options),
      async close() {
        db.close();
      },
    };
    try {
      const result = await callRecall(store, "release");
      const ids = (result.structuredContent?.hits ?? []).map((hit) => hit.id);

      expect(ids).toContain("live-open");
      expect(ids).toContain("live-done");
      // Unchanged retrieval: terminal records are filtered by the store, not by this rendering.
      expect(ids).not.toContain("gone-dropped");
      expect(ids).not.toContain("gone-invalid");

      const text = result.content[0]?.text ?? "";
      expect(text).toContain("[done] Publish the release announcement.");
      expect(text).toContain("The release train departs on Thursday.");
      expect(text).not.toContain("[open]");
    } finally {
      db.close();
    }
  });
});
