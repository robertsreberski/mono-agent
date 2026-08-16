import { describe, expect, it } from "vitest";

import { MAX_AGENT_REPLY_PARTS } from "@mono-agent/agent-contracts";

import { parseNotificationRequest } from "../notification-ingress.js";
import { fakeProcessJob } from "./helpers.js";

describe("process-job web notification ingress", () => {
  it("accepts only a strict bounded job update shape", () => {
    const processJob = fakeProcessJob();
    const input = {
      sourceId: "agent-one",
      triggerKind: "job" as const,
      deliveryKey: processJob.wake.deliveryKey,
      threadId: "thread-one",
      processJob,
      text: "The worker is still running.",
      wakePrompt: "Inspect the completed worker result.",
      parts: [{ type: "failure", id: "job-failure", code: "artifact_missing", message: "File expired." }],
    };
    expect(parseNotificationRequest(input)).toEqual(input);
    expect(() => parseNotificationRequest({ ...input, processJob: { ...processJob, secret: "leak" } }))
      .toThrowError(expect.objectContaining({ code: "invalid_notification" }));
    expect(() => parseNotificationRequest({ ...input, extra: true }))
      .toThrowError(expect.objectContaining({ code: "invalid_notification" }));
    expect(() => parseNotificationRequest({ ...input, text: "   " }))
      .toThrowError(expect.objectContaining({ code: "invalid_notification" }));
    expect(() => parseNotificationRequest({ ...input, text: "x".repeat(8_001) }))
      .toThrowError(expect.objectContaining({ status: 413 }));
    expect(() => parseNotificationRequest({ ...input, wakePrompt: "   " }))
      .toThrowError(expect.objectContaining({ code: "invalid_notification" }));
    expect(() => parseNotificationRequest({ ...input, wakePrompt: "x".repeat(200_001) }))
      .toThrowError(expect.objectContaining({ status: 413 }));
    expect(() => parseNotificationRequest({ ...input, parts: "not-an-array" }))
      .toThrowError(expect.objectContaining({ code: "invalid_notification", status: 400 }));
    expect(() => parseNotificationRequest({ ...input, parts: [{ type: "failure" }] }))
      .toThrowError(expect.objectContaining({ code: "invalid_notification", status: 400 }));
    expect(() => parseNotificationRequest({
      ...input,
      parts: Array.from({ length: MAX_AGENT_REPLY_PARTS + 1 }, (_, index) => ({
        type: "failure",
        id: `failure-${String(index)}`,
      })),
    })).toThrowError(expect.objectContaining({ code: "invalid_notification", status: 413 }));
  });
});
