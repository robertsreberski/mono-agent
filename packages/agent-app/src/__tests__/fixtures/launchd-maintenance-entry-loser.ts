import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { deriveLaunchdLabel, launchdPathsFor } from "../../launchd.js";
import { acquireFilesystemLifecycleLock } from "../../launchd-lifecycle-lock.js";
import { runLaunchdMaintenanceEntry } from "../../launchd-maintenance-entry.js";

const [configPath, homeDir, sentinelPath] = process.argv.slice(2);
if (configPath === undefined || homeDir === undefined || sentinelPath === undefined) process.exit(64);
const pid = process.pid;
const started = performance.now();
const usageBefore = process.resourceUsage();
let heavyImported = false;
let requestedDelayMs = -1;
const result = await runLaunchdMaintenanceEntry([
  "__launchd-log-maintenance",
  "--config", configPath,
  "--controller-cli", "/private/tmp/issue-609-controller/dist/cli.js",
  "--agent-cwd", "/private/tmp/issue-609-agent",
  "--agent-path", "/usr/bin:/bin",
  "--expected-managed-runtime-launch", "cHJvb2Y",
], process.env, {
  gate: {
    runner: async () => ({ code: 0, stdout: `service = {\n\tpid = ${pid}\n}\n`, stderr: "" }),
    getuid: () => process.getuid?.() ?? 0,
    currentPid: () => pid,
    isAlive: () => true,
    acquireLifecycleLock: async (target, options) => await acquireFilesystemLifecycleLock(target, {
      ...options,
      processIncarnation: {
        schema: "mono-agent.process-incarnation.v1",
        bootSessionId: "issue-609-process-test",
        processStartId: String(pid),
      },
      isSameProcessIncarnation: (ownerPid, expected) => {
        if (expected.bootSessionId !== "issue-609-process-test") return false;
        try {
          process.kill(ownerPid, 0);
          return true;
        } catch {
          return false;
        }
      },
    }),
    stderr: () => undefined,
  },
  pathsForLabel: (label) => launchdPathsFor(label, homeDir),
  verifyEntrypoint: async () => {
    await writeFile(sentinelPath, "attestation reached\n");
  },
  loadHeavy: async () => {
    heavyImported = true;
    await writeFile(sentinelPath, "heavy import reached\n");
    return { runLaunchdLogMaintenanceCommandWithLifecycleLease: async () => 99 };
  },
  currentEntrypointPath: "/private/tmp/managed/dist/launchd-maintenance-entry.js",
  platform: "darwin",
  sleep: async (milliseconds) => {
    requestedDelayMs = milliseconds;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds * 0.001));
  },
  stderr: () => undefined,
});

// Make the derived identity part of the executable fixture rather than dead setup.
deriveLaunchdLabel(configPath);
const usageAfter = process.resourceUsage();
process.stdout.write(`${JSON.stringify({
  durationMs: Math.round((performance.now() - started) * 1_000) / 1_000,
  cpuMs: Math.round(((usageAfter.userCPUTime - usageBefore.userCPUTime)
    + (usageAfter.systemCPUTime - usageBefore.systemCPUTime)) / 1_000 * 1_000) / 1_000,
  maxRssKiB: usageAfter.maxRSS,
  requestedDelayMs,
  heavyImported,
})}\n`);
process.exitCode = result;
