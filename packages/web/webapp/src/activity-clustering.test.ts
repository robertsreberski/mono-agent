import { describe, expect, it } from "vitest";
import { clusterToolCalls, type ToolClusterPartLike } from "./activity-clustering";

const asCluster = (value: unknown): ToolClusterPartLike => {
  expect(value).toMatchObject({ type: "data-tool-cluster" });
  return value as ToolClusterPartLike;
};

const call = (toolName: string, id: string, extra: Record<string, unknown> = {}) => ({
  type: "tool-call",
  toolName,
  toolCallId: id,
  status: { type: "complete" },
  ...extra,
});

describe("clusterToolCalls", () => {
  it("clusters consecutive same-tool calls and sums known durations", () => {
    const result = clusterToolCalls([
      call("Read", "one", { artifact: { executionMs: 200 } }),
      call("Read", "two", { artifact: { executionMs: 300 }, isError: true }),
    ]);

    expect(result).toEqual([{
      type: "data-tool-cluster",
      data: expect.objectContaining({
        toolName: "Read",
        status: "failed",
        failedCount: 1,
        totalMs: 500,
      }),
    }]);
  });

  it("omits the duration entirely when no member reported one", () => {
    const [cluster] = clusterToolCalls([call("Read", "one"), call("Read", "two")]);

    expect(asCluster(cluster).data).not.toHaveProperty("totalMs");
  });

  it("sums only the durations the runtime reported", () => {
    const [cluster] = clusterToolCalls([
      call("Read", "one", { artifact: { executionMs: 200 } }),
      call("Read", "two"),
    ]);

    expect(cluster).toMatchObject({ data: { totalMs: 200 } });
  });

  it("reports a run as running while any member is still in flight", () => {
    const [cluster] = clusterToolCalls([
      call("Read", "one"),
      call("Read", "two", { status: { type: "running" } }),
    ]);

    expect(cluster).toMatchObject({ data: { status: "running" } });
  });

  it("does not cluster AskUser or calls separated by another part", () => {
    const parts = [
      call("AskUser", "one"),
      call("AskUser", "two"),
      call("Read", "three"),
      { type: "reasoning" },
      call("Read", "four"),
    ];

    expect(clusterToolCalls(parts)).toEqual(parts);
  });

  it("passes an unclustered transcript through identically", () => {
    const parts = [call("Read", "one"), call("Write", "two"), { type: "text", text: "done" }];

    expect(clusterToolCalls(parts)).toEqual(parts);
  });

  it("keeps every member, in order, so nothing is hidden by folding", () => {
    const [cluster] = clusterToolCalls([call("Read", "first"), call("Read", "second")]);

    expect(asCluster(cluster).data.calls.map((member) => member.toolCallId))
      .toEqual(["first", "second"]);
  });

  it("is positionally stable as a run grows, which is what streaming re-converts on", () => {
    const growing = [call("Read", "a"), call("Read", "b"), call("Read", "c")];
    const afterTwo = clusterToolCalls(growing.slice(0, 2));
    const afterThree = clusterToolCalls(growing);

    // The cluster stays at the same index and only gains a member; assistant-ui
    // keys data parts by position, so a cluster that moved would remount.
    expect(afterTwo).toHaveLength(1);
    expect(afterThree).toHaveLength(1);
    expect(asCluster(afterThree[0]).data.calls).toHaveLength(3);
  });

  it("is pure: the same input yields a deeply equal result every time", () => {
    const parts = [call("Read", "a"), call("Read", "b"), { type: "text", text: "done" }];

    expect(clusterToolCalls(parts)).toEqual(clusterToolCalls(parts));
  });
});
