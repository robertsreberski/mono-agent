import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agent, thread } from "../test/fixtures";

const storeMock = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("../console-store", () => ({ useConsoleStore: () => storeMock.current }));

import { MobileChatList } from "./MobileChatList";

const createStore = () => ({
  agents: [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })],
  threads: [
    thread("recent", "alpha", { title: "Recent Alpha", updatedAt: "2026-07-17T12:00:00.000Z" }),
    thread("pinned", "beta", { title: "Pinned Beta", pinnedAt: "2026-07-17T11:00:00.000Z", updatedAt: "2026-07-17T11:00:00.000Z" }),
  ],
  navigate: vi.fn(),
  setThreadPinned: vi.fn().mockResolvedValue(undefined),
});

describe("MobileChatList", () => {
  beforeEach(() => {
    storeMock.current = createStore();
  });

  it("shows combined pinned/recent sections and filters by agent", () => {
    render(<MobileChatList onOpenDefaults={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Pinned" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Recent" })).toBeVisible();
    expect(screen.getByText("Pinned Beta")).toBeVisible();
    expect(screen.getByText("Recent Alpha")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Alpha 1" }));
    expect(screen.queryByText("Pinned Beta")).not.toBeInTheDocument();
    expect(screen.getByText("Recent Alpha")).toBeVisible();
  });

  it("opens a row while keeping its pin control independent", () => {
    render(<MobileChatList onOpenDefaults={vi.fn()} />);
    const store = storeMock.current as ReturnType<typeof createStore>;

    fireEvent.click(screen.getByRole("button", { name: "Unpin Pinned Beta" }));
    expect(store.setThreadPinned).toHaveBeenCalledWith("pinned", false);
    expect(store.navigate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open Recent Alpha" }));
    expect(store.navigate).toHaveBeenCalledWith({ view: "chats", threadId: "recent" });
  });
});
