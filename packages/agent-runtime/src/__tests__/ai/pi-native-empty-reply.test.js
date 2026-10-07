import { describe, expect, it, vi } from "vitest";
import { emptyReplyFinalizationPrompt, runEmptyReplyRetry, shouldRetryEmptyReply } from "../../ai/providers/pi-native/empty-reply.js";

const eligible = { finalText: "", stopReason: "stop", outputSchema: undefined, runError: undefined, externalAbort: false, maxTurnsHit: false, silent: false, pendingQuestion: false };

describe("empty reply finalization", () => {
  it("uses an overridable plain-text nudge without promoting thinking", () => {
    expect(emptyReplyFinalizationPrompt()).toContain("Keep reasoning private");
    expect(emptyReplyFinalizationPrompt({ emptyReplyFinalization: () => "Custom nudge" })).toBe("Custom nudge");
    expect(shouldRetryEmptyReply(eligible)).toBe(true);
  });

  it.each([
    { finalText: "Reply" }, { outputSchema: {} }, { runError: new Error("runtime failed") },
    { externalAbort: true }, { maxTurnsHit: true }, { silent: true }, { pendingQuestion: true },
    { stopReason: "error" }, { stopReason: "aborted" }, { stopReason: null },
  ])("excludes %j", (override) => expect(shouldRetryEmptyReply({ ...eligible, ...override })).toBe(false));

  function harness() {
    return { getActiveTools: () => [{ name: "Read" }, { name: "SuggestReplies" }],
      setActiveTools: vi.fn(async () => {}), prompt: vi.fn(async () => {}), waitForIdle: vi.fn(async () => {}) };
  }

  it("disables and restores tools around exactly one prompt", async () => {
    const h = harness();
    const warnings = [];
    expect(await runEmptyReplyRetry({ harness: h, runtimeWarnings: warnings })).toEqual({ attempted: true });
    expect(h.setActiveTools.mock.calls).toEqual([[[]], [["Read", "SuggestReplies"]]]);
    expect(h.prompt).toHaveBeenCalledExactlyOnceWith(emptyReplyFinalizationPrompt());
    expect(h.waitForIdle).toHaveBeenCalledTimes(1);
    expect(warnings).toContainEqual(expect.objectContaining({ warning_kind: "empty_reply_retry", attempt: 1 }));
  });

  it("restores tools and preserves a thrown runtime failure", async () => {
    const h = harness();
    const error = new Error("runtime failure");
    h.prompt.mockRejectedValueOnce(error);
    expect(await runEmptyReplyRetry({ harness: h, runtimeWarnings: [] })).toEqual({ attempted: true, error });
    expect(h.setActiveTools).toHaveBeenLastCalledWith(["Read", "SuggestReplies"]);
  });

  it.each(["before", "while disabling"])("does not admit a prompt when aborted %s", async (when) => {
    const h = harness();
    const controller = new AbortController();
    if (when === "before") controller.abort();
    else h.setActiveTools.mockImplementationOnce(async () => { controller.abort(); });
    expect(await runEmptyReplyRetry({ harness: h, runtimeWarnings: [], abortSignal: controller.signal })).toEqual({ attempted: false });
    expect(h.prompt).not.toHaveBeenCalled();
    if (when !== "before") expect(h.setActiveTools).toHaveBeenLastCalledWith(["Read", "SuggestReplies"]);
  });
});
