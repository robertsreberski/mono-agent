import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConsoleStoreProvider,
  SELECTED_AGENT_STORAGE_KEY,
  SELECTED_THREADS_STORAGE_KEY,
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
    searchThreads: vi.fn(),
  },
}));

vi.mock("./notifications", () => ({ NotificationBell: () => null }));

import { api } from "./api";
import { App } from "./App";

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

const agents = [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })];
const alphaThread = thread("alpha-thread", "alpha", { title: "Alpha thread", messageCount: 1 });
const cronThread = thread("cron-thread", "alpha", {
  title: "Nightly report",
  trigger: { kind: "cron", jobId: "nightly", configured: true },
  updatedAt: "2026-09-07T08:00:00.000Z",
  canSend: false,
  canUpload: false,
});
const failedThread = thread("failed-thread", "alpha", {
  title: "Broken deploy",
  runState: { status: "failed" },
  updatedAt: "2026-09-07T07:00:00.000Z",
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

const openConsole = () => render(
  <ConsoleStoreProvider>
    <WebRuntimeProvider>
      <App />
    </WebRuntimeProvider>
  </ConsoleStoreProvider>,
);

const settled = async () => {
  expect(await screen.findByText("Alpha transcript")).toBeVisible();
};

beforeEach(async () => {
  await persistence.clearAll();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
  localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, "alpha");
  localStorage.setItem(SELECTED_THREADS_STORAGE_KEY, JSON.stringify({ alpha: alphaThread.id }));
  vi.stubGlobal("EventSource", SyntheticEventSource);
  vi.mocked(api.bootstrap).mockResolvedValue(bootstrap(
    agents,
    [alphaThread, cronThread, failedThread],
    alphaThread.id,
    { threadsSourceId: "alpha" },
  ));
  vi.mocked(api.thread).mockImplementation(async () => detail(alphaThread, "Alpha transcript"));
  vi.mocked(api.agentSkills).mockResolvedValue({ status: "unsupported", items: [] });
  vi.mocked(api.threads).mockResolvedValue({ threads: [] });
  vi.mocked(api.messages).mockResolvedValue({ messages: [] });
  vi.mocked(api.cronRuns).mockResolvedValue({ runs: [] });
  vi.mocked(api.cronOverview).mockResolvedValue({ generatedAt: "2026-09-08T08:00:00.000Z", actionsEnabled: false, jobs: [] });
});

afterEach(async () => {
  cleanup();
  await persistence.clearAll();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("the dashboard as the desktop column", () => {
  beforeEach(async () => { await page.viewport(1_280, 800); });

  it("is the first of two columns, at the width the shell reserves for it", async () => {
    openConsole();
    await settled();

    const shell = document.querySelector<HTMLElement>(".app-shell");
    expect(getComputedStyle(shell!).gridTemplateColumns).toBe("340px 940px");
    const panel = screen.getByRole("navigation", { name: "Dashboard" });
    expect(panel.getBoundingClientRect().width).toBe(340);
    expect(panel.getBoundingClientRect().left).toBe(0);
  });

  it("carries every navigation surface the console has, in one column", async () => {
    openConsole();
    await settled();
    const panel = screen.getByRole("navigation", { name: "Dashboard" });

    expect(within(panel).getByRole("button", { name: "Alpha, online" })).toBeVisible();
    expect(within(panel).getByPlaceholderText("Search conversations")).toBeVisible();
    expect(within(panel).getByRole("heading", { name: "Recent" })).toBeVisible();
    expect(within(panel).getByRole("button", { name: "Open Alpha thread" })).toBeVisible();
    expect(within(panel).getByRole("button", { name: /^Data /u })).toBeVisible();
    expect(within(panel).getByRole("button", { name: /Archived/u })).toBeVisible();
    // Nothing is modal here, and nothing is behind a scrim.
    expect(screen.queryByRole("dialog", { name: "Dashboard" })).toBeNull();
    expect(document.querySelector(".drawer-scrim")).toBeNull();
  });

  it("draws a row's kind, with trouble ahead of the trigger that produced it", async () => {
    openConsole();
    await settled();

    // A cron channel is an automation's history and is not a Recent row.
    expect(screen.queryByRole("button", { name: "Open Nightly report" })).toBeNull();
    const failed = screen.getByRole("button", { name: "Open Broken deploy" });
    expect(failed.querySelector(".thread-kind.is-alert")).not.toBeNull();
    expect(failed).toHaveTextContent("Failed");
  });

  it("keeps the conversation reachable while the whole column scrolls", async () => {
    openConsole();
    await settled();
    const panel = screen.getByRole("navigation", { name: "Dashboard" });

    const footer = within(panel).getByRole("button", { name: /Archived/u });
    const bounds = footer.getBoundingClientRect();
    expect(bounds.bottom).toBeLessThanOrEqual(800);
    expect(bounds.height).toBeGreaterThan(0);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1_280);
  });
});

describe("the dashboard as the mobile entrance screen", () => {
  beforeEach(async () => { await page.viewport(390, 844); });

  /** By class: while the conversation is showing, the panel is hidden and has no role to query. */
  const panel = (): HTMLElement => {
    const found = document.querySelector<HTMLElement>(".dashboard-panel");
    if (!found) throw new Error("Expected one dashboard panel");
    return found;
  };
  const chatRegion = (): HTMLElement => {
    const found = document.querySelector<HTMLElement>(".chat-region");
    if (!found) throw new Error("Expected one chat region");
    return found;
  };
  /** The transcript is on the pushed screen; it counts as settled once the store has it, visible or not. */
  const loaded = async () => {
    await waitFor(() => expect(screen.getByText("Alpha transcript", { ignore: false })).toBeInTheDocument());
  };
  /** Push the conversation and wait for the slide to finish, so a click cannot chase it. */
  const openConversation = async (): Promise<HTMLElement> => {
    await userEvent.click(within(panel()).getByRole("button", { name: "Open Alpha thread" }));
    const region = chatRegion();
    await waitFor(() => expect(region.getBoundingClientRect().left).toBe(0));
    await waitFor(() => expect(screen.getByText("Alpha transcript")).toBeVisible());
    return region;
  };

  it("lands on the Dashboard: a plain screen, with the conversation pushed away", async () => {
    openConsole();
    await loaded();

    // A screen, not a drawer: nothing modal, nothing to dismiss, no scrim.
    expect(screen.getByRole("navigation", { name: "Dashboard" })).toBe(panel());
    expect(panel()).not.toHaveAttribute("aria-modal");
    expect(panel()).not.toHaveAttribute("inert");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".drawer-scrim")).toBeNull();
    expect(panel().getBoundingClientRect().width).toBe(390);
    expect(panel().getBoundingClientRect().left).toBe(0);
    // The conversation is off the right edge and out of reach.
    expect(chatRegion()).toHaveAttribute("inert");
    expect(chatRegion()).toHaveAttribute("aria-hidden", "true");
    expect(chatRegion().getBoundingClientRect().left).toBeGreaterThanOrEqual(390);
    expect(screen.getByText("Alpha transcript")).not.toBeVisible();
  });

  it("pushes the conversation from a row and pops it from the header's back control", async () => {
    openConsole();
    await loaded();

    const region = await openConversation();
    expect(region).not.toHaveAttribute("inert");
    expect(panel()).toHaveAttribute("inert");
    expect(panel()).toHaveAttribute("aria-hidden", "true");
    // The way back sits at the left edge of the conversation header, before the title.
    const back = screen.getByRole("button", { name: "Back to dashboard" });
    const header = back.closest(".chat-header");
    expect(header).not.toBeNull();
    expect(back.getBoundingClientRect().left).toBeLessThan(header!.getBoundingClientRect().left + 24);
    expect(back.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);

    await userEvent.click(back);
    await waitFor(() => expect(chatRegion().getBoundingClientRect().left).toBeGreaterThanOrEqual(390));
    expect(panel()).not.toHaveAttribute("inert");
    expect(chatRegion()).toHaveAttribute("inert");
  });

  it("keeps Tab on the screen that is showing, and Escape pops the conversation", async () => {
    openConsole();
    await loaded();

    for (let step = 0; step < 12; step += 1) {
      await userEvent.keyboard("{Tab}");
      expect(chatRegion().contains(document.activeElement)).toBe(false);
    }

    await openConversation();
    for (let step = 0; step < 12; step += 1) {
      await userEvent.keyboard("{Tab}");
      expect(panel().contains(document.activeElement)).toBe(false);
    }

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(chatRegion()).toHaveAttribute("inert"));
    await waitFor(() => expect(panel().contains(document.activeElement)).toBe(true));
  });

  it("stays on the Dashboard for the archive shelf and the chips, and leaves for a conversation", async () => {
    openConsole();
    await loaded();

    await userEvent.click(within(panel()).getByRole("button", { name: /^Archived/u }));
    expect(chatRegion()).toHaveAttribute("inert");
    await userEvent.click(within(panel()).getByRole("button", { name: "Back to conversations" }));
    await userEvent.click(within(panel()).getByRole("button", { name: /^Automations/u }));
    await userEvent.click(within(panel()).getByRole("button", { name: "Chats" }));
    expect(chatRegion()).toHaveAttribute("inert");

    await openConversation();
    expect(chatRegion()).not.toHaveAttribute("inert");
  });

  it("never lets either screen push the page sideways", async () => {
    openConsole();
    await loaded();
    await waitFor(() => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390));
    await openConversation();
    await waitFor(() => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390));
  });
});
