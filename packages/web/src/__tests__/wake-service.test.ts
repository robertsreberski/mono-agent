import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { WebService } from "../service.js";
import { fakeDiscoveredAgent, operatorFetch, temporaryRoot } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for scheduled turn.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("scheduled wake dispatch through the fake operator", () => {
  it("keeps a refused pre-admission launch uncertain and never replays it", async () => {
    const root = await temporaryRoot(); roots.push(root);
    let now = Date.parse("2027-01-02T09:59:00Z");
    let attempts = 0;
    const service = await WebService.create({ stateDir: join(root, "state"), clock: () => new Date(now),
      discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => [fakeDiscoveredAgent()],
      fetchImpl: operatorFetch({ turns: () => { attempts += 1; throw new Error("Operator connection unavailable"); } }),
    });
    try {
      const thread = service.createThread("agent-one");
      service.createWakeSchedule(thread.id, { kind: "once", timezone: "UTC", localAt: "2027-01-02T10:00" });
      now += 60_000;
      (service as unknown as { dispatchWakes: () => void }).dispatchWakes();
      await waitFor(() => service.store.getThread(thread.id)?.runState.status === "failed");
      expect(service.wakeSchedule(thread.id)?.lastOutcome).toBe("uncertain");
      (service as unknown as { dispatchWakes: () => void }).dispatchWakes();
      expect(attempts).toBe(1);
    } finally { await service.stop(); }
  });

  it("does not replay a failed accepted operator turn", async () => {
    const root = await temporaryRoot(); roots.push(root);
    let now = Date.parse("2027-01-02T09:59:00Z");
    let attempts = 0;
    const service = await WebService.create({ stateDir: join(root, "state"), clock: () => new Date(now),
      discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => [fakeDiscoveredAgent()],
      fetchImpl: operatorFetch({ turns: () => { attempts += 1; return "malformed response"; } }),
    });
    try {
      const thread = service.createThread("agent-one");
      service.createWakeSchedule(thread.id, { kind: "once", timezone: "UTC", localAt: "2027-01-02T10:00" });
      now += 60_000;
      (service as unknown as { dispatchWakes: () => void }).dispatchWakes();
      await waitFor(() => service.store.getThread(thread.id)?.runState.status === "failed");
      expect(service.wakeSchedule(thread.id)?.lastOutcome).toBe("failed");
      (service as unknown as { dispatchWakes: () => void }).dispatchWakes();
      expect(attempts).toBe(1);
    } finally { await service.stop(); }
  });

  it("launches one host-framed, keyless saved-route turn with a retained standalone transcript part and live events", async () => {
    const root = await temporaryRoot(); roots.push(root);
    let now = Date.parse("2027-01-02T09:59:00Z");
    const delivered: Record<string, unknown>[] = [];
    const service = await WebService.create({ stateDir: join(root, "state"), clock: () => new Date(now),
      discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => [fakeDiscoveredAgent()],
      fetchImpl: operatorFetch({ onTurn: (body) => delivered.push(body) }),
    });
    try {
      const thread = service.createThread("agent-one", { model: "provider/fallback", effort: "high" });
      const events: string[] = [];
      const unsubscribe = service.subscribe((event) => { if (event.threadId === thread.id) events.push(event.type); });
      service.createWakeSchedule(thread.id, { kind: "once", timezone: "UTC", localAt: "2027-01-02T10:00", message: "Review the sample." });
      now += 60_000;
      (service as unknown as { dispatchWakes: () => void }).dispatchWakes();
      await waitFor(() => delivered.length === 1 && service.store.getThread(thread.id)?.runState.status === "complete");
      const payload = delivered[0]!;
      expect(payload.conversationId).toBe(`web:${thread.id}`);
      expect(payload.text).toContain("<scheduled-user-message>\nReview the sample.\n</scheduled-user-message>");
      expect(payload.processJobWakeDeliveryKey).toBeUndefined();
      const metadata = (payload.metadata as { web: Record<string, unknown> }).web;
      expect(metadata.model).toBe("provider/fallback");
      expect(metadata.effort).toBe("high");
      expect(metadata.consoleProjects).toEqual({ schema: 1 });
      expect(metadata.conversationTitle).toBeUndefined();
      const wake = service.store.getThreadDetail(thread.id)!.messages.flatMap((message) => message.parts)
        .find((part) => part.type === "scheduled-wake");
      expect(wake).toEqual(expect.objectContaining({ message: "Review the sample." }));
      expect(events).toContain("message.changed");
      expect(events).toContain("threads.changed");
      expect(service.wakeSchedule(thread.id)?.state).toBe("completed");
      await waitFor(() => service.wakeSchedule(thread.id)?.lastOutcome === "fired");
      (service as unknown as { dispatchWakes: () => void }).dispatchWakes();
      expect(delivered).toHaveLength(1);
      unsubscribe();
    } finally { await service.stop(); }
  });
});
