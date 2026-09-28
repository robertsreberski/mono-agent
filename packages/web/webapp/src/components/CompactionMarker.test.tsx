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
    rerender(<CompactionMarkerRow marker={{ ...marker, status: "skipped", trigger: "automatic" }} />);
    expect(screen.getByRole("note", { name: /Context compaction skipped.*automatic/u })).toBeVisible();
    rerender(<CompactionMarkerRow marker={{ ...marker, status: "failed" }} />);
    expect(screen.getByRole("note", { name: /Context compaction failed.*manual/u })).toBeVisible();
  });
});
