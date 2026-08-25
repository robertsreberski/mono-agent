import { describe, expect, it } from "vitest";
import { agent, thread } from "../../test/fixtures";
import { agentCounts, boardThreads, groupThreads, labelColorIndex, nextThreadState } from "./board-selectors";

describe("board selectors", () => {
  const agents = [agent("alpha"), agent("beta")];
  const threads = [
    thread("one", "alpha", { state: "todo", labels: ["Launch"], project: "Console" }),
    thread("two", "beta", { state: "doing", labels: [] }),
    thread("three", "alpha", { state: "done", archivedAt: "2026-01-01T00:00:00.000Z" }),
  ];

  it("filters active conversations by search and agent", () => {
    expect(boardThreads(threads, "launch", new Set()).map(({ id }) => id)).toEqual(["one"]);
    expect(boardThreads(threads, "", new Set(["beta"])).map(({ id }) => id)).toEqual(["two"]);
    expect(agentCounts(threads)).toEqual(new Map([["alpha", 1], ["beta", 1]]));
  });

  it("groups missing labels and projects into explicit buckets", () => {
    const active = boardThreads(threads, "", new Set());
    expect(groupThreads(active, "label", agents).map(({ label }) => label)).toEqual(["No label", "Launch"]);
    expect(groupThreads(active, "project", agents).map(({ label }) => label)).toEqual(["No project", "Console"]);
  });

  it("cycles states and assigns stable label colors", () => {
    expect([nextThreadState("todo"), nextThreadState("doing"), nextThreadState("done")]).toEqual(["doing", "done", "todo"]);
    expect(labelColorIndex("Launch")).toBe(labelColorIndex("Launch"));
  });
});
