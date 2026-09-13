import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import styles from "../styles.css?raw";

import {
  RunAttribution,
  runAttributionSummary,
  shouldShowMessageRunAttribution,
} from "./RunAttribution";

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

  it("hides message attribution for a settled run that did what it was asked", () => {
    const ran = {
      requested: { model: "provider:primary", effort: "high" },
      attempted: { model: "provider:primary", effort: "high", effectiveEffort: "high" },
      executed: { model: "provider:primary", effort: "high", effectiveEffort: "high" },
      disposition: "requested" as const,
      transitions: [],
      retries: [],
    };

    expect(shouldShowMessageRunAttribution(ran, "complete")).toBe(false);
    expect(shouldShowMessageRunAttribution(ran, "running")).toBe(false);
    // The conversation moved to another model after this run; the transcript
    // rules that switch, so the settled turn keeps no footer of its own.
    expect(shouldShowMessageRunAttribution({
      requested: { model: "provider:other" },
      attempted: { model: "provider:other" },
      executed: { model: "provider:other" },
      disposition: "requested",
      transitions: [],
      retries: [],
    }, "complete")).toBe(false);
    expect(shouldShowMessageRunAttribution(undefined, "complete")).toBe(false);
  });

  it("shows message attribution for every recorded deviation from the request", () => {
    const ran = {
      requested: { model: "provider:primary", effort: "high" },
      attempted: { model: "provider:primary", effort: "high", effectiveEffort: "high" },
      executed: { model: "provider:primary", effort: "high", effectiveEffort: "high" },
      disposition: "requested" as const,
      transitions: [],
      retries: [],
    };

    expect(shouldShowMessageRunAttribution({ ...ran, disposition: "fallback" }, "complete")).toBe(true);
    expect(shouldShowMessageRunAttribution({
      ...ran,
      transitions: [{ from: "provider:primary", to: "provider:secondary", reason: "overloaded" }],
    }, "complete")).toBe(true);
    expect(shouldShowMessageRunAttribution({
      ...ran,
      retries: [{ model: "provider:primary", retryIndex: 1, reason: "overloaded" }],
    }, "complete")).toBe(true);
    expect(shouldShowMessageRunAttribution({
      ...ran,
      attempted: { model: "provider:primary", effort: "high", effectiveEffort: "low" },
      executed: { model: "provider:primary", effort: "high", effectiveEffort: "low" },
    }, "complete")).toBe(true);
    // A provider-chosen effort is not a deviation when nothing was requested.
    expect(shouldShowMessageRunAttribution({
      requested: { model: "provider:primary" },
      executed: { model: "provider:primary", effectiveEffort: "off" },
      disposition: "requested",
      transitions: [],
      retries: [],
    }, "complete")).toBe(false);
  });

  it("shows an unsettled run that is already off the requested model", () => {
    const deviating = {
      requested: { model: "provider:primary" },
      attempted: { model: "provider:secondary" },
      disposition: "requested" as const,
      transitions: [],
      retries: [],
    };

    expect(shouldShowMessageRunAttribution(deviating, "running")).toBe(true);
    expect(shouldShowMessageRunAttribution(deviating, "failed")).toBe(true);
    // Settled runs get their deviation from the server as a fallback
    // disposition, so the attempt alone never speaks for a finished turn.
    expect(shouldShowMessageRunAttribution({ ...deviating, executed: { model: "provider:secondary" } }, "complete"))
      .toBe(false);
    expect(shouldShowMessageRunAttribution({ ...deviating, requested: {} }, "running")).toBe(false);
    expect(shouldShowMessageRunAttribution({ ...deviating, attempted: { model: undefined } }, "running")).toBe(false);
  });

  it("always shows fallback attribution, including equal or unknown models", () => {
    expect(shouldShowMessageRunAttribution(fallback, "complete")).toBe(true);
    expect(shouldShowMessageRunAttribution({ ...fallback, executed: undefined, attempted: undefined }, "complete")).toBe(true);
  });

  it("keeps the message marker content-width without compact header styles", () => {
    expect(styles).toMatch(/\.run-attribution \{ width: fit-content; max-width: 100%;/u);
    expect(styles).not.toContain(".run-attribution.is-compact");
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
