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
});

const store = () => storeMock.current as ReturnType<typeof createStore>;

const openOptions = (label: string) => {
  fireEvent.click(screen.getByRole("button", { name: `Agent options for ${label}` }));
};

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

  it("keeps selection and pinning independent", () => {
    render(<AgentStrip />);

    openOptions("A complete favorite agent name");
    fireEvent.click(screen.getByRole("button", { name: "Unpin A complete favorite agent name" }));
    expect(store().setAgentPinned).toHaveBeenCalledWith("favorite", false);
    expect(store().selectAgent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Other agent, online" }));
    expect(store().selectAgent).toHaveBeenCalledWith("other");
    expect(store().setAgentPinned).toHaveBeenCalledTimes(1);
  });

  it("exposes selection and pin state through pressed semantics", () => {
    render(<AgentStrip />);

    expect(screen.getByRole("button", { name: "Current offline agent, offline" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Other agent, online" }))
      .toHaveAttribute("aria-pressed", "false");

    openOptions("Other agent");
    expect(screen.getByRole("button", { name: "Pin Other agent" }))
      .toHaveAttribute("aria-pressed", "false");
  });

  it("opens one agent's options at a time and closes them on Escape", () => {
    render(<AgentStrip />);

    openOptions("Other agent");
    expect(screen.getByRole("button", { name: "Pin Other agent" })).toBeVisible();

    openOptions("Current offline agent");
    expect(screen.queryByRole("button", { name: "Pin Other agent" })).toBeNull();
    expect(screen.getByRole("button", { name: "Pin Current offline agent" })).toBeVisible();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Pin Current offline agent" })).toBeNull();
    // The control that opened it gets the keyboard back.
    expect(document.activeElement)
      .toBe(screen.getByRole("button", { name: "Agent options for Current offline agent" }));
  });

  it("closes the options on a click somewhere else", () => {
    render(<AgentStrip />);

    openOptions("Other agent");
    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("button", { name: "Pin Other agent" })).toBeNull();
  });

  it("offers the hidden offline agents behind their count", () => {
    render(<AgentStrip />);

    fireEvent.click(screen.getByRole("button", { name: "Show 1 offline agent" }));
    expect(store().setShowOfflineAgents).toHaveBeenCalledWith(true);
  });

  it("says so rather than drawing an empty strip", () => {
    storeMock.current = { ...createStore(), visibleAgents: [], hiddenOfflineAgentCount: 0 };
    render(<AgentStrip />);

    expect(screen.getByText(/No agents discovered/u)).toBeVisible();
  });
});
