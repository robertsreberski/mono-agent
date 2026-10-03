// Controlled transport, real built app/registry/job store and durable Pi sessions.
// Run after: pnpm --filter @mono-agent/agent-app... run build
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadMonoAgentConfig } from "@mono-agent/config";
import { createMonoRuntime } from "@mono-agent/runtime-adapter";
import { buildSubagentsOptions } from "../dist/configured-agent.js";
import { createSubagentInstanceRegistry } from "../dist/subagent-instances.js";
import { openProcessJobsService } from "../dist/process-jobs-service.js";
import { openProcessJobStore } from "../dist/process-jobs-store.js";
import { PROCESS_JOBS_DEFAULTS } from "../dist/process-jobs-config.js";
import { createAgentTool } from "../../agent-runtime/src/agent/tools/agent-tool.js";
import { createAgentManageTool } from "../../agent-runtime/src/agent/tools/agent-manage-tool.js";
import { generatePiNativeResponse } from "../../agent-runtime/src/ai/providers/pi-native.js";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "../../agent-runtime/node_modules/@earendil-works/pi-ai/dist/index.js";

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
  service = await openProcessJobsService({ cwd: root, workspace: root, store,
    settings: { ...PROCESS_JOBS_DEFAULTS, configured: true, enabled: true, stateDir, maxConcurrent: 1, maxQueued: 0 },
    registration: {}, attestRegistration: async () => ({}), wake: async () => ({ delivered: true }),
  });
  await service.activateWakes();
  const registryRoot = resolve(root, "children");
  const registry = createSubagentInstanceRegistry({ root: registryRoot,
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
  const config = loadMonoAgentConfig({ cwd: root, env: {
    MONO_AGENT_IDENTITY_PATH: resolve(root, "IDENTITY.md"), MONO_AGENT_MODEL: "openai-codex:gpt-5.5", MONO_AGENT_ALLOWED_TOOLS: "Agent,AgentManage",
    MONO_AGENT_SUBAGENTS_JSON: JSON.stringify({ enabled: true, instances: { root: registryRoot } }),
  } });
  const faux = fauxProvider({ provider: config.runtime.model.provider, models: [{ id: config.runtime.model.model }], tokensPerSecond: undefined });
  const models = createModels(); models.setProvider(faux.provider);
  const sessions = [];
  const runtime = { recoverSession: owner.recoverSession.bind(owner), run: async (prompt, options) => {
    sessions.push(options.sessionId);
    return generatePiNativeResponse(prompt, { ...options, piResolvedModel: faux.getModel(), piResolvedModels: models, resolvePiApiKey: async () => "controlled-faux-key" });
  } };
  const subagents = buildSubagentsOptions(config, { runtime, baseModel: config.runtime.model }, { conversationId: origin.conversationId, runId: "parent", instances }).subagents;
  subagents.backgroundSubagentController = service.internalController(origin, 0);
  const context = { cwd: root, model: config.runtime.model };
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
  faux.setResponses([(context) => { resumedContext = context; return fauxAssistantMessage([fauxText("resumed")]); }]);
  const resumed = await send.execute("resume", { id: "helper", message: "continue same instance", background: true });
  await until(async () => (await service.get(resumed.details.jobId))?.wake.state === "delivered");
  assert.deepEqual(sessions, [first.sessionId, first.sessionId]);
  assert.match(JSON.stringify(resumedContext.messages), /remember smoke original context/);
  assert.match(JSON.stringify(resumedContext.messages), /smoke retained tool evidence/);
  assert.equal(resumedContext.messages.filter((message) => message.role === "toolResult" && message.toolCallId === "smoke-read").length, 1);
  await send.execute("close", { id: "helper", close: true });
  assert.equal((await instances.get("helper")).status, "closed");
  console.log(JSON.stringify({ scenario: "built-native-stop-resume-close", stopped: stopped.details.stop,
    sessionId: first.sessionId, instanceIncarnation: first.incarnation, resumedJobId: resumed.details.jobId,
    priorContextVisible: true, toolResultPaired: true, releaseReceiptAcknowledged: true, finalStatus: "closed" }));

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
