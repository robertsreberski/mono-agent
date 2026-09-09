import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { WebStore } from "../store.js";
import { fakeProcessJob, temporaryRoot } from "./helpers.js";
import { normalizeMonitorTerminalReply } from "../monitor-reply.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(seedWake = true) {
  const root = await temporaryRoot(); roots.push(root);
  let now = new Date("2026-09-05T10:00:00Z");
  const store = await WebStore.open({ stateDir: join(root, "state"), clock: () => now });
  store.replaceAgents([{ sourceId: "agent-one", label: "Agent", status: "online", health: "running",
    supportsAttachments: true, models: [], efforts: [], modelOptions: {},
    runSettings: { config: {}, override: null, effective: { modelSource: "config", effortSource: "config" } },
    updatedAt: now.toISOString() }]);
  store.registerWebPushSubscription({ endpoint: "https://push.example.test/opaque", p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString("base64url"),
    auth: Buffer.alloc(16, 7).toString("base64url"), siteOrigin: "https://console.example.test", keyFingerprint: "test" });
  const thread = store.createThread("agent-one");
  const job = fakeProcessJob({ conversationId: `web:${thread.id}`, state: "succeeded" });
  const input = { sourceId: "agent-one", threadId: thread.id, jobId: job.jobId, deliveryKey: job.wake.deliveryKey };
  store.upsertProcessJobCard({ ...input, processJob: job });
  store.reserveProcessJobWake(input);
  const turn = store.beginAssistantTurn({
    threadId: thread.id,
    prompt: "Job finished",
    ...(seedWake ? { processJobWake: { jobId: job.jobId, deliveryKey: job.wake.deliveryKey, disposition: "follow_up" as const } } : {}),
  });
  return { store, turn, input, advance: () => { now = new Date(now.getTime() + 10_000); } };
}

describe("process-job exact terminal suppression", () => {
  it.each([false, true])("removes a sentinel-only reply and push, late receipt=%s", async (late) => {
    const s = await setup();
    try {
      if (!late) s.store.associateProcessJobWakeTurn(s.input.deliveryKey, s.turn.turnId);
      s.store.applyStreamFrames(s.turn.turnId, [{ kind: "append", delta: "NOTHING_TO_REPORT" }]);
      s.store.completeTurn(s.turn.turnId, "", undefined, undefined, { monitorWakeDeliveryKey: s.input.deliveryKey });
      s.store.completeProcessJobWake({ ...s.input, disposition: "follow_up", turnId: s.turn.turnId });
      expect(s.store.getMessage(s.turn.assistantMessageId)?.parts).toEqual([{
        type: "process-job-wake",
        jobId: s.input.jobId,
        deliveryKey: s.input.deliveryKey,
        disposition: "follow_up",
      }]);
      s.advance(); expect(s.store.claimDueWebPushDeliveries(10)).toEqual([]);
    } finally { s.store.close(); }
  });

  it.each(["missing", "stale", "narration"])("preserves %s-key or narrated replies", async (kind) => {
    const s = await setup();
    try {
      s.store.associateProcessJobWakeTurn(s.input.deliveryKey, s.turn.turnId);
      const text = kind === "narration" ? "The change is ready.\nNOTHING_TO_REPORT" : "NOTHING_TO_REPORT";
      s.store.applyStreamFrames(s.turn.turnId, [{ kind: "append", delta: text }]);
      s.store.completeTurn(s.turn.turnId, text, undefined, undefined, kind === "missing" ? {}
        : { monitorWakeDeliveryKey: kind === "stale" ? "process-job:stale" : s.input.deliveryKey });
      expect(s.store.getMessage(s.turn.assistantMessageId)?.parts).toContainEqual({ type: "text", text });
      s.store.associateProcessJobWakeTurn(s.input.deliveryKey, s.turn.turnId, false);
      s.advance(); expect(s.store.claimDueWebPushDeliveries(10)).toHaveLength(1);
    } finally { s.store.close(); }
  });

  it("preserves a sentinel with any rich reply part", () => {
    const parts = [{ type: "text" as const, text: "NOTHING_TO_REPORT" },
      { type: "failure" as const, id: "part", code: "artifact_missing" as const, message: "File missing" }];
    expect(normalizeMonitorTerminalReply(parts, true)).toEqual({ parts, changed: false });
  });

  it("holds a push while steering is unresolved and suppresses it after the exact applied receipt", async () => {
    const s = await setup(false);
    try {
      s.store.associateProcessJobWakeTurn(s.input.deliveryKey, s.turn.turnId);
      s.store.applyStreamFrames(s.turn.turnId, [{ kind: "append", delta: "NOTHING_TO_REPORT" }]);
      s.store.completeTurn(s.turn.turnId, "NOTHING_TO_REPORT");
      s.advance(); expect(s.store.claimDueWebPushDeliveries(10)).toEqual([]);
      expect(s.store.completeProcessJobWake({ ...s.input, disposition: "steered", turnId: s.turn.turnId })?.parts).toEqual([]);
      expect(s.store.claimDueWebPushDeliveries(10)).toEqual([]);
    } finally { s.store.close(); }
  });

  it("replays a steered wake frame idempotently without retaining its synthetic tool row", async () => {
    const s = await setup(false);
    try {
      s.store.associateProcessJobWakeTurn(s.input.deliveryKey, s.turn.turnId);
      const wakeEvent = (type: "tool_call_started" | "tool_call_completed") => ({
        kind: "event" as const,
        event: {
          type,
          id: `live-input:${s.input.deliveryKey}`,
          name: "↪️ Steered: wake",
          metadata: { liveInput: true, synthetic: true, inputId: s.input.deliveryKey },
        },
      });
      const frames = [wakeEvent("tool_call_started"), wakeEvent("tool_call_completed")];
      s.store.applyStreamFrames(s.turn.turnId, frames as never);
      s.store.applyStreamFrames(s.turn.turnId, frames as never);
      expect(s.store.getMessage(s.turn.assistantMessageId)?.parts).toEqual([{
        type: "process-job-wake",
        jobId: s.input.jobId,
        deliveryKey: s.input.deliveryKey,
        disposition: "steered",
      }]);
    } finally { s.store.close(); }
  });
});
