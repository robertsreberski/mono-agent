import { describe, expect, it } from "vitest";
import {
  agentVisibility,
  boundedRequest,
  createRemovedThreadRegistry,
  createThreadWriteChain,
  preferenceKeyForThread,
  readStoredRunPreferences,
  REMOVED_THREAD_TTL_MS,
  resolveBootstrapSelection,
  RUN_PREFERENCES_STORAGE_KEY,
  sortAgentsPinnedFirst,
  startBoundedRequest,
  THREAD_READ_TIMEOUT_MS,
  THREAD_WRITE_TIMEOUT_MS,
  validateRunPreference,
} from "./console-store";
import { effortLevelsForAgentModel, GLOBAL_EFFORT_LEVELS } from "./components/model-catalog";
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

describe("sortAgentsPinnedFirst", () => {
  it("places favorites first using the backend label and source-id ordering", () => {
    const agents = [
      agent("z", { label: "Zulu" }),
      agent("b", { label: "beta", pinned: true }),
      agent("a-2", { label: "Alpha", pinned: true }),
      agent("a-1", { label: "Alpha", pinned: true, status: "offline" }),
    ];

    expect(sortAgentsPinnedFirst(agents).map((item) => item.sourceId)).toEqual([
      "a-1",
      "a-2",
      "b",
      "z",
    ]);
    expect(agents.map((item) => item.sourceId)).toEqual(["z", "b", "a-2", "a-1"]);
  });

  it("returns an unpinned agent immediately to its alphabetical position", () => {
    expect(sortAgentsPinnedFirst([
      agent("beta", { label: "Beta", pinned: false }),
      agent("alpha", { label: "Alpha", pinned: false }),
    ]).map((item) => item.sourceId)).toEqual(["alpha", "beta"]);
  });

  it("matches SQLite ASCII-only NOCASE ordering for international labels", () => {
    expect(sortAgentsPinnedFirst([
      agent("istanbul", { label: "İstanbul" }),
      agent("zulu", { label: "Zulu" }),
      agent("alpha", { label: "alpha" }),
    ]).map((item) => item.sourceId)).toEqual(["alpha", "zulu", "istanbul"]);
  });
});

describe("agentVisibility", () => {
  const agents = [
    agent("online"),
    agent("degraded", { status: "degraded" }),
    agent("pinned-offline", { status: "offline", pinned: true }),
    agent("selected-offline", { status: "offline" }),
    agent("hidden-offline", { status: "offline" }),
  ];

  it("hides only unpinned, unselected agents with exact offline status", () => {
    expect(agentVisibility(agents, "selected-offline", false)).toEqual({
      visibleAgents: agents.slice(0, 4),
      hiddenOfflineAgentCount: 1,
    });
  });

  it("restores every agent without changing the hidden-offline count", () => {
    expect(agentVisibility(agents, "selected-offline", true)).toEqual({
      visibleAgents: agents,
      hiddenOfflineAgentCount: 1,
    });
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

  it("honors provider grades and fail-closes when a present option omits effort levels", () => {
    expect(effortLevelsForAgentModel(source, "graded")).toEqual([
      "low",
      "medium",
      "xhigh",
    ]);
    expect(effortLevelsForAgentModel(source, "cloud")).toEqual([]);
  });

  it("keeps the compatibility ladder only for legacy agents without modelOptions", () => {
    expect(effortLevelsForAgentModel(
      agent("legacy", { models: ["legacy/model"], efforts: [...GLOBAL_EFFORT_LEVELS] }),
      "legacy/model",
    )).toEqual([...GLOBAL_EFFORT_LEVELS]);
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
          defaultModel: "current",
          modelOptions: { current: { reasoningMode: "none" } },
        }),
        { model: "removed", effort: "ultra" },
      ),
    ).toEqual({ model: "", effort: "" });
  });

  it("clears an incompatible stored effort when the selected model changes", () => {
    expect(
      validateRunPreference(
        agent("agent", {
          models: ["graded", "cloud"],
          modelOptions: {
            graded: { reasoning: true, effortLevels: ["low", "medium"] },
            cloud: { reasoning: true },
          },
        }),
        { model: "cloud", effort: "medium" },
      ),
    ).toEqual({ model: "cloud", effort: "" });
  });

  it("keeps an override whose row left the shortlist while its provider stays advertised", () => {
    expect(
      validateRunPreference(
        agent("agent", { models: ["current"] }),
        { model: "anthropic:claude-sonnet-4.5", effort: "" },
        ["agent", "anthropic"],
      ),
    ).toEqual({ model: "anthropic:claude-sonnet-4.5", effort: "" });
  });

  it("judges a catalog-only model's effort against the ladder its page advertised", () => {
    // The picker offers a catalog row the grades its `/v1/models` page named,
    // but validation never received that metadata: `modelOptions` covers only
    // the shortlist, so the grade the operator had just picked was erased the
    // moment it was stored.
    const source = agent("agent", {
      models: ["provider/default"],
      defaultModel: "provider/default",
      modelOptions: { "provider/default": { reasoning: true, effortLevels: ["low"] } },
    });
    const catalogByProvider = {
      anthropic: [
        {
          id: "opus-5",
          name: "Opus 5",
          provider: "anthropic",
          providerLabel: "Anthropic",
          reasoning: true,
          effortLevels: ["low", "max"],
        },
      ],
    };

    expect(validateRunPreference(
      source,
      { model: "anthropic:opus-5", effort: "max" },
      ["anthropic"],
      catalogByProvider,
    )).toEqual({ model: "anthropic:opus-5", effort: "max" });
    // ...and a grade the page did not advertise is still cleared.
    expect(validateRunPreference(
      source,
      { model: "anthropic:opus-5", effort: "ultra" },
      ["anthropic"],
      catalogByProvider,
    )).toEqual({ model: "anthropic:opus-5", effort: "" });
  });

  it("keeps the stored selection through a discovery blip with an empty shortlist", () => {
    expect(
      validateRunPreference(
        agent("agent", { models: [], defaultModel: "" }),
        { model: "graded", effort: "xhigh" },
      ),
    ).toEqual({ model: "graded", effort: "xhigh" });
  });

  it("leaves a stored selection untouched while no agent is selected", () => {
    expect(
      validateRunPreference(null, { model: "graded", effort: "xhigh" }),
    ).toEqual({ model: "graded", effort: "xhigh" });
  });
});

describe("boundedRequest", () => {
  it("settles on its deadline even when the transport ignores the abort", async () => {
    // Writes to one conversation are serialized, so an unbounded request does
    // not merely hang itself: it wedges every later write to that thread while
    // the optimistic UI keeps showing a selection that never reached the
    // server. `signal` is what a healthy fetch needs; the deadline is what
    // makes the guarantee hold when the transport does not honour it.
    let aborted = false;
    await expect(boundedRequest<never>((signal) => {
      signal.addEventListener("abort", () => { aborted = true; });
      return new Promise<never>(() => undefined);
    }, 10)).rejects.toThrow(/timed out/u);
    expect(aborted).toBe(true);
  });

  it("passes a live signal through and returns the result untouched", async () => {
    await expect(boundedRequest(async (signal) => signal.aborted, 1_000)).resolves.toBe(false);
  });
});

describe("startBoundedRequest", () => {
  it("settles the caller on the deadline but the QUEUE only on the real request", async () => {
    // The invariant: a deadline aborts a request, it does not un-send it. If
    // `settled` tracked the deadline, the queue would release the next write to
    // the same conversation while the abandoned one was still on the wire --
    // which is exactly how the older mutation came to land last.
    let release!: () => void;
    let aborted = false;
    const started = startBoundedRequest<string>((signal) => {
      signal.addEventListener("abort", () => { aborted = true; });
      return new Promise<string>((resolve) => { release = () => resolve("late"); });
    }, 10);

    await expect(started.result).rejects.toThrow(/timed out/u);
    expect(aborted).toBe(true);

    // The deadline has fired and the caller has already been told. The queue
    // must still be holding, because the request is still alive.
    let settled = false;
    void started.settled.then(() => { settled = true; });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(settled).toBe(false);

    release();
    await started.settled;
    expect(settled).toBe(true);
  });

  it("resolves both together for a transport that honours the deadline", async () => {
    const started = startBoundedRequest(async (signal) => signal.aborted, 1_000);
    await expect(started.result).resolves.toBe(false);
    await expect(started.settled).resolves.toBeUndefined();
  });
});

describe("createThreadWriteChain", () => {
  /**
   * Ordering is asserted from the ORDER OF THE CALLS ALONE. Nothing here reads
   * a request body or a marker: an earlier chain that serialized only the
   * conditional migration write still passed the suite's named ordering test
   * once its mock recognised the old request shape.
   */
  const recorder = () => {
    const order: string[] = [];
    const gates = new Map<string, () => void>();
    const run = (name: string) => (): Promise<string> => {
      order.push(`start:${name}`);
      return new Promise<string>((resolve) => {
        gates.set(name, () => {
          order.push(`end:${name}`);
          resolve(name);
        });
      });
    };
    return { order, run, release: (name: string) => gates.get(name)?.() };
  };

  it("starts a write only after the previous one on the same conversation has ended", async () => {
    const { order, run, release } = recorder();
    const chain = createThreadWriteChain();

    const first = chain.enqueue("thread-a", run("first"));
    const second = chain.enqueue("thread-a", run("second"));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(order).toEqual(["start:first"]);

    release("first");
    await first;
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    release("second");
    await second;

    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("holds the queue for a request that outlived its own deadline", async () => {
    // The caller is told the write timed out; the queue is not, because the
    // request it abandoned can still land.
    const { order, run, release } = recorder();
    const chain = createThreadWriteChain();

    const first = chain.enqueue("thread-a", run("first"), 10);
    await expect(first).rejects.toThrow(/timed out/u);
    const second = chain.enqueue("thread-a", run("second"), 10);
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(order).toEqual(["start:first"]);

    release("first");
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(order).toEqual(["start:first", "end:first", "start:second"]);
    release("second");
    await second;
  });

  it("hands the queue on after a failure and keeps conversations independent", async () => {
    const chain = createThreadWriteChain();
    await expect(chain.enqueue("thread-a", () => Promise.reject(new Error("write failed"))))
      .rejects.toThrow("write failed");
    await expect(chain.enqueue("thread-a", () => Promise.resolve("after"))).resolves.toBe("after");

    const { order, run, release } = recorder();
    const blocked = chain.enqueue("thread-a", run("a"));
    const other = chain.enqueue("thread-b", run("b"));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(order).toEqual(["start:a", "start:b"]);
    release("a");
    release("b");
    await Promise.all([blocked, other]);
  });

  it("settles only once every write issued before the call has left the queue", async () => {
    const { order, run, release } = recorder();
    const chain = createThreadWriteChain();
    const first = chain.enqueue("thread-a", run("first"));
    const second = chain.enqueue("thread-a", run("second"));

    let settled = false;
    void chain.settle("thread-a").then(() => { settled = true; });
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(settled).toBe(false);

    release("first");
    await first;
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(settled).toBe(false);
    release("second");
    await second;
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(settled).toBe(true);
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("reports a conversation as drained exactly once its queue empties", async () => {
    const drained: string[] = [];
    const { run, release } = recorder();
    const chain = createThreadWriteChain((threadId) => drained.push(threadId));

    const write = chain.enqueue("thread-a", run("only"));
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(chain.pending()).toEqual(["thread-a"]);
    expect(drained).toEqual([]);
    release("only");
    await write;
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(chain.pending()).toEqual([]);
    expect(drained).toEqual(["thread-a"]);
  });
});

describe("createRemovedThreadRegistry", () => {
  const summary = (id: string) => thread(id, "alpha");

  it("keeps every tombstone that is younger than its lifetime, however many there are", () => {
    // The invariant: a tombstone outlives any request that could have been
    // issued before its delete. A 256-entry ring broke that at the 257th
    // delete -- the oldest protection was dropped while it was still needed,
    // and a response held across that delete resurrected the conversation. The
    // 4,096-entry backstop that replaced it had the same defect at a higher
    // threshold, so there is no count limit at all now: 8,192 live tombstones
    // are 8,192 live tombstones.
    let clock = 0;
    const registry = createRemovedThreadRegistry(() => clock, 10_000);
    for (let index = 0; index < 8_192; index += 1) {
      clock += 1;
      registry.remember(`thread-${String(index)}`, summary(`thread-${String(index)}`));
    }

    expect(registry.size()).toBe(8_192);
    for (const index of [0, 1, 255, 256, 257, 4_095, 4_096, 4_097, 8_191]) {
      expect([index, registry.has(`thread-${String(index)}`)]).toEqual([index, true]);
    }
  });

  it("forgets a tombstone only once it is older than the lifetime", () => {
    let clock = 1_000;
    const registry = createRemovedThreadRegistry(() => clock, 10_000);
    registry.remember("old", summary("old"));
    clock += 9_999;
    expect(registry.has("old")).toBe(true);
    clock += 1;
    expect(registry.has("old")).toBe(false);
  });

  it("evicts expired entries on write, and only expired ones", () => {
    let clock = 0;
    const registry = createRemovedThreadRegistry(() => clock, 100);
    registry.remember("expired", summary("expired"));
    clock += 200;
    registry.remember("kept", summary("kept"));
    expect(registry.size()).toBe(1);
    expect(registry.has("expired")).toBe(false);

    for (const id of ["a", "b", "c"]) registry.remember(id, summary(id));
    expect(registry.size()).toBe(4);
    // "kept" is younger than its lifetime, so no number of later deletes may
    // drop it: that is what a count-based backstop got wrong.
    expect(registry.has("kept")).toBe(true);
    expect([registry.has("a"), registry.has("b"), registry.has("c")]).toEqual([true, true, true]);
  });

  it("hands back the newest projection it suppressed when its delete failed", () => {
    // A failed delete has to restore what its tombstone hid, not merely stop
    // hiding it: the responses that were filtered while it stood are the only
    // reason the conversation left the sidebar.
    const registry = createRemovedThreadRegistry();
    const original = summary("thread-a");
    registry.remember("thread-a", original);
    expect(registry.has("thread-a")).toBe(true);

    const newer = { ...original, title: "Renamed while the delete was pending" };
    registry.suppress("thread-a", newer);
    expect(registry.forget("thread-a")).toEqual(newer);
    expect(registry.has("thread-a")).toBe(false);
    // Nothing to hand back once it is gone, and no entry recreated by asking.
    expect(registry.forget("thread-a")).toBeUndefined();
    expect(registry.size()).toBe(0);
  });

  it("never records a suppression against an expired or absent tombstone", () => {
    let clock = 0;
    const registry = createRemovedThreadRegistry(() => clock, 100);
    registry.remember("gone", summary("gone"));
    clock += 100;
    registry.suppress("gone", { ...summary("gone"), title: "late" });
    expect(registry.has("gone")).toBe(false);
    expect(registry.size()).toBe(0);
  });

  it("derives its lifetime from the deadlines it has to outlive", () => {
    // The old ten minutes was a comment asserting a relationship the code did
    // not hold: reads had no deadline at all, so no lifetime bounded them.
    expect(REMOVED_THREAD_TTL_MS).toBeGreaterThan(THREAD_READ_TIMEOUT_MS);
    expect(REMOVED_THREAD_TTL_MS).toBeGreaterThan(THREAD_WRITE_TIMEOUT_MS);
  });
});
