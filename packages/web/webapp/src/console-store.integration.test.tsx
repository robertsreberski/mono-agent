import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import {
  CATALOG_TTL_MS,
  ConsoleStoreProvider,
  cronChannelPath,
  preferenceKeyForThread,
  RUN_PREFERENCES_STORAGE_KEY,
  useConsoleStore,
} from "./console-store";
import { agent, bootstrap, thread } from "./test/fixtures";
import type { AgentSkillRegistry, CronOverview, ThreadDetail } from "./types";

vi.mock("./api", () => ({
  api: {
    bootstrap: vi.fn(),
    thread: vi.fn(),
    threads: vi.fn(),
    messages: vi.fn(),
    createThread: vi.fn(),
    patchThread: vi.fn(),
    deleteThread: vi.fn(),
    patchAgent: vi.fn(),
    agentSkills: vi.fn(),
    agentModels: vi.fn(),
    startTurn: vi.fn(),
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
    vi.mocked(api.cronRuns).mockResolvedValue({ runs: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
      await act(async () => { await store.current.loadMoreThreads(); });
      act(() => FakeEventSource.latest?.emit("threads.changed", {
        id: "event-1",
        version: 1,
        type: "threads.changed",
        at: "2026-08-14T09:00:00.000Z",
      }));
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 400); }); });
      expect(store.current.threads.map((item) => item.id)).toEqual([]);

      await act(async () => {
        releaseDelete?.();
        await deleted;
      });
      // And a bootstrap that answers after the delete completed is still stale.
      act(() => FakeEventSource.latest?.emit("threads.changed", {
        id: "event-2",
        version: 1,
        type: "threads.changed",
        at: "2026-08-14T09:00:01.000Z",
      }));
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 400); }); });
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
      act(() => FakeEventSource.latest?.emit("threads.changed", {
        id: "event-1",
        version: 1,
        type: "threads.changed",
        at: "2026-08-14T09:00:00.000Z",
      }));
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 400); }); });
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
});
