#!/usr/bin/env node
import { startMonoAgentTui } from "@mono-agent/tui";

import {
  buildDownloadsCuratorConfig,
  createDownloadsCuratorResponder,
  writeDownloadsCuratorDeploymentFiles,
} from "./downloads-curator.js";

export interface ParsedDownloadsCuratorArgs {
  readonly downloadsRoot?: string;
  readonly stateDir?: string;
  readonly model?: string;
  readonly conversationId?: string;
  readonly help: boolean;
}

export async function startDownloadsCuratorCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseDownloadsCuratorArgs(argv);
  if ("error" in parsed) {
    exitWithError(parsed.error);
  }
  if (parsed.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  if (process.stdin.isTTY !== true) {
    exitWithError("downloads curator TUI needs an interactive terminal");
  }

  const cwd = process.cwd();
  const files = await writeDownloadsCuratorDeploymentFiles({
    cwd,
    ...(parsed.downloadsRoot === undefined ? {} : { downloadsRoot: parsed.downloadsRoot }),
    ...(parsed.stateDir === undefined ? {} : { stateDir: parsed.stateDir }),
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
  });
  const config = buildDownloadsCuratorConfig({
    cwd,
    ...(parsed.downloadsRoot === undefined ? {} : { downloadsRoot: parsed.downloadsRoot }),
    stateDir: files.stateDir,
    identityPath: files.identityPath,
    artifactDir: files.artifactDir,
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
  });
  const responder = await createDownloadsCuratorResponder({
    config,
  });
  const handle = startMonoAgentTui({
    responder,
    title: "Downloads Curator",
    subtitle: config.downloadsRoot,
    conversationId: parsed.conversationId ?? "downloads-curator",
    config: {
      path: files.configPath,
      cwd,
      env: { ...process.env },
    },
    initialStatusText: "curating downloads",
  });
  await handle.waitUntilExit();
}

export function parseDownloadsCuratorArgs(argv: readonly string[]): ParsedDownloadsCuratorArgs | { readonly error: string } {
  let downloadsRoot: string | undefined;
  let stateDir: string | undefined;
  let model: string | undefined;
  let conversationId: string | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--downloads") {
      const value = argv[index + 1];
      if (value === undefined) {
        return { error: "--downloads requires a path" };
      }
      downloadsRoot = value;
      index++;
      continue;
    }
    if (arg === "--state-dir") {
      const value = argv[index + 1];
      if (value === undefined) {
        return { error: "--state-dir requires a path" };
      }
      stateDir = value;
      index++;
      continue;
    }
    if (arg === "--model") {
      const value = argv[index + 1];
      if (value === undefined) {
        return { error: "--model requires a value" };
      }
      model = value;
      index++;
      continue;
    }
    if (arg === "--conversation") {
      const value = argv[index + 1];
      if (value === undefined) {
        return { error: "--conversation requires an id" };
      }
      conversationId = value;
      index++;
      continue;
    }
    return { error: `unknown argument: ${arg ?? ""}` };
  }

  return {
    help,
    ...(downloadsRoot === undefined ? {} : { downloadsRoot }),
    ...(stateDir === undefined ? {} : { stateDir }),
    ...(model === undefined ? {} : { model }),
    ...(conversationId === undefined ? {} : { conversationId }),
  };
}

function exitWithError(message: string): never {
  process.stderr.write(`downloads-curator: ${message}\n`);
  process.stderr.write(HELP_TEXT);
  process.exit(2);
}

const HELP_TEXT = `Usage: pnpm run demo:downloads -- [options]

Starts a local TUI agent scoped to the Downloads folder.

Options:
  --downloads <path>       Downloads folder to curate (default: ~/Downloads)
  --state-dir <path>       Ignored local state dir (default: ./.mono-agent/downloads-curator)
  --model <model>          Codex model name (default: gpt-5.5)
  --conversation <id>      TUI conversation id
  -h, --help               Show this help
`;

if (isDirectRun()) {
  void startDownloadsCuratorCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}

function isDirectRun(): boolean {
  return process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/gu, "/"));
}
