import { describe, expect, it } from "vitest";
import { JournalValidator, validateJournalHeader } from "../journal-schema.js";
import { JOURNAL_KINDS } from "../journal-types.js";
import { MemorySessionRepo } from "../session-store.js";

const header = { format: "mono-harness", version: 2, journalId: "journal-fictional",
  ownershipSchemaVersion: 1, ownership: { kind: "unbound" }, initialHandle: { id: "epoch-one" },
  id: "epoch-one", createdAt: 1, cwd: "/fictional" };
function fixture() {
  const validator = new JournalValidator();
  const records = [];
  function append(kind, payload, operationId) {
    const record = { schemaVersion: 2, id: `record-${records.length}`, parentId: validator.parentId,
      seq: validator.seq + 1, timestamp: 1, turnId: "turn-fictional", kind, payload,
      ...(operationId ? { operationId } : {}) };
    validator.apply(record); records.push(record); return record;
  }
  append("turn_start", { config: {}, identitySource: "synthetic", baselineTipId: null });
  return { validator, records, append };
}

describe("mono-agent harness journal v2", () => {
  it("validates the stable identity header and rejects other versions or guessed ownership", () => {
    expect(() => validateJournalHeader(header)).not.toThrow();
    for (const change of [{ version: 1 }, { format: "mono-pi-session" }, { journalId: "../escape" },
      { ownershipSchemaVersion: 9 }, { ownership: { kind: "host", ownerKey: "guessed" } }, { id: "epoch-two" }]) {
      expect(() => validateJournalHeader({ ...header, ...change })).toThrow("Invalid");
    }
  });
  it("defines and validates every kind without stripping opaque native metadata", () => {
    const { validator, records, append } = fixture();
    append("owner_binding", { kind: "unbound" });
    append("handle_binding", { handleId: "epoch-one", baseRevision: null, model: null });
    append("input_queued", { inputId: "input-one", state: "queued", placement: "next" });
    append("operation_start", { type: "prompt", cause: "prompt", config: {}, baselineTipId: null }, "operation-one");
    const native = { role: "assistant", content: [{ type: "thinking", thinking: "Fictional.", thinkingSignature: "opaque" },
      { type: "toolCall", id: "call-one", name: "Read", arguments: {} }], additive: { unknown: [1, 2] } };
    const message = append("message", { message: native, contextParentId: null,
      provenance: { provider: "faux", api: "faux", model: "fictional" }, input: { id: "input-one", complete: true } }, "operation-one");
    append("input_consumed", { inputId: "input-one", messageId: message.id }, "operation-one");
    append("tool_call", { callId: "call-one", name: "Read", messageId: message.id, admission: "observed" }, "operation-one");
    const result = append("message", { message: { role: "toolResult", toolCallId: "call-one", toolName: "Read", isError: false },
      contextParentId: message.id, provenance: { provider: "faux", api: "faux", model: "fictional" }, input: { id: null, complete: true } }, "operation-one");
    append("tool_result", { callId: "call-one", name: "Read", messageId: result.id, outcome: "success" }, "operation-one");
    const checkpoint = append("compaction", { compaction: { summary: "Fictional summary." }, contextParentId: result.id,
      preservedMessageIds: [message.id, result.id], derivedMessages: [], coverageVersion: 1 }, "operation-one");
    append("operation_end", { status: "completed", tipId: checkpoint.id }, "operation-one");
    append("rewind", { tipId: result.id });
    append("interruption", { cause: "explicit-account", operationIds: ["operation-one"] });
    append("model_change", { from: {}, to: {}, source: "host", checkpointId: checkpoint.id });
    append("handle_retired", { handleId: "epoch-one", cause: "retirement" });
    append("turn_end", { status: "completed", tipId: result.id, finalOperationId: "operation-one", consumedInputIds: ["input-one"] });
    expect([...new Set(records.map((r) => r.kind))].sort()).toEqual([...JOURNAL_KINDS].sort());
    expect(message.payload.message).toEqual(native);
    expect(validator.tip).toBe(result.id);
    expect(records.at(-1).parentId).not.toBe(result.id); // evidence order is not context ancestry
  });
  it("rejects malformed envelopes and unsupported kinds without advancing state", () => {
    const { validator } = fixture();
    const valid = { schemaVersion: 2, id: "record-next", parentId: validator.parentId, seq: 2,
      timestamp: 1, turnId: "turn-fictional", kind: "owner_binding", payload: { kind: "unbound" } };
    for (const change of [{ schemaVersion: 1 }, { seq: 3 }, { parentId: null }, { id: "record-0" },
      { timestamp: -1 }, { kind: "unknown" }, { payload: null }, { turnId: "missing" }]) {
      expect(() => validator.apply({ ...valid, ...change })).toThrow("Invalid");
      expect(validator.seq).toBe(1);
    }
  });
  it("rejects foreign/missing references, duplicate operation/input identities and premature turn seals", () => {
    const { append } = fixture();
    append("operation_start", { type: "prompt", cause: "prompt", config: {}, baselineTipId: null }, "operation-one");
    const invalid = [
      ["operation_end", { status: "completed", tipId: null }, "missing"],
      ["operation_start", { type: "prompt", cause: "prompt", config: {}, baselineTipId: null }, "operation-one"],
      ["turn_end", { status: "completed", tipId: null, finalOperationId: "operation-one", consumedInputIds: [] }],
      ["tool_result", { callId: "missing", name: "Read", messageId: "missing", outcome: "success" }, "operation-one"],
      ["rewind", { tipId: "missing" }],
      ["input_consumed", { inputId: "input-one", messageId: "missing" }, "operation-one"],
      ["handle_retired", { handleId: "missing", cause: "reset" }],
    ];
    for (const args of invalid) expect(() => append(...args)).toThrow("Invalid");
  });
  it("keeps unique prompt/compaction/re-prompt operations within one logical turn", async () => {
    const repo = new MemorySessionRepo(); const store = await repo.create({ id: "fixture-handle" });
    await store.beginTurn("host-run", {}, "host");
    await store.openOperation("overflow", {}, "prompt");
    const messageId = await store.appendMessage({ role: "user", content: "Fictional request." }, "user-envelope", { id: "logical-input", complete: true });
    await store.write("input_consumed", { inputId: "logical-input", messageId }, { operationId: "overflow" });
    await store.closeOperation("overflow", "failed");
    await store.openOperation("compact", {}, "compaction", "reactive_overflow");
    await store.appendCompaction({ summary: "Fictional summary." }); await store.closeOperation("compact", "completed");
    await store.openOperation("retry", {}, "prompt", "re_prompt");
    await store.closeOperation("retry", "completed"); await store.endTurn("host-run", "completed");
    expect((await store.getTurn("host-run")).payload).toMatchObject({ finalOperationId: "retry", status: "completed", consumedInputIds: ["logical-input"] });
    expect(store.records.filter((r) => r.kind === "operation_start").map((r) => r.operationId)).toEqual(["overflow", "compact", "retry"]);
    expect(new Set(store.records.filter((r) => r.kind === "operation_start").map((r) => r.turnId))).toEqual(new Set(["host-run"]));
    await store.close();
  });
});
