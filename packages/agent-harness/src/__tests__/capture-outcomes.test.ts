import { describe, expect, it } from "vitest";
import { UncommittedTurnCollector } from "../harness/turn-continuity.js";

describe("category-only host tool outcomes", () => {
  it("never treats rejected, cancelled or interrupted calls as a failed retry", () => {
    for (const state of ["rejected", "cancelled", "interrupted", "signal"] as const) {
      const collector = new UncommittedTurnCollector();
      collector.admitToolLifecycle({ phase: "invocation", toolCallId: "first", toolName: "Exec",
        arguments: { command: "fictional-private-data" } });
      collector.admitToolLifecycle({ phase: "result", toolCallId: "first", toolName: "Exec", state,
        content: "fictional-output" });
      collector.admitToolLifecycle({ phase: "invocation", toolCallId: "second", toolName: "Exec" });
      collector.admitToolLifecycle({ phase: "result", toolCallId: "second", toolName: "Exec", state: "success" });
      expect(collector.captureToolOutcomes()).toEqual([]);
    }
  });
  it.each(["error", "exit_nonzero", "timeout"] as const)("counts %s followed by success", (state) => {
    const collector = new UncommittedTurnCollector();
    collector.admitToolLifecycle({ phase: "invocation", toolCallId: "first", toolName: "Exec" });
    collector.admitToolLifecycle({ phase: "result", toolCallId: "first", state, failureKind: "fictional-raw-error" });
    collector.admitToolLifecycle({ phase: "invocation", toolCallId: "second", toolName: "Exec" });
    collector.admitToolLifecycle({ phase: "result", toolCallId: "second", state: "success" });
    expect(collector.captureToolOutcomes()).toEqual([
      { category: "execute", outcome: "failed" }, { category: "execute", outcome: "succeeded" },
    ]);
  });
});
