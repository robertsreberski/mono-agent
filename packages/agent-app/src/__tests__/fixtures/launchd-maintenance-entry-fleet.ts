import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import {
  deriveLaunchdLabel,
  launchdPathsFor,
} from "../../launchd.js";
import { acquireFilesystemLifecycleLock } from "../../launchd-lifecycle-lock.js";
import { runLaunchdMaintenanceEntry } from "../../launchd-maintenance-entry.js";

const [configPath, homeDir, sentinelPath, delayScaleText] = process.argv.slice(2);
if (configPath === undefined || homeDir === undefined || sentinelPath === undefined
  || delayScaleText === undefined) process.exit(64);
const delayScale = Number(delayScaleText);
if (!Number.isFinite(delayScale) || delayScale < 0 || delayScale > 1) process.exit(64);

const started = performance.now();
const usageBefore = process.resourceUsage();
const events: Record<string, number> = {};
const mark = (name: string): void => {
  events[name] = Math.round((performance.now() - started) * 1_000) / 1_000;
};
const pid = process.pid;
const label = deriveLaunchdLabel(configPath);
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
    runner: async () => {
      mark("pidAuthenticated");
      return { code: 0, stdout: `service = {\n\tpid = ${String(pid)}\n}\n`, stderr: "" };
    },
    getuid: () => process.getuid?.() ?? 0,
    currentPid: () => pid,
    isAlive: () => true,
    acquireLifecycleLock: async (target, options) => {
      mark("perAgentAttempt");
      const release = await acquireFilesystemLifecycleLock(target, {
        ...options,
        processIncarnation: {
          schema: "mono-agent.process-incarnation.v1",
          bootSessionId: "issue-609-fleet-process-test",
          processStartId: String(pid),
        },
        isSameProcessIncarnation: (ownerPid, expected) => {
          if (expected.bootSessionId !== "issue-609-fleet-process-test") return false;
          try {
            process.kill(ownerPid, 0);
            return true;
          } catch {
            return false;
          }
        },
      });
      mark(release === undefined ? "perAgentDeferred" : "perAgentWon");
      return release;
    },
    stderr: () => undefined,
  },
  pathsForLabel: (mainLabel) => launchdPathsFor(mainLabel, homeDir),
  verifyEntrypoint: async () => { mark("attested"); },
  loadHeavy: async () => {
    mark("heavyImportStart");
    return {
      runLaunchdLogMaintenanceCommandWithLifecycleLease: async () => {
        await writeFile(sentinelPath, "proven and recovered\n", { mode: 0o600 });
        mark("recovered");
        return 0;
      },
    };
  },
  currentEntrypointPath: "/private/tmp/managed/dist/launchd-maintenance-entry.js",
  platform: "darwin",
  sleep: async (milliseconds) => {
    requestedDelayMs = milliseconds;
    mark("dispersionStart");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds * delayScale));
    mark("dispersionEnd");
  },
  stderr: () => undefined,
});

const usageAfter = process.resourceUsage();
process.stdout.write(`${JSON.stringify({
  result,
  pid,
  label,
  requestedDelayMs,
  durationMs: Math.round((performance.now() - started) * 1_000) / 1_000,
  cpuMs: Math.round(((usageAfter.userCPUTime - usageBefore.userCPUTime)
    + (usageAfter.systemCPUTime - usageBefore.systemCPUTime)) / 1_000 * 1_000) / 1_000,
  maxRssKiB: usageAfter.maxRSS,
  events,
})}\n`);
process.exitCode = result;
