import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RunAttribution, runAttributionSummary } from "./RunAttribution";

const fallback = {
  requested: { model: "provider:primary", effort: "high" },
  attempted: { model: "provider:fallback", effort: "xhigh", effectiveEffort: "max" },
  executed: { model: "provider:fallback", effort: "xhigh", effectiveEffort: "max" },
  disposition: "fallback" as const,
  transitions: [{ from: "provider:primary", to: "provider:fallback", attemptIndex: 1, reason: "overloaded" }],
  retries: [{ model: "provider:primary", retryIndex: 1, reason: "overloaded" }],
};

describe("RunAttribution", () => {
  it("makes requested, executed, reason, and effective effort visible", () => {
    render(<RunAttribution attribution={fallback} status="complete" />);

    expect(screen.getByRole("status", { name: "Model fallback" })).toHaveAttribute("data-run-attribution", "fallback");
    expect(screen.getByText("Fallback: provider:primary → provider:fallback · overloaded")).toBeVisible();
    expect(screen.getByText("Requested High → effective Max")).toBeVisible();
    expect(screen.getByText("Routing details")).toBeInTheDocument();
  });

  it("distinguishes running, completed, and failed non-fallback attempts", () => {
    const requested = { requested: { model: "primary", effort: "high" }, attempted: { model: "primary", effort: "high" }, disposition: "requested" as const, transitions: [], retries: [] };
    expect(runAttributionSummary(requested, "running")).toBe("Running with primary · High");
    expect(runAttributionSummary({ ...requested, executed: requested.attempted }, "complete")).toBe("Ran with primary · High");
    expect(runAttributionSummary(requested, "failed")).toBe("Tried primary · High");
  });

  it("states when a fallback reason was not reported", () => {
    expect(runAttributionSummary({ ...fallback, transitions: [{ from: "primary", to: "fallback" }] }, "complete"))
      .toContain("reason not reported");
  });

  it("keeps the compact header distinct from the next-turn selector", () => {
    const { rerender } = render(<RunAttribution attribution={fallback} status="running" compact />);
    expect(screen.getByText("provider:primary → provider:fallback")).toBeVisible();
    expect(screen.queryByText(/overloaded/u)).toBeNull();

    rerender(<RunAttribution attribution={{
      requested: { model: "provider:primary", effort: "high" },
      attempted: { model: "provider:primary", effort: "high", effectiveEffort: "high" },
      executed: { model: "provider:primary", effort: "high", effectiveEffort: "high" },
      disposition: "requested",
      transitions: [],
      retries: [],
    }} status="complete" compact />);
    expect(screen.getByText("Last run · provider:primary · High")).toBeVisible();
  });

  it("reports a provider-selected effective effort when no effort was requested", () => {
    render(<RunAttribution attribution={{
      requested: { model: "provider:primary" },
      executed: { model: "provider:primary", effectiveEffort: "off" },
      disposition: "requested",
      transitions: [],
      retries: [],
    }} status="complete" />);

    expect(screen.getByText("Effective Off")).toBeVisible();
    expect(screen.getByText("Routing details")).toBeVisible();
  });
});
