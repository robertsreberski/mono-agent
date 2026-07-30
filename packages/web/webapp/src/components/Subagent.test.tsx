import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SubagentPart, toolArgumentPreview } from "./Subagent";

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
  args: { name: "researcher", prompt: "Read the router and report what it does." },
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
    expect(screen.getByText("2 tools · 12.4s")).toBeVisible();

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

  it("previews each call's key argument so repeated tools stay distinguishable", () => {
    const { container } = render(part(delegation));

    const nested = container.querySelectorAll("details.tool-call.is-nested");
    expect(within(nested[0] as HTMLElement).getByText("/repo/a.ts")).toBeInTheDocument();
    expect(within(nested[1] as HTMLElement).getByText("x")).toBeInTheDocument();
    // A settled call that has a preview does not also repeat its status word;
    // an unsettled one still says where it stands.
    expect(within(nested[0] as HTMLElement).queryByText("done")).not.toBeInTheDocument();
    expect(within(nested[1] as HTMLElement).getByText("failed")).toBeInTheDocument();
  });

  it("falls back to the status word when a call carries no previewable argument", () => {
    const { container } = render(part({
      ...delegation,
      calls: [{ toolCallId: "t1", toolName: "Bash", args: {}, result: "ok", status: "complete" }],
    }));

    const row = container.querySelector("details.tool-call.is-nested") as HTMLElement;
    expect(within(row).getByText("done")).toBeInTheDocument();
  });

  it("shows the delegated task and the report as their own folded rows", () => {
    const { container } = render(part(delegation));

    const notes = container.querySelectorAll("details.tool-call.subagent-note");
    expect(notes).toHaveLength(2);
    // Both are folded: the point of the block is that it stays one line until
    // the operator asks for more.
    for (const note of notes) expect(note).not.toHaveAttribute("open");
    expect(screen.getByText("Task")).toBeInTheDocument();
    expect(screen.getByText("Read the router and report what it does.")).toBeInTheDocument();
    expect(screen.getByText("Report")).toBeInTheDocument();
    expect(screen.getByText(/subagent: researcher/u)).toBeInTheDocument();
  });

  it("omits the task row when the delegation carries no prompt", () => {
    render(part({ ...delegation, args: { name: "researcher" } }));

    expect(screen.queryByText("Task")).not.toBeInTheDocument();
    expect(screen.getByText("Report")).toBeInTheDocument();
  });

  it("marks a failed delegation and says so when it recorded no calls", () => {
    const { container } = render(part({ ...delegation, status: "failed", calls: [], result: undefined }));

    expect(container.querySelector("details.subagent")).toHaveClass("is-error");
    expect(screen.getByText("0 tools · failed · 12.4s")).toBeVisible();
    expect(screen.getByText("No tool calls recorded.")).toBeInTheDocument();
    expect(screen.queryByText("Report")).not.toBeInTheDocument();
  });

  it("keeps a running delegation's pulse until it settles", () => {
    const { container } = render(part({ ...delegation, status: "running", executionMs: undefined }));

    expect(container.querySelector(".tool-status.is-running")).toBeInTheDocument();
    expect(screen.getByText("2 tools · running")).toBeVisible();
  });

  it("prices a delegation in its header, where an expensive one is identifiable", () => {
    // The run total this folds into cannot say which delegation spent it.
    render(part({ ...delegation, costUsd: 0.0042 }));

    expect(screen.getByText("2 tools · 12.4s · $0.0042")).toBeVisible();
  });

  it("omits the price, and its separator, when the runtime priced nothing", () => {
    render(part({ ...delegation, costUsd: 0 }));

    expect(screen.getByText("2 tools · 12.4s")).toBeVisible();
  });

  it("says one tool in the singular", () => {
    render(part({ ...delegation, calls: [delegation.calls[0]] }));

    expect(screen.getByText("1 tool · 12.4s")).toBeVisible();
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
    expect(screen.getByText("1 tool · 12.4s")).toBeVisible();
  });
});

describe("toolArgumentPreview", () => {
  it("prefers the argument that identifies the work", () => {
    expect(toolArgumentPreview({ file_path: "src/a.ts", offset: 10 })).toBe("src/a.ts");
    // A path outranks the pattern when a tool sends both.
    expect(toolArgumentPreview({ pattern: "windowMs", path: "packages/web" })).toBe("packages/web");
    expect(toolArgumentPreview({ command: "pnpm test", description: "run tests" })).toBe("pnpm test");
  });

  it("falls back to the first string argument for tools it does not know", () => {
    expect(toolArgumentPreview({ limit: 5, needle: "router" })).toBe("router");
  });

  it("has nothing to show for a non-object or empty argument set", () => {
    expect(toolArgumentPreview(undefined)).toBeUndefined();
    expect(toolArgumentPreview("just a string")).toBeUndefined();
    expect(toolArgumentPreview([1, 2])).toBeUndefined();
    expect(toolArgumentPreview({})).toBeUndefined();
    expect(toolArgumentPreview({ file_path: "   " })).toBeUndefined();
  });

  it("flattens whitespace so a multi-line argument stays one row", () => {
    expect(toolArgumentPreview({ query: "  find   the\nrouter  " })).toBe("find the router");
  });

  it("truncates a long path from the left so the filename survives", () => {
    const preview = toolArgumentPreview({ file_path: `/repo/${"nested/".repeat(20)}store.ts` });

    expect(preview).toHaveLength(72);
    expect(preview?.startsWith("…")).toBe(true);
    expect(preview?.endsWith("store.ts")).toBe(true);
  });

  it("truncates a long non-path from the right", () => {
    const preview = toolArgumentPreview({ prompt: "a".repeat(200) });

    expect(preview).toHaveLength(72);
    expect(preview?.startsWith("aaa")).toBe(true);
    expect(preview?.endsWith("…")).toBe(true);
  });
});
