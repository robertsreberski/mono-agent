import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { agent, project, thread } from "../../test/fixtures";
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
  it("never uses the selected agent's catalog for another agent's identical model ID", () => {
    const model = "local:shared-model";
    const alpha = agent("alpha", { defaultModel: "local:primary", defaultEffort: "high" });
    const beta = agent("beta", { defaultModel: "local:primary", defaultEffort: "low" });
    renderSection({
      groups: [alpha, beta].map((owner) => ({ agent: owner, threads: [thread(owner.sourceId, owner.sourceId, { runModel: model })] })),
      catalogSourceId: "alpha",
      catalogModels: { local: [{ id: "shared-model", provider: "local", providerLabel: "Local", name: "Alpha only", reasoning: false }] },
    });
    const cards = screen.getAllByRole("button", { name: /^Open/u });
    expect(within(cards[0]!).getByRole("img", { name: /Alpha only/u })).toHaveAccessibleName(/effort not reported/u);
    expect(within(cards[1]!).getByRole("img", { name: /local:shared-model/u })).toHaveAccessibleName(/effort Low/u);
    expect(within(cards[1]!).queryByRole("img", { name: /Alpha only/u })).toBeNull();
  });
  it("says which project a running conversation belongs to, across agents", () => {
    const beta = agent("beta", { label: "Beta" });
    const mine = thread("mine", "alpha", {
      title: "Mine",
      projectId: "p1",
      projectName: "Stale name",
      runState: { status: "running" },
    });
    const theirs = thread("theirs", "beta", {
      title: "Theirs",
      projectId: "p9",
      projectName: "Their project",
      runState: { status: "running" },
    });
    renderSection({
      groups: [
        { agent: alpha, threads: [mine, working] },
        { agent: beta, threads: [theirs] },
      ],
      projectsByAgent: { alpha: [project("p1", "alpha", { name: "Console work", color: "blue" })] },
    });

    // A project's conversations are no longer in the agent's list, so the card
    // is where the operator learns this one is a project chat.
    const card = screen.getByRole("button", { name: "Open Mine on Alpha, in project Console work" });
    expect(within(card).getByTitle("In project Console work")).toHaveTextContent("Console work");
    // Another agent's card labels itself with the name its own row carries.
    expect(screen.getByRole("button", { name: "Open Theirs on Beta, in project Their project" }))
      .toBeInTheDocument();
    // A conversation that belongs to its agent says nothing at all.
    const plain = screen.getByRole("button", { name: "Open Alpha work on Alpha" });
    expect(within(plain).queryByTitle(/^In project/u)).toBeNull();
  });

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

  it("counts the whole fleet, not the cards it could fit", () => {
    renderSection({ total: 63, truncated: true });

    const heading = screen.getByRole("heading", { name: "Running, 63" });
    expect(heading.querySelector(".dashboard-section-count"))
      .toHaveAttribute("title", "Conversations running across the fleet");
    // The cards are part of the answer, and the section says which part.
    expect(screen.getByText("Showing 1 of 63")).toBeVisible();
  });

  it("says LAST KNOWN rather than letting a stale count pass for the fleet", () => {
    renderSection({ authoritative: false });

    expect(screen.getByRole("heading", { name: "Running, 1, last known" })).toBeVisible();
    expect(screen.getByText("last known")).toBeVisible();
    expect(screen.queryByText(/Showing/u)).toBeNull();
  });

  it("draws what a turn is doing, and stays quiet about what it has not been told", () => {
    const asking = {
      ...working,
      id: "alpha-asking",
      title: "Asking",
      runState: { status: "running" as const, activity: { toolCallCount: 0, phase: "asking" as const } },
    };
    const priced = {
      ...working,
      id: "alpha-priced",
      title: "Priced",
      runState: {
        status: "running" as const,
        activity: { toolCallCount: 11, phase: "working" as const, cumulativeUsd: 2.44 },
      },
    };
    renderSection({ groups: [{ agent: alpha, threads: [asking, priced, working] }],
      expandedAgentIds: new Set(["alpha"]) });

    expect(screen.getByRole("button", { name: /^Open Asking/u }))
      .toHaveTextContent("Asking you a question");
    expect(screen.getByRole("button", { name: /^Open Priced/u }))
      .toHaveTextContent("Working · 11 tool calls · $2.44");
    // Nothing reported yet: the shared wording, stated quietly, and never
    // "0 tool calls" -- which would report an absence of evidence as evidence.
    const quiet = screen.getByRole("button", { name: /^Open Alpha work/u });
    expect(quiet).toHaveTextContent("Working…");
    expect(quiet.querySelector(".running-card-status")).toHaveClass("is-pending");
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
