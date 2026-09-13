import { render, screen, waitFor } from "@testing-library/react";
import { page, userEvent } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const onlineAgent = agent("agent");
const first = thread("thread-one", "agent");
const second = thread("thread-two", "agent");

/**
 * Screenshot evidence is opt-in: `VITE_COMPOSER_DRAFT_SHOTS=<absolute dir>`
 * captures the restored composer, and CI runs the same assertions without it.
 */
const shotDirectory = import.meta.env.VITE_COMPOSER_DRAFT_SHOTS as string | undefined;

const capture = async (name: string): Promise<void> => {
  if (shotDirectory === undefined || shotDirectory.length === 0) return;
  await page.screenshot({ path: `${shotDirectory}/${name}.png` });
};

function store(selectedThread: ReturnType<typeof thread>): Record<string, unknown> {
  return {
    bootstrap: null,
    agents: [onlineAgent],
    threads: [first, second],
    visibleThreads: [first, second],
    selectedAgent: onlineAgent,
    selectedThread,
    detail: null,
    selectedAgentId: onlineAgent.sourceId,
    selectedThreadId: selectedThread.id,
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
    sendSubmission: vi.fn().mockResolvedValue(undefined),
    sendLiveInput: vi.fn(),
    cancelTurn: vi.fn(),
    setShowArchived: vi.fn(),
    setModel: vi.fn(),
    setEffort: vi.fn(),
    retry: vi.fn(),
    clearActionError: vi.fn(),
  };
}

/**
 * A fresh module graph reading the same device storage is what the operator gets
 * when the app was closed, evicted by the system, or reloaded by a new build.
 */
const reopenApp = async () => {
  vi.resetModules();
  const [{ Composer }, { WebRuntimeProvider }] = await Promise.all([
    import("./Composer"),
    import("../runtime"),
  ]);
  return { Composer, WebRuntimeProvider };
};

const composerInput = (): HTMLTextAreaElement =>
  screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  document.body.style.margin = "0";
});

afterEach(async () => {
  const { resetComposerDraft } = await import("../composer-draft");
  resetComposerDraft();
  localStorage.clear();
});

describe.each([
  { label: "desktop", width: 1_440, height: 900 },
  { label: "mobile", width: 390, height: 844 },
])("unsent composer text at the $label viewport", ({ label, width, height }) => {
  it("comes back after the app is closed and reopened", async () => {
    await page.viewport(width, height);
    storeMock.current = store(first);
    const opened = await reopenApp();
    const view = render(
      <opened.WebRuntimeProvider>
        <div style={{ width: "100vw", minHeight: "160px" }}>
          <opened.Composer />
        </div>
      </opened.WebRuntimeProvider>,
    );

    await userEvent.fill(composerInput(), "Draft I did not send before closing the app");
    // The app going to the background is the only warning a phone gives.
    window.dispatchEvent(new Event("pagehide"));
    view.unmount();

    const reopened = await reopenApp();
    render(
      <reopened.WebRuntimeProvider>
        <div style={{ width: "100vw", minHeight: "160px" }}>
          <reopened.Composer />
        </div>
      </reopened.WebRuntimeProvider>,
    );

    await waitFor(() => expect(composerInput().value)
      .toBe("Draft I did not send before closing the app"));
    await capture(`restored-after-reopen-${label}`);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  });

  it("keeps each conversation's own text while switching between them", async () => {
    await page.viewport(width, height);
    storeMock.current = store(first);
    const opened = await reopenApp();
    const view = render(
      <opened.WebRuntimeProvider>
        <div style={{ width: "100vw", minHeight: "160px" }}>
          <opened.Composer />
        </div>
      </opened.WebRuntimeProvider>,
    );

    await userEvent.fill(composerInput(), "First conversation draft");
    storeMock.current = store(second);
    view.rerender(
      <opened.WebRuntimeProvider>
        <div style={{ width: "100vw", minHeight: "160px" }}>
          <opened.Composer />
        </div>
      </opened.WebRuntimeProvider>,
    );
    await waitFor(() => expect(composerInput().value).toBe(""));
    await userEvent.fill(composerInput(), "Second conversation draft");

    storeMock.current = store(first);
    view.rerender(
      <opened.WebRuntimeProvider>
        <div style={{ width: "100vw", minHeight: "160px" }}>
          <opened.Composer />
        </div>
      </opened.WebRuntimeProvider>,
    );

    await waitFor(() => expect(composerInput().value).toBe("First conversation draft"));
    await capture(`restored-after-switch-${label}`);
  });
});
