import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentStreamWireFrame } from "@mono-agent/agent-contracts";
import type { WebMessagePart } from "../contracts.js";
import { WebStore } from "../store.js";
import { hasWakeReplyContent, normalizeWakeTerminalReply } from "../wake-reply.js";
import { fakeProcessJob, temporaryRoot } from "./helpers.js";

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
    supportsAttachments: true, models: [], efforts: [], modelOptions: {},
    runSettings: { config: {}, override: null, effective: { modelSource: "config", effortSource: "config" } },
    updatedAt: now.toISOString() }]);
  store.registerWebPushSubscription({ endpoint: "https://push.example.test/opaque", p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString("base64url"),
    auth: Buffer.alloc(16, 7).toString("base64url"), siteOrigin: "https://console.example.test", keyFingerprint: "test" });
  const thread = store.createThread("agent-one");
  const turn = store.beginTurn({ threadId: thread.id, text: "Continue", attachmentIds: [] });
  const job = fakeProcessJob({ conversationId: `web:${thread.id}`, state: "succeeded" });
  const deliveryKey = job.wake.deliveryKey;
  const input = { sourceId: "agent-one", threadId: thread.id, jobId: job.jobId, deliveryKey };
  store.upsertProcessJobCard({ ...input, processJob: job });
  const reserve = () => store.reserveProcessJobWake(input);
  const settle = () => store.completeProcessJobWake({ ...input, disposition: "steered", turnId: turn.turnId });
  const parts = () => store.getMessage(turn.assistantMessageId)!.parts;
  return { store, turn, thread, deliveryKey, reserve, settle, parts, advance: () => { now = new Date(now.getTime() + 10_000); } };
}

describe("host wake terminal reply persistence", () => {

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

      expect(s.store.searchThreads({ sourceId: "agent-one", query: "worker" }).hits.map((hit) => hit.thread.id)).toEqual([s.thread.id]);
      expect(s.store.searchThreads({ sourceId: "agent-one", query: "NOTHING_TO_REPORT" }).hits).toEqual([]);
      s.advance();
      expect(s.store.claimDueWebPushDeliveries(10)[0]?.event.body).toBe(late ? "The worker is ready for Robert's review." : "Let me inspect the worker. The worker is ready for Robert's review.");
      const raw = new DatabaseSync(s.store.paths.database, { readOnly: true });
      expect(JSON.parse((raw.prepare("SELECT parts_json FROM messages WHERE id = ?").get(s.turn.assistantMessageId) as {parts_json: string}).parts_json).filter((p: WebMessagePart) => p.type === "text")).toEqual([{ type: "text", text: "Let me inspect the worker." }, { type: "text", text: "The worker is ready for Robert's review." }]);
      raw.close();
    } finally { s.store.close(); }
  });

  it.each(["NOTHING_TO_REPORT"])("suppresses only a verified follow-up terminal message: %s", async (sentinel) => {
    const s = await setup();
    try {
      s.reserve();
      s.store.associateProcessJobWakeTurn(s.deliveryKey, s.turn.turnId);
      s.store.applyStreamFrames(s.turn.turnId, [reasoning, text(sentinel), boundary]);
      s.store.completeTurn(s.turn.turnId, "", undefined, undefined, { hostWakeDeliveryKey: s.deliveryKey });
      expect(s.parts().filter((p) => p.type === "text")).toEqual([]);
      expect(s.parts()).toContainEqual({ type: "reasoning", text: "Inspecting the pane." });
      s.advance(); expect(s.store.claimDueWebPushDeliveries(10)).toEqual([]);
    } finally { s.store.close(); }
  });

  it("suppresses an already pending sentinel-only push on late settlement", async () => {
    const s = await setup();
    try {
      s.reserve();
      s.store.associateProcessJobWakeTurn(s.deliveryKey, s.turn.turnId, true);
      s.store.applyStreamFrames(s.turn.turnId, [reasoning, text("NOTHING_TO_REPORT"), boundary]);
      s.store.completeTurn(s.turn.turnId, "NOTHING_TO_REPORT");
      s.advance(); expect(s.store.claimDueWebPushDeliveries(10)).toEqual([]);
      s.settle(); s.advance();
      expect(s.store.claimDueWebPushDeliveries(10)).toEqual([]);
      expect(s.parts().filter((p) => p.type === "text")).toEqual([]);
    } finally { s.store.close(); }
  });

  it("does not hold failure pushes while a host wake steering receipt is unresolved", async () => {
    const s = await setup();
    try {
      s.reserve(); s.store.associateProcessJobWakeTurn(s.deliveryKey, s.turn.turnId, true);
      s.store.failTurn(s.turn.turnId, { message: "Provider failed" }); s.advance();
      expect(s.store.claimDueWebPushDeliveries(10)[0]?.event.kind).toBe("run.failed");
    } finally { s.store.close(); }
  });

  it.each(["ordinary", "unknown-key", "wrong-thread", "accepted-without-callback-key"])("does not treat %s as a host wake association", async (kind) => {
    const s = await setup();
    try {
      if (kind === "accepted-without-callback-key" || kind === "unknown-key") s.reserve();
      if (kind === "wrong-thread") {
        s.reserve(); s.settle();
        const other = s.store.createThread("agent-one");
        const turn = s.store.beginTurn({ threadId: other.id, text: "Literal", attachmentIds: [] });
        s.store.completeTurn(turn.turnId, "NOTHING_TO_REPORT", undefined, undefined, { hostWakeDeliveryKey: s.deliveryKey });
        expect(s.store.getMessage(turn.assistantMessageId)?.parts).toContainEqual({ type: "text", text: "NOTHING_TO_REPORT" });
      } else {
        s.store.applyStreamFrames(s.turn.turnId, [text("NOTHING_TO_REPORT"), boundary]);
        s.store.completeTurn(s.turn.turnId, "NOTHING_TO_REPORT", undefined, undefined, kind === "accepted-without-callback-key" ? {} : { hostWakeDeliveryKey: "process-job:unknown" });
        expect(s.parts()).toContainEqual({ type: "text", text: "NOTHING_TO_REPORT" });
      }
    } finally { s.store.close(); }
  });

  it("keeps attachment and MCP output alongside its terminal message", async () => {
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
      expect(s.parts().filter((p) => p.type === "text")).toEqual([{ type: "text", text: "NOTHING_TO_REPORT" }]);
      expect(s.parts().some((p) => p.type === "attachment")).toBe(true);
      expect(s.parts().some((p) => p.type === "mcp_app")).toBe(true);
      s.advance(); expect(s.store.claimDueWebPushDeliveries(10)).toHaveLength(1);
    } finally { s.store.close(); }
  });

  it("retains a restart card with sentinel text as meaningful wake content", () => {
    const proposal = { type: "restart_proposal", id: "proposal-1", reason: "Operator review" } as const;
    const parts: WebMessagePart[] = [{ type: "text", text: "NOTHING_TO_REPORT" }, proposal];
    expect(hasWakeReplyContent(parts)).toBe(true);
    expect(normalizeWakeTerminalReply(parts, true)).toEqual({ parts, changed: false });
  });

  it.each(["", "\n\n"])("honors legacy context_usage boundaries regardless of preceding whitespace %j", (space) => {
    const marker: WebMessagePart = { type: "telemetry", event: "runtime_telemetry", data: {
      type: "runtime_telemetry", kind: "context_usage", data: {},
    } };
    const prior: WebMessagePart[] = [{ type: "text", text: "Let me check." }, marker,
      { type: "reasoning", text: "Inspecting" }, { type: "text", text: `Meaningful answer${space}` }, marker];
    for (const sentinel of ["NOTHING_TO_REPORT", "Nothing changed.\nNOTHING_TO_REPORT"]) {
      const normalized = normalizeWakeTerminalReply([...prior, { type: "text", text: sentinel }, marker]);
      expect(normalized.parts).toEqual([...prior, marker]);
      expect(normalizeWakeTerminalReply(normalized.parts).parts).toEqual(normalized.parts);
    }
  });

  it("uses explicit boundaries when Pi also emits context usage for the same message", () => {
    const usage: WebMessagePart = { type: "telemetry", event: "runtime_telemetry", data: { kind: "context_usage" } };
    const explicit: WebMessagePart = { type: "telemetry", event: "runtime_telemetry", data: boundary.event };
    const answer: WebMessagePart = { type: "text", text: "Meaningful answer" };
    const normalized = normalizeWakeTerminalReply([answer, usage, explicit,
      { type: "text", text: "Nothing changed.\nNOTHING_TO_REPORT" }, usage, explicit]);
    expect(normalized.parts).toEqual([answer, usage, explicit, usage, explicit]);
    expect(normalizeWakeTerminalReply(normalized.parts).parts).toEqual(normalized.parts);
  });

  it("preserves prior text when boundary-less provider messages cannot be isolated", () => {
    for (const space of ["", "\n\n"]) {
      const prior: WebMessagePart[] = [{ type: "reasoning", text: "Plan" },
        { type: "text", text: `Meaningful answer${space}` }];
      const parts: WebMessagePart[] = [...prior, { type: "text", text: "Nothing changed.\nNOTHING_TO_REPORT" }];
      expect(normalizeWakeTerminalReply(parts)).toEqual({ parts, changed: false });
    }
    // With only one text part there is no earlier answer to erase.
    expect(normalizeWakeTerminalReply([{ type: "reasoning", text: "Plan" },
      { type: "text", text: "No update.\nNOTHING_TO_REPORT" }]).parts)
      .toEqual([{ type: "reasoning", text: "Plan" }]);
  });

  it("isolates provider boundaries, preserves rich output, and uses anchored classification", () => {
    const marker: WebMessagePart = { type: "telemetry", event: "runtime_telemetry", data: boundary.event };
    const rich: WebMessagePart = { type: "attachment", id: "file", artifactId: "artifact", name: "report.txt", mediaType: "text/plain", sizeBytes: 1, integrityId: `sha256:${"a".repeat(64)}` };
    const parts: WebMessagePart[] = [{ type: "text", text: "Earlier answer" }, marker, { type: "text", text: "Narration.\n" }, { type: "reasoning", text: "Thinking" }, { type: "text", text: "NOTHING_TO_REPORT" }, marker, rich];
    const normalized = normalizeWakeTerminalReply(parts);
    expect(normalized.parts).toEqual([parts[0], marker, parts[3], marker, rich]);
    expect(normalizeWakeTerminalReply(normalized.parts).parts).toEqual(normalized.parts);
    expect(normalizeWakeTerminalReply(parts.filter((p) => p !== marker)).parts).toEqual(parts.filter((p) => p !== marker));
    for (const literal of ["NOTHING_TO_REPORT is a sentinel.", "Use NOTHING_TO_REPORT", "NOTHING_TO_REPORT\nThen proceed."]) {
      expect(normalizeWakeTerminalReply([{ type: "text", text: literal }, marker]).changed).toBe(false);
    }
  });
});
