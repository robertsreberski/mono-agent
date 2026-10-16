import { describe, expect, it } from "vitest";
import { NoopRunRecorder } from "../index.js";

describe("NoopRunRecorder", () => {
  it("records bounded lifecycle metadata without artifacts and seals once", async () => {
    const recorder = new NoopRunRecorder({ runId: "run-demo", conversationId: "conversation-demo", isolated: true });
    expect(await recorder.start()).toMatchObject({ status: "running", eventCount: 0, artifactPaths: [] });
    recorder.onEvent({ type: "assistant", text: "Example answer" });
    const summary = await recorder.finish({ providerSessionId: "session-demo" });
    expect(summary).toMatchObject({
      runId: "run-demo", conversationId: "conversation-demo", isolated: true,
      providerSessionId: "session-demo", status: "succeeded", eventCount: 1, artifactPaths: [],
    });
    recorder.onEvent({ type: "assistant", text: "Late event" });
    expect(await recorder.fail(new Error("late failure"))).toBe(summary);
    expect(await recorder.finish({ cancelled: true })).toBe(summary);
  });

  it.each([
    [{ cancelled: true, cancellationReason: { failureKind: "cancelled", code: "operator_cancelled", notice: "Example cancellation" } }, "cancelled"],
    [{ failureKind: "runtime_failed" }, "failed"],
    [{ error: "Example failure" }, "failed"],
  ] as const)("preserves terminal result disposition %j", async (result, status) => {
    const recorder = new NoopRunRecorder({ runId: "run-demo", conversationId: "conversation-demo" });
    expect(await recorder.finish(result)).toMatchObject({ status, artifactPaths: [] });
  });
});
