// Built producer → helper contract round-trip; no supervisor installation or model call.
import assert from "node:assert/strict";
import { fork, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startMonoAgentApp } from "../../../dist/app-controller.js";
import { WorkerActivityTracker } from "../../../dist/worker-activity.js";
import { probeWorkerActivity, publishWorkerActivity } from "../../../dist/worker-activity-snapshot.js";
import { allowUnattendedMaintenanceStop, readLaunchdMaintenanceActivityStatus } from "../../../dist/launchd-maintenance-activity.js";

const target = (root) => ({ label: "com.mono-agent.smoke-01234567", paths: {
  logDir: resolve(root, "logs"), stdoutPath: resolve(root, "logs/out"), stderrPath: resolve(root, "logs/err"),
  launchAgentsDir: root, plistPath: resolve(root, "worker.plist"),
} });
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

if (process.argv[2] === "--worker") {
  const root = process.argv[3];
  const tracker = new WorkerActivityTracker();
  let app;
  const publisher = await publishWorkerActivity(target(root), tracker, () => { throw new Error("Activity publication failed"); });
  try {
    app = await startMonoAgentApp({ cwd: root, env: { HOME: root, PATH: "/usr/bin:/bin" }, drivers: [], activityTracker: tracker });
    const service = app.processJobsService;
    assert(service, "real foreground app must own ProcessJobs");
    const origin = { conversationId: "web:smoke", baseConversationId: "web:smoke", bucket: null,
      replyToConversationId: "web:smoke", normalizedReplyTarget: "web:smoke", runId: "smoke", historyBoundary: "smoke", channel: "web" };
    await service.internalController(origin, 0).startInternal({ kind: "internal", tool: "Agent", jobId: randomUUID(),
      instanceId: "local-sleep", timeoutMs: 15_000, wakeOnCompletion: false,
      run: async (signal) => { await promisify(execFile)("/bin/sleep", ["3"], { signal }); return { status: "ok", output: "", childStillBusy: false }; },
      cleanup: async () => {},
    });
    process.send({ event: "running", pid: process.pid });
    await new Promise((done) => process.once("message", done));
  } finally {
    await app?.stop(); await publisher.stop(); process.disconnect();
  }
} else {
  const root = await mkdtemp(resolve(process.cwd(), "node_modules/.worker-maintenance-smoke-"));
  let child;
  try {
    await mkdir(resolve(root, "logs"));
    await writeFile(resolve(root, "IDENTITY.md"), "A fictional local maintenance verifier.\n");
    await writeFile(resolve(root, "mono-agent.config.json"), JSON.stringify({
      runtime: { model: "pi:ollama:local-stub", workspace: "." }, context: { identityPath: "./IDENTITY.md", selectedSkills: [] },
      tools: { allowedTools: [], disallowedTools: [] }, artifacts: { dir: "./artifacts" },
      traceability: { registryDir: "./trace-sources", sourceId: "maintenance-smoke", sourceLabel: "Maintenance Smoke" },
      processJobs: { enabled: true },
    }));
    child = fork(fileURLToPath(import.meta.url), ["--worker", root], {
      cwd: root, env: { HOME: root, PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const output = []; child.stdout.on("data", (data) => output.push(String(data))); child.stderr.on("data", (data) => output.push(String(data)));
    const budget = setTimeout(() => child.kill("SIGTERM"), 60_000);
    const exited = new Promise((done) => child.once("exit", (code) => { clearTimeout(budget); done(code); }));
    const ready = await Promise.race([
      new Promise((done) => child.once("message", done)),
      exited.then((code) => { throw new Error(`Foreground worker exited before ready (${code}): ${output.join("")}`); }),
    ]);
    const t = target(root); const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const probe = () => probeWorkerActivity(t.label, t.paths, ready.pid, isAlive);
    let busy;
    for (let i = 0; i < 100; i++) { busy = await probe(); if (busy.disposition === "busy") break; await wait(20); }
    assert.equal(busy.disposition, "busy"); assert.equal(busy.counts.jobs, 1);
    const helperDeps = { runner: async () => ({ code: 0, stdout: `state = running\npid = ${ready.pid}\n`, stderr: "" }),
      getuid: () => process.getuid?.() ?? 0, now: Date.now, isAlive };
    assert.equal(await allowUnattendedMaintenanceStop(t, helperDeps, { reasons: ["log-size"] }), false);
    assert.equal((await readLaunchdMaintenanceActivityStatus(t.label, t.paths)).lastDecision.outcome, "deferred-busy");
    let idle;
    for (let i = 0; i < 500; i++) { idle = await probe(); if (idle.disposition === "idle") break; await wait(20); }
    assert.equal(idle.disposition, "idle");
    assert.equal(await allowUnattendedMaintenanceStop(t, helperDeps, { reasons: ["log-size"] }), true);
    const decision = (await readLaunchdMaintenanceActivityStatus(t.label, t.paths)).lastDecision.outcome;
    assert.equal(decision, "proceeded-idle");
    console.log(JSON.stringify({ transport: "built-private-file", workerPid: ready.pid, busy, idle, helperDecisions: ["deferred-busy", decision], modelCalls: 0 }));
    child.send({ stop: true }); assert.equal(await exited, 0);
  } finally {
    if (child?.connected) { child.send({ stop: true }); await new Promise((done) => child.once("exit", done)); }
    await rm(root, { recursive: true, force: true });
  }
}
