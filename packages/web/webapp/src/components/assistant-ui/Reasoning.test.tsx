import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../../styles.css";
import {
  ACTIVITY_GROUP_BY,
  ActivityGroup,
  REASONING_GROUP_BY,
  Reasoning,
  ReasoningGroup,
} from "./Reasoning";

describe("Reasoning", () => {
  it("streams a live thought open and lets a settled one fold away", () => {
    const thought = (type: string) => (
      <Reasoning
        type="reasoning"
        text="Working out where the state actually lives."
        status={{ type } as never}
      />
    );
    // Watching the model work is the whole reason Activity auto-opens, so a
    // thought still arriving must not be hidden behind a disclosure.
    const { container, rerender } = render(thought("running"));
    const row = container.querySelector("details.activity-row.is-thinking");
    expect(row).toHaveAttribute("open");

    // Settling removes the attribute rather than forcing the row shut, so a
    // reader who opened it by hand keeps it open.
    rerender(thought("complete"));
    expect(container.querySelector("details.activity-row.is-thinking"))
      .not.toHaveAttribute("open");
  });

  it("reads a thought's preview as prose, not as raw markdown", () => {
    const { container } = render(
      <Reasoning
        type="reasoning"
        text={"**Planning the fix**\n\nStart with `store.ts`"}
        status={{ type: "complete" }}
      />,
    );

    // The row's summary is the only thing most readers see; emphasis markers
    // would be the first characters their eye lands on.
    expect(container.querySelector(".activity-row-summary")?.textContent)
      .toBe("Planning the fix Start with store.ts");
    // The expanded body still shows what the model actually wrote.
    expect(container.querySelector(".activity-thought")?.textContent)
      .toContain("**Planning the fix**");
  });

  it("previews a long thought on the row and keeps the full text inside", () => {
    const { container } = render(
      <Reasoning
        type="reasoning"
        text={`${"considering the options ".repeat(6)}and then deciding`}
        status={{ type: "complete" }}
      />,
    );

    const summary = container.querySelector(".activity-row-summary");
    expect(summary?.textContent).toHaveLength(52);
    expect(summary?.textContent?.endsWith("\u2026")).toBe(true);
    expect(container.querySelector(".activity-thought")?.textContent)
      .toContain("and then deciding");
  });

  it("renders plain reasoning paragraphs while preserving single line breaks", () => {
    const { container } = render(
      <Reasoning
        type="reasoning"
        text={"First line\nSecond line\n\nAnother paragraph"}
        status={{ type: "complete" }}
      />,
    );

    const paragraphs = container.querySelectorAll("[data-slot='reasoning-paragraph']");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).toHaveTextContent("First lineSecond line");
    expect(paragraphs[0]?.querySelector("br")).not.toBeNull();
    expect(paragraphs[1]).toHaveTextContent("Another paragraph");
  });

  it("provides a stable grouped-parts mapping for adjacent reasoning parts", () => {
    expect(REASONING_GROUP_BY({
      type: "reasoning",
      text: "thinking",
      status: { type: "running" },
    })).toEqual(["group-reasoning"]);
    expect(REASONING_GROUP_BY({
      type: "text",
      text: "answer",
      status: { type: "complete" },
    })).toEqual([]);
  });

  it("groups reasoning and routine tools into one activity while leaving standalone tools outside", () => {
    expect(ACTIVITY_GROUP_BY({
      type: "reasoning",
      text: "thinking",
      status: { type: "running" },
    })).toEqual(["group-activity"]);
    expect(ACTIVITY_GROUP_BY({
      type: "tool-call",
      toolCallId: "tool-1",
      toolName: "inspect",
      args: {},
      argsText: "{}",
      status: { type: "running" },
    })).toEqual(["group-activity"]);
    expect(ACTIVITY_GROUP_BY({ type: "standalone-tool-call" } as never)).toEqual([]);
    // A delegation is user-visible activity, so it joins the same disclosure as
    // the tool calls around it rather than sitting loose in the transcript.
    expect(ACTIVITY_GROUP_BY({ type: "data", name: "subagent", data: {} } as never))
      .toEqual(["group-activity"]);
    expect(ACTIVITY_GROUP_BY({ type: "data", name: "telemetry", data: {} } as never)).toEqual([]);
  });
});

describe("ActivityGroup", () => {
  // Activity is a panel of rows, not a quoted aside: a reopened log scrolls with
  // the page instead of trapping the operator in a 256px window inside a message.
  it("never clamps its rows into an inner scroll, running or settled", () => {
    const { container, rerender } = render(
      <ActivityGroup streaming>
        <p>Live activity</p>
      </ActivityGroup>,
    );

    const runningText = container.querySelector<HTMLElement>("[data-slot='reasoning-text']");
    expect(runningText).not.toBeNull();
    const runningStyle = getComputedStyle(runningText!);
    expect(runningStyle.maxHeight).toBe("none");
    expect(runningStyle.overflowY).toBe("visible");
    // No clamp means no fade-out hinting at content below the fold.
    expect(runningStyle.maskImage).not.toContain("gradient");

    rerender(
      <ActivityGroup streaming={false}>
        <p>Finished activity</p>
      </ActivityGroup>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));

    const settledText = container.querySelector<HTMLElement>("[data-slot='reasoning-text']");
    expect(settledText).not.toBeNull();
    const settledStyle = getComputedStyle(settledText!);
    expect(settledStyle.maxHeight).toBe("none");
    expect(settledStyle.overflowY).toBe("visible");
  });

  /**
   * The rows sit in a one-column grid. Left implicit, that column is `auto`, so
   * it is sized by the widest row's *min-content* width — measured at 601px
   * inside a 342px panel on a phone, which `overflow: hidden` then clipped with
   * no way to scroll to the rest. jsdom performs no layout, so this pins the
   * declarations that prevent it rather than re-measuring; the resolved track
   * was verified in a browser at 390px and 1440px.
   */
  it("sizes its rows to the panel instead of to their widest content", () => {
    const { container } = render(
      <ActivityGroup streaming>
        <details className="activity-row"><summary>Row</summary></details>
      </ActivityGroup>,
    );

    const content = container.querySelector<HTMLElement>(".reasoning-text-content");
    expect(content).not.toBeNull();
    expect(getComputedStyle(content!).gridTemplateColumns).toBe("minmax(0, 1fr)");
    // A grid item only shrinks below min-content once its automatic minimum is
    // overridden, so the track alone is not enough.
    expect(getComputedStyle(container.querySelector<HTMLElement>(".activity-row")!).minWidth).toBe("0");
  });

  it("stays open while running, force-collapses on settle, and can be reopened afterward", () => {
    const { container, rerender } = render(
      <ActivityGroup streaming>
        <p>Live activity</p>
      </ActivityGroup>,
    );

    expect(container.querySelector(".activity-trigger .reasoning-trigger-icon")).toBeNull();
    const activeTrigger = screen.getByRole("button", { name: "Activity in progress" });
    expect(activeTrigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(activeTrigger);
    expect(activeTrigger).toHaveAttribute("aria-expanded", "true");

    rerender(
      <ActivityGroup streaming>
        <p>Live activity</p>
        <p>Another tool completed</p>
      </ActivityGroup>,
    );
    expect(screen.getByRole("button", { name: "Activity in progress" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("Another tool completed")).toBeVisible();

    rerender(
      <ActivityGroup streaming={false}>
        <p>Finished activity</p>
      </ActivityGroup>,
    );

    const settledTrigger = screen.getByRole("button", { name: "Activity" });
    expect(settledTrigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(settledTrigger);
    expect(settledTrigger).toHaveAttribute("aria-expanded", "true");
  });
});

describe("ReasoningGroup", () => {
  it("auto-opens while streaming and auto-collapses when the stream settles", () => {
    const { rerender } = render(
      <ReasoningGroup streaming>
        <p>Live reasoning</p>
      </ReasoningGroup>,
    );

    const trigger = screen.getByRole("button", { name: "Reasoning in progress" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector("[data-slot='reasoning-content']")).toHaveAttribute(
      "aria-busy",
      "true",
    );

    rerender(
      <ReasoningGroup streaming={false}>
        <p>Finished reasoning</p>
      </ReasoningGroup>,
    );

    expect(screen.getByRole("button", { name: "Reasoning" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("keeps the first manual choice across later streaming transitions", () => {
    const { rerender } = render(
      <ReasoningGroup streaming>
        <p>Live reasoning</p>
      </ReasoningGroup>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reasoning in progress" }));
    expect(screen.getByRole("button", { name: "Reasoning in progress" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    rerender(
      <ReasoningGroup streaming={false}>
        <p>Finished reasoning</p>
      </ReasoningGroup>,
    );
    expect(screen.getByRole("button", { name: "Reasoning" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    rerender(
      <ReasoningGroup streaming>
        <p>More reasoning</p>
      </ReasoningGroup>,
    );
    expect(screen.getByRole("button", { name: "Reasoning in progress" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("derives streaming state from a GroupedParts group status", () => {
    render(
      <ReasoningGroup status={{ type: "running" }}>
        <p>Grouped reasoning</p>
      </ReasoningGroup>,
    );

    expect(screen.getByRole("button", { name: "Reasoning in progress" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});
