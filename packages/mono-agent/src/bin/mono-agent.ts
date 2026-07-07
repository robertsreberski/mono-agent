#!/usr/bin/env node
import { spawn } from "node:child_process";

import { resolveAgentAppCliEntry } from "../resolve-agent-app-cli.js";

/**
 * Bare `mono-agent` bin. It owns no CLI logic of its own: it locates
 * `@mono-agent/agent-app`'s `mono-agent` CLI entry and runs it in a child process
 * with the same args and inherited stdio, so behaviour is byte-identical to
 * calling `@mono-agent/agent-app`'s own bin directly.
 *
 * Why a child process instead of importing `runCli` in-process: agent-app's
 * `dist/cli.js` auto-runs the CLI when it detects it is the entry module (by
 * `argv[1]` basename), which is exactly what a bin symlink named `mono-agent`
 * looks like under an npm/npx global install. Importing it here would risk a
 * double-run (the auto-run guard AND an explicit call) on some install layouts,
 * and avoiding that would require agent-app to grow a side-effect-free entry —
 * widening its surface. Spawning agent-app's real bin keeps this package pure
 * delegation with zero agent-app changes and one deterministic execution path.
 */
const cliEntry = resolveAgentAppCliEntry();
const child = spawn(process.execPath, [cliEntry, ...process.argv.slice(2)], { stdio: "inherit" });

const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
for (const signal of forwardedSignals) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}

child.on("error", (error) => {
  process.stderr.write(`mono-agent: failed to launch the @mono-agent/agent-app CLI: ${error.message}\n`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal !== null) {
    // Re-raise the terminating signal so the parent's exit status reflects it.
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
