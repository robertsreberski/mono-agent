import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import {
  ConsoleStoreProvider,
  cronChannelPath,
  preferenceKeyForThread,
  RUN_PREFERENCES_STORAGE_KEY,
  useConsoleStore,
} from "./console-store";
import { agent, bootstrap, thread } from "./test/fixtures";
import type { AgentSkillRegistry, Bootstrap, CronOverview, ThreadDetail } from "./types";

vi.mock("./api", () => ({
  api: {
    bootstrap: vi.fn(),
    thread: vi.fn(),
    threads: vi.fn(),
    workspaceThreads: vi.fn(),
    messages: vi.fn(),
    messagesAround: vi.fn(),
    createThread: vi.fn(),
    patchThread: vi.fn(),
    deleteThread: vi.fn(),
    patchAgent: vi.fn(),
    agentPreferences: vi.fn(),
    patchAgentPreferences: vi.fn(),
    createCollection: vi.fn(),
    patchCollection: vi.fn(),
    deleteCollection: vi.fn(),
    agentSkills: vi.fn(),
    cronOverview: vi.fn(),
    cronRuns: vi.fn(),
    cronRun: vi.fn(),
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
    vi.mocked(api.messagesAround).mockResolvedValue({ messages: [] });
    vi.mocked(api.workspaceThreads).mockResolvedValue({ threads: [] });
    vi.mocked(api.agentPreferences).mockImplementation(async (sourceId) => ({
      sourceId,
      runPreference: null,
    }));
    vi.mocked(api.cronRuns).mockResolvedValue({ runs: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exposes an empty collection list when a legacy v1 bootstrap omits collections", async () => {
    const legacy = { ...bootstrap([agent("alpha")], []) } as Bootstrap & {
      collections?: Bootstrap["collections"];
    };
    Reflect.deleteProperty(legacy, "collections");
    vi.mocked(api.bootstrap).mockResolvedValue(legacy);

    const store = await renderStore();

    expect(store.current.collections).toEqual([]);
    expect(store.current.bootstrap?.collections).toEqual([]);
    expect(store.current.collectionsLoading).toBe(false);
    expect(store.current.error).toBeNull();
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

  it("refreshes from the authoritative store after a successful mutation", async () => {
    vi.mocked(api.patchAgent).mockResolvedValue(agent("beta", {
      label: "Beta",
      pinned: true,
    }));
    vi.mocked(api.bootstrap).mockResolvedValueOnce(
      bootstrap([
        agent("alpha", { label: "Alpha" }),
        agent("beta", { label: "Beta" }),
      ], []),
    ).mockResolvedValue(
      bootstrap([
        agent("beta", { label: "Beta", pinned: true }),
        agent("alpha", { label: "Alpha" }),
      ], []),
    );
    const store = await renderStore();

    await act(async () => store.current.setAgentPinned("beta", true));

    await waitFor(() => expect(api.bootstrap).toHaveBeenCalledTimes(2));
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

  it("loads a source-qualified memory route directly without opening conversation detail", async () => {
    const alphaThread = thread("alpha-thread", "alpha");
    window.history.replaceState(null, "", "/memory/alpha");
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([agent("alpha")], [alphaThread]));
    vi.mocked(api.threads).mockResolvedValue({ threads: [alphaThread] });
    vi.mocked(api.thread).mockResolvedValue(detail(alphaThread));

    const store = await renderStore();

    await waitFor(() => expect(store.current.workspaceRoute).toEqual({
      kind: "memory",
      sourceId: "alpha",
    }));
    expect(store.current.selectedAgentId).toBe("alpha");
    expect(store.current.selectedThreadId).toBe(alphaThread.id);
    expect(store.current.conversationDetailOpen).toBe(false);
    expect(window.location.pathname).toBe("/memory/alpha");
  });

  it("keeps agent switches in memory, restores per-agent conversation state, and exits explicitly", async () => {
    const alphaThread = thread("alpha-thread", "alpha");
    const betaThread = thread("beta-thread", "beta");
    window.history.replaceState(null, "", "/memory/alpha");
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([
      agent("alpha"),
      agent("beta"),
    ], [alphaThread, betaThread]));
    vi.mocked(api.threads).mockImplementation(async (sourceId) => ({
      threads: sourceId === "alpha" ? [alphaThread] : [betaThread],
    }));
    vi.mocked(api.thread).mockImplementation(async (threadId) =>
      detail(threadId === alphaThread.id ? alphaThread : betaThread));
    const store = await renderStore();

    act(() => store.current.selectAgent("beta"));
    await waitFor(() => expect(store.current.workspaceRoute).toEqual({ kind: "memory", sourceId: "beta" }));
    expect(window.location.pathname).toBe("/memory/beta");
    expect(store.current.selectedThreadId).toBe(betaThread.id);

    window.history.pushState(null, "", "/memory/alpha");
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    await waitFor(() => expect(store.current.selectedAgentId).toBe("alpha"));
    expect(store.current.selectedThreadId).toBe(alphaThread.id);

    act(() => store.current.openConversationIndex());
    await waitFor(() => expect(store.current.workspaceRoute).toEqual({ kind: "conversations" }));
    expect(window.location.pathname).toBe("/conversations");
    expect(store.current.selectedThreadId).toBe(alphaThread.id);
  });

  it("repairs a malformed memory route to the conversation index", async () => {
    window.history.replaceState(null, "", "/memory/%E0%A4%A");

    const store = await renderStore();

    await waitFor(() => expect(window.location.pathname).toBe("/conversations"));
    expect(store.current.workspaceRoute).toEqual({ kind: "conversations" });
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
    expect(api.thread).toHaveBeenCalledWith(cronThread.id);
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

    expect(api.thread).toHaveBeenCalledWith("redirected-legacy-id");
    expect(api.patchThread).toHaveBeenCalledWith("canonical-thread", { archived: true });
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

  it("keeps the anchored search window when the ordinary detail request finishes later", async () => {
    const searched = thread("searched", "alpha", {
      title: "Search result",
      searchMatch: { messageId: "answer/one", snippet: "exact answer" },
    });
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([agent("alpha")], [searched]));
    let resolveOrdinary!: (value: ThreadDetail) => void;
    vi.mocked(api.thread)
      .mockImplementationOnce(async () => await new Promise<ThreadDetail>((resolve) => {
        resolveOrdinary = resolve;
      }))
      .mockResolvedValue(detail(searched, "coordinated summary"));
    const anchoredMessage = {
      id: "answer/one",
      threadId: searched.id,
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: "exact answer" }],
      attachments: [],
      createdAt: "2026-08-24T09:00:00.000Z",
      updatedAt: "2026-08-24T09:00:00.000Z",
      status: "complete" as const,
    };
    vi.mocked(api.messagesAround).mockResolvedValue({ messages: [anchoredMessage] });
    const store = await renderStore();
    await waitFor(() => expect(api.thread).toHaveBeenCalledTimes(1));

    act(() => store.current.selectSearchMatch(searched.id, anchoredMessage.id));
    await waitFor(() => expect(store.current.detail?.messages.map(({ id }) => id))
      .toEqual([anchoredMessage.id]));
    expect(api.messagesAround).toHaveBeenCalledWith(searched.id, anchoredMessage.id);

    await act(async () => {
      resolveOrdinary(detail(searched, "ordinary stale page"));
      await Promise.resolve();
    });

    expect(store.current.detail?.messages.map(({ id }) => id)).toEqual([anchoredMessage.id]);
    expect(store.current.pendingMessageId).toBe(anchoredMessage.id);
    expect(window.location.pathname).toBe("/conversations/searched");
    expect(window.location.hash).toBe("#message-answer%2Fone");
  });

  it("jumps from an anchored window to the authoritative latest tail with over fifty newer messages", async () => {
    const searched = thread("long-search", "alpha", { title: "Long search result" });
    const message = (index: number) => ({
      id: `message-${String(index)}`,
      threadId: searched.id,
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: `message ${String(index)}` }],
      attachments: [],
      createdAt: new Date(Date.UTC(2026, 7, 24, 9, index)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 7, 24, 9, index)).toISOString(),
      status: "complete" as const,
    });
    const anchored = Array.from({ length: 100 }, (_, index) => message(index));
    const latest = Array.from({ length: 100 }, (_, index) => message(index + 51));
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([agent("alpha")], [searched]));
    vi.mocked(api.thread).mockResolvedValue({ thread: searched, messages: [message(150)] });
    vi.mocked(api.messagesAround).mockResolvedValue({ messages: anchored });
    const store = await renderStore();
    await waitFor(() => expect(store.current.detail?.thread.id).toBe(searched.id));
    vi.mocked(api.thread)
      .mockResolvedValueOnce({ thread: searched, messages: latest })
      .mockResolvedValueOnce({ thread: searched, messages: latest });

    act(() => store.current.selectSearchMatch(searched.id, "message-49"));
    await waitFor(() => expect(store.current.detail?.messages).toHaveLength(100));
    expect(store.current.detail?.messages.at(-1)?.id).toBe("message-99");
    expect(window.location.hash).toBe("#message-message-49");

    await act(async () => store.current.jumpToLatest());

    expect(api.thread).toHaveBeenLastCalledWith(searched.id);
    expect(store.current.detail?.messages.at(0)?.id).toBe("message-51");
    expect(store.current.detail?.messages.at(-1)?.id).toBe("message-150");
    expect(store.current.detail?.messages.some(({ id }) => id === "message-49")).toBe(false);
    expect(store.current.pendingMessageId).toBeNull();
    expect(window.location.pathname).toBe("/conversations/long-search");
    expect(window.location.hash).toBe("");
  });

  it("restores anchored message windows on reload and same-thread browser navigation", async () => {
    const searched = thread("deep-link", "alpha");
    window.history.replaceState(null, "", "/conversations/deep-link#message-answer%2Fone");
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([agent("alpha")], [searched]));
    vi.mocked(api.thread).mockResolvedValue(detail(searched));
    const pageFor = (id: string) => ({
      messages: [{
        id,
        threadId: searched.id,
        role: "assistant" as const,
        parts: [],
        attachments: [],
        createdAt: "2026-08-24T09:00:00.000Z",
        updatedAt: "2026-08-24T09:00:00.000Z",
        status: "complete" as const,
      }],
    });
    vi.mocked(api.messagesAround).mockImplementation(async (_threadId, anchor) => pageFor(anchor));

    const store = await renderStore();
    await waitFor(() => expect(store.current.detail?.messages.map(({ id }) => id))
      .toEqual(["answer/one"]));
    expect(api.messagesAround).toHaveBeenCalledWith("deep-link", "answer/one");

    act(() => store.current.clearPendingMessage());
    window.history.pushState(null, "", "/conversations/deep-link#message-answer%2Ftwo");
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));

    await waitFor(() => expect(store.current.detail?.messages.map(({ id }) => id))
      .toEqual(["answer/two"]));
    expect(api.messagesAround).toHaveBeenCalledWith("deep-link", "answer/two");
  });

  it("does not let a late failed search clear a newer anchor in the same thread", async () => {
    const searched = thread("same-search-thread", "alpha");
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([agent("alpha")], [searched]));
    vi.mocked(api.thread).mockResolvedValue(detail(searched));
    const store = await renderStore();
    await waitFor(() => expect(store.current.detail?.thread.id).toBe(searched.id));
    let rejectFirst!: (reason: unknown) => void;
    vi.mocked(api.thread)
      .mockImplementationOnce(async () => await new Promise<ThreadDetail>((_resolve, reject) => {
        rejectFirst = reject;
      }))
      .mockResolvedValue(detail(searched));
    const pageFor = (id: string) => ({
      messages: [{
        id,
        threadId: searched.id,
        role: "assistant" as const,
        parts: [],
        attachments: [],
        createdAt: "2026-08-24T09:00:00.000Z",
        updatedAt: "2026-08-24T09:00:00.000Z",
        status: "complete" as const,
      }],
    });
    vi.mocked(api.messagesAround).mockImplementation(async (_threadId, anchor) => pageFor(anchor));

    act(() => {
      store.current.selectSearchMatch(searched.id, "answer-a");
      store.current.selectSearchMatch(searched.id, "answer-b");
    });
    await waitFor(() => expect(store.current.detail?.messages.map(({ id }) => id))
      .toEqual(["answer-b"]));

    await act(async () => {
      rejectFirst(new Error("obsolete search failed"));
      await Promise.resolve();
    });

    expect(store.current.pendingMessageId).toBe("answer-b");
    expect(store.current.actionError).not.toBe("obsolete search failed");
  });

  it("reopens the same selected conversation after mobile Back returns to discovery", async () => {
    const selected = thread("same-thread", "alpha");
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([agent("alpha")], [selected]));
    vi.mocked(api.thread).mockResolvedValue(detail(selected));
    const store = await renderStore();
    await waitFor(() => expect(store.current.selectedThreadId).toBe(selected.id));
    expect(store.current.conversationDetailOpen).toBe(false);

    act(() => store.current.selectThread(selected.id));
    await waitFor(() => expect(store.current.conversationDetailOpen).toBe(true));

    act(() => store.current.openConversationIndex());
    await waitFor(() => expect(store.current.conversationDetailOpen).toBe(false));
    expect(store.current.selectedThreadId).toBe(selected.id);

    act(() => store.current.selectThread(selected.id));
    await waitFor(() => expect(store.current.conversationDetailOpen).toBe(true));
    expect(window.location.pathname).toBe("/conversations/same-thread");
  });

  it("serializes rapid independent conversation model and effort overrides", async () => {
    const preferred = thread("preferred", "alpha");
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([agent("alpha", {
      defaultEffort: "medium",
      modelOptions: { "provider/model": { reasoning: true, effortLevels: ["medium", "high"] } },
    })], [preferred]));
    vi.mocked(api.thread).mockResolvedValue(detail(preferred));
    const resolvers: Array<(value: typeof preferred) => void> = [];
    vi.mocked(api.patchThread).mockImplementation(async () => await new Promise((resolve) => {
      resolvers.push(resolve);
    }));
    const store = await renderStore();
    await waitFor(() => expect(store.current.detail?.thread.id).toBe(preferred.id));

    act(() => {
      store.current.setModel("provider/model");
      store.current.setEffort("high");
    });
    await waitFor(() => expect(api.patchThread).toHaveBeenCalledTimes(1));
    expect(api.patchThread).toHaveBeenNthCalledWith(1, preferred.id, {
      runPreference: { model: "provider/model" },
    });

    await act(async () => {
      resolvers[0]!({ ...preferred, revision: 2, runPreference: { model: "provider/model" } });
      await Promise.resolve();
    });
    await waitFor(() => expect(api.patchThread).toHaveBeenCalledTimes(2));
    expect(store.current.selectedThread?.runPreference).toEqual({
      model: "provider/model",
      effort: "high",
    });
    expect(api.patchThread).toHaveBeenNthCalledWith(2, preferred.id, {
      runPreference: { model: "provider/model", effort: "high" },
    });

    await act(async () => {
      resolvers[1]!({
        ...preferred,
        revision: 3,
        runPreference: { model: "provider/model", effort: "high" },
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(store.current.selectedThread?.revision).toBe(3));
    expect(store.current.selectedThread?.runPreference).toEqual({
      model: "provider/model",
      effort: "high",
    });
  });

  it("does not let an older workspace query overwrite newer running workflow state", async () => {
    const current = thread("revisioned", "alpha", {
      revision: 2,
      workflowStatus: "in_progress",
      runState: { status: "running", id: "turn-2", startedAt: "2026-08-24T09:00:00.000Z" },
    });
    const stale = thread("revisioned", "alpha", {
      revision: 1,
      workflowStatus: "todo",
      runState: { status: "idle" },
    });
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([agent("alpha")], [current]));
    vi.mocked(api.thread).mockResolvedValue(detail(current));
    vi.mocked(api.workspaceThreads).mockResolvedValue({ threads: [stale] });
    const store = await renderStore();
    await waitFor(() => expect(store.current.selectedThread?.revision).toBe(2));

    await act(async () => store.current.queryWorkspaceThreads({
      sourceIds: ["alpha"],
      type: "interactive",
    }));

    expect(store.current.selectedThread).toMatchObject({
      revision: 2,
      workflowStatus: "in_progress",
      runState: { status: "running" },
    });
  });

  it("clears an explicit effort only when the newly selected model does not support it", async () => {
    const preferred = thread("preference-validation", "alpha", {
      runPreference: { model: "reasoning", effort: "high" },
    });
    const source = agent("alpha", {
      models: ["reasoning", "plain"],
      defaultModel: "reasoning",
      modelOptions: {
        reasoning: { reasoning: true, effortLevels: ["low", "high"] },
        plain: { reasoningMode: "none" },
      },
    });
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([source], [preferred]));
    vi.mocked(api.thread).mockResolvedValue(detail(preferred));
    vi.mocked(api.patchThread).mockResolvedValue({
      ...preferred,
      revision: 2,
      runPreference: { model: "plain" },
    });
    const store = await renderStore();
    await waitFor(() => expect(store.current.detail?.thread.id).toBe(preferred.id));

    act(() => store.current.setModel("plain"));

    await waitFor(() => expect(api.patchThread).toHaveBeenCalledWith(preferred.id, {
      runPreference: { model: "plain" },
    }));
    await waitFor(() => expect(store.current.selectedThread?.runPreference)
      .toEqual({ model: "plain" }));
  });

  it("uploads legacy new-agent and thread preferences only into empty server contexts", async () => {
    const migratedThread = thread("migrated", "alpha");
    const newAgentKey = preferenceKeyForThread("alpha", null);
    const threadKey = preferenceKeyForThread("alpha", migratedThread.id);
    const removedAgentKey = preferenceKeyForThread("removed-agent", null);
    localStorage.setItem(RUN_PREFERENCES_STORAGE_KEY, JSON.stringify({
      [newAgentKey]: { model: "provider/model", effort: "" },
      [threadKey]: { model: "", effort: "high" },
      [removedAgentKey]: { model: "provider/model", effort: "" },
      "not-a-preference-key": { model: "provider/model", effort: "" },
    }));
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([agent("alpha", {
      modelOptions: { "provider/model": { reasoning: true, effortLevels: ["high"] } },
    })], [migratedThread]));
    vi.mocked(api.thread).mockResolvedValue(detail(migratedThread));
    vi.mocked(api.patchAgentPreferences).mockResolvedValue({
      sourceId: "alpha",
      runPreference: { model: "provider/model" },
    });
    vi.mocked(api.patchThread).mockResolvedValue({
      ...migratedThread,
      revision: 2,
      runPreference: { effort: "high" },
    });

    await renderStore();

    await waitFor(() => {
      expect(api.patchAgentPreferences).toHaveBeenCalledWith("alpha", {
        model: "provider/model",
      });
      expect(api.patchThread).toHaveBeenCalledWith(migratedThread.id, {
        runPreference: { effort: "high" },
        expectedRevision: migratedThread.revision,
      });
      expect(localStorage.getItem(RUN_PREFERENCES_STORAGE_KEY)).toBeNull();
    });
  });

  it("discards a legacy override whose model is no longer advertised", async () => {
    const key = preferenceKeyForThread("alpha", null);
    localStorage.setItem(RUN_PREFERENCES_STORAGE_KEY, JSON.stringify({
      [key]: { model: "removed/model", effort: "" },
    }));

    await renderStore();

    await waitFor(() => expect(localStorage.getItem(RUN_PREFERENCES_STORAGE_KEY)).toBeNull());
    expect(api.patchAgentPreferences).not.toHaveBeenCalled();
  });

  it("does not let the selected-agent preference read overwrite an in-flight migration", async () => {
    const key = preferenceKeyForThread("alpha", null);
    localStorage.setItem(RUN_PREFERENCES_STORAGE_KEY, JSON.stringify({
      [key]: { model: "provider/model", effort: "" },
    }));
    let resolveMigration!: (value: { sourceId: string; runPreference: { model: string } }) => void;
    vi.mocked(api.patchAgentPreferences).mockImplementation(async () => await new Promise((resolve) => {
      resolveMigration = resolve;
    }));
    const store = await renderStore();
    await waitFor(() => expect(api.patchAgentPreferences).toHaveBeenCalledTimes(1));
    expect(api.agentPreferences).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveMigration({ sourceId: "alpha", runPreference: { model: "provider/model" } });
      await Promise.resolve();
    });

    await waitFor(() => expect(store.current.agentPreferences.alpha)
      .toEqual({ model: "provider/model" }));
    expect(api.agentPreferences).toHaveBeenCalledTimes(1);
  });

  it("retains a legacy preference until its server migration succeeds", async () => {
    const key = preferenceKeyForThread("alpha", null);
    localStorage.setItem(RUN_PREFERENCES_STORAGE_KEY, JSON.stringify({
      [key]: { model: "provider/model", effort: "" },
    }));
    vi.mocked(api.patchAgentPreferences).mockRejectedValue(new Error("preference unavailable"));

    const store = await renderStore();

    await waitFor(() => expect(store.current.actionError).toBe("preference unavailable"));
    expect(JSON.parse(localStorage.getItem(RUN_PREFERENCES_STORAGE_KEY) ?? "{}"))
      .toHaveProperty(key);
  });
});
