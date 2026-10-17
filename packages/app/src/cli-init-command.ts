import process from "node:process";

import type { ParsedCliArgs } from "./cli-args.js";
import { runGuidedInit } from "./setup/guided-init.js";
import { runFlagsInit } from "./setup/flags-init.js";
import type { RunInitEnvironmentContext } from "./setup/types.js";

export async function runInit(args: ParsedCliArgs, environment: RunInitEnvironmentContext): Promise<number> {
  const cwd = process.cwd();
  // On an interactive TTY with no overriding flags, walk the step-by-step wizard;
  // any flag (or a piped/non-TTY invocation) takes the silent default/preset path.
  const wantsWizard = shouldRunInitWizard(args, process.stdin.isTTY === true, process.stdout.isTTY === true);
  if (wantsWizard) {
    return await runGuidedInit(args, environment, cwd);
  }
  return await runFlagsInit(args, environment, cwd);
}

export function shouldRunInitWizard(args: ParsedCliArgs, stdinIsTty: boolean, stdoutIsTty: boolean): boolean {
  if (!stdinIsTty || !stdoutIsTty || args.command !== "init" || args.positionals.length > 0) {
    return false;
  }
  if (args.force || args.foreground || args.follow || args.all || args.dryRun || args.includeMemory) {
    return false;
  }
  // A bare parsed init has only these required/default keys. Treat every
  // optional key—current or future—as an overriding flag so the documented
  // "any flag is scaffold-only" contract cannot silently drift again.
  const bareKeys = new Set([
    "command",
    "positionals",
    "force",
    "foreground",
    "follow",
    "all",
    "dryRun",
    "includeMemory",
  ]);
  return Object.keys(args).every((key) => bareKeys.has(key));
}
