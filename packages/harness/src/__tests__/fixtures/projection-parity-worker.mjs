// Compare byte strings with identical time/UUID inputs, never normalize output.
import crypto from "node:crypto";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, rm, rename } from "node:fs/promises";
let uuid = 0; crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`;
crypto.randomBytes = (size) => Buffer.alloc(size, 7);
crypto.randomFillSync = (buffer) => { new Uint8Array(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, buffer.byteLength).fill(7); return buffer; };
crypto.webcrypto.getRandomValues = (array) => { array.fill(7); return array; };
syncBuiltinESMExports(); Math.random = () => 0.125;
let clock = 1700000000000; Date.now = () => clock;
Object.defineProperty(performance, "now", { value: () => 0 });
const [source, runtimeSource, root, legacy] = process.argv.slice(2);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "@mono-agent/harness" || specifier.startsWith("@mono-agent/harness/")) return {
    url: pathToFileURL(`${source}/${specifier === "@mono-agent/harness" ? "index.js" : specifier.slice("@mono-agent/harness/".length)}`).href, shortCircuit: true,
  };
  return nextResolve(specifier, context);
} });
// Filesystem identity is an external input, not portable golden output. Freeze
// ONLY the identity returned for import serialization; reader path/fd guards
// still use their real pinned stats, and content hashing still reads real bytes.
const { JournalReader } = await import(pathToFileURL(`${source}/journal-reader.js`));
const scan = JournalReader.prototype.scan, fingerprint = JournalReader.prototype.fingerprint;
const identity = (stats) => ({ ...stats, dev: 101, ino: 202, mtimeMs: 1700000000000 });
JournalReader.prototype.scan = async function(...args) { const result = await scan.apply(this, args); return { ...result, identity: identity(result.identity) }; };
JournalReader.prototype.fingerprint = async function(...args) { return identity(await fingerprint.apply(this, args)); };
const { JsonlSessionRepo } = await import(pathToFileURL(`${source}/session-store.js`));
const { createRunDriver } = await import(pathToFileURL(`${source}/run-driver.js`));
const { buildHarnessSessionContext } = await import(pathToFileURL(`${source}/session-context.js`));
const { readLegacySession } = await import(pathToFileURL(`${source}/legacy-import.js`));
const { createModels, fauxProvider, fauxAssistantMessage, fauxText, normalizeContext } = await import("@earendil-works/pi-ai");
await rm(root, { recursive: true, force: true });
const repo = new JsonlSessionRepo({ sessionsRoot: root });
const raw = await repo.create({ id: "parity-fixture", cwd: "/fictional" });
const faux = fauxProvider({ provider: "parity-fixture", models: [{ id: "A" }] }); const models = createModels();
const contexts = [];
models.setProvider({ ...faux.provider, streamSimple(selected, context, options) { contexts.push(JSON.stringify(context)); return faux.provider.streamSimple(selected, context, options); } });
faux.setResponses([fauxAssistantMessage([fauxText("Fictional response")])]);
const driver = createRunDriver(raw, { model: faux.getModel(), models, tools: [], systemPrompt: "Fictional rules", retry: { enabled: false } });
await driver.prompt("Fictional prompt");
const contextBefore = JSON.stringify(buildHarnessSessionContext(await raw.getEntries(), { repairs: await raw.getRepairEntries() }));
const driverCompactionInputs = [];
driver.hooks.on("before_compaction", ({ branchEntries }) => {
  driverCompactionInputs.push(JSON.stringify(branchEntries));
  return { compaction: { summary: "Fictional exact checkpoint", tokensBefore: 100, tokensAfter: 20, retainedTail: [branchEntries.at(-1).message] } };
});
await driver.compact();
const contextAfter = JSON.stringify(buildHarnessSessionContext(await raw.getEntries(), { repairs: await raw.getRepairEntries() }));
const wirePayloads = [];
for (const api of ["anthropic-messages", "openai-responses"]) {
  const { streamSimple } = await import(`@earendil-works/pi-ai/api/${api}`);
  const model = { ...faux.getModel(), api, baseUrl: "https://fixture.invalid/v1", reasoning: false };
  const stream = streamSimple(model, normalizeContext({ systemPrompt: "Fictional current rules", messages: JSON.parse(contextBefore), tools: [] }), {
    apiKey: "synthetic-test-value", maxRetries: 0,
    fetch: async (_url, init) => { wirePayloads.push(init.body); throw new Error("fixture transport stop"); },
  });
  await stream.result();
}
const bytes = await readFile(raw.metadata.path, "utf8");
await driver.close(); await raw.close();
const reopened = await repo.open(raw.metadata); const ancestry = JSON.stringify(await reopened.getEntries()); await reopened.close();
const importRoot = `${root}-import`;
await rm(`${importRoot}/mono-v2`, { recursive: true, force: true });
const importRepo = new JsonlSessionRepo({ sessionsRoot: importRoot });
const importMetadata = (await importRepo.list())[0];
const importSession = await importRepo.open(importMetadata);
const importBytes = await readFile(importSession.metadata.path, "utf8");
await importSession.close();
await rename(`${importMetadata.path}.migrated`, importMetadata.path);
const imported = JSON.stringify(await readLegacySession({ path: legacy, id: "fixture-session" }, dirname(legacy)));
const repairs = await captureRepairs(repo);
const runtime = await captureRuntime(repairs.session);
await repairs.session.close();
console.log(JSON.stringify({ contexts, contextBefore, contextAfter, bytes, ancestry, imported, importBytes, wirePayloads, driverCompactionInputs, repairs: repairs.capture, runtime }));
await rm(root, { recursive: true, force: true });

async function captureRepairs(repo) {
  const session = await repo.create({ id: "repair-fixture", cwd: "/fictional" });
  await session.beginTurn("repair-turn"); await session.openOperation("repair-operation", {});
  await session.appendMessage({ role: "user", content: "Fictional interrupted request", timestamp: 1 }, "repair-user");
  clock = 1700000000010;
  await session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "unknown", name: "Write", arguments: { file_path: "/fictional/unknown", content: "fictional" } },
    { type: "toolCall", id: "returned", name: "Read", arguments: { file_path: "/fictional/returned" } }], stopReason: "toolUse", timestamp: 10 }, "repair-assistant");
  for (const [callId, name] of [["unknown", "Write"], ["returned", "Read"]]) for (const admission of ["observed", "admitted", "started"]) {
    await session.write("tool_call", { callId, name, messageId: "repair-assistant", admission }, { operationId: "repair-operation" });
  }
  await session.write("tool_result", { callId: "returned", name: "Read", messageId: null, phase: "returned", outcome: "success", message: {
    role: "toolResult", toolCallId: "returned", toolName: "Read", content: [{ type: "text", text: "Fictional returned outcome" }], isError: false, timestamp: 12,
  } }, { operationId: "repair-operation" });
  clock = 1700000000020; await session.write("interruption", { cause: "crashed", operationIds: ["repair-operation"], calls: [], tipId: session.tip }, { id: "repair-early" });
  clock = 1700000000030; await session.write("interruption", { cause: "crashed", operationIds: ["repair-operation"], calls: [], tipId: session.tip }, { id: "repair-late" });
  await session.closeOperation("repair-operation", "interrupted"); await session.endTurn("repair-turn", "interrupted");
  const repairEntries = await session.getRepairEntries(); const entries = await session.getEntries();
  const projected = JSON.stringify(buildHarnessSessionContext(entries, { repairs: repairEntries }));
  const repairDriver = createRunDriver(session, { model: faux.getModel(), models, tools: [], systemPrompt: "Fictional repair rules", retry: { enabled: false } });
  const compactionInputs = [];
  repairDriver.hooks.on("before_compaction", ({ branchEntries }) => { compactionInputs.push(JSON.stringify(branchEntries)); return { compaction: {
    summary: "Fictional interruption checkpoint", tokensBefore: 150, tokensAfter: 40, retainedTail: branchEntries.slice(-2).map((e) => e.message),
  } }; });
  await repairDriver.compact(); await repairDriver.close();
  return { session, capture: { repairEntries, projected, compactionInputs,
    compactedContext: JSON.stringify(buildHarnessSessionContext(await session.getEntries(), { repairs: await session.getRepairEntries() })), bytes: await readFile(session.metadata.path, "utf8") } };
}
async function captureRuntime(session) {
  const pn = (name) => import(pathToFileURL(`${runtimeSource}/ai/providers/pi-native/${name}.js`));
  const { createPiSessionAdapter } = await pn("harness-adapter");
  const { estimateCurrentContextTokens, estimateSessionMessageTokens } = await pn("compaction-driver");
  const adapter = createPiSessionAdapter(session);
  const context = await adapter.buildContext();
  const estimates = [await estimateCurrentContextTokens(adapter, 25, 15), await estimateSessionMessageTokens(adapter)];
  const midRun = await captureMidRun(pn);
  const recovery = await captureRecovery(pn);
  return { adapterContext: JSON.stringify(context), estimates, midRun, recovery };
}
async function captureMidRun(pn) {
  const { createMidRunCompaction } = await pn("mid-run-compaction");
  const hooks = [], subscribers = [], settings = [], requests = [], events = [], warnings = [];
  const model = { provider: "fictional", api: "faux", id: "summary", contextWindow: 10000, maxTokens: 1000, reasoning: false };
  const branchEntries = Array.from({ length: 10 }, (_, index) => ({ type: "message", id: `mid-${index}`, parentId: index ? `mid-${index - 1}` : null, timestamp: 1,
    message: index % 2 ? { ...fauxAssistantMessage([fauxText(`Fictional reply ${index} ${"x".repeat(5000)}`)]), timestamp: 1 }
      : { role: "user", content: `Fictional request ${index} ${"x".repeat(5000)}`, timestamp: 1 } }));
  const harness = { models: { getModel: () => model, completeSimple: async (_model, context, options) => { requests.push(JSON.stringify({ context, options })); return {
    role: "assistant", content: [{ type: "text", text: "Fictional older-history checkpoint" }], stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } },
  }; } }, getModel: () => model, getThinkingLevel: () => "off", setCompactionSettings: async (value) => settings.push(value), setMidRunCompactionArmed: () => {},
    on: (_type, hook) => { hooks.push(hook); return () => {}; }, subscribe: (hook) => { subscribers.push(hook); return () => {}; } };
  const state = { sessionBaselineCount: 3, compaction: { policy: { enabled: true, contextWindow: 10000, triggerTokens: 5000, keepRecentTokens: 100, summaryMaxTokens: 100, compactionMinSavingsTokens: 100 },
    diagnostics: { context_fixed_overhead_tokens: 25, context_user_message_tokens: 5 }, carriedUsage: null, carriedUsageMeasured: false } };
  const controller = createMidRunCompaction(state, { harness, options: {}, reference: "fictional:summary", onEvent: (event) => events.push(event), runtimeWarnings: warnings });
  const armed = await controller.arm();
  const decision = await hooks[0]({ reason: "threshold", branchEntries, signal: new AbortController().signal });
  if (decision?.compaction) for (const hook of subscribers) hook({ type: "compaction_end", reason: "threshold", status: "completed" });
  await controller.disarm();
  return { armed, decision, settings, requests, events, warnings, state };
}
async function captureRecovery(pn) {
  const { generatePiNativeResponse } = await import(pathToFileURL(`${runtimeSource}/ai/providers/pi-native.js`));
  const { recoverDurableNativeSession, resolveDurableNativeSessionRepo } = await pn("session-lifecycle");
  clock = 1700000000000;
  const faux = fauxProvider({ provider: "recovery-fixture", models: [{ id: "A" }] }); const models = createModels(); models.setProvider(faux.provider);
  const controller = new AbortController();
  faux.setResponses([fauxAssistantMessage([fauxText("Fictional warm reply")]), () => { controller.abort(); return fauxAssistantMessage([fauxText("Fictional cancelled draft")], { stopReason: "aborted" }); }]);
  const options = { model: { provider: "recovery-fixture", model: "A", reference: "recovery-fixture:A" }, piResolvedModel: faux.getModel(), piResolvedModels: models,
    cwd: "/fictional", piSessionsRoot: `${root}-recovery`, sessionId: "recovery-fixture", sessionKeepAlive: true, effort: "none", allowedTools: [], compaction: { enabled: false } };
  const warm = await generatePiNativeResponse("Fictional rules", { ...options, messages: [{ role: "user", content: "Fictional warm request" }] });
  if (warm.error) throw new Error("Fixture warm dispatch failed");
  const cancelled = await generatePiNativeResponse("Fictional rules", { ...options, sessionRecovery: { runId: "fixture-recovery-turn", revision: 1 }, abortSignal: controller.signal, messages: [{ role: "user", content: "Fictional interrupted request" }] });
  const receipt = cancelled.providerSessionRecovery;
  if (!receipt) throw new Error("Fixture recovery receipt missing");
  const repo = resolveDurableNativeSessionRepo(`${root}-recovery`); const metadata = (await repo.list())[0];
  const before = await readFile(metadata.path, "utf8");
  const recovered = await recoverDurableNativeSession(receipt, { appliedInputIds: [] });
  const raw = await repo.open(metadata); const ancestry = JSON.stringify(await raw.getEntries()); await raw.close();
  const after = await readFile(metadata.path, "utf8");
  await rm(`${root}-recovery`, { recursive: true, force: true });
  return { receipt, cancelled: cancelled.cancelled, recovered, before, after, ancestry };
}
