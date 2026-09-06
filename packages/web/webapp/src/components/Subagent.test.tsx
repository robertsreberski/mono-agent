import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SubagentPart, toolArgumentPreview } from "./Subagent";
import { ToolCallRepairProvider } from "./tool-call-repair";

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

    const section = container.querySelector("details.activity-row.is-subagent");
    expect(section).toBeInTheDocument();
    // Closed by default: the operator clicks to see the calls, exactly like
    // every other row in the activity log.
    expect(section).not.toHaveAttribute("open");
    // The summary names which delegation this is; the meta slot says what it cost.
    expect(screen.getByText("researcher — read the router")).toBeVisible();
    expect(screen.getByText("2 tools · 12.4s")).toBeVisible();

    // The calls live inside the collapsed section — present in the DOM but
    // hidden until the operator opens it, which is the whole point of folding.
    const nested = section?.querySelectorAll("details.activity-step") ?? [];
    expect(nested).toHaveLength(4);
    expect(within(nested[1] as HTMLElement).getByText("Read")).not.toBeVisible();
    expect(within(nested[2] as HTMLElement).getByText("Grep")).toBeInTheDocument();
    // A failed child is marked without failing the delegation that contains it.
    expect(within(nested[2] as HTMLElement).getByText("failed")).toBeInTheDocument();
    expect(section).not.toHaveClass("is-failed");
  });

  it("previews each call's key argument so repeated tools stay distinguishable", () => {
    const { container } = render(part(delegation));

    const nested = container.querySelectorAll("details.activity-step");
    expect(within(nested[1] as HTMLElement).getByText("/repo/a.ts")).toBeInTheDocument();
    expect(within(nested[2] as HTMLElement).getByText("x")).toBeInTheDocument();
    // A step says nothing about a call that simply worked; a failure is the one
    // thing worth calling out at this depth.
    expect(within(nested[1] as HTMLElement).queryByText("done")).not.toBeInTheDocument();
    expect(within(nested[2] as HTMLElement).getByText("failed")).toBeInTheDocument();
  });

  it("clusters repeated nested calls and exposes durations and errors per step", () => {
    render(part({
      ...delegation,
      calls: [
        { toolCallId: "t1", toolName: "Read", args: { path: "one.md" }, result: "one", executionMs: 100, status: "complete" },
        { toolCallId: "t2", toolName: "Read", args: { path: "two.md" }, result: { error: "denied" }, executionMs: 200, status: "failed", history: { persistence: "failed", errorCode: "history_writer_closed", untrusted: true } },
      ],
    }));

    // A delegation never grows a third tier of disclosure: repeated calls become
    // one step whose payload holds every member.
    expect(screen.getByText("Read ×2")).toBeInTheDocument();
    expect(screen.getByText("1 failed")).toBeInTheDocument();
    expect(screen.getByText("300ms")).toBeInTheDocument();
    const step = screen.getByText("Read ×2").closest("details")!;
    fireEvent.click(screen.getByText("Read ×2").closest("summary")!);
    const input = step.querySelector(".activity-payload pre")!;
    expect(input.textContent).toContain("one.md");
    expect(input.textContent).toContain("two.md");
    expect(screen.getByText(/history_writer_closed/u)).toBeInTheDocument();
  });

  it("says where an unsettled call stands, and stays quiet about a settled one", () => {
    const { container } = render(part({
      ...delegation,
      calls: [
        { toolCallId: "t1", toolName: "Bash", args: {}, result: "ok", status: "complete" },
        { toolCallId: "t2", toolName: "Sleep", args: {}, status: "running" },
      ],
    }));

    const steps = container.querySelectorAll("details.activity-step");
    expect(within(steps[1] as HTMLElement).queryByText("done")).not.toBeInTheDocument();
    expect(within(steps[2] as HTMLElement).getByText("running")).toBeInTheDocument();
  });

  it("shows the delegated task and the report as their own folded rows", () => {
    const { container } = render(part(delegation));

    const notes = [...container.querySelectorAll("details.activity-step")].filter((note) =>
      ["Task", "Report"].includes(note.querySelector(".activity-step-tool")?.textContent ?? ""));
    expect(notes).toHaveLength(2);
    // Both are folded: the point of the block is that it stays one line until
    // the operator asks for more.
    for (const note of notes) expect(note).not.toHaveAttribute("open");
    expect(screen.getByText("Task")).toBeInTheDocument();
    expect(screen.getByText("Read the router and report what it does.")).toBeInTheDocument();
    expect(screen.getByText("Report")).toBeInTheDocument();
    expect(screen.getByText(/subagent: researcher/u)).toBeInTheDocument();
  });

  it("says a truncated report is a preview and loads the whole of it", async () => {
    const repair = vi.fn(async (_toolCallId: string) => true);
    render(
      <ToolCallRepairProvider repair={repair}>
        {part({
          ...delegation,
          result: "HEAD of the report",
          resultTruncated: true,
          resultBytes: 20_480,
        })}
      </ToolCallRepairProvider>,
    );

    expect(screen.getByText("Preview only, 20,480 chars.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load full output" }));
    // The delegation's own report belongs to the parent `Agent` call, which is
    // exactly what the full-body route is addressed by.
    expect(repair).toHaveBeenCalledWith("call-1");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("says a truncated task is a preview, and reports a repair that found nothing", async () => {
    const repair = vi.fn(async (_toolCallId: string) => false);
    render(
      <ToolCallRepairProvider repair={repair}>
        {part({
          ...delegation,
          args: { name: "researcher", prompt: "Read the router and rep" },
          argsTruncated: true,
          argsBytes: 6_100,
        })}
      </ToolCallRepairProvider>,
    );

    expect(screen.getByText("Preview only, 6,100 chars.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load full output" }));
    expect(repair).toHaveBeenCalledWith("call-1");
    // A repair that replaced nothing is not a load that worked.
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the full output.");
  });

  it("reports a repair the transport never answered", async () => {
    // What a bounded read does when it times out: the deadline rejects, and the
    // row has to say so rather than sit on "Loading..." with the button gone.
    const repair = vi.fn(async (_toolCallId: string) => {
      throw new Error("Request timed out.");
    });
    render(
      <ToolCallRepairProvider repair={repair}>
        {part({ ...delegation, result: "HEAD", resultTruncated: true, resultBytes: 20_480 })}
      </ToolCallRepairProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Load full output" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the full output.");
  });

  it("offers a loader on a clustered step whose members were truncated", async () => {
    const repair = vi.fn(async (_toolCallId: string) => true);
    render(
      <ToolCallRepairProvider repair={repair}>
        {part({
          ...delegation,
          result: undefined,
          calls: [
            { toolCallId: "c1", toolName: "Read", args: { file_path: "/repo/a.ts" }, result: "HEAD", resultTruncated: true, resultBytes: 20_480, status: "complete" },
            { toolCallId: "c2", toolName: "Read", args: { file_path: "/repo/b.ts" }, result: "small", status: "complete" },
            { toolCallId: "c3", toolName: "Read", args: { file_path: "/repo/c.ts" }, result: "HEAD", resultTruncated: true, resultBytes: 10_240, status: "complete" },
          ],
        })}
      </ToolCallRepairProvider>,
    );

    // One joined panel for the run, so the notice counts every truncated member
    // and its loader repairs each of them.
    expect(screen.getByText("Preview only, 30,720 chars.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load full output" }));
    // One control, every truncated member, one at a time: each repair rewrites
    // the same conversation state.
    await waitFor(() => expect(repair.mock.calls.map(([id]) => id)).toEqual(["c1", "c3"]));
  });

  it("marks a truncated report even when the server sent no size for it", async () => {
    // The flags and the byte count are independent: `resultBytes` is optional on
    // the wire, and a note that only marked the sized ones rendered the head of
    // a report as if it were the whole of it.
    const repair = vi.fn(async (_toolCallId: string) => true);
    render(
      <ToolCallRepairProvider repair={repair}>
        {part({ ...delegation, result: "HEAD of the report", resultTruncated: true })}
      </ToolCallRepairProvider>,
    );

    expect(screen.getByText("Preview only.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load full output" }));
    await waitFor(() => expect(repair).toHaveBeenCalledWith("call-1"));
  });

  it("keeps a Task note for a delegation whose arguments came back as a JSON head", async () => {
    // `shapedArgsObject` falls back to the whole-value head when no string leaf
    // can pay the budget. The note used to disappear with the object, taking the
    // only way to ask for the real arguments with it.
    const repair = vi.fn(async (_toolCallId: string) => true);
    render(
      <ToolCallRepairProvider repair={repair}>
        {part({
          ...delegation,
          args: '{"name":"researcher","prompt":"Read the ro',
          argsTruncated: true,
          argsBytes: 6_100,
        })}
      </ToolCallRepairProvider>,
    );

    expect(screen.getByText("Task")).toBeInTheDocument();
    expect(screen.getByText('{"name":"researcher","prompt":"Read the ro')).toBeInTheDocument();
    expect(screen.getByText("Preview only, 6,100 chars.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load full output" }));
    await waitFor(() => expect(repair).toHaveBeenCalledWith("call-1"));
  });

  it("still offers the arguments when truncation left nothing readable of them", async () => {
    const repair = vi.fn(async (_toolCallId: string) => true);
    render(
      <ToolCallRepairProvider repair={repair}>
        {part({ ...delegation, args: " ", argsTruncated: true, argsBytes: 6_100 })}
      </ToolCallRepairProvider>,
    );

    // No prose to show, but the delegation still has arguments and the operator
    // can still ask for them.
    expect(screen.getByText("Task")).toBeInTheDocument();
    expect(screen.getByText("Preview only, 6,100 chars.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load full output" }));
    await waitFor(() => expect(repair).toHaveBeenCalledWith("call-1"));
  });

  it("gives one control to a delegation whose task and report were both cut", () => {
    // One repair fetches the whole part, so one control asks for it. Two buttons
    // for one round trip is two ways to do the same thing, and the second reads
    // as if it fetched something else.
    const repair = vi.fn(async (_toolCallId: string) => true);
    render(
      <ToolCallRepairProvider repair={repair}>
        {part({
          ...delegation,
          args: { name: "researcher", prompt: "Read the ro" },
          argsTruncated: true,
          argsBytes: 6_100,
          result: "HEAD of the report",
          resultTruncated: true,
          resultBytes: 20_480,
        })}
      </ToolCallRepairProvider>,
    );

    // Both notes still say they are previews; the Task note owns the control.
    expect(screen.getByText("Preview only, 6,100 chars.")).toBeInTheDocument();
    expect(screen.getByText("Preview only, 20,480 chars.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Load full output" })).toHaveLength(1);
  });

  it("says only that a clustered member is a preview when it carries no size", () => {
    const repair = vi.fn(async (_toolCallId: string) => true);
    render(
      <ToolCallRepairProvider repair={repair}>
        {part({
          ...delegation,
          result: undefined,
          calls: [
            { toolCallId: "c1", toolName: "Read", args: { file_path: "/repo/a.ts" }, result: "HEAD", resultTruncated: true, status: "complete" },
            { toolCallId: "c2", toolName: "Read", args: { file_path: "/repo/b.ts" }, result: "small", status: "complete" },
          ],
        })}
      </ToolCallRepairProvider>,
    );

    // A member with no reported size must not be summed as zero: "0 chars" is a
    // measurement, and there is not one.
    expect(screen.getByText("Preview only.")).toBeInTheDocument();
    expect(screen.queryByText(/0 chars/u)).toBeNull();
    expect(screen.getAllByRole("button", { name: "Load full output" })).toHaveLength(1);
  });

  it("does not undercount a cluster where only some members reported a size", () => {
    const repair = vi.fn(async (_toolCallId: string) => true);
    render(
      <ToolCallRepairProvider repair={repair}>
        {part({
          ...delegation,
          result: undefined,
          calls: [
            { toolCallId: "c1", toolName: "Read", args: { file_path: "/repo/a.ts" }, result: "HEAD", resultTruncated: true, resultBytes: 20_480, status: "complete" },
            { toolCallId: "c2", toolName: "Read", args: { file_path: "/repo/b.ts" }, result: "HEAD", resultTruncated: true, status: "complete" },
          ],
        })}
      </ToolCallRepairProvider>,
    );

    // Summing the one member that reported would claim 20,480 for two truncated
    // bodies. Saying nothing is the only honest answer available.
    expect(screen.getByText("Preview only.")).toBeInTheDocument();
    expect(screen.queryByText(/20,480 chars/u)).toBeNull();
  });

  it("keeps deferred parent history quiet while reconciliation continues", () => {
    render(part({
      ...delegation,
      history: { persistence: "deferred", untrusted: true },
    }));

    expect(screen.queryByText(/history not saved/iu)).toBeNull();
    expect(screen.queryByText("History")).toBeNull();
    expect(screen.queryByText(/Tool history for this call was not saved/iu)).toBeNull();
  });

  it("shows durable history only for the parent delegation record", () => {
    const { container } = render(part({
      ...delegation,
      history: {
        persistence: "failed",
        errorCode: "history_persistence_timeout",
        untrusted: true,
      },
    }));

    expect(screen.getByText("2 tools · 12.4s · history not saved")).toBeVisible();
    expect(screen.getByText("History")).toBeInTheDocument();
    expect(
      screen.getByText("Tool history for this call was not saved (history_persistence_timeout)."),
    ).toBeInTheDocument();
    // Two calls plus the Task, Report, and History notes.
    expect(container.querySelectorAll("details.activity-step")).toHaveLength(5);
  });

  it("omits the task row when the delegation carries no prompt", () => {
    render(part({ ...delegation, args: { name: "researcher" } }));

    expect(screen.queryByText("Task")).not.toBeInTheDocument();
    expect(screen.getByText("Report")).toBeInTheDocument();
  });

  it("marks a failed delegation and says so when it recorded no calls", () => {
    const { container } = render(part({ ...delegation, status: "failed", calls: [], result: undefined }));

    // The row's own colour and tag carry the outcome, so the meta slot does not
    // repeat it.
    expect(container.querySelector("details.activity-row.is-subagent")).toHaveClass("is-failed");
    expect(screen.getByText("failed")).toBeVisible();
    expect(screen.getByText("0 tools · 12.4s")).toBeVisible();
    expect(screen.getByText("No tool calls recorded.")).toBeInTheDocument();
    expect(screen.queryByText("Report")).not.toBeInTheDocument();
  });

  it("keeps a running delegation's pulse until it settles", () => {
    const { container } = render(part({ ...delegation, status: "running", executionMs: undefined }));

    expect(container.querySelector(".activity-row.is-subagent.is-running")).toBeInTheDocument();
    expect(screen.getByText("2 tools")).toBeVisible();
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

    // The surviving call, plus the Task and Report notes.
    expect(container.querySelectorAll("details.activity-step")).toHaveLength(3);
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
    expect(toolArgumentPreview([1, 2])).toBeUndefined();
    expect(toolArgumentPreview({})).toBeUndefined();
    expect(toolArgumentPreview({ file_path: "   " })).toBeUndefined();
    expect(toolArgumentPreview("   ")).toBeUndefined();
  });

  it("previews arguments the server truncated, which arrive as their JSON head", () => {
    // Over 4 KB of arguments reach the browser as the head of their JSON text
    // rather than as an object. A row that showed nothing for those would go
    // anonymous exactly where it was carrying the most.
    expect(toolArgumentPreview('{"file_path":"/repo/store.ts","content":"aaa'))
      .toBe('{"file_path":"/repo/store.ts","content":"aaa');
    expect(toolArgumentPreview(`{"prompt":"${"word ".repeat(40)}`))
      .toBe(`{"prompt":"${"word ".repeat(12)}…`);
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
