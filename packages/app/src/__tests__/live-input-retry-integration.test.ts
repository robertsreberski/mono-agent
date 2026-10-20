// Mailbox-level replay contract for removed, unconsumed inputs. Real Pi now
// records liveInputTaken when an input is yielded, so its router side-effect
// gate stops the run before this replay can reach a retry or backup.
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { createLiveInputMailbox } from "@mono-agent/conversation";
import type { RuntimeLiveInputMessage } from "@mono-agent/turn/host/types";

const { instrumentLiveInputAppliedEvents } = await import(
  new URL("./runtime/live-input-events.js", pathToFileURL(createRequire(import.meta.url).resolve("@mono-agent/turn"))).href
) as {
  instrumentLiveInputAppliedEvents(
    input: AsyncIterable<RuntimeLiveInputMessage>,
    onEvent: (event: { readonly type: string }) => void,
  ): AsyncIterable<RuntimeLiveInputMessage>;
};

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

    const events: Array<{ readonly type: string }> = [];
    const stream = instrumentLiveInputAppliedEvents(mailbox, (event) => events.push(event))!;
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
