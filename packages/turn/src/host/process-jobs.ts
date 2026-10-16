import type { ProcessJobProcessResult } from "#turn/contracts/process";
import type { ProcessJobLaunchOptions } from "#turn/contracts/process";
import type { ProcessJobProcessHandle } from "#turn/contracts/process";
import type { ProcessJobStartRequest } from "#turn/contracts/process";
import type { ProcessJobStartResult } from "#turn/contracts/process";
import type { ProcessJobControllerLimits } from "#turn/contracts/process";
import type { ProcessJobsController } from "#turn/contracts/process";

export type { ProcessJobProcessResult } from "#turn/contracts/process";

export type { ProcessJobLaunchOptions } from "#turn/contracts/process";

export type { ProcessJobProcessHandle } from "#turn/contracts/process";

export type { ProcessJobStartRequest } from "#turn/contracts/process";

export type { ProcessJobStartResult } from "#turn/contracts/process";

export type { ProcessJobControllerLimits } from "#turn/contracts/process";

export type { ProcessJobsController } from "#turn/contracts/process";


/** Bridge the typed host controller to agent-runtime's dependency-free seam. */
export function bridgeProcessJobsController(
  controller: ProcessJobsController,
): ProcessJobsController {
  if (controller === null || typeof controller !== "object" || typeof controller.start !== "function") {
    throw new TypeError("Process-jobs controller must implement start().");
  }
  const limits = bridgedLimits(controller.limits);
  return Object.freeze({
    ...(limits === undefined ? {} : { limits }),
    async start(request: ProcessJobStartRequest): Promise<ProcessJobStartResult> {
      assertKernelStartRequest(request);
      return await controller.start(request);
    },
  });
}

/** Copy only well-formed positive budgets; a malformed one is simply unstated. */
function bridgedLimits(
  limits: ProcessJobControllerLimits | undefined,
): ProcessJobControllerLimits | undefined {
  if (limits === null || typeof limits !== "object") return undefined;
  const { maxRuntimeMs, maxOutputBytes } = limits;
  if (!Number.isSafeInteger(maxRuntimeMs) || maxRuntimeMs <= 0) return undefined;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) return undefined;
  return Object.freeze({ maxRuntimeMs, maxOutputBytes });
}

function assertKernelStartRequest(request: ProcessJobStartRequest): void {
  if (request === null || typeof request !== "object"
    || (request.tool !== "Exec" && request.tool !== "Bash")
    || typeof request.summary !== "string"
    || (request.description !== undefined && typeof request.description !== "string")
    || (request.wakeOnCompletion !== undefined && typeof request.wakeOnCompletion !== "boolean")
    || typeof request.launch !== "function"
    || request.prepared === null
    || typeof request.prepared !== "object"
    || typeof request.prepared.command !== "string"
    || !Array.isArray(request.prepared.args)
    || request.prepared.args.some((argument) => typeof argument !== "string")
    || typeof request.prepared.cwd !== "string"
    || typeof request.prepared.sandboxed !== "boolean"
    || (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0))
    || (request.maxOutputChars !== undefined
      && (!Number.isSafeInteger(request.maxOutputChars) || request.maxOutputChars <= 0))) {
    throw new TypeError("Kernel process-job start request is invalid.");
  }
}
