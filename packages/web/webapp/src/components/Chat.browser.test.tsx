import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { userEvent } from "@vitest/browser/context";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { WebRuntimeProvider } from "../runtime";
import { agent, processJob, thread } from "../test/fixtures";
import type { ProcessJobProjection, ThreadDetail, ThreadSummary, WebMessage } from "../types";
import "../styles.css";

const storeMock = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const layoutMock = vi.hoisted(() => ({ messageHeight: 96, composerHeight: 90 }));

vi.mock("../console-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../console-store")>();
  return {
    ...actual,
    useConsoleStore: () => storeMock.current,
    useUploadLimits: () => ({
      maxFileBytes: 20,
      maxFilesPerTurn: 10,
      maxTurnBytes: 100,
      accept: ["image/png"],
    }),
  };
});

vi.mock("../notifications", () => ({
  NotificationBell: () => null,
}));
vi.mock("./CronChannelHeader", () => ({
  CronChannelHeader: () => null,
}));
vi.mock("./assistant-ui/Quote", () => ({
  SelectionToolbar: () => null,
}));
vi.mock("./Composer", () => ({
  Composer: () => (
    <div data-testid="thread-composer" style={{ height: layoutMock.composerHeight }} />
  ),
}));
vi.mock("./Messages", () => ({
  AskReconciliationProvider: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  AssistantMessage: () => (
    <div data-testid="thread-message" style={{ height: layoutMock.messageHeight }} />
  ),
  SystemMessage: () => (
    <div data-testid="thread-message" style={{ height: layoutMock.messageHeight }} />
  ),
  UserMessage: () => (
    <div data-testid="thread-message" style={{ height: layoutMock.messageHeight }} />
  ),
}));

import { Chat } from "./Chat";

const chatMessage = (id: string, threadId: string): WebMessage => ({
  id,
  threadId,
  role: "assistant",
  parts: [{ type: "text", text: id }],
  attachments: [],
  createdAt: "2026-07-17T10:00:00.000Z",
  updatedAt: "2026-07-17T10:00:00.000Z",
  finishedAt: "2026-07-17T10:00:00.000Z",
  status: "complete",
});

const chatDetail = (selectedThread: ThreadSummary, ids: readonly string[]): ThreadDetail => ({
  thread: selectedThread,
  messages: ids.map((id) => chatMessage(`${selectedThread.id}-${id}`, selectedThread.id)),
});

const messageIds = (count: number, offset = 0): string[] =>
  Array.from({ length: count }, (_, index) => `message-${index + offset}`);

const chatStore = (
  selectedThread: ThreadSummary,
  detail: ThreadDetail | null,
  detailLoading = false,
) => {
  const selectedAgent = agent("agent", { supportsAttachments: false });
  return {
    bootstrap: null,
    agents: [selectedAgent],
    threads: [selectedThread],
    visibleThreads: [selectedThread],
    selectedAgent,
    selectedThread,
    detail,
    selectedAgentId: selectedAgent.sourceId,
    selectedThreadId: selectedThread.id,
    loading: false,
    detailLoading,
    connection: "live" as const,
    model: "",
    effort: "",
    createThread: vi.fn(),
    selectThread: vi.fn(),
    renameThread: vi.fn(),
    archiveThread: vi.fn().mockResolvedValue(undefined),
    unarchiveThread: vi.fn().mockResolvedValue(undefined),
    deleteThread: vi.fn().mockResolvedValue(undefined),
    hasOlderMessages: false,
    loadOlderMessages: vi.fn().mockResolvedValue(undefined),
    sendTurn: vi.fn().mockResolvedValue(undefined),
    sendLiveInput: vi.fn().mockResolvedValue(undefined),
    cancelTurn: vi.fn(),
    loadFullToolCall: vi.fn().mockResolvedValue(false),
  };
};

const chatTree = (width = 760) => (
  <div style={{ width, height: 520 }}>
    <WebRuntimeProvider>
      <Chat onOpenAgents={() => undefined} onOpenThreads={() => undefined} />
    </WebRuntimeProvider>
  </div>
);

const getViewport = (container: HTMLElement): HTMLElement => {
  const viewport = container.querySelector<HTMLElement>(".thread-viewport");
  if (!viewport) throw new Error("Expected a thread viewport");
  return viewport;
};

const getMessageColumn = (container: ParentNode): HTMLElement => {
  const column = container.querySelector<HTMLElement>(".message-column");
  if (!column) throw new Error("Expected a message column");
  return column;
};

const getFooter = (container: ParentNode): HTMLElement => {
  const footer = container.querySelector<HTMLElement>(".thread-footer");
  if (!footer) throw new Error("Expected a thread footer");
  return footer;
};

const gapFromBottom = (viewport: HTMLElement): number =>
  viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;

const waitForFrames = async (count = 2): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
};

const waitForScrollToSettle = async (viewport: HTMLElement): Promise<void> => {
  let previous = viewport.scrollTop;
  let stableFrames = 0;
  for (let index = 0; index < 30; index += 1) {
    await waitForFrames(1);
    const current = viewport.scrollTop;
    stableFrames = Math.abs(current - previous) <= 0.5 ? stableFrames + 1 : 0;
    if (stableFrames >= 3) return;
    previous = current;
  }
  throw new Error("The viewport did not settle after the operator scroll");
};

const waitForMessages = async (container: HTMLElement, count: number): Promise<void> => {
  await waitFor(() => {
    expect(container.querySelectorAll("[data-testid='thread-message']")).toHaveLength(count);
  });
};

const waitForBottom = async (viewport: HTMLElement): Promise<void> => {
  await waitFor(() => expect(Math.abs(gapFromBottom(viewport))).toBeLessThanOrEqual(1));
};

beforeEach(() => {
  layoutMock.messageHeight = 96;
  layoutMock.composerHeight = 90;
  document.documentElement.style.height = "100%";
  document.body.style.height = "100%";
  document.body.style.margin = "0";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Chat conversation viewport in Chromium", () => {
  it("follows stack disclosure at bottom and preserves an operator reading above", async () => {
    const selectedThread = thread("thread-a", "agent", { trigger: { kind: "cron" } });
    const base = chatDetail(selectedThread, messageIds(18));
    const terminal = processJob({
      jobId: "terminal-job",
      origin: {
        ...processJob().origin,
        conversationId: `web:${selectedThread.id}`,
        historyBoundary: `web:${selectedThread.id}`,
      },
    });
    const running = processJob({
      jobId: "running-job",
      state: "running",
      origin: terminal.origin,
      timestamps: { ...terminal.timestamps, completedAt: null },
      output: { ...terminal.output, stdoutBytes: 0, preview: "", stdoutRef: null, stderrRef: null },
      wake: { ...terminal.wake, state: "pending", attempts: 0, lastAttemptAt: null },
      exitCode: null,
      durationMs: null,
    });
    vi.spyOn(api, "threadJob").mockImplementation(() => new Promise(() => undefined));
    const detail: ThreadDetail = {
      ...base,
      messages: [...base.messages, {
        ...chatMessage("job-only", selectedThread.id),
        parts: [
          { type: "process-job", job: running },
          { type: "process-job", job: terminal },
        ],
      }],
    };
    storeMock.current = chatStore(selectedThread, detail);

    const { container } = render(chatTree());
    await waitForMessages(container, 18);
    const viewport = getViewport(container);
    await waitForBottom(viewport);
    const toggle = container.querySelector<HTMLButtonElement>(".process-job-stack-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".process-job-stack-item:not([hidden]) .is-running")).not.toBeNull();
    expect(container.querySelector(".process-job-stack-item[hidden] .is-complete")).not.toBeNull();

    toggle.focus();
    await userEvent.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".process-job-stack-item[hidden]")).toBeNull();
    await waitForFrames(3);
    expect(Math.abs(gapFromBottom(viewport))).toBeLessThanOrEqual(1);

    viewport.tabIndex = 0;
    await userEvent.click(viewport);
    await userEvent.keyboard("{PageUp}");
    await waitFor(() => expect(gapFromBottom(viewport)).toBeGreaterThan(1));
    await waitForScrollToSettle(viewport);
    const readingTop = viewport.scrollTop;

    fireEvent.click(toggle);
    await waitForFrames(3);
    expect(viewport.scrollTop).toBe(readingTop);
    fireEvent.click(toggle);
    await waitForFrames(3);
    expect(viewport.scrollTop).toBe(readingTop);
  });

  it("keeps the expanded stack inside a 360px conversation column", async () => {
    const selectedThread = thread("thread-a", "agent", { trigger: { kind: "cron" } });
    const job = processJob({
      summary: "a deliberately long command summary that must not widen the mobile conversation",
      origin: {
        ...processJob().origin,
        conversationId: `web:${selectedThread.id}`,
        historyBoundary: `web:${selectedThread.id}`,
      },
    });
    const detail: ThreadDetail = {
      thread: selectedThread,
      messages: [{
        ...chatMessage("job-only", selectedThread.id),
        parts: [
          { type: "process-job", job },
          {
            type: "process-job",
            job: {
              ...job,
              jobId: "running-job",
              state: "running",
              timestamps: { ...job.timestamps, completedAt: null },
              output: { ...job.output, stdoutBytes: 0, preview: "", stdoutRef: null, stderrRef: null },
              wake: { ...job.wake, state: "pending", attempts: 0, lastAttemptAt: null },
              exitCode: null,
              durationMs: null,
            },
          },
        ],
      }],
    };
    vi.spyOn(api, "threadJob").mockImplementation(() => new Promise(() => undefined));
    storeMock.current = chatStore(selectedThread, detail);

    const { container } = render(chatTree(360));
    await waitFor(() => expect(container.querySelector(".process-job-stack")).not.toBeNull());
    const toggle = container.querySelector<HTMLButtonElement>(".process-job-stack-toggle")!;
    toggle.focus();
    await userEvent.keyboard("{Space}");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const column = getMessageColumn(container);
    const stack = container.querySelector<HTMLElement>(".process-job-stack")!;
    await waitForFrames(2);

    expect(stack.getBoundingClientRect().left).toBeGreaterThanOrEqual(column.getBoundingClientRect().left);
    expect(stack.getBoundingClientRect().right).toBeLessThanOrEqual(column.getBoundingClientRect().right);
    expect(getViewport(container).scrollWidth).toBeLessThanOrEqual(getViewport(container).clientWidth);
  });

  it("hides a newly terminal card by the first browser frame", async () => {
    const selectedThread = thread("thread-a", "agent");
    const complete = processJob({
      jobId: "live-job",
      origin: {
        ...processJob().origin,
        conversationId: `web:${selectedThread.id}`,
        historyBoundary: `web:${selectedThread.id}`,
      },
    });
    const running: ProcessJobProjection = {
      ...complete,
      state: "running",
      timestamps: { ...complete.timestamps, completedAt: null },
      output: { ...complete.output, stdoutBytes: 0, preview: "", stdoutRef: null, stderrRef: null },
      wake: { ...complete.wake, state: "pending", attempts: 0, lastAttemptAt: null },
      exitCode: null,
      durationMs: null,
    };
    let finish!: (job: ProcessJobProjection) => void;
    vi.spyOn(api, "threadJob").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    storeMock.current = chatStore(selectedThread, {
      thread: selectedThread,
      messages: [{
        ...chatMessage("job-only", selectedThread.id),
        parts: [{ type: "process-job", job: running }],
      }],
    });

    const { container } = render(chatTree());
    await waitFor(() => expect(api.threadJob).toHaveBeenCalledOnce());
    const item = container.querySelector<HTMLElement>(".process-job-stack-item")!;
    const row = item.querySelector<HTMLElement>(".activity-row.is-job")!;
    expect(item).not.toHaveAttribute("hidden");

    await act(async () => { finish(complete); });
    await new Promise<void>((resolve, reject) => {
      requestAnimationFrame(() => {
        try {
          expect(item).toHaveAttribute("hidden");
          expect(item.querySelector(".activity-row.is-job")).toBe(row);
          expect(row).toHaveClass("is-complete");
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  });

  it("pins a short ordinary conversation's composer footer to the viewport bottom", async () => {
    const selectedThread = thread("thread-a", "agent");
    storeMock.current = chatStore(selectedThread, chatDetail(selectedThread, messageIds(1)));

    const { container } = render(chatTree());
    await waitForMessages(container, 1);
    const viewport = getViewport(container);
    const footer = getFooter(container);

    await waitFor(() => {
      expect(Math.abs(viewport.getBoundingClientRect().bottom - footer.getBoundingClientRect().bottom))
        .toBeLessThanOrEqual(1);
    });
  });

  it("follows a staged detail commit after the replacement viewport initialized empty", async () => {
    const firstThread = thread("thread-a", "agent", { trigger: { kind: "cron" } });
    const secondThread = thread("thread-b", "agent", { trigger: { kind: "cron" } });
    storeMock.current = chatStore(firstThread, chatDetail(firstThread, messageIds(18)));

    const { container, rerender } = render(chatTree());
    await waitForMessages(container, 18);
    const firstViewport = getViewport(container);
    await waitForBottom(firstViewport);

    storeMock.current = chatStore(secondThread, null, true);
    rerender(chatTree());
    const secondViewport = getViewport(container);
    expect(secondViewport).not.toBe(firstViewport);
    await waitForMessages(container, 0);
    await waitForFrames();

    layoutMock.messageHeight = 0;
    storeMock.current = chatStore(secondThread, chatDetail(secondThread, messageIds(24)));
    rerender(chatTree());
    await waitForMessages(container, 24);
    expect(container.querySelector<HTMLElement>("[data-testid='thread-message']")?.offsetHeight).toBe(0);
    await waitForFrames();

    layoutMock.messageHeight = 96;
    for (const message of container.querySelectorAll<HTMLElement>("[data-testid='thread-message']")) {
      message.style.height = `${layoutMock.messageHeight}px`;
    }
    await waitForFrames(3);

    expect(Math.abs(gapFromBottom(secondViewport))).toBeLessThanOrEqual(1);
  });

  it("bottoms a cached transcript in the same render that changes the selection", async () => {
    const firstThread = thread("thread-a", "agent", { trigger: { kind: "cron" } });
    const secondThread = thread("thread-b", "agent", { trigger: { kind: "cron" } });
    storeMock.current = chatStore(firstThread, chatDetail(firstThread, messageIds(18)));

    const { container, rerender } = render(chatTree());
    await waitForMessages(container, 18);
    const firstViewport = getViewport(container);
    await waitForBottom(firstViewport);

    storeMock.current = chatStore(secondThread, chatDetail(secondThread, messageIds(24)));
    rerender(chatTree());
    await waitForMessages(container, 24);
    const secondViewport = getViewport(container);

    expect(secondViewport).not.toBe(firstViewport);
    await waitForBottom(secondViewport);
  });

  it("follows intrinsic growth of an already-mounted descendant while at bottom", async () => {
    const selectedThread = thread("thread-a", "agent", { trigger: { kind: "cron" } });
    storeMock.current = chatStore(selectedThread, chatDetail(selectedThread, messageIds(18)));

    const { container } = render(chatTree());
    await waitForMessages(container, 18);
    const viewport = getViewport(container);
    await waitForBottom(viewport);

    const lastMessage = container.querySelectorAll<HTMLElement>("[data-testid='thread-message']").item(17);
    lastMessage.style.height = "696px";
    await waitForFrames(3);

    expect(Math.abs(gapFromBottom(viewport))).toBeLessThanOrEqual(1);
  });

  it("preserves an upward position, then resumes following after returning to bottom", async () => {
    const selectedThread = thread("thread-a", "agent", { trigger: { kind: "cron" } });
    storeMock.current = chatStore(selectedThread, chatDetail(selectedThread, messageIds(18)));

    const { container } = render(chatTree());
    await waitForMessages(container, 18);
    const viewport = getViewport(container);
    await waitForBottom(viewport);

    viewport.tabIndex = 0;
    await userEvent.click(viewport);
    await userEvent.keyboard("{PageUp}");
    await waitFor(() => expect(gapFromBottom(viewport)).toBeGreaterThan(1));
    await waitForScrollToSettle(viewport);
    const scrolledUpTop = viewport.scrollTop;

    const messages = container.querySelectorAll<HTMLElement>("[data-testid='thread-message']");
    messages.item(17).style.height = "696px";
    await waitForFrames(3);

    expect(viewport.scrollTop).toBe(scrolledUpTop);
    expect(gapFromBottom(viewport)).toBeGreaterThan(1);

    viewport.scrollTop = viewport.scrollHeight;
    fireEvent.scroll(viewport);
    await waitForFrames();
    messages.item(16).style.height = "496px";
    await waitForFrames(3);

    expect(Math.abs(gapFromBottom(viewport))).toBeLessThanOrEqual(1);
  });

  it("cancels staged work when a newer conversation wins a rapid switch", async () => {
    const firstThread = thread("thread-a", "agent", { trigger: { kind: "cron" } });
    const secondThread = thread("thread-b", "agent", { trigger: { kind: "cron" } });
    const thirdThread = thread("thread-c", "agent", { trigger: { kind: "cron" } });
    storeMock.current = chatStore(firstThread, chatDetail(firstThread, messageIds(18)));

    const { container, rerender } = render(chatTree());
    await waitForMessages(container, 18);
    await waitForBottom(getViewport(container));

    storeMock.current = chatStore(secondThread, null, true);
    rerender(chatTree());
    const secondViewport = getViewport(container);
    const secondColumn = getMessageColumn(container);

    storeMock.current = chatStore(thirdThread, chatDetail(thirdThread, messageIds(24)));
    rerender(chatTree());
    const thirdViewport = getViewport(container);
    secondColumn.style.height = "1200px";
    await waitForMessages(container, 24);
    await waitForFrames(3);

    expect(thirdViewport).not.toBe(secondViewport);
    expect(secondViewport.isConnected).toBe(false);
    expect(Math.abs(gapFromBottom(thirdViewport))).toBeLessThanOrEqual(1);
  });

  it("does not force an older-message prepend to bottom while the operator is up", async () => {
    const selectedThread = thread("thread-a", "agent", { trigger: { kind: "cron" } });
    const recentIds = messageIds(18, 12);
    storeMock.current = chatStore(selectedThread, chatDetail(selectedThread, recentIds));

    const { container, rerender } = render(chatTree());
    await waitForMessages(container, 18);
    const viewport = getViewport(container);
    await waitForBottom(viewport);

    viewport.tabIndex = 0;
    await userEvent.click(viewport);
    await userEvent.keyboard("{PageUp}");
    await waitFor(() => expect(gapFromBottom(viewport)).toBeGreaterThan(1));
    await waitForScrollToSettle(viewport);

    storeMock.current = chatStore(
      selectedThread,
      chatDetail(selectedThread, [...messageIds(12), ...recentIds]),
    );
    rerender(chatTree());
    await waitForMessages(container, 30);
    await waitForFrames(3);

    expect(gapFromBottom(viewport)).toBeGreaterThan(1);
  });
});
