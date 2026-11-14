import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readSettingsJson, readSettingsJsonBackup, restoreGuardedSettingsJson, SettingsJsonError, writeSettingsJson, type SettingsJson } from "@mono-agent/contracts";
import { loadCronAdapterConfig, validateCronExpression } from "@mono-agent/trigger-cron";
import {
  CapabilityActionError, parseCapabilityActionInput, parseCapabilityActionSaveInput,
  type CapabilityActionId, type CapabilityActionInput, type CapabilityActionPreview,
  type CapabilityActionReason, type CapabilityActionsService,
} from "@mono-agent/channel-operator";
import { canonicalToolName, isAllowAllTools } from "../tools/known-tools.js";
import { validateMonoAgentFolder } from "../doctor/doctor.js";
import type { ValidateMonoAgentFolderOptions } from "../doctor/options.js";
import { CAPABILITY_MODULES } from "./modules/catalog.js";

const processIdentity = () => ({ pid: process.pid, startedAt: new Date(performance.timeOrigin).toISOString() });
const fail = (code: "capability_action_conflict" | "capability_action_unavailable" = "capability_action_unavailable"): never => { throw new CapabilityActionError(code, 409); };
const litePatch = CAPABILITY_MODULES.find((module) => module.id === "memory:lite")!.configFragment({});
const UNDO_PREVIEW_VALUE = "Restore the exact prior bytes from the last console save. One level only; dotenv credentials and memory data are untouched.";

/** Never initializes, migrates, repairs, or removes a memory root. */
async function safeLiteRoot(cwd: string): Promise<boolean> {
  const root = resolve(cwd, ".mono-agent/memory");
  try {
    // Refuse symlink ancestors, including the standard parent when the root is absent.
    for (const path of [cwd, dirname(root), root]) {
      try {
        if ((await lstat(path)).isSymbolicLink() || await realpath(path) !== path) return false;
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    }
    const stat = await lstat(root).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (stat === undefined) return true;
    if (!stat.isDirectory()) return false;
    if ((await readdir(root)).length === 0) return true;
    const { auditBujoMemoryHealth } = await import("@mono-agent/memory/bujo");
    const manifestState = async (): Promise<string | undefined> => {
      const stat = await lstat(join(root, ".index/manifest.json")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      return stat === undefined ? undefined : `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    };
    const before = await manifestState();
    const health = auditBujoMemoryHealth({ root, mode: "lite" });
    if (await manifestState() !== before || !health.issues.every((issue) => issue === "runtime_missing" || issue === "runtime_stale")) return false;
    if (before !== undefined) return true; // Strict audit verified the stable manifest's Lite database identity.
    // A legacy root needs explicit SQLite tier metadata too; absence is not proof of Lite.
    const { openMemoryDb } = await import("@mono-agent/memory/store");
    const db = openMemoryDb({ path: join(root, "memory.db"), readOnly: true });
    try { return db.indexMetadata()?.tier === "lite"; } finally { db.close(); }
  } catch { return false; }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const deniedAgent = (json: SettingsJson): boolean =>
  ((record(json.tools)?.disallowedTools as readonly unknown[] | undefined) ?? []).some((entry) => typeof entry === "string" && canonicalToolName(entry) === "Agent");

const rawAllowlist = (json: SettingsJson): readonly string[] | undefined => {
  const tools = record(json.tools);
  const list = tools?.allowedTools;
  if (list === undefined) return undefined;
  return Array.isArray(list) && list.every((entry) => typeof entry === "string") ? list as readonly string[] : undefined;
};

/** Delegation needs configured profiles; Enable never authors them. */
const hasUsableSubagents = (json: SettingsJson): boolean => {
  const subagents = record(json.subagents);
  const definitions = subagents?.definitions;
  return subagents !== undefined && Array.isArray(definitions) && definitions.length > 0 && definitions.every((entry) => record(entry) !== undefined);
};

const agentAllowedByRawPolicy = (json: SettingsJson): boolean => {
  const list = rawAllowlist(json);
  return list === undefined || isAllowAllTools([...list]) || list.includes("Agent");
};

export function createCapabilityActionsService(
  input: ValidateMonoAgentFolderOptions,
  dependencies: { readonly loadedState?: () => { readonly memory: boolean; readonly cron: boolean; readonly subagents?: boolean }; readonly log?: (message: string) => void } = {},
): CapabilityActionsService {
  const identity = processIdentity();
  const assertIdentity = (request: CapabilityActionInput): void => {
    if (request.process.pid !== identity.pid || request.process.startedAt !== identity.startedAt) fail("capability_action_conflict");
  };
  const undoReason = async (json: SettingsJson, version: string): Promise<Extract<CapabilityActionReason, "eligible" | "undo-unavailable" | "undo-stale">> => {
    const backup = await readSettingsJsonBackup(input.configPath);
    if (backup.status === "ok" && !backup.backup.previousMissing) {
      return version === backup.backup.intendedSha256 ? "eligible" : "undo-stale";
    }
    return "undo-unavailable";
  };
  const eligibility = async (action: CapabilityActionId, json: SettingsJson, version?: string): Promise<CapabilityActionReason> => {
    if (action === "config-undo") {
      if (version === undefined) {
        const source = await readSettingsJson(input.configPath);
        if (source.missing || source.duplicateKeyPaths.length > 0) return "undo-unavailable";
        return undoReason(json, source.version);
      }
      return undoReason(json, version);
    }
    if (action === "subagents-enable") {
      if (deniedAgent(json)) return "subagents-denied";
      if (!hasUsableSubagents(json)) return "subagents-unconfigured";
      const subagents = record(json.subagents);
      if (subagents?.enabled === true && agentAllowedByRawPolicy(json)) return "already-configured";
      return "eligible";
    }
    if (action === "memory-lite") {
      const memory = json.memory as { mode?: unknown } | undefined;
      if (memory?.mode === "lite") return "already-configured";
      if (memory !== undefined && (memory === null || typeof memory !== "object" || Array.isArray(memory) || Object.keys(memory).length > 0)) return "memory-configured";
      // Core env variables are ignored today; still refuse shadow-looking settings rather than silently supersede them.
      if (Object.entries(input.env).some(([key, value]) => key.startsWith("MONO_AGENT_MEMORY_") && value?.trim())) return "env-shadowed";
      return await safeLiteRoot(resolve(input.cwd)) ? "eligible" : "memory-root-unsafe";
    }
    if (Object.entries(input.env).some(([key, value]) => key.startsWith("MONO_AGENT_CRON_") && value?.trim())) return "env-shadowed";
    try {
      const cron = await loadCronAdapterConfig({ env: input.env, json, cwd: input.cwd });
      if (cron.jobs.length === 0 || cron.jobs.some((job) => !validateCronExpression(job.expression, { timezone: job.timezone, hashSeed: job.id }).ok)) return "no-valid-jobs";
      return cron.operatorActionsEnabled === true ? "already-configured" : "eligible";
    } catch { return "no-valid-jobs"; }
  };
  const source = async () => {
    const result = await readSettingsJson(input.configPath);
    if (result.missing || result.duplicateKeyPaths.length > 0) fail();
    return result;
  };
  const patchFor = (action: CapabilityActionId, json: SettingsJson): SettingsJson => {
    if (action === "memory-lite") return litePatch as SettingsJson;
    if (action === "cron-controls") return { cron: { operatorActions: { enabled: true } } };
    const patch: SettingsJson = { subagents: { enabled: true } };
    const list = rawAllowlist(json);
    if (list !== undefined && !isAllowAllTools([...list]) && !list.includes("Agent")) {
      (patch as Record<string, unknown>).tools = { allowedTools: [...list, "Agent"] };
    }
    return patch;
  };
  const changesFor = (action: CapabilityActionId, json: SettingsJson): CapabilityActionPreview["changes"] => {
    if (action === "config-undo") return [{ field: "config", value: UNDO_PREVIEW_VALUE }];
    if (action === "subagents-enable") {
      const changes: { readonly field: "subagents.enabled" | "tools.allowedTools"; readonly value: string }[] = [];
      if (record(json.subagents)?.enabled !== true) changes.push({ field: "subagents.enabled", value: "true" });
      const list = rawAllowlist(json);
      if (list !== undefined && !isAllowAllTools([...list]) && !list.includes("Agent")) {
        changes.push({ field: "tools.allowedTools", value: "Append \"Agent\"; existing entries and deny rules are unchanged." });
      }
      return changes;
    }
    return [{ field: action === "memory-lite" ? "memory" : "cron.operatorActions.enabled", value: action === "memory-lite" ? JSON.stringify(litePatch.memory, null, 2) : "true" }];
  };
  const preview = async (request: CapabilityActionInput): Promise<CapabilityActionPreview> => {
    assertIdentity(request);
    const current = await source();
    const reason = await eligibility(request.action, current.json, current.version);
    if (reason === "undo-stale") fail("capability_action_conflict");
    if (reason !== "eligible" && reason !== "already-configured") fail();
    return {
      ...request, expectedVersion: current.version, normalizesFormatting: true, noOp: reason === "already-configured",
      changes: reason === "already-configured" ? [] : changesFor(request.action, current.json),
    };
  };
  const sanitized = async <T>(work: () => Promise<T>): Promise<T> => {
    try { return await work(); }
    catch (error) {
      if (error instanceof CapabilityActionError) throw error;
      if (error instanceof SettingsJsonError && error.code === "config_conflict") fail("capability_action_conflict");
      throw new CapabilityActionError("capability_action_failed", 503);
    }
  };
  return {
    read: () => sanitized(async () => {
      const current = await source();
      const actions = await Promise.all((["memory-lite", "cron-controls", "subagents-enable", "config-undo"] as const).map(async (id) => {
        const reason = await eligibility(id, current.json, current.version);
        const active = dependencies.loadedState?.() ?? { memory: false, cron: false };
        const subagentsActive = active.subagents ?? false;
        return { id, reason, active: id === "memory-lite" ? active.memory : id === "cron-controls" ? active.cron : id === "subagents-enable" ? subagentsActive : false, available: reason === "eligible" || reason === "already-configured" };
      }));
      return { version: 1 as const, process: identity, actions };
    }),
    preview: (raw) => sanitized(() => preview(parseCapabilityActionInput(raw))),
    save: (raw) => sanitized(async () => {
      const request = parseCapabilityActionSaveInput(raw);
      const checked = await preview({ action: request.action, process: request.process });
      if (checked.expectedVersion !== request.expectedVersion) fail("capability_action_conflict");
      if (checked.noOp) return { action: request.action, process: identity, version: checked.expectedVersion, changed: false };
      if (request.action === "config-undo") {
        const backup = await readSettingsJsonBackup(input.configPath);
        if (backup.status === "ok" && !backup.backup.previousMissing) {
          const envelope = backup.backup;
          if (checked.expectedVersion !== envelope.intendedSha256) fail("capability_action_conflict");
          const prior = Buffer.from(envelope.previousBase64, "base64");
          const saved = await restoreGuardedSettingsJson(input.configPath, prior, {
            expectedVersion: request.expectedVersion,
            log: dependencies.log ?? ((message) => console.info(message)),
            validate: async (candidate, candidatePath) => {
              // Recheck the fence under the official writer lock, against the original version.
              const current = await source();
              if (current.version !== request.expectedVersion) fail("capability_action_conflict");
              if (await eligibility(request.action, current.json, current.version) !== "eligible") fail();
              // Driver loaders can bind operator registries. Never validate a candidate through live driver instances.
              const { drivers: _liveDrivers, ...validationInput } = input;
              const candidateInput = { ...validationInput, configPath: candidatePath };
              const report = await validateMonoAgentFolder({ ...candidateInput, allowFilesystemWrites: false, liveness: false, subprocessProbes: false });
              if (!report.structurallyValid) fail();
            },
          });
          return { action: request.action, process: identity, version: saved.version, changed: true };
        }
        fail("capability_action_conflict");
      }
      const saved = await writeSettingsJson({ path: input.configPath, patch: patchFor(request.action, (await source()).json), guarded: {
        expectedVersion: request.expectedVersion,
        log: dependencies.log ?? ((message) => console.info(message)),
        validate: async (candidate, candidatePath) => {
          // Recheck eligibility under the official writer lock, against the original version.
          const current = await source();
          if (current.version !== request.expectedVersion) fail("capability_action_conflict");
          if (await eligibility(request.action, current.json, current.version) !== "eligible") fail();
          // Driver loaders can bind operator registries. Never validate a candidate through live driver instances.
          const { drivers: _liveDrivers, ...validationInput } = input;
          const candidateInput = { ...validationInput, configPath: candidatePath };
          const report = await validateMonoAgentFolder({ ...candidateInput, allowFilesystemWrites: false, liveness: false, subprocessProbes: false });
          if (!report.structurallyValid) fail();
          // Cron's loader owns jobs-dir and inline validation even for embedded hosts without drivers.
          const cron = await loadCronAdapterConfig({ env: input.env, json: candidate, cwd: input.cwd });
          if (cron.jobs.some((job) => !validateCronExpression(job.expression, { timezone: job.timezone, hashSeed: job.id }).ok)) fail();
        },
      } });
      return { action: request.action, process: identity, version: saved.version, changed: true };
    }),
  };
}
