import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agent, thread } from "../../test/fixtures";

const storeMock = vi.hoisted(() => ({ current: null as ReturnType<typeof createStore> | null }));

vi.mock("../../console-store", () => ({ useConsoleStore: () => storeMock.current }));

import { BoardView } from "./BoardView";

function createStore() {
  return {
    agents: [agent("alpha", { label: "Alpha" }), agent("beta", { label: "Beta" })],
    threads: [
      thread("alpha-work", "alpha", { title: "Alpha work", labels: ["Launch"], project: "Console" }),
      thread("beta-work", "beta", { title: "Beta work", state: "doing", runState: { status: "running" } }),
    ],
    loadBoardThreads: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn(),
    setThreadState: vi.fn().mockResolvedValue(undefined),
  };
}

describe("BoardView", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    storeMock.current = createStore();
  });

  it("renders all kanban states, filters by agent, and cycles state without opening the card", () => {
    render(<BoardView />);

    expect(screen.getByRole("heading", { name: "To do" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "In progress" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Done" })).toBeVisible();
    expect(screen.getByText("No conversations")).toBeVisible();
    expect(screen.getByRole("button", { name: /All agents 2/u })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /Beta 1/u }));
    expect(screen.queryByText("Alpha work")).not.toBeInTheDocument();
    expect(screen.getByText("Beta work")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Move Beta work to done" }));
    expect(storeMock.current!.setThreadState).toHaveBeenCalledWith("beta-work", "done");
    expect(storeMock.current!.navigate).not.toHaveBeenCalled();
  });

  it("persists list grouping preferences and opens a card in Chats", () => {
    render(<BoardView />);
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "project" } });

    expect(localStorage.getItem("mono-agent.web.board.layout")).toBe("list");
    expect(localStorage.getItem("mono-agent.web.board.group")).toBe("project");
    expect(screen.getByRole("heading", { name: "Console" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "No project" })).toBeVisible();

    expect(screen.getAllByRole("article")[0]).not.toHaveAttribute("role", "button");
    fireEvent.click(screen.getByRole("button", { name: "Open Alpha work" }));
    expect(storeMock.current!.navigate).toHaveBeenCalledWith({ view: "chats", threadId: "alpha-work" });
  });
});
