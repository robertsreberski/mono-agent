import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agent } from "../test/fixtures";

const storeMock = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("../console-store", () => ({
  useConsoleStore: () => storeMock.current,
}));

import { AgentRail, MobileAgentPicker } from "./AgentRail";

const createStore = () => ({
  agents: [
    agent("favorite", {
      label: "A complete favorite agent name",
      pinned: true,
      status: "offline",
    }),
    agent("other", { label: "Other agent" }),
  ],
  connection: "live",
  selectedAgentId: "other",
  selectAgent: vi.fn(),
  setAgentPinned: vi.fn().mockResolvedValue(undefined),
});

describe("AgentRail", () => {
  beforeEach(() => {
    storeMock.current = createStore();
  });

  it("renders full names and independent selection and pin controls", () => {
    render(<AgentRail expanded />);
    const store = storeMock.current as ReturnType<typeof createStore>;

    expect(screen.getByText("A complete favorite agent name")).toBeVisible();
    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent(
      "A complete favorite agent name",
    );

    fireEvent.click(screen.getByRole("button", { name: "Unpin A complete favorite agent name" }));
    expect(store.setAgentPinned).toHaveBeenCalledWith("favorite", false);
    expect(store.selectAgent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Other agent, online" }));
    expect(store.selectAgent).toHaveBeenCalledWith("other");
    expect(store.setAgentPinned).toHaveBeenCalledTimes(1);
  });

  it("exposes pin state through pressed semantics", () => {
    render(<AgentRail expanded />);

    expect(
      screen.getByRole("button", { name: "Unpin A complete favorite agent name" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Pin Other agent" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});

describe("MobileAgentPicker", () => {
  it("pinning does not select the agent or close the drawer", () => {
    storeMock.current = createStore();
    const onSelect = vi.fn();
    render(<MobileAgentPicker onSelect={onSelect} />);
    const store = storeMock.current as ReturnType<typeof createStore>;

    fireEvent.click(screen.getByRole("button", { name: "Pin Other agent" }));

    expect(store.setAgentPinned).toHaveBeenCalledWith("other", true);
    expect(store.selectAgent).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
