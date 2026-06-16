import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseCronJobMarkdown, startCronAdapter } from "@mono-agent/cron-adapter";
import { readMonoAgentConfigJson, writeMonoAgentConfigJson } from "@mono-agent/config";
import type { MonoAgentConfig, MonoAgentConfigJson } from "@mono-agent/config";
import { defineFieldGroup } from "@mono-agent/settings";
import type { FieldGroup } from "@mono-agent/settings";

import type { MonoAgentAppConfigInput } from "./app-config.js";

export type SelfCapabilitiesMode = "propose" | "apply";
export type SelfCapabilityKind = "skill" | "cron";

export interface SelfCapabilitiesSettings {
  readonly enabled: boolean;
  readonly mode: SelfCapabilitiesMode;
  readonly cwd: string;
  readonly configPath: string;
  readonly skillsRoot: string;
  readonly cronDir: string;
  readonly auditDir: string;
  readonly fallbackSelectedSkills: readonly string[];
  readonly selectedSkillsEnvOverride: boolean;
  readonly skillsRootEnvOverride: boolean;
  readonly cronDirEnvOverride: boolean;
  readonly confirmationToken?: string;
}

export interface SelfSkillInput {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly title?: string;
  readonly activate?: boolean;
}

export interface SelfCronInput {
  readonly id: string;
  readonly expression: string;
  readonly prompt: string;
  readonly timezone?: string;
  readonly conversationId?: string;
  readonly enabled?: boolean;
}

export interface SelfCapabilityPlan {
  readonly kind: SelfCapabilityKind;
  readonly id: string;
  readonly action: "proposed" | "created";
  readonly files: readonly string[];
  readonly configPatch?: MonoAgentConfigJson;
  readonly reloadRequired: boolean;
  readonly warnings: readonly string[];
  readonly preview?: string;
}

export interface SelfCapabilityApplyResult extends SelfCapabilityPlan {
  readonly action: "created";
  readonly auditPath: string;
}

export interface SelfCapabilitiesRuntimeExtension {
  readonly runtimeOptions: {
    readonly mcpServers: Record<string, unknown>;
  };
  readonly cleanup: () => Promise<void>;
}

export class SelfCapabilityError extends Error {
  readonly code: "invalid_config" | "invalid_input" | "not_enabled" | "conflict" | "write_failed";
  readonly details: Record<string, unknown>;

  constructor(
    code: SelfCapabilityError["code"],
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SelfCapabilityError";
    this.code = code;
    this.details = { ...details, code };
  }
}

export const SELF_CAPABILITIES_MCP_SERVER_NAME = "mono-agent-self-capabilities";
export const SELF_CAPABILITIES_RELOAD_FILE = "reload-requests.jsonl";

const DEFAULT_SELF_CAPABILITIES_MODE: SelfCapabilitiesMode = "propose";
const DEFAULT_SKILLS_ROOT = "skills";
const DEFAULT_CRON_DIR = "cron";
const DEFAULT_AUDIT_DIR = ".mono-agent/self-capabilities";
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

export const selfCapabilitiesFieldGroup: FieldGroup = defineFieldGroup({
  id: "selfCapabilities",
  label: "Self capabilities",
  description: "Optional guarded tools that let the running agent propose or create local skills and cron jobs.",
  fields: [
    {
      id: "selfCapabilities.enabled",
      label: "Enabled",
      description: "Expose the self-capability MCP server to model runs.",
      kind: "switch",
      path: ["selfCapabilities", "enabled"],
    },
    {
      id: "selfCapabilities.mode",
      label: "Mode",
      description: "propose exposes read-only proposal tools; apply also exposes write tools.",
      kind: "select",
      options: [
        { value: "propose", label: "propose" },
        { value: "apply", label: "apply" },
      ],
      path: ["selfCapabilities", "mode"],
    },
    {
      id: "selfCapabilities.skillsRoot",
      label: "Skills root",
      description: "Folder where generated skills are written. Defaults to context.skillsRoot or ./skills.",
      kind: "path",
      placeholder: "./skills",
      path: ["selfCapabilities", "skillsRoot"],
    },
    {
      id: "selfCapabilities.cronDir",
      label: "Cron folder",
      description: "Folder where generated markdown cron jobs are written. Defaults to cron.dir or ./cron.",
      kind: "path",
      placeholder: "./cron",
      path: ["selfCapabilities", "cronDir"],
    },
    {
      id: "selfCapabilities.auditDir",
      label: "Audit folder",
      description: "Folder for audit records and reload markers.",
      kind: "path",
      placeholder: "./.mono-agent/self-capabilities",
      path: ["selfCapabilities", "auditDir"],
    },
  ],
});

export async function resolveSelfCapabilitiesSettings(
  input: MonoAgentAppConfigInput,
  coreConfig: MonoAgentConfig,
): Promise<SelfCapabilitiesSettings> {
  const cwd = resolve(input.cwd);
  const configPath = resolve(cwd, input.configPath);
  const { json } = await readMonoAgentConfigJson(configPath);
  const section = readSection(json, "selfCapabilities");
  const cronSection = readSection(json, "cron");

  const enabled = readBooleanish(
    envValue(input.env.MONO_AGENT_SELF_CAPABILITIES_ENABLED) ?? section.enabled,
    "selfCapabilities.enabled",
  ) ?? false;
  if (!enabled) {
    return {
      enabled: false,
      mode: DEFAULT_SELF_CAPABILITIES_MODE,
      cwd,
      configPath,
      skillsRoot: resolve(cwd, DEFAULT_SKILLS_ROOT),
      cronDir: resolve(cwd, DEFAULT_CRON_DIR),
      auditDir: resolve(cwd, DEFAULT_AUDIT_DIR),
      fallbackSelectedSkills: coreConfig.context.selectedSkills,
      selectedSkillsEnvOverride: hasEnv(input.env.MONO_AGENT_SELECTED_SKILLS),
      skillsRootEnvOverride: hasEnv(input.env.MONO_AGENT_SKILLS_ROOT),
      cronDirEnvOverride: hasEnv(input.env.MONO_AGENT_CRON_DIR),
    };
  }
  const localConfigPath = resolveAgentLocalPath(cwd, configPath, "selfCapabilities.configPath");
  const mode = readMode(
    envValue(input.env.MONO_AGENT_SELF_CAPABILITIES_MODE) ?? section.mode,
    "selfCapabilities.mode",
  ) ?? DEFAULT_SELF_CAPABILITIES_MODE;

  const skillsRootValue =
    envValue(input.env.MONO_AGENT_SELF_CAPABILITIES_SKILLS_ROOT) ??
    coreConfig.context.skillsRoot ??
    optionalString(section.skillsRoot) ??
    DEFAULT_SKILLS_ROOT;
  const cronDirValue =
    envValue(input.env.MONO_AGENT_SELF_CAPABILITIES_CRON_DIR) ??
    envValue(input.env.MONO_AGENT_CRON_DIR) ??
    optionalString(section.cronDir) ??
    optionalString(cronSection.dir) ??
    DEFAULT_CRON_DIR;
  const auditDirValue =
    envValue(input.env.MONO_AGENT_SELF_CAPABILITIES_AUDIT_DIR) ??
    optionalString(section.auditDir) ??
    DEFAULT_AUDIT_DIR;
  const confirmationToken = envValue(input.env.MONO_AGENT_SELF_CAPABILITIES_CONFIRMATION_TOKEN);

  return {
    enabled,
    mode,
    cwd,
    configPath: localConfigPath,
    skillsRoot: resolveAgentLocalPath(cwd, skillsRootValue, "selfCapabilities.skillsRoot"),
    cronDir: resolveAgentLocalPath(cwd, cronDirValue, "selfCapabilities.cronDir"),
    auditDir: resolveAgentLocalPath(cwd, auditDirValue, "selfCapabilities.auditDir"),
    fallbackSelectedSkills: coreConfig.context.selectedSkills,
    selectedSkillsEnvOverride: hasEnv(input.env.MONO_AGENT_SELECTED_SKILLS),
    skillsRootEnvOverride: hasEnv(input.env.MONO_AGENT_SKILLS_ROOT),
    cronDirEnvOverride: hasEnv(input.env.MONO_AGENT_CRON_DIR),
    ...(confirmationToken === undefined ? {} : { confirmationToken }),
  };
}

export function createSelfCapabilitiesRuntimeExtension(
  settings: SelfCapabilitiesSettings,
  onReloadRequested: (token: string) => void,
): () => Promise<SelfCapabilitiesRuntimeExtension> {
  return async () => {
    const before = await readSelfCapabilitiesReloadToken(settings.auditDir);
    return {
      runtimeOptions: {
        mcpServers: {
          [SELF_CAPABILITIES_MCP_SERVER_NAME]: selfCapabilitiesMcpServerSpec(settings),
        },
      },
      cleanup: async () => {
        const after = await readSelfCapabilitiesReloadToken(settings.auditDir);
        if (after.length > 0 && after !== before) {
          onReloadRequested(after);
        }
      },
    };
  };
}

export function selfCapabilitiesMcpServerSpec(settings: SelfCapabilitiesSettings): Record<string, unknown> {
  return {
    type: "stdio",
    command: process.execPath,
    args: [fileURLToPath(new URL("./self-capabilities-main.js", import.meta.url))],
    cwd: settings.cwd,
    env: selfCapabilitiesMcpEnv(settings),
  };
}

export function selfCapabilitiesMcpEnv(settings: SelfCapabilitiesSettings): Record<string, string> {
  return {
    MONO_AGENT_SELF_CAPABILITIES_CONFIG_PATH: settings.configPath,
    MONO_AGENT_SELF_CAPABILITIES_CWD: settings.cwd,
    MONO_AGENT_SELF_CAPABILITIES_MODE: settings.mode,
    MONO_AGENT_SELF_CAPABILITIES_SKILLS_ROOT: settings.skillsRoot,
    MONO_AGENT_SELF_CAPABILITIES_CRON_DIR: settings.cronDir,
    MONO_AGENT_SELF_CAPABILITIES_AUDIT_DIR: settings.auditDir,
    MONO_AGENT_SELF_CAPABILITIES_SELECTED_SKILLS_JSON: JSON.stringify(settings.fallbackSelectedSkills),
    MONO_AGENT_SELF_CAPABILITIES_SELECTED_SKILLS_ENV_OVERRIDE: String(settings.selectedSkillsEnvOverride),
    MONO_AGENT_SELF_CAPABILITIES_SKILLS_ROOT_ENV_OVERRIDE: String(settings.skillsRootEnvOverride),
    MONO_AGENT_SELF_CAPABILITIES_CRON_DIR_ENV_OVERRIDE: String(settings.cronDirEnvOverride),
    ...(settings.confirmationToken === undefined ? {} : { MONO_AGENT_SELF_CAPABILITIES_CONFIRMATION_TOKEN: settings.confirmationToken }),
  };
}

export function selfCapabilitiesSettingsFromEnv(
  env: Record<string, string | undefined>,
): SelfCapabilitiesSettings {
  const cwd = envValue(env.MONO_AGENT_SELF_CAPABILITIES_CWD);
  const configPath = envValue(env.MONO_AGENT_SELF_CAPABILITIES_CONFIG_PATH);
  const mode = readMode(env.MONO_AGENT_SELF_CAPABILITIES_MODE, "MONO_AGENT_SELF_CAPABILITIES_MODE");
  const skillsRoot = envValue(env.MONO_AGENT_SELF_CAPABILITIES_SKILLS_ROOT);
  const cronDir = envValue(env.MONO_AGENT_SELF_CAPABILITIES_CRON_DIR);
  const auditDir = envValue(env.MONO_AGENT_SELF_CAPABILITIES_AUDIT_DIR);
  const confirmationToken = envValue(env.MONO_AGENT_SELF_CAPABILITIES_CONFIRMATION_TOKEN);
  if (cwd === undefined || configPath === undefined || mode === undefined || skillsRoot === undefined || cronDir === undefined || auditDir === undefined) {
    throw new SelfCapabilityError("invalid_config", "Self-capability MCP server is missing required environment.", {
      required: [
        "MONO_AGENT_SELF_CAPABILITIES_CWD",
        "MONO_AGENT_SELF_CAPABILITIES_CONFIG_PATH",
        "MONO_AGENT_SELF_CAPABILITIES_MODE",
        "MONO_AGENT_SELF_CAPABILITIES_SKILLS_ROOT",
        "MONO_AGENT_SELF_CAPABILITIES_CRON_DIR",
        "MONO_AGENT_SELF_CAPABILITIES_AUDIT_DIR",
      ],
    });
  }
  const resolvedCwd = resolve(cwd);
  return {
    enabled: true,
    mode,
    cwd: resolvedCwd,
    configPath: resolveAgentLocalPath(resolvedCwd, configPath, "MONO_AGENT_SELF_CAPABILITIES_CONFIG_PATH"),
    skillsRoot: resolveAgentLocalPath(resolvedCwd, skillsRoot, "MONO_AGENT_SELF_CAPABILITIES_SKILLS_ROOT"),
    cronDir: resolveAgentLocalPath(resolvedCwd, cronDir, "MONO_AGENT_SELF_CAPABILITIES_CRON_DIR"),
    auditDir: resolveAgentLocalPath(resolvedCwd, auditDir, "MONO_AGENT_SELF_CAPABILITIES_AUDIT_DIR"),
    fallbackSelectedSkills: readJsonStringArray(env.MONO_AGENT_SELF_CAPABILITIES_SELECTED_SKILLS_JSON),
    selectedSkillsEnvOverride: readBooleanish(env.MONO_AGENT_SELF_CAPABILITIES_SELECTED_SKILLS_ENV_OVERRIDE, "MONO_AGENT_SELF_CAPABILITIES_SELECTED_SKILLS_ENV_OVERRIDE") ?? false,
    skillsRootEnvOverride: readBooleanish(env.MONO_AGENT_SELF_CAPABILITIES_SKILLS_ROOT_ENV_OVERRIDE, "MONO_AGENT_SELF_CAPABILITIES_SKILLS_ROOT_ENV_OVERRIDE") ?? false,
    cronDirEnvOverride: readBooleanish(env.MONO_AGENT_SELF_CAPABILITIES_CRON_DIR_ENV_OVERRIDE, "MONO_AGENT_SELF_CAPABILITIES_CRON_DIR_ENV_OVERRIDE") ?? false,
    ...(confirmationToken === undefined ? {} : { confirmationToken }),
  };
}

export async function proposeSelfSkill(
  settings: SelfCapabilitiesSettings,
  input: SelfSkillInput,
): Promise<SelfCapabilityPlan> {
  const id = normalizeSlug(input.name, "name");
  const content = skillMarkdown(id, input);
  const file = resolveSkillFile(settings, id);
  const { patch, warnings } = await skillConfigPatch(settings, id, input.activate ?? true);
  const exists = await pathExists(file);
  return {
    kind: "skill",
    id,
    action: "proposed",
    files: [file],
    ...(patch === undefined ? {} : { configPatch: patch }),
    reloadRequired: true,
    warnings: exists ? [`Skill ${id} already exists at ${file}.`] : warnings,
    preview: content,
  };
}

export async function applySelfSkill(
  settings: SelfCapabilitiesSettings,
  input: SelfSkillInput,
  deps: { readonly now?: () => Date } = {},
): Promise<SelfCapabilityApplyResult> {
  assertApplyMode(settings);
  const id = normalizeSlug(input.name, "name");
  const content = skillMarkdown(id, input);
  return await withSelfCapabilityMutation(settings, async () => {
    const file = resolveSkillFile(settings, id);
    const skillDir = resolve(settings.skillsRoot, id);
    const { patch, warnings } = await skillConfigPatch(settings, id, input.activate ?? true);

    await assertNoSymlinkAncestors(settings.cwd, settings.skillsRoot, "selfCapabilities.skillsRoot");
    await mkdir(skillDir, { recursive: true });
    await assertNoSymlinkAncestors(settings.cwd, skillDir, "skill directory");
    try {
      await writeFile(file, content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (isErrno(error, "EEXIST")) {
        throw new SelfCapabilityError("conflict", `Skill ${id} already exists.`, { file });
      }
      throw new SelfCapabilityError("write_failed", "Unable to write skill file.", { file, reason: errorToMessage(error) });
    }
    let configWritten = false;
    try {
      if (patch !== undefined) {
        await writeMonoAgentConfigJson({ path: settings.configPath, patch });
        configWritten = true;
      }
    } catch (error) {
      if (!configWritten) {
        await rm(file, { force: true });
      }
      throw error;
    }
    const auditPath = await writeAudit(settings, {
      kind: "skill",
      id,
      files: [file],
      ...(patch === undefined ? {} : { configPatch: patch }),
      warnings,
    }, deps.now);
    await requestSelfCapabilitiesReload(settings, "skill", id, deps.now);
    return {
      kind: "skill",
      id,
      action: "created",
      files: [file],
      ...(patch === undefined ? {} : { configPatch: patch }),
      reloadRequired: true,
      warnings,
      auditPath,
    };
  });
}

export async function proposeSelfCron(
  settings: SelfCapabilitiesSettings,
  input: SelfCronInput,
): Promise<SelfCapabilityPlan> {
  const id = normalizeSlug(input.id, "id");
  const { content } = validatedCronMarkdown(id, input);
  const file = resolveCronFile(settings, id);
  const patch = cronConfigPatch(settings);
  const exists = await pathExists(file);
  return {
    kind: "cron",
    id,
    action: "proposed",
    files: [file],
    ...(patch === undefined ? {} : { configPatch: patch }),
    reloadRequired: true,
    warnings: exists ? [`Cron job ${id} already exists at ${file}.`] : cronWarnings(settings, patch),
    preview: content,
  };
}

export async function applySelfCron(
  settings: SelfCapabilitiesSettings,
  input: SelfCronInput,
  deps: { readonly now?: () => Date } = {},
): Promise<SelfCapabilityApplyResult> {
  assertApplyMode(settings);
  const id = normalizeSlug(input.id, "id");
  const { content } = validatedCronMarkdown(id, input);
  return await withSelfCapabilityMutation(settings, async () => {
    const file = resolveCronFile(settings, id);
    const patch = cronConfigPatch(settings);
    const warnings = cronWarnings(settings, patch);

    await assertNoSymlinkAncestors(settings.cwd, settings.cronDir, "selfCapabilities.cronDir");
    await mkdir(settings.cronDir, { recursive: true });
    await assertNoSymlinkAncestors(settings.cwd, settings.cronDir, "cron directory");
    try {
      await writeFile(file, content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (isErrno(error, "EEXIST")) {
        throw new SelfCapabilityError("conflict", `Cron job ${id} already exists.`, { file });
      }
      throw new SelfCapabilityError("write_failed", "Unable to write cron job file.", { file, reason: errorToMessage(error) });
    }
    let configWritten = false;
    try {
      if (patch !== undefined) {
        await writeMonoAgentConfigJson({ path: settings.configPath, patch });
        configWritten = true;
      }
    } catch (error) {
      if (!configWritten) {
        await rm(file, { force: true });
      }
      throw error;
    }
    const auditPath = await writeAudit(settings, {
      kind: "cron",
      id,
      files: [file],
      ...(patch === undefined ? {} : { configPatch: patch }),
      warnings,
    }, deps.now);
    await requestSelfCapabilitiesReload(settings, "cron", id, deps.now);
    return {
      kind: "cron",
      id,
      action: "created",
      files: [file],
      ...(patch === undefined ? {} : { configPatch: patch }),
      reloadRequired: true,
      warnings,
      auditPath,
    };
  });
}

export async function readSelfCapabilitiesReloadToken(auditDir: string): Promise<string> {
  try {
    const content = await readFile(join(auditDir, SELF_CAPABILITIES_RELOAD_FILE), "utf8");
    return createHash("sha256").update(content).digest("hex");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return "";
    }
    throw error;
  }
}

async function requestSelfCapabilitiesReload(
  settings: SelfCapabilitiesSettings,
  kind: SelfCapabilityKind,
  id: string,
  now: (() => Date) | undefined,
): Promise<void> {
  await mkdir(settings.auditDir, { recursive: true });
  const record = {
    timestamp: timestamp(now),
    kind,
    id,
    reason: `${kind}:${id}`,
  };
  await appendFile(join(settings.auditDir, SELF_CAPABILITIES_RELOAD_FILE), `${JSON.stringify(record)}\n`, "utf8");
}

async function writeAudit(
  settings: SelfCapabilitiesSettings,
  record: {
    readonly kind: SelfCapabilityKind;
    readonly id: string;
    readonly files: readonly string[];
    readonly configPatch?: MonoAgentConfigJson;
    readonly warnings: readonly string[];
  },
  now: (() => Date) | undefined,
): Promise<string> {
  const stamp = timestamp(now);
  const auditDir = join(settings.auditDir, "audit");
  await mkdir(auditDir, { recursive: true });
  const auditPath = join(auditDir, `${stamp.replace(/[:.]/gu, "-")}-${record.kind}-${record.id}.json`);
  const audit = {
    timestamp: stamp,
    cwd: settings.cwd,
    configPath: settings.configPath,
    ...record,
  };
  await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return auditPath;
}

async function skillConfigPatch(
  settings: SelfCapabilitiesSettings,
  id: string,
  activate: boolean,
): Promise<{ readonly patch?: MonoAgentConfigJson; readonly warnings: readonly string[] }> {
  if (!activate) {
    return { warnings: [] };
  }
  const { json } = await readMonoAgentConfigJson(settings.configPath);
  const context = readSection(json, "context");
  const fromJson = Array.isArray(context.selectedSkills)
    ? context.selectedSkills.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : undefined;
  const selectedSkills = appendUnique(fromJson ?? settings.fallbackSelectedSkills, id);
  const patch: MonoAgentConfigJson = {
    context: {
      selectedSkills,
      ...(context.skillsRoot === undefined && !settings.skillsRootEnvOverride
        ? { skillsRoot: configRelativePath(settings.cwd, settings.skillsRoot) }
        : {}),
    },
  };
  const warnings = [
    ...(settings.selectedSkillsEnvOverride
      ? ["MONO_AGENT_SELECTED_SKILLS is set; it will override the selectedSkills JSON patch until the env var is removed."]
      : []),
    ...(settings.skillsRootEnvOverride
      ? ["MONO_AGENT_SKILLS_ROOT is set; it will override context.skillsRoot in JSON."]
      : []),
  ];
  return { patch, warnings };
}

function cronConfigPatch(settings: SelfCapabilitiesSettings): MonoAgentConfigJson | undefined {
  const defaultCronDir = resolve(settings.cwd, DEFAULT_CRON_DIR);
  if (settings.cronDirEnvOverride || settings.cronDir === defaultCronDir) {
    return undefined;
  }
  return { cron: { dir: configRelativePath(settings.cwd, settings.cronDir) } };
}

function cronWarnings(settings: SelfCapabilitiesSettings, patch: MonoAgentConfigJson | undefined): readonly string[] {
  if (settings.cronDirEnvOverride) {
    return ["MONO_AGENT_CRON_DIR is set; it will override cron.dir in JSON."];
  }
  return [];
}

function skillMarkdown(id: string, input: SelfSkillInput): string {
  const description = nonBlank(input.description, "description");
  const instructions = nonBlank(input.instructions, "instructions");
  const title = optionalString(input.title) ?? titleFromSlug(id);
  return `# ${title}\n\n${description}\n\n## Instructions\n\n${instructions}\n`;
}

function cronMarkdown(id: string, input: SelfCronInput): string {
  const expression = frontmatterScalar(input.expression, "expression");
  const timezone = optionalFrontmatterScalar(input.timezone, "timezone") ?? "UTC";
  const conversationId = optionalFrontmatterScalar(input.conversationId, "conversationId");
  const prompt = nonBlank(input.prompt, "prompt");
  const lines = [
    "---",
    `id: ${id}`,
    `expression: ${expression}`,
    `timezone: ${timezone}`,
    `enabled: ${input.enabled ?? true}`,
    ...(conversationId === undefined ? [] : [`conversationId: ${conversationId}`]),
    "---",
    "",
    prompt,
    "",
  ];
  return lines.join("\n");
}

function validatedCronMarkdown(id: string, input: SelfCronInput): { readonly content: string } {
  const content = cronMarkdown(id, input);
  const parsed = parseCronJobMarkdown(`${id}.md`, content);
  const expectedTimezone = optionalFrontmatterScalar(input.timezone, "timezone") ?? "UTC";
  const expectedConversationId = optionalFrontmatterScalar(input.conversationId, "conversationId");
  const expectedEnabled = input.enabled ?? true;
  if (
    parsed.id !== id ||
    parsed.expression !== frontmatterScalar(input.expression, "expression") ||
    parsed.timezone !== expectedTimezone ||
    parsed.enabled !== expectedEnabled ||
    parsed.conversationId !== expectedConversationId
  ) {
    throw new SelfCapabilityError("invalid_input", "Cron markdown frontmatter did not round-trip safely.", { id });
  }
  validateCronSchedule(id, parsed.expression, parsed.timezone);
  return { content };
}

function resolveSkillFile(settings: SelfCapabilitiesSettings, id: string): string {
  const file = resolve(settings.skillsRoot, id, "SKILL.md");
  assertInside(settings.skillsRoot, file, "skill file");
  return file;
}

function resolveCronFile(settings: SelfCapabilitiesSettings, id: string): string {
  const file = resolve(settings.cronDir, `${id}.md`);
  assertInside(settings.cronDir, file, "cron job file");
  return file;
}

function assertApplyMode(settings: SelfCapabilitiesSettings): void {
  if (settings.mode !== "apply") {
    throw new SelfCapabilityError("not_enabled", "Self-capability writes require selfCapabilities.mode = apply.", {
      mode: settings.mode,
    });
  }
}

function resolveAgentLocalPath(cwd: string, value: string, field: string): string {
  const resolved = resolve(cwd, value);
  assertInside(cwd, resolved, field);
  return resolved;
}

function assertInside(root: string, target: string, field: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return;
  }
  throw new SelfCapabilityError("invalid_config", `${field} must stay inside ${root}.`, { root, target });
}

function configRelativePath(cwd: string, target: string): string {
  const rel = relative(cwd, target);
  if (rel.length === 0) {
    return ".";
  }
  return rel.startsWith("..") ? target : `./${rel}`;
}

function normalizeSlug(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new SelfCapabilityError("invalid_input", `${field} must be a string.`, { field });
  }
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!SLUG_PATTERN.test(slug)) {
    throw new SelfCapabilityError("invalid_input", `${field} must resolve to a path-safe slug.`, { field, value });
  }
  return slug;
}

function titleFromSlug(id: string): string {
  return id
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function nonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SelfCapabilityError("invalid_input", `${field} must be a non-empty string.`, { field });
  }
  return value.trim();
}

function frontmatterScalar(value: unknown, field: string): string {
  const normalized = nonBlank(value, field);
  if (/[\r\n]/u.test(normalized)) {
    throw new SelfCapabilityError("invalid_input", `${field} must be a single-line frontmatter value.`, { field });
  }
  return normalized;
}

function optionalFrontmatterScalar(value: unknown, field: string): string | undefined {
  const normalized = optionalString(value);
  if (normalized === undefined) {
    return undefined;
  }
  return frontmatterScalar(normalized, field);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readSection(json: MonoAgentConfigJson, key: string): Record<string, unknown> {
  const value = json[key];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function envValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function hasEnv(value: string | undefined): boolean {
  return envValue(value) !== undefined;
}

function readMode(value: unknown, field: string): SelfCapabilitiesMode | undefined {
  const mode = optionalString(value);
  if (mode === undefined) {
    return undefined;
  }
  if (mode === "propose" || mode === "apply") {
    return mode;
  }
  throw new SelfCapabilityError("invalid_config", `${field} must be propose or apply.`, { field, value });
}

function readBooleanish(value: unknown, field: string): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  const raw = optionalString(value)?.toLowerCase();
  if (raw === undefined) {
    return undefined;
  }
  if (raw === "true" || raw === "1") {
    return true;
  }
  if (raw === "false" || raw === "0") {
    return false;
  }
  throw new SelfCapabilityError("invalid_config", `${field} must be true or false.`, { field, value });
}

function readJsonStringArray(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function appendUnique(values: readonly string[], next: string): readonly string[] {
  const out = [...values];
  if (!out.some((value) => value.toLowerCase() === next.toLowerCase())) {
    out.push(next);
  }
  return out;
}

async function withSelfCapabilityMutation<T>(
  settings: SelfCapabilitiesSettings,
  fn: () => Promise<T>,
): Promise<T> {
  await assertNoSymlinkAncestors(settings.cwd, settings.auditDir, "selfCapabilities.auditDir");
  await mkdir(settings.auditDir, { recursive: true });
  await assertNoSymlinkAncestors(settings.cwd, settings.auditDir, "selfCapabilities.auditDir");
  const lockPath = join(settings.auditDir, "mutation.lock");
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
      break;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new SelfCapabilityError("conflict", "Timed out waiting for another self-capability mutation.", { lockPath });
      }
      await sleep(50);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}

async function assertNoSymlinkAncestors(cwd: string, target: string, field: string): Promise<void> {
  const root = resolve(cwd);
  const resolved = resolve(target);
  assertInside(root, resolved, field);
  const rel = relative(root, resolved);
  let current = root;
  for (const part of rel.split(/[\\/]+/u).filter((entry) => entry.length > 0)) {
    current = resolve(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new SelfCapabilityError("invalid_config", `${field} must not contain symlinked path components.`, {
          path: current,
        });
      }
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return;
      }
      throw error;
    }
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function validateCronSchedule(id: string, expression: string, timezone: string | undefined): void {
  const normalizedTimezone = optionalString(timezone);
  try {
    const running = startCronAdapter({
      responder: { async respond() { return { text: "ok" }; } },
      jobs: [{
        id,
        expression,
        prompt: "validate",
        ...(normalizedTimezone === undefined ? {} : { timezone: normalizedTimezone }),
      }],
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    running.stop();
  } catch (error) {
    throw new SelfCapabilityError("invalid_input", "Cron schedule is invalid.", {
      id,
      reason: errorToMessage(error),
    });
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

function timestamp(now: (() => Date) | undefined): string {
  return (now?.() ?? new Date()).toISOString();
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
