// Automated built-seam proof. Transport alone is fake; no interactive/live consumer.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { loadMonoAgentConfig } from "@mono-agent/config";
import { createMonoRuntime } from "@mono-agent/runtime-adapter";
import { acquireAgentRootOwnership } from "../../../dist/agent-root-coordinator.js";
import { registerProcessJobsRoot } from "../../../dist/process-jobs-root-registry.js";
import { openProcessJobsService } from "../../../dist/process-jobs-service.js";
import { PROCESS_JOBS_DEFAULTS } from "../../../dist/process-jobs-config.js";
import { createSubagentInstanceRegistry } from "../../../dist/subagent-instances.js";
import { buildSubagentsOptions } from "../../../dist/configured-agent.js";
import { openProcessJobStore } from "../../../dist/process-jobs-store.js";
import { createAgentTool } from "../../../../agent-runtime/src/agent/tools/agent-tool.js";
import { generatePiNativeResponse } from "../../../../agent-runtime/src/ai/providers/pi-native.js";
import { createToolContext, updateToolContext } from "../../../../agent-runtime/src/agent/tools/shared/tool-context.js";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "../../../../agent-runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { keepVerificationScratch, pruneVerificationScratch, removeVerificationScratch } from "./verification-scratch.mjs";

const durationMs = Number(process.argv[2] ?? 250);
assert(Number.isSafeInteger(durationMs) && durationMs >= 1 && durationMs <= 180_000);
const keepScratch = keepVerificationScratch();
const verification = resolve(process.cwd(), ".mono-agent/verification");
await mkdir(verification, { recursive: true });
await pruneVerificationScratch(verification, "managed-built-", "managed-built", { keep: keepScratch });
const root = await mkdtemp(resolve(verification, "managed-built-"));
let ownership;
try {
  ownership = await acquireAgentRootOwnership(root);
} catch (error) {
  await removeVerificationScratch(root, { keep: keepScratch, label: "managed-built" });
  throw error;
}
let service;
let runtime;
try {
  const stateDir = resolve(root, "jobs");
  const registration = await registerProcessJobsRoot({ agentRoot: root, workspace: root, stateDir, coordinator: ownership.coordinator });
  const origin = { conversationId: "web:proof", baseConversationId: "web:proof", bucket: null,
    replyToConversationId: "web:proof", normalizedReplyTarget: "web:proof", runId: "proof", historyBoundary: "proof", channel: "web" };
  let wakes = 0;
  service = await openProcessJobsService({ cwd: root, workspace: root, registration,
    settings: { ...PROCESS_JOBS_DEFAULTS, configured: true, enabled: true, stateDir, maxConcurrent: 1, maxQueued: 0, maxRuntimeMs: 300_000 },
    wake: async () => { wakes++; return { delivered: true }; },
  });
  const registryRoot = resolve(root, "children");
  const registry = createSubagentInstanceRegistry({ root: registryRoot, retireSession: async (id, sessionsRoot) => runtime?.retireDurableSession?.(id, sessionsRoot),
    ownerForReservation: (jobId) => ({ jobId, storeRoot: stateDir }), resolveOwner: (identity) => service.resolveSubagentOwner(identity),
  });
  service.bindManagedSubagents({ root: registryRoot,
    verify: async (identity) => (await registry.open(identity.conversationId, { existingOnly: true })).verifyOwner(identity),
    publish: async (phase, publication) => (await registry.open(publication.identity.conversationId, { existingOnly: true })).publishOwned(phase, publication),
  });
  await service.activateWakes();
  const instances = await registry.open(origin.conversationId);
  const config = loadMonoAgentConfig({ cwd: root, env: {
    MONO_AGENT_IDENTITY_PATH: resolve(root, "IDENTITY.md"), MONO_AGENT_MODEL: "openai-codex:gpt-5.5",
    MONO_AGENT_ALLOWED_TOOLS: "Agent,AgentSend,Exec", MONO_AGENT_SANDBOX_MODE: "off",
    MONO_AGENT_SUBAGENTS_JSON: JSON.stringify({ enabled: true, timeoutMs: 300_000, commandTimeoutMs: 300_000, instances: { root: registryRoot }, definitions: [{ name: "verifier", description: "Bounded verification", prompt: "Run the supplied verification once.", allowedTools: ["Exec"] }] }),
  } });
  const faux = fauxProvider({ provider: config.runtime.model.provider, models: [{ id: config.runtime.model.model }], tokensPerSecond: undefined });
  const models = createModels(); models.setProvider(faux.provider);
  // The driver owns one explicit tool context for this fixture run: the retired
  // process-global configuration seam is gone, so tools read the workspace from it.
  const toolContext = createToolContext({ workspace: root });
  const driver = { configureTools: (next) => updateToolContext(toolContext, { ...next, workspace: root }),
    run: (prompt, options) => generatePiNativeResponse(prompt, { ...options, toolContext, piResolvedModel: faux.getModel(), piResolvedModels: models, resolvePiApiKey: async () => "faux-key" }),
  };
  runtime = createMonoRuntime({ fallbackChain: [{ model: config.runtime.model }], resolveAttempt: () => ({ runtime: driver }) });
  const subagents = buildSubagentsOptions(config, { runtime, baseModel: config.runtime.model },
    { conversationId: origin.conversationId, runId: "proof", instances }).subagents;
  subagents.backgroundSubagentController = service.internalController(origin, 0);
  const script = `setTimeout(() => process.stdout.write('owned-proof-completed'), ${durationMs})`;
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("Exec", { executable: process.execPath, args: ["-e", script], workdir: root, timeout_ms: durationMs + 10_000 })]),
    fauxAssistantMessage([fauxText("Verification tool completed.")]),
  ]);
  const startedAt = Date.now();
  const receipt = await createAgentTool(subagents, { model: config.runtime.model, cwd: root }).execute("proof", { name: "verifier", persist: true, background: true, id: "proof", prompt: "Execute the supplied verification once." });
  const deadline = startedAt + durationMs + 30_000;
  let job;
  while (Date.now() < deadline) {
    job = await service.get(receipt.details.jobId);
    if (job?.wake.state === "delivered") break;
    await new Promise((done) => setTimeout(done, 25));
  }
  assert.equal(job?.state, "succeeded"); assert.equal(job?.wake.state, "delivered"); assert.equal(wakes, 1);
  const record = await (await openProcessJobStore(root, stateDir)).get(receipt.details.jobId);
  assert.equal(record.subagentOwnership.owner.settlement, "settled");
  assert.equal(record.subagentOwnership.command.state, "released");
  assert.equal(record.subagentOwnership.publication.state, "confirmed");
  assert.equal(record.subagentOwnership.seenCalls.length, 1);
  const instance = await instances.get("proof");
  assert.equal(instance.turns, 1); assert.equal(instance.recovery, undefined);
  const jsonl = (await readdir(instance.sessionsRoot, { recursive: true })).filter((path) => path.endsWith(".jsonl"));
  assert.equal(jsonl.length, 1);
  const transcript = (await readFile(resolve(instance.sessionsRoot, jsonl[0]), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const execution = transcript.flat().map((entry) => entry.message).find((message) => message?.role === "toolResult" && message.toolName === "Exec");
  assert(execution && execution.isError !== true);
  assert(JSON.stringify(execution.content).includes("owned-proof-completed"));
  const elapsedMs = Date.now() - startedAt;
  assert(elapsedMs >= durationMs);
  console.log(JSON.stringify({ kind: "managed-built-proof", root, jobId: receipt.details.jobId, durationMs, elapsedMs, wakes, result: "passed" }));
} finally {
  await runtime?.disposeAllSessions?.();
  await service?.stop();
  ownership.release();
  // Only this fixture creates the root, so only it removes it — after the
  // service stopped and ownership released. Cleanup failures are reported,
  // never thrown, so they cannot mask the proof verdict.
  await removeVerificationScratch(root, { keep: keepScratch, label: "managed-built" });
}
