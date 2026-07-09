import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { writeMonoAgentConfigJson } from "@mono-agent/config";

import { composeWizardPlan, defaultAnswers } from "./wizard/answers.js";
import type { ComposeContext, WizardAnswers, WizardPlan } from "./wizard/answers.js";

export interface InitMonoAgentFolderOptions {
  /** Folder the agent is constructed in. Defaults to process.cwd(). */
  readonly dir?: string;
  /** The composed capability selection; omitted → {@link defaultAnswers} (the silent default scaffold). */
  readonly answers?: WizardAnswers;
  /** Plan the scaffold and report it without writing anything. */
  readonly dryRun?: boolean;
  /** Required capability secrets held only for this init run; never written to config JSON. */
  readonly secretValues?: Readonly<Record<string, string>>;
}

export interface InitMonoAgentFolderResult {
  readonly dir: string;
  readonly configPath: string;
  readonly identityPath: string;
  /** Files and directories created (or, with dryRun, that would be created). */
  readonly created: readonly string[];
  /** Files that already existed and were left untouched (absolute paths). */
  readonly skipped: readonly string[];
  /** Existing knowledge files the generated identity references. */
  readonly knowledgeFiles: readonly string[];
  /** True when nothing was written because dryRun was set. */
  readonly dryRun: boolean;
  /** True when this init securely merged in-run required secrets into `.env`. */
  readonly secretsPersisted: boolean;
  /** The composed plan (config, secrets, env example, files, validate expectations). */
  readonly plan: WizardPlan;
}

const KNOWLEDGE_FILE_CANDIDATES = ["AGENTS.md", "CLAUDE.md", "README.md", "SOUL.md"];

/**
 * Non-destructively scaffolds a config-first mono-agent folder: a
 * `mono-agent.config.json` composed from the wizard answers (default scaffold when
 * none are supplied), an `IDENTITY.md` seeded from any knowledge files already in
 * the folder, the `.mono-agent/` working directories, and — when the composed plan
 * carries them — a `.env.example` and any capability files. Existing files are
 * never overwritten. With `dryRun`, nothing is written and `created` reports what
 * would have been.
 */
export async function initMonoAgentFolder(
  options: InitMonoAgentFolderOptions = {},
): Promise<InitMonoAgentFolderResult> {
  const dir = resolve(options.dir ?? process.cwd());
  const dryRun = options.dryRun === true;
  const created: string[] = [];
  const skipped: string[] = [];

  const knowledgeFiles: string[] = [];
  for (const candidate of KNOWLEDGE_FILE_CANDIDATES) {
    if (await pathExists(join(dir, candidate))) {
      knowledgeFiles.push(candidate);
    }
  }

  async function planFile(path: string, write: () => Promise<unknown>): Promise<void> {
    if (await pathExists(path)) {
      skipped.push(path);
      return;
    }
    if (!dryRun) {
      await write();
    }
    created.push(path);
  }

  const identityPath = join(dir, "IDENTITY.md");
  await planFile(identityPath, () => writeFile(identityPath, identityTemplate(dir, knowledgeFiles), { flag: "wx" }));

  for (const subdir of [join(dir, ".mono-agent", "artifacts"), join(dir, ".mono-agent", "workspace")]) {
    await planFile(subdir, () => mkdir(subdir, { recursive: true }));
  }

  const ctx: ComposeContext = {
    dirBasename: basename(dir),
    skillsRootExists: await pathExists(join(dir, "skills")),
  };
  const answers = options.answers ?? defaultAnswers();
  const plan = composeWizardPlan(answers, ctx);

  const configPath = join(dir, "mono-agent.config.json");
  await planFile(configPath, () => writeMonoAgentConfigJson({ path: configPath, patch: plan.configJson }));

  const envExample = plan.envExample;
  if (typeof envExample === "string" && envExample.length > 0) {
    const envExamplePath = join(dir, ".env.example");
    await planFile(envExamplePath, () => writeFile(envExamplePath, envExample, { flag: "wx" }));
  }

  const secretsPersisted = options.secretValues !== undefined && Object.keys(options.secretValues).length > 0;
  if (secretsPersisted) {
    const envPath = join(dir, ".env");
    if (!dryRun) {
      await mergeSecretEnvFile(envPath, options.secretValues);
    }
    created.push(envPath);
  }

  for (const file of plan.files) {
    const filePath = join(dir, file.path);
    await planFile(filePath, async () => {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, file.contents, { flag: "wx" });
    });
  }

  return { dir, configPath, identityPath, created, skipped, knowledgeFiles, dryRun, secretsPersisted, plan };
}

/**
 * Merge new required secrets into an existing dotenv file without replacing a
 * non-empty operator value or discarding comments. Values are quoted so shell
 * metacharacters stay data, and the finished file is owner-readable only.
 */
export async function mergeSecretEnvFile(path: string, secretValues: Readonly<Record<string, string>>): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const lines = existing.length === 0 ? [] : existing.split(/\r?\n/u);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const [name, value] of Object.entries(secretValues)) {
    const matcher = new RegExp(`^(\\s*(?:export\\s+)?${escapeRegExp(name)}\\s*=)(.*)$`, "u");
    const index = lines.findIndex((line) => matcher.test(line));
    const rendered = `${name}=${JSON.stringify(value)}`;
    if (index === -1) {
      lines.push(rendered);
      continue;
    }
    const currentLine = lines[index];
    if (currentLine === undefined) continue;
    const match = matcher.exec(currentLine);
    const currentValue = (match?.[2] ?? "").trim();
    if (currentValue.length === 0) lines[index] = rendered;
  }
  await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
