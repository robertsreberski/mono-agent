import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { commands, page } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import {
  ConsoleStoreProvider,
  useConsoleStore,
  SELECTED_AGENT_STORAGE_KEY,
  SELECTED_THREADS_STORAGE_KEY,
} from "./console-store";
import { WebRuntimeProvider } from "./runtime";
import { agent, bootstrap, thread } from "./test/fixtures";
import { createThreadPersistence } from "./thread-persistence";
import type { ThreadSummary } from "./types";
import "./styles.css";

vi.mock("./api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api")>(),
  api: {
    bootstrap: vi.fn(),
    activeThreads: vi.fn(),
    thread: vi.fn(),
    threadIfChanged: vi.fn(),
    threads: vi.fn(),
    messages: vi.fn(),
    agentSkills: vi.fn(),
    projects: vi.fn(),
    projectThreads: vi.fn(),
    listTags: vi.fn(),
    cronRuns: vi.fn(),
    searchThreads: vi.fn(),
    latestAgentRestart: vi.fn(),
    providerAuthStatus: vi.fn(),
    providerUsage: vi.fn(),
  },
}));
vi.mock("./notifications", () => ({ NotificationBell: () => null }));

import { api } from "./api";
import { App } from "./App";

/** Opt-in evidence; ordinary browser runs assert the same DOM without writing images. */
const shotDirectory = import.meta.env.VITE_UNREAD_SHOTS as string | undefined;
const capture = async (name: string): Promise<void> => {
  if (shotDirectory === undefined || shotDirectory.length === 0) return;
  await page.screenshot({ path: `${shotDirectory}/${name}.png` });
};

/** Synthetic backend only: App, console adoption, persistence and dashboard rows are real. */
class SyntheticEventSource extends EventTarget {
  static instances: SyntheticEventSource[] = [];
  readyState = 1;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
    SyntheticEventSource.instances.push(this);
  }

  close(): void { this.readyState = 2; }

  static changed(summary: ThreadSummary): void {
    const sources = this.instances.filter((source) => source.readyState === 1);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      for (const type of ["thread.changed", "threads.changed"] as const) {
        source.dispatchEvent(new MessageEvent(type, { data: JSON.stringify({
          version: 1, type, threadId: summary.id, at: summary.updatedAt, payload: { thread: summary },
        }) }));
      }
    }
  }
}

const selected = thread("current-conversation", "alpha", {
  title: "Current conversation", messageCount: 1,
});
const background = thread("background-report", "alpha", {
  title: "Background report", messageCount: 1, runState: { status: "complete" },
});
const betaCron = thread("beta-cron", "beta", { title: "Beta schedule", trigger: { kind: "cron", jobId: "fictional-cron", configured: true } });
const alphaCron = thread("alpha-cron", "alpha", { title: "Alpha schedule", trigger: { kind: "cron", jobId: "fictional-cron", configured: true } });
const persistence = createThreadPersistence();
type Store = ReturnType<typeof useConsoleStore>;
let currentStore: Store | null = null;
function StoreProbe() {
  const store = useConsoleStore();
  useEffect(() => { currentStore = store; }, [store]);
  return null;
}
const renderApp = () => render(<ConsoleStoreProvider><WebRuntimeProvider><StoreProbe /><App /></WebRuntimeProvider></ConsoleStoreProvider>);

beforeEach(async () => {
  await persistence.clearAll();
  vi.resetAllMocks();
  SyntheticEventSource.instances = [];
  currentStore = null;
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, "alpha");
  localStorage.setItem(SELECTED_THREADS_STORAGE_KEY, JSON.stringify({ alpha: selected.id }));
  vi.stubGlobal("EventSource", SyntheticEventSource);
  await commands.emulateColorScheme("dark");
  vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
    [agent("alpha", { label: "Console demo" })], [selected, background], selected.id,
  ));
  vi.mocked(api.thread).mockImplementation(async (id) => {
    // The target must never be opened as a side effect of clearing its dot.
    expect(id).toBe(selected.id);
    return { thread: selected, messages: [{
      id: "current-message", threadId: selected.id, role: "assistant", status: "complete",
      parts: [{ type: "text", text: "Browser fixture: backend events are synthetic. The background report stays unopened in Recent." }],
      attachments: [], createdAt: selected.createdAt, updatedAt: selected.updatedAt,
    }] };
  });
  vi.mocked(api.activeThreads).mockResolvedValue({ threads: [], total: 0, truncated: false, runningCounts: {} });
  vi.mocked(api.agentSkills).mockResolvedValue({ status: "unsupported", items: [] });
  vi.mocked(api.threads).mockResolvedValue({ threads: [selected, background] });
  vi.mocked(api.messages).mockResolvedValue({ messages: [] });
  vi.mocked(api.projects).mockResolvedValue([]);
  vi.mocked(api.projectThreads).mockResolvedValue({ threads: [] });
  vi.mocked(api.listTags).mockResolvedValue([]);
  vi.mocked(api.cronRuns).mockResolvedValue({ runs: [] });
  vi.mocked(api.searchThreads).mockResolvedValue({ hits: [], truncated: false });
  vi.mocked(api.latestAgentRestart).mockResolvedValue(null);
});

afterEach(async () => {
  // Unmount before removing the transport the real store's passive effects use.
  cleanup();
  vi.unstubAllGlobals();
  await commands.emulateColorScheme(null);
  await persistence.clearAll();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

const prepareRouteFixture = () => {
  vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
    [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })],
    [selected, betaCron, alphaCron], selected.id,
  ));
  vi.mocked(api.threads).mockResolvedValue({ threads: [selected, betaCron, alphaCron] });
  vi.mocked(api.thread).mockImplementation(async (id) => ({
    thread: id === betaCron.id ? betaCron : id === alphaCron.id ? alphaCron : selected,
    messages: [],
  }));
};

describe("real route writers under mounted App settings", () => {
  it("re-scopes desktop settings on the real agent switch and Back/Forward never copy a settings marker (N13)", async () => {
    await page.viewport(1200, 800);
    prepareRouteFixture();
    renderApp();
    await waitFor(() => expect(currentStore?.selectedAgent?.sourceId).toBe("alpha"));
    act(() => window.dispatchEvent(new CustomEvent("mono-agent:agent-settings", { detail: { section: "agent" } })));
    await screen.findByRole("heading", { name: "Agent", level: 2 });
    act(() => currentStore!.selectAgent("beta"));
    await waitFor(() => expect(currentStore?.selectedAgent?.sourceId).toBe("beta"));
    expect(screen.getByText("Pin Beta first")).toBeVisible();
    expect(window.location.pathname).toBe("/agents/beta/cron/fictional-cron");
    expect(window.history.state?.monoAgentMobileNavigation?.surface).not.toBe("settings");
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(screen.queryByRole("button", { name: "Close agent settings" })).toBeNull();
    window.history.forward();
    await waitFor(() => expect(window.location.pathname).toBe("/agents/beta/cron/fictional-cron"));
    expect(screen.queryByRole("button", { name: "Close agent settings" })).toBeNull();
  });
  it("does not use copied depth to close after a real phone-to-desktop agent switch (N18/N19)", async () => {
    await page.viewport(390, 844);
    prepareRouteFixture();
    renderApp();
    await waitFor(() => expect(currentStore?.selectedAgent?.sourceId).toBe("alpha"));
    act(() => window.dispatchEvent(new CustomEvent("mono-agent:agent-settings", { detail: { section: "agent" } })));
    await screen.findByRole("heading", { name: "Agent", level: 2 });
    await page.viewport(1200, 800);
    await waitFor(() => expect(screen.getByRole("button", { name: "Close agent settings" })).toBeVisible());
    act(() => currentStore!.selectAgent("beta"));
    await waitFor(() => expect(screen.getByText("Pin Beta first")).toBeVisible());
    expect(window.history.state.monoAgentMobileNavigation.surface).toBe("conversation");
    const destination = window.location.href;
    screen.getByRole("button", { name: "Close agent settings" }).click();
    expect(window.location.href).toBe(destination);
    window.history.back();
    await waitFor(() => expect(screen.getByText("Pin Beta first")).toBeVisible());
    expect(window.history.state.monoAgentMobileNavigation.section).toBe("agent");
    window.history.forward();
    await waitFor(() => expect(window.location.href).toBe(destination));
    expect(screen.queryByRole("button", { name: "Close agent settings" })).toBeNull();
  });
  it("returns to the phone settings section after the real cron route writer (N20)", async () => {
    await page.viewport(390, 844);
    prepareRouteFixture();
    renderApp();
    await waitFor(() => expect(currentStore?.selectedAgent?.sourceId).toBe("alpha"));
    act(() => window.dispatchEvent(new CustomEvent("mono-agent:agent-settings", { detail: { section: "providers" } })));
    await screen.findByRole("heading", { name: "Providers", level: 2 });
    act(() => currentStore!.selectCronJob("alpha", "fictional-cron", alphaCron.id));
    await waitFor(() => expect(window.location.pathname).toBe("/agents/alpha/cron/fictional-cron"));
    expect(window.history.state.monoAgentMobileNavigation.surface).toBe("conversation");
    window.history.back();
    await waitFor(() => expect(window.history.state.monoAgentMobileNavigation.section).toBe("providers"));
    expect(screen.getByRole("heading", { name: "Providers", level: 2 })).toBeVisible();
  });
});

describe.each([
  { label: "desktop", width: 1_280, height: 900 },
  { label: "phone", width: 390, height: 844 },
])("settings visibility and real unread store on $label", ({ label, width, height }) => {
  it("retains the selected conversation's incoming update while covered, reads it when exposed (A8)", async () => {
    await page.viewport(width, height);
    renderApp();
    const dashboard = await screen.findByRole("navigation", { name: "Dashboard" });
    const row = await within(dashboard).findByRole("button", { name: `Open ${selected.title}` });
    if (label === "phone") {
      await act(async () => { row.click(); });
      await waitFor(() => expect(document.querySelector(".chat-region")!.hasAttribute("inert")).toBe(false));
    }
    await waitFor(() => expect(currentStore?.selectedThread?.id).toBe(selected.id));
    act(() => window.dispatchEvent(new CustomEvent("mono-agent:agent-settings")));
    await screen.findByRole("navigation", { name: "Agent settings sections" });
    await waitFor(() => expect(document.querySelector(".chat-region")!.hasAttribute("inert")).toBe(true));
    act(() => SyntheticEventSource.changed({ ...selected, revision: 2 }));
    await waitFor(() => expect(currentStore?.unreadThreadIds.has(selected.id)).toBe(true));
    expect(currentStore?.selectedThread?.id).toBe(selected.id);
    const close = screen.getByRole("button", { name: label === "phone" ? "Close settings" : "Close agent settings" });
    await act(async () => { close.click(); });
    await waitFor(() => expect(document.querySelector(".chat-region")!.hasAttribute("inert")).toBe(false));
    await waitFor(() => expect(currentStore?.unreadThreadIds.has(selected.id)).toBe(false));
  });
});

describe.each([
  { label: "desktop", width: 1_280, height: 900 },
  { label: "mobile", width: 390, height: 844 },
])("server read watermark on $label", ({ label, width, height }) => {
  it("clears the dashboard dot without opening the conversation, until a later revision", async () => {
    await page.viewport(width, height);
    renderApp();
    const dashboard = await screen.findByRole("navigation", { name: "Dashboard" });
    const row = await within(dashboard).findByRole("button", { name: `Open ${background.title}` });
    expect(row).toBeVisible();
    await waitFor(() => expect(api.thread).toHaveBeenCalled());
    expect(within(row).queryByRole("img", { name: "Unread" })).toBeNull();

    const updated = { ...background, revision: 2 };
    act(() => SyntheticEventSource.changed(updated));
    await waitFor(() => expect(within(row).getByRole("img", { name: "Unread" })).toBeVisible());
    await capture(`unread-${label}-${width}x${height}-before`);

    // Exactly the unchanged-revision summary the service emits after MarkConversationRead.
    // This browser test does not invoke MCP or claim a live server tool execution.
    const marked = { ...updated, readRevision: updated.revision };
    act(() => SyntheticEventSource.changed(marked));
    await waitFor(() => expect(within(row).queryByRole("img", { name: "Unread" })).toBeNull());
    await capture(`unread-${label}-${width}x${height}-cleared`);

    act(() => SyntheticEventSource.changed({ ...marked, revision: 3 }));
    await waitFor(() => expect(within(row).getByRole("img", { name: "Unread" })).toBeVisible());
    await capture(`unread-${label}-${width}x${height}-later`);

    expect(JSON.parse(localStorage.getItem(SELECTED_THREADS_STORAGE_KEY)!)).toEqual({ alpha: selected.id });
    expect(vi.mocked(api.thread).mock.calls.every(([id]) => id === selected.id)).toBe(true);
    expect(api.threadIfChanged).not.toHaveBeenCalled();
    expect(row).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    if (label === "mobile") expect(document.querySelector(".chat-region")).toHaveAttribute("inert");
  });
});
