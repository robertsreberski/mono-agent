import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DashboardSearch } from "./DashboardSearch";

describe("DashboardSearch", () => {
  it("is labelled for a screen reader as well as placeheld for the eye", () => {
    render(<DashboardSearch value="" onChange={vi.fn()} />);

    expect(screen.getByLabelText("Search conversations")).toHaveAttribute("type", "search");
    expect(screen.getByPlaceholderText("Search conversations")).toHaveValue("");
  });

  it("reports every keystroke and never holds a value of its own", () => {
    const onChange = vi.fn();
    render(<DashboardSearch value="tail" onChange={onChange} />);

    const input = screen.getByPlaceholderText("Search conversations");
    expect(input).toHaveValue("tail");
    fireEvent.change(input, { target: { value: "tails" } });

    expect(onChange).toHaveBeenCalledWith("tails");
    // Controlled: the value only moves when the owner says so.
    expect(input).toHaveValue("tail");
  });

  it("offers a way out only while there is something to clear", () => {
    const onChange = vi.fn();
    const { rerender } = render(<DashboardSearch value="" onChange={onChange} />);
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();

    rerender(<DashboardSearch value="tailscale" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));

    expect(onChange).toHaveBeenCalledWith("");
  });
});
