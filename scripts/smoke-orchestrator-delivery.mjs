#!/usr/bin/env node
// Run after: pnpm --filter @mono-agent/agent-app... build
// Real built-dist host admission, durable storage, locks, Exec, and Pi subprocess
// transport. The responder is scripted: no model, external provider, or hosted CI.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { acquireAgentRootOwnership, releaseAgentRootOwnershipWhenIdle } from "../packages/agent-app/dist/agent-root-coordinator.js";
import { registerProcessJobsRoot } from "../packages/agent-app/dist/process-jobs-root-registry.js";
import { PROCESS_JOBS_DEFAULTS } from "../packages/agent-app/dist/process-jobs-config.js";
import { openProcessJobsService } from "../packages/agent-app/dist/process-jobs-service.js";
import { resolveProcessJobsProtectionPosture } from "../packages/agent-app/dist/process-jobs-protection.js";
import { createProcessJobsRuntimeExtension } from "../packages/agent-app/dist/process-jobs-runtime.js";
import { bindProcessJobWakeContextToResponder, processJobWakeContextForRequest, runWithProcessJobWakeContext } from "../packages/agent-app/dist/process-jobs-context.js";
// agent-runtime ships its JavaScript src directly (package.json exports); the
// TypeScript app/service/runtime admission above must use freshly built dist.
import { execToolRun } from "../packages/agent-runtime/src/agent/tools/exec.js";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const root = await realpath(await mkdtemp(join(tmpdir(), "mono-orchestrator-delivery-")));
const agentRoot = join(root, "agent");
const workspace = join(agentRoot, "work");
const leaseHome = join(root, "lease-home");
const conversationId = "web:orchestrator-delivery-smoke";
const jobs = [];
const wakes = [];
const availability = [];
const surfaceUpdates = [];
let service;
let ownership;
let extension;
let callbackError;
let exhausted = false;
let helperId;
let unknownId;

// Remove inherited credentials from tool children; Git is confined to this new
// repository, with global/system configuration and hooks disabled.
const childEnvironment = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
Object.assign(childEnvironment, {
  PATH: process.env.PATH, TMPDIR: root, LANG: "en_US.UTF-8", HOME: root,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Disposable smoke", GIT_AUTHOR_EMAIL: "smoke@example.invalid",
  GIT_COMMITTER_NAME: "Disposable smoke", GIT_COMMITTER_EMAIL: "smoke@example.invalid",
});
const childCtx = { workspace, toolEnvironment: { values: childEnvironment } };
const stages = [
  "const fs=require('node:fs');const cp=require('node:child_process');cp.execFileSync('git',['init','--quiet']);fs.writeFileSync('value.txt','bad');fs.writeFileSync('check.cjs',\"require('node:assert/strict').equal(require('node:fs').readFileSync('value.txt','utf8'),'correct')\");console.log('SETUP_BAD_CHECK');",
  "require('./check.cjs');",
  "require('node:fs').writeFileSync('value.txt','correct');console.log('CORRECTION_WRITTEN');",
  "require('./check.cjs');console.log('CHECK_PASSED');",
  "const cp=require('node:child_process');cp.execFileSync('git',['add','--','value.txt','check.cjs']);cp.execFileSync('git',['-c','core.hooksPath=/dev/null','commit','--quiet','-m','Fix disposable acceptance check']);console.log('COMMIT_CREATED');",
  "setTimeout(()=>{require('./check.cjs');console.log('CI_LIKE_SUBPROCESS_SETTLED')},150);",
];
while (stages.length < 32) stages.push(`console.log('CHAIN_STAGE_${stages.length}');`);

function toolOptions(controller) {
  return { ctx: childCtx, processJobsController: controller };
}
async function launch(controller, script, extra = {}) {
  const result = await execToolRun({ executable: process.execPath, args: ["--eval", script], workdir: workspace,
    background: true, timeout_ms: 10_000, ...extra }, toolOptions(controller));
  assert.equal(result.outcome.code, "background_started", result.text);
  return result.outcome.job_id;
}
async function waitFor(predicate, label) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (callbackError) throw callbackError;
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}

const responder = bindProcessJobWakeContextToResponder({
  async respond(request) {
    const context = processJobWakeContextForRequest(request);
    const depth = context.kind === "resolved" ? context.context.chainDepth : 0;
    assert.equal(context.kind, depth === 0 ? "none" : "resolved");
    const turn = await extension({ runId: `smoke-run-${depth}`, request });
    try {
      const options = turn.runtimeOptions;
      availability.push(options.processJobsAvailability);
      assert.equal(options.processJobsAvailability.chainDepth, depth);
      assert.equal(options.processJobsAvailability.maxChainDepth, 32);
      assert.equal(options.processJobsAvailability.remainingStarts, 32 - depth);
      if (depth === 32) {
        assert.equal(options.processJobs, undefined);
        assert.equal(options.processJobsAvailability.unavailableReason, "chain_depth_exhausted");
        const denied = await execToolRun({ executable: process.execPath, args: ["--eval", "process.exit(99)"],
          workdir: workspace, background: true }, toolOptions(options.processJobs));
        assert.equal(denied.outcome.code, "background_unsupported");
        exhausted = true;
      } else {
        assert.ok(options.processJobs, `Missing controller at depth ${depth}`);
        assert.equal(jobs.length, depth, "No synthetic user-turn or depth reset");
        // Auxiliary terminal delivery cases use the same initial controller;
        // only the main chain advances the scripted responder.
        if (depth === 0) {
          helperId = await launch(options.processJobs, "console.log('HELPER_COMPLETE')", { wake_on_completion: false });
          await waitFor(async () => (await service.get(helperId))?.wake.state === "suppressed", "helper opt-out");
          unknownId = await launch(options.processJobs, "console.log('AMBIGUOUS_RECEIPT')");
          await waitFor(async () => (await service.get(unknownId))?.wake.state === "unknown", "ambiguous receipt");
        }
        jobs.push(await launch(options.processJobs, stages[depth]));
      }
      return { text: "Scripted transport smoke turn completed." };
    } finally {
      await turn.cleanup?.();
      await turn.settleCleanup?.();
    }
  },
});

try {
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(leaseHome, { mode: 0o700 })]);
  ownership = await acquireAgentRootOwnership(agentRoot, { homeDir: leaseHome });
  const settings = { ...PROCESS_JOBS_DEFAULTS, configured: true, enabled: true,
    unsafeAllowUnprotectedState: true, stateDir: join(agentRoot, ".mono-agent", "process-jobs"),
    maxChainDepth: 32, maxRuntimeMs: 10_000, retention: { ...PROCESS_JOBS_DEFAULTS.retention } };
  const registration = await registerProcessJobsRoot({ agentRoot, workspace, stateDir: settings.stateDir,
    coordinator: ownership.coordinator });
  const coreConfig = { runtime: { workspace, model: { provider: "openai-codex", model: "gpt-5.6-sol", reference: "openai-codex:gpt-5.6-sol" } },
    tools: { allowedTools: ["Exec", "Bash"], disallowedTools: [] }, sandbox: { mode: "off" } };
  service = await openProcessJobsService({ cwd: agentRoot, workspace, settings, registration,
    surfaceUpdate: async (projection) => { surfaceUpdates.push({ jobId: projection.jobId, state: projection.state }); },
    wake: async (input) => {
      try {
        if (input.projection.jobId === unknownId || input.projection.output.preview.includes("AMBIGUOUS_RECEIPT")) {
          wakes.push({ jobId: input.projection.jobId, ambiguous: true });
          return { delivered: false, code: "notification_delivery_unknown", reason: "Scripted ambiguous receipt",
            ambiguous: true, retryable: false };
        }
        assert.equal(input.chainDepth, input.projection.limits.chainDepth + 1);
        assert.equal(input.conversationId, conversationId);
        assert.equal(input.chainDepth, wakes.filter((wake) => !wake.ambiguous).length + 1);
        wakes.push({ jobId: input.projection.jobId, depth: input.chainDepth });
        await runWithProcessJobWakeContext({ jobId: input.projection.jobId, chainDepth: input.chainDepth },
          () => responder.respond({ conversationId, text: input.prompt, metadata: { source: "web" } }, {}), input.deliveryKey);
        return { delivered: true };
      } catch (error) {
        callbackError = error;
        throw error;
      }
    },
  });
  extension = createProcessJobsRuntimeExtension({ ownership, registry: registration.snapshot, service,
    coreConfig, baseModel: coreConfig.runtime.model, channelId: "tui",
    protectionPosture: resolveProcessJobsProtectionPosture({ settings, registry: registration.snapshot, coreConfig }) });
  await service.activateWakes();
  await responder.respond({ conversationId, text: "Begin disposable acceptance chain", metadata: { source: "web" } }, {});
  await waitFor(() => exhausted, "32 successive host-wake completions");
  await waitFor(async () => (await service.get(jobs.at(-1)))?.wake.state === "delivered", "last wake receipt persistence");
  const projections = await Promise.all(jobs.map((jobId) => service.get(jobId)));
  assert.equal(projections.length, 32);
  for (const [depth, job] of projections.entries()) {
    assert.equal(job.limits.chainDepth, depth);
    assert.equal(job.origin.runId, `smoke-run-${depth}`);
    assert.equal(job.origin.conversationId, conversationId);
    assert.equal(job.state, depth === 1 ? "failed" : "succeeded");
    assert.equal(job.wake.state, "delivered");
    assert.equal(job.wake.attempts, 1);
  }
  assert.match(projections[3].output.preview, /CHECK_PASSED/);
  assert.match(projections[5].output.preview, /CI_LIKE_SUBPROCESS_SETTLED/);
  assert.equal(await readFile(join(workspace, "value.txt"), "utf8"), "correct");
  const gitEnv = Object.fromEntries(Object.entries(childEnvironment).filter(([, value]) => value !== undefined));
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, env: gitEnv, encoding: "utf8" }).trim();
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: workspace, env: gitEnv, encoding: "utf8" }), "");
  await service.stop();
  service = undefined;
  // Reopen the actual durable store and reactivate wakes: unknown receipts must
  // remain unknown and must not be replayed after process-service recovery.
  let replayed = 0;
  service = await openProcessJobsService({ cwd: agentRoot, workspace, settings, registration,
    wake: async () => { replayed += 1; return { delivered: true }; } });
  await service.activateWakes();
  const unknown = await service.get(unknownId);
  const helper = await service.get(helperId);
  assert.equal(unknown.wake.state, "unknown");
  assert.equal(unknown.wake.attempts, 1);
  assert.equal(helper.wake.state, "suppressed");
  assert.equal(helper.wake.attempts, 0);
  assert.ok(surfaceUpdates.some((update) => update.jobId === helperId && update.state === "succeeded"));
  await service.stop();
  service = undefined;
  assert.equal(replayed, 0);
  console.log(JSON.stringify({ result: "passed", sourceRoot,
    sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim(),
    sourceTreeClean: execFileSync("git", ["status", "--porcelain"], { cwd: sourceRoot, encoding: "utf8" }).trim() === "",
    transport: "built-dist-real-Exec-Pi-subprocess-scripted-responder",
    chainJobs: jobs.length, wakeDepths: wakes.filter((wake) => !wake.ambiguous).map((wake) => wake.depth),
    initialUserTurns: 1, syntheticDepthResets: 0, deliberateFailedCheck: true, correctionVerified: true,
    disposableCommit: commit, ciLikeSubprocessSettled: true, depth31: availability[31], depth32: availability[32],
    helperOptOutTerminalUpdate: true, ambiguousReceiptNotReplayedAfterReopen: true,
    providerCalls: 0, actualModelPolicyBehavior: "not tested", hostedCI: "not tested" }));
} finally {
  await service?.stop();
  if (ownership) assert.equal(await releaseAgentRootOwnershipWhenIdle(ownership), true, "All request leases must settle");
  // Exact directory allocated by this invocation only; service.stop owns its PIDs.
  await rm(root, { recursive: true, force: true });
}
