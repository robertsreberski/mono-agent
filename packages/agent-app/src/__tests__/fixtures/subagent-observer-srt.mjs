// Opt-in real SRT observation proof; never substitutes an unsandboxed probe.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSandboxPolicy, createSrtSandboxEngine } from "@mono-agent/runtime-adapter";
import { monoSandboxImpl } from "../../../../runtime-adapter/dist/sandbox-impl.js";
import { createToolContext } from "../../../../agent-runtime/src/agent/tools/shared/tool-context.js";
import { getPiBuiltinTools } from "../../../../agent-runtime/src/agent/tools/pi-bridge.js";
import { acquireAgentRootOwnership } from "../../../dist/agent-root-coordinator.js";
import { registerProcessJobsRoot } from "../../../dist/process-jobs-root-registry.js";
import { openProcessJobsService } from "../../../dist/process-jobs-service.js";
import { PROCESS_JOBS_DEFAULTS } from "../../../dist/process-jobs-config.js";
import { createSubagentInstanceRegistry } from "../../../dist/subagent-instances.js";
import { createSubagentRecoveryAccess } from "../../../dist/subagent-recovery-access.js";
import { resolveSubagentObservationGit } from "../../../dist/subagent-observation-git.js";
const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url)).replace(/\/$/, "");
assert.equal(process.cwd(), ROOT);
const local = resolve(ROOT, ".mono-agent/verification/srt-local");
// Caller must scope all runtime settings/proof/cache creation inside this checkout.
// Darwin Unix socket paths are limited: keep SRT's mux directory short, still
// inside the assigned checkout (the longer cache path is safe for ordinary files).
assert.equal(process.env.TMPDIR, resolve(ROOT, ".mono-agent/t"));
assert.equal(process.env.HOME, resolve(local, "home"));
const engine = createSrtSandboxEngine({ cacheRoot: resolve(local, "cache"), homeDir: process.env.HOME, env: process.env });
assert.equal(await engine.isAvailable(), true, "Real managed SRT functional enforcement is unavailable; no host fallback attempted.");
const root = await mkdtemp(resolve(ROOT, ".mono-agent/verification/observer-srt-"));
const repository = resolve(root, "repository");
const worktree = resolve(root, "worktree");
const agentRoot = resolve(root, "agent");
await mkdir(repository); await mkdir(agentRoot);
const nativeGit = await resolveSubagentObservationGit();
// Fixture preparation is not observer evidence; avoid the platform shim here too.
const git = (cwd, args) => execFileSync(nativeGit.path, ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
  cwd: ROOT, env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" }, timeout: 10_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();
git(repository, ["init", "--quiet"]); await writeFile(resolve(repository, "tracked.txt"), "original\n");
git(repository, ["add", "tracked.txt"]); git(repository, ["commit", "--quiet", "-m", "fixture"]);
git(repository, ["worktree", "add", "--quiet", "-b", "observation", worktree]);
const head = git(worktree, ["rev-parse", "HEAD"]);
await writeFile(resolve(worktree, "tracked.txt"), "changed\n");
await writeFile(resolve(worktree, "report.md"), "THIS REPORT CONTENT MUST NOT BE RETURNED", { mode: 0o000 });
const common = resolve(repository, ".git");
// Only repository authority is declared here. The existing sandbox engine
// grants the selected native executable's separate read-only runtime access.
const extraReadRoots = [common];
const ownership = await acquireAgentRootOwnership(agentRoot);
const keepAlive = setInterval(() => {}, 1000);
let service;
try {
  const stateDir = resolve(agentRoot, "jobs");
  const registration = await registerProcessJobsRoot({ agentRoot, workspace: worktree, stateDir, coordinator: ownership.coordinator });
  const origin = { conversationId: "web:observer", baseConversationId: "web:observer", bucket: null,
    replyToConversationId: "web:observer", normalizedReplyTarget: "web:observer", runId: "proof", historyBoundary: "proof", channel: "web" };
  service = await openProcessJobsService({ cwd: agentRoot, workspace: worktree, registration,
    settings: { ...PROCESS_JOBS_DEFAULTS, configured: true, enabled: true, stateDir }, wake: async () => ({ delivered: true }),
  });
  let protectedRoots = [agentRoot];
  const policy = createSandboxPolicy({ root: worktree, mode: "native", readableRoots: [worktree, ...extraReadRoots], writableRoots: [], network: { mode: "none" }, protectedRoots });
  const ctx = createToolContext({ workspace: worktree, additionalReadRoots: extraReadRoots, sandbox: monoSandboxImpl, sandboxPolicy: policy, sandboxEngine: engine });
  const access = createSubagentRecoveryAccess({ service, privateRoots: async () => protectedRoots,
    hostAccess: () => ({ workspace: worktree, readableRoots: extraReadRoots, sandboxPolicy: policy, sandboxEngine: engine }),
  });
  const registryRoot = resolve(agentRoot, "children");
  const registry = createSubagentInstanceRegistry({ root: registryRoot, retireSession: async () => {}, ...access,
    ownerForReservation: (jobId) => ({ jobId, storeRoot: stateDir }), resolveOwner: (identity) => service.resolveSubagentOwner(identity),
    checkOwnerIndex: (conversationId, known) => service.checkSubagentOwnerIndex(conversationId, known),
  });
  service.bindManagedSubagents({ root: registryRoot,
    verify: async (identity) => (await registry.open(identity.conversationId, { existingOnly: true })).verifyOwner(identity),
    publish: async (phase, publication) => (await registry.open(publication.identity.conversationId, { existingOnly: true })).publishOwned(phase, publication),
  });
  await service.activateWakes();
  const instances = await registry.open(origin.conversationId);
  let providerCalls = 0;
  const subagents = { instances, definitions: [{ name: "seed", description: "Seed a completed fixture child", systemPrompt: "Fixture", allowedTools: ["Read"] }],
    // No model/network or test execution is claimed by this seed callback.
    run: async (request) => { providerCalls++; return { text: "Fixture seed", providerSessionId: request.instance.sessionId }; },
    backgroundSubagentController: service.internalController(origin, 0),
  };
  const tools = getPiBuiltinTools(["Agent", "AgentSend"], { subagents, ctx, sandboxPolicy: policy, sandboxEngine: engine });
  const agent = tools.find((tool) => tool.name === "Agent");
  const send = tools.find((tool) => tool.name === "AgentSend");
  assert(agent && send);
  const receipt = await agent.execute("seed", { name: "seed", persist: true, background: true, id: "observer", prompt: "Seed only", verification: { workdir: worktree, reportPath: "report.md" } });
  const deadline = Date.now() + 10_000;
  while ((await service.get(receipt.details.jobId))?.wake.state !== "delivered") {
    assert(Date.now() < deadline, "Seed job did not finish"); await new Promise((done) => setTimeout(done, 25));
  }
  assert.equal(providerCalls, 1);
  const inspect = async () => (await send.execute("inspect", { id: "observer", inspect: true })).details.recovery;
  const observed = await inspect();
  if (observed.facts?.status !== "observed") {
    // Failure-only diagnostic, still the real SRT and exact gated process path.
    // It does not replace or pass the primary Pi-bridge assertion below.
    const { observeSubagentVerification, registerSubagentVerification } = await import("../../../dist/subagent-verification-observer.js");
    const { startPreparedProcess } = await import("../../../../agent-runtime/src/agent/tools/shared/process-runner.js");
    const diagnosticAccess = { workspace: worktree, readableRoots: extraReadRoots, sandboxPolicy: policy, sandboxEngine: engine,
      runProbe: async (prepared, timeoutMs) => {
        const handle = startPreparedProcess(prepared, { timeoutMs, maxBufferBytes: 16384, exactEnvironment: true, waitForProcessGroup: true });
        await handle.release(); const result = await handle.completion;
        console.error(JSON.stringify({ diagnostic: true, code: result.code, signal: result.signal, timedOut: result.timedOut, groupExitConfirmed: result.groupExitConfirmed, stderr: result.stderr.slice(0, 2048) }));
        return result;
      } };
    const target = await registerSubagentVerification({ workdir: worktree, reportPath: "report.md" }, diagnosticAccess, protectedRoots);
    console.error(JSON.stringify(await observeSubagentVerification(target, diagnosticAccess, protectedRoots)));
  }
  assert.equal(observed.facts?.status, "observed", JSON.stringify(observed));
  assert.equal(observed.facts.observation.headBefore, head);
  assert.equal(observed.facts.observation.headAfter, head);
  assert.deepEqual(observed.facts.observation.report, { path: "report.md", present: true });
  assert(observed.facts.observation.paths.some((entry) => entry.path === "tracked.txt" && entry.status === "tracked"));
  assert(!JSON.stringify(observed).includes("THIS REPORT CONTENT"));
  assert.equal(process.cwd(), ROOT); assert.equal(providerCalls, 1);
  assert.equal((await service.get(receipt.details.jobId)).subagentObservation, undefined);
  // Revoke the common directory after a successful persisted observation. No
  // stale policy, cached success or private path is disclosed by the next query.
  protectedRoots = [agentRoot, common];
  const revoked = await inspect();
  assert.equal(revoked.status, "observation_policy_denied");
  assert(!JSON.stringify(revoked).includes(common)); assert.equal(revoked.facts, undefined);
  protectedRoots = [agentRoot];
  await mkdir(resolve(common, "objects/info"), { recursive: true });
  await writeFile(resolve(common, "objects/info/alternates"), "/not-authorized");
  const unsafe = await inspect();
  assert.equal(unsafe.status, "observation_policy_unavailable");
  assert.equal(unsafe.facts, undefined);
  await rm(resolve(common, "objects/info/alternates"));
  await rm(resolve(worktree, "report.md"));
  await writeFile(resolve(agentRoot, "private-report"), "OWNER PRIVATE");
  await symlink(resolve(agentRoot, "private-report"), resolve(worktree, "report.md"));
  const escaped = await inspect();
  assert.equal(escaped.status, "observation_policy_denied");
  assert(!JSON.stringify(escaped).includes("OWNER PRIVATE"));
  assert.equal(providerCalls, 1);
  await rm(resolve(worktree, "report.md"));
  await writeFile(resolve(worktree, "report.md"), "presence only");
  // Explicit runtime revocation is enforced by the observer before preparation;
  // native process-exec is not equivalent to file-read permission on macOS.
  protectedRoots = [agentRoot, nativeGit.path];
  const deniedRuntime = await inspect();
  assert.equal(deniedRuntime.status, "observation_policy_denied");
  assert.equal(deniedRuntime.facts.status, "observation_policy_denied");
  assert.equal(deniedRuntime.facts.observation, undefined);
  protectedRoots = [agentRoot];
  assert.equal((await inspect()).facts.status, "observed");
  assert.equal(providerCalls, 1);
  console.log(JSON.stringify({ kind: "subagent-observer-real-srt", root, result: "passed", authorizedLinkedWorktree: true, policyRevocation: true, unsafeAlternates: true, privateReportEscape: true, deniedRuntime: true, inspectionProviderCalls: 0 }));
} finally {
  try { await service?.stop(); ownership.release(); } finally { clearInterval(keepAlive); }
}
