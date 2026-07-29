import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SubagentPart } from "./Messages";

type SubagentProps = Parameters<typeof SubagentPart>[0];

const part = (data: unknown) =>
  // The component only reads `data`; assistant-ui supplies the rest of the part
  // props, which this rendering never touches.
  <SubagentPart {...({ data } as unknown as SubagentProps)} />;

const delegation = {
  type: "subagent",
  toolCallId: "call-1",
  name: "researcher",
  label: "read the router",
  status: "complete",
  executionMs: 12_400,
  result: "<subagent: researcher · ok>",
  calls: [
    { toolCallId: "agent:call-1:t1", toolName: "Read", args: { file_path: "/repo/a.ts" }, result: "body", status: "complete" },
    { toolCallId: "agent:call-1:t2", toolName: "Grep", args: { pattern: "x" }, status: "failed" },
  ],
};

describe("SubagentPart", () => {
  it("renders one foldable section that owns the subagent's tool calls", () => {
    const { container } = render(part(delegation));

    const section = container.querySelector("details.subagent");
    expect(section).toBeInTheDocument();
    // Closed by default: the operator clicks to see the calls, exactly like
    // every other tool row in the transcript.
    expect(section).not.toHaveAttribute("open");
    expect(screen.getByText("researcher")).toBeVisible();
    expect(screen.getByText("read the router")).toBeVisible();
    expect(screen.getByText("2 tool calls · 12.4s")).toBeVisible();

    // The calls live inside the collapsed section — present in the DOM but
    // hidden until the operator opens it, which is the whole point of folding.
    const nested = section?.querySelectorAll("details.tool-call.is-nested") ?? [];
    expect(nested).toHaveLength(2);
    expect(within(nested[0] as HTMLElement).getByText("Read")).not.toBeVisible();
    expect(within(nested[1] as HTMLElement).getByText("Grep")).toBeInTheDocument();
    // A failed child is marked without failing the delegation that contains it.
    expect(nested[1]).toHaveClass("is-error");
    expect(section).not.toHaveClass("is-error");
  });

  it("shows the report the subagent sent back", () => {
    render(part(delegation));
    expect(screen.getByText("Report")).toBeInTheDocument();
    expect(screen.getByText(/subagent: researcher/u)).toBeInTheDocument();
  });

  it("marks a failed delegation and says so when it recorded no calls", () => {
    const { container } = render(part({ ...delegation, status: "failed", calls: [], result: undefined }));

    expect(container.querySelector("details.subagent")).toHaveClass("is-error");
    expect(screen.getByText("0 tool calls · 12.4s")).toBeVisible();
    expect(screen.getByText("No tool calls recorded.")).toBeInTheDocument();
    expect(screen.queryByText("Report")).not.toBeInTheDocument();
  });

  it("keeps a running delegation's pulse until it settles", () => {
    const { container } = render(part({ ...delegation, status: "running", executionMs: undefined }));

    expect(container.querySelector(".tool-status.is-running")).toBeInTheDocument();
    expect(screen.getByText("2 tool calls")).toBeVisible();
  });

  it("renders nothing rather than throwing on a malformed part", () => {
    // A newer agent, a truncated payload, or a replayed row must not blank the
    // whole transcript.
    expect(render(part({ calls: [] })).container).toBeEmptyDOMElement();
    expect(render(part(null)).container).toBeEmptyDOMElement();
  });

  it("drops malformed child entries instead of the whole delegation", () => {
    const { container } = render(part({
      ...delegation,
      calls: [{ toolCallId: "ok", toolName: "Read", status: "complete" }, { toolName: 42 }, null],
    }));

    expect(container.querySelectorAll("details.tool-call.is-nested")).toHaveLength(1);
    expect(screen.getByText("1 tool call · 12.4s")).toBeVisible();
  });
});
