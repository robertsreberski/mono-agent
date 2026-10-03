// Foreground, provider-zero cross-process proof using only this checkout's dist.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openProcessJobsService } from "../packages/agent-app/dist/process-jobs-service.js";
import { PROCESS_JOBS_DEFAULTS } from "../packages/agent-app/dist/process-jobs-config.js";
import { acquireAgentRootOwnership } from "../packages/agent-app/dist/agent-root-coordinator.js";
import { loadProcessJobsRootRegistryProtection, registerProcessJobsRoot } from "../packages/agent-app/dist/process-jobs-root-registry.js";
import { startInteractionBridge } from "../packages/agent-app/dist/interaction-bridge.js";
import { openProcessJobStore } from "../packages/agent-app/dist/process-jobs-store.js";
import { runWithProcessJobWakeContext } from "../packages/agent-app/dist/process-jobs-context.js";
import { startTuiAdapter } from "../packages/operator-adapter/dist/index.js";
import { WebService } from "../packages/web/dist/service.js";
import { startWebNotificationIngress } from "../packages/web/dist/notification-ingress.js";
import { deliverWebNotification } from "../packages/web/dist/notification-client.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(probe, label) {
  const until = Date.now() + 15_000;
  do { const result = await probe(); if (result) return result; await delay(10); } while (Date.now() < until);
  throw new Error(`Smoke timed out: ${label}`);
}
const sourceId = "smoke-agent";
const key = "fictional-operator-key";

if (process.argv[2] === "--agent") {
  const [root, webState, mode, requestedPort] = process.argv.slice(3);
  const agentRoot = await realpath(join(root, "agent"));
  const workspace = await realpath(join(agentRoot, "workspace"));
  const stateDir = join(agentRoot, "jobs");
  const ownership = await acquireAgentRootOwnership(agentRoot, { homeDir: join(root, "home") });
  const snapshot = await loadProcessJobsRootRegistryProtection(agentRoot, workspace);
  ownership.coordinator.synchronizeGeneration(snapshot.generation);
  const registration = await registerProcessJobsRoot({ agentRoot, workspace, stateDir, coordinator: ownership.coordinator });
  const mutationGate = await ownership.coordinator.publishAndAcquireMutationGate(registration.snapshot.generation, registration.rootKey);
  const interaction = await startInteractionBridge({ port: 0, askTimeoutMs: null });
  interaction.registerSink("web", { presentAsk: async () => {}, updateAsk: async () => {}, postStatus: async () => {} });
  let lastWake;
  const store = await openProcessJobStore(agentRoot, stateDir);
  const service = await openProcessJobsService({ cwd: agentRoot, workspace, registration, store,
    settings: { ...PROCESS_JOBS_DEFAULTS, configured: true, enabled: true, stateDir },
    wake: async (input) => {
      lastWake = { sourceId, triggerKind: "job", deliveryKey: input.deliveryKey, threadId: input.conversationId.slice(4),
        processJob: input.projection, wakePrompt: input.prompt, wakeRecovery: input.wakeRecovery };
      process.send({ event: "wake", token: input.wakeRecovery.token, notCrossed: input.wakeRecovery.notCrossed });
      return await runWithProcessJobWakeContext({ jobId: input.projection.jobId, chainDepth: input.chainDepth }, async () => {
        try { return (await deliverWebNotification(lastWake, { stateDir: webState })).delivery; }
        catch { return { delivered: false, ambiguous: true, retryable: false, code: "process_job_wake_failed" }; }
      }, input.deliveryKey);
    },
    surfaceUpdate: async (processJob) => { await deliverWebNotification({ sourceId, triggerKind: "job",
      threadId: processJob.origin.conversationId.split("#")[0].slice(4), deliveryKey: processJob.wake.deliveryKey, processJob }, { stateDir: webState }); },
  });
  let admitted = 0;
  const adapter = await startTuiAdapter({ port: Number(requestedPort), apiKey: key, interaction,
    processJobs: service, processJobsBearer: service.operatorToken,
    processJobWakeAdmission: { claim: async (...args) => {
      const marked = await service.wakeAdmission.claim(...args);
      if (marked && mode === "crossed") { process.send({ event: "crossed", token: args[1] }); await new Promise(() => {}); }
      return marked;
    }, release: async (...args) => { const released = await service.wakeAdmission.release(...args); if (released) process.send({ event: "safe_refusal" }); return released; } },
    // A deterministic local provider at the actual operator responder boundary:
    // no model/network credentials or production configuration are involved.
    responder: { respond: async (request, stream) => {
      if (request.text.includes("Ask the user")) {
        const ask = await fetch(`${interaction.url}/v1/asks`, { method: "POST", headers: {
          authorization: `Bearer ${interaction.token}`, "content-type": "application/json" },
        body: JSON.stringify({ conversationId: request.conversationId, questions: [{ header: "Choice", question: "Which option?",
          options: [{ label: "First", description: "Fictional option" }, { label: "Second", description: "Fictional option" }], multiSelect: false }] }) });
        if (ask.status !== 201) { process.send({ event: "ask_failed", status: ask.status, detail: await ask.text() }); throw new Error("Ask setup failed"); }
        process.send({ event: "blocked" });
        await new Promise((_, reject) => request.abortSignal.addEventListener("abort", () => reject(request.abortSignal.reason), { once: true }));
      }
      if (request.metadata?.[Symbol.for("mono-agent.process-job-wake.delivery-key.v1")] !== undefined) {
        admitted++; process.send({ event: "admitted", count: admitted });
      }
      await stream.append("Child result acknowledged"); return { text: "Child result acknowledged" };
    }, offerLiveInput: () => ({ status: "accepted", settled: Promise.resolve({ status: "requeue", reason: "closed" }) }) },
  });
  process.send({ event: "ready", baseUrl: adapter.baseUrl, pid: process.pid });
  process.on("message", async ({ id, command, threadId, jobId }) => {
    try {
      let result;
      if (command === "activate") await service.activateWakes();
      if (command === "start") {
        const conversationId = `web:${threadId}`;
        const origin = { conversationId, baseConversationId: conversationId, bucket: null, replyToConversationId: conversationId,
          normalizedReplyTarget: conversationId, runId: "smoke-parent", historyBoundary: "smoke-parent", channel: "web" };
        result = await service.internalController(origin, 0).startInternal({ kind: "internal", tool: "Agent", jobId,
          instanceId: "fictional-helper", description: "Choose the next approach", wakeOnCompletion: true, cleanup: async () => {},
          run: async () => ({ status: "awaiting_reply", output: "Which approach?", question: { question: "Which approach?" } }) });
      }
      if (command === "counts") result = { admitted };
      if (command === "inspect") result = await service.get(jobId);
      if (command === "fence") result = await store.get(jobId);
      if (command === "duplicate") result = await deliverWebNotification({ ...lastWake, processJob: await service.get(lastWake.processJob.jobId) }, { stateDir: webState });
      if (command === "stop") { await adapter.stop(); await interaction.stop(); await service.stop(); mutationGate.release(); ownership.release(); }
      process.send({ id, result });
    } catch (error) { process.send({ id, error: error.message }); }
  });
} else {
  const cache = resolve("node_modules/.cache"); await mkdir(cache, { recursive: true });
  const temp = await realpath(await mkdtemp(join(cache, "wake-smoke-")));
  const children = [];
  async function launch(root, webState, mode, port = 0) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--agent", root, webState, mode, String(port)],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] }); children.push(child);
    const events = []; const replies = new Map(); let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("message", (value) => { if (value.id) replies.get(value.id)?.(value); else events.push(value); });
    await waitFor(() => { if (child.exitCode !== null) throw new Error(stderr); return events.find((event) => event.event === "ready"); }, "agent ready");
    return { child, events, ready: events.find((event) => event.event === "ready"), rpc: async (command, data = {}) => {
      const id = randomUUID(); const receipt = new Promise((resolve) => replies.set(id, resolve)); child.send({ id, command, ...data });
      const result = await Promise.race([receipt, delay(15_000).then(() => { throw new Error(`RPC timed out: ${command} ${stderr}`); })]);
      if (result.error) throw new Error(result.error); return result.result;
    } };
  }
  async function kill(agent) { const exited = once(agent.child, "exit"); agent.child.kill("SIGKILL"); await exited; }
  try {
    for (const mode of ["waiting", "crossed"]) {
      const root = join(temp, mode); const webState = join(root, "web");
      await mkdir(join(root, "agent", "workspace"), { recursive: true, mode: 0o700 }); await mkdir(join(root, "home"), { mode: 0o700 });
      let discovered = [];
      const web = await WebService.create({ stateDir: webState, discoveryIntervalMs: 0, purgeIntervalMs: 0, discoverImpl: async () => discovered });
      const ingress = await startWebNotificationIngress(web);
      try {
        const first = await launch(root, webState, mode);
        const discover = (agent) => [{ source: { schema: "agent-runtime.trace-source.v1", sourceId, label: "Smoke agent", artifactDir: join(root, "artifacts"),
          pid: agent.ready.pid, status: "running", health: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), warnings: [] },
          baseUrl: agent.ready.baseUrl, apiKey: key }];
        discovered = discover(first); await web.refreshAgents(); const thread = web.createThread(sourceId); const jobId = randomUUID();
        if (mode === "waiting") { await web.startTurn(thread.id, { text: "Ask the user" });
          await waitFor(() => { const failure = first.events.find((event) => event.event === "ask_failed"); if (failure) throw new Error(JSON.stringify(failure)); return first.events.some((event) => event.event === "blocked"); }, "AskUser blocked"); }
        await first.rpc("activate"); await first.rpc("start", { threadId: thread.id, jobId });
        await waitFor(() => first.events.some((event) => event.event === (mode === "waiting" ? "wake" : "crossed")), "wake boundary");
        if (mode === "waiting") await waitFor(() => web.store.ownsProcessJobWake(`process-job:${jobId}`, first.events.find((event) => event.event === "wake").token), "accepted reservation");
        // Wait for the explicit safe steering refusal to have been persisted.
        const before = await waitFor(async () => {
          const record = await first.rpc("fence", { jobId });
          return record?.wake.admission?.state === (mode === "waiting" ? "not_crossed" : "crossed") ? record : undefined;
        }, "durable boundary");
        if (mode === "waiting") await waitFor(() => first.events.some((event) => event.event === "safe_refusal"), "safe steer persisted");
        assert.equal(before.wake.admission.state, mode === "waiting" ? "not_crossed" : "crossed");
        assert.equal((await first.rpc("counts")).admitted, 0);
        const pendingCard = web.thread(thread.id).messages.flatMap((message) => message.parts)
          .find((part) => part.type === "process-job" && part.job.jobId === jobId);
        assert.ok(pendingCard.job.subagentQuestion);
        assert.equal(pendingCard.job.wake.state, "pending");
        await kill(first);
        // Keep the dead connection present: the old worker may record a failed
        // follow-up but that transport error is not our non-admission proof.
        let oldTurns;
        if (mode === "waiting") oldTurns = await waitFor(() => {
          const rows = web.store.database.prepare("SELECT status, error_code FROM turns WHERE thread_id = ? ORDER BY rowid").all(thread.id);
          return rows.length === 2 && rows.every((row) => row.status !== "running") ? rows : undefined;
        }, "failed old follow-up retained");
        assert.equal(web.store.database.prepare("SELECT state FROM process_job_wake_deliveries WHERE job_id = ?").get(jobId).state, "accepted");
        const port = Number(new URL(first.ready.baseUrl).port);
        const next = await launch(root, webState, "recovered", port);
        assert.notEqual(next.ready.pid, first.ready.pid);
        discovered = discover(next); await web.refreshAgents();
        await next.rpc("activate");
        if (mode === "waiting") {
          await waitFor(() => next.events.some((event) => event.event === "admitted"), "recovered admission");
          await waitFor(async () => (await next.rpc("inspect", { jobId })).wake.state === "delivered", "delivery receipt");
          const recovered = next.events.find((event) => event.event === "wake");
          assert.deepEqual(recovered.notCrossed, [before.wake.admission.token]);
          const admittedBeforeDuplicates = (await next.rpc("counts")).admitted;
          assert.equal(admittedBeforeDuplicates, 1);
          assert.equal((await next.rpc("duplicate")).delivery.delivered, true);
          const oldRequest = await fetch(`${next.ready.baseUrl}/v1/turns`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: JSON.stringify({ conversationId: `web:${thread.id}`, client: "web", text: "Stale wake", processJobWakeDeliveryKey: before.wake.deliveryKey, processJobWakeAttempt: before.wake.admission.token }) });
          assert.equal(oldRequest.ok, false);
          const admittedAfterDuplicates = (await next.rpc("counts")).admitted;
          assert.equal(admittedAfterDuplicates, 1);
          console.log(JSON.stringify({ scenario: mode, oldPid: first.ready.pid, newPid: next.ready.pid, priorFence: before.wake.admission.state,
            certificateCount: recovered.notCrossed.length, oldTurns, pendingChildQuestion: true,
            admittedRedeliveries: admittedBeforeDuplicates, duplicateOrStaleAdmissions: admittedAfterDuplicates - admittedBeforeDuplicates,
            reservation: web.store.database.prepare("SELECT state, disposition FROM process_job_wake_deliveries WHERE job_id = ?").get(jobId) }));
        } else {
          const projection = await next.rpc("inspect", { jobId }); assert.equal(projection.wake.state, "unknown");
          assert.equal(next.events.filter((event) => event.event === "wake" || event.event === "admitted").length, 0);
          console.log(JSON.stringify({ scenario: mode, oldPid: first.ready.pid, newPid: next.ready.pid, priorFence: "crossed", wakeState: "unknown", admittedRedeliveries: 0 }));
        }
        await next.rpc("stop"); await kill(next);
      } finally { await ingress.stop(); await web.stop(); }
    }
  } finally {
    for (const child of children) { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } }
    await rm(temp, { recursive: true, force: true });
  }
}
