import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agent } from "../../test/fixtures";

const storeMock = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("../../console-store", () => ({
  useConsoleStore: () => storeMock.current,
}));

import { AgentStrip } from "./AgentStrip";

const createStore = () => ({
  agents: [
    agent("favorite", {
      label: "A complete favorite agent name",
      pinned: true,
      status: "offline",
    }),
    agent("other", { label: "Other agent" }),
    agent("current-offline", { label: "Current offline agent", status: "offline" }),
    agent("hidden-offline", { label: "Hidden offline agent", status: "offline" }),
  ],
  visibleAgents: [
    agent("favorite", {
      label: "A complete favorite agent name",
      pinned: true,
      status: "offline",
    }),
    agent("other", { label: "Other agent" }),
    agent("current-offline", { label: "Current offline agent", status: "offline" }),
  ],
  selectedAgentId: "current-offline",
  hiddenOfflineAgentCount: 1,
  showOfflineAgents: false,
  selectAgent: vi.fn(),
  setAgentPinned: vi.fn().mockResolvedValue(undefined),
  setShowOfflineAgents: vi.fn(),
  unreadCountByAgent: new Map<string, number>(),
});

const store = () => storeMock.current as ReturnType<typeof createStore>;

describe("AgentStrip", () => {
  beforeEach(() => {
    storeMock.current = createStore();
  });

  it("names every visible agent in full and keeps hidden offline agents out", () => {
    render(<AgentStrip />);

    // The square carries a monogram and its caption is the label's first
    // word; the full name is the accessible name and the caption's title, so
    // nothing is reachable only by two letters.
    expect(screen.getByRole("button", { name: "A complete favorite agent name, offline, pinned" }))
      .toBeVisible();
    expect(screen.getByTitle("A complete favorite agent name")).toHaveTextContent(/^A$/);
    expect(screen.getByTitle("Current offline agent")).toHaveTextContent(/^Current$/);
    expect(screen.queryByTitle("Hidden offline agent")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Hidden offline agent, offline/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("selects on the square and never pins from the strip", () => {
    render(<AgentStrip />);

    fireEvent.click(screen.getByRole("button", { name: "Other agent, online" }));
    expect(store().selectAgent).toHaveBeenCalledWith("other");
    // Pinning is the agent's setting, behind the header's gear; the strip
    // offers no per-agent control that could clip or hide on a phone.
    expect(screen.queryByRole("button", { name: /Agent options for/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /^(Pin|Unpin) /u })).toBeNull();
    expect(store().setAgentPinned).not.toHaveBeenCalled();
  });

  it("exposes selection through pressed semantics and pin state through the name", () => {
    render(<AgentStrip />);

    expect(screen.getByRole("button", { name: "Current offline agent, offline" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Other agent, online" }))
      .toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "A complete favorite agent name, offline, pinned" }))
      .toHaveAttribute("aria-pressed", "false");
  });

  it("offers the hidden offline agents behind their count", () => {
    render(<AgentStrip />);

    fireEvent.click(screen.getByRole("button", { name: "Show 1 offline agent" }));
    expect(store().setShowOfflineAgents).toHaveBeenCalledWith(true);
  });

  it("lets work in flight take the corner, and gives it back when the work ends", () => {
    storeMock.current = {
      ...createStore(),
      unreadCountByAgent: new Map([["other", 4]]),
    };
    const running = new Map([["other", 2]]);
    const { rerender } = render(<AgentStrip runningCounts={running} />);

    // One 16-pixel circle, and what is happening NOW is the more urgent of the
    // two claims on it.
    const busy = screen.getByRole("button", { name: "Other agent, online, 2 running" });
    expect(busy.querySelector(".agent-chip-badge")).toHaveTextContent("2");
    expect(busy.querySelector(".agent-chip-badge")).not.toHaveClass("is-unread");

    rerender(<AgentStrip runningCounts={new Map()} />);

    const quiet = screen.getByRole("button", { name: "Other agent, online, 4 unread" });
    expect(quiet.querySelector(".agent-chip-badge")).toHaveTextContent("4");
    // The muted shape: a square with messages waiting is never mistaken for one
    // with work in flight.
    expect(quiet.querySelector(".agent-chip-badge")).toHaveClass("is-unread");
  });

  it("says so rather than drawing an empty strip", () => {
    storeMock.current = { ...createStore(), visibleAgents: [], hiddenOfflineAgentCount: 0 };
    render(<AgentStrip />);

    expect(screen.getByText(/No agents discovered/u)).toBeVisible();
  });
});
