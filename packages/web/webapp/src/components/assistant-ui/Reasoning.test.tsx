import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  REASONING_GROUP_BY,
  Reasoning,
  ReasoningGroup,
} from "./Reasoning";

describe("Reasoning", () => {
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
