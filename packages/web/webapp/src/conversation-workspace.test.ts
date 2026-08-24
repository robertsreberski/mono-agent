import { describe, expect, it } from "vitest";
import {
  conversationPath,
  conversationThreadFromPath,
  effectiveRunPreference,
  groupWorkspaceThreads,
  messageIdFromHash,
  workspaceThreadMatches,
} from "./conversation-workspace";
import { agent, thread } from "./test/fixtures";

describe("conversation workspace routing", () => {
  it("round-trips encoded thread identifiers through the master-detail route", () => {
    expect(conversationPath("thread/one")).toBe("/conversations/thread%2Fone");
    expect(conversationThreadFromPath("/conversations/thread%2Fone")).toBe("thread/one");
    expect(conversationThreadFromPath("/agents/alpha/cron/job")).toBeUndefined();
    expect(messageIdFromHash("#message-answer%2Fone")).toBe("answer/one");
    expect(messageIdFromHash("#message-%E0%A4%A")).toBeUndefined();
  });
});

describe("effectiveRunPreference", () => {
  it("inherits model and effort independently across conversation, agent, and advertised defaults", () => {
    expect(effectiveRunPreference(
      { model: "conversation-model" },
      { model: "agent-model", effort: "agent-effort" },
      { model: "advertised-model", effort: "advertised-effort" },
    )).toEqual({ model: "conversation-model", effort: "agent-effort" });

    expect(effectiveRunPreference(
      { effort: "conversation-effort" },
      { model: "agent-model" },
      { model: "advertised-model", effort: "advertised-effort" },
    )).toEqual({ model: "agent-model", effort: "conversation-effort" });

    expect(effectiveRunPreference(null, null, {
      model: "advertised-model",
      effort: "advertised-effort",
    })).toEqual({ model: "advertised-model", effort: "advertised-effort" });
  });
});

describe("workspace grouping and collection filters", () => {
  const collections = [{
    id: "project",
    name: "Project",
    createdAt: "2026-08-24T08:00:00.000Z",
    updatedAt: "2026-08-24T08:00:00.000Z",
  }];
  const agents = [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })];
  const threads = [
    thread("unfiled", "alpha"),
    thread("project", "beta", { collectionId: "project", pinned: true }),
  ];

  it("keeps Unfiled and custom collections distinct while honoring cross-agent membership", () => {
    const allAgents = new Set(agents.map(({ sourceId }) => sourceId));
    expect(workspaceThreadMatches(threads[0]!, {
      collectionId: "unfiled",
      sourceIds: allAgents,
      kind: "interactive",
    })).toBe(true);
    expect(workspaceThreadMatches(threads[1]!, {
      collectionId: "collection:project",
      sourceIds: allAgents,
      kind: "interactive",
    })).toBe(true);
    expect(workspaceThreadMatches(threads[0]!, {
      collectionId: "collection:project",
      sourceIds: allAgents,
      kind: "interactive",
    })).toBe(false);
  });

  it("offers stable collection and agent group labels for the accessible list fallback", () => {
    expect(groupWorkspaceThreads(threads, "collection", collections, agents)
      .map(({ label }) => label)).toEqual(["Project", "Unfiled"]);
    expect(groupWorkspaceThreads(threads, "agent", collections, agents)
      .map(({ label }) => label)).toEqual(["Alpha", "Beta"]);
  });
});
