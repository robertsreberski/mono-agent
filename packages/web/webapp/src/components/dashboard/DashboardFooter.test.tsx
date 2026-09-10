import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDataModeSetting } from "../../data-mode";
import { recordDataUsage, resetDataUsage } from "../../data-usage";
import { thread } from "../../test/fixtures";

const storeMock = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("../../console-store", () => ({
  useConsoleStore: () => storeMock.current,
}));

import { DashboardFooter } from "./DashboardFooter";

beforeEach(() => {
  storeMock.current = {
    threads: [
      thread("live", "agent-one"),
      thread("filed", "agent-one", { archivedAt: "2026-09-07T10:00:00.000Z" }),
      thread("other-agent-filed", "agent-two", { archivedAt: "2026-09-07T10:00:00.000Z" }),
    ],
    selectedAgentId: "agent-one",
    showArchived: false,
    setShowArchived: vi.fn(),
  };
});

afterEach(() => {
  resetDataUsage();
  localStorage.clear();
});

describe("the dashboard's data-mode footer", () => {
  it("shows what the session has cost, and cycles the mode when tapped", () => {
    // Auto cannot read the network in jsdom, exactly as it cannot on iOS, so it
    // says so: Auto, resolving to Full. The number next to it is what makes the
    // choice actionable.
    recordDataUsage(3 * 1024);
    render(<DashboardFooter />);

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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T10:00:00.000Z"));
    resetDataUsage();
    vi.setSystemTime(new Date("2026-09-06T10:02:00.000Z"));
    recordDataUsage(2 * 1024);
    render(<DashboardFooter />);

    const control = screen.getByRole("button", { name: /this session/u });
    expect(control).toHaveTextContent("2 KiB/min");
    expect(control.getAttribute("aria-label"))
      .toContain("about 2 KiB in the last minute");
    vi.useRealTimers();
  });
});

describe("the dashboard's archive shelf", () => {
  it("counts only the selected agent's archived conversations", () => {
    render(<DashboardFooter />);

    const toggle = screen.getByRole("button", { name: /Archived/u });
    expect(toggle).toHaveTextContent("1");

    fireEvent.click(toggle);
    expect(storeMock.current!.setShowArchived).toHaveBeenCalledWith(true);
  });

  it("offers the way back once the shelf is open, and shows no count for none", () => {
    storeMock.current = {
      ...storeMock.current,
      threads: [thread("live", "agent-one")],
      showArchived: true,
    };
    render(<DashboardFooter />);

    const toggle = screen.getByRole("button", { name: "Back to conversations" });
    expect(toggle).toHaveClass("is-active");
    fireEvent.click(toggle);
    expect(storeMock.current!.setShowArchived).toHaveBeenCalledWith(false);
  });
});
