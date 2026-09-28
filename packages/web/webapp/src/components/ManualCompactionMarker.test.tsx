import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { thread } from "../test/fixtures";
import type { ThreadDetail } from "../types";
import { ManualCompactionMarker } from "./ManualCompactionMarker";

const active = thread("garden", "alpha", { compaction: {
  status: "running", trigger: "manual", startedAt: "2026-09-28T10:00:00Z",
} });
const detail: ThreadDetail = { thread: active, messages: [{
  id: "answer", threadId: active.id, role: "assistant", status: "complete",
  createdAt: "2026-09-28T09:59:00Z", updatedAt: "2026-09-28T09:59:00Z",
  attachments: [], parts: [{ type: "text", text: "The garden plan is ready." }],
}] };

describe("transient manual compaction marker", () => {
  it("appears until the persisted outcome arrives, without displaying both rows", () => {
    const { rerender } = render(<ManualCompactionMarker thread={active} detail={detail} />);
    expect(screen.getByRole("note", { name: "Compacting context… · manual" })).toBeVisible();
    const completed: ThreadDetail = { ...detail, messages: [{ ...detail.messages[0]!, parts: [
      ...detail.messages[0]!.parts,
      { type: "telemetry", event: "runtime_telemetry", data: { kind: "context_compaction", data: {
        trigger: "manual", status: "succeeded", timestamp: Date.parse("2026-09-28T10:00:01Z"),
      } } },
    ] }] };
    rerender(<ManualCompactionMarker thread={{ ...active, compaction: undefined }} detail={detail} />);
    expect(screen.getByRole("note", { name: "Compacting context… · manual" })).toBeVisible();
    rerender(<ManualCompactionMarker thread={{ ...active, compaction: undefined }} detail={completed} />);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });
  it("does not suppress a new run because of an older result", () => {
    const old: ThreadDetail = { ...detail, messages: [{ ...detail.messages[0]!, parts: [
      { type: "telemetry", event: "runtime_telemetry", data: { kind: "context_compaction", data: {
        trigger: "manual", status: "succeeded", timestamp: Date.parse("2026-09-28T09:00:00Z"),
      } } },
    ] }] };
    render(<ManualCompactionMarker thread={active} detail={old} />);
    expect(screen.getByRole("note")).toBeVisible();
  });
});
