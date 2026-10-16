import { SessionStore } from "../../engine/session-store.js";
import { createTurnBinding } from "../../engine/turn-evidence.js";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { generateEngineTurnResponse } from "../../execution/pi/run.js";
import { it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { produceNativeHandoffSummary } from "../../execution/pi/handoff-producer.js";
import { detachDurableNativeSession, retireDurableNativeSession, resolveDurableNativeSessionRepo, reconcileNativeSessionTurn } from "../../engine/session-lifecycle.js";

const summary = { intent: ["Fictional intent"], constraints: ["No approval"], decisions: [], completedWork: [], failures: [], openWork: ["Verify unknown effects"], nextActions: [], references: [] };
const prepared = { status: "prepared", older: [], recent: [], ledger: [{ outcome: "unknown" }], coverage: [] };
const model = { provider: "fictional", id: "summary", api: "fictional-api", contextWindow: 100000 };
const response = (content = JSON.stringify(summary), stopReason = "stop") => ({ content: [{ type: "text", text: content }], stopReason, usage: { input: 20, output: 10, cost: { total: 0 } } });
it("uses exactly one selected no-tools completion and returns accounting without retry/fallback", async () => {
  const completeSimple = vi.fn(async (..._args) => response());
  expect(await produceNativeHandoffSummary({ completeSimple, model, prepared, outputReserve: 1000, completionOptions: { transport: "websocket", maxRetries: 9 } })).toMatchObject({ status: "ready", summary, usage: { input: 20, output: 10 } });
  expect(completeSimple).toHaveBeenCalledTimes(1);
  expect(completeSimple.mock.calls[0][0]).toBe(model);
  expect(completeSimple.mock.calls[0][1].tools).toEqual([]);
  expect(completeSimple.mock.calls[0][2].maxTokens).toBe(1000);
  expect(completeSimple.mock.calls[0][2]).toMatchObject({ transport: "sse", maxRetries: 0 });
});
it.each([["", "stop"], ["{}", "stop"], [JSON.stringify(summary), "length"], [JSON.stringify(summary), "aborted"], [JSON.stringify(summary), "error"]])("rejects malformed/empty/truncated/aborted/error summaries without repeat (%s, %s)", async (content, stopReason) => {
  const completeSimple = vi.fn(async () => response(content, stopReason));
  expect((await produceNativeHandoffSummary({ completeSimple, model, prepared, outputReserve: 1000 })).status).toBe("summary_rejected");
  expect(completeSimple).toHaveBeenCalledTimes(1);
});
it("refuses unfit producer input before a paid request and refuses tool-shaped output", async () => {
  const completeSimple = vi.fn();
  expect(await produceNativeHandoffSummary({ completeSimple, model: { ...model, contextWindow: 1000 }, prepared, outputReserve: 900 })).toMatchObject({ status: "budget_failure", reason: "producer_input" });
  expect(completeSimple).not.toHaveBeenCalled();
  completeSimple.mockResolvedValue({ ...response(), content: [{ type: "toolCall", id: "fictional", name: "Write", arguments: {} }] });
  expect(await produceNativeHandoffSummary({ completeSimple, model, prepared, outputReserve: 1000 })).toMatchObject({ reason: "invalid_content" });
});
it("reports request-outcome-unknown with no retry or leaked provider exception", async () => {
  const completeSimple = vi.fn(async () => { throw new Error("sensitive fictional request data"); });
  const result = await produceNativeHandoffSummary({ completeSimple, model, prepared, outputReserve: 1000 });
  expect(result).toMatchObject({ reason: "request_outcome_unknown" }); expect(JSON.stringify(result)).not.toContain("sensitive"); expect(completeSimple).toHaveBeenCalledTimes(1);
});
const roots = []; afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("preserving detach leaves exact journal bytes, missing-current detach never deletes ancestors, retirement remains destructive", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-preserve-fixture-")); roots.push(root);
  const repo = resolveDurableNativeSessionRepo(root); const session = await repo.create({ id: "fictional-predecessor" });
  await session.appendMessage({ role: "user", content: "Retained fictional history", timestamp: 1 }); await session.close();
  const original = await readFile(session.metadata.path);
  expect(await detachDurableNativeSession("fictional-predecessor", root)).toEqual({ status: "detached", evidence: "preserved" });
  await detachDurableNativeSession("missing-current", root); expect(await readFile(session.metadata.path)).toEqual(original);
  await retireDurableNativeSession("fictional-predecessor", root);
  await expect(readFile(session.metadata.path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses preserving detach during real native dispatch, then detaches the idle registry without changing bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-detach-busy-fixture-")); roots.push(root);
  const faux = fauxProvider({ provider: "detach-fixture", models: [{ id: "fixture" }] }); const models = createModels(); /** @type {Promise<any>} */ let attempt;
  models.setProvider({ ...faux.provider, streamSimple(selected, context, options) {
    attempt = detachDurableNativeSession("busy-fixture", root).then((result) => ({ result }), (error) => ({ error }));
    return faux.provider.streamSimple(selected, context, options);
  } });
  faux.setResponses([fauxAssistantMessage([fauxText("Fictional complete response")])]);
  const result = await generateEngineTurnResponse("Fictional rules", { model: { provider: "detach-fixture", model: "fixture", reference: "detach-fixture:fixture" },
    piResolvedModel: faux.getModel(), piResolvedModels: models, allowedTools: [], effort: "none", sessionId: "busy-fixture", sessionsRoot: root,
    sessionKeepAlive: true, compaction: { enabled: false }, messages: [{ role: "user", content: "Fictional input" }] });
  expect(result.error).toBeNull(); expect(/** @type {any} */ (await attempt).error.code).toBe("ERR_HARNESS_WRITER_BUSY");
  const metadata = (await resolveDurableNativeSessionRepo(root).list())[0]; const before = await readFile(metadata.path);
  await detachDurableNativeSession("busy-fixture", root); expect(await readFile(metadata.path)).toEqual(before);
});

it("accepts a successful non-truncated summary even when bytes/3 exceeds the completion token reserve", async () => {
  const large = { ...summary, intent: ["Fictional words ".repeat(250)] };
  const completeSimple = vi.fn(async (..._args) => response(JSON.stringify(large)));
  const result = await produceNativeHandoffSummary({ completeSimple, model, prepared, outputReserve: 1000 });
  expect(result).toMatchObject({ status: "ready", summary: large });
  expect(completeSimple.mock.calls[0][2]).toMatchObject({ maxTokens: 1000, transport: "sse", maxRetries: 0 });
});
it.each(["find", "create"])("refuses detach during in-flight cold %s before an idle handle exists", async (phase) => {
  const root = await mkdtemp(join(tmpdir(), "native-detach-cold-fixture-")); roots.push(root);
  const repo = resolveDurableNativeSessionRepo(root);
  if (phase === "find") { const raw = await repo.create({ id: "cold-fixture" }); await raw.close(); }
  let reached; let release = () => {};
  const waiting = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = () => resolve(undefined); });
  const original = repo[phase].bind(repo);
  const spy = vi.spyOn(repo, phase).mockImplementationOnce(async (...args) => { reached(); await gate; return original(...args); });
  const faux = fauxProvider({ provider: "cold-fixture", models: [{ id: "fixture" }] }); const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxText("Fictional cold response")])]);
  const running = generateEngineTurnResponse("Fictional rules", { model: { provider: "cold-fixture", model: "fixture", reference: "cold-fixture:fixture" },
    piResolvedModel: faux.getModel(), piResolvedModels: models, allowedTools: [], effort: "none", sessionId: "cold-fixture", sessionsRoot: root,
    sessionKeepAlive: true, compaction: { enabled: false }, messages: [{ role: "user", content: "Fictional input" }] });
  try {
    await waiting;
    await expect(detachDurableNativeSession("cold-fixture", root)).rejects.toMatchObject({ code: "ERR_HARNESS_WRITER_BUSY" });
  } finally { release?.(); spy.mockRestore(); }
  expect((await running).error).toBeNull();
  await expect(detachDurableNativeSession("cold-fixture", root)).resolves.toMatchObject({ status: "detached" });
});

it("turn_advanced reconciliation rejects synchronously without reading context entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-advanced-no-context-fixture-")); roots.push(root);
  const repo = resolveDurableNativeSessionRepo(root); const raw = await repo.create({ id: "advanced-fixture" });
  const expectedModel = { provider: "fictional", id: "fixture", api: "fictional-api" };
  const descriptor = { kind: "host", ownerKey: "fictional-owner", historyBucket: "fictional-bucket", turnId: "first-turn", handleId: "advanced-fixture", baseRevision: 0,
    reconciliation: { version: 1, purpose: "compaction", fenceDigest: "a".repeat(64), initialInputId: null } };
  await raw.beginTurn("first-turn", { model: expectedModel }, "synthetic", createTurnBinding(descriptor, expectedModel));
  await raw.openOperation("first-operation", { model: expectedModel }, "compaction", "manual"); await raw.closeOperation("first-operation", "completed"); await raw.endTurn("first-turn", "completed", { text: null, error: null, failureKind: null, cancelled: false, stopReason: "stop" });
  await raw.beginTurn("advanced-turn", { model: expectedModel }); await raw.openOperation("advanced-operation", { model: expectedModel });
  await raw.closeOperation("advanced-operation", "completed"); await raw.endTurn("advanced-turn", "completed"); await raw.close();
  const reads = vi.spyOn(SessionStore.prototype, "getEntries");
  try {
    expect(await reconcileNativeSessionTurn({ descriptor, sessionsRoot: root, purpose: "compaction", expectedModel, expectedBaseTip: null, expectedInputs: [] }))
      .toEqual({ status: "mismatch", reason: "turn_advanced" });
    expect(reads).not.toHaveBeenCalled();
  } finally { reads.mockRestore(); }
});

it("forwards guarded retirement authority through the durable native helper", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-guarded-retirement-")); roots.push(root);
  const hostAuthority = { version: 1, rootId: "1".repeat(64), authorityId: "2".repeat(64), ownerKey: "fictional-owner", historyBucket: "fictional-bucket" };
  const repo = resolveDurableNativeSessionRepo(root), assertOwned = vi.fn(async () => {});
  const store = await repo.create({ id: "guarded-retirement", hostAuthority, assertOwned }); await store.close();
  const bytes = await readFile(store.metadata.path);
  await expect(retireDurableNativeSession(store.metadata.id, root)).rejects.toThrow("authority");
  expect(await readFile(store.metadata.path)).toEqual(bytes);
  await retireDurableNativeSession(store.metadata.id, root, { hostAuthority, disposition: "D", assertOwned });
  await expect(readFile(store.metadata.path)).rejects.toMatchObject({ code: "ENOENT" }); expect(assertOwned).toHaveBeenCalled();
});
