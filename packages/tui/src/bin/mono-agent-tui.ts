#!/usr/bin/env node
import { resolve } from "node:path";

import { startMonoAgentTui } from "../runtime/start.js";
import type { TuiAppConfigPaneOptions } from "../components/TuiApp.js";
import { exitWithError, HELP_TEXT, loadResponder, parseArgs } from "./cli.js";

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    exitWithError(parsed.error);
  }
  if (parsed.help) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }
  if (parsed.responder === undefined) {
    exitWithError("--responder is required (the TUI does not boot a harness on its own)");
  }
  if (process.stdin.isTTY !== true) {
    exitWithError("stdin is not a TTY; mono-agent-tui needs an interactive terminal");
  }

  const responder = await loadResponder(parsed.responder, parsed.config);
  const configPane: TuiAppConfigPaneOptions | undefined =
    parsed.config !== undefined
      ? { path: resolve(process.cwd(), parsed.config), cwd: process.cwd(), env: { ...process.env } }
      : undefined;

  const handle = startMonoAgentTui({
    responder,
    ...(configPane === undefined ? {} : { config: configPane }),
    ...(parsed.title === undefined ? {} : { title: parsed.title }),
    ...(parsed.conversationId === undefined
      ? {}
      : { conversationId: parsed.conversationId }),
  });

  await handle.waitUntilExit();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`mono-agent-tui: ${message}\n`);
  process.exit(1);
});
