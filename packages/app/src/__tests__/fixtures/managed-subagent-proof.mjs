// Automated built-seam proof. Transport alone is fake; no interactive/live consumer.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { registerHooks } from "node:module";

const turnSourceRoot = new URL("../../../../turn/src/", import.meta.url).href;
const turnDistRoot = new URL("../../../../turn/dist/", import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  return resolved.url.startsWith(turnSourceRoot)
    ? { ...resolved, url: turnDistRoot + resolved.url.slice(turnSourceRoot.length) } : resolved;
} });
const { resolveJsonMonoAgentConfig } = await import("@mono-agent/config");
const { createMonoRuntime } = await import("@mono-agent/turn/host");
const { JsonlSessionRepo, projectContext } = await import("@mono-agent/turn/engine");
const { acquireAgentRootOwnership, releaseAgentRootOwnershipWhenIdle } = await import("../../../dist/durable-state/agent-root-coordinator.js");
const { registerProcessJobsRoot } = await import("../../../dist/process-jobs/process-jobs-root-registry.js");
const { openProcessJobsService } = await import("../../../dist/process-jobs/process-jobs-service.js");
const { PROCESS_JOBS_DEFAULTS } = await import("../../../dist/process-jobs/process-jobs-config.js");
const { createSubagentInstanceRegistry } = await import("../../../dist/subagents/subagent-instances.js");
const { buildSubagentsOptions } = await import("../../../dist/composition/configured-subagents.js");
const { openProcessJobStore } = await import("../../../dist/process-jobs/process-jobs-store.js");
const { createAgentTool } = await import("../../../../turn/dist/tools/delegation/agent-tool.js");
const { generateEngineTurnResponse } = await import("../../../../turn/dist/execution/pi/run.js");
const { createToolContext, updateToolContext } = await import("@mono-agent/turn/tools");
const { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } = await import("../../../../turn/node_modules/@earendil-works/pi-ai/dist/index.js");
const { keepVerificationScratch, pruneVerificationScratch, removeVerificationScratch } = await import("./verification-scratch.mjs");

const durationMs = Number(process.argv[2] ?? 250);
assert(Number.isSafeInteger(durationMs) && durationMs >= 1 && durationMs <= 180_000);
const keepScratch = keepVerificationScratch();
const verification = resolve(process.cwd(), ".mono-agent/verification");
await mkdir(verification, { recursive: true });
await pruneVerificationScratch(verification, "managed-built-", "managed-built", { keep: keepScratch });
const root = await mkdtemp(resolve(verification, "managed-built-"));
let ownership;
try {
  await mkdir(resolve(root, "lease-home"), { recursive: true, mode: 0o700 });
  ownership = await acquireAgentRootOwnership(root, { homeDir: resolve(root, "lease-home") });
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
  const config = resolveJsonMonoAgentConfig({ cwd: root, json: {
    runtime: { model: "openai-codex:gpt-5.5" },
    context: { identityPath: resolve(root, "IDENTITY.md") },
    tools: { allowedTools: ["Agent", "AgentManage", "Exec"] },
    sandbox: { mode: "off" },
    subagents: { enabled: true, timeoutMs: 300_000, commandTimeoutMs: 300_000, instances: { root: registryRoot },
      definitions: [{ name: "verifier", description: "Bounded verification", prompt: "Run the supplied verification once.", allowedTools: ["Exec"] }] },
  } });
  const faux = fauxProvider({ provider: config.runtime.model.provider, models: [{ id: config.runtime.model.model }], tokensPerSecond: undefined });
  const models = createModels(); models.setProvider(faux.provider);
  // The driver owns one explicit tool context for this fixture run: the retired
  // process-global configuration seam is gone, so tools read the workspace from it.
  const toolContext = createToolContext({ workspace: root });
  const driver = { configureTools: (next) => updateToolContext(toolContext, { ...next, workspace: root }),
    run: (prompt, options) => generateEngineTurnResponse(prompt, { ...options, toolContext, piResolvedModel: faux.getModel(), piResolvedModels: models, resolvePiApiKey: async () => "faux-key" }),
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
  const repo = new JsonlSessionRepo({ sessionsRoot: instance.sessionsRoot });
  const metadata = (await repo.list()).find((entry) => entry.path === resolve(instance.sessionsRoot, jsonl[0]));
  const journal = await repo.open(metadata, { repair: false });
  let transcript;
  try {
    transcript = projectContext(await journal.getEntries()).messages;
  } finally {
    await journal.close();
  }
  const execution = transcript.find((message) => message?.role === "toolResult" && message.toolName === "Exec");
  assert(execution && execution.isError !== true);
  assert(JSON.stringify(execution.content).includes("owned-proof-completed"));
  const elapsedMs = Date.now() - startedAt;
  assert(elapsedMs >= durationMs);
  console.log(JSON.stringify({ kind: "managed-built-proof", root, jobId: receipt.details.jobId, durationMs, elapsedMs, wakes, result: "passed" }));
} finally {
  await runtime?.disposeAllSessions?.();
  await service?.stop();
  await releaseAgentRootOwnershipWhenIdle(ownership);
  // Only this fixture creates the root, so only it removes it — after the
  // service stopped and ownership released. Cleanup failures are reported,
  // never thrown, so they cannot mask the proof verdict.
  await removeVerificationScratch(root, { keep: keepScratch, label: "managed-built" });
}
