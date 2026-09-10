import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cronChannelPath,
  SELECTED_AGENT_STORAGE_KEY,
  SELECTED_THREADS_STORAGE_KEY,
  ConsoleStoreProvider,
  threadBucketKey,
} from "./console-store";
import { createThreadPersistence } from "./thread-persistence";
import { WebRuntimeProvider } from "./runtime";
import { agent, bootstrap, thread, uploadLimits } from "./test/fixtures";
import type { CronOverview, ThreadDetail, ThreadSummary, WebMessage } from "./types";
import "./styles.css";

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
    threadJob: vi.fn(),
  },
}));

vi.mock("./notifications", () => ({ NotificationBell: () => null }));

import { api } from "./api";
import { AgentRail, MobileAgentPicker } from "./components/AgentRail";
import { Chat } from "./components/Chat";
import { ThreadSidebar } from "./components/ThreadSidebar";

class SyntheticEventSource {
  readonly url: string;
  readyState = 1;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void { this.readyState = 2; }
}

const alphaThread = thread("alpha-thread", "alpha", {
  title: "Alpha thread",
  messageCount: 1,
});
const betaThread = thread("beta-thread", "beta", {
  title: "Beta thread",
  messageCount: 1,
});
const olderAlphaThread = thread("older-alpha-thread", "alpha", {
  title: "Older Alpha thread",
  messageCount: 1,
  updatedAt: "2026-09-07T08:00:00.000Z",
});
const cronThread = thread("cron-thread", "alpha", {
  title: "Cron daily report",
  trigger: { kind: "cron", jobId: "daily:report", configured: true },
  canSend: false,
  canUpload: false,
});

const detail = (summary: ThreadSummary, text: string): ThreadDetail => {
  const message: WebMessage = {
    id: `${summary.id}-message`,
    threadId: summary.id,
    role: "assistant",
    parts: [{ type: "text", text }],
    attachments: [],
    createdAt: "2026-09-08T08:00:00.000Z",
    updatedAt: "2026-09-08T08:00:00.000Z",
    status: "complete",
  };
  return { thread: summary, messages: [message] };
};

const persistence = createThreadPersistence();

const saveHydratedShell = async (
  listing: readonly ThreadSummary[],
  agents = [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })],
) => {
  await persistence.save({
    entries: [],
    snapshot: {
      agents,
      console: { hostName: "test-host", displayName: "test-host", theme: "evergreen" },
      limits: uploadLimits,
      push: {
        applicationServerKey: "B".repeat(87),
        keyFingerprint: "test-fingerprint",
        serviceWorkerVersion: 2,
      },
    },
    bucket: {
      key: threadBucketKey("alpha", false),
      threads: listing,
      nextCursor: null,
    },
  });
};

const closeInitialMobileDrawer = async (mobile: boolean) => {
  if (!mobile) return;
  screen.getByRole("button", { name: "Close navigation" }).click();
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose agent" })).toBeNull());
};

const waitForLiveConsole = async () => {
  expect(await screen.findByLabelText("Console connection: live")).toBeInTheDocument();
};

function ConversationSwitchFixture({
  width,
  height,
  mobile,
}: {
  readonly width: number;
  readonly height: number;
  readonly mobile: boolean;
}) {
  const [agentDrawer, setAgentDrawer] = useState(mobile);
  const [threadDrawer, setThreadDrawer] = useState(false);
  const closeDrawers = () => {
    setAgentDrawer(false);
    setThreadDrawer(false);
  };

  return (
    <div className="app-shell" style={{ width, height }}>
      <div className="desktop-agent-rail"><AgentRail expanded /></div>
      <div className="desktop-thread-sidebar"><ThreadSidebar /></div>
      <Chat
        onOpenAgents={() => setAgentDrawer(true)}
        onOpenThreads={() => setThreadDrawer(true)}
      />
      {(agentDrawer || threadDrawer) && (
        <button
          className="drawer-scrim"
          type="button"
          onClick={closeDrawers}
          aria-label="Close navigation"
        />
      )}
      <div
        className={`mobile-agent-drawer${agentDrawer ? " is-open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Choose agent"
        aria-hidden={!agentDrawer}
        inert={!agentDrawer}
      >
        <MobileAgentPicker onSelect={closeDrawers} />
      </div>
      <div
        className={`mobile-thread-drawer${threadDrawer ? " is-open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Conversations"
        aria-hidden={!threadDrawer}
        inert={!threadDrawer}
      >
        <ThreadSidebar onSelect={closeDrawers} />
      </div>
    </div>
  );
}

const chooseAgent = async (label: string, mobile: boolean) => {
  if (mobile) {
    if (screen.queryByRole("dialog", { name: "Choose agent" }) === null) {
      await userEvent.click(screen.getByRole("button", { name: "Choose agent" }));
    }
    const drawer = await screen.findByRole("dialog", { name: "Choose agent" });
    await userEvent.click(within(drawer).getByRole("button", { name: `${label}, online` }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose agent" })).toBeNull());
    return;
  }
  await userEvent.click(screen.getByRole("button", { name: `${label}, online` }));
};

const expectNewConversationDisabled = async (mobile: boolean) => {
  if (!mobile) {
    expect(screen.getByRole("button", { name: "New conversation" })).toBeDisabled();
    return;
  }
  let drawer = screen.queryByRole("dialog", { name: "Conversations" });
  if (drawer === null) {
    await userEvent.click(screen.getByRole("button", { name: "Open conversations" }));
    drawer = await screen.findByRole("dialog", { name: "Conversations" });
  }
  expect(within(drawer).getByRole("button", { name: "New conversation" })).toBeDisabled();
  screen.getByRole("button", { name: "Close navigation" }).click();
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Conversations" })).toBeNull());
};

beforeEach(async () => {
  await persistence.clearAll();
  vi.clearAllMocks();
  vi.mocked(api.bootstrap).mockReset();
  vi.mocked(api.thread).mockReset();
  vi.mocked(api.threads).mockReset();
  vi.mocked(api.createThread).mockReset();
  vi.mocked(api.cronOverview).mockReset();
  window.history.replaceState(null, "", "/");
  localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, "alpha");
  localStorage.setItem(SELECTED_THREADS_STORAGE_KEY, JSON.stringify({ alpha: alphaThread.id }));
  vi.stubGlobal("EventSource", SyntheticEventSource);
  vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
    [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })],
    [alphaThread],
    alphaThread.id,
    { threadsSourceId: "alpha" },
  ));
  vi.mocked(api.thread).mockImplementation(async (threadId) => threadId === betaThread.id
    ? detail(betaThread, "Beta transcript")
    : detail(alphaThread, "Alpha transcript"));
  vi.mocked(api.agentSkills).mockResolvedValue({ status: "unsupported", items: [] });
  vi.mocked(api.messages).mockResolvedValue({ messages: [] });
  vi.mocked(api.cronRuns).mockResolvedValue({ runs: [] });
});

afterEach(async () => {
  cleanup();
  await persistence.clearAll();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("conversation switching through the real Chromium store and runtime", () => {
  it.each([
    { width: 1_280, height: 800, label: "desktop" },
    { width: 390, height: 844, label: "mobile" },
  ])("shows pending creation before the create response at $label size", async ({ width, height, label }) => {
    await page.viewport(width, height);
    const mobile = label === "mobile";
    let resolveCreate!: (value: ThreadSummary) => void;
    vi.mocked(api.createThread).mockImplementation(() => new Promise((resolve) => {
      resolveCreate = resolve;
    }));

    render(
      <ConsoleStoreProvider>
        <WebRuntimeProvider>
          <ConversationSwitchFixture width={width} height={height} mobile={mobile} />
        </WebRuntimeProvider>
      </ConsoleStoreProvider>,
    );
    await closeInitialMobileDrawer(mobile);
    expect(await screen.findByText("Alpha transcript")).toBeVisible();
    await waitForLiveConsole();

    if (mobile) {
      await userEvent.click(screen.getByRole("button", { name: "Open conversations" }));
      const drawer = await screen.findByRole("dialog", { name: "Conversations" });
      await userEvent.click(within(drawer).getByRole("button", { name: "New conversation" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Conversations" })).toBeNull());
    } else {
      await userEvent.click(screen.getByRole("button", { name: "New conversation" }));
    }

    expect(await screen.findByRole("button", { name: "Creating conversation…" })).toBeDisabled();
    expect(screen.getByRole("status", { name: "Creating conversation" })).toBeVisible();
    expect(screen.queryByText("Start a new conversation")).toBeNull();
    expect(api.createThread).toHaveBeenCalledTimes(1);

    await act(async () => resolveCreate(thread("created-thread", "alpha")));
    expect(await screen.findByRole("heading", { name: "What should we work on?" })).toBeVisible();
    await waitFor(() => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width));
  });

  it.each([
    { width: 1_280, height: 800, label: "desktop" },
    { width: 390, height: 844, label: "mobile" },
  ])("never paints new-conversation copy while an uncached persisted selection restores at $label size", async ({ width, height, label }) => {
    await page.viewport(width, height);
    const mobile = label === "mobile";
    await saveHydratedShell([alphaThread]);
    let resolveBootstrap!: () => void;
    let resolveThread!: () => void;
    vi.mocked(api.bootstrap).mockImplementation(() => new Promise((resolve) => {
      resolveBootstrap = () => resolve(bootstrap(
        [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })],
        [alphaThread],
        alphaThread.id,
        { threadsSourceId: "alpha" },
      ));
    }));
    vi.mocked(api.thread).mockImplementation(() => new Promise((resolve) => {
      resolveThread = () => resolve(detail(alphaThread, "Alpha restored transcript"));
    }));

    render(
      <ConsoleStoreProvider>
        <WebRuntimeProvider>
          <ConversationSwitchFixture width={width} height={height} mobile={mobile} />
        </WebRuntimeProvider>
      </ConsoleStoreProvider>,
    );
    await closeInitialMobileDrawer(mobile);

    expect(await screen.findByRole("button", { name: "Loading conversation…" })).toBeDisabled();
    expect(screen.queryByText("Start a new conversation")).toBeNull();
    expect(api.thread).toHaveBeenCalledWith(alphaThread.id, expect.any(AbortSignal));

    await act(async () => {
      resolveBootstrap();
      resolveThread();
    });
    expect(await screen.findByText("Alpha restored transcript")).toBeVisible();
    await waitFor(() => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width));
  });

  it.each([
    { width: 1_280, height: 800, label: "desktop" },
    { width: 390, height: 844, label: "mobile" },
  ])("keeps a deferred cron route loading without opening the persisted fallback at $label size", async ({ width, height, label }) => {
    await page.viewport(width, height);
    const mobile = label === "mobile";
    const cronAgent = agent("alpha", {
      label: "Alpha",
      cron: { read: true, actions: false },
    });
    await saveHydratedShell([alphaThread], [cronAgent, agent("beta", { label: "Beta" })]);
    window.history.replaceState(null, "", cronChannelPath("alpha", "daily:report"));
    let resolveBootstrap!: () => void;
    let resolveOverview!: (value: CronOverview) => void;
    vi.mocked(api.bootstrap).mockImplementation(() => new Promise((resolve) => {
      resolveBootstrap = () => resolve(bootstrap(
        [cronAgent, agent("beta", { label: "Beta" })],
        [alphaThread],
        alphaThread.id,
        { threadsSourceId: "alpha" },
      ));
    }));
    vi.mocked(api.cronOverview).mockImplementation(() => new Promise((resolve) => {
      resolveOverview = resolve;
    }));
    vi.mocked(api.thread).mockImplementation(async (threadId) => threadId === cronThread.id
      ? detail(cronThread, "Cron restored transcript")
      : detail(alphaThread, "Wrong fallback transcript"));

    render(
      <ConsoleStoreProvider>
        <WebRuntimeProvider>
          <ConversationSwitchFixture width={width} height={height} mobile={mobile} />
        </WebRuntimeProvider>
      </ConsoleStoreProvider>,
    );
    await closeInitialMobileDrawer(mobile);

    expect(await screen.findByRole("button", { name: "Loading conversation…" })).toBeDisabled();
    expect(screen.queryByText("Start a new conversation")).toBeNull();
    expect(api.thread).not.toHaveBeenCalled();
    const overview: CronOverview = {
      generatedAt: "2026-09-08T08:00:00.000Z",
      actionsEnabled: false,
      jobs: [{
        jobId: "daily:report",
        expression: "0 8 * * *",
        timezone: "Europe/Amsterdam",
        conversationId: "cron:daily:report",
        configured: true,
        declaredEnabled: true,
        effectiveEnabled: true,
        health: "healthy",
        threadId: cronThread.id,
      }],
    };
    if (mobile) {
      // Exercise the opposite race too: a hydrated cron-capable agent can
      // answer its overview before the live bootstrap. The bootstrap must
      // recognize the already-resolved route instead of re-arming it.
      await act(async () => resolveOverview(overview));
      expect(await screen.findByText("Cron restored transcript")).toBeVisible();
      await act(async () => resolveBootstrap());
    } else {
      await act(async () => resolveBootstrap());
      expect(api.thread).not.toHaveBeenCalled();
      expect(screen.queryByText("Wrong fallback transcript")).toBeNull();
      await act(async () => resolveOverview(overview));
    }
    expect(await screen.findByText("Cron restored transcript")).toBeVisible();
    expect(vi.mocked(api.thread).mock.calls.map((call) => call[0])).toEqual([cronThread.id]);
    expect(screen.queryByText("Start a new conversation")).toBeNull();
    await waitFor(() => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width));
  });

  it.each([
    { width: 1_280, height: 800, label: "desktop" },
    { width: 390, height: 844, label: "mobile" },
  ])("drills into the Automations smart collection without refetching at $label size", async ({ width, height, label }) => {
    await page.viewport(width, height);
    const mobile = label === "mobile";
    const cronAgent = agent("alpha", {
      label: "Alpha",
      cron: { read: true, actions: false },
    });
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
      [cronAgent, agent("beta", { label: "Beta" })],
      [alphaThread],
      alphaThread.id,
      { threadsSourceId: "alpha" },
    ));
    vi.mocked(api.cronOverview).mockResolvedValue({
      generatedAt: "2026-09-08T08:00:00.000Z",
      actionsEnabled: false,
      jobs: [{
        jobId: "daily:report",
        expression: "0 8 * * *",
        timezone: "Europe/Amsterdam",
        conversationId: "cron:daily:report",
        configured: true,
        declaredEnabled: true,
        effectiveEnabled: true,
        health: "healthy",
        threadId: cronThread.id,
      }],
    });

    render(
      <ConsoleStoreProvider>
        <WebRuntimeProvider>
          <ConversationSwitchFixture width={width} height={height} mobile={mobile} />
        </WebRuntimeProvider>
      </ConsoleStoreProvider>,
    );
    await closeInitialMobileDrawer(mobile);
    expect(await screen.findByText("Alpha transcript")).toBeVisible();
    await waitForLiveConsole();
    await waitFor(() => expect(api.cronOverview).toHaveBeenCalledTimes(1));

    let scope: HTMLElement = document.body;
    if (mobile) {
      await userEvent.click(screen.getByRole("button", { name: "Open conversations" }));
      scope = await screen.findByRole("dialog", { name: "Conversations" });
    }
    expect(within(scope).getByRole("heading", { name: "Recent" })).toBeVisible();
    const collection = within(scope).getByRole("button", { name: "Open Automations collection" });
    expect(within(collection).getByLabelText("1 automation job")).toHaveTextContent("1");
    await userEvent.click(collection);

    expect(within(scope).getByRole("heading", { name: "Automations" })).toBeVisible();
    const search = within(scope).getByRole("searchbox", { name: "Search automations" });
    await userEvent.type(search, "daily");
    expect(within(scope).getByRole("button", { name: "Open run history for daily:report" })).toBeVisible();
    expect(api.cronOverview).toHaveBeenCalledTimes(1);
    await userEvent.click(within(scope).getByRole("button", { name: "All conversations" }));
    expect(within(scope).getByRole("searchbox", { name: "Search conversations" })).toHaveValue("");
    expect(within(scope).getByRole("heading", { name: "Recent" })).toBeVisible();
    await waitFor(() => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width));
  });

  it.each([
    { width: 1_280, height: 800, label: "desktop" },
    { width: 390, height: 844, label: "mobile" },
  ])("keeps a synthetic delayed B to A to B switch owned at $label size", async ({ width, height, label }) => {
    await page.viewport(width, height);
    const mobile = label === "mobile";
    let resolveBeta!: (answer: { readonly threads: readonly ThreadSummary[] }) => void;
    vi.mocked(api.threads).mockImplementation(() => new Promise((resolve) => {
      resolveBeta = resolve;
    }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <StrictMode>
        <ConsoleStoreProvider>
          <WebRuntimeProvider>
            <ConversationSwitchFixture width={width} height={height} mobile={mobile} />
          </WebRuntimeProvider>
        </ConsoleStoreProvider>
      </StrictMode>,
    );

    expect(await screen.findByText("Alpha transcript")).toBeVisible();
    await waitForLiveConsole();
    await chooseAgent("Beta", mobile);
    expect(await screen.findByRole("button", { name: "Loading conversation…" })).toBeDisabled();
    expect(screen.queryByText("Start a new conversation")).toBeNull();
    expect(screen.queryByText("Something went wrong")).toBeNull();
    await expectNewConversationDisabled(mobile);
    await waitFor(() => expect(api.threads).toHaveBeenCalledTimes(1));

    await chooseAgent("Alpha", mobile);
    expect(await screen.findByText("Alpha transcript")).toBeVisible();
    await chooseAgent("Beta", mobile);
    expect(await screen.findByRole("button", { name: "Loading conversation…" })).toBeDisabled();
    expect(api.threads).toHaveBeenCalledTimes(1);

    await act(async () => { resolveBeta({ threads: [betaThread] }); });
    expect(await screen.findByText("Beta transcript")).toBeVisible();
    expect(screen.queryByText("Alpha transcript")).toBeNull();
    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(api.threads).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls.flat().some((value) =>
      String(value).includes("render failed") || String(value).includes("useClientLookup"),
    )).toBe(false);
    await waitFor(() => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width));
    consoleError.mockRestore();
  });

  it.each([
    { width: 1_280, height: 800, label: "desktop" },
    { width: 390, height: 844, label: "mobile" },
  ])("keeps an uncached archive replacement failure explicit and retryable at $label size", async ({ width, height, label }) => {
    await page.viewport(width, height);
    const mobile = label === "mobile";
    vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
      [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })],
      [alphaThread, olderAlphaThread],
      alphaThread.id,
      { threadsSourceId: "alpha" },
    ));
    vi.mocked(api.patchThread).mockResolvedValue({
      ...alphaThread,
      archivedAt: "2026-09-08T09:00:00.000Z",
    });
    let replacementReads = 0;
    vi.mocked(api.thread).mockImplementation(async (threadId) => {
      if (threadId === olderAlphaThread.id) {
        replacementReads += 1;
        if (replacementReads === 1) throw new Error("Archive replacement unavailable");
        return detail(olderAlphaThread, "Older Alpha transcript");
      }
      return detail(alphaThread, "Alpha transcript");
    });

    render(
      <StrictMode>
        <ConsoleStoreProvider>
          <WebRuntimeProvider>
            <ConversationSwitchFixture width={width} height={height} mobile={mobile} />
          </WebRuntimeProvider>
        </ConsoleStoreProvider>
      </StrictMode>,
    );

    expect(await screen.findByText("Alpha transcript")).toBeVisible();
    await waitForLiveConsole();
    let scope: HTMLElement = document.body;
    if (mobile) {
      screen.getByRole("button", { name: "Close navigation" }).click();
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose agent" })).toBeNull());
      await userEvent.click(screen.getByRole("button", { name: "Open conversations" }));
      scope = await screen.findByRole("dialog", { name: "Conversations" });
    }
    await userEvent.click(within(scope).getByRole("button", { name: "Archive Alpha thread" }));
    if (mobile && screen.queryByRole("button", { name: "Close navigation" }) !== null) {
      screen.getByRole("button", { name: "Close navigation" }).click();
    }
    if (mobile) await waitFor(() => expect(screen.queryByRole("dialog", { name: "Conversations" })).toBeNull());

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("Conversation could not be loaded");
    expect(failure).toHaveTextContent("Archive replacement unavailable");
    expect(screen.queryByText("Start a new conversation")).toBeNull();
    expect(screen.queryByText("Start a conversation")).toBeNull();
    await expectNewConversationDisabled(mobile);

    const retry = screen.getByRole("button", { name: "Retry conversation" });
    retry.scrollIntoView({ block: "center" });
    await userEvent.click(retry);
    expect(await screen.findByText("Older Alpha transcript")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(replacementReads).toBe(2);
    await waitFor(() => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width));
  });

  it.each([
    { width: 1_280, height: 800, label: "desktop" },
    { width: 390, height: 844, label: "mobile" },
  ])("keeps a cold bucket transcript failure explicit and retryable at $label size", async ({ width, height, label }) => {
    await page.viewport(width, height);
    const mobile = label === "mobile";
    vi.mocked(api.threads).mockResolvedValue({ threads: [betaThread] });
    let betaReads = 0;
    vi.mocked(api.thread).mockImplementation(async (threadId) => {
      if (threadId !== betaThread.id) return detail(alphaThread, "Alpha transcript");
      betaReads += 1;
      if (betaReads === 1) throw new Error("Beta transcript unavailable");
      return detail(betaThread, "Beta transcript");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <StrictMode>
        <ConsoleStoreProvider>
          <WebRuntimeProvider>
            <ConversationSwitchFixture width={width} height={height} mobile={mobile} />
          </WebRuntimeProvider>
        </ConsoleStoreProvider>
      </StrictMode>,
    );

    expect(await screen.findByText("Alpha transcript")).toBeVisible();
    await waitForLiveConsole();
    await chooseAgent("Beta", mobile);
    await waitFor(() => expect(api.threads).toHaveBeenCalledTimes(1));

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("Conversation could not be loaded");
    expect(failure).toHaveTextContent("Beta transcript unavailable");
    expect(screen.queryByText("Start a new conversation")).toBeNull();
    expect(screen.queryByText("Start a conversation")).toBeNull();
    expect(screen.queryByRole("status", { name: "Loading conversation" })).toBeNull();
    await expectNewConversationDisabled(mobile);
    expect(api.threads).toHaveBeenCalledTimes(1);
    expect(betaReads).toBe(1);

    const retry = screen.getByRole("button", { name: "Retry conversation" });
    retry.scrollIntoView({ block: "center" });
    await userEvent.click(retry);
    await waitFor(() => expect(betaReads).toBe(2));
    expect(api.threads).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Beta transcript")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Alpha transcript")).toBeNull();
    expect(consoleError.mock.calls.flat().some((value) =>
      String(value).includes("render failed") || String(value).includes("useClientLookup"),
    )).toBe(false);
    await waitFor(() => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width));
    consoleError.mockRestore();
  });
});
