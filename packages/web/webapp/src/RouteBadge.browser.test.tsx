import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { commands, page, userEvent } from "@vitest/browser/context";
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

declare module "@vitest/browser/context" {
  interface BrowserCommands {
    emulateColorScheme(colorScheme: "light" | "dark" | null): Promise<void>;
  }
}

vi.mock("./api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api")>(),
  api: {
    bootstrap: vi.fn(),
    activeThreads: vi.fn(),
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

// Inside the webapp root: the browser runner's file access stays within the
// Vite project, so captures land here and are moved to ROOT/output/issue-861
// after the run (never committed).
const SHOT_DIR =
  "/Users/robertsreberski/worktrees/mono-maintainer/mono-agent/issue-861/packages/web/webapp/.screenshots-issue-861";

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

const SONNET = "anthropic:claude-sonnet-4.5";
const SOL = "openai-codex:gpt-5.6-sol";
const LONG_MODEL = "some-provider:a-very-long-custom-model-name-9";

const alpha = agent("alpha", {
  label: "Alpha",
  models: [SONNET, SOL],
  defaultModel: SONNET,
  defaultEffort: "high",
  modelOptions: {
    [SONNET]: { label: "Claude Sonnet 4.5", reasoning: true, effortLevels: ["medium", "high"] },
    [SOL]: { label: "GPT-5.6 Sol", reasoning: true, effortLevels: ["low", "high"] },
  },
});
const beta = agent("beta", {
  label: "Beta",
  models: [LONG_MODEL],
  defaultModel: LONG_MODEL,
  defaultEffort: "xhigh",
});

const inheritThread = thread("badge-inherit", "alpha", {
  title: "Inherited defaults triệt",
  messageCount: 2,
  lastMessagePreview: "A settled conversation on agent defaults.",
});
const solThread = thread("badge-sol", "alpha", {
  title: "Sol override room",
  messageCount: 3,
  runModel: SOL,
  runEffort: "low",
  lastMessagePreview: "Running hot on Sol.",
});
const maxThread = thread("badge-max", "alpha", {
  title: "Max effort push",
  messageCount: 1,
  runEffort: "max",
  lastMessagePreview: "One big push.",
});
const longThread = thread("badge-long", "beta", {
  title: "Beta long model name",
  messageCount: 1,
  lastMessagePreview: "A catalog stranger.",
});
const ghostThread = thread("badge-ghost", "ghost", {
  title: "Ghost agent thread",
  messageCount: 1,
  lastMessagePreview: "Its agent left discovery.",
});
const alphaRunning = thread("badge-running-alpha", "alpha", {
  title: "Rebuild the checkout",
  runState: { status: "running", id: "turn-a" },
});
const betaRunning = thread("badge-running-beta", "beta", {
  title: "Beta night shift",
  runState: { status: "running", id: "turn-b" },
});

const subagentMessage = (threadId: string): WebMessage => ({
  id: `${threadId}-delegation`,
  threadId,
  role: "assistant",
  createdAt: "2026-09-08T08:00:00.000Z",
  updatedAt: "2026-09-08T08:00:02.000Z",
  status: "complete",
  attachments: [],
  parts: [
    {
      type: "subagent",
      toolCallId: "call-exec",
      name: "researcher",
      label: "read the router",
      status: "complete",
      executionMs: 12_400,
      args: { name: "researcher", prompt: "Read the router and report what it does." },
      result: "The router maps channels to agents.",
      attribution: {
        requested: { model: SONNET, effort: "high" },
        executed: { model: SOL, effort: "high" },
        disposition: "requested",
        transitions: [],
        retries: [],
      },
      calls: [
        {
          toolCallId: "agent:call-exec:t1",
          toolName: "read_file",
          args: { file_path: "/repo/router.ts" },
          result: "routes",
          status: "complete",
        },
      ],
    },
    {
      type: "subagent",
      toolCallId: "call-fallback",
      name: "writer",
      status: "complete",
      executionMs: 3_200,
      args: { name: "writer", prompt: "Draft the summary." },
      result: "Summary drafted.",
      attribution: {
        requested: { model: "primary", effort: "high" },
        executed: { model: "fallback", effort: "xhigh", effectiveEffort: "max" },
        disposition: "fallback",
        transitions: [{ from: "primary", to: "fallback", reason: "overloaded" }],
        retries: [],
      },
      calls: [],
    },
  ],
});

const detail = (summary: ThreadSummary): ThreadDetail => {
  const intro: WebMessage = {
    id: `${summary.id}-message`,
    threadId: summary.id,
    role: "assistant",
    parts: [{ type: "text", text: "Badge fixture transcript" }],
    attachments: [],
    createdAt: "2026-09-08T08:00:00.000Z",
    updatedAt: "2026-09-08T08:00:00.000Z",
    status: "complete",
  };
  return {
    thread: summary,
    messages: summary.id === inheritThread.id
      ? [intro, subagentMessage(summary.id)]
      : [intro],
  };
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
  expect(await screen.findByText("Badge fixture transcript")).toBeVisible();
};

async function emulate(colorScheme: "light" | "dark"): Promise<void> {
  await commands.emulateColorScheme(colorScheme);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

beforeEach(async () => {
  await persistence.clearAll();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
  localStorage.setItem(SELECTED_AGENT_STORAGE_KEY, "alpha");
  localStorage.setItem(
    SELECTED_THREADS_STORAGE_KEY,
    JSON.stringify({ alpha: inheritThread.id }),
  );
  vi.stubGlobal("EventSource", SyntheticEventSource);
  // The list bucket is Alpha's: Beta's thread and the ghost thread only reach
  // the dashboard through fleet cards and search hits, which have their own
  // tests below.
  vi.mocked(api.bootstrap).mockResolvedValue({
    ...bootstrap(
      [alpha, beta],
      [inheritThread, solThread, maxThread],
      inheritThread.id,
      { threadsSourceId: "alpha" },
    ),
    activeThreads: {
      threads: [alphaRunning, betaRunning],
      total: 2,
      truncated: false,
      runningCounts: { alpha: 1, beta: 1 },
    },
  });
  vi.mocked(api.thread).mockImplementation(async (id: string) => detail(
    [inheritThread, solThread, maxThread].find((entry) => entry.id === id)
      ?? inheritThread,
  ));
  vi.mocked(api.activeThreads).mockResolvedValue({
    threads: [alphaRunning, betaRunning],
    total: 2,
    truncated: false,
    runningCounts: { alpha: 1, beta: 1 },
  });
  vi.mocked(api.agentSkills).mockResolvedValue({ status: "unsupported", items: [] });
  vi.mocked(api.threads).mockResolvedValue({ threads: [] });
  vi.mocked(api.messages).mockResolvedValue({ messages: [] });
  vi.mocked(api.cronRuns).mockResolvedValue({ runs: [] });
  vi.mocked(api.cronOverview).mockResolvedValue({
    generatedAt: "2026-09-08T08:00:00.000Z",
    actionsEnabled: false,
    jobs: [],
  });
});

afterEach(async () => {
  cleanup();
  await commands.emulateColorScheme(null);
  await persistence.clearAll();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("route badges on the dashboard", () => {
  it("labels inherited and overridden rows at desktop", async () => {
    await page.viewport(1_280, 800);
    await emulate("dark");
    openConsole();
    await settled();

    // The inherit row and Alpha's running card honestly agree; scope to the row.
    const inheritRow = screen.getByRole("button", { name: "Open Inherited defaults triệt" });
    expect(within(inheritRow).getByRole("img", {
      name: "Model Claude Sonnet 4.5 (anthropic:claude-sonnet-4.5), effort High, inherited agent defaults",
    })).toBeVisible();
    const solRow = screen.getByRole("button", { name: "Open Sol override room" });
    expect(within(solRow).getByRole("img", {
      name: `Model GPT-5.6 Sol (${SOL}), effort Low, conversation override`,
    })).toBeVisible();
    const maxRow = screen.getByRole("button", { name: "Open Max effort push" });
    expect(within(maxRow).getByRole("img", { name: /effort Max, conversation override/u })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1_280);
  });

  it("draws each fleet card with its own agent's route", async () => {
    await page.viewport(1_280, 800);
    await emulate("dark");
    openConsole();
    await settled();

    await waitFor(() => expect(document.querySelectorAll(".running-card").length).toBe(2));
    const alphaCard = screen.getByRole("button", { name: "Open Rebuild the checkout on Alpha" });
    expect(within(alphaCard).getByRole("img", { name: /inherited agent defaults/u })).toBeVisible();
    const betaCard = screen.getByRole("button", { name: "Open Beta night shift on Beta" });
    // Beta's long default model keeps its full identity in the accessible name.
    expect(within(betaCard).getByRole("img", { name: new RegExp(LONG_MODEL, "u") })).toBeVisible();
  });

  it("badges the search hits that replace the list", async () => {
    await page.viewport(1_280, 800);
    await emulate("dark");
    vi.mocked(api.searchThreads).mockResolvedValue({
      hits: [
        { thread: solThread, messageMatches: 0, titleMatch: true },
        { thread: ghostThread, messageMatches: 2, titleMatch: false },
      ],
      truncated: false,
    });
    openConsole();
    await settled();

    await userEvent.fill(screen.getByPlaceholderText("Search conversations"), "room");
    const hit = await screen.findByRole("button", { name: "Open Sol override room" });
    expect(within(hit).getByRole("img", { name: /conversation override/u })).toBeVisible();
    const ghost = await screen.findByRole("button", { name: "Open Ghost agent thread" });
    expect(within(ghost).getByRole("img", { name: /agent unavailable/u })).toBeVisible();
  });

  it("keeps collapsed subagent badges readable and expands the routing detail", async () => {
    await page.viewport(1_280, 800);
    await emulate("dark");
    openConsole();
    await settled();

    // Delegations fold inside the transcript's Activity group; open it first.
    await userEvent.click(screen.getByRole("button", { name: /Activity/u }));
    const executed = screen.getByRole("img", { name: /Subagent route: Ran with/u });
    expect(executed).toBeVisible();
    const fallback = screen.getByRole("img", { name: /Subagent route: Fallback/u });
    expect(fallback).toBeVisible();
    expect(fallback).toHaveClass("is-fallback");

    const rows = document.querySelectorAll("details.activity-row.is-subagent");
    expect(rows.length).toBe(2);
    await userEvent.click(rows[1]!.querySelector("summary")!);
    expect(await screen.findByText("Fallback: primary → fallback · overloaded")).toBeVisible();
  });
});

describe("route badge screenshots", () => {
  it("captures the console with badges, desktop and phone, dark and light", async () => {
    await page.viewport(1_280, 800);
    await emulate("dark");
    openConsole();
    await settled();
    await waitFor(() => expect(document.querySelectorAll(".running-card").length).toBe(2));
    await userEvent.click(screen.getByRole("button", { name: /Activity/u }));
    await waitFor(() => expect(screen.getByRole("img", { name: /Subagent route: Fallback/u })).toBeVisible());
    await page.screenshot({ path: `${SHOT_DIR}/dashboard-desktop-dark-1280x800.png` });

    await emulate("light");
    await page.screenshot({ path: `${SHOT_DIR}/dashboard-desktop-light-1280x800.png` });
    await emulate("dark");

    await page.viewport(390, 844);
    // Let the entrance slide finish: a capture mid-push is half dashboard.
    // Both edges settle -- the list arrives AND the conversation leaves.
    await waitFor(() => expect(
      document.querySelector<HTMLElement>(".dashboard-panel")?.getBoundingClientRect().left,
    ).toBe(0));
    await waitFor(() => expect(
      document.querySelector<HTMLElement>(".chat-region")?.getBoundingClientRect().left,
    ).toBeGreaterThanOrEqual(390));
    await waitFor(() => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390));
    await page.screenshot({ path: `${SHOT_DIR}/dashboard-phone-dark-390x844.png` });

    // The conversation, pushed from its row: collapsed badges plus one open
    // delegation with its routing detail.
    await userEvent.click(screen.getByRole("button", { name: "Open Inherited defaults triệt" }));
    await waitFor(() => expect(
      document.querySelector<HTMLElement>(".chat-region")?.getBoundingClientRect().left,
    ).toBe(0));
    await waitFor(() => expect(screen.getByText("Badge fixture transcript")).toBeVisible());
    const activityTrigger = screen.getByRole("button", { name: /Activity/u });
    // The desktop pass above already opened this group and the disclosure
    // state survives the push; only open it when it is actually closed.
    if (activityTrigger.getAttribute("aria-expanded") === "false") {
      // Center it: a sticky chat header eats clicks at the viewport edge.
      activityTrigger.scrollIntoView({ block: "center" });
      await userEvent.click(activityTrigger);
    }
    await waitFor(() => expect(screen.getByRole("img", { name: /Subagent route: Fallback/u })).toBeVisible());
    const rows = document.querySelectorAll("details.activity-row.is-subagent");
    await userEvent.click(rows[1]!.querySelector("summary")!);
    await waitFor(() => expect(screen.getByText("Fallback: primary → fallback · overloaded")).toBeVisible());
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${SHOT_DIR}/activity-phone-dark-390x844.png` });

    await page.viewport(320, 568);
    await waitFor(() => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320));
    await page.screenshot({ path: `${SHOT_DIR}/activity-narrow-dark-320x568.png` });
  }, 120_000);
});
