import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { writeMonoAgentConfigJson } from "@mono-agent/config";
import type { MonoAgentConfigJson } from "@mono-agent/config";

export interface InitMonoAgentFolderOptions {
  /** Folder the agent is constructed in. Defaults to process.cwd(). */
  readonly dir?: string;
  /** Primary runtime model reference written into the config. */
  readonly model?: string;
  /** Ordered backup model references written into the config. */
  readonly fallbackModels?: readonly string[];
  /** Memory strategy: omitted = no memory section. */
  readonly memory?: "markdown" | "journal";
}

export interface InitMonoAgentFolderResult {
  readonly dir: string;
  readonly configPath: string;
  readonly identityPath: string;
  /** Files and directories created by this run (absolute paths). */
  readonly created: readonly string[];
  /** Files that already existed and were left untouched (absolute paths). */
  readonly skipped: readonly string[];
  /** Existing knowledge files the generated identity references. */
  readonly knowledgeFiles: readonly string[];
}

const DEFAULT_MODEL = "claude:claude-sonnet-4-6";
const KNOWLEDGE_FILE_CANDIDATES = ["AGENTS.md", "CLAUDE.md", "README.md", "SOUL.md"];

/**
 * Non-destructively scaffolds a config-first mono-agent folder: a minimal
 * `mono-agent.config.json` (webhook enabled as the zero-credential smoke
 * channel), an `IDENTITY.md` seeded from any knowledge files already in the
 * folder, and the `.mono-agent/` working directories. Existing files are
 * never overwritten.
 */
export async function initMonoAgentFolder(
  options: InitMonoAgentFolderOptions = {},
): Promise<InitMonoAgentFolderResult> {
  const dir = resolve(options.dir ?? process.cwd());
  const created: string[] = [];
  const skipped: string[] = [];

  const knowledgeFiles: string[] = [];
  for (const candidate of KNOWLEDGE_FILE_CANDIDATES) {
    if (await pathExists(join(dir, candidate))) {
      knowledgeFiles.push(candidate);
    }
  }

  const identityPath = join(dir, "IDENTITY.md");
  if (await pathExists(identityPath)) {
    skipped.push(identityPath);
  } else {
    await writeFile(identityPath, identityTemplate(dir, knowledgeFiles), { flag: "wx" });
    created.push(identityPath);
  }

  for (const subdir of [join(dir, ".mono-agent", "artifacts"), join(dir, ".mono-agent", "workspace")]) {
    if (await pathExists(subdir)) {
      skipped.push(subdir);
    } else {
      await mkdir(subdir, { recursive: true });
      created.push(subdir);
    }
  }

  const configPath = join(dir, "mono-agent.config.json");
  if (await pathExists(configPath)) {
    skipped.push(configPath);
  } else {
    const skillsRootExists = await pathExists(join(dir, "skills"));
    await writeMonoAgentConfigJson({ path: configPath, patch: configTemplate(dir, options, skillsRootExists) });
    created.push(configPath);
  }

  return { dir, configPath, identityPath, created, skipped, knowledgeFiles };
}

function configTemplate(
  dir: string,
  options: InitMonoAgentFolderOptions,
  skillsRootExists: boolean,
): MonoAgentConfigJson {
  const fallbackModels = (options.fallbackModels ?? []).filter((entry) => entry.trim().length > 0);
  return {
    runtime: {
      model: options.model ?? DEFAULT_MODEL,
      ...(fallbackModels.length === 0 ? {} : { fallbackModels }),
      maxTurns: 8,
      workspace: ".",
    },
    context: {
      identityPath: "./IDENTITY.md",
      selectedSkills: [],
      ...(skillsRootExists ? { skillsRoot: "./skills" } : {}),
    },
    ...(options.memory === undefined
      ? {}
      : {
          memory: {
            mode: options.memory,
            path: options.memory === "journal" ? "./.mono-agent/memory" : "./MEMORY.md",
            writeMode: "append-host-summary" as const,
          },
        }),
    tools: {
      allowedTools: [],
      disallowedTools: [],
    },
    artifacts: {
      dir: "./.mono-agent/artifacts",
    },
    traceability: {
      registryDir: "./.mono-agent/trace-sources",
      sourceLabel: `Mono Agent (${basename(dir)})`,
    },
    webhook: {
      enabled: true,
    },
  } as MonoAgentConfigJson;
}

function identityTemplate(dir: string, knowledgeFiles: readonly string[]): string {
  const knowledgeSection = knowledgeFiles.length === 0
    ? "This folder starts empty; describe the agent's purpose and boundaries here."
    : [
        "This folder already carries knowledge the agent must read and respect:",
        "",
        ...knowledgeFiles.map((file) => `- \`${file}\``),
      ].join("\n");

  return `# Identity

You are the mono agent constructed in \`${basename(dir)}\`.

## Role

Describe what this agent is for in one or two sentences.

## Knowledge

${knowledgeSection}

## Boundaries

- Work inside this folder unless the user explicitly widens the workspace.
- Confirm before destructive changes.
- Fail honestly: report runtime or tool errors instead of inventing results.
`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
