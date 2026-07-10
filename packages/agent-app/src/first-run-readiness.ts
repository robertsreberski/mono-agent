import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseEnv } from "node:util";

import type { ValidationReport } from "./doctor.js";
import { validateMonoAgentFolder } from "./doctor.js";
import type { SecretPersistenceOutcome } from "./init.js";
import { piAuthPathForSetup } from "./provider-setup.js";
import type { WizardPlan } from "./wizard/answers.js";

export type CliEnvironment = Readonly<Record<string, string | undefined>>;

export interface CliDotenvSnapshot {
  readonly env: Readonly<Record<string, string>>;
  /** Opaque content + mode fingerprint; never contains a plaintext dotenv value. */
  readonly fingerprint: string;
}

export interface CliConfigSnapshot {
  /** Exact UTF-8 bytes read from the regular config file. Config never contains persisted secrets. */
  readonly contents: string;
  readonly digest: string;
  /** Content plus file identity/mode fingerprint used to detect edits and replacement. */
  readonly fingerprint: string;
}

let exactProcessEnvironmentTail: Promise<void> = Promise.resolve();

function replaceProcessEnvironment(env: CliEnvironment): void {
  const next = new Map(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  for (const name of Object.keys(process.env)) {
    if (!next.has(name)) delete process.env[name];
  }
  for (const [name, value] of next) process.env[name] = value;
}

function escapesRoot(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

/**
 * Run one guided-init operation with exactly the durable worker environment.
 *
 * Provider SDKs and CLI bridges still consult `process.env` internally, so an
 * `env` argument used only for config loading is not enough. Guided init is a
 * single-purpose CLI path; serialize these temporary global swaps, hold the
 * selected environment for the whole async operation, and restore the complete
 * caller snapshot on every exit path.
 */
export async function withExactProcessEnvironment<T>(
  env: CliEnvironment,
  task: () => Promise<T>,
): Promise<T> {
  const predecessor = exactProcessEnvironmentTail;
  let release!: () => void;
  exactProcessEnvironmentTail = new Promise<void>((resolveTail) => {
    release = resolveTail;
  });
  await predecessor;

  const original = { ...process.env };
  try {
    replaceProcessEnvironment(env);
    return await task();
  } finally {
    try {
      replaceProcessEnvironment(original);
    } finally {
      release();
    }
  }
}

/**
 * Host variables required for the CLI and its child processes to operate. The
 * guided path deliberately does not inherit provider credentials or mono-agent
 * config from the invoking shell: a launchd worker cannot reproduce either.
 */
const FIRST_RUN_OPERATIONAL_ENV_NAMES = new Set([
  "APPDATA",
  "COLORTERM",
  "COMSPEC",
  "ComSpec",
  "FORCE_COLOR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "SHELL",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
  "USERPROFILE",
]);

const MONO_AGENT_SECRET_ENV_NAME = /(?:^|_)(?:API_KEY|CREDENTIAL|CREDENTIALS|PASSWORD|SECRET|TOKEN)$/u;
const SENSITIVE_DOTENV_NAME = /(api.?key|credential|password|secret|token)/iu;

/** Whether guided setup consumed any durable dotenv value that should be owner-only and untracked. */
export function hasSensitivePersistedEnvironmentValue(env: CliEnvironment): boolean {
  return Object.entries(env).some(
    ([name, value]) => SENSITIVE_DOTENV_NAME.test(name) && nonEmpty(value),
  );
}

/** Read and fingerprint dotenv without changing process.env. A missing file is empty. */
export async function readCliDotenvSnapshot(path: string): Promise<CliDotenvSnapshot> {
  let handle;
  try {
    // O_NONBLOCK matters before fstat: opening a FIFO read-only can otherwise
    // wait forever for a writer, preventing us from reaching the regular-file
    // check. It is a no-op for ordinary files.
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { env: {}, fingerprint: "missing" };
    }
    if (["ELOOP", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new Error(`Refusing to read dotenv path ${path} because it is a symbolic link.`);
    }
    throw error;
  }
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new Error(`Refusing to read dotenv path ${path} because it is not a regular file.`);
    }
    const contents = await handle.readFile({ encoding: "utf8" });
    const mode = fileStat.mode & 0o777;
    const env = Object.fromEntries(
      Object.entries(parseEnv(contents)).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const digest = createHash("sha256").update(contents).digest("hex");
    return { env, fingerprint: `file:${mode.toString(8)}:${digest}` };
  } finally {
    await handle.close();
  }
}

/** Read a dotenv file without changing process.env. A missing file is empty. */
export async function readCliDotenvFile(path: string): Promise<Record<string, string>> {
  return { ...(await readCliDotenvSnapshot(path)).env };
}

/** Read one exact config snapshot without following the final path component. */
export async function readCliConfigSnapshot(path: string): Promise<CliConfigSnapshot> {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new Error(`Refusing to read config path ${path} because it is a symbolic link.`);
    }
    throw error;
  }
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new Error(`Refusing to read config path ${path} because it is not a regular file.`);
    }
    const bytes = await handle.readFile();
    const pathStat = await lstat(path);
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      pathStat.dev !== fileStat.dev ||
      pathStat.ino !== fileStat.ino
    ) {
      throw new Error(`Refusing to read config path ${path} because it changed during setup.`);
    }
    let contents: string;
    try {
      contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`Refusing to read config path ${path} because it is not valid UTF-8.`);
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const mode = fileStat.mode & 0o777;
    return {
      contents,
      digest,
      fingerprint: [
        "file",
        fileStat.dev,
        fileStat.ino,
        fileStat.size,
        fileStat.mtimeMs,
        fileStat.ctimeMs,
        mode.toString(8),
        digest,
      ].join(":"),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Build the durable environment proven by guided init and later used by its
 * immediate start. Shell-only provider credentials and MONO_AGENT_* overrides
 * are intentionally absent; only worker-operational host values survive.
 * Operational values win over dotenv exactly as `process.loadEnvFile` and the
 * launchd plist do, while entered secrets and resolved Pi auth remain explicit.
 */
export function effectiveFirstRunEnvironment(options: {
  readonly shellEnv: CliEnvironment;
  readonly dotenvEnv: CliEnvironment;
  readonly enteredSecrets?: CliEnvironment;
  readonly resolvedPiAuthPath?: string;
}): Record<string, string | undefined> {
  const operationalEnv = Object.fromEntries(
    Object.entries(options.shellEnv).filter(([name]) => FIRST_RUN_OPERATIONAL_ENV_NAMES.has(name)),
  );
  return {
    ...options.dotenvEnv,
    ...operationalEnv,
    ...(options.enteredSecrets ?? {}),
    ...(options.resolvedPiAuthPath === undefined
      ? {}
      : { MONO_AGENT_PI_AUTH_PATH: options.resolvedPiAuthPath }),
  };
}

/**
 * Persisted mono-agent config overrides that could make the generated JSON say
 * something different from the runtime. Secret values and the selected Pi
 * credential-store path are data inputs, not config substitutions, so remain
 * allowed. Returned names are sorted for deterministic operator output.
 */
export function unexpectedPersistedMonoAgentOverrides(
  plan: WizardPlan,
  dotenvEnv: CliEnvironment,
): readonly string[] {
  const selectedSecrets = new Set(plan.secrets.map((secret) => secret.envVar));
  return Object.keys(dotenvEnv)
    .filter((name) =>
      name.startsWith("MONO_AGENT_") &&
      name !== "MONO_AGENT_PI_AUTH_PATH" &&
      !selectedSecrets.has(name) &&
      !MONO_AGENT_SECRET_ENV_NAME.test(name)
    )
    .sort();
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Selected secret names whose shell and persisted values would diverge. */
export function selectedSecretEnvironmentConflicts(
  plan: WizardPlan,
  shellEnv: CliEnvironment,
  dotenvEnv: CliEnvironment,
  enteredSecrets: CliEnvironment = {},
): readonly string[] {
  return [...new Set(plan.secrets.map((secret) => secret.envVar))].filter((name) => {
    const values = [shellEnv[name], dotenvEnv[name], enteredSecrets[name]].filter(nonEmpty);
    return new Set(values).size > 1;
  });
}

/** All selected secret values used by the live probe, including persisted ones. */
export function selectedSecretValues(
  plan: WizardPlan,
  env: CliEnvironment,
): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const secret of plan.secrets) {
    const value = env[secret.envVar];
    if (nonEmpty(value)) values[secret.envVar] = value;
  }
  return values;
}

/**
 * Resolve the one Pi credential store used by discovery, setup, validation and
 * runtime. Inputs are already ordered by their documented precedence.
 */
export function resolveEffectivePiAuthPath(options: {
  readonly cwd: string;
  readonly explicitPath?: string;
  readonly envPath?: string;
  readonly configPath?: string;
}): string {
  const selected = [options.explicitPath, options.envPath, options.configPath]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return piAuthPathForSetup(
    selected,
    options.cwd,
  );
}

/** Whether an exported shell override would select a different background store. */
export function piAuthPathBackgroundConflict(options: {
  readonly cwd: string;
  readonly shellPath?: string | undefined;
  readonly dotenvPath?: string | undefined;
  readonly configPath?: string | undefined;
}): boolean {
  if (!nonEmpty(options.shellPath)) return false;
  const interactive = resolveEffectivePiAuthPath({
    cwd: options.cwd,
    envPath: options.shellPath,
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
  });
  const background = resolveEffectivePiAuthPath({
    cwd: options.cwd,
    ...(nonEmpty(options.dotenvPath) ? { envPath: options.dotenvPath } : {}),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
  });
  return interactive !== background;
}

export interface FirstRunReadinessGate {
  readonly ready: boolean;
  readonly reasons: readonly string[];
}

/** A readiness claim is stricter than ValidationReport.ok (which permits waiting). */
export function evaluateFirstRunReadiness(options: {
  readonly plan: WizardPlan;
  readonly report: ValidationReport;
  readonly secretPersistence: SecretPersistenceOutcome;
  /** Exact persistent runtime routes proven by successful live no-tool turns. */
  readonly verifiedCredentialModelRefs?: readonly string[];
}): FirstRunReadinessGate {
  const reasons: string[] = [];
  if (!options.report.ok) {
    reasons.push("The complete generated configuration has validation errors.");
  }
  const byId = new Map(options.report.sections.map((section) => [section.id, section]));
  for (const expectation of options.plan.validateExpectations) {
    const actual = byId.get(expectation.sectionId)?.status;
    if (actual !== expectation.mustBe) {
      reasons.push(
        `${expectation.sectionId} must be ${expectation.mustBe}, but is ${actual ?? "missing"}.` +
          (expectation.note === undefined ? "" : ` ${expectation.note}`),
      );
    }
  }
  if (options.secretPersistence.status === "refused") {
    reasons.push(
      `Secure secret persistence was refused${options.secretPersistence.reason === undefined ? "" : ` (${options.secretPersistence.reason})`}.` +
        (options.secretPersistence.detail === undefined ? "" : ` ${options.secretPersistence.detail}`),
    );
  }
  const verified = new Set(options.verifiedCredentialModelRefs ?? []);
  for (const modelRef of selectedPersistentRuntimeModelRefs(options.plan)) {
    if (!verified.has(modelRef)) {
      reasons.push(`Runtime route ${modelRef} has not completed its exact live readiness check.`);
    }
  }
  return { ready: reasons.length === 0, reasons };
}

function selectedPersistentRuntimeModelRefs(plan: WizardPlan): readonly string[] {
  const runtime = (plan.configJson.runtime ?? {}) as Record<string, unknown>;
  const refs: string[] = [];
  if (typeof runtime.model === "string" && runtime.model.length > 0) refs.push(runtime.model);
  if (Array.isArray(runtime.fallbacks)) {
    for (const raw of runtime.fallbacks) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      const model = (raw as Record<string, unknown>).model;
      if (typeof model === "string" && model.length > 0) refs.push(model);
    }
  } else if (Array.isArray(runtime.fallbackModels)) {
    for (const model of runtime.fallbackModels) {
      if (typeof model === "string" && model.length > 0) refs.push(model);
    }
  }
  return [...new Set(refs)];
}

export interface ValidateWizardPlanInStagingOptions {
  readonly plan: WizardPlan;
  /** Folder whose existing relative context roots the generated plan references. */
  readonly sourceCwd?: string;
  readonly env: Record<string, string | undefined>;
  readonly verifiedCredentialModelRefs: readonly string[];
  readonly validate?: typeof validateMonoAgentFolder;
}

/** Validate the full plan in a disposable folder before touching the target. */
export async function validateWizardPlanInStaging(
  options: ValidateWizardPlanInStagingOptions,
): Promise<ValidationReport> {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-first-run-"));
  const configPath = join(dir, "mono-agent.config.json");
  try {
    await writeFile(configPath, `${JSON.stringify(options.plan.configJson, null, 2)}\n`, { mode: 0o600 });
    await writeFile(
      join(dir, "IDENTITY.md"),
      "# First-run validation identity\n\nTemporary identity used only for setup validation.\n",
      { mode: 0o600 },
    );
    await mkdir(join(dir, ".mono-agent", "workspace"), { recursive: true });
    await mkdir(join(dir, ".mono-agent", "artifacts"), { recursive: true });
    const skillsRoot = options.plan.configJson.context?.skillsRoot;
    if (skillsRoot !== undefined) {
      if (options.sourceCwd === undefined) {
        throw new Error("Staging a generated skills root requires the source agent folder.");
      }
      const sourceSkillsRoot = resolve(options.sourceCwd, skillsRoot);
      if (!(await stat(sourceSkillsRoot)).isDirectory()) {
        throw new Error(`Configured skills root is not a directory: ${sourceSkillsRoot}`);
      }
      const canonicalSourceCwd = await realpath(options.sourceCwd);
      const canonicalSourceSkillsRoot = await realpath(sourceSkillsRoot);
      if (escapesRoot(relative(canonicalSourceCwd, canonicalSourceSkillsRoot))) {
        throw new Error(`Refusing to stage skills root outside the source agent folder: ${skillsRoot}`);
      }
      const stagedSkillsRoot = resolve(dir, skillsRoot);
      const stagedRelative = relative(dir, stagedSkillsRoot);
      if (stagedRelative.length === 0 || escapesRoot(stagedRelative)) {
        throw new Error(`Refusing to stage skills root outside the disposable agent folder: ${skillsRoot}`);
      }
      await mkdir(stagedSkillsRoot, { recursive: true });
      for (const skill of options.plan.configJson.context?.selectedSkills ?? []) {
        const sourceSkillPath = resolve(sourceSkillsRoot, skill, "SKILL.md");
        const sourceRelative = relative(sourceSkillsRoot, sourceSkillPath);
        const stagedSkillPath = resolve(stagedSkillsRoot, skill, "SKILL.md");
        const stagedSkillRelative = relative(stagedSkillsRoot, stagedSkillPath);
        if (
          escapesRoot(sourceRelative) || escapesRoot(stagedSkillRelative)
        ) {
          throw new Error(`Refusing to stage a skill outside its configured root: ${skill}`);
        }
        const contents = await readSelectedSkillManifest(sourceSkillPath, canonicalSourceSkillsRoot);
        await mkdir(dirname(stagedSkillPath), { recursive: true });
        // Materialize a fresh regular file. Copying a symlink here would let a
        // later generated-file write follow it outside the disposable tree.
        await writeFile(stagedSkillPath, contents, { flag: "wx", mode: 0o600 });
      }
    }
    for (const file of options.plan.files) {
      const path = resolve(dir, file.path);
      const pathRelative = relative(dir, path);
      if (pathRelative.length === 0 || escapesRoot(pathRelative)) {
        throw new Error(`Refusing to stage a generated file outside the disposable agent folder: ${file.path}`);
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.contents, { mode: 0o600 });
    }
    return await (options.validate ?? validateMonoAgentFolder)({
      cwd: dir,
      configPath,
      env: options.env,
      // Writes are confined to this disposable directory. Memory/sandbox
      // capabilities need their normal initialization path to prove readiness.
      allowFilesystemWrites: true,
      liveness: true,
      verifiedCredentialModelRefs: options.verifiedCredentialModelRefs,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readSelectedSkillManifest(path: string, canonicalSkillsRoot: string): Promise<Buffer> {
  const canonicalParent = await realpath(dirname(path));
  if (escapesRoot(relative(canonicalSkillsRoot, canonicalParent))) {
    throw new Error(`Refusing to stage a skill manifest outside its configured root: ${path}`);
  }
  const canonicalPath = join(canonicalParent, "SKILL.md");
  let handle;
  try {
    handle = await open(
      canonicalPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new Error(`Refusing to stage symbolic-link skill manifest: ${path}`);
    }
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error(`Refusing to stage non-regular skill manifest: ${path}`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
