import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContextDisplay } from "./ContextDisplay";

describe("ContextDisplay", () => {
  it("opens a portaled token and cost breakdown from its compact trigger", async () => {
    const { container } = render(
      <ContextDisplay
        className="compact-context"
        usage={{
          input: 1_000,
          cachedInput: 200,
          cacheCreation: 100,
          output: 50,
          reasoning: 25,
          cost: 0.0042,
        }}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "Context usage: 1.1k tokens, $0.0042",
    });
    expect(trigger).toHaveTextContent("1.1k tokens");
    expect(trigger).toHaveTextContent("$0.0042");
    expect(trigger).toHaveClass("context-display-trigger", "compact-context");
    expect(trigger).toHaveAttribute("data-slot", "context-display-trigger");

    fireEvent.click(trigger);
    const popover = await screen.findByRole("dialog", { name: "Context usage" });
    expect(container).not.toContainElement(popover);
    expect(within(popover).getByText("Input").nextElementSibling).toHaveTextContent("1k");
    expect(within(popover).getByText("Cache read").nextElementSibling).toHaveTextContent("200");
    expect(within(popover).getByText("Cache write").nextElementSibling).toHaveTextContent("100");
    expect(within(popover).getByText("Output").nextElementSibling).toHaveTextContent("50");
    expect(within(popover).getByText("Reasoning").nextElementSibling).toHaveTextContent("25");
    expect(within(popover).getByText("Cost").nextElementSibling).toHaveTextContent("$0.0042");
  });

  it("renders exact context progress only when the context window is known", async () => {
    render(
      <ContextDisplay
        usage={{ input: 600, output: 400 }}
        contextWindow={2_000}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Context usage: 1k tokens, 50%" });
    expect(trigger).toHaveTextContent("50%");
    fireEvent.click(trigger);
    const progress = await screen.findByRole("progressbar", {
      name: "Context window used",
    });
    expect(progress).toHaveAttribute("aria-valuenow", "50");
    expect(progress).toHaveAttribute(
      "aria-valuetext",
      "1k of 2k tokens (50%)",
    );
    expect(progress.firstElementChild).toHaveStyle({ width: "50%" });
  });

  it("does not infer a percentage when no context window was reported", async () => {
    render(<ContextDisplay usage={{ input: 600, output: 400 }} />);

    fireEvent.click(screen.getByRole("button", { name: "Context usage: 1k tokens" }));
    const popover = await screen.findByRole("dialog", { name: "Context usage" });
    expect(within(popover).queryByRole("progressbar")).not.toBeInTheDocument();
    expect(within(popover).queryByText(/%/u)).not.toBeInTheDocument();
  });

  it("omits unknown and zero-value segments without inventing cost", async () => {
    render(
      <ContextDisplay usage={{ input: 12, cachedInput: 0, output: Number.NaN }} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Context usage: 12 tokens" }));
    const popover = await screen.findByRole("dialog", { name: "Context usage" });
    expect(within(popover).getByText("Input")).toBeVisible();
    expect(within(popover).queryByText("Cache read")).not.toBeInTheDocument();
    expect(within(popover).queryByText("Cache write")).not.toBeInTheDocument();
    expect(within(popover).queryByText("Output")).not.toBeInTheDocument();
    expect(within(popover).queryByText("Cost")).not.toBeInTheDocument();
  });
});
