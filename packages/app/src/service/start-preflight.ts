import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { validateMonoAgentFolder } from "../doctor/doctor.js";
import type { ValidationReport } from "../doctor/doctor-types.js";
import type { ParsedCliArgs } from "../cli/cli-args.js";
/**
 * Outcome of the start/restart preflight. `code` is the process exit status to
 * return when refusing: 2 for a missing config file (a usage problem, matching
 * the arg-parse convention) and 1 for a config that loads but has errors.
 */
export type PreflightResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 2; readonly kind: "missing-config"; readonly configPath: string }
  | { readonly ok: false; readonly code: 1; readonly kind: "validation"; readonly report: ValidationReport };

/**
 * Gate for `start`/`restart`: refuse unless the directory has a present, valid
 * config. First the config FILE must exist (env vars alone are not enough — a
 * folder without a config is not a configured agent). Then run the structural
 * validation with `liveness:false` (network probes only yield `waiting`, never
 * `error`, so skipping them keeps the verdict while avoiding bounded network
 * timeouts) and refuse on any `error` section. `waiting` (e.g. Ollama not up yet) is runtime-soft and never blocks.
 */
export async function ensureStartable(
  args: Pick<ParsedCliArgs, "configPath">,
  env: Record<string, string | undefined> = process.env,
  options: {
    readonly cwd?: string;
    readonly configPath?: string;
    readonly verifiedRuntimeProvenanceDetail?: string;
  } = {},
): Promise<PreflightResult> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ?? resolve(cwd, args.configPath ?? "mono-agent.config.json");
  if (!(await pathExists(configPath))) {
    return { ok: false, code: 2, kind: "missing-config", configPath };
  }
  const report = await validateMonoAgentFolder({
    env,
    cwd,
    configPath,
    liveness: false,
    ignoreDuplicateKeys: true,

    ...(options.verifiedRuntimeProvenanceDetail === undefined
      ? {}
      : { verifiedRuntimeProvenanceDetail: options.verifiedRuntimeProvenanceDetail }),
  });
  if (!report.structurallyValid) {
    return { ok: false, code: 1, kind: "validation", report };
  }
  return { ok: true };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
