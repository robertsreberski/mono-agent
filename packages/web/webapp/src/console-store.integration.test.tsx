import { act, cleanup as cleanupDom, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, THREAD_PAGE_LIMIT } from "./api";
import { resetServerClock, serverNow } from "./server-clock";
import {
  CATALOG_TTL_MS,
  ConsoleStoreProvider,
  cronChannelPath,
  preferenceKeyForThread,
  reconcileFailedDelete,
  REMOVED_THREAD_TTL_MS,
  RUN_PREFERENCES_STORAGE_KEY,
  SELECTED_AGENT_STORAGE_KEY,
  SELECTED_THREADS_STORAGE_KEY,
  THREAD_LIST_REVALIDATE_DEBOUNCE_MS,
  THREAD_READ_TIMEOUT_MS,
  THREAD_WRITE_TIMEOUT_MS,
  useConsoleStore,
} from "./console-store";
import type { RequestLanding } from "./console-store";
import { agent, bootstrap, thread } from "./test/fixtures";
import type {
  AgentSkillRegistry,
  AgentSummary,
  CronOverview,
  MessageDelta,
  MessagePart,
  ThreadDetail,
  ThreadSummary,
  WebEvent,
  WebMessage,
} from "./types";

// `importOriginal` so `ApiError` stays the REAL class: the store branches on
// `instanceof ApiError` and on its status to tell a server that refused a
// delete from a transport that lost the answer, and a look-alike declared here
// would take the wrong branch in every test that models a server refusal.
vi.mock("./api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api")>(),
  api: {
    bootstrap: vi.fn(),
    thread: vi.fn(),
    threads: vi.fn(),
    messages: vi.fn(),
    createThread: vi.fn(),
    patchThread: vi.fn(),
    deleteThread: vi.fn(),
    patchAgent: vi.fn(),
    setAgentRunDefaults: vi.fn(),
    clearAgentRunDefaults: vi.fn(),
    agentSkills: vi.fn(),
    agentModels: vi.fn(),
    startTurn: vi.fn(),
    cancelTurn: vi.fn(),
    cronOverview: vi.fn(),
    cronRuns: vi.fn(),
    cronRun: vi.fn(),
    toolCallPart: vi.fn(),
    message: vi.fn(),
    liveInput: vi.fn(),
  },
}));

class FakeEventSource {
  static latest: FakeEventSource | undefined;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor() {
    FakeEventSource.latest = this;
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }
  close(): void {}

  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

type Store = ReturnType<typeof useConsoleStore>;

function StoreProbe({ onChange }: { readonly onChange: (store: Store) => void }) {
  const store = useConsoleStore();
  useEffect(() => onChange(store), [onChange, store]);
  return null;
}

const renderStore = async () => {
  let current: Store | undefined;
  const onChange = (store: Store) => { current = store; };
  render(
    <ConsoleStoreProvider>
      <StoreProbe onChange={onChange} />
    </ConsoleStoreProvider>,
  );
  await waitFor(() => expect(current?.loading).toBe(false));
  return {
    get current() {
      if (!current) throw new Error("Store did not initialize.");
      return current;
    },
  };
};

const cronThread = thread("cron-thread", "alpha", {
  title: "Cron · daily:report",
  trigger: { kind: "cron", jobId: "daily:report", configured: true },
  canSend: false,
  canUpload: false,
});

const cronOverview = (overrides: Partial<CronOverview> = {}): CronOverview => ({
  generatedAt: "2026-08-14T08:00:00.000Z",
  actionsEnabled: true,
  jobs: [{
    jobId: "daily:report",
    expression: "0 8 * * *",
    timezone: "Europe/Amsterdam",
    conversationId: "cron:daily:report",
    configured: true,
    declaredEnabled: true,
    effectiveEnabled: true,
    nextRunAt: "2026-08-15T06:00:00.000Z",
    health: "healthy",
    threadId: cronThread.id,
  }],
  ...overrides,
});

const detail = (threadSummary = cronThread, text = "first"): ThreadDetail => ({
  thread: threadSummary,
  messages: [{
    id: `message-${text}`,
    threadId: threadSummary.id,
    role: "assistant",
    parts: [{ type: "text", text }],
    attachments: [],
    createdAt: "2026-08-14T08:00:00.000Z",
    updatedAt: "2026-08-14T08:00:00.000Z",
    status: "complete",
  }],
});

describe("ConsoleStoreProvider integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    FakeEventSource.latest = undefined;
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.mocked(api.bootstrap).mockResolvedValue(
      bootstrap([
        agent("alpha", { label: "Alpha" }),
        agent("beta", { label: "Beta" }),
      ], []),
    );
    vi.mocked(api.agentSkills).mockResolvedValue({ status: "unsupported", items: [] });
    vi.mocked(api.threads).mockResolvedValue({ threads: [] });
    vi.mocked(api.messages).mockResolvedValue({ messages: [] });
    vi.mocked(api.cronRuns).mockResolvedValue({ runs: [] });
  });

  afterEach(() => {
    resetServerClock();
    vi.unstubAllGlobals();
  });

  it("keeps the server's clock from the stamp on every event", async () => {
    await renderStore();
    const before = Date.now();
    act(() => FakeEventSource.latest?.emit("agents.changed", {
      id: "event-clock",
      version: 1,
      type: "agents.changed",
      at: new Date(before - 3_000).toISOString(),
    }));
    const drift = Date.now() - serverNow();
    expect(drift).toBeGreaterThanOrEqual(3_000);
    expect(drift).toBeLessThan(3_500);
  });

  it("sends authored draft run choices atomically with thread creation", async () => {
    localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, "alpha");
    vi.mocked(api.createThread).mockResolvedValue(thread("created", "alpha", {
      runModel: "provider/model",
      runEffort: "high",
    }));
    const store = await renderStore();

    act(() => {
      store.current.setModel("provider/model");
      store.current.setEffort("high");
    });
    await act(async () => { await store.current.createThread(); });

    expect(api.createThread).toHaveBeenCalledWith(
      "alpha",
      { model: "provider/model", effort: "high" },
      expect.any(AbortSignal),
    );
    expect(store.current.selectedThread).toMatchObject({
      id: "created",
      runModel: "provider/model",
      runEffort: "high",
    });
  });

  it("shows and snapshots blank-draft web defaults without sending redundant fields", async () => {
    localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, "alpha");
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([agent("alpha", {
      models: ["provider/config", "provider/web"],
      defaultModel: "provider/config",
      defaultEffort: "medium",
      modelOptions: {
        "provider/config": { reasoning: true, effortLevels: ["medium", "high"] },
        "provider/web": { reasoning: true, effortLevels: ["medium", "high"] },
      },
      runSettings: {
        config: { model: "provider/config", effort: "medium" },
        override: { model: "provider/web", effort: "high" },
        effective: {
          model: "provider/web",
          modelSource: "override",
          effort: "high",
          effortSource: "override",
        },
      },
    })], []));
    vi.mocked(api.createThread).mockResolvedValue(thread("created", "alpha", {
      runModel: "provider/web",
      runEffort: "high",
    }));
    const store = await renderStore();

    expect([store.current.effectiveModel, store.current.effectiveEffort])
      .toEqual(["provider/web", "high"]);
    await act(async () => { await store.current.createThread(); });

    expect(api.createThread).toHaveBeenCalledWith("alpha", {}, expect.any(AbortSignal));
    expect([store.current.selectedThread?.runModel, store.current.selectedThread?.runEffort])
      .toEqual(["provider/web", "high"]);
  });

  it("preserves field-wise omission for compatible model-only and effort-only drafts", async () => {
    const defaulted = agent("alpha", {
      models: ["provider/config", "provider/web", "provider/other"],
      defaultModel: "provider/config",
      defaultEffort: "medium",
      modelOptions: {
        "provider/config": { reasoning: true, effortLevels: ["low", "medium", "high"] },
        "provider/web": { reasoning: true, effortLevels: ["low", "medium", "high"] },
        "provider/other": { reasoning: true, effortLevels: ["low", "high"] },
      },
      runSettings: {
        config: { model: "provider/config", effort: "medium" },
        override: { model: "provider/web", effort: "high" },
        effective: {
          model: "provider/web",
          modelSource: "override",
          effort: "high",
          effortSource: "override",
        },
      },
    });
    localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, "alpha");
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([defaulted], []));
    vi.mocked(api.createThread).mockResolvedValueOnce(thread("model", "alpha", {
      runModel: "provider/other",
      runEffort: "high",
    }));
    let store = await renderStore();

    act(() => store.current.setModel("provider/other"));
    expect([store.current.effectiveModel, store.current.effectiveEffort])
      .toEqual(["provider/other", "high"]);
    await act(async () => { await store.current.createThread(); });
    expect(api.createThread).toHaveBeenLastCalledWith(
      "alpha",
      { model: "provider/other" },
      expect.any(AbortSignal),
    );

    cleanupDom();
    localStorage.clear();
    localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, "alpha");
    window.history.replaceState(null, "", "/");
    vi.mocked(api.createThread).mockResolvedValueOnce(thread("effort", "alpha", {
      runModel: "provider/web",
      runEffort: "low",
    }));
    store = await renderStore();
    act(() => store.current.setEffort("low"));
    expect([store.current.effectiveModel, store.current.effectiveEffort])
      .toEqual(["provider/web", "low"]);
    await act(async () => { await store.current.createThread(); });
    expect(api.createThread).toHaveBeenLastCalledWith(
      "alpha",
      { effort: "low" },
      expect.any(AbortSignal),
    );
  });

  it("sends explicit null only for an authored reset or incompatible inherited effort", async () => {
    localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, "alpha");
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([agent("alpha", {
      models: ["provider/config", "provider/web", "provider/low-only"],
      defaultModel: "provider/config",
      modelOptions: {
        "provider/config": { reasoning: true, effortLevels: ["low", "high"] },
        "provider/web": { reasoning: true, effortLevels: ["low", "high"] },
        "provider/low-only": { reasoning: true, effortLevels: ["low"] },
      },
      runSettings: {
        config: { model: "provider/config" },
        override: { model: "provider/web", effort: "high" },
        effective: {
          model: "provider/web",
          modelSource: "override",
          effort: "high",
          effortSource: "override",
        },
      },
    })], []));
    vi.mocked(api.createThread).mockResolvedValue(thread("created", "alpha", {
      runModel: "provider/low-only",
      runEffort: null,
    }));
    const store = await renderStore();

    act(() => store.current.setModel("provider/low-only"));
    await act(async () => { await store.current.createThread(); });
    expect(api.createThread).toHaveBeenCalledWith(
      "alpha",
      { model: "provider/low-only", effort: null },
      expect.any(AbortSignal),
    );
  });

  it("distinguishes an explicit blank draft field from web-default inheritance", async () => {
    localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, "alpha");
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([agent("alpha", {
      models: ["provider/config", "provider/web"],
      defaultModel: "provider/config",
      defaultEffort: "medium",
      modelOptions: {
        "provider/config": { reasoning: true, effortLevels: ["medium", "high"] },
        "provider/web": { reasoning: true, effortLevels: ["medium", "high"] },
      },
      runSettings: {
        config: { model: "provider/config", effort: "medium" },
        override: { model: "provider/web", effort: "high" },
        effective: {
          model: "provider/web",
          modelSource: "override",
          effort: "high",
          effortSource: "override",
        },
      },
    })], []));
    vi.mocked(api.createThread).mockResolvedValue(thread("created", "alpha", {
      runModel: null,
      runEffort: "high",
    }));
    const store = await renderStore();

    act(() => store.current.setModel(""));
    expect([store.current.effectiveModel, store.current.effectiveEffort])
      .toEqual(["provider/config", "high"]);
    expect(store.current.hasRunOverride).toBe(true);
    await act(async () => { await store.current.createThread(); });
    expect(api.createThread).toHaveBeenCalledWith(
      "alpha",
      { model: null },
      expect.any(AbortSignal),
    );
  });

  it("keeps an existing thread on its snapshot while web defaults change", async () => {
    localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, "alpha");
    const existing = thread("existing", "alpha", {
      runModel: "provider/existing",
      runEffort: "low",
    });
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([agent("alpha", {
      models: ["provider/config", "provider/web", "provider/existing"],
      defaultModel: "provider/config",
      defaultEffort: "medium",
      runSettings: {
        config: { model: "provider/config", effort: "medium" },
        override: { model: "provider/web", effort: "high" },
        effective: {
          model: "provider/web",
          modelSource: "override",
          effort: "high",
          effortSource: "override",
        },
      },
    })], [existing], existing.id));
    vi.mocked(api.thread).mockResolvedValue({ thread: existing, messages: [] });
    const store = await renderStore();

    expect([store.current.effectiveModel, store.current.effectiveEffort])
      .toEqual(["provider/existing", "low"]);
  });

  it("applies server-authoritative agent default save and revert responses", async () => {
    localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, "alpha");
    vi.mocked(api.setAgentRunDefaults).mockResolvedValue(agent("alpha", {
      label: "Alpha",
      runSettings: {
        config: { model: "provider/model" },
        override: { effort: "high" },
        effective: {
          model: "provider/model",
          modelSource: "config",
          effort: "high",
          effortSource: "override",
        },
      },
    }));
    vi.mocked(api.clearAgentRunDefaults).mockResolvedValue(agent("alpha", { label: "Alpha" }));
    const store = await renderStore();

    await act(async () => { await store.current.setAgentRunDefaults(null, "high"); });
    expect(store.current.selectedAgent?.runSettings.override).toEqual({ effort: "high" });
    await act(async () => { await store.current.clearAgentRunDefaults(); });
    expect(store.current.selectedAgent?.runSettings.override).toBeNull();
  });

  it("applies the returned pin state and moves the agent into the favorite group", async () => {
    vi.mocked(api.patchAgent).mockResolvedValue(agent("beta", {
      label: "Beta",
      pinned: true,
    }));
    const store = await renderStore();

    await act(async () => store.current.setAgentPinned("beta", true));

    expect(api.patchAgent).toHaveBeenCalledWith("beta", true);
    expect(store.current.agents.map((item) => [item.sourceId, item.pinned])).toEqual([
      ["beta", true],
      ["alpha", false],
    ]);
    expect(store.current.actionError).toBeNull();
  });

  it("keeps the pin the PATCH returned without asking the server again", async () => {
    // The PATCH answers with the agent row it just wrote, and the store applies
    // it. The bootstrap that used to follow re-read every agent and every
    // conversation to learn one boolean this tab already had.
    vi.mocked(api.patchAgent).mockResolvedValue(agent("beta", {
      label: "Beta",
      pinned: true,
    }));
    const store = await renderStore();

    await act(async () => store.current.setAgentPinned("beta", true));
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 400); }); });

    expect(api.bootstrap).toHaveBeenCalledTimes(1);
    expect(store.current.agents.map((item) => [item.sourceId, item.pinned])).toEqual([
      ["beta", true],
      ["alpha", false],
    ]);
  });

  it("keeps authoritative state unchanged and exposes a failed mutation", async () => {
    vi.mocked(api.patchAgent).mockRejectedValue(new Error("pin unavailable"));
    const store = await renderStore();

    await act(async () => {
      await expect(store.current.setAgentPinned("beta", true)).rejects.toThrow(
        "pin unavailable",
      );
    });

    expect(store.current.agents.map((item) => item.pinned)).toEqual([false, false]);
    expect(store.current.actionError).toBe("pin unavailable");
  });

  it("ignores an obsolete registry response after the active agent changes", async () => {
    let resolveAlpha!: (registry: AgentSkillRegistry) => void;
    vi.mocked(api.agentSkills).mockImplementation(async (sourceId) => {
      if (sourceId === "alpha") {
        return await new Promise<AgentSkillRegistry>((resolve) => { resolveAlpha = resolve; });
      }
      return {
        status: "ready",
        items: [{
          name: "beta-skill",
          description: "For Beta",
          availability: "on-demand",
          reference: "$beta-skill",
        }],
        total: 1,
      };
    });
    const store = await renderStore();
    await waitFor(() => expect(api.agentSkills).toHaveBeenCalledWith("alpha", expect.any(AbortSignal)));

    act(() => store.current.selectAgent("beta"));
    await waitFor(() => expect(store.current.skillRegistry).toMatchObject({
      status: "ready",
      items: [{ name: "beta-skill" }],
    }));
    await act(async () => {
      resolveAlpha({
        status: "ready",
        items: [{
          name: "alpha-skill",
          description: "For Alpha",
          availability: "inlined",
          reference: "$alpha-skill",
        }],
        total: 1,
      });
      await Promise.resolve();
    });

    expect(store.current.selectedAgentId).toBe("beta");
    expect(store.current.skillRegistry.items[0]?.name).toBe("beta-skill");
  });

  it("refreshes on agents.changed and marks the last good snapshot stale on disconnect", async () => {
    vi.mocked(api.agentSkills)
      .mockResolvedValueOnce({
        status: "ready",
        items: [{
          name: "first",
          description: "First version",
          availability: "inlined",
          reference: "$first",
        }],
        total: 1,
      })
      .mockResolvedValue({
        status: "ready",
        items: [{
          name: "second",
          description: "Second version",
          availability: "on-demand",
          reference: "$second",
        }],
        total: 1,
      });
    const store = await renderStore();
    await waitFor(() => expect(store.current.skillRegistry.items[0]?.name).toBe("first"));

    act(() => FakeEventSource.latest?.emit("agents.changed", {
      id: "event-1",
      version: 1,
      type: "agents.changed",
      at: "2026-08-13T08:00:00.000Z",
    }));
    await waitFor(() => expect(store.current.skillRegistry.items[0]?.name).toBe("second"));

    act(() => FakeEventSource.latest?.onerror?.(new Event("error")));
    await waitFor(() => expect(store.current.skillRegistry).toMatchObject({
      status: "stale",
      items: [{ name: "second" }],
    }));

    act(() => store.current.selectAgent("beta"));
    await waitFor(() => expect(store.current.skillRegistry).toEqual({
      status: "loading",
      items: [],
    }));
  });

  it("dispatches push acknowledgements without a redundant bootstrap refresh", async () => {
    await renderStore();
    const pending = vi.fn();
    window.addEventListener("mono-agent:push-pending", pending);
    try {
      await act(async () => {
        FakeEventSource.latest?.emit("push.pending", {
          version: 1,
          type: "push.pending",
          payload: { eventId: "event-1", threadId: "thread-1", ackToken: "token" },
        });
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 350));
      });
      expect(pending).toHaveBeenCalledTimes(1);
      expect(api.bootstrap).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("mono-agent:push-pending", pending);
    }
  });

  it("restores a stable source-qualified cron route from the bounded bootstrap", async () => {
    window.history.replaceState(null, "", cronChannelPath("alpha", "daily:report"));
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([
      agent("alpha", { cron: { read: true, actions: true } }),
    ], [cronThread]));
    vi.mocked(api.threads).mockResolvedValue({ threads: [cronThread] });
    vi.mocked(api.thread).mockResolvedValue(detail());
    vi.mocked(api.cronOverview).mockResolvedValue(cronOverview());

    const store = await renderStore();

    await waitFor(() => expect(store.current.selectedThreadId).toBe(cronThread.id));
    expect(store.current.selectedAgentId).toBe("alpha");
    expect(store.current.selectedThread?.canSend).toBe(false);
    expect(window.location.pathname).toBe("/agents/alpha/cron/daily%3Areport");
  });

  it("resolves a cron route whose channel is outside the bootstrap window", async () => {
    window.history.replaceState(null, "", cronChannelPath("alpha", "daily:report"));
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([
      agent("alpha", { cron: { read: true, actions: false } }),
    ], []));
    vi.mocked(api.cronOverview).mockResolvedValue(cronOverview({ actionsEnabled: false }));
    vi.mocked(api.thread).mockResolvedValue(detail());

    const store = await renderStore();

    await waitFor(() => expect(store.current.selectedThreadId).toBe(cronThread.id));
    expect(api.thread).toHaveBeenCalledWith(cronThread.id, expect.any(AbortSignal));
    expect(window.location.pathname).toBe("/agents/alpha/cron/daily%3Areport");
  });

  it("fetches and canonicalizes an out-of-window thread before mutating it", async () => {
    const canonical = thread("canonical-thread", "alpha", { archivedAt: null });
    vi.mocked(api.thread).mockResolvedValue({ thread: canonical, messages: [] });
    vi.mocked(api.patchThread).mockResolvedValue({
      ...canonical,
      archivedAt: "2026-08-14T09:00:00.000Z",
    });
    const store = await renderStore();

    await act(async () => store.current.archiveThread("redirected-legacy-id"));

    expect(api.thread).toHaveBeenCalledWith("redirected-legacy-id", expect.any(AbortSignal));
    expect(api.patchThread).toHaveBeenCalledWith(
      "canonical-thread",
      { archived: true },
      expect.any(AbortSignal),
    );
  });

  it("converges a selected cron feed on a live event without a manual refresh", async () => {
    window.history.replaceState(null, "", cronChannelPath("alpha", "daily:report"));
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([
      agent("alpha", { cron: { read: true, actions: true } }),
    ], [cronThread]));
    vi.mocked(api.threads).mockResolvedValue({ threads: [cronThread] });
    vi.mocked(api.cronOverview).mockResolvedValue(cronOverview());
    let currentDetail = detail(cronThread, "first");
    vi.mocked(api.thread).mockImplementation(async () => currentDetail);
    const store = await renderStore();
    await waitFor(() => expect(store.current.detail?.messages[0]?.parts).toEqual([
      { type: "text", text: "first" },
    ]));
    const initialRunReads = vi.mocked(api.cronRuns).mock.calls.length;

    currentDetail = detail(cronThread, "answered elsewhere");
    act(() => FakeEventSource.latest?.emit("cron.changed", {
      id: "event-cron-converged",
      version: 1,
      type: "cron.changed",
      at: "2026-08-14T09:00:00.000Z",
      payload: { sourceId: "alpha" },
    }));

    await waitFor(() => expect(store.current.detail?.messages[0]?.parts).toEqual([
      { type: "text", text: "answered elsewhere" },
    ]));
    expect(vi.mocked(api.cronRuns).mock.calls.length).toBeGreaterThan(initialRunReads);
  });

  it("keeps an unrelated mutation error through a successful periodic cron refresh", async () => {
    window.history.replaceState(null, "", cronChannelPath("alpha", "daily:report"));
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([
      agent("alpha", { cron: { read: true, actions: true } }),
    ], [cronThread]));
    vi.mocked(api.threads).mockResolvedValue({ threads: [cronThread] });
    vi.mocked(api.thread).mockResolvedValue(detail());
    vi.mocked(api.cronOverview).mockResolvedValue(cronOverview());
    vi.mocked(api.patchAgent).mockRejectedValue(new Error("pin mutation failed"));
    const store = await renderStore();
    await waitFor(() => expect(store.current.selectedThreadId).toBe(cronThread.id));

    await act(async () => {
      await expect(store.current.setAgentPinned("alpha", true)).rejects.toThrow("pin mutation failed");
    });
    expect(store.current.actionError).toBe("pin mutation failed");
    await act(async () => store.current.refreshCron());
    expect(store.current.cronError).toBeNull();
    expect(store.current.actionError).toBe("pin mutation failed");
  });

  it("replaces the selected canonical run message after loading activity detail", async () => {
    window.history.replaceState(null, "", cronChannelPath("alpha", "daily:report"));
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([
      agent("alpha", { cron: { read: true, actions: true } }),
    ], [cronThread]));
    vi.mocked(api.threads).mockResolvedValue({ threads: [cronThread] });
    vi.mocked(api.thread).mockResolvedValue(detail(cronThread, "compact"));
    vi.mocked(api.cronOverview).mockResolvedValue(cronOverview());
    const detailedMessage = {
      ...detail(cronThread, "compact").messages[0]!,
      parts: [
        { type: "text" as const, text: "selected detail" },
        {
          type: "telemetry" as const,
          event: "cron_run",
          data: { runId: "cron:daily:report:one", activityLoaded: true, eventsTruncated: true },
        },
      ],
    };
    vi.mocked(api.cronRun).mockResolvedValue(detailedMessage);
    const store = await renderStore();
    await waitFor(() => expect(store.current.selectedThreadId).toBe(cronThread.id));

    await act(async () => store.current.loadCronRunActivity("cron:daily:report:one"));

    expect(api.cronRun).toHaveBeenCalledWith("alpha", "daily:report", "cron:daily:report:one");
    expect(store.current.detail?.messages[0]?.parts).toEqual(detailedMessage.parts);
    expect(store.current.cronError).toBeNull();
  });

  it("loads older agent-owned cron pages into the canonical message feed", async () => {
    window.history.replaceState(null, "", cronChannelPath("alpha", "daily:report"));
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([
      agent("alpha", { cron: { read: true, actions: true } }),
    ], [cronThread]));
    vi.mocked(api.threads).mockResolvedValue({ threads: [cronThread] });
    vi.mocked(api.cronOverview).mockResolvedValue(cronOverview());
    vi.mocked(api.thread).mockResolvedValue(detail());
    vi.mocked(api.cronRuns)
      .mockResolvedValueOnce({ runs: [], nextCursor: "older-page" })
      .mockResolvedValue({
        runs: [],
        messages: [{
          id: "message-older",
          threadId: cronThread.id,
          role: "assistant",
          parts: [{ type: "text", text: "older" }],
          attachments: [],
          createdAt: "2026-08-13T08:00:00.000Z",
          updatedAt: "2026-08-13T08:00:00.000Z",
          status: "complete",
        }],
      });
    const store = await renderStore();
    await waitFor(() => expect(store.current.hasOlderMessages).toBe(true));

    await act(async () => store.current.loadOlderMessages());

    expect(api.cronRuns).toHaveBeenLastCalledWith("alpha", "daily:report", "older-page");
    expect(store.current.detail?.messages.map((message) => message.id)).toEqual([
      "message-older",
      "message-first",
    ]);
    expect(store.current.hasOlderMessages).toBe(false);
  });

  it("keeps a cached cron channel read-only when paired with an old agent", async () => {
    window.history.replaceState(null, "", cronChannelPath("alpha", "daily:report"));
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([agent("alpha")], [cronThread]));
    vi.mocked(api.threads).mockResolvedValue({ threads: [cronThread] });
    vi.mocked(api.thread).mockResolvedValue(detail());

    const store = await renderStore();

    await waitFor(() => expect(store.current.selectedThreadId).toBe(cronThread.id));
    expect(store.current.cronOverview).toBeNull();
    expect(api.cronOverview).not.toHaveBeenCalled();
    expect(store.current.selectedThread?.canSend).toBe(false);
  });

  describe("legacy run-preference migration", () => {
    const alphaThread = thread("alpha-thread", "alpha");

    const seedLocalOverride = (sourceId: string, threadId: string | null) => {
      localStorage.setItem(RUN_PREFERENCES_STORAGE_KEY, JSON.stringify({
        [preferenceKeyForThread(sourceId, threadId)]: {
          model: "anthropic:opus-5",
          effort: "high",
        },
      }));
    };

    const seedTwoAgentsOneThread = () => {
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })],
        [alphaThread],
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [alphaThread] });
      vi.mocked(api.thread).mockResolvedValue(detail(alphaThread, "hello"));
    };

    const settle = async () => {
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    };

    it("adopts a browser-local override into the thread it was recorded for", async () => {
      seedTwoAgentsOneThread();
      seedLocalOverride("alpha", "alpha-thread");
      vi.mocked(api.patchThread).mockResolvedValue({
        ...alphaThread,
        runModel: "anthropic:opus-5",
        runEffort: "high",
      });

      const store = await renderStore();

      // Conditional: the server applies it only while the conversation still
      // has no override, so a write from another tab cannot be overwritten by
      // this stale local value.
      await waitFor(() => expect(api.patchThread).toHaveBeenCalledWith(
        "alpha-thread",
        { model: "anthropic:opus-5", effort: "high", ifRunConfigUnset: true },
        expect.any(AbortSignal),
      ));
      await waitFor(() => expect(store.current.selectedThread?.runModel).toBe("anthropic:opus-5"));
      expect(localStorage.getItem(RUN_PREFERENCES_STORAGE_KEY)).toBe("{}");
    });

    it("never adopts one agent's override onto the previous agent's thread", async () => {
      // `selectedThread` falls back to `detail?.thread` when the selection
      // resolves to nothing, so switching to an agent with no conversation
      // still pointed at the PREVIOUS agent's thread while `preferenceKey`
      // already named the new one -- and the adoption PATCH landed there.
      seedTwoAgentsOneThread();
      seedLocalOverride("beta", null);

      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThread?.id).toBe("alpha-thread"));

      act(() => { store.current.selectAgent("beta"); });
      await waitFor(() => expect(store.current.selectedAgentId).toBe("beta"));
      await settle();

      expect(api.patchThread).not.toHaveBeenCalled();
    });

    it("abandons the adoption when the operator changes effort inside its read", async () => {
      // The migration re-reads the thread before patching. A selection made in
      // that window is already on its way to the server, so restoring the
      // browser-local value afterwards would silently undo it.
      seedTwoAgentsOneThread();
      seedLocalOverride("alpha", "alpha-thread");
      let releaseFreshRead: (() => void) | undefined;
      const freshRead = new Promise<void>((resolve) => { releaseFreshRead = resolve; });
      let threadReads = 0;
      vi.mocked(api.thread).mockImplementation(async () => {
        threadReads += 1;
        // Read 1 is the detail load; read 2 is the migration's re-check.
        if (threadReads > 1) await freshRead;
        return detail(alphaThread, "hello");
      });
      vi.mocked(api.patchThread).mockResolvedValue({
        ...alphaThread,
        runModel: null,
        runEffort: "low",
      });

      const store = await renderStore();
      await waitFor(() => expect(threadReads).toBeGreaterThan(1));

      act(() => { store.current.setEffort("low"); });
      releaseFreshRead?.();
      await waitFor(() => expect(api.patchThread).toHaveBeenCalledWith(
        "alpha-thread",
        { effort: "low" },
        expect.any(AbortSignal),
      ));
      await settle();

      // Exactly one write reached the server, and it is the operator's.
      expect(api.patchThread).toHaveBeenCalledTimes(1);
      expect(store.current.selectedThread?.runEffort).toBe("low");
    });

    it("keeps a thread's migration waiting on ITS own writes, not another thread's", async () => {
      // The write generation used to be one shared counter, so any override
      // write anywhere read as a write to the migrating conversation. Changing
      // thread B made A's migration abandon: it dropped A's browser-local
      // preference and sent no PATCH, so the preference was deleted outright
      // while A's server override stayed null.
      const betaThread = thread("beta-thread", "beta");
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })],
        [alphaThread, betaThread],
      ));
      vi.mocked(api.threads).mockImplementation(async (sourceId) => ({
        threads: sourceId === "alpha" ? [alphaThread] : [betaThread],
      }));
      seedLocalOverride("alpha", "alpha-thread");
      let releaseAlphaRead: (() => void) | undefined;
      const alphaRead = new Promise<void>((resolve) => { releaseAlphaRead = resolve; });
      let alphaReads = 0;
      vi.mocked(api.thread).mockImplementation(async (threadId) => {
        if (threadId === "alpha-thread") {
          alphaReads += 1;
          // Read 1 is the detail load; read 2 is the migration's re-check.
          if (alphaReads > 1) await alphaRead;
          return detail(alphaThread, "hello");
        }
        return detail(betaThread, "hi");
      });
      vi.mocked(api.patchThread).mockImplementation(async (threadId, patch) => ({
        ...(threadId === "alpha-thread" ? alphaThread : betaThread),
        runModel: "model" in patch ? patch.model ?? null : null,
        runEffort: "effort" in patch ? patch.effort ?? null : null,
      }));

      const store = await renderStore();
      await waitFor(() => expect(alphaReads).toBeGreaterThan(1));

      act(() => { store.current.selectAgent("beta"); });
      await waitFor(() => expect(store.current.selectedThreadId).toBe("beta-thread"));
      act(() => { store.current.setEffort("low"); });
      await waitFor(() => expect(api.patchThread).toHaveBeenCalledWith(
        "beta-thread",
        { effort: "low" },
        expect.any(AbortSignal),
      ));

      releaseAlphaRead?.();
      // Alpha's own preference is still adopted: nothing was written to alpha.
      await waitFor(() => expect(api.patchThread).toHaveBeenCalledWith(
        "alpha-thread",
        { model: "anthropic:opus-5", effort: "high", ifRunConfigUnset: true },
        expect.any(AbortSignal),
      ));
      await settle();
      expect(localStorage.getItem(RUN_PREFERENCES_STORAGE_KEY)).toBe("{}");
    });

    it("sends an operator choice made after the migration PATCH only once it lands", async () => {
      // The migration's PATCH is already in flight, so the generation guard is
      // behind us: only ordering can keep the operator's choice last. Released
      // concurrently, the adopted legacy value landed after it and became the
      // conversation's final state.
      seedTwoAgentsOneThread();
      seedLocalOverride("alpha", "alpha-thread");
      let releaseMigrationPatch: (() => void) | undefined;
      const migrationPatch = new Promise<void>((resolve) => { releaseMigrationPatch = resolve; });
      vi.mocked(api.patchThread).mockImplementation(async (_threadId, patch) => {
        if ("ifRunConfigUnset" in patch) {
          await migrationPatch;
          return { ...alphaThread, runModel: "anthropic:opus-5", runEffort: "high" };
        }
        return {
          ...alphaThread,
          runModel: null,
          runEffort: "effort" in patch ? patch.effort ?? null : null,
        };
      });

      const store = await renderStore();
      await waitFor(() => expect(api.patchThread).toHaveBeenCalledTimes(1));

      act(() => { store.current.setEffort("low"); });
      await settle();
      // Still queued: issuing it now would let the adoption land last.
      expect(api.patchThread).toHaveBeenCalledTimes(1);

      releaseMigrationPatch?.();
      await waitFor(() => expect(api.patchThread).toHaveBeenCalledTimes(2));
      await settle();
      expect(vi.mocked(api.patchThread).mock.calls[1]?.[1]).toEqual({ effort: "low" });
      expect(store.current.selectedThread?.runEffort).toBe("low");
      expect(store.current.selectedThread?.runModel).toBeNull();
    });

    it("adopts the override another tab wrote instead of overwriting it", async () => {
      // The fresh read is still a projection: another tab can write between it
      // and the PATCH. The write is therefore conditional, and the server
      // hands back whatever it kept -- which is what this tab must show.
      seedTwoAgentsOneThread();
      seedLocalOverride("alpha", "alpha-thread");
      vi.mocked(api.patchThread).mockResolvedValue({
        ...alphaThread,
        runModel: "anthropic:sonnet-5",
        runEffort: "low",
      });

      const store = await renderStore();

      await waitFor(() => expect(api.patchThread).toHaveBeenCalledWith(
        "alpha-thread",
        { model: "anthropic:opus-5", effort: "high", ifRunConfigUnset: true },
        expect.any(AbortSignal),
      ));
      await waitFor(() => expect(store.current.selectedThread?.runModel).toBe("anthropic:sonnet-5"));
      expect(store.current.selectedThread?.runEffort).toBe("low");
      expect(localStorage.getItem(RUN_PREFERENCES_STORAGE_KEY)).toBe("{}");
    });

    it("does not resurrect a deleted conversation with a late migration response", async () => {
      seedTwoAgentsOneThread();
      seedLocalOverride("alpha", "alpha-thread");
      let releaseFreshRead: (() => void) | undefined;
      const freshRead = new Promise<void>((resolve) => { releaseFreshRead = resolve; });
      let threadReads = 0;
      vi.mocked(api.thread).mockImplementation(async () => {
        threadReads += 1;
        if (threadReads > 1) await freshRead;
        return detail(alphaThread, "hello");
      });
      vi.mocked(api.deleteThread).mockResolvedValue(undefined);
      vi.mocked(api.patchThread).mockResolvedValue({
        ...alphaThread,
        runModel: "anthropic:opus-5",
        runEffort: "high",
      });

      const store = await renderStore();
      await waitFor(() => expect(threadReads).toBeGreaterThan(1));

      await act(async () => { await store.current.deleteThread("alpha-thread"); });
      expect(store.current.threads.map((item) => item.id)).toEqual([]);

      releaseFreshRead?.();
      await settle();
      // The adoption answered for a conversation the server no longer has, and
      // `mergeThreads` would have put it back in the sidebar.
      expect(store.current.threads.map((item) => item.id)).toEqual([]);
      // It must not have written to it either.
      expect(api.patchThread).not.toHaveBeenCalled();
    });
  });

  describe("per-conversation write ordering", () => {
    const alphaThread = thread("alpha-thread", "alpha");

    const seedOneThread = () => {
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [alphaThread],
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [alphaThread] });
      vi.mocked(api.thread).mockResolvedValue(detail(alphaThread, "hello"));
    };

    /**
     * Records what the server SAW, in order, and lets each call be released by
     * hand. It never looks at a request body: an earlier chain that serialized
     * only the conditional migration write passed the previous ordering test
     * once its mock recognised the old request shape, so nothing here is
     * allowed to know what any of these writes looks like.
     */
    const patchRecorder = () => {
      const order: string[] = [];
      const gates: (() => void)[] = [];
      let issued = 0;
      vi.mocked(api.patchThread).mockImplementation(async (_threadId, patch) => {
        const index = issued;
        issued += 1;
        order.push(`start:${String(index)}`);
        await new Promise<void>((resolve) => { gates[index] = resolve; });
        order.push(`end:${String(index)}`);
        return {
          ...alphaThread,
          ...("title" in patch ? { title: patch.title ?? alphaThread.title } : {}),
          ...("archived" in patch
            ? { archivedAt: patch.archived === true ? "2026-08-14T09:00:00.000Z" : null }
            : {}),
        };
      });
      return { order, release: (index: number) => { gates[index]?.(); } };
    };

    it("holds a rename and an archive to the order they were issued", async () => {
      // Both PATCH the same row and both apply the COMPLETE thread the server
      // returns, so released together the older response overwrites the newer
      // state: holding the rename until the archive had completed put
      // `archivedAt` back to null.
      seedOneThread();
      const { order, release } = patchRecorder();
      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));

      const renamed = store.current.renameThread("alpha-thread", "Renamed");
      const archived = store.current.archiveThread("alpha-thread");
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
      expect(order).toEqual(["start:0"]);

      await act(async () => {
        release(0);
        await renamed;
      });
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
      expect(order).toEqual(["start:0", "end:0", "start:1"]);

      await act(async () => {
        release(1);
        await archived;
      });
      expect(order).toEqual(["start:0", "end:0", "start:1", "end:1"]);
      const [, first, second] = order;
      expect([first, second]).toEqual(["end:0", "start:1"]);
      expect(store.current.threads.find((item) => item.id === "alpha-thread")?.archivedAt)
        .toBe("2026-08-14T09:00:00.000Z");
    });

    it("does not start a turn until the override writes issued before it have landed", async () => {
      // A blank selection is omitted from the turn POST and the server then
      // falls back to the conversation's PERSISTED override, so a
      // reset-then-send ran the very override the reset had just cleared.
      seedOneThread();
      const { order, release } = patchRecorder();
      vi.mocked(api.startTurn).mockImplementation(async () => {
        order.push("startTurn");
        return { thread: alphaThread, turn: { id: "turn-1", status: "running" } };
      });
      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));

      act(() => { store.current.resetRunOverride(); });
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
      expect(order).toEqual(["start:0"]);

      const sent = store.current.sendTurn({ text: "go" });
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
      expect(api.startTurn).not.toHaveBeenCalled();

      await act(async () => {
        release(0);
        await sent;
      });
      expect(order).toEqual(["start:0", "end:0", "startTurn"]);
    });
  });

  describe("deleted-conversation tombstones", () => {
    const alphaThread = thread("alpha-thread", "alpha");

    /**
     * A full snapshot refresh, the way the console still does one: discovery
     * reported a change, so the bootstrap is re-read. Nothing else asks for a
     * bootstrap any more -- see the event table.
     */
    const refresh = async (id: string) => {
      act(() => FakeEventSource.latest?.emit("agents.changed", {
        id,
        version: 1,
        type: "agents.changed",
        at: "2026-08-14T09:00:00.000Z",
      }));
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 400); }); });
    };

    /** A listing event naming no conversation: one debounced bucket page. */
    const revalidateThreadList = async (id: string) => {
      act(() => FakeEventSource.latest?.emit("threads.changed", {
        id,
        version: 1,
        type: "threads.changed",
        at: "2026-08-14T09:00:00.000Z",
      }));
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, THREAD_LIST_REVALIDATE_DEBOUNCE_MS + 200);
        });
      });
    };

    it("keeps a deleted conversation out of every response that outlived it", async () => {
      // The tombstone used to be consulted at three of eleven insertion points
      // and recorded only AFTER the delete answered. `refreshNow` issues a
      // bootstrap on every SSE event behind a 300 ms debounce, so a bootstrap
      // in flight across a delete is ordinary, not exotic.
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [alphaThread],
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [alphaThread] });
      vi.mocked(api.thread).mockResolvedValue(detail(alphaThread, "hello"));
      let releaseDelete: (() => void) | undefined;
      const deletion = new Promise<void>((resolve) => { releaseDelete = resolve; });
      vi.mocked(api.deleteThread).mockImplementation(async () => { await deletion; });

      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));

      const deleted = store.current.deleteThread("alpha-thread");
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });

      // Still in flight. A page and a bootstrap that both still list the
      // conversation land here, and neither may put it back.
      await revalidateThreadList("event-page");
      await refresh("event-1");
      expect(store.current.threads.map((item) => item.id)).toEqual([]);

      await act(async () => {
        releaseDelete?.();
        await deleted;
      });
      // And a bootstrap that answers after the delete completed is still stale.
      await refresh("event-2");
      expect(store.current.threads.map((item) => item.id)).toEqual([]);
      expect(store.current.selectedThreadId).toBeNull();
    });

    it("restores a conversation whose delete failed", async () => {
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [alphaThread],
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [alphaThread] });
      vi.mocked(api.thread).mockResolvedValue(detail(alphaThread, "hello"));
      vi.mocked(api.deleteThread).mockRejectedValue(new Error("delete failed"));

      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));

      await act(async () => {
        await expect(store.current.deleteThread("alpha-thread")).rejects.toThrow("delete failed");
      });
      await refresh("event-1");
      expect(store.current.threads.map((item) => item.id)).toEqual(["alpha-thread"]);
    });
  });

  describe("provider catalog freshness", () => {
    const withProvider = (generation: string) => agent("alpha", {
      label: "Alpha",
      generation,
      models: ["localx:one"],
      defaultModel: "localx:one",
      providers: [{ id: "localx", label: "Local X" }],
    });

    const seedCatalog = (generation: string) => {
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([withProvider(generation)], []));
      vi.mocked(api.threads).mockResolvedValue({ threads: [] });
    };

    beforeEach(() => {
      vi.mocked(api.agentModels).mockResolvedValue({
        models: [{ id: "one", name: "One", provider: "localx", providerLabel: "Local X" }],
        truncated: false,
      });
    });

    it("retains a persisted catalog-only model before its provider page loads", async () => {
      const providerOnly = agent("alpha", {
        label: "Alpha",
        generation: "gen-1",
        models: ["localx:one"],
        defaultModel: "localx:one",
        providers: [
          { id: "localx", label: "Local X" },
          { id: "openai", label: "OpenAI" },
        ],
      });
      const selected = thread("alpha-thread", "alpha", {
        runModel: "openai:gpt-x",
        runEffort: "high",
      });
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([providerOnly], [selected]));
      vi.mocked(api.threads).mockResolvedValue({ threads: [selected] });
      vi.mocked(api.thread).mockResolvedValue(detail(selected));
      vi.mocked(api.agentModels).mockResolvedValue({
        models: [{ id: "gpt-x", name: "GPT X", provider: "openai", providerLabel: "OpenAI" }],
        truncated: false,
      });

      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));
      expect(store.current.catalogByProvider.openai).toBeUndefined();
      expect(store.current.model).toBe("openai:gpt-x");
      expect(store.current.effort).toBe("high");
      expect(store.current.hasRunOverride).toBe(true);

      await act(async () => { await store.current.ensureProviderCatalog("openai"); });
      expect(store.current.model).toBe("openai:gpt-x");
      expect(store.current.effort).toBe("high");
      expect(store.current.catalogByProvider.openai?.models[0]?.name).toBe("GPT X");
    });

    it("retains a catalog-only model when its loaded provider page omits it", async () => {
      const providerOnly = agent("alpha", {
        label: "Alpha",
        generation: "gen-1",
        models: ["localx:one"],
        defaultModel: "localx:one",
        providers: [
          { id: "localx", label: "Local X" },
          { id: "openai", label: "OpenAI" },
        ],
      });
      const selected = thread("alpha-thread", "alpha", {
        runModel: "openai:gpt-x",
        runEffort: "medium",
      });
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([providerOnly], [selected]));
      vi.mocked(api.threads).mockResolvedValue({ threads: [selected] });
      vi.mocked(api.thread).mockResolvedValue(detail(selected));
      vi.mocked(api.agentModels).mockResolvedValue({ models: [], truncated: false });

      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));
      await act(async () => { await store.current.ensureProviderCatalog("openai"); });

      expect(store.current.catalogByProvider.openai).toMatchObject({
        status: "loaded",
        models: [],
      });
      expect(store.current.model).toBe("openai:gpt-x");
      expect(store.current.effort).toBe("medium");
      expect(store.current.effortOptions).toContain("medium");
    });

    it("refetches a provider once the agent process behind it is a different one", async () => {
      // A source id outlives the process behind it. Keyed on the id alone the
      // tab kept offering the retired generation's models until it was
      // reloaded, and the server rejected every turn that used one.
      seedCatalog("gen-1");
      const store = await renderStore();
      await act(async () => { await store.current.ensureProviderCatalog("localx"); });
      expect(api.agentModels).toHaveBeenCalledTimes(1);

      // Same source id, same everything else: only the process is new.
      await act(async () => { await store.current.ensureProviderCatalog("localx"); });
      expect(api.agentModels).toHaveBeenCalledTimes(1);

      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([withProvider("gen-2")], []));
      act(() => FakeEventSource.latest?.emit("agents.changed", {
        id: "event-1",
        version: 1,
        type: "agents.changed",
        at: "2026-08-14T09:00:00.000Z",
      }));
      await waitFor(() => expect(store.current.selectedAgent?.generation).toBe("gen-2"));
      await waitFor(() => expect(store.current.catalogByProvider.localx).toBeUndefined());

      await act(async () => { await store.current.ensureProviderCatalog("localx"); });
      expect(api.agentModels).toHaveBeenCalledTimes(2);
    });

    it("revalidates a provider once its page is older than the catalog lifetime", async () => {
      // Nothing pushes a catalog change, and a live process can gain or lose
      // models without ever restarting -- so generation alone cannot see it.
      seedCatalog("gen-1");
      const store = await renderStore();
      await act(async () => { await store.current.ensureProviderCatalog("localx"); });
      expect(api.agentModels).toHaveBeenCalledTimes(1);

      // Fresh: asking again must not put the same page back on the wire.
      await act(async () => { await store.current.ensureProviderCatalog("localx"); });
      expect(api.agentModels).toHaveBeenCalledTimes(1);

      const realNow = Date.now;
      const shifted = realNow() + CATALOG_TTL_MS + 1;
      vi.spyOn(Date, "now").mockImplementation(() => shifted);
      try {
        await act(async () => { await store.current.ensureProviderCatalog("localx"); });
      } finally {
        vi.mocked(Date.now).mockRestore();
      }
      expect(api.agentModels).toHaveBeenCalledTimes(2);
    });

    it("replaces a revalidated page instead of merging a retired model back in", async () => {
      seedCatalog("gen-1");
      const store = await renderStore();
      await act(async () => { await store.current.ensureProviderCatalog("localx"); });
      expect(store.current.catalogByProvider.localx?.models.map((item) => item.id)).toEqual(["one"]);

      vi.mocked(api.agentModels).mockResolvedValue({
        models: [{ id: "two", name: "Two", provider: "localx", providerLabel: "Local X" }],
        truncated: false,
      });
      const shifted = Date.now() + CATALOG_TTL_MS + 1;
      vi.spyOn(Date, "now").mockImplementation(() => shifted);
      try {
        await act(async () => { await store.current.ensureProviderCatalog("localx"); });
      } finally {
        vi.mocked(Date.now).mockRestore();
      }
      expect(store.current.catalogByProvider.localx?.models.map((item) => item.id)).toEqual(["two"]);
    });
  });

  describe("thread override writes", () => {
    const alphaThread = thread("alpha-thread", "alpha");

    const seedOneThread = () => {
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [alphaThread],
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [alphaThread] });
      vi.mocked(api.thread).mockResolvedValue(detail(alphaThread, "hello"));
    };

    it("serializes rapid operator choices so the newest one lands last", async () => {
      // Two choices released together raced: by delaying the first PATCH, the
      // newer selection landed first and the older landed last, becoming the
      // conversation's final server and UI state.
      seedOneThread();
      let releaseFirst: (() => void) | undefined;
      const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let patches = 0;
      vi.mocked(api.patchThread).mockImplementation(async (_threadId, patch) => {
        patches += 1;
        if (patches === 1) await first;
        return {
          ...alphaThread,
          runModel: null,
          runEffort: "effort" in patch ? patch.effort ?? null : null,
        };
      });

      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));

      act(() => { store.current.setEffort("low"); });
      act(() => { store.current.setEffort("high"); });
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      // The second choice must not be in flight while the first is unresolved.
      expect(api.patchThread).toHaveBeenCalledTimes(1);

      releaseFirst?.();
      await waitFor(() => expect(api.patchThread).toHaveBeenCalledTimes(2));
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
      expect(vi.mocked(api.patchThread).mock.calls.map((call) => call[1])).toEqual([
        { effort: "low" },
        { effort: "high" },
      ]);
      expect(store.current.selectedThread?.runEffort).toBe("high");
    });

    it("lets the next write through after one fails, instead of wedging the queue", async () => {
      // Writes to one conversation are serialized, so a failed one must hand
      // the queue on rather than keep it: every later write to that
      // conversation would be dropped, silently, behind an optimistic UI.
      seedOneThread();
      vi.mocked(api.patchThread)
        .mockRejectedValueOnce(new Error("write failed"))
        .mockResolvedValue({ ...alphaThread, runModel: null, runEffort: "high" });

      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));

      act(() => { store.current.setEffort("low"); });
      await waitFor(() => expect(store.current.actionError).toBe("write failed"));

      act(() => { store.current.setEffort("high"); });
      await waitFor(() => expect(api.patchThread).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(store.current.selectedThread?.runEffort).toBe("high"));
    });

    it("does not resurrect a conversation deleted while its write was in flight", async () => {
      // Any response can outlive the conversation it describes -- the write's
      // own result, or the rollback of a failed one. `mergeThreads` re-adds
      // whatever it is handed, so the sidebar showed a conversation the server
      // had already destroyed until the next refresh.
      seedOneThread();
      let releasePatch: (() => void) | undefined;
      const held = new Promise<void>((resolve) => { releasePatch = resolve; });
      vi.mocked(api.patchThread).mockImplementation(async () => {
        await held;
        return { ...alphaThread, runModel: null, runEffort: "low" };
      });
      vi.mocked(api.deleteThread).mockResolvedValue(undefined);

      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));

      act(() => { store.current.setEffort("low"); });
      await waitFor(() => expect(api.patchThread).toHaveBeenCalledTimes(1));
      await act(async () => { await store.current.deleteThread("alpha-thread"); });
      expect(store.current.threads.map((item) => item.id)).toEqual([]);

      releasePatch?.();
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
      expect(store.current.threads.map((item) => item.id)).toEqual([]);
    });
  });

  /**
   * Round 4's cluster. Every one of these is the same shape: an operation that
   * FAILS or answers LATE leaves state only the success path knows how to
   * repair. The suite that shipped with the tombstones proved the success paths
   * and the "a later refresh fixes it" paths; none of it fails against the
   * broken failure handlers, which is what makes each of these a repro rather
   * than a regression test.
   */
  describe("failed and late responses repaired where they fail", () => {
    const alphaThread = thread("alpha-thread", "alpha");
    const preferenceKey = preferenceKeyForThread("alpha", "alpha-thread");

    const settle = async () => {
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    };

    const seedOneThread = (overrides: Partial<AgentSummary> = {}) => {
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha", ...overrides })],
        [alphaThread],
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [alphaThread] });
      vi.mocked(api.thread).mockResolvedValue(detail(alphaThread, "hello"));
    };

    /** A DELETE the test releases by hand, either way. */
    const heldDelete = () => {
      let reject: ((error: Error) => void) | undefined;
      let resolve: (() => void) | undefined;
      vi.mocked(api.deleteThread).mockImplementation(async () => {
        await new Promise<void>((ok, no) => { resolve = ok; reject = no; });
      });
      return {
        fail: () => reject?.(new Error("delete failed")),
        succeed: () => resolve?.(),
      };
    };

    /**
     * A full snapshot refresh, the way the console still does one: discovery
     * reported a change, so the bootstrap is re-read. Nothing else asks for a
     * bootstrap any more -- see the event table.
     */
    const refresh = async (id: string) => {
      act(() => FakeEventSource.latest?.emit("agents.changed", {
        id,
        version: 1,
        type: "agents.changed",
        at: "2026-08-14T09:00:00.000Z",
      }));
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 400); }); });
    };

    /** A listing event naming no conversation: one debounced bucket page. */
    const revalidateThreadList = async (id: string) => {
      act(() => FakeEventSource.latest?.emit("threads.changed", {
        id,
        version: 1,
        type: "threads.changed",
        at: "2026-08-14T09:00:00.000Z",
      }));
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, THREAD_LIST_REVALIDATE_DEBOUNCE_MS + 200);
        });
      });
    };

    it("keeps the legacy run preference when the delete that tombstoned it fails", async () => {
      // P0. The migration marks the key migrated BEFORE any I/O and drops both
      // local values the moment it sees a tombstone. A DELETE that then fails
      // only forgets the tombstone: the server override is still unset, the
      // browser copy is gone, and the key is marked migrated, so nothing --
      // including a reload -- can recover what the operator chose.
      // The agent must ADVERTISE the model, or `validateRunPreference` empties
      // the stored preference on the first render and the repro would pass
      // against the broken code for the wrong reason.
      seedOneThread({ models: ["anthropic:opus-5"], defaultModel: "anthropic:opus-5" });
      localStorage.setItem(RUN_PREFERENCES_STORAGE_KEY, JSON.stringify({
        [preferenceKey]: { model: "anthropic:opus-5", effort: "high" },
      }));
      let releaseMigrationRead: (() => void) | undefined;
      const migrationRead = new Promise<void>((resolve) => { releaseMigrationRead = resolve; });
      let reads = 0;
      vi.mocked(api.thread).mockImplementation(async () => {
        reads += 1;
        // The migration's own confirming read, held open.
        if (reads > 1) await migrationRead;
        return detail(alphaThread, "hello");
      });
      const deletion = heldDelete();

      const store = await renderStore();
      await waitFor(() => expect(reads).toBeGreaterThan(1));
      expect(store.current.model).toBe("anthropic:opus-5");

      const deleted = store.current.deleteThread("alpha-thread");
      await settle();
      releaseMigrationRead?.();
      await settle();
      await act(async () => {
        deletion.fail();
        await expect(deleted).rejects.toThrow("delete failed");
      });
      await settle();

      expect(store.current.model).toBe("anthropic:opus-5");
      expect(store.current.effort).toBe("high");
      expect(JSON.parse(localStorage.getItem(RUN_PREFERENCES_STORAGE_KEY) ?? "null"))
        .toEqual({ [preferenceKey]: { model: "anthropic:opus-5", effort: "high" } });
      // It must not have written the operator's choice to the server the delete
      // failed against either -- the conversation is still theirs.
      expect(api.patchThread).not.toHaveBeenCalled();

      // And the adoption has to still be ELIGIBLE. Keeping the values while
      // leaving the key marked migrated would look identical here and still be
      // a one-way door: the preference would stay browser-local for the life of
      // the tab and never reach the conversation.
      vi.mocked(api.patchThread).mockResolvedValue({
        ...alphaThread,
        runModel: "anthropic:opus-5",
        runEffort: "high",
      });
      const later = { ...alphaThread, updatedAt: "2026-08-14T09:00:00.000Z" };
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", {
          label: "Alpha",
          models: ["anthropic:opus-5"],
          defaultModel: "anthropic:opus-5",
        })],
        [later],
      ));
      await refresh("event-1");
      await waitFor(() => expect(api.patchThread).toHaveBeenCalledWith(
        "alpha-thread",
        { model: "anthropic:opus-5", effort: "high", ifRunConfigUnset: true },
        expect.any(AbortSignal),
      ));
    });

    it("restores a conversation an overlapping refresh dropped when its delete fails", async () => {
      // P1-7. The failure handler forgets the tombstone and nothing else, so a
      // response that arrived DURING the delete -- `refreshNow` fires one on
      // every SSE event -- has already filtered the conversation out of the
      // projection and nobody puts it back. The shipped test injects a LATER
      // SSE before asserting restoration, which proves a future refresh can
      // repair it, not that the failure did.
      seedOneThread();
      const deletion = heldDelete();

      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));

      const deleted = store.current.deleteThread("alpha-thread");
      await settle();
      // The refresh carries a NEWER projection than the one the delete read.
      // Whatever the failure hands back has to be that one: restoring the
      // delete-time snapshot instead would silently roll a rename back.
      const renamed = { ...alphaThread, title: "Renamed elsewhere", revision: 2 };
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [renamed],
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [renamed] });
      vi.mocked(api.thread).mockResolvedValue(detail(renamed, "hello"));
      await refresh("event-1");
      expect(store.current.threads.map((item) => item.id)).toEqual([]);

      await act(async () => {
        deletion.fail();
        await expect(deleted).rejects.toThrow("delete failed");
      });
      await settle();
      // No further event, and no further refresh: the failure itself repairs.
      expect(store.current.threads.map((item) => item.id)).toEqual(["alpha-thread"]);
      expect(store.current.threads[0]?.title).toBe("Renamed elsewhere");
      expect(store.current.selectedThreadId).toBe("alpha-thread");
    });

    it("does not start a turn when a run-setting write issued before it failed", async () => {
      // P1-6. Queue settlement collapses fulfilment AND rejection to `void`, so
      // a send waits for a failed reset and then POSTs anyway. A blank
      // selection is omitted from that POST and the server falls back to the
      // conversation's stored override -- exactly the override the reset was
      // clearing.
      seedOneThread();
      let rejectPatch: ((error: Error) => void) | undefined;
      vi.mocked(api.patchThread).mockImplementation(async () => {
        await new Promise<never>((_ok, no) => { rejectPatch = no; });
        throw new Error("unreachable");
      });
      vi.mocked(api.startTurn).mockResolvedValue({
        thread: alphaThread,
        turn: { id: "turn-1", status: "running" },
      });

      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));

      act(() => { store.current.resetRunOverride(); });
      await settle();
      expect(api.patchThread).toHaveBeenCalledTimes(1);

      const sent = store.current.sendTurn({ text: "go" });
      await settle();
      expect(api.startTurn).not.toHaveBeenCalled();

      await act(async () => {
        rejectPatch?.(new Error("reset failed"));
        await expect(sent).rejects.toThrow();
      });
      expect(api.startTurn).not.toHaveBeenCalled();
    });

    it("still starts a turn once a later write supersedes the failed one", async () => {
      // The refusal above must not wedge the composer: a write that SUCCEEDS
      // after a failed one is the operator's newest intent and the server has
      // it, so the next send is honest.
      //
      // The superseding write is HELD across the send deliberately. Released
      // first, the queue drains before `sendTurn` asks, the settle takes its
      // nothing-outstanding path, and the test would pass even if a success
      // never cleared the failure -- which it did, until this held it open.
      seedOneThread();
      let releaseSecond: (() => void) | undefined;
      const second = new Promise<void>((resolve) => { releaseSecond = resolve; });
      let patches = 0;
      vi.mocked(api.patchThread).mockImplementation(async () => {
        patches += 1;
        if (patches === 1) throw new Error("reset failed");
        await second;
        return { ...alphaThread, runModel: null, runEffort: "high" };
      });
      vi.mocked(api.startTurn).mockResolvedValue({
        thread: alphaThread,
        turn: { id: "turn-1", status: "running" },
      });

      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));

      act(() => { store.current.resetRunOverride(); });
      await waitFor(() => expect(store.current.actionError).toBe("reset failed"));
      act(() => { store.current.setEffort("high"); });
      await waitFor(() => expect(api.patchThread).toHaveBeenCalledTimes(2));

      const sent = store.current.sendTurn({ text: "go" });
      await settle();
      expect(api.startTurn).not.toHaveBeenCalled();

      await act(async () => {
        releaseSecond?.();
        await sent;
      });
      expect(api.startTurn).toHaveBeenCalledTimes(1);
    });

    it("does not resurrect a deleted conversation with a late create response", async () => {
      // P1-8. The server commits and emits before the POST answers, so the SSE
      // can expose a conversation the create call has not returned yet. The
      // create then prepends its response with neither `admitThreads` nor a
      // dedup, so a delete made in that window is undone by the create's own
      // answer.
      const fresh = thread("fresh-thread", "alpha");
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([agent("alpha", { label: "Alpha" })], []));
      vi.mocked(api.threads).mockResolvedValue({ threads: [] });
      vi.mocked(api.thread).mockResolvedValue(detail(fresh, "hello"));
      let releaseCreate: (() => void) | undefined;
      const creation = new Promise<void>((resolve) => { releaseCreate = resolve; });
      vi.mocked(api.createThread).mockImplementation(async () => {
        await creation;
        return fresh;
      });
      vi.mocked(api.deleteThread).mockResolvedValue(undefined);

      const store = await renderStore();
      const pending = store.current.createThread();
      await settle();

      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([agent("alpha", { label: "Alpha" })], [fresh]));
      vi.mocked(api.threads).mockResolvedValue({ threads: [fresh] });
      await refresh("event-1");
      expect(store.current.threads.map((item) => item.id)).toEqual(["fresh-thread"]);

      await act(async () => { await store.current.deleteThread("fresh-thread"); });
      expect(store.current.threads.map((item) => item.id)).toEqual([]);

      await act(async () => {
        releaseCreate?.();
        await expect(pending).rejects.toThrow(/deleted/iu);
      });
      expect(store.current.threads.map((item) => item.id)).toEqual([]);
      expect(store.current.selectedThreadId).toBeNull();
    });

    it("abandons a read the transport never answers, inside the tombstone lifetime", async () => {
      // The tombstone's ten minutes only bounds a late response if the response
      // itself is bounded. Reads had no deadline at all: a bootstrap, a page or
      // a selection fetch on a transport that never answers stayed pending
      // forever, so it could land after its tombstone expired and re-admit a
      // conversation the server had destroyed.
      seedOneThread();
      vi.mocked(api.threads).mockResolvedValue({ threads: [alphaThread], nextCursor: "cursor-1" });
      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));
      // Only a page response carries a cursor; the bootstrap has none, and it
      // is what seeds the sidebar now.
      await revalidateThreadList("event-page");
      expect(store.current.hasMoreThreads).toBe(true);

      // A transport that answers neither the request nor its abort.
      vi.mocked(api.threads).mockImplementation(() => new Promise<never>(() => undefined));
      let settledWith: unknown;
      vi.useFakeTimers();
      try {
        const page = store.current.loadMoreThreads().then(
          () => { settledWith = "resolved"; },
          (error: unknown) => { settledWith = error; },
        );
        for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
        expect(settledWith).toBeUndefined();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(THREAD_READ_TIMEOUT_MS);
          await page;
        });
      } finally {
        vi.useRealTimers();
      }
      expect(settledWith).toBeInstanceOf(Error);
      expect((settledWith as Error).message).toMatch(/timed out/iu);
      expect(THREAD_READ_TIMEOUT_MS).toBeLessThan(REMOVED_THREAD_TTL_MS);
    });

    it("does not list a conversation twice when its create and its event race", async () => {
      // The same hole without a delete: the SSE admits the conversation, then
      // the create prepends the very same row again.
      const fresh = thread("fresh-thread", "alpha");
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([agent("alpha", { label: "Alpha" })], []));
      vi.mocked(api.threads).mockResolvedValue({ threads: [] });
      vi.mocked(api.thread).mockResolvedValue(detail(fresh, "hello"));
      let releaseCreate: (() => void) | undefined;
      const creation = new Promise<void>((resolve) => { releaseCreate = resolve; });
      vi.mocked(api.createThread).mockImplementation(async () => {
        await creation;
        return fresh;
      });

      const store = await renderStore();
      const pending = store.current.createThread();
      await settle();

      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([agent("alpha", { label: "Alpha" })], [fresh]));
      vi.mocked(api.threads).mockResolvedValue({ threads: [fresh] });
      await refresh("event-1");

      await act(async () => {
        releaseCreate?.();
        await pending;
      });
      expect(store.current.threads.map((item) => item.id)).toEqual(["fresh-thread"]);
    });
  });

  /**
   * Round 5's cluster, and all one shape: the repair round 4 added treats a
   * FAILED delete as proof that nothing happened and that nothing has moved
   * since. A failed request proves neither. It proves the answer did not
   * arrive.
   */
  describe("failed deletes reconciled rather than assumed", () => {
    const alphaThread = thread("alpha-thread", "alpha");

    const settle = async () => {
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    };

    const seedOneThread = () => {
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [alphaThread],
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [alphaThread] });
      vi.mocked(api.thread).mockResolvedValue(detail(alphaThread, "hello"));
    };

    const heldDelete = () => {
      let reject: ((error: Error) => void) | undefined;
      vi.mocked(api.deleteThread).mockImplementation(async () => {
        await new Promise<void>((_ok, no) => { reject = no; });
      });
      return { fail: (error: Error) => reject?.(error) };
    };

    /**
     * A full snapshot refresh, the way the console still does one: discovery
     * reported a change, so the bootstrap is re-read. Nothing else asks for a
     * bootstrap any more -- see the event table.
     */
    const refresh = async (id: string) => {
      act(() => FakeEventSource.latest?.emit("agents.changed", {
        id,
        version: 1,
        type: "agents.changed",
        at: "2026-08-14T09:00:00.000Z",
      }));
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 400); }); });
    };

    // Two shapes of the same non-answer: a lost answer, and one the far side of
    // the server produced itself. Neither says the delete was not applied.
    it.each([
      ["a request that never answered", () => new Error("The web console request timed out.")],
      ["a gateway that answered for the server", () => new ApiError("Bad gateway", 502)],
    ] as const)(
      "does not resurrect a conversation the server deleted before %s failed",
      async (_label, failure) => {
      // P1-3. The server COMMITS the row deletion and only then awaits
      // attachment cleanup and emits its invalidations, so a rejection can
      // arrive after the delete is authoritative -- a proxy that dropped the
      // answer, or this console's own deadline. Restoring on every rejection
      // therefore puts back a conversation the server no longer has, over an
      // authoritative refresh that had already removed it.
      //
      // The deleted conversation is NOT the selected one, deliberately: a
      // refresh reads the selected conversation alongside the bootstrap and
      // discards both if that read fails, so a server that has genuinely
      // deleted the SELECTED conversation cannot deliver the authoritative
      // refresh this defect needs. Deleting a second conversation reproduces it
      // with every response consistent with a server that committed.
      const gammaThread = thread("gamma-thread", "alpha", { updatedAt: "2026-07-17T09:00:00.000Z" });
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [alphaThread, gammaThread],
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [alphaThread, gammaThread] });
      vi.mocked(api.thread).mockResolvedValue(detail(alphaThread, "hello"));
      const deletion = heldDelete();

      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));

      const deleted = store.current.deleteThread("gamma-thread");
      await settle();

      // The server has committed: the row is gone from every later response,
      // and a read of it is answered "not found".
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [alphaThread],
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [alphaThread] });
      vi.mocked(api.thread).mockImplementation(async (id: string) => {
        if (id !== "alpha-thread") {
          throw new ApiError("Conversation not found.", 404, "thread_not_found");
        }
        return detail(alphaThread, "hello");
      });
      await refresh("event-1");
      expect(store.current.threads.map((item) => item.id)).toEqual(["alpha-thread"]);

      let settledWith: "resolved" | "rejected" = "resolved";
      await act(async () => {
        deletion.fail(failure());
        await deleted.catch(() => { settledWith = "rejected"; });
      });
      await settle();

      expect(store.current.threads.map((item) => item.id)).toEqual(["alpha-thread"]);
      expect(store.current.selectedThreadId).toBe("alpha-thread");
      // Reconciliation ASKED the server and was told the conversation is gone,
      // so the operator gets the outcome they asked for rather than an error
      // beside a sidebar that already agrees with the server.
      expect(settledWith).toBe("resolved");
      expect(store.current.actionError).toBeNull();
    },
    );

    it("leaves an unreconcilable delete to the server instead of guessing", async () => {
      // The third state, and the one a boolean cannot hold: the delete failed
      // AND the read that would settle what happened failed too. Restoring is a
      // guess that can resurrect a deleted conversation; keeping the tombstone
      // is a guess that hides a live one for its whole lifetime. So neither --
      // drop the tombstone, assert nothing, and let the server's next answer
      // decide.
      seedOneThread();
      const deletion = heldDelete();

      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));

      const deleted = store.current.deleteThread("alpha-thread");
      await settle();
      // A refresh answers while the tombstone stands, so the projection has
      // already dropped the conversation -- which is what makes restoring it a
      // decision rather than a no-op.
      await refresh("event-1");
      expect(store.current.threads.map((item) => item.id)).toEqual([]);

      // The transport is down for the reconciling read as well.
      vi.mocked(api.thread).mockRejectedValue(new Error("The web console request timed out."));
      await act(async () => {
        deletion.fail(new Error("The web console request timed out."));
        await expect(deleted).rejects.toThrow(/timed out/iu);
      });
      await settle();

      expect(store.current.threads.map((item) => item.id)).toEqual([]);
      expect(store.current.actionError).toMatch(/timed out/iu);

      // The tombstone is gone, so the next authoritative answer is obeyed
      // either way: still there means still there.
      vi.mocked(api.thread).mockResolvedValue(detail(alphaThread, "hello"));
      await refresh("event-2");
      expect(store.current.threads.map((item) => item.id)).toEqual(["alpha-thread"]);
    });

    it("restores the selection a failed delete lost to an automatic one", async () => {
      // P1-4a. `selectedThreadRef.current === null` was standing in for "the
      // operator has not chosen anything since". A bootstrap that answered
      // while the conversation was tombstoned re-resolves the selection to a
      // surviving conversation, so the ref is not null -- and the repair the
      // failure owes the operator is skipped.
      const betaThread = thread("beta-thread", "alpha", { updatedAt: "2026-07-17T09:00:00.000Z" });
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [alphaThread, betaThread],
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [alphaThread, betaThread] });
      vi.mocked(api.thread).mockResolvedValue(detail(alphaThread, "hello"));
      const deletion = heldDelete();

      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));

      const deleted = store.current.deleteThread("alpha-thread");
      await settle();
      await refresh("event-1");
      expect(store.current.selectedThreadId).toBe("beta-thread");

      await act(async () => {
        // 409: the server refused before it touched anything.
        deletion.fail(new ApiError("Cancel the active turn before deleting this conversation.", 409, "turn_active"));
        await expect(deleted).rejects.toBeInstanceOf(ApiError);
      });
      await settle();

      expect(store.current.threads.map((item) => item.id).sort())
        .toEqual(["alpha-thread", "beta-thread"]);
      expect(store.current.selectedThreadId).toBe("alpha-thread");
    });

    it("leaves a selection the operator moved alone when a delete fails", async () => {
      // P1-4b. The same null check the other way: the operator deliberately
      // switched to another agent, so the ref IS null -- and the repair put
      // Alpha's conversation id back under Beta, which every later model action
      // then targets while the console shows Beta's capabilities.
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })],
        [alphaThread],
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [alphaThread] });
      vi.mocked(api.thread).mockResolvedValue(detail(alphaThread, "hello"));
      const deletion = heldDelete();

      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));

      const deleted = store.current.deleteThread("alpha-thread");
      await settle();
      act(() => { store.current.selectAgent("beta"); });
      await settle();
      expect(store.current.selectedAgentId).toBe("beta");
      expect(store.current.selectedThreadId).toBeNull();

      await act(async () => {
        deletion.fail(new ApiError("Archive the conversation before deleting it.", 409, "thread_not_archived"));
        await expect(deleted).rejects.toBeInstanceOf(ApiError);
      });
      await settle();

      // The conversation comes back -- the delete was refused -- but the
      // operator's own choice of where to be outranks the repair.
      expect(store.current.threads.map((item) => item.id)).toEqual(["alpha-thread"]);
      expect(store.current.selectedAgentId).toBe("beta");
      expect(store.current.selectedThreadId).toBeNull();
    });

    it("restores the newest suppressed projection, not the last one to arrive", async () => {
      // P1-5. "Newest" meant "last response received". Responses arrive out of
      // order, so a delayed older projection overwrote a newer one and the
      // restore rolled back a title, an archive state or a run override the
      // server had already accepted.
      seedOneThread();
      const deletion = heldDelete();

      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));

      const deleted = store.current.deleteThread("alpha-thread");
      await settle();

      const revisionThree = { ...alphaThread, title: "Renamed again", revision: 3 };
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [revisionThree],
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [revisionThree] });
      await refresh("event-1");

      // A response issued BEFORE that one, answered after it.
      const revisionTwo = { ...alphaThread, title: "Renamed once", revision: 2 };
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [revisionTwo],
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [revisionTwo] });
      await refresh("event-2");

      await act(async () => {
        deletion.fail(new ApiError("Cancel the active turn before deleting this conversation.", 409, "turn_active"));
        await expect(deleted).rejects.toBeInstanceOf(ApiError);
      });
      await settle();

      expect(store.current.threads.map((item) => item.title)).toEqual(["Renamed again"]);
      expect(store.current.threads[0]?.revision).toBe(3);
    });
  });

  /**
   * Round 6's cluster, and all one shape: RECONCILIATION WAS TREATED AS
   * AUTHORITATIVE WHEN IT CANNOT BE.
   *
   * A follow-up GET is not a linearization point while the original DELETE is
   * still on the wire, and a refusal only describes the request -- never the
   * conversation as it stands now, which another client may have removed while
   * the answer was in flight.
   */
  describe("reconcileFailedDelete", () => {
    const alphaThread = thread("alpha-thread", "alpha");
    const landed = (landing: RequestLanding) => Promise.resolve(landing);

    it("withholds a refusal when the failure was not an ANSWER, and reports the row", async () => {
      // A `fetch` rejection that is not an answer says this client lost the
      // exchange, not that the server is done with the request -- so the read
      // below is not a linearization point and the row it saw may be removed a
      // millisecond later. The row is still worth reporting: it is the freshest
      // thing the server has said and the caller repairs its projection from
      // it. The VERDICT is what may not be claimed.
      vi.mocked(api.thread).mockResolvedValue(detail(alphaThread, "hello"));

      const outcome = await reconcileFailedDelete(
        "alpha-thread",
        landed({ outcome: "failed", error: new TypeError("Failed to fetch") }),
      );

      expect(outcome.verdict).toBe("unknown");
      expect(outcome.thread?.id).toBe("alpha-thread");
    });

    it("withholds it for a gateway that answered for a server it never reached", async () => {
      // A 502 is an answer from the wrong machine. `classifyDeleteFailure`
      // already refuses to read it as the server's, and reconciliation must not
      // put it back by treating a sighting as the missing proof.
      vi.mocked(api.thread).mockResolvedValue(detail(alphaThread, "hello"));

      const outcome = await reconcileFailedDelete(
        "alpha-thread",
        landed({ outcome: "failed", error: new ApiError("Bad gateway", 502) }),
      );

      expect(outcome.verdict).toBe("unknown");
      expect(outcome.thread?.id).toBe("alpha-thread");
    });

    it("calls it a refusal when the server answered with a code it publishes", async () => {
      // The two-sided test, both sides satisfied: the server ANSWERED that it
      // refused, and a read issued after that still found the row.
      vi.mocked(api.thread).mockResolvedValue(detail(alphaThread, "hello"));

      const outcome = await reconcileFailedDelete(
        "alpha-thread",
        landed({
          outcome: "failed",
          error: new ApiError("Cancel the active turn first.", 409, "turn_active"),
        }),
      );

      expect(outcome.verdict).toBe("refused");
      expect(outcome.thread?.id).toBe("alpha-thread");
    });

    it("still reads an affirmative not-found as applied, however the request failed", async () => {
      // The one thing a read CAN settle on its own: the row is gone, so the
      // postcondition the operator asked for holds however it got there.
      vi.mocked(api.thread).mockRejectedValue(
        new ApiError("Conversation not found.", 404, "thread_not_found"),
      );

      const outcome = await reconcileFailedDelete(
        "alpha-thread",
        landed({ outcome: "failed", error: new TypeError("Failed to fetch") }),
      );

      expect(outcome.verdict).toBe("applied");
      expect(outcome.thread).toBeUndefined();
    });
  });

  describe("delete reconciliation ordered against what is still outstanding", () => {
    const alphaThread = thread("alpha-thread", "alpha");
    const gammaThread = thread("gamma-thread", "alpha", { updatedAt: "2026-07-17T09:00:00.000Z" });

    /** A message in the open conversation: one read of that conversation. */
    const refreshSelected = async (id: string, threadId: string) => {
      act(() => FakeEventSource.latest?.emit("message.changed", {
        id,
        version: 1,
        type: "message.changed",
        at: "2026-08-14T09:00:00.000Z",
        threadId,
        payload: { messageId: "message-hello", updatedAt: "2026-08-14T09:00:00.000Z" },
      }));
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 400); }); });
    };

    const settle = async () => {
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    };

    /**
     * A full snapshot refresh, the way the console still does one: discovery
     * reported a change, so the bootstrap is re-read. Nothing else asks for a
     * bootstrap any more -- see the event table.
     */
    const refresh = async (id: string) => {
      act(() => FakeEventSource.latest?.emit("agents.changed", {
        id,
        version: 1,
        type: "agents.changed",
        at: "2026-08-14T09:00:00.000Z",
      }));
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 400); }); });
    };

    /** A listing event naming no conversation: one debounced bucket page. */
    const revalidateThreadList = async (id: string) => {
      act(() => FakeEventSource.latest?.emit("threads.changed", {
        id,
        version: 1,
        type: "threads.changed",
        at: "2026-08-14T09:00:00.000Z",
      }));
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, THREAD_LIST_REVALIDATE_DEBOUNCE_MS + 200);
        });
      });
    };

    const seedTwoThreads = () => {
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [alphaThread, gammaThread],
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [alphaThread, gammaThread] });
      vi.mocked(api.thread).mockImplementation(async (id: string) =>
        detail(id === "gamma-thread" ? gammaThread : alphaThread, "hello"));
    };

    /** The conversation is gone server-side, whoever removed it. */
    const serverHasOnlyAlpha = () => {
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [alphaThread],
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [alphaThread] });
      vi.mocked(api.thread).mockImplementation(async (id: string) => {
        if (id !== "alpha-thread") {
          throw new ApiError("Conversation not found.", 404, "thread_not_found");
        }
        return detail(alphaThread, "hello");
      });
    };

    /**
     * A DELETE that behaves the way `fetch` does under a deadline: the abort
     * rejects THIS CALLER at once, and the request it already transmitted goes
     * on running through the proxy and the server.
     *
     * A mock that ignores the signal and stays pending until it is resolved by
     * hand asserts a state production `fetch` cannot be in after an abort, so
     * it cannot test what an abort does -- it tests a transport that has none.
     */
    const deleteStillRunningAfterAbort = () => {
      let finish: (() => void) | undefined;
      const onServer = new Promise<void>((resolve) => { finish = resolve; });
      vi.mocked(api.deleteThread).mockImplementation(async (_threadId, signal) =>
        new Promise<void>((resolve, reject) => {
          // The server keeps going whatever this caller does about it.
          void onServer.then(resolve);
          if (signal === undefined) return;
          const abort = () => {
            reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        }));
      return { finishOnServer: () => { finish?.(); } };
    };

    it("does not restore a conversation another client deleted while the refusal was in flight", async () => {
      // P1-1a. A 4xx short-circuits reconciliation entirely, so a DELAYED
      // refusal is applied to a projection that has moved underneath it. The
      // refusal is true about the request -- the server refused it before it
      // touched anything -- and says nothing about a row another client has
      // since removed.
      seedTwoThreads();
      let refuse: ((error: unknown) => void) | undefined;
      vi.mocked(api.deleteThread).mockImplementation(async () => {
        await new Promise<void>((_ok, no) => { refuse = no; });
      });

      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));

      const deleted = store.current.deleteThread("gamma-thread");
      await settle();

      serverHasOnlyAlpha();
      await refresh("event-1");
      expect(store.current.threads.map((item) => item.id)).toEqual(["alpha-thread"]);

      let settledWith: "resolved" | "rejected" = "resolved";
      await act(async () => {
        refuse?.(new ApiError(
          "Cancel the active turn before deleting this conversation.",
          409,
          "turn_active",
        ));
        await deleted.catch(() => { settledWith = "rejected"; });
      });
      await settle();

      // Reconciled: the read that follows the refusal is answered "not found",
      // so the postcondition the operator asked for holds however it got there.
      expect(store.current.threads.map((item) => item.id)).toEqual(["alpha-thread"]);
      expect(settledWith).toBe("resolved");
      expect(store.current.actionError).toBeNull();
    });

    it("asserts nothing about a delete its own deadline abandoned", async () => {
      // P1-1. Waiting for the request to settle was the right shape, but the
      // thing waited on was the BROWSER promise, and the deadline's signal goes
      // straight to `fetch`: an abort rejects it the instant it is seen, while
      // the DELETE it already transmitted is still running server-side. So the
      // promise settling said "finished" when all that happened was that this
      // caller stopped listening. The reconciling read went out anyway, saw the
      // row, called the delete refused -- and the DELETE then removed it.
      //
      // Abandoning a request destroys the only evidence there was. `unknown`,
      // and a refresh, is the whole of what is left to say.
      seedTwoThreads();
      const server = deleteStillRunningAfterAbort();

      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        // Settled-with is captured at issue, not awaited later: a rejection
        // nothing is listening for yet is an unhandled rejection.
        const deleted = store.current.deleteThread("gamma-thread")
          .then(() => "resolved" as const, () => "rejected" as const);
        await act(async () => { await vi.advanceTimersByTimeAsync(THREAD_WRITE_TIMEOUT_MS + 1); });

        // The abort has rejected the browser promise and the DELETE is still on
        // the wire. Nothing may be read ABOUT this conversation on the strength
        // of that: such a read cannot order itself against the delete.
        expect(vi.mocked(api.thread).mock.calls.map(([id]) => id)).not.toContain("gamma-thread");

        // The server finishes the delete it was already doing.
        serverHasOnlyAlpha();
        let settledWith: "resolved" | "rejected" | undefined;
        await act(async () => {
          server.finishOnServer();
          await vi.advanceTimersByTimeAsync(400);
          settledWith = await deleted;
        });

        // Reported as the failure it was, and the row left the sidebar because
        // the queued refresh asked the server -- not because the console
        // guessed which way an abandoned request had gone.
        expect(settledWith).toBe("rejected");
        expect(store.current.threads.map((item) => item.id)).toEqual(["alpha-thread"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("asks the server once however many times the operator asks for one delete", async () => {
      // P2. The delete button stays enabled while its request is outstanding --
      // which is exactly when an operator clicks it again -- and every re-entry
      // took out a SECOND tombstone for the same row. `remember` replaces the
      // entry it finds, so the second ask discarded the newest projection the
      // first had recorded, and whichever ask reconciled first then released or
      // forgot a tombstone the other was still relying on, with its DELETE
      // still on the wire.
      seedTwoThreads();
      const refusals: ((error: unknown) => void)[] = [];
      vi.mocked(api.deleteThread).mockImplementation(async () => {
        await new Promise<void>((_ok, no) => { refusals.push(no); });
      });

      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));

      const first = store.current.deleteThread("gamma-thread");
      await settle();
      const second = store.current.deleteThread("gamma-thread");
      await settle();

      // One conversation, one delete. Asking twice is one intent.
      expect(refusals).toHaveLength(1);

      const refusal = new ApiError(
        "Cancel the active turn before deleting this conversation.",
        409,
        "turn_active",
      );
      await act(async () => {
        for (const refuse of refusals) refuse(refusal);
        await expect(first).rejects.toBe(refusal);
        // The second ask is answered by the delete it joined, not by one of
        // its own.
        await expect(second).rejects.toBe(refusal);
      });
      await settle();

      expect(store.current.threads.map((item) => item.id).sort())
        .toEqual(["alpha-thread", "gamma-thread"]);

      // Refused, not applied -- so the conversation is still there and still
      // deletable. Nothing may outlive the request it stood for.
      const again = store.current.deleteThread("gamma-thread");
      await settle();
      expect(refusals).toHaveLength(2);
      await act(async () => {
        refusals[1]?.(refusal);
        await expect(again).rejects.toBe(refusal);
      });
      await settle();
    });

    it("calls a delete that never settles unknown rather than reading past it", async () => {
      // The bound this fix accepts and does not hide: a transport that neither
      // answers nor releases the request leaves NOTHING to linearize against,
      // so the console asserts nothing at all -- no tombstone, no restore, no
      // claim about the server.
      seedTwoThreads();
      vi.mocked(api.deleteThread).mockImplementation(async () => {
        await new Promise<void>(() => undefined);
      });

      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const deleted = store.current.deleteThread("gamma-thread")
          .then(() => "resolved" as const, () => "rejected" as const);
        let settledWith: "resolved" | "rejected" | undefined;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(THREAD_WRITE_TIMEOUT_MS + 1);
          await vi.advanceTimersByTimeAsync(THREAD_WRITE_TIMEOUT_MS + 1);
          settledWith = await deleted;
        });

        expect(settledWith).toBe("rejected");
        expect(vi.mocked(api.thread).mock.calls.map(([id]) => id)).not.toContain("gamma-thread");
        // Nothing answered while the tombstone stood, so the projection is
        // still the last thing the server actually said.
        expect(store.current.threads.map((item) => item.id).sort())
          .toEqual(["alpha-thread", "gamma-thread"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("never re-admits a page its delete outran, even once the tombstone is dropped", async () => {
      // P1-2a. The tombstone filters while it stands and is dropped the moment
      // a delete proves unreconcilable -- so a read issued BEFORE the delete,
      // answered after that, walks straight back into the projection over the
      // refresh that had just removed the row.
      const selected = thread("selected-thread", "alpha");
      const stale = thread("stale-thread", "alpha", {
        archivedAt: "2026-07-17T09:30:00.000Z",
        updatedAt: "2026-07-17T09:30:00.000Z",
      });
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [selected, stale],
      ));
      vi.mocked(api.thread).mockImplementation(async (id: string) => {
        if (id === "stale-thread") throw new Error("The web console request timed out.");
        return detail(selected, "hello");
      });
      vi.mocked(api.threads).mockImplementation(async (_sourceId, archived) => archived
        ? { threads: [stale], nextCursor: "cursor-1" }
        : { threads: [selected] });

      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("selected-thread"));
      act(() => { store.current.setShowArchived(true); });
      // The archived bucket arrives with the bootstrap, which carries no
      // cursor: a page response is what tells the sidebar there is more.
      await revalidateThreadList("event-page");
      await waitFor(() => expect(store.current.hasMoreThreads).toBe(true));

      // The operator scrolls the archived list: an older page goes out, and is
      // still on the wire when the delete is issued.
      let releasePage: (() => void) | undefined;
      const heldPage = new Promise<void>((resolve) => { releasePage = resolve; });
      vi.mocked(api.threads).mockImplementation(async () => {
        await heldPage;
        return { threads: [stale] };
      });
      const olderPage = store.current.loadMoreThreads();
      await settle();

      vi.mocked(api.deleteThread).mockRejectedValue(new Error("The web console request timed out."));
      await act(async () => {
        await expect(store.current.deleteThread("stale-thread")).rejects.toThrow(/timed out/iu);
      });
      // Unreconcilable, so the tombstone is dropped and a refresh is queued.
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [selected],
      ));
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 400); }); });
      expect(store.current.threads.map((item) => item.id)).toEqual(["selected-thread"]);

      await act(async () => {
        releasePage?.();
        await olderPage;
      });

      expect(store.current.threads.map((item) => item.id)).toEqual(["selected-thread"]);
    });

    it("keeps the fence when the row outlived a delete the server never answered", async () => {
      // The abandoned case, one door along. `fetch` also rejects on a reset
      // connection or a proxy that dropped the socket, and neither of those is
      // an ANSWER: the DELETE this console transmitted may still be running.
      // The reconciling read then sees the row -- proving only that it existed
      // at that instant -- and calling that a REFUSAL dropped the fence. The
      // delete commits, the refresh removes the row, and the page issued before
      // the delete walks the conversation straight back into the sidebar.
      const selected = thread("selected-thread", "alpha");
      const stale = thread("stale-thread", "alpha", {
        archivedAt: "2026-07-17T09:30:00.000Z",
        updatedAt: "2026-07-17T09:30:00.000Z",
      });
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [selected, stale],
      ));
      // The row is STILL THERE when the reconciliation asks -- which is the
      // whole point: the sighting is true, and it is not a promise.
      vi.mocked(api.thread).mockImplementation(async (id: string) =>
        detail(id === "stale-thread" ? stale : selected, "hello"));
      vi.mocked(api.threads).mockImplementation(async (_sourceId, archived) => archived
        ? { threads: [stale], nextCursor: "cursor-1" }
        : { threads: [selected] });

      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("selected-thread"));
      act(() => { store.current.setShowArchived(true); });
      // The archived bucket arrives with the bootstrap, which carries no
      // cursor: a page response is what tells the sidebar there is more.
      await revalidateThreadList("event-page");
      await waitFor(() => expect(store.current.hasMoreThreads).toBe(true));

      // An older archived page goes out, and is still on the wire when the
      // delete is issued.
      let releasePage: (() => void) | undefined;
      const heldPage = new Promise<void>((resolve) => { releasePage = resolve; });
      vi.mocked(api.threads).mockImplementation(async () => {
        await heldPage;
        return { threads: [stale] };
      });
      const olderPage = store.current.loadMoreThreads();
      await settle();

      // A transport rejection, NOT an ApiError: no server ever answered this.
      vi.mocked(api.deleteThread).mockRejectedValue(new TypeError("Failed to fetch"));
      await act(async () => {
        await expect(store.current.deleteThread("stale-thread")).rejects.toThrow(/failed to fetch/iu);
      });
      await settle();

      // The DELETE was running all along and has now committed server-side, so
      // the authoritative refresh removes the row.
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [selected],
      ));
      vi.mocked(api.thread).mockImplementation(async (id: string) => {
        if (id !== "selected-thread") {
          throw new ApiError("Conversation not found.", 404, "thread_not_found");
        }
        return detail(selected, "hello");
      });
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 400); }); });
      expect(store.current.threads.map((item) => item.id)).toEqual(["selected-thread"]);

      await act(async () => {
        releasePage?.();
        await olderPage;
      });

      expect(store.current.threads.map((item) => item.id)).toEqual(["selected-thread"]);
    });

    it("restores the newest projection a tombstoned DETAIL carried, not the newest listing", async () => {
      // P1-2b. The detail paths drop a tombstoned projection instead of
      // recording it, so the newest thing this tab ever saw about the
      // conversation is not what a failed delete hands back -- and the
      // reconciling read is not a floor either: it is one more response, and
      // responses do not arrive in the order the server produced them.
      const revisionOne = thread("alpha-thread", "alpha");
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [revisionOne],
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [revisionOne] });
      vi.mocked(api.thread).mockResolvedValue(detail(revisionOne, "hello"));
      let refuse: ((error: unknown) => void) | undefined;
      vi.mocked(api.deleteThread).mockImplementation(async () => {
        await new Promise<void>((_ok, no) => { refuse = no; });
      });

      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));

      const deleted = store.current.deleteThread("alpha-thread");
      await settle();

      // A refresh lands while the tombstone stands: its LISTING still carries
      // the pre-rename row, its DETAIL carries the rename.
      const revisionThree = { ...revisionOne, title: "Renamed thrice", revision: 3 };
      vi.mocked(api.thread).mockResolvedValue(detail(revisionThree, "hello"));
      // The DETAIL read first: the bootstrap re-resolves the selection off a
      // conversation its listing no longer carries, and an unselected
      // conversation is not read.
      await refreshSelected("event-1", "alpha-thread");
      await refresh("event-2");

      // The reconciling read is answered by a lagging replica.
      const revisionTwo = { ...revisionOne, title: "Renamed twice", revision: 2 };
      vi.mocked(api.thread).mockResolvedValue(detail(revisionTwo, "hello"));

      await act(async () => {
        refuse?.(new ApiError(
          "Cancel the active turn before deleting this conversation.",
          409,
          "turn_active",
        ));
        await expect(deleted).rejects.toBeInstanceOf(ApiError);
      });
      await settle();

      expect(store.current.threads.map((item) => item.revision)).toEqual([3]);
      expect(store.current.threads[0]?.title).toBe("Renamed thrice");
    });
  });

  /**
   * One bucket per bootstrap.
   *
   * A bootstrap used to carry EVERY agent's conversations -- 187 KB of a 219 KB
   * payload on a 13-agent fleet -- and the sidebar then re-read the one bucket
   * it actually shows. It now asks for that bucket and nothing else, which
   * makes every other bucket something to go and fetch.
   */
  describe("one bucket per bootstrap", () => {
    const alphaThread = thread("alpha-thread", "alpha");
    const olderAlpha = thread("older-alpha", "alpha", { updatedAt: "2026-07-16T09:00:00.000Z" });
    const betaThread = thread("beta-thread", "beta");
    let eventSequence = 0;

    const emit = (
      type: WebEvent["type"],
      extra: { readonly threadId?: string; readonly payload?: unknown } = {},
    ) => {
      eventSequence += 1;
      act(() => FakeEventSource.latest?.emit(type, {
        id: `bucket-event-${String(eventSequence)}`,
        version: 1,
        type,
        at: "2026-08-14T09:00:00.000Z",
        ...extra,
      }));
    };

    const quiet = async (ms = 400) => {
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, ms); }); });
    };

    const openOnAlpha = async (
      threads: readonly ThreadSummary[] = [alphaThread],
      scope: { readonly threadsSourceId?: string | null; readonly threadsNextCursor?: string | null } = {},
    ) => {
      localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, "alpha");
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })],
        threads,
        undefined,
        { threadsSourceId: "alpha", ...scope },
      ));
      vi.mocked(api.thread).mockImplementation(async (threadId) => detail(
        [alphaThread, olderAlpha, betaThread].find((item) => item.id === threadId) ?? alphaThread,
        "hello",
      ));
      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedAgentId).toBe("alpha"));
      return store;
    };

    it("asks for the bucket it is about to show, and pages it from the cursor it came with", async () => {
      const store = await openOnAlpha([alphaThread], { threadsNextCursor: "cursor-1" });
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));
      await quiet();

      expect(api.bootstrap).toHaveBeenCalledWith(expect.any(AbortSignal), {
        sourceId: "alpha",
        archived: false,
        limit: THREAD_PAGE_LIMIT,
      });
      // The bucket the bootstrap carried is not re-read...
      expect(api.threads).not.toHaveBeenCalled();
      // ...and it arrives with the cursor that makes "load more" work on it.
      expect(store.current.hasMoreThreads).toBe(true);
      vi.mocked(api.threads).mockResolvedValue({ threads: [olderAlpha] });
      await act(async () => { await store.current.loadMoreThreads(); });
      expect(api.threads).toHaveBeenCalledWith("alpha", false, "cursor-1", expect.any(AbortSignal));
      expect(store.current.visibleThreads.map((item) => item.id))
        .toEqual(["alpha-thread", "older-alpha"]);
    });

    it("fetches the bucket an agent switch lands on instead of another bootstrap", async () => {
      const store = await openOnAlpha();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));
      vi.mocked(api.threads).mockResolvedValue({ threads: [betaThread] });

      act(() => { store.current.selectAgent("beta"); });
      await waitFor(() => expect(store.current.visibleThreads.map((item) => item.id))
        .toEqual(["beta-thread"]));
      await quiet();

      expect(api.threads).toHaveBeenCalledTimes(1);
      expect(api.threads).toHaveBeenCalledWith("beta", false, undefined, expect.any(AbortSignal));
      // The page is what resolves the conversation to open: the bootstrap no
      // longer carries the other agents' rows for `selectAgent` to look in.
      expect(store.current.selectedThreadId).toBe("beta-thread");
      expect(api.bootstrap).toHaveBeenCalledTimes(1);
    });

    it("opens the conversation the operator last had with the agent they switch to", async () => {
      localStorage.setItem(SELECTED_THREADS_STORAGE_KEY, JSON.stringify({ beta: "beta-older" }));
      const olderBeta = thread("beta-older", "beta", { updatedAt: "2026-07-16T09:00:00.000Z" });
      const store = await openOnAlpha();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));
      vi.mocked(api.threads).mockResolvedValue({ threads: [betaThread, olderBeta] });

      act(() => { store.current.selectAgent("beta"); });
      await waitFor(() => expect(store.current.selectedThreadId).toBe("beta-older"));
      await quiet();

      expect(api.bootstrap).toHaveBeenCalledTimes(1);
      expect(api.threads).toHaveBeenCalledTimes(1);
    });

    it("keeps the open conversation a refreshed bucket does not happen to list", async () => {
      // One page of fifty rows is not the whole bucket, so "not in the answer"
      // is the ordinary case for an older conversation -- and yanking the
      // operator to another one for it is not a refresh, it is a jump.
      const store = await openOnAlpha([alphaThread, olderAlpha]);
      act(() => { store.current.selectThread("older-alpha"); });
      await waitFor(() => expect(store.current.selectedThreadId).toBe("older-alpha"));
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })],
        [alphaThread],
        undefined,
        { threadsSourceId: "alpha" },
      ));

      emit("agents.changed");
      await waitFor(() => expect(api.bootstrap).toHaveBeenCalledTimes(2));
      await quiet();

      expect(store.current.selectedThreadId).toBe("older-alpha");
      expect(store.current.selectedThread?.id).toBe("older-alpha");
    });

    it("keeps refreshing after the remount StrictMode does on every mount", async () => {
      // React 19 StrictMode -- which `main.tsx` wraps the console in -- runs
      // every effect setup, cleanup, setup, and refs survive all three. A
      // "still mounted" flag that is only ever CLEARED by a cleanup is false
      // for the rest of the session after that, and every SSE-driven refresh
      // routed through the debounce is silently dead in `vite dev`.
      localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, "alpha");
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [alphaThread],
        undefined,
        { threadsSourceId: "alpha" },
      ));
      vi.mocked(api.thread).mockResolvedValue(detail(alphaThread, "hello"));
      let current: Store | undefined;
      render(
        <StrictMode>
          <ConsoleStoreProvider>
            <StoreProbe onChange={(store) => { current = store; }} />
          </ConsoleStoreProvider>
        </StrictMode>,
      );
      await waitFor(() => expect(current?.selectedThreadId).toBe("alpha-thread"));
      await waitFor(() => expect(current?.detail?.thread.id).toBe("alpha-thread"));
      const detailReads = vi.mocked(api.thread).mock.calls.length;

      emit("message.changed", {
        threadId: "alpha-thread",
        payload: { messageId: "message-1", updatedAt: "2026-08-14T09:00:00.000Z" },
      });

      await waitFor(() => expect(vi.mocked(api.thread).mock.calls.length).toBe(detailReads + 1));
    });

    it("closes a restored conversation the server no longer has", async () => {
      // The stored id outlives the browser, so a conversation deleted from
      // another client is resolved again on every load. One bucket page cannot
      // say it is gone -- the detail read can, and it is the only thing that
      // does.
      localStorage.setItem(SELECTED_THREADS_STORAGE_KEY, JSON.stringify({ alpha: "deleted-elsewhere" }));
      localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, "alpha");
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })],
        [alphaThread],
        undefined,
        { threadsSourceId: "alpha" },
      ));
      vi.mocked(api.thread).mockRejectedValue(
        new ApiError("Conversation not found.", 404, "thread_not_found"),
      );
      const store = await renderStore();

      await waitFor(() => expect(store.current.selectedThreadId).toBeNull());
      await quiet();

      expect(store.current.detail).toBeNull();
      expect(store.current.actionError).toBe("This conversation was deleted.");
      expect(JSON.parse(localStorage.getItem(SELECTED_THREADS_STORAGE_KEY) ?? "{}"))
        .toEqual({});
      // The sidebar it landed on is still the bucket the bootstrap carried.
      expect(store.current.visibleThreads.map((item) => item.id)).toEqual(["alpha-thread"]);
    });

    it("does not open a restored conversation archived from another client", async () => {
      // Archiving one HERE moves the selection to the next active row (see
      // `archiveThread`), and a restored id the console finds archived is no
      // more the active view's selection than that one was. The active bucket
      // cannot show it, so keeping it opened a conversation the sidebar does
      // not list and the archive toggle says nothing about.
      const archivedElsewhere = thread("archived-elsewhere", "alpha", {
        archivedAt: "2026-07-17T09:30:00.000Z",
        updatedAt: "2026-07-17T09:30:00.000Z",
      });
      localStorage.setItem(SELECTED_THREADS_STORAGE_KEY, JSON.stringify({ alpha: "archived-elsewhere" }));
      localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, "alpha");
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })],
        [alphaThread],
        undefined,
        { threadsSourceId: "alpha" },
      ));
      vi.mocked(api.thread).mockImplementation(async (threadId) => detail(
        threadId === "archived-elsewhere" ? archivedElsewhere : alphaThread,
        "hello",
      ));
      const store = await renderStore();

      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));
      await quiet();

      expect(store.current.showArchived).toBe(false);
      expect(store.current.detail?.thread.id).toBe("alpha-thread");
      expect(JSON.parse(localStorage.getItem(SELECTED_THREADS_STORAGE_KEY) ?? "{}"))
        .toEqual({ alpha: "alpha-thread" });
    });

    it("keeps an archived conversation the operator opened themselves", async () => {
      // Conversation search and push deep links both reach archived
      // conversations while the active view is showing, and both are the
      // operator's choice. Only a selection the console RESTORED is second-
      // guessed by the detail read.
      const archivedElsewhere = thread("archived-elsewhere", "alpha", {
        archivedAt: "2026-07-17T09:30:00.000Z",
        updatedAt: "2026-07-17T09:30:00.000Z",
      });
      const store = await openOnAlpha([alphaThread]);
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));
      vi.mocked(api.thread).mockImplementation(async (threadId) => detail(
        threadId === "archived-elsewhere" ? archivedElsewhere : alphaThread,
        "hello",
      ));

      act(() => { store.current.selectThread("archived-elsewhere"); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe("archived-elsewhere"));
      await quiet();

      expect(store.current.selectedThreadId).toBe("archived-elsewhere");
      expect(store.current.showArchived).toBe(false);
    });

    it("keeps a conversation the operator opened when a bootstrap lands before its read", async () => {
      // `agents.changed` alone re-applies a bootstrap, and a conversation the
      // operator deliberately opened from search or a push link is by
      // definition absent from the active bucket. Re-arming the restore marker
      // for a selection that did not CHANGE turned that routine refresh into an
      // ejection out of the conversation they had just opened.
      const archivedElsewhere = thread("archived-elsewhere", "alpha", {
        archivedAt: "2026-07-17T09:30:00.000Z",
        updatedAt: "2026-07-17T09:30:00.000Z",
      });
      const store = await openOnAlpha([alphaThread]);
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      vi.mocked(api.thread).mockImplementation(async (threadId) => {
        if (threadId !== "archived-elsewhere") return detail(alphaThread, "hello");
        await held;
        return detail(archivedElsewhere, "hello");
      });

      act(() => { store.current.selectThread("archived-elsewhere"); });
      await waitFor(() => expect(store.current.selectedThreadId).toBe("archived-elsewhere"));
      emit("agents.changed");
      await waitFor(() => expect(api.bootstrap).toHaveBeenCalledTimes(2));
      await act(async () => {
        release?.();
        await held;
      });
      await quiet();

      expect(store.current.selectedThreadId).toBe("archived-elsewhere");
      expect(store.current.detail?.thread.id).toBe("archived-elsewhere");
    });

    it("leaves the conversation the operator created while a restored read was in flight", async () => {
      // The restored read answers late and about a conversation nobody is
      // looking at any more. Applying its repair blind blanked the pane the
      // operator had just opened.
      const archivedElsewhere = thread("archived-elsewhere", "alpha", {
        archivedAt: "2026-07-17T09:30:00.000Z",
        updatedAt: "2026-07-17T09:30:00.000Z",
      });
      const fresh = thread("fresh-thread", "alpha", { updatedAt: "2026-07-17T13:00:00.000Z" });
      localStorage.setItem(SELECTED_THREADS_STORAGE_KEY, JSON.stringify({ alpha: "archived-elsewhere" }));
      localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, "alpha");
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [alphaThread],
        undefined,
        { threadsSourceId: "alpha" },
      ));
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      vi.mocked(api.thread).mockImplementation(async (threadId) => {
        if (threadId === "fresh-thread") return detail(fresh, "hello");
        if (threadId !== "archived-elsewhere") return detail(alphaThread, "hello");
        await held;
        return detail(archivedElsewhere, "hello");
      });
      vi.mocked(api.createThread).mockResolvedValue(fresh);
      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("archived-elsewhere"));

      await act(async () => { await store.current.createThread(); });
      await waitFor(() => expect(store.current.selectedThreadId).toBe("fresh-thread"));
      await act(async () => {
        release?.();
        await held;
      });
      await quiet();

      expect(store.current.selectedThreadId).toBe("fresh-thread");
      expect(store.current.detail?.thread.id).toBe("fresh-thread");
    });

    it("drops a conversation a listing event says was removed, without a page", async () => {
      // The removal arrives as a pair, and the `threads.changed` half names a
      // conversation this tab does not list. Read as a bare listing event it
      // bought a page of the bucket to look for something the same event had
      // just said was gone.
      const store = await openOnAlpha();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));

      emit("threads.changed", {
        threadId: "outside-the-window",
        payload: { threadId: "outside-the-window", removed: true },
      });
      await quiet(THREAD_LIST_REVALIDATE_DEBOUNCE_MS + 200);

      expect(api.threads).not.toHaveBeenCalled();
      expect(api.bootstrap).toHaveBeenCalledTimes(1);
    });

    it("updates a sidebar row from the summary an event carries, without reading anything", async () => {
      const store = await openOnAlpha([alphaThread, olderAlpha]);
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));
      const detailReads = vi.mocked(api.thread).mock.calls.length;

      emit("thread.changed", {
        threadId: "older-alpha",
        payload: { thread: { ...olderAlpha, title: "Renamed by another tab", revision: 2 } },
      });
      await waitFor(() => expect(
        store.current.threads.find((item) => item.id === "older-alpha")?.title,
      ).toBe("Renamed by another tab"));
      await quiet();

      expect(api.bootstrap).toHaveBeenCalledTimes(1);
      expect(api.threads).not.toHaveBeenCalled();
      expect(vi.mocked(api.thread).mock.calls.length).toBe(detailReads);
    });

    it("re-reads the open conversation when an event says its transcript moved", async () => {
      // The summary an event carries is the sidebar row. The MESSAGES are not
      // in it, and a finished turn, a reconciled cron run and an appended
      // notification all end in this event and say nothing else.
      const store = await openOnAlpha();
      await waitFor(() => expect(store.current.detail?.thread.id).toBe("alpha-thread"));
      const detailReads = vi.mocked(api.thread).mock.calls.length;

      emit("thread.changed", {
        threadId: "alpha-thread",
        payload: { thread: { ...alphaThread, title: "Named by the agent", revision: 3 } },
      });
      await waitFor(() => expect(vi.mocked(api.thread).mock.calls.length).toBe(detailReads + 1));
      await quiet();

      expect(store.current.threads.find((item) => item.id === "alpha-thread")?.title)
        .toBe("Named by the agent");
      expect(api.bootstrap).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.thread).mock.calls.length).toBe(detailReads + 1);
    });
  });

  /**
   * The event table. Every SSE event used to fall through to one
   * `Promise.all([api.bootstrap(), api.thread(selected)])` -- for any type, for
   * any agent, for any conversation -- so watching one turn run cost a full
   * bootstrap plus the whole open conversation every 300 ms. Each event now
   * says exactly what it invalidated, and the console re-reads that alone.
   */
  describe("one refresh per event, and only what the event invalidated", () => {
    const selected = thread("alpha-thread", "alpha");
    const other = thread("other-thread", "alpha", { updatedAt: "2026-07-17T09:00:00.000Z" });
    let eventSequence = 0;

    const seedTwoThreads = () => {
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [selected, other],
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [selected, other] });
      vi.mocked(api.thread).mockResolvedValue(detail(selected, "hello"));
    };

    const emit = (
      type: WebEvent["type"],
      extra: { readonly threadId?: string; readonly payload?: unknown } = {},
    ) => {
      eventSequence += 1;
      act(() => FakeEventSource.latest?.emit(type, {
        id: `event-${String(eventSequence)}`,
        version: 1,
        type,
        at: "2026-08-14T09:00:00.000Z",
        ...extra,
      }));
    };

    /** Long enough for the refresh debounce to have fired if anything asked. */
    const quiet = async (ms = 400) => {
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, ms); }); });
    };

    const openedOnAlpha = async () => {
      const store = await renderStore();
      await waitFor(() => expect(store.current.selectedThreadId).toBe("alpha-thread"));
      await waitFor(() => expect(store.current.detail?.thread.id).toBe("alpha-thread"));
      return store;
    };

    it("applies a pin the event named, and asks the server for nothing", async () => {
      seedTwoThreads();
      const store = await openedOnAlpha();
      const detailReads = vi.mocked(api.thread).mock.calls.length;

      emit("agents.changed", { payload: { sourceId: "alpha", pinned: true } });
      await quiet();

      expect(store.current.agents.map((item) => [item.sourceId, item.pinned]))
        .toEqual([["alpha", true]]);
      // The whole point: a one-boolean write no longer costs a bootstrap, the
      // skill registry and the cron overview in every open tab.
      expect(api.bootstrap).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.thread).mock.calls.length).toBe(detailReads);
      expect(api.agentSkills).toHaveBeenCalledTimes(1);
    });

    it("still re-reads everything for an agents.changed that names nothing", async () => {
      seedTwoThreads();
      await openedOnAlpha();

      emit("agents.changed");
      await waitFor(() => expect(api.bootstrap).toHaveBeenCalledTimes(2));
    });

    it("replaces the message a truncated tool call sits in, rather than repairing it in place", async () => {
      const truncated = {
        id: "message-tool",
        threadId: selected.id,
        role: "assistant" as const,
        parts: [
          {
            type: "tool-call" as const,
            toolCallId: "tool-big",
            toolName: "Exec",
            args: { command: "run" },
            result: "HEAD",
            resultTruncated: true,
            resultBytes: 20 * 1_024,
            status: "complete" as const,
          },
        ],
        attachments: [],
        createdAt: "2026-08-14T08:00:00.000Z",
        updatedAt: "2026-08-14T08:00:00.000Z",
        status: "complete" as const,
      };
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([agent("alpha", { label: "Alpha" })], [selected]));
      vi.mocked(api.threads).mockResolvedValue({ threads: [selected] });
      vi.mocked(api.thread).mockResolvedValue({ thread: selected, messages: [truncated] });
      vi.mocked(api.toolCallPart).mockResolvedValue({
        type: "tool-call",
        toolCallId: "tool-big",
        toolName: "Exec",
        args: { command: "run" },
        result: "THE WHOLE BODY",
        status: "complete",
      });
      const store = await openedOnAlpha();
      const before = store.current.detail?.messages[0];

      await act(async () => { await store.current.loadFullToolCall("tool-big"); });

      // Bounded like every other read, so the call carries the deadline's signal.
      expect(api.toolCallPart).toHaveBeenCalledWith(
        selected.id, "message-tool", "tool-big", expect.any(AbortSignal));
      const after = store.current.detail?.messages[0];
      // assistant-ui caches its part conversions by object identity, so the
      // repair has to arrive as new objects or the row keeps its preview.
      expect(after).not.toBe(before);
      expect(after?.parts[0]).not.toBe(before?.parts[0]);
      expect(after?.parts[0]).toEqual({
        type: "tool-call",
        toolCallId: "tool-big",
        toolName: "Exec",
        args: { command: "run" },
        result: "THE WHOLE BODY",
        status: "complete",
      });
      // The preview and its marker are gone together.
      expect(before).toMatchObject({ parts: [{ resultTruncated: true }] });
    });

    it("keeps both repairs when two calls in one message come back together", async () => {
      // Two "Load full output" clicks on one message -- a cluster, or two
      // subagent steps -- can have both responses queued before React commits
      // either. A repair that substitutes a message it built from a pre-commit
      // snapshot loses the other one, and both still report success.
      const truncatedCall = (toolCallId: string) => ({
        type: "tool-call" as const,
        toolCallId,
        toolName: "Exec",
        result: "HEAD",
        resultTruncated: true,
        resultBytes: 20 * 1_024,
        status: "complete" as const,
      });
      const truncated = {
        id: "message-tool",
        threadId: selected.id,
        role: "assistant" as const,
        parts: [truncatedCall("tool-a"), truncatedCall("tool-b")],
        attachments: [],
        createdAt: "2026-08-14T08:00:00.000Z",
        updatedAt: "2026-08-14T08:00:00.000Z",
        status: "complete" as const,
      };
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([agent("alpha", { label: "Alpha" })], [selected]));
      vi.mocked(api.threads).mockResolvedValue({ threads: [selected] });
      vi.mocked(api.thread).mockResolvedValue({ thread: selected, messages: [truncated] });
      const answers = new Map<string, (part: MessagePart) => void>();
      vi.mocked(api.toolCallPart).mockImplementation(async (_threadId, _messageId, toolCallId) =>
        new Promise<MessagePart>((resolve) => answers.set(toolCallId, resolve)));
      const store = await openedOnAlpha();

      const first = store.current.loadFullToolCall("tool-a");
      const second = store.current.loadFullToolCall("tool-b");
      await waitFor(() => expect(answers.size).toBe(2));

      // Both answers land before React commits either repair.
      await act(async () => {
        answers.get("tool-a")?.({
          type: "tool-call", toolCallId: "tool-a", toolName: "Exec", result: "WHOLE A", status: "complete",
        });
        answers.get("tool-b")?.({
          type: "tool-call", toolCallId: "tool-b", toolName: "Exec", result: "WHOLE B", status: "complete",
        });
        await Promise.all([first, second]);
      });

      await expect(first).resolves.toBe(true);
      await expect(second).resolves.toBe(true);
      const parts = store.current.detail?.messages[0]?.parts ?? [];
      expect(parts.map((part) => (part as { result?: unknown }).result)).toEqual(["WHOLE A", "WHOLE B"]);
      expect(parts.every((part) => (part as { resultTruncated?: boolean }).resultTruncated !== true)).toBe(true);
    });

    it("abandons a full-body read the transport never answers", async () => {
      // Every other read is bounded; this one was not. A stalled request left
      // the notice stuck on "Loading…" with no way back to the button, because
      // nothing ever settled the promise it was waiting on.
      const truncated = {
        id: "message-tool",
        threadId: selected.id,
        role: "assistant" as const,
        parts: [{
          type: "tool-call" as const,
          toolCallId: "tool-big",
          toolName: "Exec",
          result: "HEAD",
          resultTruncated: true,
          resultBytes: 20 * 1_024,
          status: "complete" as const,
        }],
        attachments: [],
        createdAt: "2026-08-14T08:00:00.000Z",
        updatedAt: "2026-08-14T08:00:00.000Z",
        status: "complete" as const,
      };
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([agent("alpha", { label: "Alpha" })], [selected]));
      vi.mocked(api.threads).mockResolvedValue({ threads: [selected] });
      vi.mocked(api.thread).mockResolvedValue({ thread: selected, messages: [truncated] });
      const store = await openedOnAlpha();

      // A transport that answers neither the request nor its abort.
      vi.mocked(api.toolCallPart).mockImplementation(() => new Promise<never>(() => undefined));
      let settledWith: unknown;
      vi.useFakeTimers();
      try {
        const repairing = store.current.loadFullToolCall("tool-big").then(
          (replaced) => { settledWith = replaced; },
          (error: unknown) => { settledWith = error; },
        );
        for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
        expect(settledWith).toBeUndefined();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(THREAD_READ_TIMEOUT_MS);
          await repairing;
        });
      } finally {
        vi.useRealTimers();
      }
      // Rejected, so the row's notice reports the failure instead of waiting
      // forever on a promise nothing will settle.
      expect(settledWith).toBeInstanceOf(Error);
      expect((settledWith as Error).message).toMatch(/timed out/iu);
      expect(JSON.stringify(store.current.detail?.messages)).toContain("resultTruncated");
    });

    it("reports no repair when the operator leaves the conversation mid-fetch", async () => {
      // The full body is a round trip, and the operator can walk away from the
      // conversation during it. Reporting success for a replacement that never
      // landed leaves the row looking settled on the preview it still shows.
      const truncated = {
        id: "message-tool",
        threadId: selected.id,
        role: "assistant" as const,
        parts: [{
          type: "tool-call" as const,
          toolCallId: "tool-big",
          toolName: "Exec",
          result: "HEAD",
          resultTruncated: true,
          resultBytes: 20 * 1_024,
          status: "complete" as const,
        }],
        attachments: [],
        createdAt: "2026-08-14T08:00:00.000Z",
        updatedAt: "2026-08-14T08:00:00.000Z",
        status: "complete" as const,
      };
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([agent("alpha", { label: "Alpha" })], [selected, other]));
      vi.mocked(api.threads).mockResolvedValue({ threads: [selected, other] });
      vi.mocked(api.thread).mockImplementation(async (threadId) => threadId === selected.id
        ? { thread: selected, messages: [truncated] }
        : detail(other, "elsewhere"));
      let answer!: (part: MessagePart) => void;
      vi.mocked(api.toolCallPart).mockImplementation(async () =>
        new Promise<MessagePart>((resolve) => { answer = resolve; }));
      const store = await openedOnAlpha();

      const repairing = store.current.loadFullToolCall("tool-big");
      await waitFor(() => expect(api.toolCallPart).toHaveBeenCalledTimes(1));
      act(() => { store.current.selectThread(other.id); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(other.id));

      await act(async () => {
        answer({
          type: "tool-call",
          toolCallId: "tool-big",
          toolName: "Exec",
          result: "THE WHOLE BODY",
          status: "complete",
        });
        await repairing;
      });
      await expect(repairing).resolves.toBe(false);
      expect(store.current.detail?.thread.id).toBe(other.id);
      expect(JSON.stringify(store.current.detail?.messages)).not.toContain("THE WHOLE BODY");
    });

    it("fetches nothing for a message in a conversation nobody is looking at", async () => {
      seedTwoThreads();
      await openedOnAlpha();
      const detailReads = vi.mocked(api.thread).mock.calls.length;

      emit("message.changed", {
        threadId: "other-thread",
        payload: { messageId: "message-1", updatedAt: "2026-08-14T09:00:00.000Z" },
      });
      await quiet();

      expect(api.bootstrap).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.thread).mock.calls.length).toBe(detailReads);
    });

    it("answers a burst on the open conversation with one read of it", async () => {
      seedTwoThreads();
      await openedOnAlpha();
      const detailReads = vi.mocked(api.thread).mock.calls.length;

      for (let index = 0; index < 5; index += 1) {
        emit("message.changed", {
          threadId: "alpha-thread",
          payload: { messageId: `message-${String(index)}`, updatedAt: "2026-08-14T09:00:00.000Z" },
        });
      }
      await quiet();

      expect(vi.mocked(api.thread).mock.calls.length).toBe(detailReads + 1);
      expect(api.bootstrap).toHaveBeenCalledTimes(1);
    });

    it("applies the run state a turn event carries instead of asking for it", async () => {
      seedTwoThreads();
      const store = await openedOnAlpha();
      const detailReads = vi.mocked(api.thread).mock.calls.length;

      emit("turn.changed", {
        threadId: "alpha-thread",
        payload: { turn: { id: "turn-1", status: "running", startedAt: "2026-08-14T09:00:00.000Z" } },
      });
      await waitFor(() => expect(store.current.selectedThread?.runState.status).toBe("running"));
      await quiet();

      expect(store.current.selectedThread?.runState.id).toBe("turn-1");
      expect(store.current.detail?.thread.runState.status).toBe("running");
      expect(api.bootstrap).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.thread).mock.calls.length).toBe(detailReads);
    });

    it("merges the conversation an event already carries rather than refetching it", async () => {
      seedTwoThreads();
      const store = await openedOnAlpha();

      emit("threads.changed", {
        threadId: "other-thread",
        payload: { thread: { ...other, title: "Renamed elsewhere", revision: 2 } },
      });
      await waitFor(() => expect(
        store.current.threads.find((item) => item.id === "other-thread")?.title,
      ).toBe("Renamed elsewhere"));
      await quiet();

      expect(api.bootstrap).toHaveBeenCalledTimes(1);
      expect(api.threads).not.toHaveBeenCalled();
    });

    it("ignores a listing event about a conversation it already lists", async () => {
      seedTwoThreads();
      await openedOnAlpha();

      emit("threads.changed", { threadId: "other-thread" });
      await quiet(THREAD_LIST_REVALIDATE_DEBOUNCE_MS + 200);

      expect(api.bootstrap).toHaveBeenCalledTimes(1);
      expect(api.threads).not.toHaveBeenCalled();
    });

    it("re-reads one bucket page when a listing event names nothing", async () => {
      seedTwoThreads();
      await openedOnAlpha();

      emit("threads.changed");
      emit("threads.changed");
      await quiet(THREAD_LIST_REVALIDATE_DEBOUNCE_MS + 200);

      expect(api.threads).toHaveBeenCalledTimes(1);
      expect(api.threads).toHaveBeenCalledWith("alpha", false, undefined, expect.any(AbortSignal));
      expect(api.bootstrap).toHaveBeenCalledTimes(1);
    });

    it("removes a conversation another client deleted without a bootstrap", async () => {
      seedTwoThreads();
      const store = await openedOnAlpha();

      emit("thread.changed", {
        threadId: "other-thread",
        payload: { threadId: "other-thread", removed: true },
      });
      await waitFor(() => expect(store.current.threads.map((item) => item.id)).toEqual(["alpha-thread"]));
      await quiet();

      expect(api.bootstrap).toHaveBeenCalledTimes(1);
    });

    it("re-requests no bucket a bootstrap carried, and one page for each it did not", async () => {
      // A bootstrap carries ONE bucket, so the archive shelf and every other
      // agent are pages to fetch -- one each, and never another bootstrap.
      const betaThread = thread("beta-thread", "beta");
      const archived = thread("archived-thread", "alpha", {
        archivedAt: "2026-07-17T09:30:00.000Z",
        updatedAt: "2026-07-17T09:30:00.000Z",
      });
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })],
        [selected],
        undefined,
        { threadsSourceId: "alpha" },
      ));
      vi.mocked(api.thread).mockImplementation(async (threadId) =>
        detail(threadId === "beta-thread" ? betaThread : selected, "hello"));
      const store = await openedOnAlpha();
      expect(api.threads).not.toHaveBeenCalled();

      vi.mocked(api.threads).mockResolvedValue({ threads: [archived] });
      act(() => { store.current.setShowArchived(true); });
      await waitFor(() => expect(store.current.visibleThreads.map((item) => item.id))
        .toEqual(["archived-thread"]));
      act(() => { store.current.setShowArchived(false); });
      vi.mocked(api.threads).mockResolvedValue({ threads: [betaThread] });
      act(() => { store.current.selectAgent("beta"); });
      await waitFor(() => expect(store.current.selectedThreadId).toBe("beta-thread"));
      await quiet();

      expect(vi.mocked(api.threads).mock.calls.map((call) => [call[0], call[1]]))
        .toEqual([["alpha", true], ["beta", false]]);
      expect(api.bootstrap).toHaveBeenCalledTimes(1);
    });

    it("spends the first ready on nothing and a reconnect on one bootstrap", async () => {
      seedTwoThreads();
      vi.mocked(api.agentSkills).mockResolvedValue({ status: "ready", items: [], total: 0 });
      const store = await openedOnAlpha();
      await waitFor(() => expect(store.current.skillRegistry.status).toBe("ready"));
      const detailReads = vi.mocked(api.thread).mock.calls.length;
      const skillReads = vi.mocked(api.agentSkills).mock.calls.length;

      // The stream's first `ready` arrives beside the snapshot the mount
      // already asked for.
      emit("ready", { payload: { version: 1 } });
      await quiet();
      expect(api.bootstrap).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.thread).mock.calls.length).toBe(detailReads);
      expect(vi.mocked(api.agentSkills).mock.calls.length).toBe(skillReads);

      // A REAL reconnect, in the order a browser produces it: the stream
      // errors, the connection is re-established, and only then does the
      // server say `ready`. Emitting `ready` alone models nothing -- it is the
      // `onerror` leg that marks the registry stale, which is what made a
      // "refetch only when it is not ready" guard fire every single time.
      act(() => FakeEventSource.latest?.onerror?.(new Event("error")));
      await waitFor(() => expect(store.current.connection).toBe("reconnecting"));
      act(() => FakeEventSource.latest?.onopen?.(new Event("open")));
      emit("ready", { payload: { version: 1 } });
      await quiet();

      expect(api.bootstrap).toHaveBeenCalledTimes(2);
      expect(vi.mocked(api.thread).mock.calls.length).toBe(detailReads + 1);
      // Exactly one registry read for the reconnect, from the connection
      // transition alone.
      expect(vi.mocked(api.agentSkills).mock.calls.length).toBe(skillReads + 1);
      expect(api.cronOverview).not.toHaveBeenCalled();
    });

    it("ignores a cron event for an agent the operator is not looking at", async () => {
      seedTwoThreads();
      await openedOnAlpha();
      const detailReads = vi.mocked(api.thread).mock.calls.length;

      emit("cron.changed", { payload: { sourceId: "beta" } });
      await quiet();

      expect(api.cronOverview).not.toHaveBeenCalled();
      expect(api.bootstrap).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.thread).mock.calls.length).toBe(detailReads);
    });

    it("refreshes only the open conversation after starting a turn", async () => {
      seedTwoThreads();
      vi.mocked(api.startTurn).mockResolvedValue({
        thread: selected,
        turn: { id: "turn-1", status: "running" },
      });
      const store = await openedOnAlpha();
      const detailReads = vi.mocked(api.thread).mock.calls.length;

      await act(async () => { await store.current.sendTurn({ text: "go" }); });
      await quiet();

      expect(api.bootstrap).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.thread).mock.calls.length).toBe(detailReads + 1);
    });

    it("tombstones a conversation another client deleted, so a slow response cannot restore it", async () => {
      // The removal used to fall through to a bootstrap, and that bootstrap
      // settled the question. Now nothing re-reads afterwards, so a response
      // ISSUED BEFORE the removal and answered after it is the last word --
      // and it still lists the conversation the server has destroyed.
      seedTwoThreads();
      const store = await openedOnAlpha();
      let releaseBootstrap: (() => void) | undefined;
      const heldBootstrap = new Promise<void>((resolve) => { releaseBootstrap = resolve; });
      vi.mocked(api.bootstrap).mockImplementationOnce(async () => {
        await heldBootstrap;
        return bootstrap([agent("alpha", { label: "Alpha" })], [selected, other]);
      });

      emit("agents.changed");
      await quiet();

      emit("thread.changed", {
        threadId: "other-thread",
        payload: { threadId: "other-thread", removed: true },
      });
      await waitFor(() => expect(store.current.threads.map((item) => item.id))
        .toEqual(["alpha-thread"]));

      releaseBootstrap?.();
      await quiet();

      expect(store.current.threads.map((item) => item.id)).toEqual(["alpha-thread"]);
    });

    it("removes the selected listed conversation on a remote delete", async () => {
      seedTwoThreads();
      const store = await openedOnAlpha();

      emit("thread.changed", {
        threadId: "alpha-thread",
        payload: { threadId: "alpha-thread", removed: true },
      });

      await waitFor(() => expect(store.current.threads.map((item) => item.id))
        .toEqual(["other-thread"]));
      expect(store.current.selectedThreadId).not.toBe("alpha-thread");
      await quiet();
      expect(api.bootstrap).toHaveBeenCalledTimes(1);
    });

    it("keeps the rows a revalidation page does not carry", async () => {
      // `loadThreadBucket` replaces the bucket it reads, which is right for the
      // authoritative fill and wrong for a revalidation: answering one bare
      // event would have cut a bootstrap-seeded window down to one page.
      const older = thread("older-thread", "alpha", { updatedAt: "2026-07-16T09:00:00.000Z" });
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [selected, other, older],
      ));
      vi.mocked(api.thread).mockResolvedValue(detail(selected, "hello"));
      // The page carries only the top of the bucket.
      vi.mocked(api.threads).mockResolvedValue({ threads: [selected, other], nextCursor: "cursor-1" });
      const store = await openedOnAlpha();
      expect([...store.current.threads].map((item) => item.id).sort())
        .toEqual(["alpha-thread", "older-thread", "other-thread"]);

      emit("threads.changed");
      await quiet(THREAD_LIST_REVALIDATE_DEBOUNCE_MS + 200);

      expect(api.threads).toHaveBeenCalledTimes(1);
      expect([...store.current.threads].map((item) => item.id).sort())
        .toEqual(["alpha-thread", "older-thread", "other-thread"]);
      // The bucket had no cursor -- a bootstrap carries none -- so it adopts
      // this one and "load more" works again.
      expect(store.current.hasMoreThreads).toBe(true);

      // A later revalidation must NOT overwrite it: its page starts at the top
      // of the bucket, so its cursor walks rows already merged rather than the
      // older ones the bucket is pointing at.
      vi.mocked(api.threads).mockResolvedValue({ threads: [selected, other], nextCursor: "cursor-2" });
      emit("threads.changed");
      await quiet(THREAD_LIST_REVALIDATE_DEBOUNCE_MS + 200);
      await act(async () => { await store.current.loadMoreThreads(); });

      expect(vi.mocked(api.threads).mock.calls.at(-1)?.[2]).toBe("cursor-1");
    });

    it("asks one page about a conversation it will never list, and no more", async () => {
      // These events name no agent, so a turn on a BACKGROUND agent emits two
      // of them -- one at the start, one at the finish -- for a conversation
      // this tab will never hold.
      seedTwoThreads();
      await openedOnAlpha();

      emit("threads.changed", { threadId: "background-agent-thread" });
      await quiet(THREAD_LIST_REVALIDATE_DEBOUNCE_MS + 200);
      expect(api.threads).toHaveBeenCalledTimes(1);

      emit("threads.changed", { threadId: "background-agent-thread" });
      await quiet(THREAD_LIST_REVALIDATE_DEBOUNCE_MS + 200);

      expect(api.threads).toHaveBeenCalledTimes(1);
      expect(api.bootstrap).toHaveBeenCalledTimes(1);
    });

    it("spends no page request on a bootstrap that failed", async () => {
      // There is no projection for a page to land in -- `loadThreadBucket`
      // no-ops without one -- so the request would be spent and discarded.
      //
      // The persisted agent is what makes this test reach that guard at all:
      // without it `selectedAgentId` is null and the effect returns one clause
      // earlier, which is a different reason and would pass either way.
      localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, "alpha");
      vi.mocked(api.bootstrap).mockRejectedValue(new Error("bootstrap unavailable"));
      const store = await renderStore();
      await waitFor(() => expect(store.current.error).toBe("bootstrap unavailable"));
      expect(store.current.selectedAgentId).toBe("alpha");
      await quiet();

      expect(api.threads).not.toHaveBeenCalled();
    });

    it("clears the sidebar's responding marker from the cancel's own answer", async () => {
      seedTwoThreads();
      const store = await openedOnAlpha();
      emit("turn.changed", {
        threadId: "alpha-thread",
        payload: { turn: { id: "turn-1", status: "running", startedAt: "2026-08-14T09:00:00.000Z" } },
      });
      await waitFor(() => expect(
        store.current.threads.find((item) => item.id === "alpha-thread")?.runState.status,
      ).toBe("running"));
      vi.mocked(api.cancelTurn).mockResolvedValue({
        cancelled: true,
        thread: { ...selected, runState: { id: "turn-1", status: "cancelled" } },
      });

      await act(async () => { await store.current.cancelTurn(); });

      expect(store.current.threads.find((item) => item.id === "alpha-thread")?.runState.status)
        .toBe("cancelled");
    });

    it("does not carry one bucket's unlisted answer over to another agent's", async () => {
      // A page of agent A's bucket says nothing about agent B's. Remembered by
      // id alone, a conversation that had simply fallen outside A's window
      // silenced every later event for it -- and B's bucket is
      // bootstrap-seeded, so nothing else would ever go and look.
      const betaThread = thread("beta-thread", "beta");
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })],
        [selected, other],
        undefined,
        { threadsSourceId: "alpha" },
      ));
      vi.mocked(api.thread).mockImplementation(async (threadId) =>
        detail(threadId === "beta-thread" ? betaThread : selected, "hello"));
      vi.mocked(api.threads).mockResolvedValue({ threads: [selected, other] });
      const store = await openedOnAlpha();

      emit("threads.changed", { threadId: "outside-the-window" });
      await quiet(THREAD_LIST_REVALIDATE_DEBOUNCE_MS + 200);
      expect(api.threads).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.threads).mock.calls[0]?.[0]).toBe("alpha");

      // The switch itself costs beta's page, because a bootstrap carries only
      // the bucket it was asked for.
      vi.mocked(api.threads).mockResolvedValue({ threads: [betaThread] });
      act(() => { store.current.selectAgent("beta"); });
      await waitFor(() => expect(store.current.selectedAgentId).toBe("beta"));
      await waitFor(() => expect(api.threads).toHaveBeenCalledTimes(2));

      emit("threads.changed", { threadId: "outside-the-window" });
      await quiet(THREAD_LIST_REVALIDATE_DEBOUNCE_MS + 200);

      expect(api.threads).toHaveBeenCalledTimes(3);
      expect(vi.mocked(api.threads).mock.calls[2]?.[0]).toBe("beta");
    });

    it("closes a conversation deleted while this tab was still fetching it by id", async () => {
      // The other half of the removal arm: selected, and this tab holds no
      // projection of it at all -- no row in the listing, and its detail read
      // still on the wire. A push deep link opens a conversation exactly like
      // this. There is nothing to name it with, so nothing to tombstone; what
      // it must not do is leave a destroyed conversation on screen.
      seedTwoThreads();
      const store = await openedOnAlpha();
      let answerOutside: ((error: Error) => void) | undefined;
      vi.mocked(api.thread).mockImplementation(async (threadId) => {
        if (threadId !== "outside-thread") return detail(selected, "hello");
        return await new Promise<never>((_resolve, reject) => { answerOutside = reject; });
      });

      act(() => { store.current.selectThread("outside-thread"); });
      await waitFor(() => expect(store.current.selectedThreadId).toBe("outside-thread"));
      expect(store.current.detail).toBeNull();

      emit("thread.changed", {
        threadId: "outside-thread",
        payload: { threadId: "outside-thread", removed: true },
      });

      await waitFor(() => expect(store.current.selectedThreadId).toBeNull());
      expect(store.current.actionError).toBe("This conversation was deleted.");
      expect(api.bootstrap).toHaveBeenCalledTimes(1);

      // The read the selection started is answered the way a server answers for
      // a conversation it no longer has, and puts nothing back.
      await act(async () => {
        answerOutside?.(new ApiError("Conversation not found.", 404, "thread_not_found"));
        await new Promise((resolve) => { setTimeout(resolve, 0); });
      });
      expect(store.current.detail).toBeNull();
      expect([...store.current.threads].map((item) => item.id).sort())
        .toEqual(["alpha-thread", "other-thread"]);
    });
  });
  describe("a conversation cache, message deltas applied to it", () => {
    const alpha = thread("alpha-thread", "alpha");
    const beta = thread("beta-thread", "alpha", { updatedAt: "2026-07-17T09:00:00.000Z" });
    let eventSequence = 0;

    const streamed = (
      id: string,
      text: string,
      overrides: Partial<WebMessage> = {},
    ): WebMessage => ({
      id,
      threadId: alpha.id,
      role: "assistant",
      parts: [{ type: "text", text }],
      attachments: [],
      createdAt: "2026-08-14T08:00:00.000Z",
      updatedAt: "2026-08-14T08:00:00.000Z",
      status: "running",
      seq: 1,
      ...overrides,
    });

    const emit = (
      type: WebEvent["type"],
      extra: { readonly threadId?: string; readonly payload?: unknown } = {},
    ) => {
      eventSequence += 1;
      act(() => FakeEventSource.latest?.emit(type, {
        id: `cache-event-${String(eventSequence)}`,
        version: 1,
        type,
        at: "2026-08-14T09:00:00.000Z",
        ...extra,
      }));
    };

    const emitDelta = (threadId: string, delta: Partial<MessageDelta> = {}) => {
      emit("message.delta", {
        threadId,
        payload: {
          messageId: "m1",
          baseSeq: 1,
          seq: 2,
          status: "running",
          updatedAt: "2026-08-14T09:00:00.000Z",
          ops: [],
          ...delta,
        },
      });
    };

    const quiet = async (ms = 400) => {
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, ms); }); });
    };

    /**
     * Every render's (selection, transcript) pair, captured DURING render.
     *
     * An effect cannot see this: `act` flushes effects, so a transcript
     * published one commit late still looks right by the time the test asks.
     * What the operator sees is the commit itself.
     */
    let paints: readonly (readonly [string | null, string | undefined])[] = [];
    function PaintProbe() {
      const store = useConsoleStore();
      paints = [...paints, [store.selectedThreadId, store.detail?.thread.id]];
      return null;
    }

    /** A commit that drew ANOTHER conversation's transcript under this header. */
    const mispaints = () =>
      paints.filter(([selected, shown]) => shown !== undefined && shown !== selected);

    /** The transcript the operator is actually looking at, as text. */
    function Transcript() {
      const store = useConsoleStore();
      return (
        <ol>
          {(store.detail?.messages ?? []).map((message) => (
            <li key={message.id} data-testid={`message-${message.id}`}>
              {message.parts
                .map((part) => (part.type === "text" ? part.text : ""))
                .join("")}
            </li>
          ))}
        </ol>
      );
    }

    const renderConsole = async () => {
      let current: Store | undefined;
      const onChange = (store: Store) => { current = store; };
      paints = [];
      render(
        <ConsoleStoreProvider>
          <StoreProbe onChange={onChange} />
          <PaintProbe />
          <Transcript />
        </ConsoleStoreProvider>,
      );
      await waitFor(() => expect(current?.loading).toBe(false));
      return {
        get current() {
          if (!current) throw new Error("Store did not initialize.");
          return current;
        },
      };
    };

    const seedTwo = (messages: readonly WebMessage[] = [streamed("m1", "Hel")]) => {
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [alpha, beta],
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [alpha, beta] });
      vi.mocked(api.thread).mockImplementation(async (threadId) => threadId === alpha.id
        ? { thread: alpha, messages }
        : { thread: beta, messages: [streamed("b1", "beta", { threadId: beta.id, seq: 1 })] });
    };

    const openedOnAlpha = async () => {
      const store = await renderConsole();
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(alpha.id));
      return store;
    };

    it("reads a conversation once however often the operator comes back to it", async () => {
      seedTwo();
      const store = await openedOnAlpha();

      act(() => { store.current.selectThread(beta.id); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(beta.id));
      act(() => { store.current.selectThread(alpha.id); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(alpha.id));
      await quiet();

      // One read each, and the return trip is answered from what this tab
      // already holds. It used to cost a full transcript every single time.
      expect(vi.mocked(api.thread).mock.calls.map((call) => call[0]))
        .toEqual([alpha.id, beta.id]);
      expect(store.current.detailLoading).toBe(false);
      expect(await screen.findByTestId("message-m1")).toHaveTextContent("Hel");
    });

    it("keeps the history the operator paged back to through a refresh", async () => {
      const recent = streamed("recent", "recent", { createdAt: "2026-08-14T08:00:00.000Z" });
      seedTwo([recent]);
      vi.mocked(api.thread).mockImplementation(async () =>
        ({ thread: alpha, messages: [recent], messagesNextCursor: "cursor-1" }));
      vi.mocked(api.messages).mockResolvedValue({
        messages: [streamed("older", "older", { createdAt: "2026-08-14T07:00:00.000Z" })],
      });
      const store = await openedOnAlpha();

      await act(async () => { await store.current.loadOlderMessages(); });
      expect(store.current.detail?.messages.map((message) => message.id))
        .toEqual(["older", "recent"]);

      // A hint naming a message this transcript does not hold re-reads the
      // conversation -- and that read carries only the newest window.
      emit("message.changed", {
        threadId: alpha.id,
        payload: { messageId: "brand-new", updatedAt: "2026-08-14T09:00:00.000Z" },
      });
      await waitFor(() => expect(vi.mocked(api.thread).mock.calls.length).toBe(2));
      await quiet();

      expect(store.current.detail?.messages.map((message) => message.id))
        .toEqual(["older", "recent"]);
      // The page it walked back to is still reachable from the cursor that
      // reached it, not from the one the window read carries.
      expect(store.current.hasOlderMessages).toBe(false);
    });

    it("applies a streamed write to the open transcript and asks for nothing", async () => {
      const settled = streamed("m0", "earlier", {
        createdAt: "2026-08-14T07:00:00.000Z",
        status: "complete",
        seq: 3,
      });
      seedTwo([settled, streamed("m1", "Hel")]);
      const store = await openedOnAlpha();
      const reads = vi.mocked(api.thread).mock.calls.length;
      const before = store.current.detail?.messages ?? [];

      emitDelta(alpha.id, { ops: [{ op: "append", index: 0, delta: "lo" }] });
      await waitFor(async () =>
        expect(await screen.findByTestId("message-m1")).toHaveTextContent("Hello"));
      await quiet();

      expect(vi.mocked(api.thread).mock.calls.length).toBe(reads);
      expect(api.message).not.toHaveBeenCalled();
      const after = store.current.detail?.messages ?? [];
      // The message the write did not touch is the SAME object: assistant-ui
      // caches its conversion under that identity, so replacing it re-converts
      // a transcript nothing happened to.
      expect(after[0]).toBe(before[0]);
      expect(after[1]).not.toBe(before[1]);
      expect(after[1]?.seq).toBe(2);
    });

    it("consumes a status-only write so the next one still applies", async () => {
      seedTwo();
      const store = await openedOnAlpha();

      emitDelta(alpha.id, { baseSeq: 1, seq: 2, status: "complete", ops: [] });
      await waitFor(() => expect(store.current.detail?.messages[0]?.status).toBe("complete"));
      emitDelta(alpha.id, {
        baseSeq: 2,
        seq: 3,
        status: "complete",
        ops: [{ op: "append", index: 0, delta: "lo" }],
      });
      await waitFor(async () =>
        expect(await screen.findByTestId("message-m1")).toHaveTextContent("Hello"));

      expect(api.message).not.toHaveBeenCalled();
    });

    it("reads the one message a missed write moved, and reads it once", async () => {
      seedTwo();
      const store = await openedOnAlpha();
      const reads = vi.mocked(api.thread).mock.calls.length;
      let answer!: (message: WebMessage) => void;
      vi.mocked(api.message).mockImplementation(async () =>
        new Promise<WebMessage>((resolve) => { answer = resolve; }));

      // Three frames of a turn this tab has fallen behind on. Without the join
      // every frame of the rest of the turn would buy its own request.
      emitDelta(alpha.id, { baseSeq: 4, seq: 5, ops: [{ op: "append", index: 0, delta: "a" }] });
      emitDelta(alpha.id, { baseSeq: 5, seq: 6, ops: [{ op: "append", index: 0, delta: "b" }] });
      emitDelta(alpha.id, { baseSeq: 6, seq: 7, ops: [{ op: "append", index: 0, delta: "c" }] });
      await waitFor(() => expect(api.message).toHaveBeenCalledTimes(1));

      await act(async () => {
        answer(streamed("m1", "Helloabc", { seq: 7, status: "complete" }));
        await new Promise((resolve) => { setTimeout(resolve, 0); });
      });
      await quiet();

      expect(api.message).toHaveBeenCalledTimes(1);
      expect(api.message).toHaveBeenCalledWith(alpha.id, "m1", expect.any(AbortSignal));
      // ONE message, never the conversation around it.
      expect(vi.mocked(api.thread).mock.calls.length).toBe(reads);
      expect(store.current.detail?.messages[0]?.seq).toBe(7);
      expect(await screen.findByTestId("message-m1")).toHaveTextContent("Helloabc");
    });

    it("spends no message read on a conversation it has not opened yet", async () => {
      // The cold read of the conversation the operator just opened is on the
      // wire when a delta for it arrives. There is nothing to apply it to and
      // nowhere for a message read to land -- one issued here bought an answer
      // the cache then dropped on the floor.
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [alpha, beta],
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [alpha, beta] });
      vi.mocked(api.thread).mockResolvedValue({
        thread: alpha,
        messages: [streamed("m1", "Hello", { seq: 2, status: "complete" })],
      });
      let releaseRead!: (detail: ThreadDetail) => void;
      vi.mocked(api.thread).mockImplementationOnce(async () =>
        new Promise<ThreadDetail>((resolve) => { releaseRead = resolve; }));
      const store = await renderConsole();
      await waitFor(() => expect(store.current.selectedThreadId).toBe(alpha.id));
      await waitFor(() => expect(releaseRead).toBeDefined());

      emitDelta(alpha.id, { baseSeq: 1, seq: 2, ops: [{ op: "append", index: 0, delta: "lo" }] });
      await quiet();
      expect(api.message).not.toHaveBeenCalled();
      expect(vi.mocked(api.thread).mock.calls.length).toBe(1);

      // The answer this read carries predates that write, so it lands BEHIND --
      // and costs exactly one more read rather than leaving a transcript on
      // screen that looks settled and is not.
      await act(async () => {
        releaseRead({ thread: alpha, messages: [streamed("m1", "Hel", { seq: 1 })] });
        await new Promise((resolve) => { setTimeout(resolve, 0); });
      });
      await waitFor(() => expect(vi.mocked(api.thread).mock.calls.length).toBe(2));
      await waitFor(async () =>
        expect(await screen.findByTestId("message-m1")).toHaveTextContent("Hello"));
      await quiet();

      expect(api.message).not.toHaveBeenCalled();
      expect(vi.mocked(api.thread).mock.calls.length).toBe(2);
    });

    it("reads again for a version that became known while the repair was out", async () => {
      // The join is what keeps a copy that fell behind from buying a request
      // per streamed frame. It must not also swallow the frames: the read on
      // the wire was issued before those versions existed.
      seedTwo();
      const store = await openedOnAlpha();
      const answers: ((message: WebMessage) => void)[] = [];
      vi.mocked(api.message).mockImplementation(async () =>
        new Promise<WebMessage>((resolve) => { answers.push(resolve); }));

      emitDelta(alpha.id, { baseSeq: 4, seq: 5, ops: [{ op: "append", index: 0, delta: "a" }] });
      await waitFor(() => expect(answers.length).toBe(1));
      // A LATER version, learned while the first read was still out.
      emitDelta(alpha.id, { baseSeq: 5, seq: 6, ops: [{ op: "append", index: 0, delta: "b" }] });

      await act(async () => {
        answers[0]?.(streamed("m1", "Helloa", { seq: 5 }));
        await new Promise((resolve) => { setTimeout(resolve, 0); });
      });
      await waitFor(() => expect(answers.length).toBe(2));

      await act(async () => {
        answers[1]?.(streamed("m1", "Helloab", { seq: 6, status: "complete" }));
        await new Promise((resolve) => { setTimeout(resolve, 0); });
      });
      await quiet();

      expect(api.message).toHaveBeenCalledTimes(2);
      expect(store.current.detail?.messages[0]?.seq).toBe(6);
      expect(await screen.findByTestId("message-m1")).toHaveTextContent("Helloab");
      // Still never the conversation around it.
      expect(vi.mocked(api.thread).mock.calls.length).toBe(1);
    });

    it("ignores a write it is already past instead of reading for it", async () => {
      seedTwo([streamed("m1", "Hello", { seq: 6 })]);
      const store = await openedOnAlpha();
      const reads = vi.mocked(api.thread).mock.calls.length;

      emitDelta(alpha.id, { baseSeq: 3, seq: 4, ops: [{ op: "append", index: 0, delta: "!" }] });
      await quiet();

      expect(api.message).not.toHaveBeenCalled();
      expect(vi.mocked(api.thread).mock.calls.length).toBe(reads);
      expect(store.current.detail?.messages[0]?.seq).toBe(6);
    });

    it("repairs the one message a hint names when the transcript already holds it", async () => {
      seedTwo();
      const store = await openedOnAlpha();
      const reads = vi.mocked(api.thread).mock.calls.length;
      vi.mocked(api.message).mockResolvedValue(
        streamed("m1", "reconciled", { seq: 4, status: "complete" }),
      );

      emit("message.changed", {
        threadId: alpha.id,
        payload: { messageId: "m1", updatedAt: "2026-08-14T09:00:00.000Z" },
      });
      await waitFor(async () =>
        expect(await screen.findByTestId("message-m1")).toHaveTextContent("reconciled"));
      await quiet();

      expect(api.message).toHaveBeenCalledTimes(1);
      // The four reconciliation write paths bump a version with no delta, and
      // this is the read they cost: one message, not the conversation.
      expect(vi.mocked(api.thread).mock.calls.length).toBe(reads);
      expect(store.current.detail?.messages[0]?.status).toBe("complete");
    });

    it("keeps a background conversation's run state without reading it again", async () => {
      seedTwo();
      const store = await openedOnAlpha();
      act(() => { store.current.selectThread(beta.id); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(beta.id));
      const reads = vi.mocked(api.thread).mock.calls.length;

      emit("turn.changed", {
        threadId: alpha.id,
        payload: { turn: { id: "turn-9", status: "running", startedAt: "2026-08-14T09:00:00.000Z" } },
      });
      act(() => { store.current.selectThread(alpha.id); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(alpha.id));
      await quiet();

      expect(store.current.detail?.thread.runState).toEqual({
        id: "turn-9",
        status: "running",
        startedAt: "2026-08-14T09:00:00.000Z",
      });
      expect(vi.mocked(api.thread).mock.calls.length).toBe(reads);
    });

    it("re-reads a conversation whose transcript moved while it was not on screen", async () => {
      seedTwo();
      const store = await openedOnAlpha();
      act(() => { store.current.selectThread(beta.id); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(beta.id));
      const reads = vi.mocked(api.thread).mock.calls.length;

      // Nothing is fetched WHILE it is in the background...
      emit("message.changed", {
        threadId: alpha.id,
        payload: { messageId: "m1", updatedAt: "2026-08-14T09:00:00.000Z" },
      });
      await quiet();
      expect(vi.mocked(api.thread).mock.calls.length).toBe(reads);
      expect(api.message).not.toHaveBeenCalled();

      // ...and opening it is what pays for what it missed.
      act(() => { store.current.selectThread(alpha.id); });
      await waitFor(() => expect(vi.mocked(api.thread).mock.calls.length).toBe(reads + 1));
    });

    it("buys each bucket's page once, however often the operator switches back", async () => {
      const gamma = thread("gamma-thread", "beta");
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })],
        [alpha],
        undefined,
        { threadsSourceId: "alpha" },
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [gamma] });
      vi.mocked(api.thread).mockImplementation(async (threadId) => threadId === gamma.id
        ? { thread: gamma, messages: [] }
        : { thread: alpha, messages: [streamed("m1", "Hel")] });
      const store = await openedOnAlpha();

      act(() => { store.current.selectAgent("beta"); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(gamma.id));
      act(() => { store.current.selectAgent("alpha"); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(alpha.id));
      act(() => { store.current.selectAgent("beta"); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(gamma.id));
      await quiet();

      // Alpha's bucket came with the bootstrap and beta's was read once. The
      // return trips cost neither a page nor a transcript.
      expect(vi.mocked(api.threads).mock.calls.map((call) => [call[0], call[1]]))
        .toEqual([["beta", false]]);
      expect(vi.mocked(api.thread).mock.calls.map((call) => call[0]))
        .toEqual([alpha.id, gamma.id]);
      expect(api.bootstrap).toHaveBeenCalledTimes(1);
    });

    it("never paints the conversation the operator just left under the new header", async () => {
      // The selection is state and the transcript is state, and publishing the
      // cached one from an EFFECT puts them in different commits: the header,
      // the composer and the run controls switch a frame before the transcript
      // does, so a cached A->B->A flashes the previous conversation.
      seedTwo();
      const store = await openedOnAlpha();
      act(() => { store.current.selectThread(beta.id); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(beta.id));

      paints = [];
      act(() => { store.current.selectThread(alpha.id); });

      expect(store.current.detail?.thread.id).toBe(alpha.id);
      expect(mispaints()).toEqual([]);
      // And the same on the way back, where the cache is warm both ways.
      paints = [];
      act(() => { store.current.selectThread(beta.id); });
      expect(mispaints()).toEqual([]);
    });

    it("never paints another agent's conversation while switching agents", async () => {
      const gamma = thread("gamma-thread", "beta");
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })],
        [alpha],
        undefined,
        { threadsSourceId: "alpha" },
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [gamma] });
      vi.mocked(api.thread).mockImplementation(async (threadId) => threadId === gamma.id
        ? { thread: gamma, messages: [] }
        : { thread: alpha, messages: [streamed("m1", "Hel")] });
      const store = await openedOnAlpha();
      act(() => { store.current.selectAgent("beta"); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(gamma.id));

      paints = [];
      act(() => { store.current.selectAgent("alpha"); });

      expect(mispaints()).toEqual([]);
    });

    it("re-reads a background conversation whose summary event moved its transcript", async () => {
      // A cron page that reconciled and a turn that started both move a
      // transcript and say so only through the conversation's own summary
      // event. Held from before, it would answer the next open from a
      // transcript that is behind, with nothing left to correct it.
      seedTwo();
      const store = await openedOnAlpha();
      act(() => { store.current.selectThread(beta.id); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(beta.id));
      const reads = vi.mocked(api.thread).mock.calls.length;

      emit("thread.changed", {
        threadId: alpha.id,
        payload: { thread: { ...alpha, revision: 2, messageCount: 4 } },
      });
      await quiet();
      expect(vi.mocked(api.thread).mock.calls.length).toBe(reads);

      act(() => { store.current.selectThread(alpha.id); });
      await waitFor(() => expect(vi.mocked(api.thread).mock.calls.length).toBe(reads + 1));
    });

    it("trusts nothing it kept across a reconnect", async () => {
      seedTwo();
      const store = await openedOnAlpha();
      // The stream's own first `ready`, so the one below is known to be a
      // RECONNECT rather than the snapshot the mount already asked for.
      emit("ready", { payload: { version: 1 } });
      act(() => { store.current.selectThread(beta.id); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(beta.id));
      const reads = vi.mocked(api.thread).mock.calls.length;

      // Nothing was observed while the link was down, so no held conversation
      // can say it is current.
      act(() => FakeEventSource.latest?.onerror?.(new Event("error")));
      await waitFor(() => expect(store.current.connection).toBe("reconnecting"));
      act(() => FakeEventSource.latest?.onopen?.(new Event("open")));
      emit("ready", { payload: { version: 1 } });
      await waitFor(() => expect(api.bootstrap).toHaveBeenCalledTimes(2));
      await quiet();

      act(() => { store.current.selectThread(alpha.id); });
      // The reconnect read the open conversation; this is the one it kept.
      await waitFor(() => expect(vi.mocked(api.thread).mock.calls.length).toBe(reads + 2));
    });

    it("hands a transcript nothing touched back as the very array it held", async () => {
      seedTwo();
      const store = await openedOnAlpha();
      const before = store.current.detail?.messages;

      emit("message.changed", {
        threadId: alpha.id,
        payload: { messageId: "unheld", updatedAt: "2026-08-14T09:00:00.000Z" },
      });
      await waitFor(() => expect(vi.mocked(api.thread).mock.calls.length).toBe(2));
      await quiet();

      // assistant-ui short-circuits its entire store update on this identity,
      // so a refresh that rebuilt the array re-converted every message in it.
      expect(store.current.detail?.messages).toBe(before);
    });
  });
});
