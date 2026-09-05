import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentStreamWireFrame } from "@mono-agent/agent-contracts";
import type { WebMessagePart } from "../contracts.js";
import { WebStore } from "../store.js";
import { normalizeMonitorTerminalReply } from "../monitor-reply.js";
import { fakeMonitor, temporaryRoot } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const boundary: AgentStreamWireFrame = { kind: "event", event: {
  type: "runtime_telemetry", kind: "assistant_message_boundary", data: { messageId: "provider-message" },
} };
const text = (delta: string): AgentStreamWireFrame => ({ kind: "append", delta });
const reasoning: AgentStreamWireFrame = { kind: "event", event: { type: "assistant_thought", text: "Inspecting the pane." } };

async function setup() {
  const root = await temporaryRoot(); roots.push(root);
  let now = new Date("2026-09-05T10:00:00Z");
  const store = await WebStore.open({ stateDir: join(root, "state"), clock: () => now });
  store.replaceAgents([{ sourceId: "agent-one", label: "Agent", status: "online", health: "running",
    supportsAttachments: true, models: [], efforts: [], modelOptions: {}, updatedAt: now.toISOString() }]);
  store.registerWebPushSubscription({ endpoint: "https://push.example.test/opaque", p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString("base64url"),
    auth: Buffer.alloc(16, 7).toString("base64url"), siteOrigin: "https://console.example.test", keyFingerprint: "test" });
  const thread = store.createThread("agent-one");
  const turn = store.beginTurn({ threadId: thread.id, text: "Continue", attachmentIds: [] });
  const monitor = fakeMonitor({ conversationId: `web:${thread.id}` });
  const deliveryKey = `monitor:${monitor.monitorId}:1`;
  const reserve = () => store.reserveMonitorWake({ sourceId: "agent-one", threadId: thread.id, monitorId: monitor.monitorId,
    deliveryKey, payloadSha256: "a".repeat(64), monitor });
  const settle = () => store.completeMonitorWake({ sourceId: "agent-one", monitorId: monitor.monitorId, deliveryKey, disposition: "steered", turnId: turn.turnId });
  const parts = () => store.getMessage(turn.assistantMessageId)!.parts;
  return { store, turn, thread, deliveryKey, reserve, settle, parts, advance: () => { now = new Date(now.getTime() + 10_000); } };
}

describe("Monitor terminal reply persistence", () => {
  it.each([false, true])("preserves the previous answer and repairs push when settlement is late=%s", async (late) => {
    const s = await setup();
    try {
      s.reserve(); if (!late) s.settle();
      s.store.applyStreamFrames(s.turn.turnId, [text("Let me inspect the worker."), boundary,
        { kind: "event", event: { type: "tool_call_started", id: "read", name: "Read", arguments: {} } },
        reasoning, text("The worker is ready for Robert's review."), boundary, text("NOTHING_TO_REPORT"), boundary]);
      s.store.completeTurn(s.turn.turnId, "NOTHING_TO_REPORT");
      if (late) s.settle();
      expect(s.parts().filter((p) => p.type === "text")).toEqual([{ type: "text", text: "Let me inspect the worker." }, { type: "text", text: "The worker is ready for Robert's review." }]);
      expect(s.parts()).toContainEqual({ type: "reasoning", text: "Inspecting the pane." });
      expect(s.parts().some((p) => p.type === "monitor-activity")).toBe(true);
      s.advance();
      expect(s.store.claimDueWebPushDeliveries(10)[0]?.event.body).toBe("The worker is ready for Robert's review.");
      const raw = new DatabaseSync(s.store.paths.database, { readOnly: true });
      expect(JSON.parse((raw.prepare("SELECT parts_json FROM messages WHERE id = ?").get(s.turn.assistantMessageId) as {parts_json: string}).parts_json).filter((p: WebMessagePart) => p.type === "text")).toEqual([{ type: "text", text: "Let me inspect the worker." }, { type: "text", text: "The worker is ready for Robert's review." }]);
      raw.close();
    } finally { s.store.close(); }
  });

  it.each(["NOTHING_TO_REPORT", "No new developments.\nNOTHING_TO_REPORT"])("suppresses only a verified follow-up terminal message: %s", async (sentinel) => {
    const s = await setup();
    try {
      s.reserve();
      s.store.applyStreamFrames(s.turn.turnId, [reasoning, text(sentinel), boundary]);
      s.store.completeTurn(s.turn.turnId, "", undefined, undefined, { monitorWakeDeliveryKey: s.deliveryKey });
      expect(s.parts().filter((p) => p.type === "text")).toEqual([]);
      expect(s.parts()).toContainEqual({ type: "reasoning", text: "Inspecting the pane." });
      s.advance(); expect(s.store.claimDueWebPushDeliveries(10)).toEqual([]);
    } finally { s.store.close(); }
  });

  it("suppresses an already pending sentinel-only push on late settlement", async () => {
    const s = await setup();
    try {
      s.reserve();
      s.store.setMonitorWakeSteeringTurn("agent-one", s.deliveryKey, s.turn.turnId, true);
      s.store.applyStreamFrames(s.turn.turnId, [reasoning, text("NOTHING_TO_REPORT"), boundary]);
      s.store.completeTurn(s.turn.turnId, "NOTHING_TO_REPORT");
      s.advance(); expect(s.store.claimDueWebPushDeliveries(10)).toEqual([]);
      s.settle(); s.advance();
      expect(s.store.claimDueWebPushDeliveries(10)).toEqual([]);
      expect(s.parts().filter((p) => p.type === "text")).toEqual([]);
    } finally { s.store.close(); }
  });

  it("does not hold failure pushes while a Monitor steering receipt is unresolved", async () => {
    const s = await setup();
    try {
      s.reserve(); s.store.setMonitorWakeSteeringTurn("agent-one", s.deliveryKey, s.turn.turnId, true);
      s.store.failTurn(s.turn.turnId, { message: "Provider failed" }); s.advance();
      expect(s.store.claimDueWebPushDeliveries(10)[0]?.event.kind).toBe("run.failed");
    } finally { s.store.close(); }
  });

  it.each(["ordinary", "unknown-key", "wrong-thread", "accepted-without-callback-key"])("does not treat %s as a Monitor association", async (kind) => {
    const s = await setup();
    try {
      if (kind === "accepted-without-callback-key" || kind === "unknown-key") s.reserve();
      if (kind === "wrong-thread") {
        s.reserve(); s.settle();
        const other = s.store.createThread("agent-one");
        const turn = s.store.beginTurn({ threadId: other.id, text: "Literal", attachmentIds: [] });
        s.store.completeTurn(turn.turnId, "NOTHING_TO_REPORT", undefined, undefined, { monitorWakeDeliveryKey: s.deliveryKey });
        expect(s.store.getMessage(turn.assistantMessageId)?.parts).toContainEqual({ type: "text", text: "NOTHING_TO_REPORT" });
      } else {
        s.store.applyStreamFrames(s.turn.turnId, [text("NOTHING_TO_REPORT"), boundary]);
        s.store.completeTurn(s.turn.turnId, "NOTHING_TO_REPORT", undefined, undefined, kind === "accepted-without-callback-key" ? {} : { monitorWakeDeliveryKey: "monitor:unknown:1" });
        expect(s.parts()).toContainEqual({ type: "text", text: "NOTHING_TO_REPORT" });
      }
    } finally { s.store.close(); }
  });

  it("keeps attachment and MCP output alongside a suppressed terminal message", async () => {
    const s = await setup();
    try {
      s.reserve(); s.settle();
      s.store.applyStreamFrames(s.turn.turnId, [reasoning, text("NOTHING_TO_REPORT"), boundary]);
      s.store.completeTurn(s.turn.turnId, "NOTHING_TO_REPORT", undefined, [
        { type: "attachment", id: "report", reference: { scheme: "mono-agent-artifact", id: "artifact-one" },
          name: "report.txt", mediaType: "text/plain", sizeBytes: 12, integrityId: `sha256:${"a".repeat(64)}` },
        { type: "mcp_app", id: "11111111-1111-4111-8111-111111111111", invocationId: "11111111-1111-4111-8111-111111111111",
          connectionId: "connection-one", serverName: "widgets", toolName: "show_chart", resourceUri: "ui://widgets/chart",
          mediaType: "text/html;profile=mcp-app", protocolVersion: "2026-01-26" },
      ]);
      expect(s.parts().filter((p) => p.type === "text")).toEqual([]);
      expect(s.parts().some((p) => p.type === "attachment")).toBe(true);
      expect(s.parts().some((p) => p.type === "mcp_app")).toBe(true);
      s.advance(); expect(s.store.claimDueWebPushDeliveries(10)).toHaveLength(1);
    } finally { s.store.close(); }
  });

  it("normalizes legacy reads without rewriting the database", async () => {
    const s = await setup();
    try {
      s.reserve(); s.settle();
      s.store.completeTurn(s.turn.turnId, "Done");
      const raw = new DatabaseSync(s.store.paths.database);
      const parts: WebMessagePart[] = [
        { type: "reasoning", text: "Plan" }, { type: "text", text: "Meaningful answer" },
        { type: "telemetry", event: "runtime_telemetry", data: boundary.event },
        { type: "text", text: "NOTHING_TO_REPORT" },
        { type: "telemetry", event: "runtime_telemetry", data: boundary.event },
      ];
      const original = JSON.stringify(parts);
      raw.prepare("UPDATE messages SET parts_json = ? WHERE id = ?").run(original, s.turn.assistantMessageId);
      expect(s.parts().filter((p) => p.type === "text")).toEqual([{ type: "text", text: "Meaningful answer" }]);
      expect((raw.prepare("SELECT parts_json FROM messages WHERE id = ?").get(s.turn.assistantMessageId) as {parts_json: string}).parts_json).toBe(original);
      raw.close();
    } finally { s.store.close(); }
  });

  it("isolates provider boundaries, preserves rich output, and uses anchored classification", () => {
    const marker: WebMessagePart = { type: "telemetry", event: "runtime_telemetry", data: boundary.event };
    const rich: WebMessagePart = { type: "attachment", id: "file", artifactId: "artifact", name: "report.txt", mediaType: "text/plain", sizeBytes: 1, integrityId: `sha256:${"a".repeat(64)}` };
    const parts: WebMessagePart[] = [{ type: "text", text: "Earlier answer" }, marker, { type: "text", text: "Narration.\n" }, { type: "reasoning", text: "Thinking" }, { type: "text", text: "NOTHING_TO_REPORT" }, marker, rich];
    const normalized = normalizeMonitorTerminalReply(parts);
    expect(normalized.parts).toEqual([parts[0], marker, parts[3], marker, rich]);
    expect(normalizeMonitorTerminalReply(normalized.parts).parts).toEqual(normalized.parts);
    expect(normalizeMonitorTerminalReply(parts.filter((p) => p !== marker)).parts.filter((p) => p.type === "text")).toEqual([]);
    for (const literal of ["NOTHING_TO_REPORT is a sentinel.", "Use NOTHING_TO_REPORT", "NOTHING_TO_REPORT\nThen proceed."]) {
      expect(normalizeMonitorTerminalReply([{ type: "text", text: literal }, marker]).changed).toBe(false);
    }
  });
});
