import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { Fragment, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent, thread } from "../../test/fixtures";
import { SEARCH_HIGHLIGHT_CLOSE, SEARCH_HIGHLIGHT_OPEN } from "../../thread-search";
import type { CronOverview, ThreadSearchHit, ThreadSummary } from "../../types";

const storeMock = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const apiMock = vi.hoisted(() => ({ searchThreads: vi.fn() }));

vi.mock("../../console-store", () => ({
  useConsoleStore: () => storeMock.current,
}));
vi.mock("../../api", () => ({ api: apiMock }));
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

import { Dashboard } from "./Dashboard";

const hit = (id: string, overrides: Partial<ThreadSearchHit> = {}): ThreadSearchHit => ({
  thread: thread(id, "agent-one", { title: `${id} title` }),
  snippet: `we discussed ${SEARCH_HIGHLIGHT_OPEN}tailscale${SEARCH_HIGHLIGHT_CLOSE} at length`,
  messageMatches: 1,
  titleMatch: false,
  ...overrides,
});


beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  apiMock.searchThreads.mockReset();
  apiMock.searchThreads.mockResolvedValue({ hits: [hit("older")], truncated: false });
  storeMock.current = {
    bootstrap: { console: { hostName: "fable", displayName: "fable", theme: "plum" as const } },
    agents: [agent("agent-one")],
    visibleAgents: [agent("agent-one")],
    hiddenOfflineAgentCount: 0,
    showOfflineAgents: false,
    setShowOfflineAgents: vi.fn(),
    setAgentPinned: vi.fn().mockResolvedValue(undefined),
    selectAgent: vi.fn(),
    cachedRunningThreads: [] as readonly ThreadSummary[],
    visibleThreads: [thread("loaded", "agent-one")],
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

// Ported from the retired ThreadSidebar suite (PR #847): the Automations
// collection behaves the same inside the Dashboard.
describe("Dashboard Automations collection", () => {
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

  it("drills into and back out of the collection while resetting search semantics", () => {
    storeMock.current!.navigationDestination = "chats";
    const { rerender } = render(<Dashboard />);

    const chatSearch = screen.getByRole("searchbox", { name: "Search conversations" });
    fireEvent.change(chatSearch, { target: { value: "release" } });
    const collection = screen.getByRole("button", { name: "Open Automations collection" });
    expect(collection).toHaveTextContent("Automations");
    expect(within(collection).getByLabelText("1 automation job")).toHaveTextContent("1");
    fireEvent.click(collection);
    expect(storeMock.current!.setNavigationDestination).toHaveBeenCalledWith("automations");

    storeMock.current!.navigationDestination = "automations";
    rerender(<Dashboard />);
    expect(screen.getByRole("searchbox", { name: "Search automations" })).toHaveValue("");
    expect(screen.getByRole("heading", { name: "Automations" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "All conversations" }));
    expect(storeMock.current!.setNavigationDestination).toHaveBeenCalledWith("chats");
  });

  it("shows each configured overview job once before its first run and opens durable history", () => {
    render(<Dashboard />);

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

    render(<Dashboard />);

    // The header announces the connection as a status too; this is the list's own.
    expect(screen.getByText(/saved snapshot/u).closest('[role="status"]')).not.toBeNull();
    expect(screen.getByRole("note")).toHaveTextContent("removed historical jobs may not be shown");
    const row = screen.getByRole("button", { name: "Open run history for daily:brief" });
    expect(row).toHaveTextContent("Enabled in snapshot");
    expect(row).toHaveTextContent("Next run unavailable");
    expect(row.querySelector("time")).toBeNull();
  });

  it("keeps an already loaded automation list stable during a background refresh", () => {
    storeMock.current!.cronLoading = true;
    render(<Dashboard />);

    expect(screen.getByRole("button", { name: "Open run history for daily:brief" })).toBeVisible();
    expect(screen.queryByText(/Refreshing automation status/iu)).toBeNull();
    expect(screen.queryByText(/Loading automations/iu)).toBeNull();
  });

  it("searches the complete overview locally without refreshing the agent", () => {
    storeMock.current!.cronOverview = {
      ...overview,
      jobs: [
        ...overview.jobs,
        {
          ...overview.jobs[0]!,
          jobId: "weekly-review",
          expression: "0 9 * * 1",
          timezone: "UTC",
          effectiveEnabled: false,
          health: "warning",
          threadId: "cron-weekly",
        },
      ],
    };
    render(<Dashboard />);

    const search = screen.getByRole("searchbox", { name: "Search automations" });
    fireEvent.change(search, { target: { value: "warning" } });
    expect(screen.getByRole("button", { name: "Open run history for weekly-review" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open run history for daily:brief" })).toBeNull();
    fireEvent.change(search, { target: { value: "does not exist" } });
    expect(screen.getByText("No matching automations")).toBeVisible();
    expect(storeMock.current!.refreshCron).not.toHaveBeenCalled();
    expect(apiMock.searchThreads).not.toHaveBeenCalled();
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
    render(<Dashboard />);
    expect(screen.getByText(copy)).toBeVisible();
  });
});

