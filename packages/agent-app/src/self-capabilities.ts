import { createHash, createHmac, randomUUID } from "node:crypto";
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
  readonly reloadNonce?: string;
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

export interface SelfProposalApplyInput {
  readonly proposalId: string;
}

export type SelfSkillApplyInput = SelfSkillInput | SelfProposalApplyInput;
export type SelfCronApplyInput = SelfCronInput | SelfProposalApplyInput;

export interface SelfCapabilityPlan {
  readonly kind: SelfCapabilityKind;
  readonly id: string;
  readonly action: "proposed" | "created";
  readonly files: readonly string[];
  readonly configPatch?: MonoAgentConfigJson;
  readonly reloadRequired: boolean;
  readonly warnings: readonly string[];
  readonly preview?: string;
  readonly proposalId?: string;
  readonly proposalPath?: string;
}

export interface SelfCapabilityApplyResult extends SelfCapabilityPlan {
  readonly action: "created";
  readonly auditPath: string;
}

export type SelfCapabilityProposalRecord = SelfSkillProposalRecord | SelfCronProposalRecord;

export interface SelfSkillProposalRecord extends SelfCapabilityProposalRecordBase {
  readonly kind: "skill";
  readonly input: SelfSkillInput;
}

export interface SelfCronProposalRecord extends SelfCapabilityProposalRecordBase {
  readonly kind: "cron";
  readonly input: SelfCronInput;
}

interface SelfCapabilityProposalRecordBase {
  readonly version: 1;
  readonly proposalId: string;
  readonly contentHash: string;
  readonly timestamp: string;
  readonly cwd: string;
  readonly configPath: string;
  readonly id: string;
  readonly files: readonly string[];
  readonly configPatch?: MonoAgentConfigJson;
  readonly reloadRequired: false;
  readonly warnings: readonly string[];
  readonly preview: string;
}

export interface SelfCapabilitiesRuntimeExtension {
  readonly runtimeOptions: {
    readonly mcpServers: Record<string, unknown>;
  };
  readonly cleanup: () => Promise<void>;
}

export class SelfCapabilityError extends Error {
  readonly code: "invalid_config" | "invalid_input" | "not_enabled" | "not_found" | "conflict" | "write_failed";
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
export const SELF_CAPABILITIES_PROPOSALS_DIR = "proposals";

const DEFAULT_SELF_CAPABILITIES_MODE: SelfCapabilitiesMode = "propose";
const DEFAULT_SKILLS_ROOT = "skills";
const DEFAULT_CRON_DIR = "cron";
const DEFAULT_AUDIT_DIR = ".mono-agent/self-capabilities";
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const PROPOSAL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,160}[a-z0-9])?$/u;

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
    const requestSettings = { ...settings, reloadNonce: randomUUID() };
    const before = await readSelfCapabilitiesReloadToken(settings.auditDir, requestSettings.reloadNonce);
    return {
      runtimeOptions: {
        mcpServers: {
          [SELF_CAPABILITIES_MCP_SERVER_NAME]: selfCapabilitiesMcpServerSpec(requestSettings),
        },
      },
      cleanup: async () => {
        const after = await readSelfCapabilitiesReloadToken(settings.auditDir, requestSettings.reloadNonce);
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
    ...(settings.reloadNonce === undefined ? {} : { MONO_AGENT_SELF_CAPABILITIES_RELOAD_NONCE: settings.reloadNonce }),
  };
}

export function selfCapabilityConfirmationToken(settings: SelfCapabilitiesSettings, proposalId: string): string | undefined {
  if (settings.confirmationToken === undefined) {
    return undefined;
  }
  return createHmac("sha256", settings.confirmationToken)
    .update(normalizeProposalId(proposalId))
    .digest("hex");
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
  const reloadNonce = envValue(env.MONO_AGENT_SELF_CAPABILITIES_RELOAD_NONCE);
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
    ...(reloadNonce === undefined ? {} : { reloadNonce: normalizeReloadNonce(reloadNonce) }),
  };
}

export async function proposeSelfSkill(
  settings: SelfCapabilitiesSettings,
  input: SelfSkillInput,
  deps: { readonly now?: () => Date } = {},
): Promise<SelfCapabilityPlan> {
  const id = normalizeSlug(input.name, "name");
  const content = skillMarkdown(id, input);
  const file = resolveSkillFile(settings, id);
  const { patch, warnings } = await skillConfigPatch(settings, id, input.activate ?? true);
  const exists = await pathExists(file);
  const plan = {
    kind: "skill",
    id,
    action: "proposed",
    files: [file],
    ...(patch === undefined ? {} : { configPatch: patch }),
    reloadRequired: false,
    warnings: exists ? [`Skill ${id} already exists at ${file}.`] : warnings,
    preview: content,
  } satisfies Omit<SelfCapabilityPlan, "proposalId" | "proposalPath">;
  const proposal = await writeProposal(settings, {
    kind: "skill",
    id,
    input,
    files: plan.files,
    ...(patch === undefined ? {} : { configPatch: patch }),
    warnings: plan.warnings,
    preview: content,
  }, deps.now);
  return { ...plan, proposalId: proposal.proposalId, proposalPath: proposal.path };
}

export async function applySelfSkill(
  settings: SelfCapabilitiesSettings,
  input: SelfSkillApplyInput,
  deps: { readonly now?: () => Date } = {},
): Promise<SelfCapabilityApplyResult> {
  assertApplyMode(settings);
  if (isProposalApplyInput(input)) {
    const proposal = await readSkillProposal(settings, input.proposalId);
    return await applySelfSkillInput(settings, proposal.input, deps, proposal);
  }
  return await applySelfSkillInput(settings, input, deps, undefined);
}

async function applySelfSkillInput(
  settings: SelfCapabilitiesSettings,
  input: SelfSkillInput,
  deps: { readonly now?: () => Date },
  proposal: SelfSkillProposalRecord | undefined,
): Promise<SelfCapabilityApplyResult> {
  const id = normalizeSlug(input.name, "name");
  const content = skillMarkdown(id, input);
  return await withSelfCapabilityMutation(settings, async () => {
    const file = resolveSkillFile(settings, id);
    const skillDir = resolve(settings.skillsRoot, id);
    const { patch, warnings } = await skillConfigPatch(settings, id, input.activate ?? true);
    if (proposal !== undefined) {
      assertProposalMatchesCurrent(proposal, {
        kind: "skill",
        id,
        input,
        files: [file],
        ...(patch === undefined ? {} : { configPatch: patch }),
        warnings,
        preview: content,
      });
    }

    await preflightSelfCapabilityWriteTargets(settings);
    await assertNoSymlinkAncestors(settings.cwd, settings.skillsRoot, "selfCapabilities.skillsRoot");
    await mkdir(skillDir, { recursive: true });
    await assertNoSymlinkAncestors(settings.cwd, skillDir, "skill directory");
    const originalConfig = patch === undefined ? undefined : await readFile(settings.configPath, "utf8");
    let fileWritten = false;
    let configWritten = false;
    try {
      await writeFile(file, content, { encoding: "utf8", flag: "wx" });
      fileWritten = true;
      if (patch !== undefined) {
        await writeMonoAgentConfigJson({ path: settings.configPath, patch });
        configWritten = true;
      }
      const auditPath = await writeAudit(settings, {
        kind: "skill",
        id,
        files: [file],
        ...(patch === undefined ? {} : { configPatch: patch }),
        warnings,
        ...(proposal === undefined ? {} : { proposalId: proposal.proposalId, proposalPath: proposalPath(settings, proposal.proposalId) }),
      }, deps.now);
      await requestSelfCapabilitiesReload(settings, "skill", id, deps.now, proposal?.proposalId);
      return {
        kind: "skill",
        id,
        action: "created",
        files: [file],
        ...(patch === undefined ? {} : { configPatch: patch }),
        reloadRequired: true,
        warnings,
        ...(proposal === undefined ? {} : { proposalId: proposal.proposalId, proposalPath: proposalPath(settings, proposal.proposalId) }),
        auditPath,
      };
    } catch (error) {
      if (isErrno(error, "EEXIST")) {
        throw new SelfCapabilityError("conflict", `Skill ${id} already exists.`, { file });
      }
      if (!fileWritten) {
        throw new SelfCapabilityError("write_failed", "Unable to write skill file.", { file, reason: errorToMessage(error) });
      }
      await rollbackSelfCapabilityWrite(settings, file, fileWritten, originalConfig, configWritten);
      throw error;
    }
  });
}

export async function proposeSelfCron(
  settings: SelfCapabilitiesSettings,
  input: SelfCronInput,
  deps: { readonly now?: () => Date } = {},
): Promise<SelfCapabilityPlan> {
  const id = normalizeSlug(input.id, "id");
  const { content } = validatedCronMarkdown(id, input);
  const file = resolveCronFile(settings, id);
  const patch = cronConfigPatch(settings);
  const exists = await pathExists(file);
  const plan = {
    kind: "cron",
    id,
    action: "proposed",
    files: [file],
    ...(patch === undefined ? {} : { configPatch: patch }),
    reloadRequired: false,
    warnings: exists ? [`Cron job ${id} already exists at ${file}.`] : cronWarnings(settings, patch),
    preview: content,
  } satisfies Omit<SelfCapabilityPlan, "proposalId" | "proposalPath">;
  const proposal = await writeProposal(settings, {
    kind: "cron",
    id,
    input,
    files: plan.files,
    ...(patch === undefined ? {} : { configPatch: patch }),
    warnings: plan.warnings,
    preview: content,
  }, deps.now);
  return { ...plan, proposalId: proposal.proposalId, proposalPath: proposal.path };
}

export async function applySelfCron(
  settings: SelfCapabilitiesSettings,
  input: SelfCronApplyInput,
  deps: { readonly now?: () => Date } = {},
): Promise<SelfCapabilityApplyResult> {
  assertApplyMode(settings);
  if (isProposalApplyInput(input)) {
    const proposal = await readCronProposal(settings, input.proposalId);
    return await applySelfCronInput(settings, proposal.input, deps, proposal);
  }
  return await applySelfCronInput(settings, input, deps, undefined);
}

async function applySelfCronInput(
  settings: SelfCapabilitiesSettings,
  input: SelfCronInput,
  deps: { readonly now?: () => Date },
  proposal: SelfCronProposalRecord | undefined,
): Promise<SelfCapabilityApplyResult> {
  const id = normalizeSlug(input.id, "id");
  const { content } = validatedCronMarkdown(id, input);
  return await withSelfCapabilityMutation(settings, async () => {
    const file = resolveCronFile(settings, id);
    const patch = cronConfigPatch(settings);
    const warnings = cronWarnings(settings, patch);
    if (proposal !== undefined) {
      assertProposalMatchesCurrent(proposal, {
        kind: "cron",
        id,
        input,
        files: [file],
        ...(patch === undefined ? {} : { configPatch: patch }),
        warnings,
        preview: content,
      });
    }

    await preflightSelfCapabilityWriteTargets(settings);
    await assertNoSymlinkAncestors(settings.cwd, settings.cronDir, "selfCapabilities.cronDir");
    await mkdir(settings.cronDir, { recursive: true });
    await assertNoSymlinkAncestors(settings.cwd, settings.cronDir, "cron directory");
    const originalConfig = patch === undefined ? undefined : await readFile(settings.configPath, "utf8");
    let fileWritten = false;
    let configWritten = false;
    try {
      await writeFile(file, content, { encoding: "utf8", flag: "wx" });
      fileWritten = true;
      if (patch !== undefined) {
        await writeMonoAgentConfigJson({ path: settings.configPath, patch });
        configWritten = true;
      }
      const auditPath = await writeAudit(settings, {
        kind: "cron",
        id,
        files: [file],
        ...(patch === undefined ? {} : { configPatch: patch }),
        warnings,
        ...(proposal === undefined ? {} : { proposalId: proposal.proposalId, proposalPath: proposalPath(settings, proposal.proposalId) }),
      }, deps.now);
      await requestSelfCapabilitiesReload(settings, "cron", id, deps.now, proposal?.proposalId);
      return {
        kind: "cron",
        id,
        action: "created",
        files: [file],
        ...(patch === undefined ? {} : { configPatch: patch }),
        reloadRequired: true,
        warnings,
        ...(proposal === undefined ? {} : { proposalId: proposal.proposalId, proposalPath: proposalPath(settings, proposal.proposalId) }),
        auditPath,
      };
    } catch (error) {
      if (isErrno(error, "EEXIST")) {
        throw new SelfCapabilityError("conflict", `Cron job ${id} already exists.`, { file });
      }
      if (!fileWritten) {
        throw new SelfCapabilityError("write_failed", "Unable to write cron job file.", { file, reason: errorToMessage(error) });
      }
      await rollbackSelfCapabilityWrite(settings, file, fileWritten, originalConfig, configWritten);
      throw error;
    }
  });
}

export async function readSelfCapabilitiesReloadToken(auditDir: string, reloadNonce?: string): Promise<string> {
  try {
    const raw = await readFile(join(auditDir, SELF_CAPABILITIES_RELOAD_FILE), "utf8");
    const content = reloadNonce === undefined ? raw : reloadRecordsForNonce(raw, reloadNonce);
    if (content.length === 0) {
      return "";
    }
    return createHash("sha256").update(content).digest("hex");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return "";
    }
    throw error;
  }
}

async function writeProposal(
  settings: SelfCapabilitiesSettings,
  record: {
    readonly kind: SelfCapabilityKind;
    readonly id: string;
    readonly input: SelfSkillInput | SelfCronInput;
    readonly files: readonly string[];
    readonly configPatch?: MonoAgentConfigJson;
    readonly warnings: readonly string[];
    readonly preview: string;
  },
  now: (() => Date) | undefined,
): Promise<{ readonly proposalId: string; readonly path: string }> {
  return await withSelfCapabilityMutation(settings, async () => {
    const stamp = timestamp(now);
    const proposalsDir = proposalsPath(settings);
    await mkdir(proposalsDir, { recursive: true });
    await assertNoSymlinkAncestors(settings.cwd, proposalsDir, "selfCapabilities.proposalsDir");
    const contentHash = proposalContentHash(record);
    const baseId = proposalIdBase(stamp, record, contentHash);
    const hashSuffix = contentHash.slice(0, 12);
    const retryPrefix = baseId.slice(0, -hashSuffix.length - 1);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const proposalId = attempt === 0 ? baseId : normalizeProposalId(`${retryPrefix}-${attempt + 1}-${hashSuffix}`);
      const path = proposalPath(settings, proposalId);
      await assertNoSymlinkAncestors(settings.cwd, path, "selfCapabilities.proposalFile");
      const proposalBase = {
        version: 1,
        proposalId,
        contentHash,
        timestamp: stamp,
        cwd: settings.cwd,
        configPath: settings.configPath,
        id: record.id,
        files: record.files,
        ...(record.configPatch === undefined ? {} : { configPatch: record.configPatch }),
        reloadRequired: false,
        warnings: record.warnings,
        preview: record.preview,
      } satisfies SelfCapabilityProposalRecordBase;
      const proposalRecord: SelfCapabilityProposalRecord = record.kind === "skill"
        ? { ...proposalBase, kind: "skill", input: record.input as SelfSkillInput }
        : { ...proposalBase, kind: "cron", input: record.input as SelfCronInput };
      try {
        await writeFile(path, `${JSON.stringify(proposalRecord, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        return { proposalId, path };
      } catch (error) {
        if (isErrno(error, "EEXIST")) {
          continue;
        }
        throw error;
      }
    }
    throw new SelfCapabilityError("conflict", "Unable to allocate a unique self-capability proposal id.", {
      proposalsDir,
      baseId,
    });
  });
}

async function readSkillProposal(settings: SelfCapabilitiesSettings, proposalId: string): Promise<SelfSkillProposalRecord> {
  const proposal = await readProposal(settings, proposalId);
  if (proposal.kind !== "skill") {
    throw new SelfCapabilityError("invalid_input", `Proposal ${proposalId} is a ${proposal.kind} proposal, not a skill proposal.`, {
      proposalId,
      kind: proposal.kind,
    });
  }
  return proposal;
}

async function readCronProposal(settings: SelfCapabilitiesSettings, proposalId: string): Promise<SelfCronProposalRecord> {
  const proposal = await readProposal(settings, proposalId);
  if (proposal.kind !== "cron") {
    throw new SelfCapabilityError("invalid_input", `Proposal ${proposalId} is a ${proposal.kind} proposal, not a cron proposal.`, {
      proposalId,
      kind: proposal.kind,
    });
  }
  return proposal;
}

async function readProposal(settings: SelfCapabilitiesSettings, proposalId: string): Promise<SelfCapabilityProposalRecord> {
  const normalized = normalizeProposalId(proposalId);
  const path = proposalPath(settings, normalized);
  await assertNoSymlinkAncestors(settings.cwd, proposalsPath(settings), "selfCapabilities.proposalsDir");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new SelfCapabilityError("not_found", `Self-capability proposal ${normalized} does not exist.`, {
        proposalId: normalized,
        path,
      });
    }
    throw new SelfCapabilityError("invalid_input", `Unable to read self-capability proposal ${normalized}.`, {
      proposalId: normalized,
      path,
      reason: errorToMessage(error),
    });
  }
  return normalizeProposalRecord(settings, parsed, normalized);
}

function normalizeProposalRecord(
  settings: SelfCapabilitiesSettings,
  value: unknown,
  expectedProposalId: string,
): SelfCapabilityProposalRecord {
  const record = asRecord(value, "proposal");
  const proposalId = stringField(record, "proposalId");
  if (proposalId !== expectedProposalId) {
    throw new SelfCapabilityError("invalid_input", "Self-capability proposal id does not match its file name.", {
      expectedProposalId,
      proposalId,
    });
  }
  if (record.version !== 1) {
    throw new SelfCapabilityError("invalid_input", "Unsupported self-capability proposal version.", {
      proposalId,
      version: record.version,
    });
  }
  if (record.reloadRequired !== false) {
    throw new SelfCapabilityError("invalid_input", "Self-capability proposal reloadRequired must be false.", {
      proposalId,
    });
  }
  const kind = stringField(record, "kind");
  const id = normalizeSlug(stringField(record, "id"), "id");
  const files = stringArrayField(record, "files");
  const warnings = stringArrayField(record, "warnings");
  const contentHash = stringField(record, "contentHash");
  const timestampValue = stringField(record, "timestamp");
  assertProposalIdMatchesFields(proposalId, timestampValue, kind, id, contentHash);
  const cwd = stringField(record, "cwd");
  const configPath = stringField(record, "configPath");
  if (resolve(cwd) !== settings.cwd || resolve(configPath) !== settings.configPath) {
    throw new SelfCapabilityError("invalid_input", "Self-capability proposal belongs to a different agent folder or config file.", {
      proposalId,
      cwd,
      configPath,
    });
  }
  const base = {
    version: 1,
    proposalId: normalizeProposalId(proposalId),
    contentHash,
    timestamp: timestampValue,
    cwd,
    configPath,
    id,
    files,
    ...(isRecord(record.configPatch) ? { configPatch: record.configPatch as MonoAgentConfigJson } : {}),
    reloadRequired: false,
    warnings,
    preview: stringField(record, "preview"),
  } satisfies SelfCapabilityProposalRecordBase;
  if (kind === "skill") {
    const input = skillInputFromProposal(record.input);
    if (normalizeSlug(input.name, "name") !== id) {
      throw new SelfCapabilityError("invalid_input", "Skill proposal id does not match its input name.", {
        proposalId,
        id,
      });
    }
    assertProposalIntegrity({
      proposalId,
      contentHash,
      kind,
      id,
      input,
      files,
      ...(base.configPatch === undefined ? {} : { configPatch: base.configPatch }),
      warnings,
      preview: base.preview,
    });
    return {
      ...base,
      kind,
      input,
    };
  }
  if (kind === "cron") {
    const input = cronInputFromProposal(record.input);
    if (normalizeSlug(input.id, "id") !== id) {
      throw new SelfCapabilityError("invalid_input", "Cron proposal id does not match its input id.", {
        proposalId,
        id,
      });
    }
    assertProposalIntegrity({
      proposalId,
      contentHash,
      kind,
      id,
      input,
      files,
      ...(base.configPatch === undefined ? {} : { configPatch: base.configPatch }),
      warnings,
      preview: base.preview,
    });
    return {
      ...base,
      kind,
      input,
    };
  }
  throw new SelfCapabilityError("invalid_input", "Self-capability proposal kind must be skill or cron.", {
    proposalId,
    kind,
  });
}

async function requestSelfCapabilitiesReload(
  settings: SelfCapabilitiesSettings,
  kind: SelfCapabilityKind,
  id: string,
  now: (() => Date) | undefined,
  proposalId: string | undefined,
): Promise<void> {
  await assertNoSymlinkAncestors(settings.cwd, settings.auditDir, "selfCapabilities.auditDir");
  await mkdir(settings.auditDir, { recursive: true });
  await assertNoSymlinkAncestors(settings.cwd, settings.auditDir, "selfCapabilities.auditDir");
  const reloadPath = join(settings.auditDir, SELF_CAPABILITIES_RELOAD_FILE);
  await assertNoSymlinkAncestors(settings.cwd, reloadPath, "selfCapabilities.reloadFile");
  const record = {
    timestamp: timestamp(now),
    kind,
    id,
    reason: `${kind}:${id}`,
    ...(proposalId === undefined ? {} : { proposalId }),
    ...(settings.reloadNonce === undefined ? {} : { reloadNonce: settings.reloadNonce }),
  };
  await appendFile(reloadPath, `${JSON.stringify(record)}\n`, "utf8");
}

async function preflightSelfCapabilityWriteTargets(settings: SelfCapabilitiesSettings): Promise<void> {
  await assertNoSymlinkAncestors(settings.cwd, settings.auditDir, "selfCapabilities.auditDir");
  await mkdir(settings.auditDir, { recursive: true });
  await assertNoSymlinkAncestors(settings.cwd, settings.auditDir, "selfCapabilities.auditDir");
  const auditDir = join(settings.auditDir, "audit");
  await mkdir(auditDir, { recursive: true });
  await assertNoSymlinkAncestors(settings.cwd, auditDir, "selfCapabilities.auditDir");
  await assertNoSymlinkAncestors(
    settings.cwd,
    join(settings.auditDir, SELF_CAPABILITIES_RELOAD_FILE),
    "selfCapabilities.reloadFile",
  );
}

async function rollbackSelfCapabilityWrite(
  settings: SelfCapabilitiesSettings,
  file: string,
  fileWritten: boolean,
  originalConfig: string | undefined,
  configWritten: boolean,
): Promise<void> {
  if (fileWritten) {
    await rm(file, { force: true });
  }
  if (configWritten && originalConfig !== undefined) {
    await writeFile(settings.configPath, originalConfig, "utf8");
  }
}

async function writeAudit(
  settings: SelfCapabilitiesSettings,
  record: {
    readonly kind: SelfCapabilityKind;
    readonly id: string;
    readonly files: readonly string[];
    readonly configPatch?: MonoAgentConfigJson;
    readonly warnings: readonly string[];
    readonly proposalId?: string;
    readonly proposalPath?: string;
  },
  now: (() => Date) | undefined,
): Promise<string> {
  const stamp = timestamp(now);
  const auditDir = join(settings.auditDir, "audit");
  await assertNoSymlinkAncestors(settings.cwd, auditDir, "selfCapabilities.auditDir");
  await mkdir(auditDir, { recursive: true });
  await assertNoSymlinkAncestors(settings.cwd, auditDir, "selfCapabilities.auditDir");
  const auditPath = join(auditDir, `${stamp.replace(/[:.]/gu, "-")}-${record.kind}-${record.id}.json`);
  await assertNoSymlinkAncestors(settings.cwd, auditPath, "selfCapabilities.auditFile");
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

function proposalsPath(settings: SelfCapabilitiesSettings): string {
  const dir = resolve(settings.auditDir, SELF_CAPABILITIES_PROPOSALS_DIR);
  assertInside(settings.auditDir, dir, "self-capability proposals directory");
  return dir;
}

function proposalPath(settings: SelfCapabilitiesSettings, proposalId: string): string {
  const normalized = normalizeProposalId(proposalId);
  const file = resolve(proposalsPath(settings), `${normalized}.json`);
  assertInside(proposalsPath(settings), file, "self-capability proposal file");
  return file;
}

function proposalIdBase(
  stamp: string,
  record: { readonly kind: SelfCapabilityKind; readonly id: string },
  contentHash: string,
): string {
  const safeStamp = stamp
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalizeProposalId(`${safeStamp}-${record.kind}-${record.id}-${contentHash.slice(0, 12)}`);
}

function assertProposalIdMatchesFields(
  proposalId: string,
  stamp: string,
  kind: string,
  id: string,
  contentHash: string,
): void {
  const hashSuffix = contentHash.slice(0, 12);
  const baseId = proposalIdBase(stamp, { kind: kind as SelfCapabilityKind, id }, contentHash);
  const retryPattern = new RegExp(`^${escapeRegExp(baseId.slice(0, -hashSuffix.length - 1))}-[0-9]+-${hashSuffix}$`, "u");
  if (proposalId !== baseId && !retryPattern.test(proposalId)) {
    throw new SelfCapabilityError("invalid_input", "Self-capability proposal id does not match its saved metadata.", {
      proposalId,
    });
  }
}

function proposalContentHash(record: {
  readonly kind: SelfCapabilityKind;
  readonly id: string;
  readonly input: SelfSkillInput | SelfCronInput;
  readonly files: readonly string[];
  readonly configPatch?: MonoAgentConfigJson;
  readonly warnings: readonly string[];
  readonly preview: string;
}): string {
  const payload = {
    kind: record.kind,
    id: record.id,
    input: record.kind === "skill"
      ? canonicalSkillInput(record.input as SelfSkillInput)
      : canonicalCronInput(record.input as SelfCronInput),
    files: record.files,
    configPatch: record.configPatch ?? null,
    warnings: record.warnings,
    preview: record.preview,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function canonicalSkillInput(input: SelfSkillInput): SelfSkillInput {
  return {
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.activate === undefined ? {} : { activate: input.activate }),
  };
}

function canonicalCronInput(input: SelfCronInput): SelfCronInput {
  return {
    id: input.id,
    expression: input.expression,
    prompt: input.prompt,
    ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
  };
}

function assertProposalIntegrity(record: {
  readonly proposalId: string;
  readonly contentHash: string;
  readonly kind: SelfCapabilityKind;
  readonly id: string;
  readonly input: SelfSkillInput | SelfCronInput;
  readonly files: readonly string[];
  readonly configPatch?: MonoAgentConfigJson;
  readonly warnings: readonly string[];
  readonly preview: string;
}): void {
  const expected = proposalContentHash(record);
  if (record.contentHash !== expected) {
    throw new SelfCapabilityError("invalid_input", "Self-capability proposal content hash does not match its saved payload.", {
      proposalId: record.proposalId,
    });
  }
}

function assertProposalMatchesCurrent(
  proposal: SelfCapabilityProposalRecord,
  current: {
    readonly kind: SelfCapabilityKind;
    readonly id: string;
    readonly input: SelfSkillInput | SelfCronInput;
    readonly files: readonly string[];
    readonly configPatch?: MonoAgentConfigJson;
    readonly warnings: readonly string[];
    readonly preview: string;
  },
): void {
  const currentHash = proposalContentHash(current);
  if (proposal.kind !== current.kind || proposal.id !== current.id || proposal.contentHash !== currentHash) {
    throw new SelfCapabilityError("invalid_input", "Self-capability proposal no longer matches the current config and write targets.", {
      proposalId: proposal.proposalId,
      kind: proposal.kind,
      id: proposal.id,
    });
  }
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

function normalizeProposalId(value: unknown): string {
  if (typeof value !== "string") {
    throw new SelfCapabilityError("invalid_input", "proposalId must be a string.", { field: "proposalId" });
  }
  const proposalId = value.trim().toLowerCase();
  if (!PROPOSAL_ID_PATTERN.test(proposalId)) {
    throw new SelfCapabilityError("invalid_input", "proposalId must be a path-safe proposal id.", {
      field: "proposalId",
      value,
    });
  }
  return proposalId;
}

function normalizeReloadNonce(value: unknown): string {
  if (typeof value !== "string") {
    throw new SelfCapabilityError("invalid_config", "reload nonce must be a string.", { field: "reloadNonce" });
  }
  const nonce = value.trim().toLowerCase();
  if (!PROPOSAL_ID_PATTERN.test(nonce)) {
    throw new SelfCapabilityError("invalid_config", "reload nonce must be path-safe.", { field: "reloadNonce" });
  }
  return nonce;
}

function reloadRecordHasNonce(line: string, reloadNonce: string): boolean {
  if (line.trim().length === 0) {
    return false;
  }
  try {
    const record = JSON.parse(line) as unknown;
    return isRecord(record) && record.reloadNonce === reloadNonce && typeof record.proposalId === "string";
  } catch {
    return false;
  }
}

function reloadRecordsForNonce(raw: string, reloadNonce: string): string {
  return raw
    .split("\n")
    .filter((line) => reloadRecordHasNonce(line, reloadNonce))
    .join("\n");
}

function isProposalApplyInput(value: SelfSkillApplyInput | SelfCronApplyInput): value is SelfProposalApplyInput {
  return typeof (value as { proposalId?: unknown }).proposalId === "string";
}

function skillInputFromProposal(value: unknown): SelfSkillInput {
  const input = asRecord(value, "input");
  return {
    name: stringField(input, "name"),
    description: stringField(input, "description"),
    instructions: stringField(input, "instructions"),
    ...(input.title === undefined ? {} : { title: stringField(input, "title") }),
    ...(input.activate === undefined ? {} : { activate: booleanField(input, "activate") }),
  };
}

function cronInputFromProposal(value: unknown): SelfCronInput {
  const input = asRecord(value, "input");
  return {
    id: stringField(input, "id"),
    expression: stringField(input, "expression"),
    prompt: stringField(input, "prompt"),
    ...(input.timezone === undefined ? {} : { timezone: stringField(input, "timezone") }),
    ...(input.conversationId === undefined ? {} : { conversationId: stringField(input, "conversationId") }),
    ...(input.enabled === undefined ? {} : { enabled: booleanField(input, "enabled") }),
  };
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

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SelfCapabilityError("invalid_input", `${field} must be an object.`, { field });
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SelfCapabilityError("invalid_input", `${field} must be a non-empty string.`, { field });
  }
  return value;
}

function stringArrayField(record: Record<string, unknown>, field: string): readonly string[] {
  const value = record[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new SelfCapabilityError("invalid_input", `${field} must be an array of strings.`, { field });
  }
  return value as readonly string[];
}

function booleanField(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw new SelfCapabilityError("invalid_input", `${field} must be a boolean.`, { field });
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
