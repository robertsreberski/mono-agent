import { render, screen, waitFor } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StartTurnInput } from "../types";
import { agent, thread, uploadLimits } from "../test/fixtures";
import "../styles.css";

const storeMock = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("../console-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../console-store")>();
  return {
    ...actual,
    useConsoleStore: () => storeMock.current,
    useUploadLimits: () => uploadLimits,
  };
});
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    api: { createUpload: vi.fn(), deleteUpload: vi.fn() },
    uploadContent: vi.fn(),
  };
});

import { Composer } from "./Composer";
import { ModelChangeNotice, ModelControls } from "./Chat";
import { WebRuntimeProvider } from "../runtime";

type SendSubmission = (
  input: StartTurnInput,
  onThreadResolved?: (threadId: string) => void,
) => Promise<void>;

/**
 * Screenshot evidence is opt-in: `VITE_COMPOSER_HINT_SHOTS=<absolute dir>`
 * captures the composer at each viewport, and CI runs the same assertions
 * without it.
 */
const shotDirectory = import.meta.env.VITE_COMPOSER_HINT_SHOTS as string | undefined;

const capture = async (name: string): Promise<void> => {
  if (shotDirectory === undefined || shotDirectory.length === 0) return;
  await page.screenshot({ path: `${shotDirectory}/${name}.png` });
};

const onlineAgent = agent("agent");
const runningThread = thread("thread", "agent", {
  runState: { id: "turn-running", status: "running" },
});

function store(sendSubmission: SendSubmission): Record<string, unknown> {
  return {
    bootstrap: null,
    agents: [onlineAgent],
    threads: [runningThread],
    visibleThreads: [runningThread],
    selectedAgent: onlineAgent,
    selectedThread: runningThread,
    detail: null,
    selectedAgentId: onlineAgent.sourceId,
    selectedThreadId: runningThread.id,
    loading: false,
    detailLoading: false,
    selectionLoading: false,
    selectionError: null,
    error: null,
    actionError: null,
    connection: "live",
    showArchived: false,
    model: "",
    effort: "",
    modelOptions: [],
    effortOptions: [],
    skillRegistry: { status: "ready", items: [], total: 0 },
    selectAgent: vi.fn(),
    selectThread: vi.fn(),
    createThread: vi.fn(),
    renameThread: vi.fn(),
    archiveThread: vi.fn(),
    unarchiveThread: vi.fn(),
    sendTurn: vi.fn(),
    sendSubmission,
    sendLiveInput: vi.fn(),
    cancelTurn: vi.fn().mockResolvedValue(undefined),
    setShowArchived: vi.fn(),
    setModel: vi.fn(),
    setEffort: vi.fn(),
    retry: vi.fn(),
    clearActionError: vi.fn(),
  };
}

/**
 * Screenshot evidence is opt-in: `VITE_MODEL_CHANGE_BANNER_SHOTS=<absolute dir>`
 * captures the composer with the model-change banner visible, and CI runs the
 * same geometry assertions without it.
 */
const bannerShotDirectory = import.meta.env.VITE_MODEL_CHANGE_BANNER_SHOTS as string | undefined;

const captureBanner = async (name: string): Promise<void> => {
  if (bannerShotDirectory === undefined || bannerShotDirectory.length === 0) return;
  await page.screenshot({ path: `${bannerShotDirectory}/${name}.png` });
};

const NOTICE_COPY = "Model changed — the next reply rebuilds this conversation's context from its text history.";

function noticeStore(): Record<string, unknown> {
  const changedFrom = "pi:openai-codex:gpt-5.5";
  const changedTo = "pi:anthropic:claude-sonnet-4.5";
  const base = store(vi.fn<SendSubmission>().mockResolvedValue(undefined));
  const selectedThread = thread("thread", "agent");
  const selectedAgent = agent("agent", {
    models: [changedFrom, changedTo],
    defaultModel: changedFrom,
    defaultEffort: "high",
    modelOptions: {
      [changedFrom]: { label: "GPT-5.5 Codex", reasoning: true, effortLevels: ["low", "high"] },
      [changedTo]: { label: "Claude Sonnet 4.5", reasoning: true, effortLevels: ["low", "high"] },
    },
  });
  return {
    ...base,
    model: changedTo,
    effort: "",
    modelOptions: [changedFrom, changedTo],
    effortOptions: ["low", "high"],
    effectiveModel: changedTo,
    effectiveEffort: "high",
    hasRunOverride: false,
    resetRunOverride: vi.fn(),
    setModel: vi.fn(),
    setEffort: vi.fn(),
    selectedThread,
    selectedThreadId: selectedThread.id,
    threads: [selectedThread],
    visibleThreads: [selectedThread],
    selectedAgent,
    agents: [selectedAgent],
    selectedAgentId: selectedAgent.sourceId,
    detail: {
      thread: selectedThread,
      messages: [{
        id: "assistant-one",
        threadId: selectedThread.id,
        role: "assistant",
        parts: [{ type: "text", text: "done" }],
        attachments: [],
        createdAt: "2026-07-17T10:00:00.000Z",
        updatedAt: "2026-07-17T10:00:00.000Z",
        finishedAt: "2026-07-17T10:00:00.000Z",
        status: "complete",
        attribution: {
          requested: { model: changedFrom, effort: "high" },
          executed: { model: changedFrom, effort: "high" },
          disposition: "requested" as const,
          transitions: [],
          retries: [],
        },
      }],
    },
    catalogByProvider: {},
    ensureProviderCatalog: vi.fn(),
  };
}

describe.each([
  { label: "mobile", width: 390, height: 844 },
  { label: "desktop", width: 1440, height: 900 },
])("model-change banner at the $label viewport", ({ label, width, height }) => {
  it("renders above the input without overlapping the action row", async () => {
    await page.viewport(width, height);
    storeMock.current = noticeStore();
    render(
      <WebRuntimeProvider>
        <div style={{ width: "100vw", minHeight: "160px" }}>
          <Composer runSettings={<ModelControls />} notice={<ModelChangeNotice />} />
        </div>
      </WebRuntimeProvider>,
    );

    // A textual assertion alone would have passed before this bug too: the old
    // notice rendered the same copy inside the action row. The geometry below
    // is the regression coverage.
    const matches = screen.getAllByText(NOTICE_COPY);
    expect(matches).toHaveLength(1);
    const notice = matches[0] as HTMLElement;
    expect(notice).toBeVisible();
    expect(notice).toHaveAttribute("role", "status");
    expect(notice).toHaveAttribute("aria-live", "polite");
    expect(notice.closest(".composer-actions")).toBeNull();
    expect(notice.closest(".model-controls")).toBeNull();
    expect(document.querySelector(".model-change-notice")).toBeNull();
    const root = notice.closest(".composer-root");
    expect(root).not.toBeNull();

    const noticeBox = notice.getBoundingClientRect();
    const rootBox = (root as Element).getBoundingClientRect();
    const inputRow = document.querySelector(".composer-input-row");
    const actions = document.querySelector(".composer-actions");
    expect(inputRow).not.toBeNull();
    expect(actions).not.toBeNull();
    const inputBox = (inputRow as Element).getBoundingClientRect();
    const actionsBox = (actions as Element).getBoundingClientRect();
    const triggerBox = screen
      .getByRole("button", { name: "Model and reasoning effort" })
      .getBoundingClientRect();

    // The banner sits above the textarea and spans the composer's width.
    expect(noticeBox.bottom).toBeLessThanOrEqual(inputBox.top);
    expect(noticeBox.left).toBeGreaterThanOrEqual(rootBox.left);
    expect(noticeBox.right).toBeLessThanOrEqual(rootBox.right);
    expect(noticeBox.width).toBeGreaterThan(rootBox.width * 0.9);
    // It shares no pixels with the action row or the model trigger beneath it.
    const overlaps = (a: DOMRect, b: DOMRect): boolean =>
      a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    expect(overlaps(noticeBox, actionsBox)).toBe(false);
    expect(overlaps(noticeBox, triggerBox)).toBe(false);
    expect(noticeBox.bottom).toBeLessThanOrEqual(actionsBox.top);
    expect(noticeBox.bottom).toBeLessThanOrEqual(triggerBox.top);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await captureBanner(`model-change-banner-${label}`);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  document.body.style.margin = "0";
});

describe.each([
  { label: "desktop", width: 1_440, height: 900, showsKeyboardHint: true },
  { label: "mobile", width: 390, height: 844, showsKeyboardHint: false },
  { label: "narrow mobile", width: 360, height: 800, showsKeyboardHint: false },
])("single composer submission at the $label viewport", ({ label, width, height, showsKeyboardHint }) => {
  it("keeps one Send action and submits through the server-authoritative path", async () => {
    await page.viewport(width, height);
    const sendSubmission = vi.fn<SendSubmission>().mockResolvedValue(undefined);
    storeMock.current = store(sendSubmission);
    render(
      <WebRuntimeProvider>
        <div style={{ width: "100vw", minHeight: "160px" }}>
          <Composer />
        </div>
      </WebRuntimeProvider>,
    );

    expect(screen.queryByRole("button", { name: "Steer this message" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Send message" })).toHaveLength(1);
    const input = screen.getByRole("combobox", { name: "Message" });
    await userEvent.fill(input, "Use the authoritative state");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(sendSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Use the authoritative state" }),
      expect.any(Function),
    ));
    // The ⌘↵/Ctrl+↵ line is desktop-only: a phone has no such shortcut, so the
    // row is dropped there instead of spending composer height on noise.
    const keyboardHint = document.querySelector(".composer-hint-keys");
    expect(keyboardHint).not.toBeNull();
    if (showsKeyboardHint) {
      expect(keyboardHint).toBeVisible();
    } else {
      expect(keyboardHint).not.toBeVisible();
      expect(document.querySelector(".composer-hint")?.getBoundingClientRect().height ?? -1)
        .toBe(0);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await capture(`composer-${label.replace(/\s+/gu, "-")}`);
  });
});


describe.each([
  ["MacIntel", "Meta", "⌘↵"],
  ["Win32", "Control", "Ctrl+↵"],
])("fixed Enter behavior on %s", (platform, modifier, hint) => {
  it("shows the send hint, preserves newlines, sends, steers, and ignores Escape", async () => {
    await page.viewport(1440, 900);
    const platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    try {
      const send = vi.fn<SendSubmission>().mockResolvedValue(undefined);
      storeMock.current = store(send);
      render(<WebRuntimeProvider><Composer /></WebRuntimeProvider>);
      expect(screen.getByText(`${hint} to send · / commands · $ skills`)).toBeVisible();
      const input = screen.getByRole("combobox", { name: "Message" });
      await userEvent.fill(input, "first");
      await userEvent.keyboard("{Escape}");
      expect(storeMock.current.cancelTurn).not.toHaveBeenCalled();
      await userEvent.keyboard("{Enter}");
      expect(send).not.toHaveBeenCalled();
      expect(input).toHaveValue("first\n");
      await userEvent.keyboard("second");
      await userEvent.keyboard(`{${modifier}>}{Enter}{/${modifier}}`);
      await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: "first\nsecond" }), expect.any(Function)));
      send.mockClear();
      await userEvent.fill(input, "steer");
      await userEvent.keyboard(`{${modifier}>}{Shift>}{Enter}{/Shift}{/${modifier}}`);
      await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: "steer" }), expect.any(Function)));
      await userEvent.click(screen.getByRole("button", { name: "Stop response" }));
      expect(storeMock.current.cancelTurn).toHaveBeenCalledWith("user-stop");
    } finally { platformSpy.mockRestore(); }
  });
});
