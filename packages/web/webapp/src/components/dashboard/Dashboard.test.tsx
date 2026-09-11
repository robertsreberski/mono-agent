import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Fragment, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent, thread } from "../../test/fixtures";
import { SEARCH_HIGHLIGHT_CLOSE, SEARCH_HIGHLIGHT_OPEN } from "../../thread-search";
import type { ThreadSearchHit, ThreadSummary } from "../../types";

const storeMock = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const apiMock = vi.hoisted(() => ({ searchThreads: vi.fn() }));
/** assistant-ui's answer to "is this row the open conversation". */
const auiSelected = vi.hoisted(() => ({ current: false }));

vi.mock("../../console-store", () => ({
  useConsoleStore: () => storeMock.current,
}));
vi.mock("../../notifications", () => ({ NotificationBell: () => null }));
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
    // The row's own class carries the selection mark, so it is passed through.
    Root: ({ children, ...rest }: Record<string, unknown>) => <div {...rest}>{children as never}</div>,
    Trigger: ({ children, ...rest }: Record<string, unknown>) => <button type="button" {...rest}>{children as never}</button>,
    Title: () => null,
    Archive: () => null,
    Unarchive: () => null,
  },
  useAuiState: () => auiSelected.current,
}));

import { Dashboard } from "./Dashboard";

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

/** The store's own rule, mirrored so a test can move `threads` and be believed. */
const visible = (threads: readonly ThreadSummary[], sourceId: string, archived: boolean) =>
  threads.filter(
    (item) => item.sourceId === sourceId && Boolean(item.archivedAt) === archived,
  );

const createStore = (threads: readonly ThreadSummary[] = [thread("loaded", "agent-one")]) => ({
  bootstrap: { console: { hostName: "fable", displayName: "fable", theme: "plum" as const } },
  connection: "live",
  agents: [agent("agent-one"), agent("agent-two")],
  visibleAgents: [agent("agent-one"), agent("agent-two")],
  hiddenOfflineAgentCount: 0,
  showOfflineAgents: false,
  cachedRunningThreads: [] as readonly ThreadSummary[],
  unreadThreadIds: new Set<string>(),
  unreadCountByAgent: new Map<string, number>(),
  // No server answer by default: most cases are about the list, and the ones
  // about Running say for themselves what the fleet reported.
  activeThreads: null as {
    readonly threads: readonly ThreadSummary[];
    readonly total: number;
    readonly truncated: boolean;
    readonly runningCounts: Readonly<Record<string, number>>;
    readonly authoritative: boolean;
  } | null,
  navigationDestination: "chats" as const,
  cronOverview: null,
  setNavigationDestination: vi.fn(),
  selectedAgent: agent("agent-one"),
  selectedAgentId: "agent-one",
  selectedThreadId: null,
  threads,
  visibleThreads: visible(threads, "agent-one", false),
  showArchived: false,
  selectionLoading: false,
  creatingThread: false,
  selectionError: null,
  threadListError: null,
  retryThreadList: vi.fn(),
  setShowArchived: vi.fn(),
  setShowOfflineAgents: vi.fn(),
  setAgentPinned: vi.fn().mockResolvedValue(undefined),
  selectAgent: vi.fn(),
  hasMoreThreads: true,
  loadMoreThreads: vi.fn().mockResolvedValue(undefined),
  selectThread: vi.fn(),
});

const store = () => storeMock.current as ReturnType<typeof createStore>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  auiSelected.current = false;
  apiMock.searchThreads.mockReset();
  apiMock.searchThreads.mockResolvedValue({ hits: [hit("older")], truncated: false });
  storeMock.current = createStore();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Dashboard header", () => {
  it("names the console and the agent the conversations belong to", () => {
    render(<Dashboard />);

    expect(screen.getByText("fable")).toBeVisible();
    expect(screen.getByRole("heading", { name: "AGENT-ONE" })).toBeVisible();
    expect(screen.getByLabelText("Console connection: live")).toBeInTheDocument();
  });

  it("turns the new-conversation action into an immediate pending indicator", () => {
    storeMock.current = { ...createStore(), selectionLoading: true, creatingThread: true };

    render(<Dashboard />);

    const pending = screen.getByRole("button", { name: "Creating conversation" });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(pending).toHaveAttribute("title", "Creating conversation…");
    expect(pending.querySelector(".new-thread-spinner")).not.toBeNull();
  });

  it("leaves for a new conversation, and stays put for the settings dialog", () => {
    const onNavigate = vi.fn();
    const settings = vi.fn();
    window.addEventListener("mono-agent:agent-settings", settings);
    render(<Dashboard onNavigate={onNavigate} />);

    expect(screen.queryByRole("button", { name: "Open command palette" })).toBeNull();

    // The dialog opens over this screen. Pushing the conversation under it
    // meant closing the dialog landed the operator in a conversation they had
    // not asked for.
    fireEvent.click(screen.getByRole("button", { name: "Agent settings" }));
    expect(settings).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    window.removeEventListener("mono-agent:agent-settings", settings);
  });

  it("has nothing to configure without a settled agent", () => {
    storeMock.current = { ...createStore(), selectedAgent: null };
    render(<Dashboard />);

    expect(screen.getByRole("heading", { name: "No agent" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Agent settings" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New conversation" })).toBeDisabled();
  });
});

describe("Dashboard selection highlight", () => {
  beforeEach(() => { auiSelected.current = true; });

  it("marks the open conversation where that conversation is on screen", () => {
    render(<Dashboard />);

    expect(document.querySelector(".thread-item.is-active")).not.toBeNull();
  });

  it("marks nothing while the list is the whole screen", () => {
    // The store still HOLDS the selection -- the chat screen behind needs one.
    // Drawing it here pre-answers a question the operator came to ask.
    render(<Dashboard highlightSelected={false} />);

    expect(document.querySelector(".thread-item")).not.toBeNull();
    expect(document.querySelector(".thread-item.is-active")).toBeNull();
  });
});

describe("Dashboard conversation rows", () => {
  it("shows loading instead of claiming a cold agent has no conversations", () => {
    storeMock.current = { ...createStore([]), selectionLoading: true };

    render(<Dashboard />);

    expect(screen.getByText("Loading conversations…")).toBeVisible();
    expect(screen.queryByText("Start a conversation")).toBeNull();
    expect(screen.getByRole("button", { name: "New conversation" })).toBeDisabled();
  });

  it("shows failure instead of claiming a failed bucket has no conversations", () => {
    storeMock.current = { ...createStore([]), selectionError: "bucket unavailable" };

    render(<Dashboard />);

    expect(screen.getByText("Conversations unavailable")).toBeVisible();
    expect(screen.queryByText("Start a conversation")).toBeNull();
    expect(screen.getByRole("button", { name: "New conversation" })).toBeDisabled();
  });

  it("keeps a usable conversation available while offering an exact listing retry", () => {
    storeMock.current!.threadListError = "beta conversations unavailable";

    render(<Dashboard />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Conversations could not be refreshed. beta conversations unavailable",
    );
    expect(screen.getByRole("button", { name: "New conversation" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry conversations" }));
    expect(store().retryThreadList).toHaveBeenCalledTimes(1);
  });

  it.each([
    { archived: false, emptyCopy: "Start a conversation" },
    { archived: true, emptyCopy: "No archived conversations" },
  ])("does not call an empty $emptyCopy shelf authoritative while its listing failed", ({
    archived,
    emptyCopy,
  }) => {
    storeMock.current = {
      ...createStore([]),
      showArchived: archived,
      hasMoreThreads: false,
      threadListError: "listing unavailable",
    };

    const { rerender } = render(<Dashboard />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Conversations could not be refreshed. listing unavailable",
    );
    expect(screen.getByText("Conversations unavailable")).toBeVisible();
    expect(screen.queryByText(emptyCopy)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry conversations" }));
    expect(store().retryThreadList).toHaveBeenCalledTimes(1);
    storeMock.current!.threadListError = null;
    rerender(<Dashboard />);

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
    storeMock.current = createStore([running]);
    const { rerender } = render(<Dashboard />);
    const row = screen.getByRole("button", { name: "Open Background work" });
    expect(row).toHaveTextContent("2 background jobs running");
    expect(within(row).getByRole("img", { name: "2 background jobs running" })).toBeVisible();
    expect(row).not.toHaveTextContent("Older reply");
    expect(row).not.toHaveTextContent("5 messages");

    storeMock.current = createStore([{
      ...running,
      jobActivity: { queued: 0, starting: 0, running: 0, latestTerminal: {
        state: "succeeded", completedAt: "2026-09-07T10:00:00.000Z", replyPreview: "Results are ready",
      } },
    }]);
    rerender(<Dashboard />);
    expect(row).toHaveTextContent("Results are ready");
    expect(within(row).queryByRole("img", { name: /running|Working/u })).toBeNull();
  });

  it("shows cancellation status in archived conversations", () => {
    const cancelled = thread("cancelled", "agent-one", {
      archivedAt: "2026-09-07T10:00:00.000Z",
      runState: { status: "cancelled" },
      lastMessagePreview: "Previous reply",
      messageCount: 4,
    });
    storeMock.current = {
      ...createStore([cancelled]),
      showArchived: true,
      visibleThreads: visible([cancelled], "agent-one", true),
    };
    render(<Dashboard />);
    const row = screen.getByRole("button", { name: "Open cancelled" });
    expect(row).toHaveTextContent("Cancelled");
    expect(row).not.toHaveTextContent("Previous reply");
    expect(within(row).queryByRole("img", { name: "Cancelled" })).toBeNull();
  });

  it("marks what a conversation is, with trouble ahead of its trigger, and keeps cron out", () => {
    const failedWebhook = thread("delivery", "agent-one", {
      title: "Webhook delivery",
      trigger: { kind: "webhook" },
      runState: { status: "failed" },
    });
    const healthyWebhook = thread("ping", "agent-one", {
      title: "Webhook ping",
      trigger: { kind: "webhook" },
    });
    const cron = thread("nightly", "agent-one", {
      title: "Nightly report",
      trigger: { kind: "cron", jobId: "nightly" },
    });
    storeMock.current = createStore([failedWebhook, healthyWebhook, cron]);
    render(<Dashboard />);

    const failed = screen.getByRole("button", { name: "Open Webhook delivery" });
    expect(failed.querySelector(".thread-kind.is-alert")).not.toBeNull();
    // The alert takes the glyph; its name still says where the run came from.
    expect(within(failed).getByRole("img", { name: /webhook conversation/u })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Open Webhook ping" }).querySelector(".thread-kind.is-webhook"),
    ).not.toBeNull();
    // A cron channel is an automation's history: it lives in that collection.
    expect(screen.queryByRole("button", { name: "Open Nightly report" })).toBeNull();
  });

  it("marks a row this device has not seen, and says so by name", () => {
    storeMock.current = { ...createStore(), unreadThreadIds: new Set(["loaded"]) };
    render(<Dashboard />);

    const row = screen.getByRole("button", { name: "Open loaded" });
    expect(within(row).getByRole("img", { name: "Unread" })).toBeVisible();
  });

  it("closes the drawer when a row opens a conversation, and not when the list pages", () => {
    const onNavigate = vi.fn();
    render(<Dashboard onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole("button", { name: "Load older conversations" }));
    expect(store().loadMoreThreads).toHaveBeenCalledTimes(1);
    expect(onNavigate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open loaded" }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});

describe("Dashboard list chips", () => {
  it("offers Automations with its job count beside Chats, and switches in place", () => {
    storeMock.current = {
      ...createStore(),
      cronOverview: { generatedAt: "2026-09-08T08:00:00.000Z", actionsEnabled: false, jobs: [
        { jobId: "daily", expression: "0 8 * * *", timezone: "UTC", conversationId: "cron:daily",
          configured: true, declaredEnabled: true, effectiveEnabled: true, health: "healthy", threadId: "cron-daily" },
      ] },
    };
    render(<Dashboard />);

    expect(screen.getByRole("button", { name: "Chats" })).toHaveAttribute("aria-pressed", "true");
    const chip = screen.getByRole("button", { name: "Automations, 1 job" });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(chip);
    expect(store().setNavigationDestination).toHaveBeenCalledWith("automations");
  });

  it("keeps the chips on the archive shelf", () => {
    storeMock.current = { ...createStore(), showArchived: true };
    render(<Dashboard />);
    expect(screen.getByRole("heading", { name: "Archived" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Chats" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows the automations in the list's place, with its own search and Running still above", () => {
    storeMock.current = { ...createStore(), navigationDestination: "automations" as const };
    render(<Dashboard />);
    expect(screen.getByRole("heading", { name: "Automations" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Recent" })).toBeNull();
    expect(screen.getByRole("searchbox", { name: "Search automations" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Archived/u })).toBeNull();
    expect(screen.getByRole("button", { name: "Automations" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Chats" }));
    expect(store().setNavigationDestination).toHaveBeenCalledWith("chats");
  });
});

describe("Dashboard running section", () => {
  const alphaRunning = thread("alpha-live", "agent-one", {
    title: "Alpha work",
    runState: { status: "running" },
  });
  const betaRunning = thread("beta-live", "agent-two", {
    title: "Beta work",
    runState: { status: "running" },
    updatedAt: "2026-07-17T11:00:00.000Z",
  });

  it("draws nothing at all when this browser is holding no work in flight", () => {
    render(<Dashboard />);

    expect(screen.queryByRole("heading", { name: /Running/u })).toBeNull();
  });

  it("names work on an agent whose conversations are nowhere in the listing", () => {
    storeMock.current = {
      ...createStore(),
      activeThreads: {
        threads: [betaRunning],
        total: 1,
        truncated: false,
        runningCounts: { "agent-one": 0, "agent-two": 1 },
        authoritative: true,
      },
    };
    render(<Dashboard />);

    expect(screen.getByRole("heading", { name: "Running, 1" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Beta work on AGENT-TWO" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open Beta work" })).toBeNull();
    // The badge is the SERVER's count for that agent, not the cards' -- this
    // browser holds none of beta's conversations.
    expect(screen.getByRole("button", { name: /^AGENT-TWO, online, 1 running$/u })).toBeVisible();
  });

  it("says the fleet is idle only when the server said so, and keeps the cards when it did not", () => {
    const idle = {
      threads: [] as readonly ThreadSummary[],
      total: 0,
      truncated: false,
      runningCounts: { "agent-one": 0, "agent-two": 0 },
      authoritative: true,
    };
    storeMock.current = {
      ...createStore(),
      cachedRunningThreads: [betaRunning],
      activeThreads: idle,
    };
    const view = render(<Dashboard />);
    // An authoritative empty listing beats what this tab is still holding.
    expect(screen.queryByRole("heading", { name: /Running/u })).toBeNull();

    storeMock.current = {
      ...createStore(),
      cachedRunningThreads: [betaRunning],
      activeThreads: { ...idle, authoritative: false },
    };
    view.rerender(<Dashboard />);

    // The same empty answer, no longer standing: the cache speaks again and
    // the section says what that is worth.
    expect(screen.getByRole("heading", { name: "Running, 1, last known" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Beta work on AGENT-TWO" })).toBeVisible();
  });

  it("says how many of the fleet's running conversations it is showing", () => {
    storeMock.current = {
      ...createStore(),
      activeThreads: {
        threads: [alphaRunning, betaRunning],
        total: 63,
        truncated: true,
        runningCounts: { "agent-one": 31, "agent-two": 32 },
        authoritative: true,
      },
    };
    render(<Dashboard />);

    expect(screen.getByRole("heading", { name: "Running, 63" })).toBeVisible();
    expect(screen.getByText("Showing 2 of 63")).toBeVisible();
    expect(screen.getByRole("button", { name: /^AGENT-ONE, online, 31 running$/u })).toBeVisible();
  });

  it("switches agent, bucket and conversation in one action, then gets out of the way", () => {
    const onNavigate = vi.fn();
    const archivedRunning = { ...betaRunning, archivedAt: "2026-07-18T10:00:00.000Z" };
    storeMock.current = { ...createStore(), cachedRunningThreads: [archivedRunning] };
    render(<Dashboard onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole("button", { name: "Open Beta work on AGENT-TWO" }));

    expect(store().selectAgent).toHaveBeenCalledWith("agent-two");
    expect(store().setShowArchived).toHaveBeenCalledWith(true);
    expect(store().selectThread).toHaveBeenCalledWith("beta-live");
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("folds an agent's third card away and expands it in place", () => {
    const extra = (index: number) => thread(`alpha-${String(index)}`, "agent-one", {
      title: `Alpha ${String(index)}`,
      runState: { status: "running" },
      updatedAt: `2026-07-1${String(index)}T10:00:00.000Z`,
    });
    storeMock.current = {
      ...createStore(),
      cachedRunningThreads: [alphaRunning, extra(5), extra(4)],
    };
    render(<Dashboard />);

    expect(screen.getAllByRole("button", { name: /^Open Alpha/u })).toHaveLength(2);
    const more = screen.getByRole("button", { name: "+1 more · AGENT-ONE" });

    fireEvent.click(more);
    expect(screen.getAllByRole("button", { name: /^Open Alpha/u })).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Show fewer · AGENT-ONE" }));
    expect(screen.getAllByRole("button", { name: /^Open Alpha/u })).toHaveLength(2);
  });

  it("keeps the cards a card-only fallback can still name, and labels them", () => {
    // No server answer at all -- a cold start off the device, or a console that
    // has never had a live stream. The cache is all there is.
    storeMock.current = { ...createStore(), cachedRunningThreads: [betaRunning] };
    render(<Dashboard />);

    expect(screen.getByRole("heading", { name: "Running, 1, last known" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Beta work on AGENT-TWO" })).toBeVisible();
  });

  it("drops held work whose agent is no longer discovered", () => {
    storeMock.current = {
      ...createStore(),
      agents: [agent("agent-one")],
      visibleAgents: [agent("agent-one")],
      cachedRunningThreads: [betaRunning],
    };
    render(<Dashboard />);

    expect(screen.queryByRole("heading", { name: /Running/u })).toBeNull();
  });
});

describe("Dashboard search", () => {
  it("leaves the conversation list alone until the query is worth running", async () => {
    render(<Dashboard />);

    type("t");
    await vi.advanceTimersByTimeAsync(500);

    expect(apiMock.searchThreads).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Load older conversations" })).toBeVisible();
  });

  it("searches the server and renders highlighted snippets from outside the loaded page", async () => {
    render(<Dashboard />);

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
    // The chips stay: the list's other face is one tap away during a search,
    // and switching to it retires the query, which meant something else.
    expect(screen.getByRole("button", { name: "Chats" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /^Automations/u }));
    expect(store().setNavigationDestination).toHaveBeenCalledWith("automations");
  });

  it("clears a conversation query when the list switches to automations", () => {
    const { rerender } = render(<Dashboard />);
    type("tailscale");
    expect(screen.getByRole("searchbox", { name: "Search conversations" })).toHaveValue("tailscale");

    storeMock.current = { ...storeMock.current!, navigationDestination: "automations" as const };
    rerender(<Dashboard />);
    expect(screen.getByRole("searchbox", { name: "Search automations" })).toHaveValue("");
    expect(apiMock.searchThreads).not.toHaveBeenCalled();
  });

  it("debounces to one request per settled query", async () => {
    render(<Dashboard />);

    type("tai");
    await vi.advanceTimersByTimeAsync(50);
    type("tails");
    await vi.advanceTimersByTimeAsync(50);
    type("tailscale");
    await vi.advanceTimersByTimeAsync(500);

    await waitFor(() => { expect(apiMock.searchThreads).toHaveBeenCalledTimes(1); });
    expect(apiMock.searchThreads).toHaveBeenCalledWith("agent-one", "tailscale", expect.anything());
  });

  it("opens a hit through the store, which can fetch a thread the list never loaded", async () => {
    const onNavigate = vi.fn();
    render(<Dashboard onNavigate={onNavigate} />);

    type("tailscale");
    await vi.advanceTimersByTimeAsync(500);
    fireEvent.click(await screen.findByRole("button", { name: "Open older title" }));

    expect(store().selectThread).toHaveBeenCalledWith("older");
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("clears the query when the agent changes, so no hit outlives its agent", async () => {
    const { rerender } = render(<Dashboard />);
    type("tailscale");
    await vi.advanceTimersByTimeAsync(500);
    await screen.findByRole("button", { name: "Open older title" });

    storeMock.current = { ...createStore(), selectedAgentId: "agent-two" };
    rerender(<Dashboard />);

    expect(screen.getByPlaceholderText("Search conversations")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Open older title" })).toBeNull();
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
    render(<Dashboard />);

    type("tailscale");
    await vi.advanceTimersByTimeAsync(500);

    expect(await screen.findByText("Conversations")).toBeVisible();
    // Scoped by heading: the archive toggle at the foot of the dashboard
    // carries the same word.
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
    render(<Dashboard />);

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
    render(<Dashboard />);

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
    const { unmount } = render(<Dashboard />);
    type("nothing");
    await vi.advanceTimersByTimeAsync(500);
    expect(await screen.findByText("No matching conversations")).toBeVisible();
    unmount();

    apiMock.searchThreads.mockRejectedValue(new Error("offline"));
    render(<Dashboard />);
    type("nothing");
    await vi.advanceTimersByTimeAsync(500);
    expect(await screen.findByRole("alert")).toHaveTextContent("Search is unavailable right now");
  });

  it("warns that a truncated result set is only the closest matches", async () => {
    apiMock.searchThreads.mockResolvedValue({ hits: [hit("older")], truncated: true });
    render(<Dashboard />);

    type("tailscale");
    await vi.advanceTimersByTimeAsync(500);

    expect(await screen.findByText(/Showing the closest matches/u)).toBeVisible();
  });

  it("restores the conversation list when the query is cleared", async () => {
    render(<Dashboard />);
    type("tailscale");
    await vi.advanceTimersByTimeAsync(500);
    await screen.findByRole("button", { name: "Open older title" });

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    await vi.advanceTimersByTimeAsync(500);

    expect(screen.queryByRole("button", { name: "Open older title" })).toBeNull();
    expect(screen.getByRole("button", { name: "Load older conversations" })).toBeVisible();
  });
});
