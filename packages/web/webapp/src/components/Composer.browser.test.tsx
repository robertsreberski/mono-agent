import { render, screen, waitFor } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StartTurnInput } from "../types";
import { agent, thread, uploadLimits } from "../test/fixtures";
import "../styles.css";

const storeMock = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("../console-store", () => ({
  useConsoleStore: () => storeMock.current,
  useUploadLimits: () => uploadLimits,
}));
vi.mock("../api", () => ({
  api: { createUpload: vi.fn(), deleteUpload: vi.fn() },
  uploadContent: vi.fn(),
}));

import { Composer } from "./Composer";
import { WebRuntimeProvider } from "../runtime";

type SendSubmission = (
  input: StartTurnInput,
  onThreadResolved?: (threadId: string) => void,
) => Promise<void>;

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

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  document.body.style.margin = "0";
});

describe.each([
  { label: "desktop", width: 1_440, height: 900 },
  { label: "mobile", width: 390, height: 844 },
  { label: "narrow mobile", width: 360, height: 800 },
])("single composer submission at the $label viewport", ({ width, height }) => {
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
    expect(document.querySelector(".composer-hint")).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  });
});


describe.each(["send", "newline"] as const)("explicit Enter mode %s", (mode) => {
  it("shows the effective hint, preserves newlines, steers, and ignores Escape", async () => {
    await page.viewport(1440, 900);
    const { COMPOSER_ENTER_MODE_KEY, composerEnterHint, composerSteerHint } = await import("../composer-enter-mode");
    localStorage.setItem(COMPOSER_ENTER_MODE_KEY, mode);
    const send = vi.fn<SendSubmission>().mockResolvedValue(undefined);
    storeMock.current = store(send);
    render(<WebRuntimeProvider><Composer /></WebRuntimeProvider>);
    expect(screen.getByText(`${composerEnterHint(mode)} · ${composerSteerHint()} · / commands · $ skills`)).toBeVisible();
    const input = screen.getByRole("combobox", { name: "Message" });
    await userEvent.fill(input, "first");
    await userEvent.keyboard("{Escape}");
    expect(storeMock.current.cancelTurn).not.toHaveBeenCalled();
    await userEvent.keyboard(mode === "send" ? "{Shift>}{Enter}{/Shift}" : "{Enter}");
    expect(send).not.toHaveBeenCalled();
    expect(input).toHaveValue("first\n");
    await userEvent.keyboard("second");
    await userEvent.keyboard(mode === "send" ? "{Enter}" : "{Control>}{Enter}{/Control}");
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: "first\nsecond" }), expect.any(Function)));
    send.mockClear();
    await userEvent.fill(input, "steer");
    await userEvent.keyboard("{Control>}{Shift>}{Enter}{/Shift}{/Control}");
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: "steer" }), expect.any(Function)));
    await userEvent.click(screen.getByRole("button", { name: /^Enter key behavior:/ }));
    expect(screen.getByText(`${composerEnterHint(mode === "send" ? "newline" : "send")} · ${composerSteerHint()} · / commands · $ skills`)).toBeVisible();
    expect(localStorage.getItem(COMPOSER_ENTER_MODE_KEY)).toBe(mode === "send" ? "newline" : "send");
    await userEvent.click(screen.getByRole("button", { name: "Stop response" }));
    expect(storeMock.current.cancelTurn).toHaveBeenCalledWith("user-stop");
  });
});


describe.each([true, false])("default Enter with touch-primary=%s", (touchPrimary) => {
  it("inserts a newline without submitting regardless of pointer capabilities", async () => {
    const nativeMatchMedia = window.matchMedia.bind(window);
    const media = vi.spyOn(window, "matchMedia").mockImplementation((query) => {
      const result = nativeMatchMedia(query);
      if (query.includes("pointer")) Object.defineProperty(result, "matches", {
        value: query.includes("coarse") ? touchPrimary : !touchPrimary, configurable: true,
      });
      return result;
    });
    try {
      const { COMPOSER_ENTER_MODE_KEY, composerEnterHint, composerSteerHint } = await import("../composer-enter-mode");
      expect(localStorage.getItem(COMPOSER_ENTER_MODE_KEY)).toBeNull();
      const send = vi.fn<SendSubmission>().mockResolvedValue(undefined);
      storeMock.current = store(send);
      render(<WebRuntimeProvider><Composer /></WebRuntimeProvider>);
      const input = screen.getByRole("combobox", { name: "Message" });
      await userEvent.fill(input, "first");
      await userEvent.keyboard("{Enter}");
      expect(send).not.toHaveBeenCalled();
      expect(input).toHaveValue("first\n");
      expect(localStorage.getItem(COMPOSER_ENTER_MODE_KEY)).toBe("newline");
      expect(screen.getByText(`${composerEnterHint("newline")} · ${composerSteerHint()} · / commands · $ skills`)).toBeVisible();
      await userEvent.keyboard("second");
      await userEvent.keyboard("{Control>}{Enter}{/Control}");
      await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: "first\nsecond" }), expect.any(Function)));
    } finally { media.mockRestore(); }
  });
});
