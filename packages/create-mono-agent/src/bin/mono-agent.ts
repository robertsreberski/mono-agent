#!/usr/bin/env node
import { spawn } from "node:child_process";

import { guardNodeVersion } from "@mono-agent/app/node-version-guard";

/**
 * Delegating bin for the `create-mono-agent` installer. Both of its bin names
 * (`create-mono-agent` and `mono-agent`) point here. It owns no CLI logic of its
 * own beyond basename-aware installer routing: it locates
 * `@mono-agent/app`'s `mono-agent` CLI entry and runs it in a child process
 * with normalized args and inherited stdio. After that routing, behaviour —
 * output, interactive shutdown, and exit status — is byte-identical to calling
 * `@mono-agent/app`'s own bin directly.
 *
 * The built-in-only app Node guard runs before resolver/delegator imports and
 * before spawning. Spawning app's guarded executable keeps one deterministic
 * execution path and preserves the installed bin paths and signal behavior.
 *
 * Signal/exit fidelity is delegated to `delegateSignals` (see there): the child
 * shares this process group, so Ctrl-C already reaches it; the shim must NOT
 * re-forward group-delivered signals (that would hard-kill a child mid-shutdown),
 * only relay a targeted SIGTERM, and mirror the child's exit code/signal exactly.
 */
if (guardNodeVersion()) {
  const { delegatedCliArgs, delegateSignals } = await import("../delegate.js");
  const { resolveAgentAppCliEntry } = await import("../resolve-agent-app-cli.js");
  const cliEntry = resolveAgentAppCliEntry();
  const args = delegatedCliArgs(process.argv[1], process.argv.slice(2));
  const child = spawn(process.execPath, [cliEntry, ...args], { stdio: "inherit" });
  delegateSignals(child, process);
}
