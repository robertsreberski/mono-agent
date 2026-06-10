import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import {
  createConfiguredAgentResponder,
} from "@mono-agent/agent-host";
import type { MonoAgentConfigJson } from "@mono-agent/config";
import type {
  MonoRuntimeLike,
  RuntimeModelReference,
} from "@mono-agent/runtime-adapter";
import { parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";

export const DOWNLOADS_CURATOR_SOURCE_ID = "downloads-curator";
export const DEFAULT_DOWNLOADS_CURATOR_MODEL = "gpt-5.5";
export const DEFAULT_DOWNLOADS_CURATOR_CONFIG_PATH = ".mono-agent/downloads-curator/downloads-curator.config.json";
export const DEFAULT_DOWNLOADS_CURATOR_STATE_DIR = ".mono-agent/downloads-curator";

export interface DownloadsCuratorConfigInput {
  readonly cwd: string;
  readonly downloadsRoot?: string;
  readonly stateDir?: string;
  readonly identityPath?: string;
  readonly artifactDir?: string;
  readonly traceRegistryDir?: string;
  readonly model?: string;
}

export interface DownloadsCuratorResponderOptions {
  readonly config: DownloadsCuratorConfig;
  readonly runtime?: MonoRuntimeLike;
  readonly createRunId?: () => string;
}

export interface DownloadsCuratorConfig {
  readonly mono: import("@mono-agent/config").MonoAgentConfig;
  readonly downloadsRoot: string;
  readonly stateDir: string;
  readonly identityPath: string;
  readonly artifactDir: string;
  readonly model: RuntimeModelReference;
}

export interface DownloadsCuratorDeploymentOptions {
  readonly cwd: string;
  readonly downloadsRoot?: string;
  readonly stateDir?: string;
  readonly configPath?: string;
  readonly model?: string;
}

export interface DownloadsCuratorDeploymentFiles {
  readonly configPath: string;
  readonly identityPath: string;
  readonly stateDir: string;
  readonly artifactDir: string;
}

export function buildDownloadsCuratorConfig(input: DownloadsCuratorConfigInput): DownloadsCuratorConfig {
  const cwd = resolve(input.cwd);
  const downloadsRoot = resolve(input.downloadsRoot ?? join(homedir(), "Downloads"));
  const stateDir = resolve(cwd, input.stateDir ?? DEFAULT_DOWNLOADS_CURATOR_STATE_DIR);
  const identityPath = resolve(input.identityPath ?? join(stateDir, "IDENTITY.md"));
  const artifactDir = resolve(input.artifactDir ?? join(stateDir, "artifacts"));
  const traceRegistryDir = resolve(input.traceRegistryDir ?? join(stateDir, "trace-sources"));
  const model = parseMonoRuntimeModelReference(`codex:${input.model?.trim() || DEFAULT_DOWNLOADS_CURATOR_MODEL}`);

  return {
    mono: {
      runtime: {
        model,
        executionMode: "cli",
        maxTurns: 8,
        workspace: downloadsRoot,
      },
      context: {
        identityPath,
        selectedSkills: [],
      },
      tools: {
        allowedTools: ["downloads_list", "downloads_create_proposal", "downloads_apply_proposal"],
        disallowedTools: ["Bash", "Edit", "Write"],
      },
      artifacts: {
        dir: artifactDir,
      },
      traceability: {
        registryDir: traceRegistryDir,
        sourceId: DOWNLOADS_CURATOR_SOURCE_ID,
        sourceLabel: "Downloads Curator",
        heartbeatMs: 10_000,
        staleAfterMs: 30_000,
      },
    },
    downloadsRoot,
    stateDir,
    identityPath,
    artifactDir,
    model,
  };
}

export function createDownloadsCuratorResponder(options: DownloadsCuratorResponderOptions): AgentResponder {
  return createConfiguredAgentResponder({
    config: options.config.mono,
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
    model: options.config.model,
    executionMode: "cli",
    ...(options.createRunId === undefined ? {} : { createRunId: options.createRunId }),
    runtimeOptions: {
      sandbox: "read-only",
      approvalPolicy: "never",
    },
    runtimeOptionsForRequest: ({ request }) => ({
      runtimeOptions: {
        sandbox: "read-only",
        approvalPolicy: "never",
        mcpServers: {
          downloads_curator: {
            type: "stdio",
            command: process.execPath,
            args: [fileURLToPath(new URL("./mcp-server.js", import.meta.url))],
            env: {
              DOWNLOADS_CURATOR_ROOT: options.config.downloadsRoot,
              DOWNLOADS_CURATOR_STATE_DIR: options.config.stateDir,
              DOWNLOADS_CURATOR_CURRENT_USER_MESSAGE: request.userMessage,
            },
          },
        },
      },
    }),
  });
}

export function buildDownloadsCuratorConfigJson(input: DownloadsCuratorConfigInput): MonoAgentConfigJson {
  const config = buildDownloadsCuratorConfig(input);
  return {
    runtime: {
      model: config.model.reference ?? `codex:${config.model.model}`,
      executionMode: "cli",
      maxTurns: config.mono.runtime.maxTurns,
      workspace: config.downloadsRoot,
    },
    context: {
      identityPath: config.identityPath,
      selectedSkills: [],
    },
    tools: {
      allowedTools: [...config.mono.tools.allowedTools],
      disallowedTools: [...config.mono.tools.disallowedTools],
    },
    artifacts: {
      dir: config.artifactDir,
    },
    traceability: {
      registryDir: config.mono.traceability.registryDir,
      sourceId: DOWNLOADS_CURATOR_SOURCE_ID,
      sourceLabel: "Downloads Curator",
      heartbeatMs: 10_000,
      staleAfterMs: 30_000,
    },
  };
}

export async function writeDownloadsCuratorDeploymentFiles(
  options: DownloadsCuratorDeploymentOptions,
): Promise<DownloadsCuratorDeploymentFiles> {
  const cwd = resolve(options.cwd);
  const stateDir = resolve(cwd, options.stateDir ?? DEFAULT_DOWNLOADS_CURATOR_STATE_DIR);
  const configPath = resolve(cwd, options.configPath ?? DEFAULT_DOWNLOADS_CURATOR_CONFIG_PATH);
  const identityPath = join(stateDir, "IDENTITY.md");
  const artifactDir = join(stateDir, "artifacts");
  const config = buildDownloadsCuratorConfigJson({
    cwd,
    ...(options.downloadsRoot === undefined ? {} : { downloadsRoot: options.downloadsRoot }),
    stateDir,
    identityPath,
    artifactDir,
    ...(options.model === undefined ? {} : { model: options.model }),
  });

  await Promise.all([
    mkdir(dirname(configPath), { recursive: true }),
    mkdir(stateDir, { recursive: true }),
    mkdir(artifactDir, { recursive: true }),
  ]);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await writeFileIfMissing(identityPath, DOWNLOADS_CURATOR_IDENTITY);

  return {
    configPath,
    identityPath,
    stateDir,
    artifactDir,
  };
}

async function writeFileIfMissing(path: string, content: string): Promise<void> {
  try {
    await access(path);
  } catch {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}

const DOWNLOADS_CURATOR_IDENTITY = `# Downloads Curator

You are a local Downloads folder curator. Your workspace is the user's Downloads directory.

Inspect before recommending. Prefer concise, numbered recommendations grouped by action. You may use only the Downloads curator tools for filesystem actions.

Never claim an action was applied unless the tool result says it was applied. Never permanently delete files. Trash means moving to the user's Trash folder.

For cleanup:
- Identify active downloads and leave them alone.
- Prefer organizing useful files into _Curated category folders.
- Prefer Trash only for obvious duplicates, installers, temporary files, or files the user explicitly wants removed.
- Before applying changes, call downloads_create_proposal and show the exact approval phrase.
- Only call downloads_apply_proposal after the user's latest TUI message exactly matches the approval phrase.
`;
