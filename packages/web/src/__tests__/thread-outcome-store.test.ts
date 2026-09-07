import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebStore } from "../store.js";
import { fakeMonitor, fakeProcessJob, temporaryRoot } from "./helpers.js";
import { threadPresentation } from "../../webapp/src/thread-presentation.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await temporaryRoot(); roots.push(root);
  let now = new Date("2026-09-07T10:00:00Z");
  const stateDir = join(root, "state");
  const store = await WebStore.open({ stateDir, clock: () => now });
  store.replaceAgents([{ sourceId: "agent-one", label: "Agent", status: "online", health: "running",
    supportsAttachments: true, models: [], efforts: [], modelOptions: {},
    runSettings: { config: {}, override: null, effective: { modelSource: "config", effortSource: "config" } },
    updatedAt: now.toISOString() }]);
  const thread = store.createThread("agent-one");
  const failed = fakeProcessJob({ conversationId: `web:${thread.id}`, state: "failed" });
  const job = { ...failed, timestamps: { ...failed.timestamps, completedAt: now.toISOString() } };
  const jobInput = { sourceId: "agent-one", threadId: thread.id, jobId: job.jobId, deliveryKey: job.wake.deliveryKey };
  const summary = () => store.getThread(thread.id)!;
  return { store, stateDir, thread, summary, present: () => threadPresentation(summary()),
    jobInput, addJob: () => store.upsertProcessJobCard({ ...jobInput,
      processJob: { ...job, timestamps: { ...job.timestamps, completedAt: now.toISOString() } } }),
    advance: () => { now = new Date(now.getTime() + 60_000); },
    wake: (kind: "monitor" | "process", reply = "NOTHING_TO_REPORT", late = false) => {
      const turn = store.beginAssistantTurn({ threadId: thread.id, prompt: "Host follow-up" });
      let key: string;
      let settle: () => unknown;
      if (kind === "monitor") {
        const monitor = fakeMonitor({ conversationId: `web:${thread.id}` });
        key = `monitor:${monitor.monitorId}:1`;
        store.reserveMonitorWake({ sourceId: "agent-one", threadId: thread.id, monitorId: monitor.monitorId,
          deliveryKey: key, payloadSha256: "a".repeat(64), monitor });
        settle = () => store.completeMonitorWake({ sourceId: "agent-one", monitorId: monitor.monitorId,
          deliveryKey: key, disposition: "follow_up", turnId: turn.turnId });
      } else {
        key = jobInput.deliveryKey;
        store.reserveProcessJobWake(jobInput);
        settle = () => store.completeProcessJobWake({ ...jobInput, disposition: "follow_up", turnId: turn.turnId });
      }
      if (!late) settle();
      store.applyStreamFrames(turn.turnId, [{ kind: "append", delta: reply }]);
      store.completeTurn(turn.turnId, reply, undefined, undefined, { monitorWakeDeliveryKey: key });
      if (late) settle();
      return turn;
    } };
}

describe("meaningful conversation outcomes", () => {
  it.each(["monitor", "process"] as const)("retains a job failure through a silent %s wake and reopen", async (kind) => {
    const s = await setup();
    try {
      s.addJob();
      expect(s.present()).toEqual({ text: "Background job failed", active: false });
      s.advance();
      const turn = s.wake(kind);
      expect(s.summary().runState).toMatchObject({ status: "complete", id: turn.turnId, lastOutcome: null });
      expect(s.store.getMessage(turn.assistantMessageId)?.parts.filter((p) => p.type === "text")).toEqual([]);
      expect(s.present()).toEqual({ text: "Background job failed", active: false });
      s.store.close();
      const reopened = await WebStore.open({ stateDir: s.stateDir });
      try { expect(threadPresentation(reopened.getThread(s.thread.id)!)).toEqual({ text: "Background job failed", active: false }); }
      finally { reopened.close(); }
    } finally { s.store.close(); }
  });

  it.each(["monitor", "process"] as const)("retains an older foreground failure through late %s settlement", async (kind) => {
    const s = await setup();
    try {
      if (kind === "process") s.addJob();
      s.advance();
      const user = s.store.beginTurn({ threadId: s.thread.id, text: "Recover", attachmentIds: [] });
      s.store.failTurn(user.turnId, { message: "Recovery failed" });
      s.advance(); s.wake(kind, "NOTHING_TO_REPORT", true);
      expect(s.summary().runState.lastOutcome).toMatchObject({ status: "failed" });
      expect(s.present()).toEqual({ text: "Failed", active: false });
      s.advance();
      const next = s.store.beginTurn({ threadId: s.thread.id, text: "Try again", attachmentIds: [] });
      expect(s.present()).toEqual({ text: "Working…", active: true });
      s.store.completeTurn(next.turnId, "Recovered successfully");
      expect(s.present()).toEqual({ text: "Recovered successfully", active: false });
    } finally { s.store.close(); }
  });

  it.each(["monitor", "process"] as const)("lets a meaningful %s wake resolve a job failure", async (kind) => {
    const s = await setup();
    try {
      s.addJob(); s.advance(); s.wake(kind, "The failure is resolved.");
      expect(s.summary().runState.lastOutcome).toBeUndefined();
      expect(s.present()).toEqual({ text: "The failure is resolved.", active: false });
    } finally { s.store.close(); }
  });

  it("does not use stale answer text as proof that a later silent wake resolved a job", async () => {
    const s = await setup();
    try {
      const user = s.store.beginTurn({ threadId: s.thread.id, text: "Start", attachmentIds: [] });
      s.store.completeTurn(user.turnId, "Earlier answer");
      s.advance(); s.addJob(); s.advance(); s.wake("monitor");
      expect(s.summary().runState.lastOutcome?.finishedAt).toBe("2026-09-07T10:00:00.000Z");
      expect(s.summary().runState.finishedAt).toBe("2026-09-07T10:02:00.000Z");
      expect(s.present()).toEqual({ text: "Background job failed", active: false });
    } finally { s.store.close(); }
  });

  it("keeps rich reply failures meaningful and textless user outcomes authoritative", async () => {
    const s = await setup();
    try {
      s.addJob(); s.advance();
      const rich = s.store.beginAssistantTurn({ threadId: s.thread.id, prompt: "Host result" });
      s.store.completeTurn(rich.turnId, "", undefined,
        [{ type: "failure", id: "missing", code: "artifact_missing", message: "File missing" }]);
      expect(s.summary().runState.lastOutcome).toBeUndefined();
      s.advance();
      const user = s.store.beginTurn({ threadId: s.thread.id, text: "New request", attachmentIds: [] });
      s.store.completeTurn(user.turnId, "");
      expect(s.summary().runState.lastOutcome).toBeUndefined();
      expect(s.present()).toEqual({ text: "Completed", active: false });
    } finally { s.store.close(); }
  });

  it("treats whitespace-only assistant output as silent without relying on a delivery receipt", async () => {
    const s = await setup();
    try {
      s.addJob(); s.advance();
      const host = s.store.beginAssistantTurn({ threadId: s.thread.id, prompt: "No change" });
      s.store.completeTurn(host.turnId, "\u00a0\u2003\ufeff");
      expect(s.summary().runState.lastOutcome).toBeNull();
      expect(s.present()).toEqual({ text: "Background job failed", active: false });
    } finally { s.store.close(); }
  });

  it("normalizes historical Monitor sentinel bytes without rewriting their stored message", async () => {
    const s = await setup();
    try {
      s.addJob(); s.advance();
      const host = s.wake("monitor");
      const raw = new DatabaseSync(s.store.paths.database);
      try {
        const parts = JSON.stringify([{ type: "text", text: "NOTHING_TO_REPORT" }]);
        raw.prepare("UPDATE messages SET parts_json = ? WHERE id = ?").run(parts, host.assistantMessageId);
        expect(s.present()).toEqual({ text: "Background job failed", active: false });
        expect(raw.prepare("SELECT parts_json FROM messages WHERE id = ?").get(host.assistantMessageId))
          .toMatchObject({ parts_json: parts });
      } finally { raw.close(); }
    } finally { s.store.close(); }
  });
});
