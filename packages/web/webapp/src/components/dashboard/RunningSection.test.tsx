import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { agent, thread } from "../../test/fixtures";
import { RunningSection } from "./RunningSection";

const alpha = agent("alpha", { label: "Alpha" });
const working = thread("alpha-live", "alpha", {
  title: "Alpha work",
  runState: { status: "running" },
  updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
});

const renderSection = (
  overrides: Partial<Parameters<typeof RunningSection>[0]> = {},
) => {
  const props = {
    groups: [{ agent: alpha, threads: [working] }],
    expandedAgentIds: new Set<string>(),
    onToggleAgent: vi.fn(),
    onOpen: vi.fn(),
    ...overrides,
  };
  render(<RunningSection {...props} />);
  return props;
};

describe("RunningSection", () => {
  it("draws nothing rather than an empty shelf", () => {
    const { container } = render(
      <RunningSection
        groups={[]}
        expandedAgentIds={new Set()}
        onToggleAgent={vi.fn()}
        onOpen={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("counts what is CACHED rather than claiming to know the fleet", () => {
    renderSection();

    const heading = screen.getByRole("heading", { name: "Running, 1 cached" });
    expect(heading).toHaveTextContent("Running");
    expect(heading.querySelector(".dashboard-section-count"))
      .toHaveAttribute("title", "Conversations this browser is holding");
  });

  it("says which agent a card belongs to, what it is doing, and for how long", () => {
    renderSection();

    const card = screen.getByRole("button", { name: "Open Alpha work on Alpha" });
    expect(card).toHaveTextContent("AL");
    expect(card).toHaveTextContent("Working…");
    expect(card).toHaveTextContent("5m");
  });

  it("hands the whole conversation back, not an identifier", () => {
    const props = renderSection();

    fireEvent.click(screen.getByRole("button", { name: "Open Alpha work on Alpha" }));

    expect(props.onOpen).toHaveBeenCalledWith(working);
  });

  it("offers the overflow control only once an agent has more than fits", () => {
    const second = { ...working, id: "alpha-second", title: "Second" };
    renderSection({ groups: [{ agent: alpha, threads: [working, second] }] });

    expect(screen.queryByRole("button", { name: /more ·/u })).toBeNull();
  });

  it("names the agent in its own overflow control, and offers the way back", () => {
    const more = (id: string) => ({ ...working, id, title: id });
    const groups = [{ agent: alpha, threads: [working, more("second"), more("third")] }];
    const props = renderSection({ groups });

    fireEvent.click(screen.getByRole("button", { name: "+1 more · Alpha" }));
    expect(props.onToggleAgent).toHaveBeenCalledWith("alpha");

    screen.getByRole("button", { name: "+1 more · Alpha" }).remove();
    render(
      <RunningSection
        groups={groups}
        expandedAgentIds={new Set(["alpha"])}
        onToggleAgent={props.onToggleAgent}
        onOpen={props.onOpen}
      />,
    );
    expect(screen.getByRole("button", { name: "Show fewer · Alpha" })).toBeVisible();
  });
});
