import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readSettingsJson, SettingsJsonError, writeSettingsJson, type SettingsJson } from "@mono-agent/contracts";
import { loadCronAdapterConfig, validateCronExpression } from "@mono-agent/trigger-cron";
import {
  CapabilityActionError, parseCapabilityActionInput, parseCapabilityActionSaveInput,
  type CapabilityActionId, type CapabilityActionInput, type CapabilityActionPreview,
  type CapabilityActionReason, type CapabilityActionsService,
} from "@mono-agent/channel-operator";
import { validateMonoAgentFolder } from "../doctor/doctor.js";
import type { ValidateMonoAgentFolderOptions } from "../doctor/options.js";
import { CAPABILITY_MODULES } from "./modules/catalog.js";

const processIdentity = () => ({ pid: process.pid, startedAt: new Date(performance.timeOrigin).toISOString() });
const fail = (code: "capability_action_conflict" | "capability_action_unavailable" = "capability_action_unavailable"): never => { throw new CapabilityActionError(code, 409); };
const litePatch = CAPABILITY_MODULES.find((module) => module.id === "memory:lite")!.configFragment({});

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

export function createCapabilityActionsService(
  input: ValidateMonoAgentFolderOptions,
  dependencies: { readonly loadedState?: () => { readonly memory: boolean; readonly cron: boolean }; readonly log?: (message: string) => void } = {},
): CapabilityActionsService {
  const identity = processIdentity();
  const assertIdentity = (request: CapabilityActionInput): void => {
    if (request.process.pid !== identity.pid || request.process.startedAt !== identity.startedAt) fail("capability_action_conflict");
  };
  const eligibility = async (action: CapabilityActionId, json: SettingsJson): Promise<CapabilityActionReason> => {
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
  const patchFor = (action: CapabilityActionId): SettingsJson => action === "memory-lite" ? litePatch as SettingsJson : { cron: { operatorActions: { enabled: true } } };
  const preview = async (request: CapabilityActionInput): Promise<CapabilityActionPreview> => {
    assertIdentity(request);
    const current = await source();
    const reason = await eligibility(request.action, current.json);
    if (reason !== "eligible" && reason !== "already-configured") fail();
    return {
      ...request, expectedVersion: current.version, normalizesFormatting: true, noOp: reason === "already-configured",
      changes: reason === "already-configured" ? [] : [{ field: request.action === "memory-lite" ? "memory" : "cron.operatorActions.enabled", value: request.action === "memory-lite" ? JSON.stringify(litePatch.memory, null, 2) : "true" }],
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
      const actions = await Promise.all((["memory-lite", "cron-controls"] as const).map(async (id) => {
        const reason = await eligibility(id, current.json);
        const active = dependencies.loadedState?.() ?? { memory: false, cron: false };
        return { id, reason, active: id === "memory-lite" ? active.memory : active.cron, available: reason === "eligible" || reason === "already-configured" };
      }));
      return { version: 1 as const, process: identity, actions };
    }),
    preview: (raw) => sanitized(() => preview(parseCapabilityActionInput(raw))),
    save: (raw) => sanitized(async () => {
      const request = parseCapabilityActionSaveInput(raw);
      const checked = await preview({ action: request.action, process: request.process });
      if (checked.expectedVersion !== request.expectedVersion) fail("capability_action_conflict");
      if (checked.noOp) return { action: request.action, process: identity, version: checked.expectedVersion, changed: false };
      const saved = await writeSettingsJson({ path: input.configPath, patch: patchFor(request.action), guarded: {
        expectedVersion: request.expectedVersion,
        log: dependencies.log ?? ((message) => console.info(message)),
        validate: async (candidate, candidatePath) => {
          // Recheck eligibility under the official writer lock, against the original version.
          const current = await source();
          if (current.version !== request.expectedVersion) fail("capability_action_conflict");
          if (await eligibility(request.action, current.json) !== "eligible") fail();
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
