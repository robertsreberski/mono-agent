import type { SecretPersistenceOutcome, InitFileChange } from "./types.js";
import type { InitMonoAgentFolderOptions, InitMonoAgentFolderResult } from "./scaffold-types.js";
import { lstat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { writeMonoAgentConfigJson } from "@mono-agent/config";

import { composeWizardPlan, defaultAnswers, humanizeAgentName } from "./wizard/answers.js";
import type { ComposeContext } from "./wizard-types.js";
import {
  initializeFirstRunManagedMemory,
  preflightFirstRunManagedMemory,
} from "./first-run-managed-memory.js";
import { assertManagedProjectSkillInitSafe } from "../skills/project-skills.js";
import { mergeSecretEnvFile, SecretEnvPersistenceRefusedError } from "./secret-env.js";
import {
  assertSafeScaffoldTarget,
  createMonoAgentConfigExclusively,
  createSafeScaffoldDirectory,
  ensureSafeScaffoldParent,
  identityTemplate,
  pathExists,
  removeCreatedConfigIfUnchanged,
} from "./scaffold-files.js";

const KNOWLEDGE_FILE_CANDIDATES = ["AGENTS.md", "CLAUDE.md", "README.md", "SOUL.md"];

/**
 * Non-destructively scaffolds a config-first mono-agent folder: a
 * `mono-agent.config.json` composed from the wizard answers (default scaffold when
 * none are supplied), an `IDENTITY.md` seeded from any knowledge files already in
 * the folder, the `.mono-agent/` working directories, and — when the composed plan
 * carries them — a `.env.example` and any capability files. Existing
 * scaffold/config files are never overwritten; reviewed secret persistence is
 * the deliberate exception that can transactionally replace `.env` and update
 * `.gitignore`. With `dryRun`, nothing is written and `created` reports what would
 * have been.
 */
export async function initMonoAgentFolder(
  options: InitMonoAgentFolderOptions = {},
): Promise<InitMonoAgentFolderResult> {
  const dir = resolve(options.dir ?? process.cwd());
  const dryRun = options.dryRun === true;
  const answers = options.answers ?? defaultAnswers();
  const created: string[] = [];
  const skipped: string[] = [];
  const changes: InitFileChange[] = [];

  await assertManagedProjectSkillInitSafe(dir);

  const ctx: ComposeContext = {
    dirBasename: basename(dir),
    skillsRootExists: await pathExists(join(dir, "skills")),
  };
  const composed = composeWizardPlan(answers, ctx);
  const plan = options.authPathForConfig === undefined || composed.configJson.providers?.piAuthPath !== undefined
    ? composed
    : { ...composed, configJson: { ...composed.configJson,
      providers: { ...composed.configJson.providers, piAuthPath: options.authPathForConfig } } };
  const configPath = join(dir, "mono-agent.config.json");
  await assertSafeScaffoldTarget(configPath, "config");
  const configAlreadyExists = await pathExists(configPath);
  if (options.requireConfigCreation === true && configAlreadyExists) {
    const error = new Error(`Refusing guided init because ${configPath} already exists.`) as NodeJS.ErrnoException;
    error.code = "EEXIST";
    throw error;
  }
  if (!configAlreadyExists) {
    await preflightFirstRunManagedMemory({
      agentRoot: dir,
      plan,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  }

  const knowledgeFiles: string[] = [];
  for (const candidate of KNOWLEDGE_FILE_CANDIDATES) {
    if (await pathExists(join(dir, candidate))) {
      knowledgeFiles.push(candidate);
    }
  }

  async function planFile(path: string, write: () => Promise<unknown>): Promise<boolean> {
    if (await pathExists(path)) {
      skipped.push(path);
      changes.push({ path, kind: "unchanged" });
      return false;
    }
    if (!dryRun) {
      await write();
    }
    created.push(path);
    changes.push({ path, kind: dryRun ? "planned-create" : "created" });
    return true;
  }

  const identityPath = join(dir, "IDENTITY.md");
  await assertSafeScaffoldTarget(identityPath, "identity");
  const identityCreated = await planFile(identityPath, () => writeFile(
    identityPath,
    identityTemplate(
      dir,
      answers.name?.trim() || humanizeAgentName(basename(dir)),
      answers.purpose?.trim() || "Help the operator work effectively in this folder.",
      knowledgeFiles,
    ),
    { flag: "wx" },
  ));

  for (const subdir of [join(dir, ".mono-agent", "artifacts"), join(dir, ".mono-agent", "workspace")]) {
    await assertSafeScaffoldTarget(subdir, "working directory");
    await ensureSafeScaffoldParent(dir, subdir, !dryRun);
    await planFile(subdir, async () => {
      await ensureSafeScaffoldParent(dir, subdir, true);
      await createSafeScaffoldDirectory(subdir);
    });
  }

  let configCreatedByThisInit = false;
  let configCreatedIdentity: { readonly dev: number; readonly ino: number } | undefined;
  if (options.requireConfigCreation === true) {
    if (dryRun) {
      if (await pathExists(configPath)) {
        throw new Error(`Refusing guided init because ${configPath} already exists.`);
      }
    } else {
      await createMonoAgentConfigExclusively(configPath, plan.configJson);
    }
    created.push(configPath);
    changes.push({ path: configPath, kind: dryRun ? "planned-create" : "created" });
    configCreatedByThisInit = !dryRun;
  } else {
    const configPlanned = await planFile(
      configPath,
      () => writeMonoAgentConfigJson({ path: configPath, patch: plan.configJson }),
    );
    configCreatedByThisInit = !dryRun && configPlanned;
  }
  if (configCreatedByThisInit) {
    const configStat = await lstat(configPath);
    configCreatedIdentity = { dev: configStat.dev, ino: configStat.ino };
  }

  const envExample = plan.envExample;
  if (typeof envExample === "string" && envExample.length > 0) {
    const envExamplePath = join(dir, ".env.example");
    await assertSafeScaffoldTarget(envExamplePath, "environment example");
    await planFile(envExamplePath, () => writeFile(envExamplePath, envExample, { flag: "wx" }));
  }

  const requestedSecrets = options.secretValues !== undefined && Object.keys(options.secretValues).length > 0;
  const requestedEnvSecurity = requestedSecrets || options.secureExistingDotenv === true;
  let secretPersistence: SecretPersistenceOutcome = { status: "not-requested", changed: false };
  if (requestedEnvSecurity) {
    const envPath = join(dir, ".env");
    try {
      const result = await mergeSecretEnvFile(envPath, options.secretValues ?? {}, {
        dryRun,
        secureExistingFile: options.secureExistingDotenv === true,
      });
      changes.push(...result.changes);
      for (const change of result.changes) {
        if (change.kind === "created" || change.kind === "planned-create") created.push(change.path);
        if (change.kind === "unchanged") skipped.push(change.path);
      }
      secretPersistence = {
        status: dryRun ? "planned" : "persisted",
        path: envPath,
        changed: result.valuesChanged > 0,
      };
    } catch (error) {
      if (!(error instanceof SecretEnvPersistenceRefusedError)) throw error;
      secretPersistence = {
        status: "refused",
        path: envPath,
        changed: false,
        reason: error.code,
        detail: error.message,
      };
    }
  }

  for (const file of plan.files) {
    const filePath = resolve(dir, file.path);
    await ensureSafeScaffoldParent(dir, filePath, !dryRun);
    await assertSafeScaffoldTarget(filePath, `generated capability file ${file.path}`);
    await planFile(filePath, async () => {
      await ensureSafeScaffoldParent(dir, filePath, true);
      await writeFile(filePath, file.contents, { flag: "wx" });
    });
  }

  if (configCreatedByThisInit) {
    try {
      const initializedMemory = await initializeFirstRunManagedMemory({
        agentRoot: dir,
        plan,
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.firstRunManagedMemoryHooks === undefined
          ? {}
          : { hooks: options.firstRunManagedMemoryHooks }),
      });
      if (initializedMemory.initialized && initializedMemory.root !== undefined) {
        created.push(initializedMemory.root);
        changes.push({ path: initializedMemory.root, kind: "created" });
      }
    } catch (error) {
      if (configCreatedIdentity !== undefined) {
        await removeCreatedConfigIfUnchanged(configPath, configCreatedIdentity, `${JSON.stringify(plan.configJson, null, 2)}\n`);
      }
      throw error;
    }
  }

  return {
    dir,
    configPath,
    identityPath,
    identityRole: {
      path: identityPath,
      section: "## Role",
      status: identityCreated ? (dryRun ? "planned-create" : "created") : "preserved",
    },
    created,
    skipped,
    knowledgeFiles,
    dryRun,
    secretsPersisted: !dryRun && secretPersistence.status === "persisted" && secretPersistence.changed,
    changes,
    secretPersistence,
    plan,
  };
}
