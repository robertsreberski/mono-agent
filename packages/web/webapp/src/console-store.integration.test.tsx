// The console keeps recent conversations on the device now, so every test in
// this file runs the persistence path as well: hydration before the first read,
// and the debounced write-through behind it. The store is emptied before each
// test, so what any one of them restores is exactly what it seeded.
import "fake-indexeddb/auto";
import { act, cleanup as cleanupDom, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  ApiError,
  LEAN_MESSAGE_PAGE_LIMIT,
  LEAN_THREAD_PAGE_LIMIT,
  MESSAGE_PAGE_LIMIT,
  NOT_MODIFIED,
  THREAD_PAGE_LIMIT,
} from "./api";
import { writeDataModeSetting } from "./data-mode";
import { resetServerClock, serverNow } from "./server-clock";
import {
  CATALOG_TTL_MS,
  ConsoleStoreProvider,
  LEAN_DELTA_BATCH_MS,
  HYDRATION_DEADLINE_MS,
  PERSIST_DEBOUNCE_MS,
  cronChannelPath,
  preferenceKeyForThread,
  reconcileFailedDelete,
  REMOVED_THREAD_TTL_MS,
  RUN_PREFERENCES_STORAGE_KEY,
  SELECTED_AGENT_STORAGE_KEY,
  SELECTED_THREADS_STORAGE_KEY,
  STREAM_SILENCE_LIMIT_MS,
  THREAD_LIST_REVALIDATE_DEBOUNCE_MS,
  THREAD_READ_TIMEOUT_MS,
  THREAD_WRITE_TIMEOUT_MS,
  threadBucketKey,
  useConsoleStore,
} from "./console-store";
import type { RequestLanding } from "./console-store";
import { canSendInConsole } from "./capabilities";
import { agent, bootstrap, thread, uploadLimits } from "./test/fixtures";
import type { ThreadCacheEntry } from "./thread-cache";
import {
  acquireReplyImageBlob,
  clearReplyImageBlobs,
  publishReplyImageBlob,
  releaseReplyImageBlob,
  replyImageKey,
  retainedReplyImageBytes,
} from "./components/reply-image-cache";
import { createThreadPersistence } from "./thread-persistence";
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
    threadIfChanged: vi.fn(),
    liveInput: vi.fn(),
  },
}));

/**
 * Never emits `ready` and never calls `onopen` unless a test does so itself.
 *
 * Which is deliberate -- most tests are about what an EVENT costs -- but it
 * means the read counts in the cache describe are not production request
 * counts: a real console's first `ready` and every reconnect's resync are
 * absent unless the test emits them.
 */
class FakeEventSource {
  static latest: FakeEventSource | undefined;
  /** Every stream this render opened, in order: a reconnect is a new entry. */
  static instances: FakeEventSource[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  /** `EventSource.CLOSED` is 2; tests set it to model a socket the OS killed. */
  readyState = 1;
  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.latest = this;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

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

/**
 * Another owner of the same device store -- which is what a second tab is, and
 * what these tests use to seed a visit and to read back what one wrote.
 */
const deviceStore = createThreadPersistence();

/** The real (fake-indexeddb) factory, kept for the tests that stub a broken one. */
const realIndexedDb = globalThis.indexedDB;

/** An `indexedDB.open` that answers nothing at all -- WebKit, after a suspension. */
const deafIndexedDb = (): IDBFactory => ({
  open: () => ({
    onsuccess: null,
    onerror: null,
    onblocked: null,
    onupgradeneeded: null,
  }) as unknown as IDBOpenDBRequest,
}) as unknown as IDBFactory;

/** A real open, answered late. */
const slowIndexedDb = (delayMs: number): IDBFactory => ({
  open: (name: string, version?: number) => {
    const inner = version === undefined
      ? realIndexedDb.open(name)
      : realIndexedDb.open(name, version);
    const proxy: Record<string, unknown> = {
      result: undefined,
      onsuccess: null,
      onerror: null,
      onblocked: null,
      onupgradeneeded: null,
    };
    inner.onupgradeneeded = (event) => {
      proxy.result = inner.result;
      (proxy.onupgradeneeded as ((value: Event) => void) | null)?.(event);
    };
    inner.onsuccess = () => {
      proxy.result = inner.result;
      setTimeout(() => (proxy.onsuccess as (() => void) | null)?.(), delayMs);
    };
    inner.onerror = () => {
      setTimeout(() => (proxy.onerror as (() => void) | null)?.(), delayMs);
    };
    return proxy as unknown as IDBOpenDBRequest;
  },
}) as unknown as IDBFactory;

describe("ConsoleStoreProvider integration", () => {
  beforeEach(async () => {
    await deviceStore.clearAll();
    vi.clearAllMocks();
    // `clearAllMocks` forgets CALLS, not implementations. A `mockImplementation`
    // one case installs for `api.thread` or `api.threadIfChanged` would answer
    // every case after it, and a case that passes on the strength of an answer
    // it never asked for is one that breaks the moment the file is reordered.
    // Reset both; every case installs what it needs.
    vi.mocked(api.thread).mockReset();
    vi.mocked(api.threadIfChanged).mockReset();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    FakeEventSource.latest = undefined;
    FakeEventSource.instances = [];
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
    // The third argument is the validator a conditional re-read quotes; there
    // is none to quote on a first read of this agent.
    await waitFor(() => expect(api.agentSkills)
      .toHaveBeenCalledWith("alpha", expect.any(AbortSignal), undefined));

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
      expect(api.threads).toHaveBeenCalledWith("alpha", false, "cursor-1", expect.any(AbortSignal), THREAD_PAGE_LIMIT);
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
      expect(api.threads).toHaveBeenCalledWith("beta", false, undefined, expect.any(AbortSignal), THREAD_PAGE_LIMIT);
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

    it("applies the summary an event carries and reads nothing for it", async () => {
      // The summary IS the sidebar row, and applying it is the whole of what
      // this event means. It used to re-read the entire conversation for the
      // transcript, because a finished turn, a reconciled cron run and an
      // appended notification all ended here and nothing else said the
      // transcript had moved. Every one of those writes now names its message.
      const store = await openOnAlpha();
      await waitFor(() => expect(store.current.detail?.thread.id).toBe("alpha-thread"));
      const detailReads = vi.mocked(api.thread).mock.calls.length;

      emit("thread.changed", {
        threadId: "alpha-thread",
        payload: { thread: { ...alphaThread, title: "Named by the agent", revision: 3 } },
      });
      await quiet();

      expect(store.current.threads.find((item) => item.id === "alpha-thread")?.title)
        .toBe("Named by the agent");
      expect(api.bootstrap).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.thread).mock.calls.length).toBe(detailReads);

      // A transcript move DOES still cost a read -- through the event built for
      // it. A hint naming a row this tab does not hold is a new message, and
      // only the conversation read can place it.
      emit("message.changed", {
        threadId: "alpha-thread",
        payload: { messageId: "appended", updatedAt: "2026-08-14T09:00:00.000Z" },
      });
      await waitFor(() => expect(vi.mocked(api.thread).mock.calls.length).toBe(detailReads + 1));
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
      expect(api.threads).toHaveBeenCalledWith("alpha", false, undefined, expect.any(AbortSignal), THREAD_PAGE_LIMIT);
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

    it("spends a ready with a gap behind it on the open conversation, and every other one on nothing", async () => {
      seedTwoThreads();
      vi.mocked(api.agentSkills).mockResolvedValue({ status: "ready", items: [], total: 0 });
      const store = await openedOnAlpha();
      await waitFor(() => expect(store.current.skillRegistry.status).toBe("ready"));
      const detailReads = vi.mocked(api.thread).mock.calls.length;

      // A fresh browser has no stored selection to seed the subscription from,
      // so the stream this tab opened before the snapshot resolved one is
      // re-pointed at it -- and the round trip between those two sockets is a
      // gap like any other. It costs ONE conditional read of the open
      // conversation, and no snapshot.
      emit("ready", { payload: { version: 1 } });
      await quiet();
      expect(api.bootstrap).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.thread).mock.calls.length).toBe(detailReads + 1);
      const skillReads = vi.mocked(api.agentSkills).mock.calls.length;

      // A `ready` with nothing behind it -- the same socket, still open --
      // costs nothing at all.
      emit("ready", { payload: { version: 1 } });
      await quiet();
      expect(api.bootstrap).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.thread).mock.calls.length).toBe(detailReads + 1);
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

      // The snapshot is NOT re-bought: the gap invalidated the conversation on
      // screen and the listing, and each is answered on its own -- the
      // conversation with one read, the listing with one merge page.
      expect(api.bootstrap).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.thread).mock.calls.length).toBe(detailReads + 2);
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

    it("asks for half a page of everything on a lean link", async () => {
      writeDataModeSetting("lean");
      const recent = streamed("recent", "recent", { createdAt: "2026-08-14T08:00:00.000Z" });
      seedTwo([recent]);
      vi.mocked(api.thread).mockImplementation(async () =>
        ({ thread: alpha, messages: [recent], messagesNextCursor: "cursor-1" }));
      vi.mocked(api.messages).mockResolvedValue({ messages: [] });
      const store = await openedOnAlpha();

      expect(api.bootstrap).toHaveBeenCalledWith(
        expect.any(AbortSignal),
        expect.objectContaining({ limit: LEAN_THREAD_PAGE_LIMIT }),
      );
      expect(LEAN_THREAD_PAGE_LIMIT).toBeLessThan(THREAD_PAGE_LIMIT);

      act(() => { store.current.setShowArchived(true); });
      await waitFor(() => { expect(api.threads).toHaveBeenCalled(); });
      expect(vi.mocked(api.threads).mock.calls.at(-1)?.[4]).toBe(LEAN_THREAD_PAGE_LIMIT);

      await act(async () => { await store.current.loadOlderMessages(); });
      expect(vi.mocked(api.messages).mock.calls.at(-1)?.[3]).toBe(LEAN_MESSAGE_PAGE_LIMIT);
      expect(LEAN_MESSAGE_PAGE_LIMIT).toBeLessThan(MESSAGE_PAGE_LIMIT);
    });

    it("applies a running turn's writes on one tick on a lean link, and a finish at once", async () => {
      writeDataModeSetting("lean");
      seedTwo([streamed("m1", "Hel")]);
      const store = await openedOnAlpha();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        emitDelta(alpha.id, { ops: [{ op: "append", index: 0, delta: "l" }] });
        emitDelta(alpha.id, { baseSeq: 2, seq: 3, ops: [{ op: "append", index: 0, delta: "o" }] });

        // Both writes are in the cache; neither has been painted yet. A phone
        // rendering every frame of a running turn spends battery, not bytes,
        // and this is the one that costs battery.
        expect(screen.getByTestId("message-m1").textContent).toBe("Hel");

        await act(async () => { await vi.advanceTimersByTimeAsync(LEAN_DELTA_BATCH_MS); });
        expect(screen.getByTestId("message-m1").textContent).toBe("Hello");

        // The write that ENDS the turn is not batched: a finished answer that
        // arrives a second late reads as a console that is still thinking.
        emitDelta(alpha.id, {
          baseSeq: 3,
          seq: 4,
          status: "complete",
          ops: [{ op: "append", index: 0, delta: "!" }],
        });
        expect(screen.getByTestId("message-m1").textContent).toBe("Hello!");
      } finally {
        vi.useRealTimers();
      }
      expect(vi.mocked(api.thread).mock.calls.length).toBe(1);
      expect(store.current.detail?.messages.at(-1)?.status).toBe("complete");
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

    it("follows up on a deep-link read a write overtook", async () => {
      // A push notification or a search hit opens a conversation this tab holds
      // no row for, and THAT read goes out from `selectThread` rather than from
      // the selection effect. It is the same race, and it was the one read that
      // did not quote the clock: a write landing while it was on the wire left
      // it looking like the newest thing the server had said.
      //
      // The deep-link read is the ONLY read this open makes -- the selection
      // effect stands aside for it -- so the delta has to be answered by the
      // clock that read quoted, and by nothing else.
      seedTwo();
      const store = await openedOnAlpha();
      const deepLinked = thread("deep-linked", "alpha");
      const stale = (): ThreadDetail => ({
        thread: deepLinked,
        messages: [streamed("d1", "Hel", { threadId: deepLinked.id, seq: 1 })],
      });
      const opens: ((detail: ThreadDetail) => void)[] = [];
      vi.mocked(api.thread).mockImplementation(async (threadId) => {
        if (threadId !== deepLinked.id) return { thread: alpha, messages: [streamed("m1", "Hel")] };
        // The FIRST open -- `selectThread`'s own -- is held; the follow-up
        // answers at once, with the version the delta described.
        if (opens.length === 0) {
          return new Promise<ThreadDetail>((resolve) => { opens.push(resolve); });
        }
        opens.push(() => undefined);
        return {
          thread: deepLinked,
          messages: [streamed("d1", "Hello", {
            threadId: deepLinked.id, seq: 2, status: "complete",
          })],
        };
      });
      const reads = vi.mocked(api.thread).mock.calls.length;

      act(() => {
        store.current.selectThread(deepLinked.id);
        // While the deep-link request is on the wire.
        FakeEventSource.latest?.emit("message.delta", {
          id: "deep-link-delta",
          version: 1,
          type: "message.delta",
          at: "2026-08-14T09:00:00.000Z",
          threadId: deepLinked.id,
          payload: {
            messageId: "d1",
            baseSeq: 1,
            seq: 2,
            status: "complete",
            updatedAt: "2026-08-14T09:00:00.000Z",
            ops: [{ op: "append", index: 0, delta: "lo" }],
          },
        });
      });
      await waitFor(() => expect(opens.length).toBe(1));
      // Nothing was spent on a conversation there was nowhere to land it in.
      expect(api.message).not.toHaveBeenCalled();

      await act(async () => {
        opens[0]?.(stale());
        await new Promise((resolve) => { setTimeout(resolve, 0); });
      });

      // The deep-link answer predates the write, so it costs one follow-up --
      // and exactly one: the open itself is a single read now.
      await waitFor(async () =>
        expect(await screen.findByTestId("message-d1")).toHaveTextContent("Hello"));
      await quiet();
      expect(vi.mocked(api.thread).mock.calls.length).toBe(reads + 2);
      expect(api.message).not.toHaveBeenCalled();
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

    it("knows a turn is running on a conversation the listing does not show", async () => {
      // The sidebar shows one agent's one bucket. A turn running on another
      // agent -- or past the listed page -- is still one this tab is watching,
      // and everything that defers to a running turn has to be able to see it.
      // Read off the CACHE's held set for exactly that reason.
      const runningAlpha = { ...alpha, runState: { status: "running" as const, id: "turn-1" } };
      const gamma = thread("gamma-thread", "beta");
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })],
        [runningAlpha],
        undefined,
        { threadsSourceId: "alpha" },
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [gamma] });
      vi.mocked(api.thread).mockImplementation(async (threadId) => threadId === gamma.id
        ? { thread: gamma, messages: [] }
        : { thread: runningAlpha, messages: [streamed("m1", "Hel")] });
      const store = await openedOnAlpha();
      expect(store.current.hasRunningThread).toBe(true);

      act(() => { store.current.selectAgent("beta"); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(gamma.id));
      await quiet();

      // Beta's bucket is what the sidebar draws, and alpha is nowhere in it...
      expect(store.current.visibleThreads.map((row) => row.id)).toEqual([gamma.id]);
      expect(store.current.selectedThread?.id).toBe(gamma.id);
      expect(store.current.selectedThread?.runState.status).not.toBe("running");
      // ...but alpha is still held, and still running.
      expect(store.current.hasRunningThread).toBe(true);
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

    it("never paints the old transcript when unarchiving or restoring a conversation", async () => {
      // The same one-frame flash, on the two selection moves that were missed:
      // unarchiving a conversation, and the selection a failed delete owes back.
      const archived = thread("archived-thread", "alpha", {
        archivedAt: "2026-07-17T09:30:00.000Z",
        updatedAt: "2026-07-17T09:30:00.000Z",
      });
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [alpha, archived],
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [alpha, archived] });
      vi.mocked(api.thread).mockImplementation(async (threadId) => threadId === archived.id
        ? { thread: archived, messages: [streamed("a1", "archived", { threadId: archived.id })] }
        : { thread: alpha, messages: [streamed("m1", "Hel")] });
      vi.mocked(api.patchThread).mockResolvedValue({ ...archived, archivedAt: null, revision: 2 });
      const store = await openedOnAlpha();

      paints = [];
      await act(async () => { await store.current.unarchiveThread(archived.id); });

      expect(store.current.selectedThreadId).toBe(archived.id);
      // The read the selection provokes settles in its own commit, and a frame
      // painted THERE is exactly what this is looking for -- so let it land,
      // the way the sibling case does.
      await quiet();
      expect(mispaints()).toEqual([]);
    });

    it("never paints the old transcript when a failed delete gives the selection back", async () => {
      // A bootstrap that answered while the conversation was tombstoned moves
      // the selection to a survivor; the refusal then gives it back. Both are
      // selection moves, and the second one used to leave the survivor's
      // transcript under the restored conversation's header.
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [alpha, beta],
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [alpha, beta] });
      vi.mocked(api.thread).mockImplementation(async (threadId) => threadId === beta.id
        ? { thread: beta, messages: [streamed("b1", "beta", { threadId: beta.id })] }
        : { thread: alpha, messages: [streamed("m1", "Hel")] });
      let failDelete!: (error: unknown) => void;
      vi.mocked(api.deleteThread).mockImplementation(async () =>
        new Promise<void>((_resolve, reject) => { failDelete = reject; }));
      const store = await openedOnAlpha();

      const deleted = store.current.deleteThread(alpha.id);
      await waitFor(() => expect(failDelete).toBeDefined());
      // The bootstrap answers while the tombstone stands and re-resolves the
      // selection onto the survivor.
      emit("agents.changed");
      await waitFor(() => expect(store.current.selectedThreadId).toBe(beta.id));
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(beta.id));

      paints = [];
      await act(async () => {
        failDelete(new ApiError("Cancel the active turn first.", 409, "turn_active"));
        await expect(deleted).rejects.toBeInstanceOf(ApiError);
      });
      await waitFor(() => expect(store.current.selectedThreadId).toBe(alpha.id));
      await quiet();

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

    it("re-reads the conversation on screen at once, and each kept one when it is opened", async () => {
      seedTwo();
      const store = await openedOnAlpha();
      // The stream's own first `ready`, so the one below is known to have a
      // GAP behind it rather than being the snapshot the mount already read.
      emit("ready", { payload: { version: 1 } });
      act(() => { store.current.selectThread(beta.id); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(beta.id));
      const reads = vi.mocked(api.thread).mock.calls.length;

      act(() => FakeEventSource.latest?.onerror?.(new Event("error")));
      await waitFor(() => expect(store.current.connection).toBe("reconnecting"));
      act(() => FakeEventSource.latest?.onopen?.(new Event("open")));
      emit("ready", { payload: { version: 1 } });
      await quiet();

      // ONE read now -- the conversation on screen. A reconnect used to buy the
      // whole snapshot on top of it.
      expect(vi.mocked(api.thread).mock.calls.length).toBe(reads + 1);
      expect(vi.mocked(api.thread).mock.calls.at(-1)?.[0]).toBe(beta.id);
      expect(api.bootstrap).toHaveBeenCalledTimes(1);

      // And ONE for the conversation it kept, deferred to the moment it is
      // opened. Both are unconditional only because this fixture serves no
      // validator -- see "re-reads every conversation it kept across a gap,
      // conditionally".
      await quiet(THREAD_LIST_REVALIDATE_DEBOUNCE_MS + 400);
      act(() => { store.current.selectThread(alpha.id); });
      await waitFor(() => expect(vi.mocked(api.thread).mock.calls.length).toBe(reads + 2));
      await quiet();
      expect(vi.mocked(api.thread).mock.calls.length).toBe(reads + 2);
      expect(store.current.detail?.thread.id).toBe(alpha.id);
    }, 15_000);

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

  describe("a stream subscribed to the conversation on screen", () => {
    const alpha = thread("alpha-thread", "alpha");
    const beta = thread("beta-thread", "alpha", { updatedAt: "2026-07-17T09:00:00.000Z" });
    const gamma = thread("gamma-thread", "alpha", { updatedAt: "2026-07-17T08:00:00.000Z" });
    let eventSequence = 0;

    const held = (
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
        id: `stream-event-${String(eventSequence)}`,
        version: 1,
        type,
        at: "2026-08-14T09:00:00.000Z",
        ...extra,
      }));
    };

    const quiet = async (ms = 400) => {
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, ms); }); });
    };

    /** The stream currently open, and what conversation it named. */
    const liveUrl = () => FakeEventSource.instances.at(-1)?.url;
    const streamCount = () => FakeEventSource.instances.length;

    const seedTwo = (messages: readonly WebMessage[] = [held("m1", "Hel")]) => {
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        [agent("alpha", { label: "Alpha" })],
        [alpha, beta],
      ));
      vi.mocked(api.threads).mockResolvedValue({ threads: [alpha, beta] });
      vi.mocked(api.thread).mockImplementation(async (threadId) => threadId === alpha.id
        ? { thread: alpha, messages, etag: 'W/"alpha-1"' }
        : { thread: beta, messages: [held("b1", "beta", { threadId: beta.id })], etag: 'W/"beta-1"' });
    };

    /** The transcript the operator is actually looking at, as text. */
    function StreamTranscript() {
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

    const openedOnAlpha = async () => {
      let current: Store | undefined;
      const onChange = (store: Store) => { current = store; };
      render(
        <ConsoleStoreProvider>
          <StoreProbe onChange={onChange} />
          <StreamTranscript />
        </ConsoleStoreProvider>,
      );
      await waitFor(() => expect(current?.loading).toBe(false));
      const store = {
        get current() {
          if (!current) throw new Error("Store did not initialize.");
          return current;
        },
      };
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(alpha.id));
      await quiet();
      return store;
    };

    /** The stream drops the way a browser reports it: an error, then an open. */
    const dropAndReopen = () => {
      act(() => FakeEventSource.latest?.onerror?.(new Event("error")));
      act(() => FakeEventSource.latest?.onopen?.(new Event("open")));
    };

    it("names the conversation on screen on the stream itself", async () => {
      seedTwo();
      const store = await openedOnAlpha();

      // Nothing was selected when the console opened its first stream, and an
      // empty `?thread=` is a 400 -- so the parameter is absent, not blank.
      expect(FakeEventSource.instances[0]?.url).toBe("/api/v1/events");
      expect(liveUrl()).toBe(`/api/v1/events?thread=${encodeURIComponent(alpha.id)}`);

      act(() => { store.current.selectThread(beta.id); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(beta.id));
      await quiet();

      expect(liveUrl()).toBe(`/api/v1/events?thread=${encodeURIComponent(beta.id)}`);
      // The stream it re-pointed is closed; a console holding both would count
      // twice against the server's client cap.
      expect(FakeEventSource.instances.at(-2)?.closed).toBe(true);
    });

    it("costs one reconnect for a switch, and none for one the operator took back", async () => {
      seedTwo();
      const store = await openedOnAlpha();
      const opened = streamCount();

      // Away and back inside the debounce: the subscription never moved, so
      // there was never anything to re-point.
      act(() => { store.current.selectThread(beta.id); });
      act(() => { store.current.selectThread(alpha.id); });
      await quiet();
      expect(streamCount()).toBe(opened);
      expect(liveUrl()).toBe(`/api/v1/events?thread=${encodeURIComponent(alpha.id)}`);

      // A switch that settles costs exactly one.
      act(() => { store.current.selectThread(beta.id); });
      await quiet();
      expect(streamCount()).toBe(opened + 1);
      expect(liveUrl()).toBe(`/api/v1/events?thread=${encodeURIComponent(beta.id)}`);
    });

    it("answers a reconnect with one conditional read instead of the whole projection", async () => {
      seedTwo();
      vi.mocked(api.agentSkills).mockResolvedValue({ status: "ready", items: [], total: 0 });
      const store = await openedOnAlpha();
      await waitFor(() => expect(store.current.skillRegistry.status).toBe("ready"));
      const reads = vi.mocked(api.thread).mock.calls.length;
      const transcript = store.current.detail?.messages;
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);

      dropAndReopen();
      emit("ready", { payload: { version: 1 } });
      await quiet();

      // The validator the opening read was served with, quoted back.
      expect(vi.mocked(api.threadIfChanged).mock.calls.map((call) => [call[0], call[1]]))
        .toEqual([[alpha.id, 'W/"alpha-1"']]);
      // A reconnect used to buy the whole snapshot and the whole conversation.
      expect(api.bootstrap).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.thread).mock.calls.length).toBe(reads);
      // Nothing was replaced, so assistant-ui keeps every conversion it made.
      expect(store.current.detail?.messages).toBe(transcript);
      expect(store.current.connection).toBe("live");
    });

    it("takes the transcript when the conditional read says it moved", async () => {
      seedTwo();
      const store = await openedOnAlpha();
      vi.mocked(api.threadIfChanged).mockResolvedValue({
        thread: { ...alpha, revision: 2 },
        messages: [
          held("m1", "Hello", { seq: 2, updatedAt: "2026-08-14T09:00:00.000Z" }),
          held("m2", "and more"),
        ],
        etag: 'W/"alpha-2"',
      });

      dropAndReopen();
      emit("ready", { payload: { version: 1 } });
      await quiet();

      expect(store.current.detail?.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
      expect(await screen.findByTestId("message-m1")).toHaveTextContent("Hello");

      // And the validator it answered with is the one the NEXT reconnect quotes.
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);
      dropAndReopen();
      emit("ready", { payload: { version: 1 } });
      await quiet();
      expect(vi.mocked(api.threadIfChanged).mock.calls.at(-1)?.[1]).toBe('W/"alpha-2"');
    });

    it("rebuilds a stream an app switch left closed, still naming the open conversation", async () => {
      seedTwo();
      const store = await openedOnAlpha();
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);
      const opened = streamCount();

      // iOS suspends the tab and the socket dies with it; nothing tells the
      // page until it comes back.
      const killed = FakeEventSource.latest;
      if (killed !== undefined) killed.readyState = 2;
      act(() => { document.dispatchEvent(new Event("visibilitychange")); });

      expect(streamCount()).toBe(opened + 1);
      expect(liveUrl()).toBe(`/api/v1/events?thread=${encodeURIComponent(alpha.id)}`);
      expect(store.current.connection).toBe("reconnecting");

      emit("ready", { payload: { version: 1 } });
      await quiet();
      expect(vi.mocked(api.threadIfChanged).mock.calls.map((call) => [call[0], call[1]]))
        .toEqual([[alpha.id, 'W/"alpha-1"']]);
      expect(api.bootstrap).toHaveBeenCalledTimes(1);
    });

    it("rebuilds a stream that went silent while the tab was in the background", async () => {
      seedTwo();
      await openedOnAlpha();
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);
      const opened = streamCount();
      // The socket still reads OPEN, which is exactly the iOS case: the system
      // suspended it and a read-only stream never writes, so the browser has no
      // way to find out.
      expect(FakeEventSource.latest?.readyState).toBe(1);

      const realNow = Date.now.bind(Date);
      let offset = 0;
      const dateNow = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
      let visibility = "hidden";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => visibility,
      });
      try {
        act(() => { document.dispatchEvent(new Event("visibilitychange")); });
        // Backgrounded, and left alone: a briefly-hidden tab still receives
        // what its stream sends.
        expect(streamCount()).toBe(opened);

        offset = STREAM_SILENCE_LIMIT_MS + 1_000;
        visibility = "visible";
        act(() => { document.dispatchEvent(new Event("visibilitychange")); });

        expect(streamCount()).toBe(opened + 1);
        expect(liveUrl()).toBe(`/api/v1/events?thread=${encodeURIComponent(alpha.id)}`);
      } finally {
        dateNow.mockRestore();
        // Own property, shadowing jsdom's prototype getter: removing it puts
        // the real one back.
        Reflect.deleteProperty(document, "visibilityState");
      }
    });

    it("refreshes the listing a reconnect missed with one page, not a snapshot", async () => {
      seedTwo();
      const store = await openedOnAlpha();
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);
      const pages = vi.mocked(api.threads).mock.calls.length;

      dropAndReopen();
      emit("ready", { payload: { version: 1 } });
      // The listing revalidation has its own, slower debounce -- it is the
      // least specific thing an invalidation can ask for.
      await quiet(THREAD_LIST_REVALIDATE_DEBOUNCE_MS + 400);

      expect(vi.mocked(api.threads).mock.calls.length).toBe(pages + 1);
      expect(api.bootstrap).toHaveBeenCalledTimes(1);
      // A merge, so the page cannot truncate the sidebar the operator is
      // looking at.
      expect(store.current.visibleThreads.map((item) => item.id)).toEqual([alpha.id, beta.id]);

      // And only once: a second `ready` with nothing behind it buys nothing.
      emit("ready", { payload: { version: 1 } });
      await quiet(THREAD_LIST_REVALIDATE_DEBOUNCE_MS + 400);
      expect(vi.mocked(api.threads).mock.calls.length).toBe(pages + 1);
      // Two waits on the listing's own 2 s debounce.
    }, 15_000);

    it("leaves a healthy stream alone when the tab merely comes back to the front", async () => {
      seedTwo();
      await openedOnAlpha();
      const opened = streamCount();

      act(() => { document.dispatchEvent(new Event("visibilitychange")); });
      await quiet();

      expect(streamCount()).toBe(opened);
      expect(api.threadIfChanged).not.toHaveBeenCalled();
    });

    it("rebuilds the stream a back-forward restore froze", async () => {
      seedTwo();
      await openedOnAlpha();
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);
      const opened = streamCount();

      // A page restored from the back-forward cache reports `persisted`, and
      // its stream did not come back with it -- whatever `readyState` says.
      act(() => {
        const restored = new Event("pageshow");
        Object.defineProperty(restored, "persisted", { value: true });
        window.dispatchEvent(restored);
      });

      expect(streamCount()).toBe(opened + 1);
      expect(liveUrl()).toBe(`/api/v1/events?thread=${encodeURIComponent(alpha.id)}`);
    });

    it("revalidates the skill registry rather than re-reading it", async () => {
      // Every transition back to "live" buys a registry read, and an app switch
      // on a phone is one of those. The registry changes when the agent's
      // advertisement does, which is rare -- so the read quotes what it was
      // served with, and a 304 simply lifts the "stale" the disconnect marked.
      seedTwo();
      vi.mocked(api.agentSkills).mockResolvedValue({
        status: "ready", items: [], total: 0, etag: 'W/"skills-1"',
      });
      const store = await openedOnAlpha();
      await waitFor(() => expect(store.current.skillRegistry.status).toBe("ready"));
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);
      vi.mocked(api.agentSkills).mockResolvedValue(NOT_MODIFIED);

      dropAndReopen();
      emit("ready", { payload: { version: 1 } });
      await quiet();

      expect(vi.mocked(api.agentSkills).mock.calls.at(-1)?.[2]).toBe('W/"skills-1"');
      // The registry the 304 spoke for is on screen, ready, not stale.
      expect(store.current.skillRegistry.status).toBe("ready");
    });

    it("never quotes a validator for a registry it could not hold as ready", async () => {
      // The server answers 200 with `unsupported` and `offline` payloads too,
      // and Express mints an ETag for those. Stored, that validator later
      // answered 304 for a registry `retainAsStale` cannot lift back to
      // "ready" -- the console sat at "Loading skills…" for the rest of the
      // session and re-quoted the poisoned validator on every reconnect.
      seedTwo();
      vi.mocked(api.agentSkills).mockResolvedValue({
        status: "unsupported", items: [], etag: 'W/"unsupported-1"',
      });
      const store = await openedOnAlpha();
      await waitFor(() => expect(store.current.skillRegistry.status).toBe("unsupported"));
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);
      vi.mocked(api.agentSkills).mockClear();

      dropAndReopen();
      emit("ready", { payload: { version: 1 } });
      await quiet();

      // Unconditional: there is no READY answer this tab is holding for that
      // validator to describe.
      expect(vi.mocked(api.agentSkills).mock.calls.map((call) => call[2])).toEqual([undefined]);
      expect(store.current.skillRegistry.status).toBe("unsupported");
    });

    it("re-reads unconditionally when a 304 answers a registry it cannot lift", async () => {
      // A bug guard, not a path the store can reach on its own: a 304 is only
      // ever the answer to a validator a READY registry left behind, so one
      // arriving when there is no stale copy to lift means the two have come
      // apart. Answered by dropping the validator and reading once more, never
      // by leaving the operator at "Loading skills…" for the session.
      seedTwo();
      let answers = 0;
      vi.mocked(api.agentSkills).mockImplementation(async () => {
        answers += 1;
        return answers === 1 ? NOT_MODIFIED : { status: "unsupported", items: [] };
      });
      const store = await openedOnAlpha();

      await waitFor(() => expect(store.current.skillRegistry.status).toBe("unsupported"));
      expect(vi.mocked(api.agentSkills).mock.calls.map((call) => call[2]))
        .toEqual([undefined, undefined]);
      // And exactly once: a guard that kept reading would be its own outage.
      await quiet();
      expect(vi.mocked(api.agentSkills).mock.calls.length).toBe(2);
    });

    it("comes back online without re-reading the skill registry twice", async () => {
      seedTwo();
      vi.mocked(api.agentSkills).mockResolvedValue({ status: "ready", items: [], total: 0 });
      const store = await openedOnAlpha();
      await waitFor(() => expect(store.current.skillRegistry.status).toBe("ready"));
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);
      const skillReads = vi.mocked(api.agentSkills).mock.calls.length;

      act(() => { window.dispatchEvent(new Event("offline")); });
      await waitFor(() => expect(store.current.connection).toBe("offline"));
      const killed = FakeEventSource.latest;
      if (killed !== undefined) killed.readyState = 2;
      act(() => { window.dispatchEvent(new Event("online")); });
      emit("ready", { payload: { version: 1 } });
      await quiet();

      // Exactly one, from the connection transition alone. The explicit bump
      // this handler used to make put a second one on the wire and aborted the
      // first mid-flight.
      expect(vi.mocked(api.agentSkills).mock.calls.length).toBe(skillReads + 1);
      expect(api.bootstrap).toHaveBeenCalledTimes(1);
    });

    it("learns when a turn finished from the delta that finished it", async () => {
      seedTwo([held("m1", "Hel", { status: "running" })]);
      const store = await openedOnAlpha();
      const reads = vi.mocked(api.thread).mock.calls.length;

      emit("message.delta", {
        threadId: alpha.id,
        payload: {
          messageId: "m1",
          baseSeq: 1,
          seq: 2,
          status: "complete",
          updatedAt: "2026-08-14T09:00:00.000Z",
          finishedAt: "2026-08-14T09:00:00.000Z",
          ops: [{ op: "append", index: 0, delta: "lo" }],
        },
      });
      await quiet();

      // The Activity header draws the turn's window from these two stamps, and
      // the second one used to cost a whole-conversation read per turn.
      expect(store.current.detail?.messages[0]).toMatchObject({
        status: "complete",
        finishedAt: "2026-08-14T09:00:00.000Z",
      });
      expect(await screen.findByTestId("message-m1")).toHaveTextContent("Hello");
      expect(vi.mocked(api.thread).mock.calls.length).toBe(reads);
      expect(api.message).not.toHaveBeenCalled();
    });

    it("re-reads every conversation it kept across a gap, conditionally", async () => {
      // The events that would have said what changed are exactly the ones a gap
      // loses, and no listing summary can stand in for them: `writeMessageParts`
      // moves a transcript without touching the conversation row at all -- a
      // Monitor wake, every mid-turn flush -- so a page reporting an unchanged
      // summary is silent about writes this console actually missed. Everything
      // held is suspect, and each conversation pays a CONDITIONAL read when it
      // is opened.
      seedTwo();
      const store = await openedOnAlpha();
      act(() => { store.current.selectThread(beta.id); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(beta.id));
      act(() => { store.current.selectThread(alpha.id); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(alpha.id));
      await quiet();
      const reads = vi.mocked(api.thread).mock.calls.length;
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);

      dropAndReopen();
      emit("ready", { payload: { version: 1 } });
      await quiet();

      // The one on screen is revalidated at once.
      expect(vi.mocked(api.threadIfChanged).mock.calls.map((call) => call[0])).toEqual([alpha.id]);

      // The one in the background pays when it is opened -- and quotes the
      // validator it holds, so nothing that did not move costs a transcript.
      act(() => { store.current.selectThread(beta.id); });
      await waitFor(() => expect(api.threadIfChanged).toHaveBeenCalledTimes(2));
      await quiet();
      expect(vi.mocked(api.threadIfChanged).mock.calls.map((call) => [call[0], call[1]]))
        .toEqual([[alpha.id, 'W/"alpha-1"'], [beta.id, 'W/"beta-1"']]);
      // Not one whole-conversation read between them.
      expect(vi.mocked(api.thread).mock.calls.length).toBe(reads);
      expect(store.current.detail?.thread.id).toBe(beta.id);
    });

    it("re-reads what it kept when the gap was a suspension the socket never reported", async () => {
      // The case this task exists for: the tab was hidden, iOS suspended the
      // socket, `readyState` still reads OPEN and `onerror` never fired. It
      // loses exactly the same events a socket that errored does.
      seedTwo();
      const store = await openedOnAlpha();
      act(() => { store.current.selectThread(beta.id); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(beta.id));
      act(() => { store.current.selectThread(alpha.id); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(alpha.id));
      await quiet();
      const reads = vi.mocked(api.thread).mock.calls.length;
      const pages = vi.mocked(api.threads).mock.calls.length;
      // Conversation beta moved while the tab was away.
      vi.mocked(api.threadIfChanged).mockImplementation(async (threadId) => (threadId === beta.id
        ? {
            thread: { ...beta, revision: beta.revision + 1 },
            messages: [held("b1", "beta moved on", { threadId: beta.id, seq: 2 })],
            etag: 'W/"beta-2"',
          }
        : NOT_MODIFIED));

      const realNow = Date.now.bind(Date);
      let offset = 0;
      const dateNow = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
      let visibility = "hidden";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => visibility,
      });
      try {
        act(() => { document.dispatchEvent(new Event("visibilitychange")); });
        offset = STREAM_SILENCE_LIMIT_MS + 1_000;
        visibility = "visible";
        // Never errored, and still OPEN.
        expect(FakeEventSource.latest?.readyState).toBe(1);
        act(() => { document.dispatchEvent(new Event("visibilitychange")); });
      } finally {
        dateNow.mockRestore();
        Reflect.deleteProperty(document, "visibilityState");
      }
      emit("ready", { payload: { version: 1 } });
      await quiet(THREAD_LIST_REVALIDATE_DEBOUNCE_MS + 400);

      // The sidebar is refreshed too: a silence-detected gap missed the same
      // listing events a proven drop did.
      expect(vi.mocked(api.threads).mock.calls.length).toBe(pages + 1);
      expect(api.bootstrap).toHaveBeenCalledTimes(1);

      act(() => { store.current.selectThread(beta.id); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(beta.id));
      await waitFor(async () =>
        expect(await screen.findByTestId("message-b1")).toHaveTextContent("beta moved on"));
      await quiet();
      expect(vi.mocked(api.threadIfChanged).mock.calls.map((call) => [call[0], call[1]]))
        .toEqual([[alpha.id, 'W/"alpha-1"'], [beta.id, 'W/"beta-1"']]);
      expect(vi.mocked(api.thread).mock.calls.length).toBe(reads);
    }, 15_000);

    it("owes a resume asked for while the tab was in the background", async () => {
      // `online` fires while the app is backgrounded: nothing may be rebuilt
      // there, and the evidence for rebuilding it -- that very event -- is gone
      // by the time the tab comes back. Without recording it, the console sat
      // "offline" behind a banner it could not clear.
      seedTwo();
      const store = await openedOnAlpha();
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);
      const opened = streamCount();
      let visibility = "hidden";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => visibility,
      });
      try {
        act(() => { document.dispatchEvent(new Event("visibilitychange")); });
        act(() => { window.dispatchEvent(new Event("offline")); });
        await waitFor(() => expect(store.current.connection).toBe("offline"));
        // The link is back, but the tab is not.
        act(() => { window.dispatchEvent(new Event("online")); });
        expect(streamCount()).toBe(opened);
        expect(store.current.connection).toBe("offline");

        visibility = "visible";
        act(() => { document.dispatchEvent(new Event("visibilitychange")); });
      } finally {
        Reflect.deleteProperty(document, "visibilityState");
      }

      expect(streamCount()).toBe(opened + 1);
      expect(store.current.connection).toBe("reconnecting");
      emit("ready", { payload: { version: 1 } });
      await quiet();
      expect(vi.mocked(api.threadIfChanged).mock.calls.map((call) => call[0])).toEqual([alpha.id]);
      await waitFor(() => expect(store.current.connection).toBe("live"));
    });

    it("comes back from a suspension that never errored, even after an offline resume", async () => {
      // The worst iOS case: the system suspended the socket, no `onerror` ever
      // fired, and `readyState` still reads OPEN -- so every signal available
      // says "healthy". Declaring the console live on that left the banner
      // hidden and the composer enabled over a dead stream.
      seedTwo();
      const store = await openedOnAlpha();
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);
      const opened = streamCount();

      act(() => { window.dispatchEvent(new Event("offline")); });
      await waitFor(() => expect(store.current.connection).toBe("offline"));
      // A resume while the link is down cannot rebuild anything, and must not
      // spend the evidence the next one is judged on either.
      act(() => { document.dispatchEvent(new Event("visibilitychange")); });
      expect(streamCount()).toBe(opened);
      expect(store.current.connection).toBe("offline");

      act(() => { window.dispatchEvent(new Event("online")); });

      expect(FakeEventSource.instances[opened - 1]?.readyState).toBe(2);
      expect(streamCount()).toBe(opened + 1);
      expect(liveUrl()).toBe(`/api/v1/events?thread=${encodeURIComponent(alpha.id)}`);
      expect(store.current.connection).toBe("reconnecting");
      emit("ready", { payload: { version: 1 } });
      await quiet();
      expect(vi.mocked(api.threadIfChanged).mock.calls.map((call) => call[0])).toEqual([alpha.id]);
    });

    it("does not tear down the socket a resume just built", async () => {
      // `online` can land between the rebuild and the new socket's first byte,
      // when `readyState` and `errored` still describe the socket that was
      // closed. Forcing a second resume there closed the replacement before it
      // had a chance to open.
      seedTwo();
      const store = await openedOnAlpha();
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);
      const opened = streamCount();

      const killed = FakeEventSource.latest;
      if (killed !== undefined) killed.readyState = 2;
      act(() => { document.dispatchEvent(new Event("visibilitychange")); });
      expect(streamCount()).toBe(opened + 1);
      const rebuilt = FakeEventSource.latest;

      // Still CONNECTING: nothing has opened, nothing has failed.
      act(() => { window.dispatchEvent(new Event("online")); });
      expect(streamCount()).toBe(opened + 1);
      expect(rebuilt?.closed).toBe(false);

      // Once it has answered, a later `online` is judged on it rather than on
      // the socket it replaced.
      act(() => { rebuilt?.onopen?.(new Event("open")); });
      await waitFor(() => expect(store.current.connection).toBe("live"));
      act(() => { window.dispatchEvent(new Event("online")); });
      expect(streamCount()).toBe(opened + 1);
    });

    it("never rebuilds the stream while the tab is in the background", async () => {
      seedTwo();
      const store = await openedOnAlpha();
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);
      const opened = streamCount();
      let visibility = "hidden";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => visibility,
      });
      try {
        act(() => { document.dispatchEvent(new Event("visibilitychange")); });
        const killed = FakeEventSource.latest;
        if (killed !== undefined) killed.readyState = 2;

        // A socket rebuilt in the background is one more thing the system is
        // about to suspend again.
        act(() => { window.dispatchEvent(new Event("online")); });
        expect(streamCount()).toBe(opened);

        visibility = "visible";
        act(() => { document.dispatchEvent(new Event("visibilitychange")); });
        expect(streamCount()).toBe(opened + 1);
        expect(store.current.connection).toBe("reconnecting");
      } finally {
        Reflect.deleteProperty(document, "visibilityState");
      }
    });

    it("reads once more when the conditional read that answered 304 was overtaken", async () => {
      // `confirmFresh` deliberately refuses to clear the suspicion when
      // something was observed while the read was on the wire, and NOTHING
      // else answers that: the resync's own `ready` has already been spent.
      // Staged as the sequence that actually produces it -- the app is
      // suspended AGAIN while the resync is in flight, so the second resume
      // marks the open conversation stale before the first one's 304 lands.
      seedTwo();
      const store = await openedOnAlpha();
      let answer304!: () => void;
      vi.mocked(api.threadIfChanged).mockImplementation(async () =>
        new Promise((resolve) => { answer304 = () => resolve(NOT_MODIFIED); }));
      const reads = vi.mocked(api.thread).mock.calls.length;

      dropAndReopen();
      emit("ready", { payload: { version: 1 } });
      await waitFor(() => expect(api.threadIfChanged).toHaveBeenCalledTimes(1));

      // Suspended again. No `ready` follows, so the stream this rebuilds is
      // not what settles the conversation either.
      const killed = FakeEventSource.latest;
      if (killed !== undefined) killed.readyState = 2;
      act(() => { document.dispatchEvent(new Event("visibilitychange")); });
      await act(async () => { answer304(); await Promise.resolve(); });

      // The 304 answered the state at the moment it was ISSUED, so it cannot
      // speak for an observation made after that: one more read settles it --
      // and exactly one, CONDITIONAL like every other conversation read. The
      // follow-up used to go out through the debounced refresh with no
      // validator at all, putting a whole transcript back on the wire for a
      // conversation that had usually not moved.
      await waitFor(
        () => expect(api.threadIfChanged).toHaveBeenCalledTimes(2),
        { timeout: 3_000 },
      );
      await quiet();
      expect(vi.mocked(api.threadIfChanged).mock.calls.map((call) => [call[0], call[1]]))
        .toEqual([[alpha.id, 'W/"alpha-1"'], [alpha.id, 'W/"alpha-1"']]);
      expect(vi.mocked(api.thread).mock.calls.length).toBe(reads);
      expect(store.current.detail?.thread.id).toBe(alpha.id);
    });

    it("keeps an ordinary switch conditional when the re-point overtakes its read", async () => {
      // The overlap a switch produces after a gap: the selection issues a
      // conditional read of the conversation being opened, and ~250 ms later
      // the subscription re-points, whose `ready` stales everything held --
      // including the read still on the wire. That read then lands overtaken
      // and buys another. Every one of them has to quote a validator; the
      // follow-up used to go out through the debounced refresh with none.
      seedTwo();
      const store = await openedOnAlpha();
      // Beta was opened once, so it is held with a validator.
      act(() => { store.current.selectThread(beta.id); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(beta.id));
      act(() => { store.current.selectThread(alpha.id); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(alpha.id));
      await quiet();
      const reads = vi.mocked(api.thread).mock.calls.length;

      // A gap: everything held is suspect.
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);
      dropAndReopen();
      emit("ready", { payload: { version: 1 } });
      await quiet();
      vi.mocked(api.threadIfChanged).mockClear();

      // Open beta and hold its read open, so the re-point's `ready` lands
      // while it is still on the wire.
      const pending: ((answer: typeof NOT_MODIFIED) => void)[] = [];
      vi.mocked(api.threadIfChanged).mockImplementation(async () =>
        new Promise((resolve) => { pending.push(() => resolve(NOT_MODIFIED)); }));
      act(() => { store.current.selectThread(beta.id); });
      await waitFor(() => expect(pending.length).toBe(1));
      await quiet();
      emit("ready", { payload: { version: 1 } });
      await act(async () => { for (const answer of pending) answer(NOT_MODIFIED); await Promise.resolve(); });
      await quiet();

      // Not one unconditional conversation read between them.
      expect(vi.mocked(api.thread).mock.calls.length).toBe(reads);
      expect(vi.mocked(api.threadIfChanged).mock.calls.every((call) => call[1] === 'W/"beta-1"'))
        .toBe(true);
      expect(store.current.detail?.thread.id).toBe(beta.id);
    }, 15_000);

    it("treats a switch to another conversation as the gap it is", async () => {
      // Re-pointing the subscription closes one socket and opens another, and
      // `thread.changed` is broadcast to every connection -- so a write that
      // lands in that round trip reaches neither.
      seedTwo();
      const store = await openedOnAlpha();
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);
      act(() => { store.current.selectThread(beta.id); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(beta.id));
      await quiet();
      expect(liveUrl()).toBe(`/api/v1/events?thread=${encodeURIComponent(beta.id)}`);

      emit("ready", { payload: { version: 1 } });
      await quiet();

      expect(vi.mocked(api.threadIfChanged).mock.calls.map((call) => [call[0], call[1]]))
        .toEqual([[beta.id, 'W/"beta-1"']]);
      expect(api.bootstrap).toHaveBeenCalledTimes(1);
    });

    it("finishes a turn without reading the conversation", async () => {
      // The real finish sequence a subscribed console receives, in order. It
      // used to cost one whole-conversation read every single turn, because
      // `thread.changed` was the only thing that said the transcript had moved.
      seedTwo([held("m1", "Hel", { status: "running" })]);
      const store = await openedOnAlpha();
      const reads = vi.mocked(api.thread).mock.calls.length;

      emit("message.delta", {
        threadId: alpha.id,
        payload: {
          messageId: "m1", baseSeq: 1, seq: 2, status: "complete",
          updatedAt: "2026-08-14T09:00:00.000Z",
          finishedAt: "2026-08-14T09:00:00.000Z",
          ops: [{ op: "append", index: 0, delta: "lo" }],
        },
      });
      emit("turn.changed", { threadId: alpha.id, payload: { turn: { status: "complete" } } });
      emit("thread.changed", {
        threadId: alpha.id,
        payload: { thread: { ...alpha, revision: alpha.revision + 1, messageCount: 2 } },
      });
      emit("threads.changed", {
        threadId: alpha.id,
        payload: { thread: { ...alpha, revision: alpha.revision + 1, messageCount: 2 } },
      });
      await quiet();

      expect(vi.mocked(api.thread).mock.calls.length).toBe(reads);
      expect(api.message).not.toHaveBeenCalled();
      expect(store.current.detail?.messages[0]).toMatchObject({
        status: "complete",
        finishedAt: "2026-08-14T09:00:00.000Z",
      });
      expect(await screen.findByTestId("message-m1")).toHaveTextContent("Hello");
      expect(store.current.selectedThread?.revision).toBe(alpha.revision + 1);
    });

    it("opens a conversation the sidebar does not list with one read", async () => {
      seedTwo();
      vi.mocked(api.thread).mockImplementation(async (threadId) => threadId === gamma.id
        ? { thread: gamma, messages: [held("g1", "gamma", { threadId: gamma.id })], etag: 'W/"gamma-1"' }
        : { thread: alpha, messages: [held("m1", "Hel")], etag: 'W/"alpha-1"' });
      const store = await openedOnAlpha();
      const reads = vi.mocked(api.thread).mock.calls.length;

      // A push deep link or a search hit: `selectThread` reads it itself, and
      // the selection effect used to read the very same conversation again.
      act(() => { store.current.selectThread(gamma.id); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(gamma.id));
      await quiet();

      expect(vi.mocked(api.thread).mock.calls.slice(reads).map((call) => call[0]))
        .toEqual([gamma.id]);
      expect(store.current.detailLoading).toBe(false);
    });
  });

  describe("a console that opens on what this browser kept", () => {
    const alpha = thread("alpha-thread", "alpha");
    const beta = thread("beta-thread", "alpha", { updatedAt: "2026-07-17T09:00:00.000Z" });
    const agents = [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })];
    let eventSequence = 0;

    const kept = (id: string, text: string, threadId = alpha.id): WebMessage => ({
      id,
      threadId,
      role: "assistant",
      parts: [{ type: "text", text }],
      attachments: [],
      createdAt: "2026-08-14T08:00:00.000Z",
      updatedAt: "2026-08-14T08:00:00.000Z",
      status: "complete",
      seq: 1,
    });

    const entry = (
      summary: ThreadSummary,
      messages: readonly WebMessage[],
      etag?: string,
    ): ThreadCacheEntry => ({
      thread: summary,
      messages,
      stale: false,
      syncedAt: 0,
      repairedToolCallIds: new Set<string>(),
      pagedInIds: new Set<string>(),
      ...(etag === undefined ? {} : { etag }),
    });

    /** A previous visit: what that visit left on this device, and where it was. */
    const previousVisit = async (options: {
      readonly entries: readonly ThreadCacheEntry[];
      readonly listing: readonly ThreadSummary[];
      readonly openedOn?: string;
      readonly hostName?: string;
    }) => {
      localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, "alpha");
      if (options.openedOn !== undefined) {
        localStorage.setItem(
          SELECTED_THREADS_STORAGE_KEY,
          JSON.stringify({ alpha: options.openedOn }),
        );
      }
      await deviceStore.save({
        entries: options.entries,
        snapshot: {
          agents,
          console: { hostName: options.hostName ?? "test-host", theme: "evergreen" },
          limits: uploadLimits,
          push: {
            applicationServerKey: "B".repeat(87),
            keyFingerprint: "test-fingerprint",
            serviceWorkerVersion: 2,
          },
        },
        bucket: {
          key: threadBucketKey("alpha", false),
          threads: options.listing,
          nextCursor: null,
        },
      });
    };

    const emit = (
      type: WebEvent["type"],
      extra: { readonly threadId?: string; readonly payload?: unknown } = {},
    ) => {
      eventSequence += 1;
      act(() => FakeEventSource.latest?.emit(type, {
        id: `device-event-${String(eventSequence)}`,
        version: 1,
        type,
        at: "2026-08-14T09:00:00.000Z",
        ...extra,
      }));
    };

    const quiet = async (ms = 400) => {
      await act(async () => { await new Promise((resolve) => { setTimeout(resolve, ms); }); });
    };

    /** Long enough for one debounced write-through to have landed. */
    const written = async () => { await quiet(PERSIST_DEBOUNCE_MS + 400); };

    function Transcript() {
      const store = useConsoleStore();
      return (
        <ol>
          {(store.detail?.messages ?? []).map((message) => (
            <li key={message.id} data-testid={`kept-${message.id}`}>
              {message.parts.map((part) => (part.type === "text" ? part.text : "")).join("")}
            </li>
          ))}
        </ol>
      );
    }

    /** Rendered WITHOUT waiting for a snapshot: what the cold start draws is the point. */
    const openConsole = () => {
      let current: Store | undefined;
      const onChange = (store: Store) => { current = store; };
      render(
        <ConsoleStoreProvider>
          <StoreProbe onChange={onChange} />
          <Transcript />
        </ConsoleStoreProvider>,
      );
      return {
        get current() {
          if (!current) throw new Error("Store did not initialize.");
          return current;
        },
      };
    };

    it("takes the listing as the server speaking for every conversation it holds", async () => {
      // A conversation this tab is NOT subscribed to gets no `message.delta`,
      // and `turn.changed` fires only at the start and the finish of a turn --
      // so a background conversation restored from the device stayed
      // unconfirmed for the whole of a turn that had started before the reopen.
      // The flag read false while the sidebar drew the row as running, and a
      // staged build could reload over exactly what the guard exists to
      // protect. The listing is a server summary for every row in it.
      const runningBeta = { ...beta, runState: { status: "running" as const, id: "turn-b" } };
      await previousVisit({
        entries: [
          entry(alpha, [kept("m1", "kept transcript")], 'W/"alpha-1"'),
          entry(runningBeta, [kept("b1", "beta", beta.id)], 'W/"beta-1"'),
        ],
        listing: [alpha, runningBeta],
        openedOn: alpha.id,
      });
      vi.mocked(api.bootstrap).mockResolvedValue(
        bootstrap(agents, [alpha, runningBeta], undefined, { threadsSourceId: "alpha" }),
      );
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);

      const store = openConsole();
      await waitFor(() => expect(store.current.hasServerSnapshot).toBe(true));

      // Beta is not the conversation on screen, nothing read it, and no
      // `turn.changed` was emitted -- the listing alone is what says so.
      await waitFor(() => expect(store.current.hasRunningThread).toBe(true));
      expect(store.current.selectedThreadId).toBe(alpha.id);
      expect(vi.mocked(api.thread).mock.calls.map((call) => call[0])).not.toContain(beta.id);
    });

    it("takes the listing's word for a turn that finished while the tab was shut", async () => {
      // Confirmed as running FIRST, by a listing that says so -- otherwise
      // "false" is what an unconfirmed restore reads as anyway and the listing
      // has proved nothing. Then a listing at a NEWER revision says the turn
      // is over, and is adopted: the one way a listing may replace what is
      // held.
      const runningBeta = { ...beta, runState: { status: "running" as const, id: "turn-b" } };
      const finishedBeta = {
        ...beta,
        revision: beta.revision + 1,
        runState: { status: "complete" as const, id: "turn-b" },
      };
      await previousVisit({
        entries: [
          entry(alpha, [kept("m1", "kept transcript")], 'W/"alpha-1"'),
          entry(runningBeta, [kept("b1", "beta", beta.id)], 'W/"beta-1"'),
        ],
        listing: [alpha, runningBeta],
        openedOn: alpha.id,
      });
      let listing: readonly ThreadSummary[] = [alpha, runningBeta];
      vi.mocked(api.bootstrap).mockImplementation(async () =>
        bootstrap(agents, listing, undefined, { threadsSourceId: "alpha" }));
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);

      const store = openConsole();
      await waitFor(() => expect(store.current.hasServerSnapshot).toBe(true));
      await waitFor(() => expect(store.current.hasRunningThread).toBe(true));

      listing = [alpha, finishedBeta];
      emit("agents.changed");
      await waitFor(() => expect(api.bootstrap).toHaveBeenCalledTimes(2));

      await waitFor(() => expect(store.current.hasRunningThread).toBe(false));
    });

    it("never lets the listing roll a cached summary backwards", async () => {
      // The listing reaches the cache through `confirmListed`, which takes a
      // row only when it is STRICTLY newer than what is held: a bootstrap that
      // lost its race with an event must not undo the event, at an older
      // revision or an equal one.
      const heldBeta = {
        ...beta,
        revision: beta.revision + 5,
        runState: { status: "running" as const, id: "turn-b" },
      };
      await previousVisit({
        entries: [
          entry(alpha, [kept("m1", "kept transcript")], 'W/"alpha-1"'),
          entry(heldBeta, [kept("b1", "beta", beta.id)], 'W/"beta-1"'),
        ],
        listing: [alpha, heldBeta],
        openedOn: alpha.id,
      });
      // An OLDER revision of the same row, saying the turn is over.
      vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
        agents,
        [alpha, { ...beta, revision: beta.revision + 4, runState: { status: "complete" as const } }],
        undefined,
        { threadsSourceId: "alpha" },
      ));
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);

      const store = openConsole();
      await waitFor(() => expect(store.current.hasServerSnapshot).toBe(true));
      await quiet();

      // Confirmed by the listing, but with the summary it already had.
      expect(store.current.hasRunningThread).toBe(true);
    });

    it("writes nothing to the device for a listing that says what the device already holds", async () => {
      // A listing row is a fresh object per response. Adopting one at an EQUAL
      // revision replaced the held summary's identity with a copy of itself,
      // which the device store reads as "this transcript moved" -- so every
      // bootstrap (the mount, a payload-less `agents.changed`, a reconnect)
      // rewrote every held, listed transcript, up to eight of them, to say
      // what was already there.
      await previousVisit({
        entries: [
          entry(alpha, [kept("m1", "kept transcript")], 'W/"alpha-1"'),
          entry(beta, [kept("b1", "beta", beta.id)], 'W/"beta-1"'),
        ],
        listing: [alpha, beta],
        openedOn: alpha.id,
      });
      const savedAtOf = async () => Object.fromEntries(
        ((await deviceStore.hydrate())?.threads ?? []).map((row) => [row.id, row.savedAt]),
      );
      const seeded = await savedAtOf();
      expect(Object.keys(seeded).sort()).toEqual([alpha.id, beta.id]);
      // Identical rows, exactly as the wire delivers them: parsed afresh, so
      // nothing about their identity says "the same row as last time".
      vi.mocked(api.bootstrap).mockImplementation(async () =>
        structuredClone(bootstrap(agents, [alpha, beta], undefined, { threadsSourceId: "alpha" })));
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);

      const store = openConsole();
      await waitFor(() => expect(store.current.hasServerSnapshot).toBe(true));
      await written();
      expect(await savedAtOf()).toEqual(seeded);

      emit("agents.changed");
      await waitFor(() => expect(api.bootstrap).toHaveBeenCalledTimes(2));
      await written();

      expect(await savedAtOf()).toEqual(seeded);
    });

    it("keeps a turn that began while the snapshot was on the wire, whatever the snapshot's row says", async () => {
      // `patchRunState` moves `runState` without moving `revision`, so the
      // cached summary is NEWER than a listing row at the same revision that
      // the server made before the turn began. Replayed as a patch, that row
      // won: `hasRunningThread` went true, then false, for a turn still
      // running.
      await previousVisit({
        entries: [entry(alpha, [kept("m1", "kept transcript")], 'W/"alpha-1"')],
        listing: [alpha],
        openedOn: alpha.id,
      });
      let release: () => void = () => undefined;
      vi.mocked(api.bootstrap).mockReturnValue(new Promise((resolve) => {
        release = () => resolve(bootstrap(agents, [alpha], undefined, { threadsSourceId: "alpha" }));
      }));
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);

      const store = openConsole();
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(alpha.id));
      await waitFor(() => expect(FakeEventSource.latest).toBeDefined());

      // The turn starts while the snapshot is still out.
      emit("turn.changed", {
        threadId: alpha.id,
        payload: { turn: { id: "turn-1", status: "running", startedAt: "2026-08-14T09:00:00.000Z" } },
      });
      await waitFor(() => expect(store.current.hasRunningThread).toBe(true));

      // The snapshot lands carrying the row the server made BEFORE the turn:
      // the same revision, idle.
      act(() => { release(); });
      await waitFor(() => expect(store.current.hasServerSnapshot).toBe(true));
      await quiet();

      expect(store.current.hasRunningThread).toBe(true);
      expect(store.current.detail?.thread.runState).toMatchObject({ id: "turn-1", status: "running" });
    });

    it("does not re-latch a turn that finished while the snapshot was on the wire", async () => {
      // The mirror. The device says running, the finish lands during the
      // round trip, and the snapshot's row -- same revision, still running --
      // must not put the turn back.
      const runningAlpha = { ...alpha, runState: { status: "running" as const, id: "turn-1" } };
      await previousVisit({
        entries: [entry(runningAlpha, [kept("m1", "kept transcript")], 'W/"alpha-1"')],
        listing: [runningAlpha],
        openedOn: alpha.id,
      });
      let release: () => void = () => undefined;
      vi.mocked(api.bootstrap).mockReturnValue(new Promise((resolve) => {
        release = () => resolve(bootstrap(agents, [runningAlpha], undefined, { threadsSourceId: "alpha" }));
      }));
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);

      const store = openConsole();
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(alpha.id));
      await waitFor(() => expect(FakeEventSource.latest).toBeDefined());

      emit("turn.changed", {
        threadId: alpha.id,
        payload: { turn: { id: "turn-1", status: "complete", finishedAt: "2026-08-14T09:00:00.000Z" } },
      });
      await quiet();
      expect(store.current.hasRunningThread).toBe(false);

      act(() => { release(); });
      await waitFor(() => expect(store.current.hasServerSnapshot).toBe(true));
      await quiet();

      expect(store.current.hasRunningThread).toBe(false);
    });

    it("confirms a held conversation of another agent from that agent's page", async () => {
      // A bootstrap carries ONE bucket. A conversation this device holds for
      // an agent the operator is not looking at is in no listing the bootstrap
      // confirms, and the page that fills that agent's bucket used to write
      // only the projection -- so a running turn there was confirmed by
      // nothing until it finished, and switching to the agent did not fix it.
      const runningGamma = thread("gamma-thread", "beta", {
        runState: { status: "running" as const, id: "turn-g" },
      });
      const betaThread = thread("beta-thread", "beta", { updatedAt: "2026-07-17T11:00:00.000Z" });
      await previousVisit({
        entries: [
          entry(alpha, [kept("m1", "kept transcript")], 'W/"alpha-1"'),
          entry(runningGamma, [kept("g1", "gamma", runningGamma.id)], 'W/"gamma-1"'),
        ],
        listing: [alpha],
        openedOn: alpha.id,
      });
      // The operator's last conversation with beta is NOT the running one, so
      // opening beta reads nothing about gamma: only the page speaks for it.
      localStorage.setItem(
        SELECTED_THREADS_STORAGE_KEY,
        JSON.stringify({ alpha: alpha.id, beta: betaThread.id }),
      );
      vi.mocked(api.bootstrap).mockResolvedValue(
        bootstrap(agents, [alpha], undefined, { threadsSourceId: "alpha" }),
      );
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);
      vi.mocked(api.threads).mockResolvedValue({ threads: [betaThread, runningGamma] });
      vi.mocked(api.thread).mockResolvedValue({ thread: betaThread, messages: [] });

      const store = openConsole();
      await waitFor(() => expect(store.current.hasServerSnapshot).toBe(true));
      await quiet();
      // Held, running, and confirmed by nothing: the snapshot's bucket is alpha's.
      expect(store.current.hasRunningThread).toBe(false);

      act(() => { store.current.selectAgent("beta"); });
      await waitFor(() => expect(store.current.selectedThreadId).toBe(betaThread.id));
      await waitFor(() => expect(store.current.hasRunningThread).toBe(true));

      // No `turn.changed`, and nothing read gamma: the page alone said so.
      expect(vi.mocked(api.thread).mock.calls.map((call) => call[0])).not.toContain(runningGamma.id);
      expect(vi.mocked(api.threadIfChanged).mock.calls.map((call) => call[0]))
        .not.toContain(runningGamma.id);
    });

    it("does not believe a turn is running because the device kept one that was", async () => {
      // `runState` is stored verbatim. A tab killed mid-turn restores `running`
      // for a turn that finished while the browser was shut, and nothing on the
      // device can say otherwise -- so the flag latched true for the whole
      // session and the staged service-worker build was never applied.
      const runningAlpha = { ...alpha, runState: { status: "running" as const, id: "turn-1" } };
      await previousVisit({
        entries: [entry(runningAlpha, [kept("m1", "kept transcript")], 'W/"alpha-1"')],
        listing: [runningAlpha],
        openedOn: alpha.id,
      });
      // Held open, so the console is observed in the state that used to latch:
      // the transcript is on screen and nothing has confirmed a word of it.
      let release: () => void = () => undefined;
      vi.mocked(api.bootstrap).mockReturnValue(new Promise((resolve) => {
        release = () => resolve(bootstrap(agents, [runningAlpha], undefined, { threadsSourceId: "alpha" }));
      }));
      vi.mocked(api.threadIfChanged).mockImplementation(async () => new Promise(() => undefined));

      const store = openConsole();
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(alpha.id));
      await waitFor(() => expect(api.threadIfChanged).toHaveBeenCalled());
      // Drawn from the device, and NOT counted: nothing has confirmed it.
      expect(store.current.hasRunningThread).toBe(false);

      // The listing says the same thing the device did -- but the server is
      // saying it, which is the whole difference.
      act(() => { release(); });
      await waitFor(() => expect(store.current.hasRunningThread).toBe(true));
      expect(store.current.detail?.thread.id).toBe(alpha.id);
    });

    it("draws what it kept before anything answers, and confirms it with one conditional read", async () => {
      await previousVisit({
        entries: [entry(alpha, [kept("m1", "kept transcript")], 'W/"alpha-1"')],
        listing: [alpha],
        openedOn: alpha.id,
      });
      let release: () => void = () => undefined;
      vi.mocked(api.bootstrap).mockReturnValue(new Promise((resolve) => {
        release = () => resolve(bootstrap(agents, [alpha], undefined, { threadsSourceId: "alpha" }));
      }));
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);

      const store = openConsole();

      // The whole point: the transcript, the rail and the sidebar are on screen
      // while the snapshot is still on the wire.
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(alpha.id));
      expect(store.current.loading).toBe(true);
      expect(vi.mocked(api.bootstrap)).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("kept-m1")).toHaveTextContent("kept transcript");
      expect(store.current.agents.map((item) => item.sourceId)).toEqual(["alpha", "beta"]);
      expect(store.current.visibleThreads.map((item) => item.id)).toEqual([alpha.id]);
      // Nothing live stands behind any of it yet, and the console says so.
      expect(store.current.connection).toBe("reconnecting");
      expect(store.current.detailLoading).toBe(false);

      // ONE read, and it quotes what the transcript was served with.
      await waitFor(() => expect(vi.mocked(api.threadIfChanged)).toHaveBeenCalledTimes(1));
      expect(vi.mocked(api.threadIfChanged).mock.calls.map((call) => [call[0], call[1]]))
        .toEqual([[alpha.id, 'W/"alpha-1"']]);
      expect(vi.mocked(api.thread)).not.toHaveBeenCalled();
      const held = store.current.detail?.messages;

      act(() => { release(); });
      await waitFor(() => expect(store.current.loading).toBe(false));
      await quiet();

      // A 304 replaced nothing, and the snapshot bought no second read.
      expect(vi.mocked(api.threadIfChanged)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(api.thread)).not.toHaveBeenCalled();
      expect(store.current.detail?.messages).toBe(held);
      expect(store.current.selectedThreadId).toBe(alpha.id);
    });

    it("keeps the transcript a turn streamed, with the validator it was served with", async () => {
      vi.mocked(api.bootstrap).mockResolvedValue(
        bootstrap(agents, [alpha], undefined, { threadsSourceId: "alpha" }),
      );
      vi.mocked(api.thread).mockResolvedValue({
        thread: alpha,
        messages: [{ ...kept("m1", "Hel"), status: "running" }],
        etag: 'W/"alpha-1"',
      });
      localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, "alpha");
      const store = openConsole();
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(alpha.id));

      emit("message.delta", {
        threadId: alpha.id,
        payload: {
          messageId: "m1",
          baseSeq: 1,
          seq: 2,
          status: "running",
          updatedAt: "2026-08-14T09:00:01.000Z",
          ops: [{ op: "append", index: 0, delta: "lo" }],
        },
      });
      await waitFor(() => expect(screen.getByTestId("kept-m1")).toHaveTextContent("Hello"));
      await written();

      const stored = await deviceStore.hydrate();
      const alphaRow = stored?.threads.find((item) => item.id === alpha.id);
      expect(alphaRow?.messages[0]?.parts).toEqual([{ type: "text", text: "Hello" }]);
      // The validator the entry was served with, carried with that entry and no
      // other. It describes an older version than the delta produced, which is
      // exactly why the read that quotes it is answered with a transcript.
      expect(alphaRow?.etag).toBe('W/"alpha-1"');
      expect(stored?.host).toBe("test-host");
      expect(stored?.buckets.map((item) => item.key)).toEqual([threadBucketKey("alpha", false)]);
    });

    it("forgets a kept conversation the server no longer has, on the device too", async () => {
      await previousVisit({
        entries: [entry(alpha, [kept("m1", "kept transcript")], 'W/"alpha-1"')],
        listing: [alpha],
        openedOn: alpha.id,
      });
      vi.mocked(api.bootstrap).mockResolvedValue(
        bootstrap(agents, [beta], undefined, { threadsSourceId: "alpha" }),
      );
      vi.mocked(api.threadIfChanged).mockRejectedValue(
        new ApiError("Conversation not found.", 404, "thread_not_found"),
      );
      vi.mocked(api.thread).mockResolvedValue({
        thread: beta,
        messages: [kept("b1", "beta", beta.id)],
        etag: 'W/"beta-1"',
      });

      const store = openConsole();
      await waitFor(() => expect(store.current.actionError).toBe("This conversation was deleted."));
      await written();

      expect(store.current.selectedThreadId).not.toBe(alpha.id);
      const stored = await deviceStore.hydrate();
      expect(stored?.threads.map((item) => item.id)).not.toContain(alpha.id);
      expect(JSON.parse(localStorage.getItem(SELECTED_THREADS_STORAGE_KEY) ?? "{}").alpha)
        .not.toBe(alpha.id);
    });

    it("empties the device when the operator asks, and keeps what is on screen", async () => {
      await previousVisit({
        entries: [
          entry(alpha, [kept("m1", "kept transcript")], 'W/"alpha-1"'),
          entry(beta, [kept("b1", "beta transcript", beta.id)], 'W/"beta-1"'),
        ],
        listing: [alpha, beta],
        openedOn: alpha.id,
      });
      vi.mocked(api.bootstrap).mockResolvedValue(
        bootstrap(agents, [alpha, beta], undefined, { threadsSourceId: "alpha" }),
      );
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);
      vi.mocked(api.thread).mockResolvedValue({
        thread: beta,
        messages: [kept("b1", "beta transcript", beta.id)],
        etag: 'W/"beta-2"',
      });
      const store = openConsole();
      await waitFor(() => expect(store.current.loading).toBe(false));
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(alpha.id));
      const held = store.current.detail?.messages;

      await act(async () => { await store.current.clearCachedData(); });

      expect(await deviceStore.hydrate())
        .toEqual({ host: null, snapshot: null, buckets: [], threads: [] });
      // The conversation in front of the operator is not what they asked to
      // lose: it is still on screen, as the very transcript it was.
      expect(store.current.detail?.messages).toBe(held);
      expect(screen.getByTestId("kept-m1")).toHaveTextContent("kept transcript");

      // Everything else is gone from memory as well, so opening one costs a read.
      const reads = vi.mocked(api.thread).mock.calls.length;
      act(() => { store.current.selectThread(beta.id); });
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(beta.id));
      expect(vi.mocked(api.thread).mock.calls.slice(reads).map((call) => call[0]))
        .toEqual([beta.id]);
    });


    it("gives back the pictures it is keeping for nobody, and none of the one on screen", async () => {
      const revokeObjectURL = vi.fn();
      const originalCreate = URL.createObjectURL;
      const originalRevoke = URL.revokeObjectURL;
      let issued = 0;
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: () => `blob:cleared-${String(++issued)}`,
      });
      Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
      try {
        const store = openConsole();
        await waitFor(() => expect(store.current.loading).toBe(false));

        const onScreen = replyImageKey("sha256:on-screen", 4);
        const kept = replyImageKey("sha256:kept", 4);
        const shown = publishReplyImageBlob(onScreen, new Blob(["abcd"]));
        publishReplyImageBlob(kept, new Blob(["abcd"]));
        releaseReplyImageBlob(kept);

        await act(async () => { await store.current.clearCachedData(); });

        // Pictures the retention window is holding for nobody are cached data
        // like any other, and were the one thing this action did not take off
        // the device. The picture still on screen is not: revoking the URL an
        // <img> is pointing at would blank it in front of the operator.
        expect(revokeObjectURL).toHaveBeenCalledTimes(1);
        expect(retainedReplyImageBytes()).toBe(0);
        expect(acquireReplyImageBlob(onScreen)).toBe(shown);
      } finally {
        clearReplyImageBlobs();
        Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreate });
        Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevoke });
      }
    });

    it("asks the server anyway when the device never answers", async () => {
      // An `indexedDB.open` that fires nothing at all -- no success, no error,
      // no blocked. Awaiting that unbounded is a console stuck on its spinner
      // with a "Try again" that awaits the same dead promise.
      vi.stubGlobal("indexedDB", deafIndexedDb());
      localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, "alpha");
      vi.mocked(api.bootstrap).mockResolvedValue(
        bootstrap(agents, [alpha], undefined, { threadsSourceId: "alpha" }),
      );
      vi.mocked(api.thread).mockResolvedValue({
        thread: alpha,
        messages: [kept("m1", "from the server")],
        etag: 'W/"alpha-1"',
      });

      const store = openConsole();

      await waitFor(
        () => expect(store.current.loading).toBe(false),
        { timeout: HYDRATION_DEADLINE_MS + 3_000 },
      );
      expect(vi.mocked(api.bootstrap)).toHaveBeenCalledTimes(1);
      expect(store.current.agents.map((item) => item.sourceId)).toEqual(["alpha", "beta"]);
    });

    it("gives the device its one wait, and does not pay it again on retry", async () => {
      vi.stubGlobal("indexedDB", deafIndexedDb());
      localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, "alpha");
      vi.mocked(api.bootstrap).mockRejectedValue(new Error("The web console request failed."));

      const store = openConsole();
      await waitFor(
        () => expect(vi.mocked(api.bootstrap)).toHaveBeenCalledTimes(1),
        { timeout: HYDRATION_DEADLINE_MS + 3_000 },
      );

      // The device has already failed to answer once. Charging the operator
      // another {@link HYDRATION_DEADLINE_MS} for every "Try again" would make
      // the retry feel like the outage.
      const askedAt = Date.now();
      act(() => { store.current.retry(); });
      await waitFor(() => expect(vi.mocked(api.bootstrap)).toHaveBeenCalledTimes(2));
      expect(Date.now() - askedAt).toBeLessThan(HYDRATION_DEADLINE_MS);
    });

    it("ignores what the device says once the server has answered", async () => {
      // The device's listing carries a conversation the server's does not, so
      // the two are told apart by what is on screen and not only by the
      // transcript.
      const ghost = thread("ghost-thread", "alpha", { updatedAt: "2026-07-17T08:00:00.000Z" });
      await previousVisit({
        entries: [entry(alpha, [kept("m1", "last visit")], 'W/"alpha-1"')],
        listing: [alpha, ghost],
        openedOn: alpha.id,
      });
      // Late, but not never: the boot goes without it and this lands afterwards.
      vi.stubGlobal("indexedDB", slowIndexedDb(HYDRATION_DEADLINE_MS + 700));
      vi.mocked(api.bootstrap).mockResolvedValue(
        bootstrap(agents, [alpha], undefined, { threadsSourceId: "alpha" }),
      );
      vi.mocked(api.thread).mockResolvedValue({
        thread: alpha,
        messages: [kept("m2", "from the server")],
        etag: 'W/"alpha-2"',
      });

      const store = openConsole();
      await waitFor(
        () => expect(screen.queryByTestId("kept-m2")).not.toBeNull(),
        { timeout: HYDRATION_DEADLINE_MS + 3_000 },
      );
      await quiet(HYDRATION_DEADLINE_MS + 1_200);

      // `restore` replaces the entry it names and always lands stale, so a late
      // hydration would put a last-visit transcript over the one the server
      // just gave. Nothing republishes on its own, so the damage is in the
      // CACHE and in the listing: the next event that draws from either is what
      // shows it.
      emit("turn.changed", {
        threadId: alpha.id,
        payload: { turn: { id: "turn-1", status: "running" } },
      });
      await quiet();

      expect(screen.queryByTestId("kept-m1")).toBeNull();
      expect(store.current.detail?.messages.map((item) => item.id)).toEqual(["m2"]);
      expect(store.current.visibleThreads.map((item) => item.id)).toEqual([alpha.id]);
      expect(vi.mocked(api.threadIfChanged)).not.toHaveBeenCalled();
    });

    it("keeps the device's copy on screen when the snapshot fails and the device is slow", async () => {
      // The case the deadline exists for, with no network behind it: a resumed
      // WebKit page whose `indexedDB.open` is slow AND a server that is not
      // there. The boot goes without the device, the fetch fails at once, and
      // the hydration that lands afterwards is the ONLY thing this operator can
      // be given -- so it must not be thrown away for having arrived late.
      const ghost = thread("ghost-thread", "alpha", { updatedAt: "2026-07-17T08:00:00.000Z" });
      await previousVisit({
        entries: [entry(alpha, [kept("m1", "last visit")], 'W/"alpha-1"')],
        listing: [alpha, ghost],
        openedOn: alpha.id,
      });
      vi.stubGlobal("indexedDB", slowIndexedDb(HYDRATION_DEADLINE_MS + 700));
      vi.mocked(api.bootstrap).mockRejectedValue(new Error("The web console request failed."));
      vi.mocked(api.thread).mockRejectedValue(new Error("The web console request failed."));
      vi.mocked(api.threadIfChanged).mockRejectedValue(new Error("The web console request failed."));

      const store = openConsole();
      // The snapshot is not even requested until the deadline expires.
      await waitFor(
        () => expect(store.current.error).not.toBeNull(),
        { timeout: HYDRATION_DEADLINE_MS + 3_000 },
      );
      await waitFor(
        () => expect(screen.queryByTestId("kept-m1")).not.toBeNull(),
        { timeout: HYDRATION_DEADLINE_MS + 3_000 },
      );

      // `error` with no projection is the fatal screen, which is what this
      // operator would otherwise have been given: a dead end, with everything
      // this browser was holding sitting unread on the device.
      expect(store.current.bootstrap).not.toBeNull();
      expect(store.current.hasServerSnapshot).toBe(false);
      expect(store.current.detail?.thread.id).toBe(alpha.id);
      expect(store.current.visibleThreads.map((item) => item.id))
        .toEqual([alpha.id, ghost.id]);
    });

    it("says so, and stays disconnected, when the snapshot fails behind what it restored", async () => {
      await previousVisit({
        entries: [entry(alpha, [kept("m1", "last visit")], 'W/"alpha-1"')],
        listing: [alpha],
        openedOn: alpha.id,
      });
      vi.mocked(api.bootstrap).mockRejectedValue(new Error("The web console request failed."));
      vi.mocked(api.threadIfChanged).mockRejectedValue(new Error("The web console request failed."));

      const store = openConsole();
      await waitFor(() => expect(store.current.error).not.toBeNull());
      // The stream comes up anyway -- it is a different socket to a different
      // route, and it says nothing whatever about the listing.
      act(() => FakeEventSource.latest?.emit("ready", {
        id: "device-ready", version: 1, type: "ready", at: "2026-08-14T09:00:00.000Z",
      }));
      await quiet();

      expect(store.current.hasServerSnapshot).toBe(false);
      expect(store.current.connection).not.toBe("live");
      // Which is what keeps the composer shut: sending into a listing no server
      // stands behind targets a conversation this tab cannot vouch for.
      expect(canSendInConsole(
        store.current.connection,
        store.current.selectedAgent,
        store.current.selectedThread,
      )).toBe(false);
      // And what it restored is still readable, which is the point of keeping it.
      expect(screen.queryByTestId("kept-m1")).not.toBeNull();
    });

    it("promotes itself the moment a snapshot finally lands", async () => {
      await previousVisit({
        entries: [entry(alpha, [kept("m1", "last visit")], 'W/"alpha-1"')],
        listing: [alpha],
        openedOn: alpha.id,
      });
      vi.mocked(api.bootstrap).mockRejectedValueOnce(new Error("The web console request failed."));
      vi.mocked(api.bootstrap).mockResolvedValue(
        bootstrap(agents, [alpha], undefined, { threadsSourceId: "alpha" }),
      );
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);

      const store = openConsole();
      await waitFor(() => expect(store.current.error).not.toBeNull());
      // The stream reports itself live BEFORE the retry answers, and will not
      // say so again on a quiet fleet.
      act(() => FakeEventSource.latest?.emit("ready", {
        id: "device-ready-2", version: 1, type: "ready", at: "2026-08-14T09:00:00.000Z",
      }));

      await waitFor(() => expect(store.current.hasServerSnapshot).toBe(true));
      await waitFor(() => expect(store.current.connection).toBe("live"));
      expect(store.current.error).toBeNull();
    });

    it("does not write back what the operator just cleared", async () => {
      await previousVisit({
        entries: [entry(alpha, [kept("m1", "kept transcript")], 'W/"alpha-1"')],
        listing: [alpha],
        openedOn: alpha.id,
      });
      vi.mocked(api.bootstrap).mockResolvedValue(
        bootstrap(agents, [alpha], undefined, { threadsSourceId: "alpha" }),
      );
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);
      const store = openConsole();
      await waitFor(() => expect(store.current.loading).toBe(false));

      // A commit half a second before the action, so a flush is armed and
      // carries the snapshot, the listing and the entry on screen.
      emit("turn.changed", {
        threadId: alpha.id,
        payload: { turn: { id: "turn-1", status: "running" } },
      });
      await quiet(PERSIST_DEBOUNCE_MS / 2);

      await act(async () => { await store.current.clearCachedData(); });
      await written();

      expect(await deviceStore.hydrate())
        .toEqual({ host: null, snapshot: null, buckets: [], threads: [] });
    });

    it("keeps the listing it stored while an agent switch is still in flight", async () => {
      await previousVisit({
        entries: [entry(alpha, [kept("m1", "kept transcript")], 'W/"alpha-1"')],
        listing: [alpha],
        openedOn: alpha.id,
      });
      vi.mocked(api.bootstrap).mockResolvedValue(
        bootstrap(agents, [alpha], undefined, { threadsSourceId: "alpha" }),
      );
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);
      const store = openConsole();
      await waitFor(() => expect(store.current.loading).toBe(false));
      await written();
      const before = (await deviceStore.hydrate())?.buckets;
      expect(before?.map((item) => item.key)).toEqual([threadBucketKey("alpha", false)]);

      // Beta's page never answers, so for that whole window the listing on
      // screen is filtered from rows that belong to ANOTHER bucket -- which is
      // to say, from nothing.
      vi.mocked(api.threads).mockReturnValue(new Promise(() => undefined));
      act(() => { store.current.selectAgent("beta"); });
      await written();

      expect((await deviceStore.hydrate())?.buckets).toEqual(before);
    });

    it("forgets a running turn it was holding when the operator clears the cache", async () => {
      // "Clear cached data" keeps the conversation on screen and empties the
      // rest, so what the flag says has to be recomputed against what survived
      // -- `clear` announces no commit, because nothing it changes is stored.
      const runningBeta = { ...beta, runState: { status: "running" as const, id: "turn-b" } };
      await previousVisit({
        entries: [
          entry(alpha, [kept("m1", "kept transcript")], 'W/"alpha-1"'),
          entry(runningBeta, [kept("b1", "beta", beta.id)], 'W/"beta-1"'),
        ],
        listing: [alpha, runningBeta],
        openedOn: alpha.id,
      });
      vi.mocked(api.bootstrap).mockResolvedValue(
        bootstrap(agents, [alpha, runningBeta], undefined, { threadsSourceId: "alpha" }),
      );
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);

      const store = openConsole();
      await waitFor(() => expect(store.current.hasRunningThread).toBe(true));
      expect(store.current.selectedThreadId).toBe(alpha.id);

      await act(async () => { await store.current.clearCachedData(); });

      // Only alpha survives, and alpha is not running.
      expect(store.current.hasRunningThread).toBe(false);
      expect(store.current.detail?.thread.id).toBe(alpha.id);
    });

    it("keeps counting the running turn it was asked to keep when the operator clears the cache", async () => {
      // The mirror: "Clear cached data" keeps the conversation on screen, so a
      // running answer it is holding is kept with it, and the recompute must
      // read what survived rather than assume nothing did.
      const runningAlpha = { ...alpha, runState: { status: "running" as const, id: "turn-a" } };
      await previousVisit({
        entries: [
          entry(runningAlpha, [kept("m1", "kept transcript")], 'W/"alpha-1"'),
          entry(beta, [kept("b1", "beta", beta.id)], 'W/"beta-1"'),
        ],
        listing: [runningAlpha, beta],
        openedOn: alpha.id,
      });
      vi.mocked(api.bootstrap).mockResolvedValue(
        bootstrap(agents, [runningAlpha, beta], undefined, { threadsSourceId: "alpha" }),
      );
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);

      const store = openConsole();
      await waitFor(() => expect(store.current.hasRunningThread).toBe(true));
      expect(store.current.selectedThreadId).toBe(alpha.id);

      await act(async () => { await store.current.clearCachedData(); });

      expect(store.current.hasRunningThread).toBe(true);
      expect(store.current.detail?.thread.id).toBe(alpha.id);
    });

    it("forgets a running turn belonging to a console this device is no longer", async () => {
      // A snapshot from a different host empties everything the other console
      // left, and an answer derived from it has to go with it.
      const runningAlpha = { ...alpha, runState: { status: "running" as const, id: "turn-a" } };
      await previousVisit({
        entries: [entry(runningAlpha, [kept("m1", "another console")], 'W/"other-1"')],
        listing: [runningAlpha],
        openedOn: alpha.id,
        hostName: "kitchen",
      });
      let release: () => void = () => undefined;
      vi.mocked(api.bootstrap).mockReturnValue(new Promise((resolve) => {
        release = () => resolve(bootstrap(agents, [alpha], undefined, { threadsSourceId: "alpha" }));
      }));
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);
      vi.mocked(api.thread).mockResolvedValue({
        thread: alpha,
        messages: [kept("m2", "this console")],
        etag: 'W/"alpha-1"',
      });

      const store = openConsole();
      await waitFor(() => expect(store.current.hasRunningThread).toBe(true));

      // A different console wrote what is on this device; all of it goes.
      act(() => { release(); });
      await waitFor(() => expect(store.current.loading).toBe(false));

      expect(store.current.hasRunningThread).toBe(false);
    });

    it("does not carry a running answer across into what the device restores", async () => {
      // Hydration writes the cache through `restore`, which announces no commit
      // either -- so a console that had already answered "a turn is running"
      // for something it has just thrown away would have gone on saying so.
      const runningAlpha = { ...alpha, runState: { status: "running" as const, id: "turn-a" } };
      await previousVisit({
        entries: [entry(runningAlpha, [kept("m1", "kept transcript")], 'W/"alpha-1"')],
        listing: [runningAlpha],
        openedOn: alpha.id,
      });
      // Held open, so hydration lands while nothing has confirmed anything.
      const answers: (() => void)[] = [];
      vi.mocked(api.bootstrap).mockReturnValue(new Promise(() => undefined));
      vi.mocked(api.threadIfChanged).mockImplementation(async () =>
        new Promise((resolve) => { answers.push(() => resolve(NOT_MODIFIED)); }));

      const store = openConsole();
      await waitFor(() => expect(store.current.detail?.thread.id).toBe(alpha.id));
      await waitFor(() => expect(answers.length).toBeGreaterThan(0));

      // The restore put a `running` row in the cache and the flag was
      // recomputed over it: unconfirmed, so it counts for nothing.
      expect(store.current.hasRunningThread).toBe(false);

      // And the read that confirms it is what makes it count.
      await act(async () => { for (const answer of answers) answer(); await Promise.resolve(); });
      await waitFor(() => expect(store.current.hasRunningThread).toBe(true));
    });

    it("throws away what a different console left on this device", async () => {
      await previousVisit({
        entries: [entry(alpha, [kept("m1", "another console")], 'W/"other-1"')],
        listing: [alpha],
        openedOn: alpha.id,
        hostName: "kitchen",
      });
      let release: () => void = () => undefined;
      vi.mocked(api.bootstrap).mockReturnValue(new Promise((resolve) => {
        release = () => resolve(bootstrap(agents, [alpha], undefined, { threadsSourceId: "alpha" }));
      }));
      // The read the restored copy provokes quotes the OTHER console's
      // validator, and it is on the wire before the snapshot that exposes the
      // host. A 304 to it is the pathological answer -- today's validator comes
      // from the body, but one derived from a revision could collide -- and the
      // console still owes the operator THIS console's conversation.
      vi.mocked(api.threadIfChanged).mockResolvedValue(NOT_MODIFIED);
      vi.mocked(api.thread).mockResolvedValue({
        thread: alpha,
        messages: [kept("m2", "this console")],
        etag: 'W/"alpha-1"',
      });

      const store = openConsole();
      await waitFor(() => expect(screen.queryByTestId("kept-m1")).not.toBeNull());
      await waitFor(() => expect(vi.mocked(api.threadIfChanged)).toHaveBeenCalledTimes(1));

      act(() => { release(); });
      await waitFor(() => expect(store.current.loading).toBe(false));
      await waitFor(() => expect(screen.queryByTestId("kept-m2")).not.toBeNull());
      await written();

      // Not one byte of the other console's copy survived, in memory or on the
      // device, and what replaced it was read without a validator.
      expect(screen.queryByTestId("kept-m1")).toBeNull();
      expect(vi.mocked(api.thread).mock.calls.map((call) => call[0])).toEqual([alpha.id]);
      const stored = await deviceStore.hydrate();
      expect(stored?.host).toBe("test-host");
      expect(stored?.threads.flatMap((item) => item.messages.map((message) => message.id)))
        .toEqual(["m2"]);
    });
  });
});
