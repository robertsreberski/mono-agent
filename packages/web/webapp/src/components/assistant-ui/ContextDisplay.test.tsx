import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContextDisplay } from "./ContextDisplay";

describe("ContextDisplay", () => {
  it("renders exact current context and last-turn work as separate sections", async () => {
    const { container } = render(
      <ContextDisplay
        className="compact-context"
        context={{
          input: 1_000,
          cachedInput: 200,
          cacheCreation: 100,
          output: 50,
          total: 1_350,
          contextWindow: 2_700,
        }}
        processed={{ input: 4_000, cachedInput: 8_000, output: 500, reasoning: 250 }}
        conversationCost={0.0042}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "Context usage: 1.4k tokens, 50%, $0.0042",
    });
    expect(trigger).toHaveClass("context-display-trigger", "compact-context");
    fireEvent.click(trigger);

    const popover = await screen.findByRole("dialog", { name: "Context usage" });
    expect(container).not.toContainElement(popover);
    const current = within(popover).getByRole("region", { name: "Current context" });
    expect(within(current).getByText("Cache read").nextElementSibling).toHaveTextContent("200");
    expect(within(current).getByText("Total").nextElementSibling).toHaveTextContent("1.4k");
    const processed = within(popover).getByRole("region", { name: "Last turn processed" });
    expect(within(processed).getByText("Processed total").nextElementSibling).toHaveTextContent("12.5k");
    expect(within(popover).getByText("Conversation cost").nextElementSibling).toHaveTextContent("$0.0042");
  });

  it("uses the reported total and window for exact post-compaction progress", async () => {
    render(<ContextDisplay context={{ input: 900_000, total: 20_000, contextWindow: 100_000 }} />);

    const trigger = screen.getByRole("button", { name: "Context usage: 20k tokens, 20%" });
    fireEvent.click(trigger);
    const progress = await screen.findByRole("progressbar", { name: "Context window used" });
    expect(progress).toHaveAttribute("aria-valuenow", "20");
    expect(progress).toHaveAttribute("aria-valuetext", "20k of 100k tokens (20%)");
  });

  it("labels legacy aggregate telemetry unavailable and never invents a percentage", async () => {
    render(
      <ContextDisplay
        processed={{ input: 429_128, cachedInput: 4_970_496, output: 15_773 }}
        conversationCost={5.104078}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Context usage: unavailable, $5.10" });
    expect(trigger).toHaveTextContent("Context —");
    expect(trigger).not.toHaveTextContent("100%");
    fireEvent.click(trigger);
    const popover = await screen.findByRole("dialog", { name: "Context usage" });
    expect(within(popover).getByText("Exact context usage was not recorded for this conversation.")).toBeVisible();
    expect(within(popover).queryByRole("progressbar")).not.toBeInTheDocument();
    expect(within(popover).getByText("Processed total").nextElementSibling).toHaveTextContent("5.4M");
  });

  it("omits unknown and zero-value segments", async () => {
    render(<ContextDisplay context={{ input: 12, cachedInput: 0, output: Number.NaN, total: 12 }} />);

    fireEvent.click(screen.getByRole("button", { name: "Context usage: 12 tokens" }));
    const current = await screen.findByRole("region", { name: "Current context" });
    expect(within(current).getByText("Input")).toBeVisible();
    expect(within(current).queryByText("Cache read")).not.toBeInTheDocument();
    expect(within(current).queryByText("Output")).not.toBeInTheDocument();
  });
});
