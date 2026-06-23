import { describe, expect, it } from "vitest";

import type { SupermemoryAddParams, SupermemoryClient, SupermemoryHit, SupermemorySearchParams } from "../client.js";
import { SupermemoryMemoryStore } from "../store.js";

class FakeClient implements SupermemoryClient {
  readonly added: SupermemoryAddParams[] = [];
  readonly searches: SupermemorySearchParams[] = [];
  hits: SupermemoryHit[] = [];
  failAdd = false;
  failSearch = false;

  async add(params: SupermemoryAddParams): Promise<void> {
    this.added.push(params);
    if (this.failAdd) {
      throw new Error("boom-add");
    }
  }

  async search(params: SupermemorySearchParams): Promise<SupermemoryHit[]> {
    this.searches.push(params);
    if (this.failSearch) {
      throw new Error("boom-search");
    }
    return this.hits;
  }
}

function makeStore(client: SupermemoryClient, maxBytes?: number) {
  const warnings: string[] = [];
  const store = new SupermemoryMemoryStore(client, {
    logger: { warn: (m) => warnings.push(m) },
    ...(maxBytes === undefined ? {} : { maxBytes }),
  });
  return { store, warnings };
}

describe("SupermemoryMemoryStore.load", () => {
  it("formats search hits into a markdown block scoped by query", async () => {
    const client = new FakeClient();
    client.hits = [
      { id: "a", text: "user prefers dark mode", score: 0.91 },
      { id: "b", text: "ships on Fridays", score: 0.42 },
    ];
    const { store } = makeStore(client);

    const block = await store.load("conv-1", "preferences");

    expect(block?.kind).toBe("markdown");
    expect(block?.source).toBe("supermemory");
    expect(block?.truncated).toBe(false);
    expect(block?.content).toContain("user prefers dark mode");
    expect(block?.content).toContain("(0.910)");
    expect(client.searches[0]?.query).toBe("preferences");
  });

  it("falls back to the conversation id when no query is given", async () => {
    const client = new FakeClient();
    client.hits = [{ id: "a", text: "x", score: 1 }];
    const { store } = makeStore(client);

    await store.load("conv-7");

    expect(client.searches[0]?.query).toBe("conv-7");
  });

  it("returns undefined when there are no hits", async () => {
    const client = new FakeClient();
    client.hits = [];
    const { store } = makeStore(client);

    expect(await store.load("c", "q")).toBeUndefined();
  });

  it("degrades to undefined (never throws) when search fails", async () => {
    const client = new FakeClient();
    client.failSearch = true;
    const { store, warnings } = makeStore(client);

    expect(await store.load("c", "q")).toBeUndefined();
    expect(warnings.some((w) => w.includes("recall failed"))).toBe(true);
  });

  it("truncates the block to maxBytes", async () => {
    const client = new FakeClient();
    client.hits = Array.from({ length: 50 }, (_v, i) => ({ id: `h${i}`, text: "x".repeat(200), score: 0.5 }));
    const { store } = makeStore(client, 256);

    const block = await store.load("c", "q");

    expect(block?.truncated).toBe(true);
    expect(Buffer.byteLength(block?.content ?? "", "utf8")).toBeLessThanOrEqual(256);
  });
});

describe("SupermemoryMemoryStore.appendHostSummary", () => {
  it("adds a one-line document with an idempotent customId and returns bytesWritten", async () => {
    const client = new FakeClient();
    const { store } = makeStore(client);

    const result = await store.appendHostSummary("conv-1", "remembered a fact");

    expect(result).toEqual({ conversationId: "conv-1", source: "supermemory", bytesWritten: 17 });
    const added = client.added[0];
    expect(added?.content).toBe("remembered a fact");
    expect(added?.customId).toMatch(/^host-summary:/u);
    expect(added?.metadata).toMatchObject({ kind: "host-summary", conversationId: "conv-1" });
  });

  it("derives a stable customId for identical content", async () => {
    const client = new FakeClient();
    const { store } = makeStore(client);

    await store.appendHostSummary("conv-1", "same");
    await store.appendHostSummary("conv-1", "same");

    expect(client.added[0]?.customId).toBe(client.added[1]?.customId);
  });

  it("returns bytesWritten 0 and never throws when the add fails", async () => {
    const client = new FakeClient();
    client.failAdd = true;
    const { store, warnings } = makeStore(client);

    const result = await store.appendHostSummary("conv-1", "x");

    expect(result.bytesWritten).toBe(0);
    expect(warnings.some((w) => w.includes("appendHostSummary failed"))).toBe(true);
  });
});

describe("SupermemoryMemoryStore.scheduleCapture", () => {
  it("posts the full turn as a capture and drains via flush", async () => {
    const client = new FakeClient();
    const { store } = makeStore(client);

    store.scheduleCapture("conv-1", "the whole turn text");
    await store.flush();

    expect(client.added).toHaveLength(1);
    expect(client.added[0]?.content).toBe("the whole turn text");
    expect(client.added[0]?.metadata).toMatchObject({ kind: "turn-capture", conversationId: "conv-1" });
  });

  it("serializes captures and survives failures without breaking the chain", async () => {
    const client = new FakeClient();
    client.failAdd = true;
    const { store, warnings } = makeStore(client);

    store.scheduleCapture("c", "one");
    store.scheduleCapture("c", "two");
    await store.flush();

    expect(client.added).toHaveLength(2);
    expect(warnings.filter((w) => w.includes("capture failed"))).toHaveLength(2);

    // Chain still works after failures.
    client.failAdd = false;
    store.scheduleCapture("c", "three");
    await store.flush();
    expect(client.added).toHaveLength(3);
  });
});

describe("SupermemoryMemoryStore.recall", () => {
  it("maps hits into recall-tool-shaped records", async () => {
    const client = new FakeClient();
    client.hits = [{ id: "a", text: "fact", score: 0.8 }];
    const { store } = makeStore(client);

    const hits = await store.recall("q", { topK: 3 });

    expect(hits).toEqual([{ score: 0.8, record: { id: "a", text: "fact" } }]);
    expect(client.searches[0]?.limit).toBe(3);
  });
});
