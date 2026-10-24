// Controlled transport, real built app/registry/job store and durable sessions.
// Run after: pnpm --filter @mono-agent/app... run build
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { createToolHistoryArtifactSink } from "@mono-agent/conversation";
import { registerHooks } from "node:module";

const turnSourceRoot = new URL("../../turn/src/", import.meta.url).href;
const turnDistRoot = new URL("../../turn/dist/", import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  return resolved.url.startsWith(turnSourceRoot)
    ? { ...resolved, url: turnDistRoot + resolved.url.slice(turnSourceRoot.length) } : resolved;
} });
const { resolveJsonMonoAgentConfig } = await import("@mono-agent/config");
const { createMonoRuntime } = await import("@mono-agent/turn/host");
const { createSandboxPolicy } = await import("@mono-agent/turn/host/sandbox");
const { createSubagentRecoveryAccess } = await import("../dist/subagents/subagent-recovery-access.js");
const { buildSubagentsOptions } = await import("../dist/composition/configured-subagents.js");
const { createSubagentInstanceRegistry } = await import("../dist/subagents/subagent-instances.js");
const { openProcessJobsService } = await import("../dist/process-jobs/process-jobs-service.js");
const { openProcessJobStore } = await import("../dist/process-jobs/process-jobs-store.js");
const { PROCESS_JOBS_DEFAULTS } = await import("../dist/process-jobs/process-jobs-config.js");
const { createAgentTool } = await import("../../turn/dist/tools/delegation/agent-tool.js");
const { createAgentManageTool } = await import("../../turn/dist/tools/delegation/agent-manage-tool.js");
const { generateEngineTurnResponse } = await import("../../turn/dist/execution/pi/run.js");
const { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } = await import("../../turn/node_modules/@earendil-works/pi-ai/dist/index.js");

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function until(check) {
  const deadline = Date.now() + 10_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, "bounded local proof deadline");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const root = await mkdtemp(resolve(process.cwd(), "node_modules/.subagent-stop-smoke-"));
const owner = createMonoRuntime();
const origin = { conversationId: "web:stop-smoke", baseConversationId: "web:stop-smoke", bucket: null, replyToConversationId: "web:stop-smoke", normalizedReplyTarget: "web:stop-smoke", runId: "parent", historyBoundary: "parent", channel: "web" };
let service;
let releaseLate;
try {
  const stateDir = resolve(root, "jobs");
  const store = await openProcessJobStore(root, stateDir);
  const wakes = [];
  service = await openProcessJobsService({ cwd: root, workspace: root, store,
    settings: { ...PROCESS_JOBS_DEFAULTS, configured: true, enabled: true, stateDir, maxConcurrent: 1, maxQueued: 0 },
    registration: {}, attestRegistration: async () => ({}), wake: async (input) => { wakes.push(input); return { delivered: true }; },
  });
  await service.activateWakes();
  const registryRoot = resolve(root, "children");
  const access = { workspace: root, readableRoots: [], sandboxPolicy: createSandboxPolicy({ root }) };
  const registry = createSubagentInstanceRegistry({ root: registryRoot,
    ...createSubagentRecoveryAccess({ service, privateRoots: async () => [stateDir, registryRoot], hostAccess: () => access }),
    retireSession: (id, root) => owner.retireDurableSession(id, root),
    ownerForReservation: (jobId) => ({ jobId, storeRoot: stateDir }),
    resolveOwner: (identity) => service.resolveSubagentOwner(identity),
    checkOwnerIndex: (conversationId, known) => service.checkSubagentOwnerIndex(conversationId, known),
  });
  service.bindManagedSubagents({ root: registryRoot,
    verify: async (identity) => (await registry.open(identity.conversationId, { existingOnly: true })).verifyOwner(identity),
    publish: async (phase, publication) => (await registry.open(publication.identity.conversationId, { existingOnly: true })).publishOwned(phase, publication),
  });
  const instances = await registry.open(origin.conversationId);
  await writeFile(resolve(root, "evidence.txt"), "smoke retained tool evidence");
  const config = resolveJsonMonoAgentConfig({ cwd: root, json: {
    runtime: { model: "openai-codex:gpt-5.5" },
    context: { identityPath: resolve(root, "IDENTITY.md") },
    tools: { allowedTools: ["Agent", "AgentManage"] },
    subagents: { enabled: true, instances: { root: registryRoot } },
  } });
  const faux = fauxProvider({ provider: config.runtime.model.provider, models: [{ id: config.runtime.model.model }], tokensPerSecond: undefined });
  const models = createModels(); models.setProvider(faux.provider);
  const sessions = [];
  const runtime = { recoverSession: owner.recoverSession.bind(owner), run: async (prompt, options) => {
    sessions.push(options.sessionId);
    return generateEngineTurnResponse(prompt, { ...options, piResolvedModel: faux.getModel(), piResolvedModels: models, resolvePiApiKey: async () => "controlled-faux-key" });
  } };
  const subagents = buildSubagentsOptions(config, { runtime, baseModel: config.runtime.model }, { conversationId: origin.conversationId, runId: "parent", instances }).subagents;
  subagents.backgroundSubagentController = service.internalController(origin, 0);
  const context = { cwd: root, model: config.runtime.model, recoveryAccess: access, persistArtifact: createToolHistoryArtifactSink({ artifactRoot: resolve(root, "artifacts"), runId: "parent" }) };
  const agent = createAgentTool(subagents, context); const send = createAgentManageTool(subagents, context);
  const toolBearing = deferred();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("Read", { file_path: "evidence.txt" }, { id: "smoke-read" })]),
    async (_context, options) => {
      toolBearing.resolve();
      await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
      return fauxAssistantMessage([fauxText("aborted partial turn")], { stopReason: "aborted" });
    },
  ]);
  const started = await agent.execute("start", { id: "helper", persist: true, background: true, prompt: "remember smoke original context" });
  await toolBearing.promise;
  const stopped = await send.execute("stop", { id: "helper", stop: true });
  assert.equal(stopped.details.stop.status, "stopped"); assert.equal(stopped.details.stop.resumable, true);
  const first = await instances.get("helper");
  const stored = await store.get(started.details.jobId);
  assert.equal(stored.subagentOwnership.turnToken, started.details.jobId);
  assert.equal(stored.subagentOwnership.instanceIncarnation, first.incarnation);
  assert.equal(stored.subagentOwnership.publication.receiptPending, false);
  let resumedContext;
  const finalAnswer = `digest verification; token thresholds; basic setup; bearer of bad news; ${"Planning notes. ".repeat(2_000)}THE-END`;
  faux.setResponses([(context) => { resumedContext = context; return fauxAssistantMessage([fauxText(finalAnswer)]); }]);
  const resumed = await send.execute("resume", { id: "helper", message: "continue same instance", background: true });
  await until(async () => (await service.get(resumed.details.jobId))?.wake.state === "delivered");
  const completed = await service.get(resumed.details.jobId);
  const stdout = JSON.parse(await readFile(resolve(stateDir, completed.output.stdoutRef), "utf8"));
  const fullPath = stdout.artifacts[0];
  assert.ok(isAbsolute(fullPath), `Expected an absolute artifact reference, got ${JSON.stringify(fullPath)}`);
  assert.match(stdout.resultReference, /full result saved to:/);
  assert.ok(completed.output.preview.startsWith(stdout.resultReference));
  assert.ok(wakes.find((wake) => wake.projection.jobId === resumed.details.jobId).prompt.includes(fullPath));
  const fullText = await readFile(fullPath, "utf8");
  assert.ok(fullText.includes(finalAnswer));
  assert.match(fullText, /<subagent:/);
  assert.equal((await stat(fullPath)).mode & 0o777, 0o600);
  assert.ok(stdout.answer.includes("digest verification; token thresholds"));
  assert.deepEqual(sessions, [first.sessionId, first.sessionId]);
  assert.match(JSON.stringify(resumedContext.messages), /remember smoke original context/);
  assert.match(JSON.stringify(resumedContext.messages), /smoke retained tool evidence/);
  assert.equal(resumedContext.messages.filter((message) => message.role === "toolResult" && message.toolCallId === "smoke-read").length, 1);
  await send.execute("close", { id: "helper", close: true });
  assert.equal((await instances.get("helper")).status, "closed");
  console.log(JSON.stringify({ scenario: "built-native-stop-resume-close", stopped: stopped.details.stop,
    sessionId: first.sessionId, instanceIncarnation: first.incarnation, resumedJobId: resumed.details.jobId,
    fullAnswerArtifactVerified: true, wakeResultPathVerified: true, privateArtifactMode: "0600",
    priorContextVisible: true, toolResultPaired: true, releaseReceiptAcknowledged: true, finalStatus: "closed" }));

  // Exhausted provider failure: certify, inspect/ack, then continue the SAME child.
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("Read", { file_path: "evidence.txt" }, { id: "failure-read" })]),
    fauxAssistantMessage([fauxText("uncommitted failed draft"), fauxToolCall("Read", { file_path: "unused.txt" }, { id: "failed-dangling" })],
      { stopReason: "error", errorMessage: "Fictional connection error" }),
  ]);
  const failed = await agent.execute("provider-failure", { id: "recoverable", persist: true, background: true, prompt: "remember failed child original context" });
  await until(async () => (await service.get(failed.details.jobId))?.wake.state === "delivered");
  const failedRecord = await instances.get("recoverable");
  assert.deepEqual({ reason: failedRecord.recovery.reason, continuity: failedRecord.recovery.continuity }, { reason: "failed", continuity: "retained" });
  assert.equal((await store.get(failed.details.jobId)).subagentOwnership.disposition.status, "failed");
  assert.equal((await store.get(failed.details.jobId)).subagentOwnership.publication.receiptPending, false);
  await assert.rejects(() => send.execute("without-ack", { id: "recoverable", background: true, message: "must not run" }));
  const inspection = (await send.execute("inspect-failure", { id: "recoverable", inspect: true })).details.recovery;
  assert.equal(inspection.status, "ready"); assert.equal(typeof inspection.ack, "string"); assert.equal(inspection.resumable, undefined);
  let recoveredContext;
  faux.setResponses([(context) => { recoveredContext = context; return fauxAssistantMessage([fauxText("recovered")]); }]);
  const continued = await send.execute("ack-continue", { id: "recoverable", ack: inspection.ack, message: "re-check partial work", background: true });
  await until(async () => (await service.get(continued.details.jobId))?.wake.state === "delivered");
  assert.equal((await service.get(continued.details.jobId)).state, "succeeded");
  const recoveredRecord = await instances.get("recoverable");
  assert.equal(recoveredRecord.incarnation, failedRecord.incarnation); assert.equal(recoveredRecord.sessionId, failedRecord.sessionId);
  assert.deepEqual(sessions.slice(-2), [failedRecord.sessionId, failedRecord.sessionId]);
  const recoveredMessages = JSON.stringify(recoveredContext.messages);
  assert.match(recoveredMessages, /remember failed child original context/); assert.match(recoveredMessages, /smoke retained tool evidence/);
  assert.match(recoveredMessages, /previous turn failed \(reason: failed\)/);
  assert.doesNotMatch(recoveredMessages, /failed-dangling|uncommitted failed draft/);
  assert.equal(recoveredContext.messages.filter((message) => message.role === "toolResult" && message.toolCallId === "failure-read").length, 1);
  await send.execute("close-recovered", { id: "recoverable", close: true });
  console.log(JSON.stringify({ scenario: "built-native-provider-failure-ack-continue", failedJobId: failed.details.jobId,
    continuedJobId: continued.details.jobId, continuity: "retained", sameInstance: true, priorContextVisible: true,
    failedDraftExcluded: true, toolResultPaired: true, ackRequired: true, finalStatus: "closed" }));

  const late = deferred(); releaseLate = late.resolve; let lateRequest;
  const held = { ...subagents, run: async (request) => { lateRequest = request; return late.promise; } };
  const heldAgent = createAgentTool(held, context); const heldSend = createAgentManageTool(held, context);
  const uncooperative = await heldAgent.execute("hold", { id: "held", persist: true, background: true, prompt: "hold" });
  await until(() => lateRequest !== undefined);
  const began = Date.now(); const busy = await heldSend.execute("stop", { id: "held", stop: true }); const elapsedMs = Date.now() - began;
  assert.equal(busy.details.stop.status, "stop_requested"); assert.equal(busy.details.stop.childStillBusy, true); assert.equal(busy.details.stop.resumable, false);
  assert.ok(elapsedMs <= 6_000); assert.equal((await instances.get("held")).status, "running");
  await assert.rejects(() => heldAgent.execute("capacity", { id: "blocked", persist: true, background: true, prompt: "no slot" }));
  late.resolve({ text: "settled", subagentContinuity: { turnToken: lateRequest.turnToken, state: "retained" } });
  await until(async () => { const record = await instances.get("held"); return record.status === "idle" && !record.recoveryBlocked; });
  await heldSend.execute("close", { id: "held", close: true });
  console.log(JSON.stringify({ scenario: "bounded-uncooperative-stop", receipt: busy.details.stop, elapsedMs, capacityRetained: true,
    jobId: uncooperative.details.jobId, lateSettlementReleased: true }));
} finally {
  releaseLate?.({ text: "cleanup" });
  await service?.stop();
  await owner.disposeAllSessions?.();
  await rm(root, { recursive: true, force: true });
}
