import { cleanup, render, screen } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConsoleStoreProvider,
  SELECTED_AGENT_STORAGE_KEY,
  SELECTED_THREADS_STORAGE_KEY,
} from "../console-store";
import { createThreadPersistence } from "../thread-persistence";
import { WebRuntimeProvider } from "../runtime";
import { agent, bootstrap, thread } from "../test/fixtures";
import type { ThreadDetail, WebMessage } from "../types";
import "../styles.css";

vi.mock("../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../api")>(),
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

vi.mock("../notifications", () => ({ NotificationBell: () => null }));

import { api } from "../api";
import { App } from "../App";

/**
 * Screenshot evidence is opt-in, like the route-badge and route-marker suites:
 * `VITE_RUN_ATTRIBUTION_SHOTS=<absolute dir>` writes the transcript shots, and
 * CI runs the same DOM assertions without writing anything.
 */
const shotDirectory = import.meta.env.VITE_RUN_ATTRIBUTION_SHOTS as string | undefined;

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

/**
 * The conversation is set to Fable at High RIGHT NOW. Every fixture below is
 * synthetic: the turns, their attribution, and the route-change rule are
 * hand-written server shapes, not the product of real provider calls.
 */
const routed = thread("routed", "alpha", {
  title: "Release note for the console",
  messageCount: 6,
  runModel: FABLE,
  runEffort: "high",
});

const TURN_BY_PREFIX: Record<string, string> = {
  first: "turn-first",
  second: "turn-second",
  third: "turn-third",
};

const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
  at: string,
  attribution?: WebMessage["attribution"],
): WebMessage => ({
  id,
  threadId: routed.id,
  turnId: TURN_BY_PREFIX[id.split("-")[0] ?? ""] ?? "turn-first",
  role,
  parts: [{ type: "text", text }],
  attachments: [],
  status: "complete",
  createdAt: at,
  updatedAt: at,
  ...(attribution === undefined ? {} : { attribution }),
});

/**
 * Turn 1 asked for Sol at High and got exactly that. The conversation has since
 * moved to Fable, so the run model differs from the current selection — which is
 * NOT a deviation and must leave this turn without a footer.
 */
const obedient: WebMessage["attribution"] = {
  requested: { model: SOL, effort: "high" },
  attempted: { model: SOL, effort: "high", effectiveEffort: "high" },
  executed: { model: SOL, effort: "high", effectiveEffort: "high" },
  disposition: "requested",
  transitions: [],
  retries: [],
};

/** Turn 2 asked for Fable and was answered by Sol: a real fallback, always shown. */
const fellBack: WebMessage["attribution"] = {
  requested: { model: FABLE, effort: "high" },
  attempted: { model: SOL, effort: "high", effectiveEffort: "high" },
  executed: { model: SOL, effort: "high", effectiveEffort: "high" },
  disposition: "fallback",
  transitions: [{ from: FABLE, to: SOL, attemptIndex: 1, reason: "overloaded" }],
  retries: [],
};

/**
 * Turn 3 stayed on the selected model but the provider did not honour the asked
 * effort. The old selection-based rule hid exactly this case; it is shown now.
 */
const loweredEffort: WebMessage["attribution"] = {
  requested: { model: FABLE, effort: "high" },
  attempted: { model: FABLE, effort: "high", effectiveEffort: "low" },
  executed: { model: FABLE, effort: "high", effectiveEffort: "low" },
  disposition: "requested",
  transitions: [],
  retries: [],
};

const FIRST_ANSWER = "Here is a first pass at the release note.";
const SECOND_ANSWER = "Reworked, with the tone tightened throughout.";
const THIRD_ANSWER = "Trimmed the last paragraph as asked.";

const detail = (): ThreadDetail => ({
  thread: routed,
  messages: [
    message("first-user", "user", "Draft the release note for the console.", "2026-09-12T09:00:00.000Z"),
    message("first-assistant", "assistant", FIRST_ANSWER, "2026-09-12T09:00:04.000Z", obedient),
    message("second-user", "user", "Try that again, with more care about the wording.", "2026-09-12T09:05:00.000Z"),
    message("second-assistant", "assistant", SECOND_ANSWER, "2026-09-12T09:05:06.000Z", fellBack),
    message("third-user", "user", "Trim the last paragraph.", "2026-09-12T09:09:00.000Z"),
    message("third-assistant", "assistant", THIRD_ANSWER, "2026-09-12T09:09:05.000Z", loweredEffort),
  ],
  // The operator switched the conversation from Sol to Fable between turn 1 and
  // turn 2; the transcript rule is where that switch is told.
  modelTransitions: [{
    id: 1,
    afterMessageId: "first-assistant",
    turnId: "turn-second",
    before: { model: SOL, effort: "high" },
    after: { model: FABLE, effort: "high" },
    createdAt: "2026-09-12T09:04:40.000Z",
  }],
  projectTransitions: [],
});

const persistence = createThreadPersistence();

const openConsole = () => render(
  <ConsoleStoreProvider>
    <WebRuntimeProvider>
      <App />
    </WebRuntimeProvider>
  </ConsoleStoreProvider>,
);

const footers = (): readonly HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(".run-attribution"));

const messageOf = (text: string): HTMLElement => {
  const found = screen.getByText(text).closest<HTMLElement>(".message-assistant");
  if (found === null) throw new Error(`Expected an assistant message around ${text}`);
  return found;
};

/** Every deviation shown, every obedient turn silent — asserted on the real DOM. */
const assertRule = (): void => {
  // 1. The turn that ran on a model the conversation no longer uses: silent.
  expect(messageOf(FIRST_ANSWER).querySelector(".run-attribution")).toBeNull();
  expect(screen.queryByText(`Ran with ${SOL} · High`)).toBeNull();

  // 2. The fallback turn: shown, with both routes and the classified reason.
  const fallback = messageOf(SECOND_ANSWER).querySelector<HTMLElement>(".run-attribution");
  expect(fallback).not.toBeNull();
  expect(fallback).toHaveAttribute("data-run-attribution", "fallback");
  expect(fallback).toHaveTextContent(`Fallback: ${FABLE} → ${SOL} · overloaded`);
  expect(screen.getByRole("status", { name: "Model fallback" })).toBeVisible();

  // 3. The turn whose effort the provider did not honour: shown, on the very
  //    model the conversation is set to.
  const effort = messageOf(THIRD_ANSWER).querySelector<HTMLElement>(".run-attribution");
  expect(effort).not.toBeNull();
  expect(effort).toHaveAttribute("data-run-attribution", "requested");
  expect(effort).toHaveTextContent(`Ran with ${FABLE} · High`);
  expect(effort).toHaveTextContent("Requested High → effective Low");

  // Exactly those two footers exist in the whole transcript.
  expect(footers()).toHaveLength(2);
};

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
  await persistence.clearAll();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("run attribution in a real transcript", () => {
  it("marks only the runs that deviated from their request, desktop", async () => {
    await page.viewport(1_280, 900);
    openConsole();
    expect(await screen.findByText(THIRD_ANSWER)).toBeVisible();

    // The switch itself is told by the transcript rule, not by the turns around it.
    const marker = await screen.findByRole("note", { name: /Model changed from/u });
    expect(marker).toBeVisible();
    const rule = marker.getBoundingClientRect();
    expect(rule.top).toBeGreaterThan(screen.getByText(FIRST_ANSWER).getBoundingClientRect().bottom);

    assertRule();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1_280);
    await capture("run-attribution-desktop");
  });

  it("keeps the same verdicts inside a phone transcript", async () => {
    // The viewport is set BEFORE the console mounts: the mobile shell picks its
    // layout at mount, so resizing a desktop tree would shoot neither layout.
    await page.viewport(390, 844);
    openConsole();
    // The phone shell opens on the conversation list, so the transcript is one
    // tap away rather than already on screen.
    await userEvent.click(await screen.findByRole("button", { name: /Open Release note for the console/u }));
    expect(await screen.findByText(THIRD_ANSWER)).toBeVisible();

    assertRule();
    const fallback = messageOf(SECOND_ANSWER).querySelector<HTMLElement>(".run-attribution");
    expect(fallback?.getBoundingClientRect().right).toBeLessThanOrEqual(390);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    await capture("run-attribution-mobile");
  });
});
