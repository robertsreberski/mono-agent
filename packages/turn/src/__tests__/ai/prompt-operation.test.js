import { describe, expect, it, vi } from "vitest";
import { runHarnessPrompt } from "../../ai/providers/engine-turn/prompt-operation.js";

describe("prompt operation", () => {
  it("omits empty options and always waits for idle", async () => {
    const order = [];
    const harness = {
      prompt: vi.fn(async () => { order.push("prompt"); }),
      waitForIdle: vi.fn(async () => { order.push("idle"); }),
    };
    expect(await runHarnessPrompt(harness, "hello", [])).toEqual({ runError: null });
    expect(harness.prompt).toHaveBeenCalledWith("hello");
    expect(order).toEqual(["prompt", "idle"]);
  });

  it("passes images and operation admission unchanged, retaining suspension", async () => {
    const images = [{ type: "image", data: "fixture", mimeType: "image/png" }];
    const onOperationAdmitted = vi.fn();
    const harness = {
      prompt: vi.fn(async (_text, options) => {
        options.onOperationAdmitted("operation-fixture");
        return { operationId: "operation-fixture", status: "suspended" };
      }),
      waitForIdle: vi.fn(async () => {}),
    };
    expect(await runHarnessPrompt(harness, "hello", images, { onOperationAdmitted })).toEqual({
      runError: null, operationId: "operation-fixture", suspended: true,
    });
    expect(harness.prompt).toHaveBeenCalledWith("hello", { images, onOperationAdmitted });
    expect(onOperationAdmitted).toHaveBeenCalledWith("operation-fixture");
  });

  it("captures arbitrary prompt throws but does not swallow idle failure", async () => {
    const thrown = { fixture: "prompt rejection" };
    const harness = {
      prompt: vi.fn(async () => { throw thrown; }),
      waitForIdle: vi.fn(async () => {}),
    };
    expect(await runHarnessPrompt(harness, "hello", undefined)).toEqual({ runError: thrown });
    expect(harness.waitForIdle).toHaveBeenCalledOnce();
    const idleError = new Error("fixture idle failure");
    harness.waitForIdle.mockRejectedValueOnce(idleError);
    await expect(runHarnessPrompt(harness, "hello", undefined)).rejects.toBe(idleError);
  });
});
