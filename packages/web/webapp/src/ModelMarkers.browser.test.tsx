import { cleanup, render, screen } from "@testing-library/react";
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
import type { ThreadDetail, WebMessage } from "./types";
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

/**
 * Screenshot evidence is opt-in, like the route-badge suite:
 * `VITE_MODEL_MARKER_SHOTS=<absolute dir>` captures the transcript with the
 * rules in it, and CI runs the same assertions without writing anything.
 */
const shotDirectory = import.meta.env.VITE_MODEL_MARKER_SHOTS as string | undefined;

const capture = async (name: string): Promise<void> => {
  if (shotDirectory === undefined || shotDirectory.length === 0) return;
  await page.screenshot({ path: `${shotDirectory}/${name}.png` });
};

const SOL = "openai-codex:gpt-5.6-sol";
const FABLE = "anthropic:claude-fable-5-1";

const alpha = agent("alpha", {
  label: "Alpha",
  models: [SOL, FABLE],
  defaultModel: SOL,
  defaultEffort: "high",
  modelOptions: {
    [SOL]: { label: "GPT-5.6 Sol", reasoning: true, effortLevels: ["low", "medium", "high", "xhigh"] },
    [FABLE]: { label: "Claude Fable 5.1", reasoning: true, effortLevels: ["low", "medium", "high", "max"] },
  },
});

const routed = thread("routed", "alpha", {
  title: "Release note for the console",
  messageCount: 4,
  runModel: FABLE,
  runEffort: "medium",
});

const message = (id: string, role: "user" | "assistant" | "system", text: string, at: string): WebMessage => ({
  id,
  threadId: routed.id,
  turnId: id.startsWith("first") ? "turn-first" : "turn-second",
  role,
  parts: [{ type: "text", text }],
  attachments: [],
  status: "complete",
  createdAt: at,
  updatedAt: at,
});

// Sep 12 of the current year: the rule prints the year only for another one,
// so a fixed calendar date would drift into a different rendering next January.
const resumedAt = new Date(new Date().getFullYear(), 8, 12, 9, 4, 40);

const resumedLabel = (): string => `Resumed ${resumedAt.toLocaleString(undefined,
  { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;

const resumedRow = (): WebMessage => ({
  ...message("resume-marker", "system", "", new Date(resumedAt.getTime() + 1_000).toISOString()),
  parts: [{ type: "conversation-marker", kind: "resumed", at: resumedAt.toISOString(),
    previousMessageAt: new Date(resumedAt.getTime() - 7_480_000).toISOString(), idleMs: 7_480_000 }],
});

const detail = (): ThreadDetail => ({
  thread: routed,
  messages: [
    message("first-user", "user", "Draft the release note for the console.", "2026-09-12T09:00:00.000Z"),
    message("first-assistant", "assistant", "Here is a first pass at the release note.", "2026-09-12T09:00:04.000Z"),
    { ...message("project-marker", "system", "", "2026-09-12T09:04:40.000Z"), parts: [{ type: "conversation-marker", kind: "project",
    before: null,
    after: { id: "project-web", name: "Web console", color: "blue" },
    at: "2026-09-12T09:04:30.000Z",
  }] },
    { ...message("model-marker", "system", "", "2026-09-12T09:04:40.000Z"), parts: [{ type: "conversation-marker", kind: "model",
    before: { model: SOL, effort: "high" },
    after: { model: FABLE, effort: "medium" },
    at: "2026-09-12T09:04:40.000Z",
  }] },
    message("second-user", "user", "Try that again, with more care about the wording.", "2026-09-12T09:05:00.000Z"),
    message("second-assistant", "assistant", "Reworked, with the tone tightened throughout.", "2026-09-12T09:05:06.000Z"),
  ],

});

const persistence = createThreadPersistence();

const openConsole = () => render(
  <ConsoleStoreProvider>
    <WebRuntimeProvider>
      <App />
    </WebRuntimeProvider>
  </ConsoleStoreProvider>,
);

const settled = async () => {
  expect(await screen.findByText("Reworked, with the tone tightened throughout.")).toBeVisible();
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
  localStorage.setItem(SELECTED_THREADS_STORAGE_KEY, JSON.stringify({ alpha: routed.id }));
  vi.mocked(api.bootstrap).mockResolvedValue(bootstrap([alpha], [routed], routed.id, { threadsSourceId: "alpha" }));
  vi.mocked(api.thread).mockResolvedValue(detail());
  vi.mocked(api.activeThreads).mockResolvedValue({ threads: [], total: 0, truncated: false, runningCounts: { alpha: 0 } });
  vi.mocked(api.agentSkills).mockResolvedValue({ status: "unsupported", items: [] });
  vi.mocked(api.threads).mockResolvedValue({ threads: [] });
  vi.mocked(api.messages).mockResolvedValue({ messages: [] });
  vi.mocked(api.cronRuns).mockResolvedValue({ runs: [] });
  vi.mocked(api.cronOverview).mockResolvedValue({
    generatedAt: "2026-09-12T09:00:00.000Z",
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

describe("route change markers in the transcript", () => {
  it("draws the rule between the two turns, beside a membership rule, desktop and phone", async () => {
    await page.viewport(1_280, 900);
    await emulate("dark");
    openConsole();
    await settled();

    const marker = await screen.findByRole("note", {
      name: `Model changed from ${SOL}, effort High to ${FABLE}, effort Medium`,
    });
    expect(marker).toBeVisible();
    expect(marker.closest(".message")).toBeNull();
    expect(marker).toHaveTextContent("Sol 5.6 · high");
    expect(marker).toHaveTextContent("Fable 5.1 · medium");
    // Between the turns it sits between, and telling itself apart from the
    // membership rule that landed at the same anchor.
    const membership = screen.getByText("Joined Web console").getBoundingClientRect();
    const first = screen.getByText("Here is a first pass at the release note.").getBoundingClientRect();
    const second = screen.getByText("Try that again, with more care about the wording.").getBoundingClientRect();
    const rule = marker.getBoundingClientRect();
    expect(rule.top).toBeGreaterThan(first.bottom);
    expect(rule.bottom).toBeLessThan(second.top);
    expect(rule.top).toBeGreaterThanOrEqual(membership.bottom - 1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1_280);
    await capture("transcript-desktop-dark-1280x900");

    await emulate("light");
    await capture("transcript-desktop-light-1280x900");
  });

  it("renders a resumed system row as a short local-time quiet rule without bubble chrome", async () => {
    await page.viewport(1_280, 900);
    const data = detail();
    vi.mocked(api.thread).mockResolvedValue({ ...data, messages: [...data.messages.slice(0, 2), resumedRow(), ...data.messages.slice(-2)] });
    openConsole();
    await settled();
    const marker = screen.getByText(resumedLabel());
    const rule = marker.closest('[role="note"]');
    expect(rule).toBeVisible();
    expect(rule).toHaveAccessibleName(resumedLabel());
    // No seconds, and the idle duration stays in the agent's context only.
    expect(rule).not.toHaveTextContent(/:\d\d:\d\d/u);
    expect(rule).not.toHaveTextContent(/idle/u);
    expect(marker.closest(".message")).toBeNull();
    expect(marker.getBoundingClientRect().bottom).toBeLessThan(screen.getByText("Try that again, with more care about the wording.").getBoundingClientRect().top);
    await capture("transcript-resumed-desktop-1280x900");
  });

  it("keeps the rule inside a phone transcript", async () => {
    // The viewport is set BEFORE the console mounts: the mobile shell picks its
    // layout at mount, so resizing a desktop tree leaves the drawer half open
    // and the shot would be of neither layout.
    await page.viewport(390, 844);
    await emulate("light");
    const data = detail();
    vi.mocked(api.thread).mockResolvedValue({ ...data, messages: [...data.messages.slice(0, 2), resumedRow(), ...data.messages.slice(2)] });
    openConsole();
    // The phone shell opens on the conversation list, so the transcript is one
    // tap away rather than already on screen.
    await userEvent.click(await screen.findByRole("button", { name: /Open Release note for the console/u }));
    await settled();

    const marker = await screen.findByRole("note", { name: /Model changed from/u });
    expect(marker).toBeVisible();
    expect(marker.closest(".message")).toBeNull();
    expect(marker).toHaveTextContent("Fable 5.1 · medium");
    expect(marker.getBoundingClientRect().right).toBeLessThanOrEqual(390);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);

    // The resume rule is the longest of the three: it has to stay on one line
    // at 390px, which is what the shortened date buys.
    const resumed = await screen.findByRole("note", { name: resumedLabel() });
    expect(resumed).toBeVisible();
    expect(screen.getByText(resumedLabel()).getClientRects()).toHaveLength(1);
    expect(resumed.getBoundingClientRect().right).toBeLessThanOrEqual(390);
    await capture("transcript-phone-light-390x844");

    await emulate("dark");
    await capture("transcript-phone-dark-390x844");
  });
});
