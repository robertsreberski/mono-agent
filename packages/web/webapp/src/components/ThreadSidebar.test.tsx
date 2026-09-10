import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Fragment, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDataModeSetting } from "../data-mode";
import { recordDataUsage, resetDataUsage } from "../data-usage";
import { agent, thread } from "../test/fixtures";
import { SEARCH_HIGHLIGHT_CLOSE, SEARCH_HIGHLIGHT_OPEN } from "../thread-search";
import type { CronOverview, ThreadSearchHit, ThreadSummary } from "../types";

const storeMock = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const apiMock = vi.hoisted(() => ({ searchThreads: vi.fn() }));

vi.mock("../console-store", () => ({
  useConsoleStore: () => storeMock.current,
}));
vi.mock("../api", () => ({ api: apiMock }));
// Keep the real list-row rendering; only assistant-ui's runtime bindings are
// reduced to markup, so preview and activity regressions are observable here.
vi.mock("@assistant-ui/react", () => ({
  ThreadListPrimitive: {
    Root: ({ children, ...rest }: Record<string, unknown>) => <div {...rest}>{children as never}</div>,
    Items: ({ children, archived }: {
      children: (input: { threadListItem: { id: string } }) => ReactNode;
      archived: boolean;
    }) => <>{(storeMock.current?.threads as ThreadSummary[] ?? [])
      .filter((item) => Boolean(item.archivedAt) === archived)
      .map((item) => <Fragment key={item.id}>{children({ threadListItem: { id: item.id } })}</Fragment>)}</>,
    New: ({ children, ...rest }: Record<string, unknown>) => <button type="button" {...rest}>{children as never}</button>,
  },
  ThreadListItemPrimitive: {
    Root: ({ children }: Record<string, unknown>) => <div>{children as never}</div>,
    Trigger: ({ children, ...rest }: Record<string, unknown>) => <button type="button" {...rest}>{children as never}</button>,
    Title: () => null,
    Archive: () => null,
    Unarchive: () => null,
  },
  useAuiState: () => false,
}));

import { ThreadSidebar } from "./ThreadSidebar";

const hit = (id: string, overrides: Partial<ThreadSearchHit> = {}): ThreadSearchHit => ({
  thread: thread(id, "agent-one", { title: `${id} title` }),
  snippet: `we discussed ${SEARCH_HIGHLIGHT_OPEN}tailscale${SEARCH_HIGHLIGHT_CLOSE} at length`,
  messageMatches: 1,
  titleMatch: false,
  ...overrides,
});

const type = (value: string): void => {
  fireEvent.change(screen.getByPlaceholderText("Search conversations"), { target: { value } });
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  apiMock.searchThreads.mockReset();
  apiMock.searchThreads.mockResolvedValue({ hits: [hit("older")], truncated: false });
  storeMock.current = {
    selectedAgent: agent("agent-one"),
    selectedAgentId: "agent-one",
    selectedThreadId: null,
    threads: [thread("loaded", "agent-one")],
    showArchived: false,
    selectionLoading: false,
    creatingThread: false,
    selectionError: null,
    threadListError: null,
    navigationDestination: "chats",
    retryThreadList: vi.fn(),
    setNavigationDestination: vi.fn(),
    setShowArchived: vi.fn(),
    hasMoreThreads: true,
    loadMoreThreads: vi.fn().mockResolvedValue(undefined),
    selectThread: vi.fn(),
    selectCronJob: vi.fn(),
    cronOverview: null,
    cronLoading: false,
    cronError: null,
    connection: "live",
    refreshCron: vi.fn().mockResolvedValue(undefined),
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ThreadSidebar conversation rows", () => {
  it("keeps webhook conversations in Chats without showing cron channels", () => {
    storeMock.current!.threads = [
      thread("ordinary", "agent-one", { title: "Ordinary chat" }),
      thread("webhook", "agent-one", {
        title: "Webhook result",
        trigger: { kind: "webhook" },
      }),
      thread("cron", "agent-one", {
        title: "Cron history",
        trigger: { kind: "cron", jobId: "daily" },
      }),
    ];

    render(<ThreadSidebar />);

    expect(screen.getByRole("button", { name: "Open Ordinary chat" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Webhook result" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open Cron history" })).toBeNull();
    expect(screen.getByRole("button", { name: "Load older conversations" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Chats" })).toHaveAttribute("aria-current", "page");
  });

  it("turns the new-conversation action into an immediate pending indicator", () => {
    storeMock.current!.selectionLoading = true;
    storeMock.current!.creatingThread = true;

    render(<ThreadSidebar />);

    const pending = screen.getByRole("button", { name: "Creating conversation" });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(pending).toHaveAttribute("title", "Creating conversation…");
    expect(pending.querySelector(".new-thread-spinner")).not.toBeNull();
  });

  it("shows loading instead of claiming a cold agent has no conversations", () => {
    storeMock.current!.threads = [];
    storeMock.current!.selectionLoading = true;

    render(<ThreadSidebar />);

    expect(screen.getByText("Loading conversations…")).toBeVisible();
    expect(screen.queryByText("Start a conversation")).toBeNull();
    expect(screen.getByRole("button", { name: "New conversation" })).toBeDisabled();
  });

  it("shows failure instead of claiming a failed bucket has no conversations", () => {
    storeMock.current!.threads = [];
    storeMock.current!.selectionError = "bucket unavailable";

    render(<ThreadSidebar />);

    expect(screen.getByText("Conversations unavailable")).toBeVisible();
    expect(screen.queryByText("Start a conversation")).toBeNull();
    expect(screen.getByRole("button", { name: "New conversation" })).toBeDisabled();
  });

  it("keeps a usable conversation available while offering an exact listing retry", () => {
    storeMock.current!.threadListError = "beta conversations unavailable";

    render(<ThreadSidebar />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Conversations could not be refreshed. beta conversations unavailable",
    );
    expect(screen.getByRole("button", { name: "New conversation" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry conversations" }));
    expect(storeMock.current!.retryThreadList).toHaveBeenCalledTimes(1);
  });

  it.each([
    { archived: false, emptyCopy: "Start a conversation" },
    { archived: true, emptyCopy: "No archived conversations" },
  ])("does not call an empty $emptyCopy shelf authoritative while its listing failed", ({
    archived,
    emptyCopy,
  }) => {
    storeMock.current!.threads = [];
    storeMock.current!.showArchived = archived;
    storeMock.current!.hasMoreThreads = false;
    storeMock.current!.threadListError = "listing unavailable";

    const { rerender } = render(<ThreadSidebar />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Conversations could not be refreshed. listing unavailable",
    );
    expect(screen.getByText("Conversations unavailable")).toBeVisible();
    expect(screen.queryByText(emptyCopy)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry conversations" }));
    expect(storeMock.current!.retryThreadList).toHaveBeenCalledTimes(1);
    storeMock.current!.threadListError = null;
    rerender(<ThreadSidebar />);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Conversations unavailable")).toBeNull();
    expect(screen.getByText(emptyCopy)).toBeVisible();
  });

  it("renders active jobs on an unselected conversation and clears activity at completion", () => {
    const running = thread("worker", "agent-one", {
      title: "Background work",
      messageCount: 5,
      lastMessagePreview: "Older reply",
      runState: { status: "complete" },
      jobActivity: { queued: 0, starting: 0, running: 2 },
    });
    storeMock.current!.threads = [running];
    const { rerender } = render(<ThreadSidebar />);
    const row = screen.getByRole("button", { name: "Open Background work" });
    expect(row).toHaveTextContent("2 background jobs running");
    expect(within(row).getByRole("img", { name: "2 background jobs running" })).toBeVisible();
    expect(row).not.toHaveTextContent("Older reply");
    expect(row).not.toHaveTextContent("5 messages");

    storeMock.current!.threads = [{
      ...running,
      jobActivity: { queued: 0, starting: 0, running: 0, latestTerminal: {
        state: "succeeded", completedAt: "2026-09-07T10:00:00.000Z", replyPreview: "Results are ready",
      } },
    }];
    rerender(<ThreadSidebar />);
    expect(row).toHaveTextContent("Results are ready");
    expect(within(row).queryByRole("img")).toBeNull();
  });

  it("shows cancellation status in archived conversations", () => {
    storeMock.current!.showArchived = true;
    storeMock.current!.threads = [thread("cancelled", "agent-one", {
      archivedAt: "2026-09-07T10:00:00.000Z",
      runState: { status: "cancelled" },
      lastMessagePreview: "Previous reply",
      messageCount: 4,
    })];
    render(<ThreadSidebar />);
    const row = screen.getByRole("button", { name: "Open cancelled" });
    expect(row).toHaveTextContent("Cancelled");
    expect(row).not.toHaveTextContent("Previous reply");
    expect(within(row).queryByRole("img")).toBeNull();
  });
});

describe("ThreadSidebar Automations destination", () => {
  const overview: CronOverview = {
    generatedAt: "2026-09-10T08:00:00.000Z",
    actionsEnabled: false,
    jobs: [{
      jobId: "daily:brief",
      expression: "0 8 * * *",
      timezone: "Europe/Budapest",
      conversationId: "cron:daily:brief",
      configured: true,
      declaredEnabled: true,
      effectiveEnabled: true,
      nextRunAt: "2026-09-11T06:00:00.000Z",
      health: "healthy",
      threadId: "cron-daily",
    }],
  };

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-10T10:00:00.000Z"));
    storeMock.current!.navigationDestination = "automations";
    storeMock.current!.selectedAgent = agent("agent-one", {
      cron: { read: true, actions: false },
    });
    storeMock.current!.cronOverview = overview;
  });

  it("shows each configured overview job once before its first run and opens durable history", () => {
    render(<ThreadSidebar />);

    const rows = screen.getAllByRole("button", { name: "Open run history for daily:brief" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toHaveTextContent("Every day at 08:00 (Europe/Budapest)");
    expect(rows[0]!).toHaveTextContent("Enabled");
    expect(rows[0]!).toHaveTextContent("No runs yet");
    expect(rows[0]!).toHaveTextContent("Next");
    expect(screen.queryByPlaceholderText("Search conversations")).toBeNull();
    expect(screen.queryByRole("button", { name: "Load older conversations" })).toBeNull();

    fireEvent.click(rows[0]!);
    expect(storeMock.current!.selectCronJob).toHaveBeenCalledWith(
      "agent-one",
      "daily:brief",
      "cron-daily",
    );
  });

  it("keeps snapshot and truncation limits visible without advertising a next run", () => {
    storeMock.current!.connection = "offline";
    storeMock.current!.selectedAgent = agent("agent-one", {
      status: "offline",
    });
    storeMock.current!.cronOverview = { ...overview, jobsTruncated: true };

    render(<ThreadSidebar />);

    expect(screen.getByRole("status")).toHaveTextContent("saved snapshot");
    expect(screen.getByRole("note")).toHaveTextContent("removed historical jobs may not be shown");
    const row = screen.getByRole("button", { name: "Open run history for daily:brief" });
    expect(row).toHaveTextContent("Enabled in snapshot");
    expect(row).toHaveTextContent("Next run unavailable");
    expect(row.querySelector("time")).toBeNull();
  });

  it("keeps an already loaded automation list stable during a background refresh", () => {
    storeMock.current!.cronLoading = true;
    render(<ThreadSidebar />);

    expect(screen.getByRole("button", { name: "Open run history for daily:brief" })).toBeVisible();
    expect(screen.queryByText(/Refreshing automation status/iu)).toBeNull();
    expect(screen.queryByText(/Loading automations/iu)).toBeNull();
  });

  it.each([
    {
      name: "loading",
      overrides: { cronOverview: null, cronLoading: true, cronError: null },
      copy: "Loading automations…",
    },
    {
      name: "unsupported",
      overrides: {
        selectedAgent: agent("agent-one"),
        cronOverview: null,
        cronLoading: false,
        cronError: "unsupported",
      },
      copy: "Automations not supported",
    },
    {
      name: "empty",
      overrides: { cronOverview: { ...overview, jobs: [] }, cronLoading: false, cronError: null },
      copy: "No automations configured",
    },
  ])("distinguishes the $name state", ({ overrides, copy }) => {
    Object.assign(storeMock.current!, overrides);
    render(<ThreadSidebar />);
    expect(screen.getByText(copy)).toBeVisible();
  });
});

describe("ThreadSidebar search", () => {
  it("leaves the conversation list alone until the query is worth running", async () => {
    render(<ThreadSidebar />);

    type("t");
    await vi.advanceTimersByTimeAsync(500);

    expect(apiMock.searchThreads).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Load older conversations" })).toBeVisible();
  });

  it("searches the server and renders highlighted snippets from outside the loaded page", async () => {
    render(<ThreadSidebar />);

    type("tailscale");
    await vi.advanceTimersByTimeAsync(500);

    await waitFor(() => {
      expect(apiMock.searchThreads).toHaveBeenCalledWith("agent-one", "tailscale", expect.anything());
    });
    const row = await screen.findByRole("button", { name: "Open older title" });
    // The sentinels never reach the page as text; they become a <mark>.
    expect(within(row).getByText("tailscale").tagName).toBe("MARK");
    expect(row).toHaveTextContent("we discussed tailscale at length");
    expect(screen.queryByText(SEARCH_HIGHLIGHT_OPEN)).toBeNull();
    // Paging belongs to the list, not to a result set the server already ranked.
    expect(screen.queryByRole("button", { name: "Load older conversations" })).toBeNull();
  });

  it("debounces to one request per settled query", async () => {
    render(<ThreadSidebar />);

    type("tai");
    await vi.advanceTimersByTimeAsync(50);
    type("tails");
    await vi.advanceTimersByTimeAsync(50);
    type("tailscale");
    await vi.advanceTimersByTimeAsync(500);

    await waitFor(() => { expect(apiMock.searchThreads).toHaveBeenCalledTimes(1); });
    expect(apiMock.searchThreads).toHaveBeenCalledWith("agent-one", "tailscale", expect.anything());
  });

  it("opens a hit through the store, which can fetch a thread the sidebar never loaded", async () => {
    render(<ThreadSidebar />);

    type("tailscale");
    await vi.advanceTimersByTimeAsync(500);
    fireEvent.click(await screen.findByRole("button", { name: "Open older title" }));

    expect(storeMock.current?.selectThread).toHaveBeenCalledWith("older");
  });

  it("groups archived matches separately instead of hiding them", async () => {
    apiMock.searchThreads.mockResolvedValue({
      hits: [
        hit("live"),
        hit("filed", {
          thread: thread("filed", "agent-one", {
            title: "filed title",
            archivedAt: "2026-07-01T10:00:00.000Z",
          }),
        }),
      ],
      truncated: false,
    });
    render(<ThreadSidebar />);

    type("tailscale");
    await vi.advanceTimersByTimeAsync(500);

    expect(await screen.findByText("Conversations")).toBeVisible();
    // Scoped by heading: the archive toggle at the foot of the sidebar carries
    // the same word.
    const archived = screen
      .getByRole("heading", { name: "Archived" })
      .closest("section") as HTMLElement;
    expect(within(archived).getByRole("button", { name: "Open filed title" })).toBeVisible();
    expect(within(archived).queryByRole("button", { name: "Open live title" })).toBeNull();
  });

  it("highlights a title-only match and says so when no message matched", async () => {
    apiMock.searchThreads.mockResolvedValue({
      hits: [{
        thread: thread("named", "agent-one", { title: "Quarterly planning" }),
        messageMatches: 0,
        titleMatch: true,
      }],
      truncated: false,
    });
    render(<ThreadSidebar />);

    type("quarterly");
    await vi.advanceTimersByTimeAsync(500);

    const row = await screen.findByRole("button", { name: "Open Quarterly planning" });
    expect(within(row).getByText("Quarterly", { exact: false }).tagName).toBe("MARK");
    expect(row).toHaveTextContent("Matched the title");
  });

  it("reports how many messages matched when more than one did", async () => {
    apiMock.searchThreads.mockResolvedValue({
      hits: [hit("many", { messageMatches: 9 }), hit("once", { messageMatches: 1 })],
      truncated: false,
    });
    render(<ThreadSidebar />);

    type("tailscale");
    await vi.advanceTimersByTimeAsync(500);

    expect(await screen.findByRole("button", { name: "Open many title" }))
      .toHaveTextContent("9 matches");
    // A single match needs no count; the snippet already shows it.
    expect(screen.getByRole("button", { name: "Open once title" }))
      .not.toHaveTextContent("matches");
  });

  it("says so when nothing matched, and when the search itself failed", async () => {
    apiMock.searchThreads.mockResolvedValue({ hits: [], truncated: false });
    const { unmount } = render(<ThreadSidebar />);
    type("nothing");
    await vi.advanceTimersByTimeAsync(500);
    expect(await screen.findByText("No matching conversations")).toBeVisible();
    unmount();

    apiMock.searchThreads.mockRejectedValue(new Error("offline"));
    render(<ThreadSidebar />);
    type("nothing");
    await vi.advanceTimersByTimeAsync(500);
    expect(await screen.findByRole("alert")).toHaveTextContent("Search is unavailable right now");
  });

  it("warns that a truncated result set is only the closest matches", async () => {
    apiMock.searchThreads.mockResolvedValue({ hits: [hit("older")], truncated: true });
    render(<ThreadSidebar />);

    type("tailscale");
    await vi.advanceTimersByTimeAsync(500);

    expect(await screen.findByText(/Showing the closest matches/u)).toBeVisible();
  });

  it("restores the conversation list when the query is cleared", async () => {
    render(<ThreadSidebar />);
    type("tailscale");
    await vi.advanceTimersByTimeAsync(500);
    await screen.findByRole("button", { name: "Open older title" });

    type("");
    await vi.advanceTimersByTimeAsync(500);

    expect(screen.queryByRole("button", { name: "Open older title" })).toBeNull();
    expect(screen.getByRole("button", { name: "Load older conversations" })).toBeVisible();
  });
});

describe("the sidebar's data-mode footer", () => {
  afterEach(() => {
    resetDataUsage();
    localStorage.clear();
  });

  it("shows what the session has cost, and cycles the mode when tapped", () => {
    // Auto cannot read the network in jsdom, exactly as it cannot on iOS, so it
    // says so: Auto, resolving to Full. The number next to it is what makes the
    // choice actionable.
    recordDataUsage(3 * 1024);
    render(<ThreadSidebar />);

    // Nothing installed a resource observer here, so the console is adding up
    // body lengths -- and says so rather than presenting a guess as a reading.
    const control = screen.getByRole("button", { name: /^Data Auto · Full, an estimated 3 KiB this session/u });
    expect(control).toHaveTextContent("Auto · Full");
    expect(control).toHaveTextContent("~3 KiB");

    fireEvent.click(control);
    expect(readDataModeSetting()).toBe("lean");
    expect(screen.getByRole("button", { name: /^Data Lean/u })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /^Data Lean/u }));
    expect(readDataModeSetting()).toBe("full");
    fireEvent.click(screen.getByRole("button", { name: /^Data Full/u }));
    expect(readDataModeSetting()).toBe("auto");
  });

  it("says the per-minute rate out loud, not only on screen", () => {
    // The rate is the half of this control that answers "is the link expensive
    // right now", which is the question the mode exists for -- and it was
    // painted and never spoken, so a screen reader got the session total and
    // nothing about the minute the operator is deciding in.
    vi.setSystemTime(new Date("2026-09-06T10:00:00.000Z"));
    resetDataUsage();
    vi.setSystemTime(new Date("2026-09-06T10:02:00.000Z"));
    recordDataUsage(2 * 1024);
    render(<ThreadSidebar />);

    const control = screen.getByRole("button", { name: /this session/u });
    expect(control).toHaveTextContent("2 KiB/min");
    expect(control.getAttribute("aria-label"))
      .toContain("about 2 KiB in the last minute");
  });
});
