import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { agent, thread } from "../test/fixtures";
import type { AgentSummary, ThreadSummary } from "../types";
import { ActivityRow } from "./ActivityRow";
import { resolveThreadRoute } from "./route-label";
import { RouteBadge } from "./RouteBadge";
import { SubagentPart } from "./Subagent";

type SubagentProps = Parameters<typeof SubagentPart>[0];
const part = (data: unknown) =>
  <SubagentPart {...({ data } as unknown as SubagentProps)} />;

/** The row label exactly as Recent/Running/Search render it. */
function RowLabel({ row, owner }: {
  readonly row: ThreadSummary;
  readonly owner: AgentSummary | null;
}) {
  const route = resolveThreadRoute(row, owner);
  return (
    <RouteBadge
      modelShort={route.modelShort}
      effortShort={route.effortShort}
      label={route.label}
      title={route.title}
    />
  );
}

const owner = (): AgentSummary => agent("alpha", {
  label: "Alpha",
  models: ["anthropic:claude-sonnet-4.5"],
  defaultModel: "anthropic:claude-sonnet-4.5",
  defaultEffort: "high",
  modelOptions: {
    "anthropic:claude-sonnet-4.5": {
      label: "Claude Sonnet 4.5",
      reasoning: true,
      effortLevels: ["medium", "high"],
    },
  },
});

describe("RouteBadge", () => {
  it("shows the short words while the accessible name keeps the whole route", () => {
    render(
      <RouteBadge
        modelShort="Sol"
        effortShort="H"
        label="Model GPT-5.6 Sol (openai-codex:gpt-5.6-sol), effort High, conversation override"
        title="Model GPT-5.6 Sol (openai-codex:gpt-5.6-sol), effort High, conversation override"
      />,
    );
    const badge = screen.getByRole("img", {
      name: "Model GPT-5.6 Sol (openai-codex:gpt-5.6-sol), effort High, conversation override",
    });
    expect(badge).toHaveTextContent("Sol");
    expect(badge).toHaveTextContent("H");
    expect(badge).toHaveAttribute(
      "title",
      "Model GPT-5.6 Sol (openai-codex:gpt-5.6-sol), effort High, conversation override",
    );
  });

  it("is a span, so it never nests a button inside a navigating row", () => {
    const { container } = render(
      <button type="button">
        <RouteBadge modelShort="Sol" effortShort="H" label="route" title="route" />
      </button>,
    );
    expect(container.querySelector(".route-badge")?.tagName).toBe("SPAN");
    expect(container.querySelector(".route-badge button")).toBeNull();
  });
});

describe("row labels without opening the conversation", () => {
  it("moves with a thread SSE patch to another row", () => {
    const first = thread("t1", "alpha", { title: "First" });
    const second = thread("t2", "alpha", {
      title: "Second",
      runModel: "openai-codex:gpt-5.6-sol",
      runEffort: "low",
    });
    const { rerender } = render(<RowLabel row={first} owner={owner()} />);
    expect(screen.getByRole("img").textContent).toContain("Sonnet");

    // A list update or SSE projection lands: the badge follows the new thread,
    // with no selection, navigation or reload involved.
    rerender(<RowLabel row={second} owner={owner()} />);
    const badge = screen.getByRole("img");
    expect(badge.textContent).toContain("Sol");
    expect(badge.textContent).toContain("L");
    expect(badge).toHaveAccessibleName(/conversation override/u);
  });

  it("moves with a settings patch to the agent defaults", () => {
    const row = thread("t1", "alpha", { title: "First" });
    const { rerender } = render(<RowLabel row={row} owner={owner()} />);
    expect(screen.getByRole("img").textContent).toContain("Sonnet");

    rerender(<RowLabel
      row={row}
      owner={agent("alpha", {
        label: "Alpha",
        models: ["openai-codex:gpt-5.6-sol"],
        defaultModel: "openai-codex:gpt-5.6-sol",
        defaultEffort: "low",
        modelOptions: {
          "openai-codex:gpt-5.6-sol": {
            label: "GPT-5.6 Sol",
            reasoning: true,
            effortLevels: ["low", "high"],
          },
        },
      })}
    />);
    const badge = screen.getByRole("img");
    expect(badge.textContent).toContain("Sol");
    expect(badge).toHaveAccessibleName(/inherited agent defaults/u);
  });
});

describe("subagent collapsed badges", () => {
  const delegation = {
    type: "subagent",
    toolCallId: "call-1",
    name: "researcher",
    label: "read the router",
    status: "complete",
    executionMs: 1_000,
    args: { name: "researcher", prompt: "Read the router." },
    result: "done",
    calls: [
      { toolCallId: "c1", toolName: "Read", args: { file_path: "/repo/a.ts" }, result: "body", status: "complete" },
    ],
  };

  it("badges a completed delegation with its executed route", () => {
    render(part({
      ...delegation,
      attribution: {
        requested: { model: "primary", effort: "high" },
        executed: { model: "anthropic:claude-sonnet-4.5", effort: "high" },
        disposition: "requested",
        transitions: [],
        retries: [],
      },
    }));
    const badge = screen.getByRole("img", { name: /Subagent route: Ran with/u });
    expect(badge.textContent).toContain("Sonnet");
    // The expanded routing detail stays where it was.
    expect(screen.getByText(/Ran with/u)).toBeInTheDocument();
  });

  it("marks requested-only as requested, never as ran-with", () => {
    render(part({
      ...delegation,
      status: "running",
      executionMs: undefined,
      attribution: {
        requested: { model: "anthropic:claude-sonnet-4.5", effort: "high" },
        disposition: "requested",
        transitions: [],
        retries: [],
      },
    }));
    const badge = screen.getByRole("img", { name: /requested, not a confirmed run/u });
    expect(badge).toHaveClass("is-requested");
    expect(badge.textContent).toContain("Sonnet");
  });

  it("keeps a fallback flagged while folded and honest about effective effort", () => {
    render(part({
      ...delegation,
      attribution: {
        requested: { model: "primary", effort: "high" },
        executed: { model: "fallback", effort: "xhigh", effectiveEffort: "max" },
        disposition: "fallback",
        transitions: [{ from: "primary", to: "fallback", reason: "overloaded" }],
        retries: [],
      },
    }));
    const badge = screen.getByRole("img", { name: /Fallback/u });
    expect(badge).toHaveClass("is-fallback");
    expect(badge.textContent).toContain("Max");
    expect(badge).toHaveAccessibleName(/requested High/u);
    expect(badge).toHaveAccessibleName(/effective Max/u);
  });

  it("invents no badge for attribution-free records", () => {
    const { container } = render(part(delegation));
    expect(container.querySelector(".route-badge")).toBeNull();
    expect(screen.getByText("researcher — read the router")).toBeVisible();
  });
});

describe("ActivityRow badge slot", () => {
  it("stays backward compatible: no badge changes nothing and disclosure still works", () => {
    const { container } = render(
      <ActivityRow label="Read" summary="a.ts" duration="12ms">
        <p>body</p>
      </ActivityRow>,
    );
    expect(container.querySelector(".activity-row-badge")).toBeNull();
    const row = container.querySelector("details.activity-row")!;
    expect(row).not.toHaveAttribute("open");
    fireEvent.click(row.querySelector("summary")!);
    expect(row).toHaveAttribute("open");
  });

  it("renders the badge inside the collapsed line without breaking the toggle", () => {
    const { container } = render(
      <ActivityRow
        variant="subagent"
        label="Subagent"
        summary="researcher — read the router"
        duration="1 tool"
        badge={<RouteBadge modelShort="Sol" effortShort="H" label="route" title="route" compact />}
      >
        <p>body</p>
      </ActivityRow>,
    );
    const row = container.querySelector("details.activity-row.is-subagent")!;
    expect(row).not.toHaveAttribute("open");
    expect(row.querySelector(".activity-row-badge .route-badge")).not.toBeNull();
    fireEvent.click(row.querySelector("summary")!);
    expect(row).toHaveAttribute("open");
    expect(screen.getByText("body")).toBeVisible();
  });
});
