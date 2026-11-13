#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { guardNodeVersion } from "./node-version-guard.js";

/** Lightweight facade: no configuration or native dependency imports before dispatch. */
export async function runCli(argv: readonly string[]): Promise<number> {
  if (!guardNodeVersion()) return 1;
  if (argv[0] === "preflight" || (argv[0] === "help" && argv[1] === "preflight")) {
    const { runHostPreflight } = await import("./cli/commands/cli-host-preflight-command.js");
    return runHostPreflight(argv[0] === "help" ? ["--help", ...argv.slice(2)] : argv.slice(1));
  }
  const router = await import("./cli/cli-commands.js");
  return router.runCli(argv);
}

function isExecutable(): boolean {
  try { return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}
if (isExecutable()) {
  runCli(process.argv.slice(2)).then((code) => { if (code !== 0) process.exitCode = code; }).catch(async (error: unknown) => {
    const ui = await import("./cli/ui.js");
    process.stderr.write(`${ui.style.red("✗")} ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
