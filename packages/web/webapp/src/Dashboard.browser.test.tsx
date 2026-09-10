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

    const cron = screen.getByRole("button", { name: "Open Nightly report" });
    expect(cron.querySelector(".thread-kind.is-cron")).not.toBeNull();
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

describe("the dashboard as the mobile drawer", () => {
  beforeEach(async () => { await page.viewport(390, 844); });

  /** The panel by class: while it is closed it has no accessible name to find. */
  const panelElement = (): HTMLElement => {
    const panel = document.querySelector<HTMLElement>(".dashboard-panel");
    if (!panel) throw new Error("Expected one dashboard panel");
    return panel;
  };

  /** Open it and wait for the slide to finish, so a click cannot chase it. */
  const openDrawer = async (): Promise<HTMLElement> => {
    await userEvent.click(screen.getByRole("button", { name: "Open dashboard" }));
    const panel = await screen.findByRole("dialog", { name: "Dashboard" });
    await waitFor(() => expect(panel.getBoundingClientRect().left).toBe(0));
    return panel;
  };

  it("opens closed, hidden from assistive technology and out of the tab order", async () => {
    openConsole();
    await settled();

    const panel = panelElement();
    expect(panel).toHaveAttribute("role", "dialog");
    expect(panel).toHaveAttribute("aria-modal", "true");
    expect(panel).toHaveAttribute("aria-label", "Dashboard");
    expect(panel).toHaveAttribute("aria-hidden", "true");
    expect(panel).toHaveAttribute("inert");
    // Off the left edge, and nothing of the conversation is blocked.
    expect(panel.getBoundingClientRect().right).toBeLessThanOrEqual(0);
    expect(document.querySelector(".chat-region")).not.toHaveAttribute("inert");
    expect(document.querySelector(".drawer-scrim")).toBeNull();
  });

  it("opens from the one header control, takes focus, and makes the chat inert", async () => {
    openConsole();
    await settled();

    const panel = await openDrawer();

    expect(panel).not.toHaveAttribute("inert");
    expect(panel).toHaveAttribute("aria-hidden", "false");
    expect(document.querySelector(".chat-region")).toHaveAttribute("inert");
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    expect(screen.getByRole("button", { name: "Close navigation" })).toBeVisible();
  });

  it("keeps Tab out of the conversation and gives focus back on Escape", async () => {
    openConsole();
    await settled();
    const opener = screen.getByRole("button", { name: "Open dashboard" });
    const panel = await openDrawer();
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    const chat = document.querySelector<HTMLElement>(".chat-region");

    // The trap lets one step reach the scrim -- which is part of the modal,
    // and the only pointer-free way out of it -- and takes the next one back.
    for (let step = 0; step < 12; step += 1) {
      await userEvent.keyboard("{Tab}");
      expect(chat?.contains(document.activeElement)).toBe(false);
      expect(
        panel.contains(document.activeElement)
        || document.activeElement?.classList.contains("drawer-scrim")
        || document.activeElement === document.body,
      ).toBe(true);
    }

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Dashboard" })).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("closes on a conversation and on the scrim, and stays open for the archive shelf", async () => {
    openConsole();
    await settled();

    const panel = await openDrawer();
    await userEvent.click(within(panel).getByRole("button", { name: /^Archived/u }));
    // A shelf switch is not going anywhere: the drawer stays put.
    expect(screen.getByRole("dialog", { name: "Dashboard" })).toBeVisible();
    await userEvent.click(within(panel).getByRole("button", { name: "Back to conversations" }));
    expect(screen.getByRole("dialog", { name: "Dashboard" })).toBeVisible();

    // Dispatched rather than pointed at: the scrim covers the whole viewport
    // and its centre is under the drawer, which is what a real tap avoids by
    // landing on the strip beside it.
    screen.getByRole("button", { name: "Close navigation" }).click();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Dashboard" })).toBeNull());

    const reopened = await openDrawer();
    await userEvent.click(
      await within(reopened).findByRole("button", { name: "Open Alpha thread" }),
    );

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Dashboard" })).toBeNull());
  });

  it("never lets the drawer push the page sideways", async () => {
    openConsole();
    await settled();
    await openDrawer();

    await waitFor(() => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390));
  });
});
