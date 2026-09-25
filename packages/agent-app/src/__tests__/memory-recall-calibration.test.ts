import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import {
  calibrateRecallHits,
  createMemoryRecallServer,
  recallEvidenceNote,
  recallHitCurrentness,
  RECALL_TAIL_MARGIN,
} from "../memory-recall.js";
import type { MemoryRecallHit, RecallCapableStore } from "../memory-recall.js";
import type { LabelSections } from "../memory-label-sections.js";

interface ToolResult {
  readonly content: Array<{ type: string; text: string }>;
  readonly structuredContent?: {
    readonly hits: Array<{ id: string; score: number; currentness?: string }>;
    readonly evidence?: string;
  };
}

const hit = (id: string, score: number, text: string, record: Partial<MemoryRecallHit["record"]> = {}): MemoryRecallHit =>
  ({ score, record: { id, text, status: "open", createdAt: "2026-07-12T10:00:00.000Z", ...record } });

function localStore(hits: readonly MemoryRecallHit[], sections?: LabelSections): RecallCapableStore {
  return {
    async recall() { return hits; },
    async recallWithOutcome() { return { hits, retrievalMode: "hybrid" as const }; },
    ...(sections === undefined ? {} : { labelSections: () => sections }),
    async close() {},
  };
}

async function callRecall(store: RecallCapableStore, query: string): Promise<ToolResult> {
  const server = createMemoryRecallServer(store);
  const client = new Client({ name: "recall-calibration-test", version: "0.1.0" }, { capabilities: {} });
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

describe("calibrated explicit MemoryRecall", () => {
  it("drops tail hits beyond the relative margin or below the floor and always keeps the best hit", () => {
    const scores = (hits: readonly { score: number }[]) => calibrateRecallHits(hits).map(({ score }) => score);
    expect(RECALL_TAIL_MARGIN).toBe(0.15);
    // Strong top: keep within 0.15 and at or above the 0.65 floor.
    expect(scores([{ score: 0.9 }, { score: 0.8 }, { score: 0.75 }, { score: 0.74 }])).toEqual([0.9, 0.8, 0.75]);
    expect(scores([{ score: 0.7 }, { score: 0.66 }, { score: 0.64 }])).toEqual([0.7, 0.66]);
    // Weak top: only the relative margin applies; the best hit is never dropped.
    expect(scores([{ score: 0.6 }, { score: 0.5 }, { score: 0.4 }])).toEqual([0.6, 0.5]);
    expect(scores([{ score: 0.2 }])).toEqual([0.2]);
    expect(scores([])).toEqual([]);
  });

  it("marks superseded values from lifecycle status or a closed validity interval", () => {
    const today = "2026-07-12";
    expect(recallHitCurrentness(hit("a", 0.9, "Morgan works in Example City."), today)).toBe("current");
    expect(recallHitCurrentness(hit("b", 0.9, "Morgan worked in Maple Town.", { validTo: "2026-01-31" }), today)).toBe("superseded");
    expect(recallHitCurrentness(hit("c", 0.9, "Morgan worked in Maple Town.", { status: "invalidated" }), today)).toBe("superseded");
    expect(recallHitCurrentness(hit("d", 0.9, "Morgan works until autumn.", { validTo: "2026-10-01" }), today)).toBe("current");
    expect(recallHitCurrentness({ score: 0.9, record: { id: "e", text: "Remote memory." } }, today)).toBeUndefined();
  });

  it("says insufficient evidence for a weak best hit and conflicting values for disagreeing current facts", () => {
    expect(recallEvidenceNote("What is Morgan's favorite tea?", [hit("a", 0.61, "Morgan visited Maple Town.")])).toBe("insufficient");
    expect(recallEvidenceNote("What is Morgan's favorite tea?", [hit("a", 0.82, "Morgan's favorite tea is jasmine.")])).toBeUndefined();
    expect(recallEvidenceNote("What is Morgan's favorite tea?", [])).toBeUndefined();
    const conflicted: LabelSections = { text: "", factSheet: [
      { entityId: "person:morgan", name: "Morgan", key: "home_location", value: { type: "text", text: "Example City" },
        attribution: "user-stated", recordedAt: "2026-07-01", current: true, conflict: true },
    ] };
    expect(recallEvidenceNote("Where does Morgan live?", [hit("a", 0.9, "Morgan lives in Example City.")], conflicted)).toBe("conflicting");
    expect(recallEvidenceNote("What color did Morgan select for the Maple launch?", [
      hit("a", 0.9, "Morgan selected cobalt as the color for the Maple launch."),
      hit("b", 0.7, "Morgan selected teal as the color for the Maple launch."),
    ])).toBe("conflicting");
  });

  it("serves fewer weak hits with source date, superseded marker and an explicit evidence note", async () => {
    const strong = await callRecall(localStore([
      hit("m-1", 0.9, "Morgan's favorite tea is jasmine."),
      hit("m-2", 0.8, "Morgan's favorite tea was oolong.", { validTo: "2026-01-31" }),
      hit("m-3", 0.6, "Maple Town has a tea shop."),
    ]), "What is Morgan's favorite tea?");
    expect(strong.structuredContent?.hits.map(({ id, currentness }) => [id, currentness])).toEqual([["m-1", "current"], ["m-2", "superseded"]]);
    expect(strong.structuredContent).not.toHaveProperty("evidence");
    expect(strong.content[0]?.text).toBe([
      "0.900  [recorded 2026-07-12T10:00:00.000Z] Morgan's favorite tea is jasmine.",
      "0.800  [recorded 2026-07-12T10:00:00.000Z; valid to 2026-01-31; superseded] Morgan's favorite tea was oolong.",
    ].join("\n"));

    const weak = await callRecall(localStore([hit("m-1", 0.58, "Maple Town has a tea shop."), hit("m-2", 0.3, "Morgan bought a kettle.")]),
      "What is Morgan's favorite tea?");
    expect(weak.structuredContent?.evidence).toBe("insufficient");
    expect(weak.structuredContent?.hits.map(({ id }) => id)).toEqual(["m-1"]);
    expect(weak.content[0]?.text.split("\n")[0]).toMatch(/^Insufficient evidence:/u);
  });

  it("flags conflicting values found in the uncut candidates even when the tail cut drops one of them", async () => {
    const query = "What color did Morgan select for the Maple launch?";
    const cobalt = hit("m-cobalt", 0.9, "Morgan selected cobalt as the color for the Maple launch.");
    const teal = hit("m-teal", 0.7, "Morgan selected teal as the color for the Maple launch.");
    // 0.70 is within the floor but more than 0.15 below 0.90: the cut drops it.
    expect(calibrateRecallHits([cobalt, teal])).toEqual([cobalt]);
    expect(recallEvidenceNote(query, [cobalt], undefined, [cobalt, teal])).toBe("conflicting");
    const result = await callRecall(localStore([cobalt, teal]), query);
    expect(result.structuredContent?.hits.map(({ id }) => id)).toEqual(["m-cobalt"]);
    expect(result.structuredContent?.evidence).toBe("conflicting");
    expect(result.content[0]?.text.split("\n")[0]).toMatch(/^Conflicting values:/u);
  });

  it("keeps an array-only backend's previous output exactly", async () => {
    const remote: RecallCapableStore = {
      async recall() { return [{ score: 0.5, record: { id: "r-1", text: "A remote memory." } }, { score: 0.1, record: { id: "r-2", text: "Another." } }]; },
      async close() {},
    };
    const result = await callRecall(remote, "remote");
    expect(result.content[0]?.text).toBe("0.500  A remote memory.\n0.100  Another.");
    expect(result.structuredContent).not.toHaveProperty("evidence");
    expect(result.structuredContent?.hits.every((entry) => !("currentness" in entry))).toBe(true);
  });
});
