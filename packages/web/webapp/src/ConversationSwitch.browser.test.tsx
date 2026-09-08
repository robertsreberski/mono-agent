import { act, render, screen, waitFor } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SELECTED_AGENT_STORAGE_KEY,
  SELECTED_THREADS_STORAGE_KEY,
  ConsoleStoreProvider,
} from "./console-store";
import { createThreadPersistence } from "./thread-persistence";
import { WebRuntimeProvider } from "./runtime";
import { agent, bootstrap, thread } from "./test/fixtures";
import type { ThreadDetail, ThreadSummary, WebMessage } from "./types";
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
import { AgentRail } from "./components/AgentRail";
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

beforeEach(async () => {
  await persistence.clearAll();
  vi.clearAllMocks();
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

describe("conversation switching through the real Chromium store and runtime", () => {
  it.each([
    { width: 1_280, height: 800, label: "desktop" },
    { width: 390, height: 844, label: "mobile" },
  ])("keeps a synthetic delayed B to A to B switch owned at $label size", async ({ width, height }) => {
    await page.viewport(width, height);
    let resolveBeta!: (answer: { readonly threads: readonly ThreadSummary[] }) => void;
    vi.mocked(api.threads).mockImplementation(() => new Promise((resolve) => {
      resolveBeta = resolve;
    }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <StrictMode>
        <ConsoleStoreProvider>
          <WebRuntimeProvider>
            <div className="app-shell" style={{ width, height }}>
              <AgentRail expanded />
              <ThreadSidebar />
              <Chat onOpenAgents={() => undefined} onOpenThreads={() => undefined} />
            </div>
          </WebRuntimeProvider>
        </ConsoleStoreProvider>
      </StrictMode>,
    );

    expect(await screen.findByText("Alpha transcript")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Beta, online" }));
    expect(await screen.findByRole("button", { name: "Loading conversation…" })).toBeDisabled();
    expect(screen.queryByText("Start a new conversation")).toBeNull();
    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(screen.getByRole("button", { name: "New conversation" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Alpha, online" }));
    expect(await screen.findByText("Alpha transcript")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Beta, online" }));
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
});
