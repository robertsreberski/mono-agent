import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { AgentResponderLike } from "../agent/responder.js";

export interface ParsedArgs {
  readonly responder?: string;
  readonly config?: string;
  readonly title?: string;
  readonly conversationId?: string;
  readonly help: boolean;
}

export type ParseArgsResult = ParsedArgs | { readonly error: string };

/**
 * Parse the `mono-agent-tui` argv (already stripped of `node` + script path).
 * Pure and side-effect free so it can be unit-tested without booting the CLI.
 */
export function parseArgs(argv: readonly string[]): ParseArgsResult {
  let help = false;
  let responder: string | undefined;
  let config: string | undefined;
  let title: string | undefined;
  let conversationId: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "-h" || flag === "--help") {
      help = true;
      continue;
    }
    if (flag === "--responder") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { error: "--responder requires a path" };
      }
      responder = value;
      i++;
      continue;
    }
    if (flag === "--config") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { error: "--config requires a path" };
      }
      config = value;
      i++;
      continue;
    }
    if (flag === "--title") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { error: "--title requires a value" };
      }
      title = value;
      i++;
      continue;
    }
    if (flag === "--conversation") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { error: "--conversation requires a value" };
      }
      conversationId = value;
      i++;
      continue;
    }
    return { error: `unknown argument: ${String(flag)}` };
  }

  const result: ParsedArgs = {
    help,
    ...(responder === undefined ? {} : { responder }),
    ...(config === undefined ? {} : { config }),
    ...(title === undefined ? {} : { title }),
    ...(conversationId === undefined ? {} : { conversationId }),
  };
  return result;
}

export const HELP_TEXT = `Usage: mono-agent-tui [options]

  --responder <file>      Path to an ESM module that default-exports an
                          AgentResponderLike, or exports
                          createResponder(env, cwd, configJson).
  --config <path>         Path to mono-agent.config.json. When set, the
                          Config pane is enabled and the file is forwarded
                          to createResponder().
  --conversation <id>     Conversation id passed to the responder
                          (default: tui-local).
  --title <text>          Header title (default: "Agent").
  -h, --help              Show this help and exit.

The TUI is a communication adapter — it does not boot a harness on its
own. Hosts that want a runnable TUI in their own demo should call
startMonoAgentTui() from their own bin and pass an AgentResponderLike
backed by createAgentResponder({ harness }).
`;

export function exitWithError(message: string): never {
  process.stderr.write(`mono-agent-tui: ${message}\n`);
  process.stderr.write(HELP_TEXT);
  process.exit(2);
}

/**
 * Resolve and import an `AgentResponderLike` from a host-supplied module.
 * Accepts either a `createResponder(env, cwd, configPath)` factory export or
 * a default-exported responder. Exits the process with a 2 on user error.
 */
export async function loadResponder(
  responderPath: string,
  configPath: string | undefined,
): Promise<AgentResponderLike> {
  const absolute = resolve(process.cwd(), responderPath);
  if (!existsSync(absolute)) {
    exitWithError(`responder file not found: ${absolute}`);
  }
  const moduleUrl = pathToFileURL(absolute).href;
  const moduleExports = (await import(moduleUrl)) as {
    default?: AgentResponderLike;
    createResponder?: (
      env: Record<string, string | undefined>,
      cwd: string,
      configPath: string | undefined,
    ) => Promise<AgentResponderLike> | AgentResponderLike;
  };

  if (typeof moduleExports.createResponder === "function") {
    const result = await moduleExports.createResponder(
      { ...process.env },
      process.cwd(),
      configPath,
    );
    return result;
  }
  if (
    moduleExports.default !== undefined &&
    typeof moduleExports.default.respond === "function"
  ) {
    return moduleExports.default;
  }
  exitWithError(
    `module ${absolute} did not export a default AgentResponderLike or createResponder().`,
  );
}
