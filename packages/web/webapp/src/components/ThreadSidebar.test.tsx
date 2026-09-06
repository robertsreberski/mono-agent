import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDataModeSetting } from "../data-mode";
import { recordDataUsage, resetDataUsage } from "../data-usage";
import { agent, thread } from "../test/fixtures";
import { SEARCH_HIGHLIGHT_CLOSE, SEARCH_HIGHLIGHT_OPEN } from "../thread-search";
import type { ThreadSearchHit } from "../types";

const storeMock = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const apiMock = vi.hoisted(() => ({ searchThreads: vi.fn() }));

vi.mock("../console-store", () => ({
  useConsoleStore: () => storeMock.current,
}));
vi.mock("../api", () => ({ api: apiMock }));
// The sidebar list itself is assistant-ui's; these tests are about the search
// surface that replaces it, so the primitives are reduced to plain markup.
vi.mock("@assistant-ui/react", () => ({
  ThreadListPrimitive: {
    Root: ({ children, ...rest }: Record<string, unknown>) => <div {...rest}>{children as never}</div>,
    Items: () => null,
    New: ({ children, ...rest }: Record<string, unknown>) => <button type="button" {...rest}>{children as never}</button>,
  },
  ThreadListItemPrimitive: {
    Root: ({ children }: Record<string, unknown>) => <div>{children as never}</div>,
    Trigger: ({ children }: Record<string, unknown>) => <button type="button">{children as never}</button>,
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
    setShowArchived: vi.fn(),
    hasMoreThreads: true,
    loadMoreThreads: vi.fn().mockResolvedValue(undefined),
    selectThread: vi.fn(),
  };
});

afterEach(() => {
  vi.useRealTimers();
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
