import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MemorySessionRepo } from "../session-store.js";
import { createEvidenceView, evidenceDigest, nativeCompatibility } from "../evidence-view.js";
import { projectContext } from "../request-projection.js";
import { createHandoffBudget, buildHandoff, buildOpenWorkLedger, renderHandoffMessage, prepareHandoff, checkHandoffDispatch, validateHandoffSummary } from "../handoff.js";

const provenance = { provider: "fictional", api: "fictional-api", account: "fixture-account" };
const target = { ...provenance, model: "A" };
const hostContext = { systemPrompt: "Current fictional rules", tools: [{ name: "Read", parameters: { type: "object" } }] };
const budget = createHandoffBudget({ contextWindow: 100000, outputReserve: 2000, inputTokens: 100, hostContext });
const options = { target, budget, hostContext, timestamp: 17, producer: "outgoing" };
const text = (value) => ({ role: "user", content: value, timestamp: 1 });
const summary = { intent: ["Fictional goal"], constraints: ["No deployment approval"], decisions: [], completedWork: [], failures: [], openWork: ["Inspect result"], nextActions: ["Wait"], references: [] };
async function segment(id, epoch, predecessorJournalId = null, messages = [text(id)]) {
  const repo = new MemorySessionRepo(); const store = await repo.create({ id, cwd: "/fictional" });
  await store.beginTurn(`turn-${id}`);
  for (let i = 0; i < messages.length; i++) await store.appendMessage(messages[i], `${id}-message-${i}`);
  await store.endTurn(`turn-${id}`, "completed");
  const descriptor = { ownerKey: "fictional-owner", historyBucket: "fictional-bucket", epoch, journalId: store.metadata.journalId,
    handleId: id, predecessorJournalId, sourceDigest: evidenceDigest(store.records), sourceSeq: store.seq, sourceTipId: store.tip, provenance };
  return { descriptor, header: { ...store.metadata, format: "mono-harness", version: 2, ownershipSchemaVersion: 1, ownership: { kind: "unbound" }, initialHandle: { id } }, records: store.records, store };
}
function view(segments) { return createEvidenceView({ ownerKey: "fictional-owner", historyBucket: "fictional-bucket", segments }); }
function refreshed(segment) { return { ...segment, records: segment.store.records, descriptor: { ...segment.descriptor,
  sourceDigest: evidenceDigest(segment.store.records), sourceSeq: segment.store.seq, sourceTipId: segment.store.tip } }; }

describe("positive native compatibility", () => {
  it.each(["provider", "api", "account"])("rejects missing, unknown and different %s", (key) => {
    for (const value of [undefined, "", "unknown", "different"]) expect(nativeCompatibility({ ...provenance, [key]: value }, target).compatible).toBe(false);
    expect(nativeCompatibility(provenance, target).compatible).toBe(true);
  });
});
it("projects A -> B -> A including intervening B and opaque signatures, with no copies in current evidence mode", async () => {
  const a = await segment("A", 1, null, [text("A fact"), { role: "assistant", provider: "fictional", api: "fictional-api", model: "A", stopReason: "stop", timestamp: 1,
    content: [{ type: "thinking", thinking: "Fictional reasoning", thinkingSignature: "opaque-fixture-signature" }, { type: "text", text: "A reply" }] }]);
  const b = await segment("B", 2, a.header.journalId, [text("B fact")]); const c = await segment("A-return", 3, b.header.journalId);
  const evidence = view([a, b, c]); const result = projectContext(evidence, { ...options, switching: true });
  expect(result.status).toBe("ready"); expect(JSON.stringify(result.messages)).toContain("B fact"); expect(JSON.stringify(result.messages)).toContain("opaque-fixture-signature");
  expect(projectContext(evidence, { mode: "evidence" }).entries.map((e) => e.id)).toEqual(["A-return-message-0"]);
  const missing = structuredClone({ descriptor: b.descriptor, header: b.header, records: b.records }); missing.descriptor.provenance.account = undefined;
  expect(projectContext(view([a, missing, c]), { ...options, switching: true })).toMatchObject({ status: "handoff_required", reason: "unknown_account" });
  expect(projectContext(evidence, { ...options, budget: createHandoffBudget({ contextWindow: 20000, outputReserve: 2000, inputTokens: 100 }), switching: true }).status).toBe("handoff_required");
});
it("rejects fabricated views, cycles, foreign owners, changed frozen tips/digests and nonmonotonic epochs", async () => {
  const a = await segment("A", 1); const b = await segment("B", 2, a.header.journalId);
  for (const change of [{ predecessorJournalId: "cycle" }, { ownerKey: "foreign" }, { sourceTipId: "missing" }, { sourceDigest: "bad" }, { epoch: 0 }]) {
    expect(() => view([a, { ...b, descriptor: { ...b.descriptor, ...change } }])).toThrow("Invalid");
  }
  expect(() => projectContext({ segments: [a] }, options)).toThrow("unvalidated");
  expect(() => view([a, a])).toThrow("Invalid");
});
it("persists opt-in composed coverage and replays inherited material exactly once", async () => {
  const a = await segment("A", 1); const b = await segment("B", 2, a.header.journalId);
  const frozen = view([a, b]);
  await b.store.appendComposedCompaction({ summary: "A and B checkpoint", tokensBefore: 100, retainedTail: [], tokensAfter: 20 }, frozen);
  expect(b.store.records.find((r) => r.kind === "compaction").schemaVersion).toBe(3);
  const c = await segment("C", 3, b.header.journalId); const result = projectContext(view([a, refreshed(b), c]), { ...options, switching: true });
  expect(result.messages).toHaveLength(2); expect(result.messages[0].summary).toBe("A and B checkpoint");
  const bad = refreshed(b); bad.records = structuredClone(bad.records); bad.records.find((r) => r.kind === "compaction").payload.compaction.checkpoint.inheritedCoverage.sources[0].sourceDigest = "0".repeat(64);
  bad.descriptor.sourceDigest = evidenceDigest(bad.records);
  expect(() => projectContext(view([a, bad, c]), { ...options, switching: true })).toThrow("coverage");
  await expect(b.store.appendComposedCompaction({}, frozen)).rejects.toThrow("changed");
});
it("keeps whole latest turns, visible text verbatim and historical calls as neutral data", async () => {
  const segments = []; for (let i = 0; i < 5; i++) segments.push(await segment(`turn${i}`, i, segments.at(-1)?.header.journalId ?? null, [text(`verbatim-${i}`)]));
  const evidence = view(segments); const prepared = prepareHandoff(evidence, options);
  expect(prepared.recent).toHaveLength(3); expect(prepared.older).toHaveLength(2);
  const result = buildHandoff(evidence, { ...options, summary }); expect(result.status).toBe("ready");
  expect(JSON.stringify(result.messages)).toContain("verbatim-4"); expect(JSON.stringify(result.messages)).not.toContain('"role":"toolResult"');
  const neutral = renderHandoffMessage({ role: "assistant", content: [{ type: "toolCall", id: "call", name: "Write", arguments: { file_path: "/fictional" } }, { type: "thinking", thinking: "not fabricated", thinkingSignature: "opaque" }] });
  expect(neutral.data[0].label).toBe("historical_tool_call_data"); expect(neutral.data[1].label).toBe("opaque_native_reference"); expect(JSON.stringify(neutral)).not.toContain("not fabricated");
  expect(buildHandoff(evidence, { ...options, summary })).toEqual(result);
});
it("accounts for started unknown effects, returned-but-unplaced results, interruption and unconsumed input without replay", async () => {
  const s = await segment("ledger", 0); const store = s.store;
  await store.beginTurn("pending"); await store.openOperation("op", { model: { provider: "fictional", api: "fictional-api", id: "A" } });
  await store.appendMessage({ role: "assistant", provider: "fictional", api: "fictional-api", model: "A", content: [{ type: "toolCall", id: "unknown", name: "Write", arguments: { file_path: "/fictional/unknown" } }, { type: "toolCall", id: "returned", name: "Read", arguments: { file_path: "/fictional/result" } }], stopReason: "toolUse", timestamp: 1 }, "calls");
  for (const [callId, name] of [["unknown", "Write"], ["returned", "Read"]]) for (const admission of ["observed", "admitted", "started"]) await store.write("tool_call", { callId, name, messageId: "calls", admission }, { operationId: "op" });
  await store.write("tool_result", { callId: "returned", name: "Read", phase: "returned", messageId: null, outcome: "success", message: { role: "toolResult", toolCallId: "returned", toolName: "Read", isError: false, content: [{ type: "text", text: "Confirmed fixture result" }], timestamp: 2 } }, { operationId: "op" });
  await store.write("interruption", { cause: "crashed", operationIds: ["op"], tipId: store.tip, calls: [] });
  await store.write("input_queued", { inputId: "later", state: "queued", placement: "live" });
  const ledger = buildOpenWorkLedger(view([refreshed(s)]));
  expect(ledger.find((r) => r.callId === "unknown")).toMatchObject({ outcome: "unknown", admission: "started", placed: false, cause: "crashed" });
  expect(ledger.find((r) => r.callId === "returned")).toMatchObject({ outcome: "success", returned: true, placed: false });
  expect(ledger.find((r) => r.kind === "input")).toMatchObject({ id: "later", outcome: "not_consumed" });
  expect(buildHandoff(view([refreshed(s)]), options).status).toBe("ready");
});
it("checkpoint fallback retains exact envelope plus COMPLETE suffix and all uncovered predecessors", async () => {
  const a = await segment("A", 0); const b = await segment("B", 1, a.header.journalId);
  await b.store.appendCompaction({ summary: "exact fixture checkpoint", tokensBefore: 50, retainedTail: [] });
  for (let i = 0; i < 4; i++) { await b.store.beginTurn(`suffix${i}`); await b.store.appendMessage(text(`suffix-${i}`), `suffix-message-${i}`); await b.store.endTurn(`suffix${i}`, "completed"); }
  const evidence = view([a, refreshed(b)]); const result = buildHandoff(evidence, options);
  expect(result.status).toBe("ready"); expect(result.artifact.checkpoint.suffix).toHaveLength(4); expect(result.artifact.checkpoint.prefix).toHaveLength(1);
  expect(result.artifact.checkpoint.envelope).toEqual((await b.store.getEntries()).find((e) => e.type === "compaction").checkpoint);
});
it("refuses mandatory latest/ledger overflow, host-cap extensions and oversized current input; never clips", async () => {
  const a = await segment("huge", 0, null, [text("x".repeat(300000))]);
  expect(buildHandoff(view([a]), options)).toMatchObject({ status: "budget_failure", reason: "mandatory_history" });
  expect(checkHandoffDispatch({ messages: [], systemPrompt: "x".repeat(100000) }, budget)).toMatchObject({ status: "budget_failure", reason: "host_cap" });
  expect(checkHandoffDispatch({ messages: [], currentInput: "x".repeat(1000) }, budget).reason).toBe("input_allowance");
  expect(createHandoffBudget({ contextWindow: 100000, outputReserve: 2000, inputTokens: 100, hostContext: { tools: [{ parameters: "x".repeat(60000) }] } }).hostCap).toBeGreaterThan(20000);
  for (const malformed of [null, {}, { ...summary, intent: "not-array" }, { ...summary, extra: [] }, Object.fromEntries(Object.keys(summary).map((key) => [key, []]))]) expect(() => validateHandoffSummary(malformed)).toThrow();
  expect(buildHandoff(view([await segment("A", 0)]), { ...options, summary: {} }).status).toBe("summary_rejected");
});
it("enforces one context-builder seam in production source (definition and compatibility export remain)", async () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  async function scan(path) { const files = []; for (const e of await readdir(path, { withFileTypes: true })) { if (e.name === "__tests__") continue; const child = `${path}/${e.name}`; if (e.isDirectory()) files.push(...await scan(child)); else if (e.name.endsWith(".js")) files.push(child); } return files; }
  const files = [...await scan(`${root}packages/harness/src`), ...await scan(`${root}packages/agent-runtime/src`)];
  for (const file of files) {
    if (file.endsWith("/session-context.js") || file.endsWith("/request-projection.js") || file.endsWith("/harness/src/index.js")) continue;
    expect((await readFile(file, "utf8")).replace(/export \{ buildHarnessSessionContext \} from [^;]+;/g, ""), file).not.toMatch(/\bbuildHarnessSessionContext\b/);
  }
});

it("opt-in model-change records carry only an artifact reference; canonical gaps cannot masquerade as native evidence", async () => {
  const a = await segment("A", 0);
  await a.store.appendModelChangeReference({ switchId: "fictional-switch", from: provenance, to: target, artifactRef: { id: "fictional-artifact", hash: "0".repeat(64) } });
  const event = a.store.records.find((r) => r.kind === "model_change");
  expect(event.schemaVersion).toBe(3); expect(event.payload.artifactRef).toEqual({ id: "fictional-artifact", hash: "0".repeat(64) });
  await expect(a.store.appendModelChangeReference({ switchId: "invalid", from: provenance, to: target, artifactRef: { id: "bad", hash: "bad", summary: "not authoritative" } })).rejects.toThrow("Invalid");
  const evidence = createEvidenceView({ ownerKey: "fictional-owner", historyBucket: "fictional-bucket", segments: [refreshed(a)], gaps: [
    { afterJournalId: a.header.journalId, reference: "canonical-fixture-reference", reason: "missing-native-history", messages: [text("Canonical-only fictional fact")] },
  ] });
  expect(projectContext(evidence, { ...options, switching: true })).toMatchObject({ status: "handoff_required", reason: "canonical_only_gap" });
  expect(JSON.stringify(buildHandoff(evidence, options))).toContain("Canonical-only fictional fact");
});
