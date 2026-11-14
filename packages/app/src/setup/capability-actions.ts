import { createHash } from "node:crypto";
import { lstat, readdir, realpath, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { mergeSettingsJsonPatch, privateTemp, readSettingsJson, readSettingsJsonBackup, restoreGuardedSettingsJson, SettingsJsonError, writeSettingsJson, type SettingsJson } from "@mono-agent/contracts";
import { loadCronAdapterConfig, validateCronExpression } from "@mono-agent/trigger-cron";
import {
  CapabilityActionError, parseCapabilityActionInput, parseCapabilityActionSaveInput,
  type CapabilityActionId, type CapabilityActionInput, type CapabilityActionPreview,
  type CapabilityActionReason, type CapabilityActionsService,
} from "@mono-agent/channel-operator";
import { isAgentToolAllowed, isAgentToolDenied, isAllowAllTools } from "../tools/known-tools.js";
import { validateMonoAgentFolder } from "../doctor/doctor.js";
import type { ValidateMonoAgentFolderOptions } from "../doctor/options.js";
import { CAPABILITY_MODULES } from "./modules/catalog.js";

const processIdentity = () => ({ pid: process.pid, startedAt: new Date(performance.timeOrigin).toISOString() });
const fail = (code: "capability_action_conflict" | "capability_action_unavailable" = "capability_action_unavailable"): never => { throw new CapabilityActionError(code, 409); };
const invalid = (): never => { throw new CapabilityActionError("capability_action_invalid", 409); };
const litePatch = CAPABILITY_MODULES.find((module) => module.id === "memory:lite")!.configFragment({});
const UNDO_PREVIEW_VALUE = "Restore the exact prior file, including its formatting. The one-level slot is consumed; dotenv credentials and memory data are untouched.";

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

const stringList = (value: unknown): readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value as readonly string[] : [];

const deniedAgent = (json: SettingsJson): boolean =>
  isAgentToolDenied(stringList(record(json.tools)?.disallowedTools));

const rawAllowlist = (json: SettingsJson): readonly string[] | undefined => {
  const tools = record(json.tools);
  const list = tools?.allowedTools;
  if (list === undefined) return undefined;
  return Array.isArray(list) && list.every((entry) => typeof entry === "string") ? list as readonly string[] : undefined;
};

/** Delegation with zero definitions still serves general-purpose; Enable never authors profiles. */
const hasConfiguredSubagents = (json: SettingsJson): boolean => record(json.subagents) !== undefined;

const agentAllowedByRawPolicy = (json: SettingsJson): boolean => {
  const list = rawAllowlist(json);
  return isAgentToolAllowed(list ?? ["*"], []);
};

export function createCapabilityActionsService(
  input: ValidateMonoAgentFolderOptions,
  dependencies: { readonly loadedState?: () => { readonly memory: boolean; readonly cron: boolean; readonly subagents?: boolean }; readonly log?: (message: string) => void } = {},
): CapabilityActionsService {
  const identity = processIdentity();
  const assertIdentity = (request: CapabilityActionInput): void => {
    if (request.process.pid !== identity.pid || request.process.startedAt !== identity.startedAt) fail("capability_action_conflict");
  };
  /** One candidate-validation body for both save and Undo, including cron checks. */
  const validateCandidate = async (candidate: SettingsJson, candidatePath: string): Promise<void> => {
    // Driver loaders can bind operator registries. Never validate a candidate through live driver instances.
    const { drivers: _liveDrivers, ...validationInput } = input;
    const candidateInput = { ...validationInput, configPath: candidatePath };
    const report = await validateMonoAgentFolder({ ...candidateInput, allowFilesystemWrites: false, liveness: false, subprocessProbes: false });
    if (!report.structurallyValid) invalid();
    // Cron's loader owns jobs-dir and inline validation even for embedded hosts without drivers.
    const cron = await loadCronAdapterConfig({ env: input.env, json: candidate, cwd: input.cwd });
    if (cron.jobs.some((job) => !validateCronExpression(job.expression, { timezone: job.timezone, hashSeed: job.id }).ok)) invalid();
  };
  /** Probe whether the action's candidate would still validate, so read() never offers an unpublishable action. */
  const candidateValid = async (action: CapabilityActionId, json: SettingsJson): Promise<boolean> => {
    let candidate: SettingsJson;
    let serialized: string;
    if (action === "config-undo") {
      const backup = await readSettingsJsonBackup(input.configPath);
      if (backup.status !== "ok" || backup.backup.previousMissing) return false;
      serialized = Buffer.from(backup.backup.previousBase64, "base64").toString("utf8");
      try {
        const parsed: unknown = serialized.trim().length === 0 ? {} : JSON.parse(serialized);
        if (record(parsed) === undefined) return false;
        candidate = parsed as SettingsJson;
      } catch { return false; }
    } else {
      candidate = mergeSettingsJsonPatch(json, patchFor(action, json));
      serialized = `${JSON.stringify(candidate, null, 2)}\n`;
    }
    const temp = await privateTemp(input.configPath, serialized);
    try {
      await validateCandidate(candidate, temp);
      return true;
    } catch { return false; }
    finally { await unlink(temp).catch(() => undefined); }
  };
  const baseEligibility = async (action: CapabilityActionId, json: SettingsJson, version?: string): Promise<CapabilityActionReason> => {
    if (action === "config-undo") {
      if (version === undefined) {
        const source = await readSettingsJson(input.configPath);
        if (source.missing || source.duplicateKeyPaths.length > 0) return "undo-unavailable";
        return undoFence(source.version);
      }
      return undoFence(version);
    }
    if (action === "subagents-enable") {
      if (deniedAgent(json)) return "subagents-denied";
      if (!hasConfiguredSubagents(json)) return "subagents-unconfigured";
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
  /** Fence only: the current bytes must still hash to the backup's recorded result. */
  const undoFence = async (version: string): Promise<Extract<CapabilityActionReason, "eligible" | "undo-unavailable" | "undo-stale">> => {
    const backup = await readSettingsJsonBackup(input.configPath);
    if (backup.status === "missing" || backup.status === "corrupt" || backup.status === "unreadable" || backup.backup.previousMissing) return "undo-unavailable";
    return version === backup.backup.intendedSha256 ? "eligible" : "undo-stale";
  };
  const eligibility = async (action: CapabilityActionId, json: SettingsJson, version?: string): Promise<CapabilityActionReason> => {
    const reason = await baseEligibility(action, json, version);
    if (reason !== "eligible") return reason;
    // E2 actions recheck the publishable candidate so read() never offers an action its save would refuse.
    if (action === "config-undo" || action === "subagents-enable") {
      return await candidateValid(action, json) ? "eligible" : "candidate-invalid";
    }
    return reason;
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
    if (reason === "candidate-invalid") invalid();
    if (reason !== "eligible" && reason !== "already-configured") fail();
    return {
      ...request, expectedVersion: current.version, normalizesFormatting: request.action !== "config-undo", exactBytes: request.action === "config-undo", noOp: reason === "already-configured",
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
          // An identical digest means there is nothing to restore; refuse rather than publish.
          if (createHash("sha256").update(prior).digest("hex") === checked.expectedVersion) fail("capability_action_conflict");
          const saved = await restoreGuardedSettingsJson(input.configPath, prior, {
            expectedVersion: request.expectedVersion,
            log: dependencies.log ?? ((message) => console.info(message)),
            validate: async (candidate, candidatePath) => {
              // Recheck the fence under the official writer lock, against the original version.
              const current = await source();
              if (current.version !== request.expectedVersion) fail("capability_action_conflict");
              if (await undoFence(current.version) !== "eligible") fail("capability_action_conflict");
              await validateCandidate(candidate, candidatePath);
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
          if (await baseEligibility(request.action, current.json, current.version) !== "eligible") fail();
          await validateCandidate(candidate, candidatePath);
        },
      } });
      return { action: request.action, process: identity, version: saved.version, changed: true };
    }),
  };
}
