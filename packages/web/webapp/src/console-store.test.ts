import { describe, expect, it } from "vitest";
import {
  effortLevelsForAgentModel,
  GLOBAL_EFFORT_LEVELS,
  preferenceKeyForThread,
  readStoredRunPreferences,
  resolveBootstrapSelection,
  RUN_PREFERENCES_STORAGE_KEY,
  validateRunPreference,
} from "./console-store";
import { agent, bootstrap, thread } from "./test/fixtures";

describe("resolveBootstrapSelection", () => {
  it("restores the origin-local thread for the selected agent instead of backend global state", () => {
    const payload = bootstrap(
      [agent("a"), agent("b")],
      [thread("a-local", "a"), thread("b-global", "b")],
      "b-global",
    );

    expect(
      resolveBootstrapSelection(payload, "a", null, { a: "a-local" }),
    ).toEqual({ agentId: "a", threadId: "a-local" });
  });

  it("rejects a persisted thread belonging to another agent", () => {
    const payload = bootstrap(
      [agent("a"), agent("b")],
      [
        thread("a-new", "a", { updatedAt: "2026-07-17T12:00:00.000Z" }),
        thread("b-thread", "b"),
      ],
    );

    expect(
      resolveBootstrapSelection(payload, "a", null, { a: "b-thread" }),
    ).toEqual({ agentId: "a", threadId: "a-new" });
  });

  it("rejects archived and removed persisted threads and uses the latest active thread", () => {
    const payload = bootstrap(
      [agent("a")],
      [
        thread("active-old", "a", { updatedAt: "2026-07-17T10:00:00.000Z" }),
        thread("active-new", "a", { updatedAt: "2026-07-17T12:00:00.000Z" }),
        thread("archived", "a", { archivedAt: "2026-07-17T13:00:00.000Z" }),
      ],
    );

    expect(
      resolveBootstrapSelection(payload, "a", null, { a: "archived" }).threadId,
    ).toBe("active-new");
    expect(
      resolveBootstrapSelection(payload, "a", null, { a: "removed" }).threadId,
    ).toBe("active-new");
  });
});

describe("effortLevelsForAgentModel", () => {
  const source = agent("a", {
    models: ["toggle", "none", "empty", "graded", "cloud"],
    modelOptions: {
      toggle: { reasoningMode: "toggle" },
      none: { reasoningMode: "none" },
      empty: { reasoning: true, effortLevels: [] },
      graded: { reasoning: true, effortLevels: ["low", "medium", "xhigh"] },
      cloud: { reasoning: true },
    },
  });

  it("normalizes toggle reasoning to thinking on and off values", () => {
    expect(effortLevelsForAgentModel(source, "toggle")).toEqual(["high", "none"]);
  });

  it("hides effort for non-reasoning and explicitly empty models", () => {
    expect(effortLevelsForAgentModel(source, "none")).toEqual([]);
    expect(effortLevelsForAgentModel(source, "empty")).toEqual([]);
  });

  it("honors provider grades and exposes the complete cloud ladder when unspecified", () => {
    expect(effortLevelsForAgentModel(source, "graded")).toEqual([
      "low",
      "medium",
      "xhigh",
    ]);
    expect(effortLevelsForAgentModel(source, "cloud")).toEqual(GLOBAL_EFFORT_LEVELS);
  });
});

describe("run setting isolation", () => {
  it("keys optional model and effort overrides per conversation", () => {
    expect(preferenceKeyForThread("agent", "thread-a")).not.toBe(
      preferenceKeyForThread("agent", "thread-b"),
    );
    expect(preferenceKeyForThread("agent", null)).not.toBe(
      preferenceKeyForThread("agent", "thread-a"),
    );
  });

  it("reloads a browser-local per-thread selection when it is still advertised", () => {
    const key = preferenceKeyForThread("agent", "thread-a");
    localStorage.setItem(
      RUN_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ [key]: { model: "graded", effort: "xhigh" } }),
    );
    const source = agent("agent", {
      models: ["graded"],
      modelOptions: { graded: { reasoning: true, effortLevels: ["low", "xhigh"] } },
    });

    expect(validateRunPreference(source, readStoredRunPreferences()[key]!)).toEqual({
      model: "graded",
      effort: "xhigh",
    });
  });

  it("clears stale model and effort overrides after provider capabilities change", () => {
    expect(
      validateRunPreference(
        agent("agent", {
          models: ["current"],
          modelOptions: { current: { reasoningMode: "none" } },
        }),
        { model: "removed", effort: "ultra" },
      ),
    ).toEqual({ model: "", effort: "" });
  });
});
