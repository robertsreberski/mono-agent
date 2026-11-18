import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CompactionMarkerRow } from "./Messages";

describe("persisted compaction marker divider", () => {
  const marker = { type: "conversation-marker" as const, kind: "compaction" as const,
    at: "2026-01-15T10:00:00Z", operationId: "fictional-operation", status: "succeeded" as const,
    trigger: "manual" as const, tokensBefore: 183_400, tokensAfter: 41_300 };
  it("renders the established outcome copy for manual and automatic outcomes", () => {
    const { rerender } = render(<CompactionMarkerRow marker={marker} />);
    expect(screen.getByRole("note", { name: "Context compacted · 183.4k → ≈41.3k tokens · manual" })).toBeVisible();
    rerender(<CompactionMarkerRow marker={{ ...marker, status: "skipped", trigger: "automatic", reason: "model_changed" }} />);
    expect(screen.getByRole("note", { name: "Context compaction skipped · Model changed. · automatic" })).toBeVisible();
    rerender(<CompactionMarkerRow marker={{ ...marker, status: "failed" }} />);
    expect(screen.getByRole("note", { name: "Context compaction failed · manual" })).toBeVisible();
    rerender(<CompactionMarkerRow marker={{ ...marker, status: "failed", reason: "outcome_unknown" }} />);
    expect(screen.getByRole("note", { name: "Context compaction outcome unknown · Response lost; it may have completed. · manual" })).toBeVisible();
  });
});

it.each([
  ["protected_tuples_missing", "Some protected details were not preserved. · "],
  ["summary_budget_exceeded", "Summary was longer than the target. · "],
  ["output_truncated", "The summary was cut off. · "],
  ["provider_error", ""],
] as const)("renders a successful cut with only allow-listed %s notes", (reason, note) => {
  render(<CompactionMarkerRow marker={{ type: "conversation-marker", kind: "compaction", at: "2026-01-15T10:00:00Z",
    operationId: "fictional", status: "succeeded", trigger: "automatic", reason, httpStatus: 500 }} />);
  expect(screen.getByRole("note", { name: `Context compacted · ${note}automatic` })).toBeVisible();
});

it.each([
  ["provider_overloaded", "Provider overloaded (HTTP 529).", 529],
  ["timeout", "Summary request timed out.", undefined],
  ["cancelled", "Compaction was cancelled.", undefined],
  ["insufficient_summary_headroom", "Not enough room for a useful summary.", undefined],
  ["preservation_growth_required", "Waiting for more context before retrying historical preservation.", undefined],
  ["busy", "Conversation is busy; try again when idle.", undefined],
  ["context_too_large", "Conversation too large for the summary model.", undefined],
] as const)("renders safe %s diagnostics", (reason, label, httpStatus) => {
  render(<CompactionMarkerRow marker={{ type: "conversation-marker", kind: "compaction", at: "2026-01-15T10:00:00Z",
    operationId: "fictional", status: "failed", trigger: "manual", reason, httpStatus }} />);
  expect(screen.getByRole("note", { name: `Context compaction failed · ${label} · manual` })).toBeVisible();
});

it.each(["skipped", "failed"] as const)("renders unknown %s reasons neutrally", status => {
  render(<CompactionMarkerRow marker={{ type: "conversation-marker", kind: "compaction", at: "2026-01-15T10:00:00Z",
    operationId: "fictional", status, trigger: "automatic", reason: "future_code" as never, httpStatus: 500 }} />);
  expect(screen.getByRole("note", { name: `Context compaction ${status} · automatic` })).toBeVisible();
});
