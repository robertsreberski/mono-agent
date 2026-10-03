// Controlled transport, real built app/registry/job store, real Pi live-input path.
// Run after: pnpm --filter @mono-agent/agent-app... run build
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadMonoAgentConfig } from "@mono-agent/config";
import { createMonoRuntime, monoRuntimeSupportsLiveInput } from "@mono-agent/runtime-adapter";
import { buildSubagentsOptions } from "../dist/configured-agent.js";
import { createSubagentInstanceRegistry } from "../dist/subagent-instances.js";
import { openProcessJobsService } from "../dist/process-jobs-service.js";
import { openProcessJobStore } from "../dist/process-jobs-store.js";
import { PROCESS_JOBS_DEFAULTS } from "../dist/process-jobs-config.js";
import { createAgentTool } from "../../agent-runtime/src/agent/tools/agent-tool.js";
import { createAgentManageTool } from "../../agent-runtime/src/agent/tools/agent-manage-tool.js";
import { generatePiNativeResponse } from "../../agent-runtime/src/ai/providers/pi-native.js";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "../../agent-runtime/node_modules/@earendil-works/pi-ai/dist/index.js";

const STEER_TEXT = "steered mid-turn: prefer the smaller diff";
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, label = "bounded local proof deadline") {
  const deadline = Date.now() + 20_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, label);
    await sleep(20);
  }
}
const root = await mkdtemp(resolve(process.cwd(), "node_modules/.subagent-steer-smoke-"));
const owner = createMonoRuntime();
const origin = { conversationId: "web:steer-smoke", baseConversationId: "web:steer-smoke", bucket: null, replyToConversationId: "web:steer-smoke", normalizedReplyTarget: "web:steer-smoke", runId: "parent", historyBoundary: "parent", channel: "web" };
let service;
let releaseStep;
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
    retireSession: (id, sessionRoot) => owner.retireDurableSession(id, sessionRoot),
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
  let childLiveInput = "absent";
  const runtime = { recoverSession: owner.recoverSession.bind(owner), run: async (prompt, options) => {
    childLiveInput = options.liveInput === undefined ? "absent" : "supplied";
    return generatePiNativeResponse(prompt, { ...options, piResolvedModel: faux.getModel(), piResolvedModels: models, resolvePiApiKey: async () => "controlled-faux-key" });
  } };
  const subagents = buildSubagentsOptions(config, { runtime, baseModel: config.runtime.model }, { conversationId: origin.conversationId, runId: "parent", instances }).subagents;
  subagents.backgroundSubagentController = service.internalController(origin, 0);
  const context = { cwd: root, model: config.runtime.model };
  const agent = createAgentTool(subagents, context); const send = createAgentManageTool(subagents, context);

  const midTurn = deferred(); const offerIssued = deferred(); releaseStep = offerIssued.resolve;
  let finalContext;
  faux.setResponses([
    async () => {
      midTurn.resolve();
      // Hold the first provider step until the parent's offer is in flight, then
      // let the loop reach its next step, where live input is injected.
      await offerIssued.promise;
      await sleep(500);
      return fauxAssistantMessage([fauxToolCall("Read", { file_path: "evidence.txt" }, { id: "smoke-read" })]);
    },
    (stepContext) => { finalContext = stepContext; return fauxAssistantMessage([fauxText(`acted on: ${STEER_TEXT}`)]); },
  ]);

  const started = await agent.execute("start", { id: "helper", persist: true, background: true, prompt: "work on the original brief" });
  await midTurn.promise;
  const steering = send.execute("steer", { id: "helper", steer: STEER_TEXT });
  offerIssued.resolve();
  const steered = await steering;
  assert.equal(steered.isError, undefined, "a real steer must not be an error receipt");
  assert.ok(["applied", "pending"].includes(steered.details.steer.status), `unexpected steer status ${steered.details.steer.status}`);
  assert.equal(steered.details.steer.jobId, started.details.jobId);
  assert.equal(steered.details.steer.applied, steered.details.steer.status === "applied");

  const rejected = await send.execute("multi", { id: "helper", steer: "x", description: "label" });
  assert.equal(rejected.details.steer.code, "subagent_steer_unexpected_parameters");
  await assert.rejects(() => send.execute("busy", { id: "helper", message: "next" }), /busy/);

  await until(async () => (await service.get(started.details.jobId))?.wake.state === "delivered", "detached turn settlement");
  const transcript = JSON.stringify(finalContext?.messages ?? []);
  const steeredInTranscript = transcript.includes(STEER_TEXT);
  assert.equal(childLiveInput, "supplied", "the child run must receive the steering mailbox");
  assert.equal(steeredInTranscript, true, "the steered text must appear in the child's own turn");
  assert.equal(monoRuntimeSupportsLiveInput(), true);
  const settled = await service.get(started.details.jobId);
  assert.match(settled.output.preview, /acted on: steered mid-turn/);

  // The mailbox is removed at settlement: a later steer is refused, never queued.
  const late = await send.execute("late", { id: "helper", steer: "too late" });
  assert.equal(late.details.steer.code, "subagent_steer_not_running");
  assert.equal(late.details.steer.applied, false);
  await send.execute("close", { id: "helper", close: true });
  assert.equal((await instances.get("helper")).status, "closed");

  console.log(JSON.stringify({ scenario: "built-native-steer-running-detached-child", receipt: steered.details.steer,
    jobId: started.details.jobId, childReceivedMailbox: childLiveInput, steeredTextInChildTranscript: steeredInTranscript,
    childAnswerPreview: settled.output.preview.slice(0, 120), multiModeRejected: rejected.details.steer.code,
    afterSettlement: late.details.steer.code, finalStatus: "closed" }, null, 2));
} finally {
  releaseStep?.();
  await service?.stop();
  await owner.disposeAllSessions?.();
  await rm(root, { recursive: true, force: true });
}
