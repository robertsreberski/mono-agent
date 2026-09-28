import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => vi.useRealTimers());
  it("expires without a result and forgets a hold after a thread switch", () => {
    vi.useFakeTimers();
    const cleared = { ...active, compaction: undefined };
    const other = thread("other", "alpha");
    const { rerender } = render(<ManualCompactionMarker thread={active} detail={detail} />);
    rerender(<ManualCompactionMarker thread={cleared} detail={detail} />);
    expect(screen.getByRole("note")).toBeVisible();
    act(() => vi.advanceTimersByTime(3_001));
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    rerender(<ManualCompactionMarker thread={active} detail={detail} />);
    rerender(<ManualCompactionMarker thread={other} detail={{ ...detail, thread: other }} />);
    rerender(<ManualCompactionMarker thread={cleared} detail={detail} />);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });
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
  it("hands off to a persisted marker row without telemetry", () => {
    const { rerender } = render(<ManualCompactionMarker thread={active} detail={detail} />);
    expect(screen.getByRole("note")).toBeVisible();
    rerender(<ManualCompactionMarker thread={active} detail={{ ...detail, messages: [...detail.messages, {
      ...detail.messages[0]!, id: "marker", role: "system", parts: [{ type: "conversation-marker", kind: "compaction",
        at: "2026-09-28T10:00:01Z", operationId: "fictional-result", trigger: "manual", status: "succeeded" }],
    }] }} />);
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
