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


const dispatch = (service: WebService) => (service as unknown as { dispatchWakes: () => void }).dispatchWakes();

describe("compact-first scheduled wake admission", () => {
  it("reserves compaction, then launches exactly one wake before newly queued live input", async () => {
    const root = await temporaryRoot(); roots.push(root);
    let now = Date.parse("2027-01-02T09:59:00Z");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const service = await WebService.create({ stateDir: join(root, "state"), clock: () => new Date(now),
      discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => [fakeDiscoveredAgent()],
      fetchImpl: operatorFetch({ supportsManualCompaction: true,
        onCompact: async (_id, body) => {
          order.push("compact"); expect(body).toMatchObject({ model: "provider/fallback" });
          await gate; return { status: "succeeded", trigger: "manual", operationId: "compact-wake" };
        }, onTurn: (body) => order.push(String(body.text).includes("<scheduled-user-message>") ? "wake" : "queued"),
      }),
    });
    try {
      const thread = service.createThread("agent-one", { model: "provider/fallback" });
      service.createWakeSchedule(thread.id, { kind: "once", timezone: "UTC", localAt: "2027-01-02T10:00",
        compactFirst: true, message: "Review the fictional draft." });
      now += 60_000; dispatch(service);
      await waitFor(() => order.length === 1);
      expect(service.thread(thread.id).thread.compaction?.status).toBe("running");
      expect(service.submitLiveInput(thread.id, "Queued during compaction").disposition).toBe("queued");
      dispatch(service); dispatch(service);
      expect(order).toEqual(["compact"]);
      expect(service.wakeSchedule(thread.id)?.state).toBe("active");
      release();
      await waitFor(() => order.length === 3 && service.store.getThread(thread.id)?.runState.status === "complete");
      expect(order).toEqual(["compact", "wake", "queued"]);
      expect(service.thread(thread.id).messages.flatMap((message) => message.parts)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "compaction", status: "succeeded" }),
      ]));
      dispatch(service); expect(order).toHaveLength(3);
    } finally { release(); await service.stop(); }
  });

  it.each(["failed", "nothing_to_compact", "model_changed", "unknown", "unsupported"])("still runs once after %s compaction", async (outcome) => {
    const root = await temporaryRoot(); roots.push(root);
    let now = Date.parse("2027-01-02T09:59:00Z");
    let compactions = 0; let turns = 0;
    const service = await WebService.create({ stateDir: join(root, "state"), clock: () => new Date(now),
      discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => [fakeDiscoveredAgent()],
      fetchImpl: operatorFetch({ supportsManualCompaction: outcome !== "unsupported", onCompact: () => {
        compactions += 1;
        if (outcome === "unknown") throw new Error("Connection lost");
        return { status: outcome === "failed" ? "failed" : "skipped", reason: outcome,
          trigger: "manual", operationId: "compact-outcome" };
      }, onTurn: () => { turns += 1; } }),
    });
    try {
      const thread = service.createThread("agent-one");
      service.createWakeSchedule(thread.id, { kind: "once", timezone: "UTC", localAt: "2027-01-02T10:00", compactFirst: true });
      now += 60_000; dispatch(service);
      await waitFor(() => turns === 1 && service.store.getThread(thread.id)?.runState.status === "complete");
      expect(service.wakeSchedule(thread.id)?.lastOutcome).toBe("fired");
      expect(compactions).toBe(outcome === "unsupported" ? 0 : 1);
      expect(service.thread(thread.id).messages.flatMap((message) => message.parts)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "compaction", status: ["failed", "unknown", "unsupported"].includes(outcome) ? "failed" : "skipped",
          ...(outcome === "unknown" ? { reason: "outcome_unknown" } : {}) }),
      ]));
      dispatch(service); expect(turns).toBe(1);
    } finally { await service.stop(); }
  });

  it("leaves preparation pending across service restart and claims the turn only once", async () => {
    const root = await temporaryRoot(); roots.push(root);
    let now = Date.parse("2027-01-02T09:59:00Z");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let compactions = 0; let turns = 0;
    const options = { stateDir: join(root, "state"), clock: () => new Date(now),
      discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => [fakeDiscoveredAgent()],
      fetchImpl: operatorFetch({ supportsManualCompaction: true, onCompact: async () => {
        compactions += 1; if (compactions === 1) await gate;
        return { status: "succeeded", trigger: "manual", operationId: `compact-${compactions}` };
      }, onTurn: () => { turns += 1; } }),
    };
    const first = await WebService.create(options);
    const thread = first.createThread("agent-one");
    first.createWakeSchedule(thread.id, { kind: "once", timezone: "UTC", localAt: "2027-01-02T10:00", compactFirst: true });
    now += 60_000; dispatch(first);
    await waitFor(() => compactions === 1);
    await first.stop();
    const second = await WebService.create(options);
    try {
      await waitFor(() => turns === 1 && second.store.getThread(thread.id)?.runState.status === "complete");
      release(); await new Promise((resolve) => setTimeout(resolve, 30));
      dispatch(second); expect(turns).toBe(1); expect(compactions).toBe(2);
    } finally { release(); await second.stop(); }
  });
});


it("defers a compact-first wake across disconnection and never duplicates it on reconnection", async () => {
  const root = await temporaryRoot(); roots.push(root);
  let now = Date.parse("2027-01-02T09:59:00Z");
  let online = true; let compactions = 0; let turns = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const service = await WebService.create({ stateDir: join(root, "state"), clock: () => new Date(now),
    discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => online ? [fakeDiscoveredAgent()] : [],
    fetchImpl: operatorFetch({ supportsManualCompaction: true, onCompact: async () => {
      compactions += 1; if (compactions === 1) await gate;
      return { status: "succeeded", operationId: `disconnected-${compactions}`, trigger: "manual" };
    }, onTurn: () => { turns += 1; } }),
  });
  try {
    const thread = service.createThread("agent-one");
    service.createWakeSchedule(thread.id, { kind: "once", timezone: "UTC", localAt: "2027-01-02T10:00", compactFirst: true });
    now += 60_000; dispatch(service);
    await waitFor(() => compactions === 1);
    online = false; await service.refreshAgents(); release();
    await waitFor(() => service.thread(thread.id).thread.compaction === undefined);
    dispatch(service); expect(turns).toBe(0);
    online = true; await service.refreshAgents();
    await waitFor(() => turns === 1 && service.store.getThread(thread.id)?.runState.status === "complete");
    dispatch(service); expect(turns).toBe(1); expect(compactions).toBe(2);
  } finally { release(); await service.stop(); }
});
