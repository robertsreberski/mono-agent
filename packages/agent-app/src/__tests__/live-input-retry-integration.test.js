import { describe, expect, it } from "vitest";

import { createLiveInputMailbox } from "../../../agent-harness/src/live-input.js";
import { instrumentLiveInputAppliedEvents } from "../../../agent-runtime/src/ai/runtime/live-input-events.js";

describe("live-input mailbox and runtime instrumentation retry", () => {
  it("keeps the first logical owner while refreshing only its mailbox lease callbacks", async () => {
    const mailbox = createLiveInputMailbox("run-integrated");
    const offered = mailbox.offer({
      conversationId: "conversation",
      id: "stable-input",
      text: "Preserve the original body",
      receivedAt: "2026-09-07T12:00:00.000Z",
    });
    expect(offered.status).toBe("accepted");
    if (offered.status !== "accepted") return;

    const events = [];
    const stream = instrumentLiveInputAppliedEvents(mailbox, (event) => events.push(event));
    const attemptOne = await stream[Symbol.asyncIterator]().next();
    expect(attemptOne.value?.reject?.({ code: "native_queue_removed" })).toBe("recorded");

    const attemptTwo = await stream[Symbol.asyncIterator]().next();
    expect(attemptTwo.value?.body).toBe("Preserve the original body");
    expect(attemptOne.value?.acknowledge?.({ providerEntryId: "stale" })).toBe("ignored");
    expect(attemptTwo.value?.acknowledge?.({ providerEntryId: "current", providerRunId: "run" }))
      .toBe("recorded");

    await expect(offered.settled).resolves.toEqual({ status: "applied", runId: "run-integrated" });
    expect(mailbox.applied()).toHaveLength(1);
    expect(events.filter((event) => event.type === "live_input_duplicate_suppressed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "live_input_applied")).toHaveLength(1);
  });
});
