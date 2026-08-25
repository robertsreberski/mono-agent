import { describe, expect, it } from "vitest";
import { clusterToolCalls } from "./activity-clustering";

const call = (toolName: string, id: string, extra: Record<string, unknown> = {}) => ({
  type: "tool-call",
  toolName,
  toolCallId: id,
  status: { type: "complete" },
  ...extra,
});

describe("clusterToolCalls", () => {
  it("clusters consecutive same-tool calls and sums known duration", () => {
    const result = clusterToolCalls([
      call("Read", "one", { artifact: { executionMs: 200 } }),
      call("Read", "two", { artifact: { executionMs: 300 }, isError: true }),
    ]);
    expect(result).toEqual([{ type: "data-tool-cluster", data: expect.objectContaining({ toolName: "Read", failedCount: 1, totalMs: 500 }) }]);
  });

  it("does not cluster AskUser or calls separated by another part", () => {
    const parts = [call("AskUser", "one"), call("AskUser", "two"), call("Read", "three"), { type: "reasoning" }, call("Read", "four")];
    expect(clusterToolCalls(parts)).toEqual(parts);
  });
});
