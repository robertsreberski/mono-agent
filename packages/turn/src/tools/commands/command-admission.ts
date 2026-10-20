// Shared checks are separate so frontend argument validation stays between them.
import { existsSync } from "node:fs";
import { isPathAllowed, isWorkdirAllowed, workspaceRoot } from "../shared/path-resolver.js";


export function commandAdmission({ background, wakeOnCompletion, processJobsController }: { background: any; wakeOnCompletion: any; processJobsController: any }): { text: string; code: string } | undefined {
  if (wakeOnCompletion !== undefined && (background !== true || typeof wakeOnCompletion !== "boolean")) {
    return { text: "Error: wake_on_completion requires background=true and a boolean value.", code: "process_job_invalid" };
  }
  if (background === true && !processJobsController) {
    return { text: "Error: Background process jobs are unavailable for this request.", code: "background_unsupported" };
  }
  return undefined;
}

export function commandWorkdir(workdir: any, { sandboxPolicy, ctx }: { sandboxPolicy: any; ctx: any }): { failure: { text: string; code: string }; cwd?: undefined } | { cwd: string; failure?: undefined } {
  const pathOptions = { sandboxPolicy, ctx };
  if (workdir && !isWorkdirAllowed(workdir, pathOptions)) {
    return { failure: { text: `Error: Working directory not allowed: ${workdir}`, code: "workdir_denied" } };
  }
  const cwd = workspaceRoot(workdir, ctx);
  if (!isPathAllowed(cwd, workdir, pathOptions)) {
    return { failure: { text: `Error: Working directory not allowed: ${cwd}`, code: "workdir_denied" } };
  }
  if (!existsSync(cwd)) {
    return { failure: { text: `Error: Working directory not found: ${cwd}`, code: "workdir_not_found" } };
  }
  return { cwd };
}
