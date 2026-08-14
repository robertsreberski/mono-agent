import { describe, expect, it } from "vitest";

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
  });
});
