import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import styles from "../styles.css?raw";

import { ModelMarkers } from "./ModelMarkers";
import type { ModelTransition } from "../types";

const transition = (overrides: Partial<ModelTransition> = {}): ModelTransition => ({
  id: 1,
  afterMessageId: "m-1",
  turnId: "turn-2",
  before: { model: "openai-codex:gpt-5.6-sol", effort: "high" },
  after: { model: "anthropic:claude-fable-5-1", effort: "medium" },
  createdAt: "2026-09-12T10:00:00.000Z",
  ...overrides,
});

describe("ModelMarkers", () => {
  it("names both routes in the short vocabulary and the full one in the accessible name", () => {
    render(<ModelMarkers transitions={[transition()]} />);

    const marker = screen.getByRole("note", {
      name: "Model changed from openai-codex:gpt-5.6-sol, effort High to anthropic:claude-fable-5-1, effort Medium",
    });
    expect(marker).toBeVisible();
    expect(marker).toHaveTextContent("Model");
    expect(marker).toHaveTextContent("Sol 5.6 · high");
    expect(marker).toHaveTextContent("Fable 5.1 · medium");
  });

  it("says effort when only the grade moved, without repeating the model", () => {
    render(<ModelMarkers transitions={[transition({
      after: { model: "openai-codex:gpt-5.6-sol", effort: "low" },
    })]} />);

    const marker = screen.getByRole("note", {
      name: "Effort changed from openai-codex:gpt-5.6-sol, effort High to openai-codex:gpt-5.6-sol, effort Low",
    });
    expect(marker).toHaveTextContent("Effort");
    expect(marker).toHaveTextContent("high");
    expect(marker).not.toHaveTextContent("Sol 5.6");
  });

  it("keeps an unreported side unknown rather than calling it off", () => {
    render(<ModelMarkers transitions={[transition({
      before: { model: "openai-codex:gpt-5.6-sol", effort: null },
      after: { model: "openai-codex:gpt-5.6-sol", effort: "low" },
    })]} />);

    expect(screen.getByRole("note", {
      name: "Effort changed from openai-codex:gpt-5.6-sol to openai-codex:gpt-5.6-sol, effort Low",
    })).toHaveTextContent("unknown");
  });

  it("renders nothing without transitions, and takes the transcript rule's own geometry", () => {
    const { container } = render(<ModelMarkers />);
    expect(container).toBeEmptyDOMElement();
    // The same rule as a membership change, in the conversation's neutral ink.
    expect(styles).toMatch(/\.model-transition \{ display: flex; align-items: center; gap: 12px; margin: 30px 0; color: var\(--text-muted\);/u);
    expect(styles).toContain(".model-transition::before, .model-transition::after");
  });
});
