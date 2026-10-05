import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtemp, rm, appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fork } from "node:child_process";
import { once } from "node:events";
import { MemorySessionRepo, JsonlSessionRepo } from "../session-store.js";
import { createTurnBinding, digestTurnInput, readTurnEvidence, matchTurnEvidence, selectTurnInterruptionAccounts } from "../turn-evidence.js";
import { repairInterruptedSession } from "../interruption.js";
import { validateSessionTurn } from "../journal-schema.js";
const model = { provider: "faux", id: "fictional-model", api: "faux" };
const descriptor = { kind: "host", ownerKey: "fictional-owner", historyBucket: "fictional-bucket", turnId: "fictional-turn", handleId: "fictional-handle", baseRevision: 2,
  reconciliation: { version: 1, purpose: "execution", fenceDigest: "a".repeat(64), initialInputId: "fictional-input" } };
const result = { text: "Fictional final answer.", error: null, failureKind: null, cancelled: false, stopReason: "stop" };
async function fixture() {
  const raw = await new MemorySessionRepo().create({ id: descriptor.handleId });
  await raw.beginTurn(descriptor.turnId, { model }, "host", createTurnBinding(descriptor, model)); await raw.sync();
  return raw;
}
async function input(raw, operationId) {
  await raw.openOperation(operationId, { model });
  const content = [{ type: "text", text: "Fictional request." }];
  const id = await raw.appendMessage({ role: "user", content }, undefined, { id: descriptor.reconciliation.initialInputId, complete: true,
    placement: "initial", requestDigest: digestTurnInput(content) });
  if (!raw.validator.turns.get(descriptor.turnId).inputs.size) await raw.write("input_consumed", { inputId: descriptor.reconciliation.initialInputId, messageId: id }, { operationId });
}
const request = (extra = {}) => ({ descriptor, purpose: "execution", expectedModel: model,
  expectedBaseTip: null, expectedInputs: [{ id: "fictional-input", requestDigest: digestTurnInput("Fictional request."), placement: "initial" }], ...extra });

describe("indexed protected turn evidence", () => {
  it("has matching protected inline ownership at the first synced start, before later bindings or input dispatch", async () => {
    const raw = await fixture();
    expect(raw.validator.owner).toMatchObject({ kind: "host", ownerKey: descriptor.ownerKey });
    expect(raw.records.filter((record) => record.turnId === descriptor.turnId && record.kind === "owner_binding")).toEqual([]);
    const evidence = await readTurnEvidence(raw, descriptor.turnId);
    expect(evidence.binding).toEqual(createTurnBinding(descriptor, model)); expect(evidence.operations).toEqual([]);
    expect(matchTurnEvidence(evidence, request()).status).toBe("matched");
    await repairInterruptedSession(raw); await raw.close();
  });
  it("reads only ordered references for the requested turn, retaining the actual final result rather than an earlier operation", async () => {
    const raw = await fixture(); const all = vi.spyOn(raw, "getAllEntries"); const branch = vi.spyOn(raw, "getEntries");
    await input(raw, "first"); await raw.closeOperation("first", "failed");
    await raw.openOperation("compaction", { model }, "compaction", "overflow"); await raw.closeOperation("compaction", "completed");
    await input(raw, "final"); await raw.closeOperation("final", "completed");
    await raw.endTurn(descriptor.turnId, "completed", result); await raw.sync();
    const evidence = await readTurnEvidence(raw, descriptor.turnId);
    expect(evidence.operations.map((op) => [op.operationId, op.status])).toEqual([["first", "failed"], ["compaction", "completed"], ["final", "completed"]]);
    expect(evidence.finalOperationId).toBe("final"); expect(evidence.seal).toEqual({ version: 1, outcome: "completed", result });
    expect(evidence.consumedInputIds).toEqual(["fictional-input"]); expect(evidence.inputs).toHaveLength(1);
    expect(matchTurnEvidence(evidence, request()).status).toBe("matched"); expect(all).not.toHaveBeenCalled(); expect(branch).not.toHaveBeenCalled(); await raw.close();
  });
  it.each(["ownerKey", "historyBucket", "handleId", "baseRevision", "turnId"])("rejects a mismatched %s before callers may repair", async (key) => {
    const raw = await fixture(); const evidence = await readTurnEvidence(raw, descriptor.turnId); const seq = raw.seq;
    const bad = { ...descriptor, [key]: key === "baseRevision" ? 3 : "foreign" };
    expect(matchTurnEvidence(evidence, request({ descriptor: bad }))).toMatchObject({ status: "mismatch", reason: key }); expect(raw.seq).toBe(seq);
    await repairInterruptedSession(raw); await raw.close();
  });
  it("matches exact model, purpose, fence, baseline and consumed input digests without transforming evidence", async () => {
    const raw = await fixture(); await input(raw, "prompt"); await raw.closeOperation("prompt", "failed"); await raw.endTurn(descriptor.turnId, "failed"); await raw.sync();
    const evidence = await readTurnEvidence(raw, descriptor.turnId);
    for (const [extra, reason] of [[{ expectedModel: { ...model, id: "other" } }, "model"], [{ expectedBaseTip: "other" }, "baseline_tip"],
      [{ purpose: "compaction" }, "purpose"], [{ expectedInputs: [{ id: "fictional-input", requestDigest: "b".repeat(64), placement: "initial" }] }, "consumed_inputs"],
      [{ descriptor: { ...descriptor, reconciliation: { ...descriptor.reconciliation, fenceDigest: "b".repeat(64) } } }, "fenceDigest"]]) {
      expect(matchTurnEvidence(evidence, request(extra))).toMatchObject({ status: "mismatch", reason });
    }
    expect(matchTurnEvidence(undefined, request()).status).toBe("absent");
    expect(matchTurnEvidence({ ...evidence, binding: null }, request())).toMatchObject({ status: "mismatch", reason: "unbound_turn" }); await raw.close();
  });
  it("does not silently certify missing/private/wrongly classified runtime results or success from an earlier operation", async () => {
    const raw = await fixture(); await input(raw, "first"); await raw.closeOperation("first", "completed");
    await raw.openOperation("last", { model }); await raw.closeOperation("last", "failed");
    await expect(raw.endTurn(descriptor.turnId, "completed", result)).rejects.toThrow("Invalid");
    await expect(raw.endTurn(descriptor.turnId, "failed", { ...result, controller: {} })).rejects.toThrow("Invalid");
    await expect(raw.endTurn(descriptor.turnId, "failed", { ...result, cancelled: undefined })).rejects.toThrow("Invalid");
    expect(raw.failure).toBeNull(); await raw.endTurn(descriptor.turnId, "failed", { ...result, error: "Fictional usage limit.", failureKind: "usage_limit" }); await raw.sync(); await raw.close();
  });
  it("accounts the last closed operation on an unsealed turn and preserves suspension without a continuation", async () => {
    const raw = await fixture(); await input(raw, "last");
    await raw.appendMessage({ role: "assistant", content: [], stopReason: "deferred" }); await raw.closeOperation("last", "failed");
    expect(selectTurnInterruptionAccounts(raw, descriptor.turnId)).toEqual([{ operationId: "last", cause: "suspended_not_resumed" }]);
    await repairInterruptedSession(raw); const evidence = await readTurnEvidence(raw, descriptor.turnId);
    expect(evidence.status).toBe("interrupted"); expect(evidence.seal).toMatchObject({ outcome: "interrupted", result: null });
    expect(evidence.interruptionEvidence).toMatchObject([{ cause: "suspended_not_resumed", operationIds: ["last"] }]);
    const seq = raw.seq; await repairInterruptedSession(raw); expect(raw.seq).toBe(seq); await raw.close();
  });
  it("keeps legacy descriptors unchanged but rejects malformed or instance-owned reconciliation opt-in", () => {
    expect(() => validateSessionTurn({ ...descriptor, reconciliation: undefined }, descriptor.handleId)).not.toThrow();
    for (const reconciliation of [{}, { ...descriptor.reconciliation, version: 2 }, { ...descriptor.reconciliation, fenceDigest: "bad" },
      { ...descriptor.reconciliation, initialInputId: null }, { ...descriptor.reconciliation, credentials: "must-not-persist" }]) {
      expect(() => validateSessionTurn({ ...descriptor, reconciliation }, descriptor.handleId)).toThrow("reconciliation");
    }
    expect(() => validateSessionTurn({ ...descriptor, kind: "instance", historyBucket: null }, descriptor.handleId)).toThrow("reconciliation");
  });
});

it("validates consumed digests against persisted content and scoped later ownership bindings", async () => {
  const raw = await fixture(); await raw.openOperation("prompt", { model });
  await expect(raw.appendMessage({ role: "user", content: "Different fictional content." }, undefined,
    { id: "fictional-input", complete: true, placement: "initial", requestDigest: digestTurnInput("Fictional request.") })).rejects.toThrow("Invalid");
  await expect(raw.write("owner_binding", { kind: "host", ownerKey: "foreign", historyBucket: descriptor.historyBucket })).rejects.toThrow("Invalid");
  await expect(raw.write("handle_binding", { handleId: descriptor.handleId, baseRevision: 99, authoritative: true, model })).rejects.toThrow("Invalid");
  expect(raw.failure).toBeNull(); await raw.closeOperation("prompt", "failed"); await raw.endTurn(descriptor.turnId, "failed"); await raw.close();
});

it("separates a protected compaction purpose from execution/input adoption before prompt dispatch", async () => {
  const raw = await new MemorySessionRepo().create({ id: descriptor.handleId });
  const compaction = { ...descriptor, reconciliation: { ...descriptor.reconciliation, purpose: "compaction", initialInputId: null } };
  await raw.beginTurn(compaction.turnId, { model }, "synthetic", createTurnBinding(compaction, model));
  await expect(raw.openOperation("not-a-compaction", { model }, "prompt")).rejects.toThrow("Invalid");
  await raw.openOperation("actual-compaction", { model }, "compaction", "manual"); await raw.closeOperation("actual-compaction", "completed");
  await raw.endTurn(compaction.turnId, "completed", { ...result, text: "", stopReason: "compaction" });
  const evidence = await readTurnEvidence(raw, compaction.turnId);
  expect(matchTurnEvidence(evidence, { descriptor: compaction, purpose: "compaction", expectedModel: model, expectedInputs: [] }).status).toBe("matched");
  expect(matchTurnEvidence(evidence, request()).status).toBe("mismatch"); await raw.close();
});

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("matches before repairing a torn native tail and leaves mismatched evidence byte-identical", async () => {
  const root = await mkdtemp(join(tmpdir(), "turn-evidence-")); roots.push(root);
  const repo = new JsonlSessionRepo({ sessionsRoot: root }); const raw = await repo.create({ id: descriptor.handleId });
  await raw.beginTurn(descriptor.turnId, { model }, "host", createTurnBinding(descriptor, model)); await raw.sync(); const metadata = raw.metadata; await raw.close();
  await appendFile(metadata.path, '{"fictional":"torn'); const bytes = await readFile(metadata.path);
  const inspect = await repo.open(metadata, { repair: false }); const evidence = await readTurnEvidence(inspect, descriptor.turnId);
  expect(matchTurnEvidence(evidence, request({ descriptor: { ...descriptor, ownerKey: "foreign" } })).status).toBe("mismatch");
  await inspect.close(); expect((await readFile(metadata.path)).equals(bytes)).toBe(true);
  const matched = await repo.open(metadata, { repair: false }); expect(matchTurnEvidence(await readTurnEvidence(matched, descriptor.turnId), request()).status).toBe("matched");
  await matched.prepareReconciliation(); await repairInterruptedSession(matched); await matched.close();
  expect((await readFile(metadata.path, "utf8")).includes("torn")).toBe(false);
  const again = await repo.open(metadata, { repair: false }); expect((await readTurnEvidence(again, descriptor.turnId)).status).toBe("interrupted"); await again.close();
});
it("survives SIGKILL at first bound-start fsync and reconciles idempotently in empty fresh processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "turn-evidence-kill-")); roots.push(root);
  const start = fork(new URL("./fixtures/turn-evidence-worker.mjs", import.meta.url), [root, "admit"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try {
    const [notice] = await Promise.race([once(start, "message"), once(start, "exit").then(([code]) => { throw new Error(`Admission worker exited before barrier: ${code}`); })]);
    expect(notice).toEqual({ phase: "inline-start-synced" }); const exited = once(start, "exit"); start.kill("SIGKILL"); await exited;
  } finally { if (start.exitCode === null && start.signalCode === null) { const exited = once(start, "exit"); start.kill("SIGKILL"); await exited; } }
  async function recover() {
    const child = fork(new URL("./fixtures/turn-evidence-worker.mjs", import.meta.url), [root, "inspect"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const exited = once(child, "exit");
    try { const [notice] = await Promise.race([once(child, "message"), exited.then(([code]) => { throw new Error(`Recovery worker exited before report: ${code}`); })]); expect((await exited)[0]).toBe(0); return notice; }
    finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
  }
  const first = await recover(), second = await recover(); expect(first.beforeStatus).toBeNull(); expect(second.beforeStatus).toBe("interrupted");
  expect(first.evidence).toEqual(second.evidence); expect(first.evidence).toMatchObject({ status: "interrupted", operations: [], consumedInputIds: [],
    binding: { ownerKey: "fictional-owner" }, seal: { outcome: "interrupted", result: null }, interruptionEvidence: [{ cause: "crashed", operationIds: [] }] });
}, 10000);
