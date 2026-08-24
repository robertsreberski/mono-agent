import { describe, expect, it } from "vitest";
import {
  isTerminalMemoryOperation,
  layoutMemoryGraph,
  MEMORY_GRAPH_MIN_VERTICAL_GAP,
  memoryOperationPollDelay,
  memoryPath,
  memorySourceFromPath,
  truncateMemoryGraphLabel,
  workspaceRouteFromPath,
} from "./memory-workspace";
import { memoryGraph } from "./test/fixtures";

describe("memory workspace routes", () => {
  it("round-trips an encoded live agent source", () => {
    expect(memoryPath("agent/one:local")).toBe("/memory/agent%2Fone%3Alocal");
    expect(memorySourceFromPath("/memory/agent%2Fone%3Alocal")).toBe("agent/one:local");
    expect(workspaceRouteFromPath("/memory/agent%2Fone%3Alocal")).toEqual({
      kind: "memory",
      sourceId: "agent/one:local",
    });
  });

  it("distinguishes conversations from malformed memory routes", () => {
    expect(workspaceRouteFromPath("/conversations/thread-one")).toEqual({ kind: "conversations" });
    expect(workspaceRouteFromPath("/agents/alpha/cron/job")).toEqual({ kind: "conversations" });
    expect(workspaceRouteFromPath("/memory")).toEqual({ kind: "malformed-memory" });
    expect(workspaceRouteFromPath("/memory/%E0%A4%A")).toEqual({ kind: "malformed-memory" });
    expect(workspaceRouteFromPath("/memory/agent/extra")).toEqual({ kind: "malformed-memory" });
  });
});

describe("memory graph helpers", () => {
  it("lays captured entities and memories into stable bounded columns", () => {
    const layout = layoutMemoryGraph(memoryGraph(), 800, 400);
    expect(layout.positions).toHaveLength(2);
    expect(layout.byId.get("entity-one")?.x).toBeCloseTo(224);
    expect(layout.byId.get("entity-one")?.y).toBeCloseTo(200);
    expect(layout.byId.get("record-one")?.x).toBeCloseTo(576);
    expect(layout.byId.get("record-one")?.y).toBeCloseTo(200);
  });

  it("truncates by Unicode code point without hiding the full graph DTO", () => {
    expect(truncateMemoryGraphLabel("abcdefgh", 5)).toBe("abcd…");
    expect(truncateMemoryGraphLabel("🧠🧠🧠🧠", 3)).toBe("🧠🧠…");
  });

  it("grows a dense graph to keep the largest column readable and pannable", () => {
    const graph = memoryGraph({
      nodes: [
        ...Array.from({ length: 10 }, (_value, index) => ({
          kind: "entity" as const,
          id: `entity-${index}`,
          label: `Entity ${index}`,
        })),
        ...Array.from({ length: 30 }, (_value, index) => ({
          kind: "memory" as const,
          id: `memory-${index}`,
          label: `Memory ${index}`,
          lifecycle: "active" as const,
          recordType: "note" as const,
        })),
      ],
      edges: [],
    });

    const layout = layoutMemoryGraph(graph, 800, 400);
    const memoryPositions = layout.positions.filter(({ node }) => node.kind === "memory");

    expect(layout.height).toBe(31 * MEMORY_GRAPH_MIN_VERTICAL_GAP);
    expect(memoryPositions[1]!.y - memoryPositions[0]!.y).toBe(MEMORY_GRAPH_MIN_VERTICAL_GAP);
    expect(memoryPositions.at(-1)!.y).toBeLessThan(layout.height);
  });
});

describe("memory operation helpers", () => {
  it("recognizes only terminal receipts", () => {
    const operation = {
      id: "operation-one",
      action: "edit" as const,
      recordId: "record-one",
      status: "applying" as const,
      createdAt: "2026-08-24T10:00:00.000Z",
      updatedAt: "2026-08-24T10:00:01.000Z",
    };
    expect(isTerminalMemoryOperation(operation)).toBe(false);
    expect(isTerminalMemoryOperation({ ...operation, status: "succeeded" })).toBe(true);
    expect(isTerminalMemoryOperation({ ...operation, status: "failed", errorCode: "unavailable" })).toBe(true);
  });

  it("backs off from one second and caps each polling interval at ten seconds", () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(memoryOperationPollDelay)).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      10_000,
      10_000,
      10_000,
    ]);
  });
});
