import { describe, expect, it } from "vitest";

import { parseNotificationRequest } from "../notification-ingress.js";
import { fakeMonitor } from "./helpers.js";

describe("Monitor notification ingress", () => {
  it("accepts only the strict bounded Monitor wake shape", () => {
    const monitor = fakeMonitor({ conversationId: "web:thread-one", seq: 7 });
    const input = {
      sourceId: "agent-one",
      triggerKind: "monitor" as const,
      deliveryKey: `monitor:${monitor.monitorId}:7`,
      threadId: "thread-one",
      monitor,
      wakePrompt: "bounded fenced event envelope",
    };

    expect(parseNotificationRequest(input)).toEqual(input);
    expect(() => parseNotificationRequest({ ...input, extra: true }))
      .toThrowError(expect.objectContaining({ code: "invalid_notification" }));
    expect(() => parseNotificationRequest({ ...input, monitor: { ...monitor, command: "secret" } }))
      .toThrowError(expect.objectContaining({ code: "invalid_notification" }));
    expect(() => parseNotificationRequest({ ...input, wakePrompt: "   " }))
      .toThrowError(expect.objectContaining({ code: "invalid_notification" }));
    expect(() => parseNotificationRequest({ ...input, wakePrompt: "x".repeat(3 * 1024 * 1024 + 1) }))
      .toThrowError(expect.objectContaining({ status: 413 }));
  });

  it("bounds the wake prompt by UTF-8 bytes rather than JavaScript characters", () => {
    const monitor = fakeMonitor();
    expect(() => parseNotificationRequest({
      sourceId: "agent-one",
      triggerKind: "monitor",
      deliveryKey: `monitor:${monitor.monitorId}:1`,
      threadId: "thread-one",
      monitor,
      wakePrompt: "🧪".repeat(800_000),
    })).toThrowError(expect.objectContaining({ status: 413 }));
  });
});
