// @ts-check

import { existsSync } from "node:fs";
import { passthroughSandbox } from "../sandbox-seam.js";
import {
  isPathAllowed,
  isWorkdirAllowed,
  workspaceRoot,
} from "./shared/path-resolver.js";
import { handOffMonitor, handOffMonitorStop } from "./shared/monitors.js";
import { readToolRuntime } from "./shared/runtime-context.js";
import { requestToolProcessEnvironment, resolveSandboxPolicy } from "./shared/tool-context.js";
import { cleanBashEnvironment } from "./shared/bash-environment.js";

/** Claude-Code-compatible defaults: 5 minutes, never below one second. */
export const DEFAULT_MONITOR_TIMEOUT_MS = 300_000;
export const MIN_MONITOR_TIMEOUT_MS = 1_000;

/**
 * Normalize `timeout_ms` for a monitor. Unlike Bash there is no
 * seconds-vs-milliseconds heuristic — this field is new, so it is exact
 * milliseconds only. `undefined`/invalid falls back to the documented default;
 * the host's own ceiling clamps the result on its side and reports what it
 * actually granted.
 */
export function normalizeMonitorTimeoutMs(value, fallback = DEFAULT_MONITOR_TIMEOUT_MS) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(MIN_MONITOR_TIMEOUT_MS, Math.floor(number));
}

/**
 * Structured Monitor execution used by the Pi bridge.
 *
 * Command preparation is deliberately byte-identical to Bash: the same
 * `/bin/bash --noprofile --norc -c` shape, the same workdir rules, the same
 * cleaned startup environment, and the same sandbox `prepareCommand` seam. A
 * monitor must never be a way to run a command Bash could not.
 *
 * @param {{command?: string, description?: string, timeout_ms?: number, persistent?: boolean, workdir?: string}} params
 * @param {{signal?: AbortSignal, sandboxPolicy?: any, sandboxEngine?: any, ctx?: any, monitorsController?: import("./shared/monitors.js").MonitorsController}} [options]
 */
export async function monitorToolRun(
  { command, description, timeout_ms, persistent, workdir },
  { sandboxPolicy, sandboxEngine, ctx, monitorsController } = {},
) {
  const startedAt = Date.now();
  if (!monitorsController) {
    return failed("Error: Monitors are unsupported for this tool call.", "monitor_unsupported", startedAt);
  }
  if (typeof command !== "string") {
    return failed("Error: Monitor command must be a string.", "monitor_invalid", startedAt);
  }
  if (command.includes("\0")) {
    return failed("Error: Monitor command must not contain NUL characters.", "monitor_invalid", startedAt);
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    return failed("Error: Monitor description is required.", "monitor_invalid", startedAt);
  }
  const resolvedCtx = ctx ?? readToolRuntime();
  const sandbox = resolvedCtx.sandbox ?? passthroughSandbox;
  const policy = resolveSandboxPolicy(resolvedCtx, sandboxPolicy);
  const pathOptions = { sandboxPolicy: policy, ctx: resolvedCtx };
  if (workdir && !isWorkdirAllowed(workdir, pathOptions)) {
    return failed(`Error: Working directory not allowed: ${workdir}`, "workdir_denied", startedAt);
  }
  const cwd = workspaceRoot(workdir, resolvedCtx);
  if (!isPathAllowed(cwd, workdir, pathOptions)) {
    return failed(`Error: Working directory not allowed: ${cwd}`, "workdir_denied", startedAt);
  }
  if (!existsSync(cwd)) {
    return failed(`Error: Working directory not found: ${cwd}`, "workdir_not_found", startedAt);
  }

  let prepared;
  try {
    prepared = await sandbox.prepareCommand({
      policy,
      engine: sandboxEngine ?? resolvedCtx.sandboxEngine ?? undefined,
      command: {
        command: "/bin/bash",
        args: ["--noprofile", "--norc", "-c", command],
        cwd,
        env: requestToolProcessEnvironment(resolvedCtx, cleanBashEnvironment()),
      },
    });
  } catch (error) {
    return failed(`Error: ${error?.message || String(error)}`, "sandbox_prepare_failed", startedAt);
  }

  const isPersistent = persistent === true;
  return await handOffMonitor({
    controller: monitorsController,
    prepared,
    summary: `Monitor command (${command.length} characters; content redacted)`,
    description,
    // A persistent monitor has no timed deadline; sending one anyway would let
    // an ignored field look honoured in the durable record.
    ...(isPersistent ? {} : { timeoutMs: normalizeMonitorTimeoutMs(timeout_ms) }),
    persistent: isPersistent,
    startedAt,
    failed,
  });
}

/**
 * @param {{monitor_id?: string}} params
 * @param {{monitorsController?: import("./shared/monitors.js").MonitorsController}} [options]
 */
export async function monitorStopToolRun({ monitor_id }, { monitorsController } = {}) {
  const startedAt = Date.now();
  if (!monitorsController) {
    return failed("Error: Monitors are unsupported for this tool call.", "monitor_unsupported", startedAt);
  }
  return await handOffMonitorStop({
    controller: monitorsController,
    monitorId: monitor_id,
    startedAt,
    failed,
  });
}

function failed(text, code, startedAt) {
  return {
    text,
    outcome: {
      status: "error",
      code,
      retryable: false,
      attempts: 1,
      durationMs: Date.now() - startedAt,
      bytes: 0,
      truncated: false,
      exitCode: null,
      signal: null,
      timedOut: false,
    },
    error: true,
  };
}
