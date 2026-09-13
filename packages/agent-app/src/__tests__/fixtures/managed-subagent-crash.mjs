// Physical owner crash/reopen proof: compiled app/adapter, shipped runtime JS,
// fake transport, real registry locks, gated process group and OS incarnation.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMonoAgentConfig } from "@mono-agent/config";
import { createMonoRuntime } from "@mono-agent/runtime-adapter";
import { acquireAgentRootOwnership } from "../../../dist/agent-root-coordinator.js";
import { registerProcessJobsRoot } from "../../../dist/process-jobs-root-registry.js";
import { openProcessJobsService } from "../../../dist/process-jobs-service.js";
import { PROCESS_JOBS_DEFAULTS } from "../../../dist/process-jobs-config.js";
import { createSubagentInstanceRegistry, subagentConversationRoot } from "../../../dist/subagent-instances.js";
import { buildSubagentsOptions } from "../../../dist/configured-agent.js";
import { openProcessJobStore } from "../../../dist/process-jobs-store.js";
import { readProcessIncarnation, processIncarnationsEqual } from "../../../dist/process-incarnation.js";
import { createAgentTool } from "../../../../agent-runtime/src/agent/tools/agent-tool.js";
import { generatePiNativeResponse } from "../../../../agent-runtime/src/ai/providers/pi-native.js";
import { configureToolRuntime } from "../../../../agent-runtime/src/agent/tools/shared/runtime-context.js";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "../../../../agent-runtime/node_modules/@earendil-works/pi-ai/dist/index.js";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url)).replace(/\/$/, "");
assert.equal(process.cwd(), ROOT);
const verification = resolve(ROOT, ".mono-agent/verification");
const mode = process.argv[2] ?? "running";
const origin = { conversationId: "web:crash", baseConversationId: "web:crash", bucket: null,
  replyToConversationId: "web:crash", normalizedReplyTarget: "web:crash", runId: "crash", historyBoundary: "crash", channel: "web" };
const spec = { id: "proof", name: "verifier", systemPrompt: "Verification", definition: { name: "verifier", description: "Verification", systemPrompt: "Verification" } };
async function until(operation, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await operation(); if (value) return value; await new Promise((done) => setTimeout(done, 25)); }
  throw new Error("Bounded physical proof condition timed out.");
}
async function open(root, options = {}) {
  assert(root.startsWith(verification + sep));
  const ownership = await acquireAgentRootOwnership(root);
  const stateDir = resolve(root, "jobs");
  const registration = await registerProcessJobsRoot({ agentRoot: root, workspace: root, stateDir, coordinator: ownership.coordinator });
  let wakes = 0;
  const store = await openProcessJobStore(root, stateDir);
  const service = await openProcessJobsService({ cwd: root, workspace: root, registration, store,
    settings: { ...PROCESS_JOBS_DEFAULTS, configured: true, enabled: true, stateDir, maxConcurrent: 1, maxQueued: 0, maxRuntimeMs: 300_000,
      ...(options.expiredRetention ? { retention: { ...PROCESS_JOBS_DEFAULTS.retention, maxAgeMs: 1 } } : {}) },
    ...(options.expiredRetention ? { now: () => new Date(Date.now() + 60_000) } : {}),
    wake: async () => { wakes++; return { delivered: true }; },
  });
  await options.beforeBind?.(store);
  let certificate;
  const registryRoot = resolve(root, "children");
  const registry = createSubagentInstanceRegistry({ root: registryRoot, retireSession: async () => {},
    ownerForReservation: (jobId) => ({ jobId, storeRoot: stateDir }), resolveOwner: (identity) => service.resolveSubagentOwner(identity),
    checkOwnerIndex: (conversationId, known) => service.checkSubagentOwnerIndex(conversationId, known),
  });
  service.bindManagedSubagents({ root: registryRoot,
    verify: async (identity) => (await registry.open(identity.conversationId, { existingOnly: true })).verifyOwner(identity),
    publish: async (phase, publication) => {
      const instances = await registry.open(publication.identity.conversationId, { existingOnly: true });
      if (phase === "finalize" && options.certificateBoundary) {
        if (options.certificateBoundary === "certificate-lost-ack") await instances.publishOwned(phase, publication);
        certificate = publication;
        await new Promise(() => {}); // Only the proof parent may SIGKILL this owner.
      }
      await instances.publishOwned(phase, publication);
    },
  });
  await service.activateWakes();
  const instances = await registry.open(origin.conversationId, mode === "recover" ? { existingOnly: true } : {});
  return { service, instances, store, certificate: () => certificate, wakes: () => wakes, close: async () => { await service.stop(); ownership.release(); } };
}
async function owner(root, scenario) {
  setInterval(() => {}, 1000); // Scoped to this deliberately SIGKILLed fixture owner.
  const certificateScenario = scenario.startsWith("certificate-");
  const f = await open(root, certificateScenario ? { certificateBoundary: scenario } : {});
  let releaseProvider;
  const providerGate = new Promise((done) => { releaseProvider = done; });
  const phase = { preparing: "preparing", attested: "attested", "release-fence": "running" }[scenario];
  if (phase) {
    const mutate = f.store.mutate.bind(f.store);
    f.store.mutate = async (...args) => {
      const result = await mutate(...args);
      if ((await f.store.list()).some((record) => record.subagentOwnership?.command?.state === phase)) await new Promise(() => {});
      return result;
    };
  }
  const shortCommand = scenario === "terminal" || certificateScenario;
  const timeoutMs = shortCommand ? 6000 : 300_000;
  const config = loadMonoAgentConfig({ cwd: root, env: {
    MONO_AGENT_IDENTITY_PATH: resolve(root, "IDENTITY.md"), MONO_AGENT_MODEL: "openai-codex:gpt-5.5",
    MONO_AGENT_ALLOWED_TOOLS: "Agent,AgentSend,Exec", MONO_AGENT_SANDBOX_MODE: "off",
    MONO_AGENT_SUBAGENTS_JSON: JSON.stringify({ enabled: true, timeoutMs, commandTimeoutMs: 300_000, instances: { root: resolve(root, "children") },
      definitions: [{ name: "verifier", description: "Bounded verification", prompt: "Run the supplied verification once.", allowedTools: ["Exec"] }] }),
  } });
  const faux = fauxProvider({ provider: config.runtime.model.provider, models: [{ id: config.runtime.model.model }], tokensPerSecond: undefined });
  const models = createModels(); models.setProvider(faux.provider);
  const driver = { configureTools: (next) => configureToolRuntime({ ...next, workspace: root }),
    run: (prompt, options) => generatePiNativeResponse(prompt, { ...options, piResolvedModel: faux.getModel(), piResolvedModels: models, resolvePiApiKey: async () => "faux-key" }),
  };
  const runtime = createMonoRuntime({ fallbackChain: [{ model: config.runtime.model }], resolveAttempt: () => ({ runtime: driver }) });
  const subagents = buildSubagentsOptions(config, { runtime, baseModel: config.runtime.model }, { conversationId: origin.conversationId, runId: "crash", instances: f.instances }).subagents;
  subagents.backgroundSubagentController = f.service.internalController(origin, 0);
  if (shortCommand) {
    // Hold the actual provider settlement, never its already-settled reporting race.
    const run = subagents.run;
    subagents.run = async (request) => { const result = await run(request); await providerGate; return result; };
  }
  const marker = resolve(root, "executions.txt");
  const script = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'start\\n'); ${shortCommand ? "process.stdout.write('done')" : "setInterval(() => {}, 1000)"}`;
  faux.setResponses([fauxAssistantMessage([fauxToolCall("Exec", { executable: process.execPath, args: ["-e", script], workdir: root, timeout_ms: shortCommand ? 4000 : 290_000 })]), fauxAssistantMessage([fauxText("Verification returned.")])]);
  const receipt = await createAgentTool(subagents, { model: config.runtime.model, cwd: root }).execute("crash", { name: "verifier", persist: true, background: true, id: "proof", prompt: "Execute the supplied verification once." });
  const record = await until(async () => {
    const record = await f.store.get(receipt.details.jobId);
    const started = await readFile(marker, "utf8").catch(() => "");
    if (!record?.subagentOwnership?.command) return;
    if (phase) { if (record.subagentOwnership.command.state === phase) { assert.equal(started, ""); return record; } return; }
    if (!started) return;
    if (certificateScenario) {
      if (record.state === "timed_out" && record.wake.state === "delivered") releaseProvider();
      if (f.certificate() && record.subagentOwnership.publication.receiptPending === true) return record;
      return;
    }
    if (scenario === "terminal" ? record.state === "timed_out" && record.wake.state === "delivered" : record.subagentOwnership.command.state === "running") return record;
  });
  assert.equal(record.subagentOwnership.owner.settlement, certificateScenario ? "settled" : "running");
  if (shortCommand) assert.equal(record.subagentOwnership.command.state, "released");
  if (certificateScenario) {
    const records = JSON.parse(await readFile(resolve(subagentConversationRoot(resolve(root, "children"), origin.conversationId), "instances.json"), "utf8"));
    assert.equal(records[0].ownerReceipt.finalized, scenario === "certificate-lost-ack");
    assert.equal(record.wake.state, "delivered"); assert.equal(f.wakes(), 1);
  }
  const evidence = { jobId: record.jobId, command: record.subagentOwnership.command, targetStarted: !phase, wakes: f.wakes(), certificateScenario, scenario };
  await writeFile(resolve(root, "proof.json"), JSON.stringify(evidence));
  process.send({ ready: true });
  // Kept alive only until the foreground proof parent sends physical SIGKILL.
  await new Promise(() => {});
}
async function recover(root, expectedWakes, attempt) {
  const proof = JSON.parse(await readFile(resolve(root, "proof.json"), "utf8"));
  // The real host has channel servers; this headless fixture needs one scoped
  // event-loop reference while the service's unref'ed recovery grace elapses.
  const keepAlive = setInterval(() => {}, 1000);
  let f;
  try {
    f = await open(root, proof.certificateScenario ? { expiredRetention: true, beforeBind: async (store) => {
      const retained = await store.get(proof.jobId);
      if (attempt === 0) {
        assert.equal(retained.subagentOwnership.publication.receiptPending, true);
        assert.equal(retained.wake.state, "delivered");
      } else assert.equal(retained, undefined); // Prior durable certificate/ack permitted actual retention.
    } } : {});
    if (proof.certificateScenario) {
      if (attempt === 0) {
        const record = await until(async () => { const value = await f.store.get(proof.jobId); return value?.subagentOwnership.publication.receiptPending === false && value; });
        assert.equal(record.subagentOwnership.owner.settlement, "settled");
        assert.equal(record.state, "timed_out"); assert.equal(record.subagentOwnership.command.state, "released");
        assert.equal(record.subagentCommandReceipts.commands[0].completion, "observed");
        assert.equal(record.subagentCommandReceipts.commands[0].exitCode, 0);
        const registry = JSON.parse(await readFile(resolve(subagentConversationRoot(resolve(root, "children"), origin.conversationId), "instances.json"), "utf8"));
        assert.equal(registry[0].ownerReceipt.finalized, true);
        await f.store.applyRetention(f.service.settings, new Date(Date.now() + 60_000));
        assert.equal(await f.store.get(proof.jobId), undefined);
      }
      assert.equal((await f.instances.get("proof")).activeTurn, undefined);
      await assert.rejects(f.instances.begin("proof"), { code: "subagent_recovery_required" });
      assert.equal((await readFile(resolve(root, "executions.txt"), "utf8")).trim(), "start");
      assert.equal(f.wakes(), 0);
      console.log(JSON.stringify({ kind: "managed-certificate-reopen", attempt, retainedBeforeBind: attempt === 0, wakes: 0, result: "passed" }));
      return;
    }
    const record = await until(async () => { const record = await f.store.get(proof.jobId); return record?.subagentOwnership?.publication.state === "confirmed" && record.subagentOwnership.publication.receiptPending === false && record.wake.state === "delivered" && record; });
    assert.equal(record.subagentOwnership.owner.settlement, "dead");
    assert.equal(record.subagentOwnership.command.state, "released");
    assert.equal(record.subagentCommandReceipts.commands.length, 1);
    assert.equal(record.subagentCommandReceipts.commands[0].cleanup, "confirmed");
    assert.equal(record.subagentCommandReceipts.commands[0].completion, proof.wakes ? "observed" : "unobserved");
    assert.equal(record.subagentCommandReceipts.commands[0].exitCode, proof.wakes ? 0 : null);
    assert.equal((await f.service.get(proof.jobId)).subagentCommandReceipts, undefined);
    assert.equal(record.state, proof.wakes ? "timed_out" : "interrupted");
    assert.equal(f.wakes(), expectedWakes);
    if (proof.command.pgid !== null) assert.throws(() => process.kill(-proof.command.pgid, 0), { code: "ESRCH" });
    const instance = await f.instances.get("proof");
    assert.equal(instance.activeTurn, undefined); assert.equal(instance.recovery.continuity, "unknown");
    await assert.rejects(f.instances.begin("proof"), { code: "subagent_recovery_required" });
    const executions = await readFile(resolve(root, "executions.txt"), "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
    assert.equal(executions.trim(), proof.targetStarted ? "start" : "");
    console.log(JSON.stringify({ kind: "managed-crash-reopen", state: record.state, wakes: f.wakes(), result: "passed" }));
  } finally { try { await f?.close(); } finally { clearInterval(keepAlive); } }
}
function child(args) {
  const process = fork(fileURLToPath(import.meta.url), args, { cwd: ROOT, silent: true });
  let output = "";
  for (const stream of [process.stdout, process.stderr]) stream.on("data", (chunk) => { output = (output + chunk.toString()).slice(-16_384); });
  const deadline = setTimeout(() => process.kill("SIGKILL"), 30_000);
  const exited = once(process, "exit").then(([code, signal]) => ({ code, signal, output })).finally(() => clearTimeout(deadline));
  return { process, exited, output: () => output };
}
if (mode === "owner") await owner(resolve(process.argv[3]), process.argv[4]);
else if (mode === "recover") await recover(resolve(process.argv[3]), Number(process.argv[4]), Number(process.argv[5]));
else {
  assert(["running", "terminal", "preparing", "attested", "release-fence", "certificate-before-write", "certificate-lost-ack"].includes(mode));
  await mkdir(verification, { recursive: true });
  const root = await mkdtemp(resolve(verification, "managed-crash-"));
  const host = child(["owner", root, mode]);
  let helper;
  let proof;
  try {
    let ready = false; host.process.on("message", (message) => { ready ||= message?.ready === true; });
    await until(() => { assert.equal(host.process.exitCode, null, host.output()); return ready; }, 25_000);
    proof = JSON.parse(await readFile(resolve(root, "proof.json"), "utf8"));
    host.process.kill("SIGKILL");
    assert.equal((await host.exited).signal, "SIGKILL");
    if (mode === "running") process.kill(-proof.command.pgid, 0); // Survives the owner, really needs recovery.
    if (mode !== "certificate-lost-ack") {
      const unavailable = await createSubagentInstanceRegistry({ root: resolve(root, "children"), retireSession: async () => {} }).open(origin.conversationId, { existingOnly: true });
      await assert.rejects(unavailable.begin("proof"), { code: "subagent_owner_unavailable" });
      await assert.rejects(unavailable.create({ ...spec, id: "bypass" }), { code: "subagent_owner_unavailable" });
    } // Lost-ack already has a positive certificate; do not mutate it via an unrelated host.
    for (const [attempt, expectedWakes] of [proof.wakes ? 0 : 1, 0].entries()) {
      helper = child(["recover", root, String(expectedWakes), String(attempt)]);
      const result = await helper.exited;
      assert.equal(result.code, 0, result.output);
    }
    console.log(JSON.stringify({ kind: "managed-physical-crash-proof", root, scenario: mode, initialWakes: proof.wakes, reopens: 2, result: "passed" }));
  } finally {
    for (const process of [host.process, helper?.process]) if (process && process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
    const actual = proof?.command.pid && await readProcessIncarnation(proof.command.pid);
    if (actual && processIncarnationsEqual(actual, proof.command.incarnation)) {
      try { process.kill(-proof.command.pgid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
}
