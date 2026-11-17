import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NOTHING_TO_REPORT_SENTINEL, type AgentReplyPart, type AgentStreamWireFrame } from "@mono-agent/contracts";
import type { WebMessagePart } from "../contracts.js";
import { WebStore } from "../store.js";
import { temporaryRoot } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const boundary: AgentStreamWireFrame = { kind: "event", event: {
  type: "runtime_telemetry", kind: "assistant_message_boundary", data: { messageId: "provider-message" },
} };
const text = (delta: string): AgentStreamWireFrame => ({ kind: "append", delta });
const reasoning: AgentStreamWireFrame = { kind: "event", event: { type: "assistant_thought", text: "Checking the daily list." } };
const textParts = (parts: readonly WebMessagePart[] | undefined) => (parts ?? []).filter((part) => part.type === "text");

async function setup() {
  const root = await temporaryRoot(); roots.push(root);
  let now = Date.parse("2027-03-04T08:59:00Z");
  const store = await WebStore.open({ stateDir: join(root, "state"), clock: () => new Date(now) });
  store.replaceAgents([{ sourceId: "fictional-agent", label: "Fictional", status: "online", health: "running",
    supportsAttachments: true, models: [], efforts: [], modelOptions: {},
    runSettings: { config: {}, override: null, effective: { modelSource: "config", effortSource: "config" } },
    updatedAt: "2027-03-04T08:00:00Z" }]);
  store.registerWebPushSubscription({ endpoint: "https://push.example.test/opaque",
    p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString("base64url"),
    auth: Buffer.alloc(16, 7).toString("base64url"), siteOrigin: "https://console.example.test", keyFingerprint: "test" });
  const thread = store.createThread("fictional-agent");
  store.createWakeSchedule(thread.id, { kind: "once", timezone: "UTC", localAt: "2027-03-04T09:00", message: "Daily check for Morgan." });
  now = Date.parse("2027-03-04T09:00:00Z");
  store.reconcileWake(thread.id, true);
  const claimed = store.claimWake(thread.id, thread.sourceId, () => true, {});
  if (claimed === null) throw new Error("expected a claimed scheduled wake");
  const { started, prompt } = claimed;
  store.markWakeAdmitted(started.turnId);
  const parts = () => store.getMessage(started.assistantMessageId)?.parts ?? [];
  const pushes = () => { now += 10_000; return store.claimDueWebPushDeliveries(10); };
  const raw = <T>(sql: string, ...args: string[]): T => {
    const database = new DatabaseSync(store.paths.database, { readOnly: true });
    try { return database.prepare(sql).get(...args) as T; } finally { database.close(); }
  };
  return { store, thread, started, prompt, parts, pushes, raw };
}

describe("scheduled wake terminal reply", () => {
  it("offers the same silence contract as a process-job wake before the untrusted user text", async () => {
    const s = await setup();
    try {
      const guidance = `If this wake-up needs no user-visible update, call FinishSilently({}) alone, with no narration or attachments. If the tool is unavailable, reply with exactly ${NOTHING_TO_REPORT_SENTINEL} and no attachments. An empty final answer is a failure, not silence.`;
      expect(s.prompt).toContain(guidance);
      expect(s.prompt.indexOf(guidance)).toBeLessThan(s.prompt.indexOf("<scheduled-user-message>"));
      expect(s.prompt).toContain("<scheduled-user-message>\nDaily check for Morgan.\n</scheduled-user-message>");
    } finally { s.store.close(); }
  });

  it("strips an exact sentinel reply, keeps the wake item and sends no response push", async () => {
    const s = await setup();
    try {
      s.store.applyStreamFrames(s.started.turnId, [reasoning, text(NOTHING_TO_REPORT_SENTINEL), boundary]);
      const detail = s.store.completeTurn(s.started.turnId, NOTHING_TO_REPORT_SENTINEL);
      expect(detail.thread.runState.status).toBe("complete");
      expect(textParts(s.parts())).toEqual([]);
      expect(s.parts()[0]).toMatchObject({ type: "scheduled-wake", message: "Daily check for Morgan." });
      expect(s.parts()).toContainEqual({ type: "reasoning", text: "Checking the daily list." });
      const stored = s.raw<{ parts_json: string }>("SELECT parts_json FROM messages WHERE id = ?", s.started.assistantMessageId);
      expect(stored.parts_json).not.toContain(NOTHING_TO_REPORT_SENTINEL);
      expect(s.store.searchThreads({ sourceId: "fictional-agent", query: NOTHING_TO_REPORT_SENTINEL }).hits).toEqual([]);
      expect(s.pushes()).toEqual([]);
      expect(s.store.finishWake(s.started.turnId)).toBe(s.thread.id);
      expect(s.store.wakeSchedule(s.thread.id)?.lastOutcome).toBe("fired");
    } finally { s.store.close(); }
  });

  it("records a host-certified silent wake as a successful silent turn without a push", async () => {
    const s = await setup();
    try {
      s.store.applyStreamFrames(s.started.turnId, [reasoning]);
      const detail = s.store.completeTurn(s.started.turnId, "", { turnDisposition: "silent" });
      expect(detail.thread.runState.status).toBe("complete");
      expect(textParts(s.parts())).toEqual([]);
      expect(s.raw<{ reply_disposition: string | null; status: string; error_code: string | null }>(
        "SELECT reply_disposition, status, error_code FROM turns WHERE id = ?", s.started.turnId,
      )).toEqual({ reply_disposition: "silent", status: "complete", error_code: null });
      expect(s.pushes()).toEqual([]);
    } finally { s.store.close(); }
  });

  it.each([
    "Morgan's daily check found two new items.",
    `Nothing changed today.\n${NOTHING_TO_REPORT_SENTINEL}`,
  ])("keeps a real or narrated report visible and pushed: %j", async (reply) => {
    const s = await setup();
    try {
      s.store.applyStreamFrames(s.started.turnId, [text(reply), boundary]);
      s.store.completeTurn(s.started.turnId, reply);
      expect(textParts(s.parts())).toEqual([{ type: "text", text: reply }]);
      expect(s.pushes()).toHaveLength(1);
    } finally { s.store.close(); }
  });

  it("never strips an ordinary user turn that ends in the sentinel", async () => {
    const s = await setup();
    try {
      s.store.completeTurn(s.started.turnId, "Done.");
      const turn = s.store.beginTurn({ threadId: s.thread.id, text: "Reply with the sentinel", attachmentIds: [] });
      s.store.applyStreamFrames(turn.turnId, [text(NOTHING_TO_REPORT_SENTINEL), boundary]);
      s.store.completeTurn(turn.turnId, NOTHING_TO_REPORT_SENTINEL);
      expect(textParts(s.store.getMessage(turn.assistantMessageId)?.parts))
        .toEqual([{ type: "text", text: NOTHING_TO_REPORT_SENTINEL }]);
      expect(s.pushes().map((push) => push.event.body)).toContain(NOTHING_TO_REPORT_SENTINEL);
    } finally { s.store.close(); }
  });

  it.each<[string, AgentReplyPart]>([
    ["attachment", { type: "attachment", id: "report", reference: { scheme: "mono-agent-artifact", id: "artifact-one" },
      name: "report.txt", mediaType: "text/plain", sizeBytes: 12, integrityId: `sha256:${"a".repeat(64)}` }],
    ["failure", { type: "failure", id: "reply-failure", code: "artifact_missing", message: "File expired." }],
    ["reply options", { type: "reply_options", id: "choices", options: ["Review list", "Skip today"] }],
  ])("keeps the sentinel and its %s visible", async (_label, part) => {
    const s = await setup();
    try {
      s.store.applyStreamFrames(s.started.turnId, [text(NOTHING_TO_REPORT_SENTINEL), boundary]);
      s.store.completeTurn(s.started.turnId, NOTHING_TO_REPORT_SENTINEL, undefined, [part]);
      expect(textParts(s.parts())).toEqual([{ type: "text", text: NOTHING_TO_REPORT_SENTINEL }]);
      expect(s.parts().some((candidate) => candidate.type === part.type)).toBe(true);
      expect(s.pushes()).toHaveLength(1);
    } finally { s.store.close(); }
  });

  it.each(["pending", "applied", "uncertain"] as const)("keeps a wake with %s steered user input visible", async (state) => {
    const s = await setup();
    try {
      const steered = s.store.reserveLiveInput(s.thread.id, "Also look at the calendar");
      expect(steered.offered).toBe(true);
      if (state === "applied") s.store.markLiveInputApplied(steered.input.id);
      if (state === "uncertain") s.store.markLiveInputUncertain(steered.input.id);
      s.store.applyStreamFrames(s.started.turnId, [text(NOTHING_TO_REPORT_SENTINEL), boundary]);
      s.store.completeTurn(s.started.turnId, NOTHING_TO_REPORT_SENTINEL);
      expect(textParts(s.parts())).toEqual([{ type: "text", text: NOTHING_TO_REPORT_SENTINEL }]);
      expect(s.pushes().map((push) => push.event.kind)).toContain("response.ready");
    } finally { s.store.close(); }
  });

  it("strips a wake whose schedule was deleted mid-turn, but not the next ordinary turn", async () => {
    const s = await setup();
    try {
      // The stored wake item, not the schedule ledger, carries provenance.
      const schedule = s.store.wakeSchedule(s.thread.id)!;
      s.store.changeWakeSchedule(s.thread.id, schedule.revision, { delete: true });
      s.store.applyStreamFrames(s.started.turnId, [text(NOTHING_TO_REPORT_SENTINEL), boundary]);
      s.store.completeTurn(s.started.turnId, NOTHING_TO_REPORT_SENTINEL);
      expect(textParts(s.parts())).toEqual([]);
      const next = s.store.beginTurn({ threadId: s.thread.id, text: "Plain question", attachmentIds: [] });
      s.store.completeTurn(next.turnId, NOTHING_TO_REPORT_SENTINEL);
      expect(textParts(s.store.getMessage(next.assistantMessageId)?.parts))
        .toEqual([{ type: "text", text: NOTHING_TO_REPORT_SENTINEL }]);
    } finally { s.store.close(); }
  });
});
