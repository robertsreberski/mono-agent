import { createHash } from "node:crypto";
import { resolve } from "node:path";

import * as ui from "../../../ui.js";
import { assertNoLiveConfiguredAgent, memoryRegistryDirs, previewRecallSettings } from "./context.js";
import { MEMORY_FORGET_SCHEMA_VERSION, writeMemoryForgetFailure } from "./forget-failure.js";
import type { MemoryForgetFailureCode } from "./forget-failure.js";
import {
  canonicalProspectivePath,
  hasExactKeys,
  isCanonicalIso,
  isObject,
  isSameOrUnderDirectory,
  isSha256,
  MAX_FORGET_PLAN_BYTES,
  MEMORY_ID_RE,
  memoryRootFingerprint,
  readPinnedFile,
  readPrivateJson,
  writePrivateJsonExclusive,
} from "./private-plan.js";
import { write } from "./render.js";
import { loadBujoModule, loadMemoryRecallModule } from "./store-access.js";
import { INTAKE_REASON_RE } from "./types.js";
import type { MemoryCommandContext, RunMemoryCommandInput } from "./types.js";
const MAX_FORGET_IDS = 32;

interface MemoryForgetPlanPayload {
  readonly schemaVersion: typeof MEMORY_FORGET_SCHEMA_VERSION;
  readonly operation: "forget";
  readonly rootFingerprint: string;
  readonly sourceFingerprint: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly memoryIds: readonly string[];
}

interface MemoryForgetPlan extends MemoryForgetPlanPayload {
  readonly planDigest: string;
}

class MemoryForgetOperationError extends Error {
  constructor(
    readonly code: MemoryForgetFailureCode,
    readonly recovered = false,
    readonly backupPath?: string,
  ) {
    super(code);
  }
}

export async function runMemoryForget(
  context: MemoryCommandContext,
  rest: readonly string[],
  input: RunMemoryCommandInput,
): Promise<number> {
  const operation = rest[0] as "prepare" | "apply" | "restore";
  const memory = context.config.memory;
  if (memory === undefined || memory.mode !== "bujo" || memory.embeddings === undefined) {
    writeMemoryForgetFailure(input.json, operation, "forget_requires_bujo");
    return 1;
  }

  try {
    const bujo = await loadBujoModule();
    const root = bujo.resolveExplicitMemoryForgetRoot(resolve(context.cwd, memory.path));
    if (operation === "prepare") {
      const result = await prepareMemoryForgetPlan(context, root, input);
      write(input.json, result, () => renderMemoryForgetResult(result));
      return 0;
    }
    if (operation === "apply") {
      const result = await applyMemoryForgetPlan(context, root, input.planPath!);
      write(input.json, result, () => renderMemoryForgetResult(result));
      return 0;
    }
    const result = await restoreMemoryForgetBackup(context, root, input.backupPath!);
    write(input.json, result, () => renderMemoryForgetResult(result));
    return 0;
  } catch (error) {
    const failure = error instanceof MemoryForgetOperationError
      ? error
      : new MemoryForgetOperationError(
          operation === "prepare"
            ? "forget_prepare_failed"
            : operation === "restore"
              ? "forget_restore_failed"
              : "forget_apply_failed",
        );
    writeMemoryForgetFailure(input.json, operation, failure.code, failure.recovered, failure.backupPath);
    return 1;
  }
}

async function prepareMemoryForgetPlan(
  context: MemoryCommandContext,
  root: string,
  input: RunMemoryCommandInput,
) {
  const idsFile = resolve(context.cwd, input.idsFile!);
  const planPath = await canonicalProspectivePath(resolve(context.cwd, input.planPath!));
  if (isSameOrUnderDirectory(root, planPath)) {
    throw new MemoryForgetOperationError("forget_prepare_failed");
  }
  const memoryIds = await readMemoryIds(idsFile);
  const bujo = await loadBujoModule();
  bujo.previewCanonicalExplicitForgetMemories(root, memoryIds);

  const payload: MemoryForgetPlanPayload = {
    schemaVersion: MEMORY_FORGET_SCHEMA_VERSION,
    operation: "forget",
    rootFingerprint: memoryRootFingerprint(root),
    sourceFingerprint: bujo.readBujoCanonicalSourceFingerprint(root),
    reason: input.reason!,
    createdAt: new Date().toISOString(),
    memoryIds,
  };
  const plan: MemoryForgetPlan = { ...payload, planDigest: memoryForgetPlanDigest(payload) };
  await writePrivateJsonExclusive(planPath, plan);
  return {
    schemaVersion: MEMORY_FORGET_SCHEMA_VERSION,
    operation: "forget-prepare" as const,
    status: "prepared" as const,
    count: memoryIds.length,
    planPath,
    planDigest: plan.planDigest,
  };
}

async function applyMemoryForgetPlan(
  context: MemoryCommandContext,
  root: string,
  rawPlanPath: string,
) {
  const planPath = resolve(context.cwd, rawPlanPath);
  const canonicalPlanPath = await canonicalProspectivePath(planPath);
  if (isSameOrUnderDirectory(root, canonicalPlanPath)) {
    throw new MemoryForgetOperationError("forget_apply_failed");
  }
  const plan = await readMemoryForgetPlan(planPath);
  const bujo = await loadBujoModule();
  if (plan.rootFingerprint !== memoryRootFingerprint(root)) {
    throw new MemoryForgetOperationError("forget_apply_failed");
  }
  // Preserve the user-facing same-config diagnostic; the package transaction
  // independently enforces the authoritative shared-root writer lease.
  await assertNoLiveConfiguredAgent(context.configPath, await memoryRegistryDirs(context));
  const settings = previewRecallSettings(context.config);
  if (settings === undefined || settings.embeddings === undefined) {
    throw new MemoryForgetOperationError("forget_apply_failed");
  }
  const { createMemoryEmbeddingProvider } = await loadMemoryRecallModule();
  const embeddings = await createMemoryEmbeddingProvider(settings.embeddings);
  try {
    const result = await bujo.applyExplicitMemoryForget({
      root,
      ids: plan.memoryIds,
      expectedRootFingerprint: plan.rootFingerprint,
      expectedSourceFingerprint: plan.sourceFingerprint,
      planDigest: plan.planDigest,
      embeddings,
      dimension: settings.embeddings.dim ?? 768,
    });
    return {
      schemaVersion: MEMORY_FORGET_SCHEMA_VERSION,
      operation: "forget-apply" as const,
      status: "applied" as const,
      count: result.forgotten,
      sourceFingerprint: result.sourceFingerprint,
      backupPath: result.backupPath,
      planDigest: plan.planDigest,
    };
  } catch (error) {
    if (error instanceof bujo.ExplicitMemoryForgetError) {
      if (error.code === "apply_failed_recovered") {
        throw new MemoryForgetOperationError("forget_apply_failed_recovered", true, error.backupPath);
      }
      if (error.code === "apply_recovery_failed") {
        throw new MemoryForgetOperationError("forget_apply_recovery_failed", false, error.backupPath);
      }
    }
    throw new MemoryForgetOperationError("forget_apply_failed");
  }
}

async function restoreMemoryForgetBackup(
  context: MemoryCommandContext,
  root: string,
  rawBackupPath: string,
) {
  const bujo = await loadBujoModule();
  try {
    const result = await bujo.restoreExplicitMemoryForget({
      root,
      backupPath: resolve(context.cwd, rawBackupPath),
      expectedRootFingerprint: memoryRootFingerprint(root),
    });
    return {
      schemaVersion: MEMORY_FORGET_SCHEMA_VERSION,
      operation: "forget-restore" as const,
      status: "restored" as const,
      backupPath: result.backupPath,
      sourceFingerprint: result.sourceFingerprint,
      planDigest: result.planDigest,
    };
  } catch {
    throw new MemoryForgetOperationError("forget_restore_failed");
  }
}

async function readMemoryIds(path: string): Promise<readonly string[]> {
  const raw = await readPinnedFile(path, MAX_FORGET_PLAN_BYTES, false);
  const ids = raw.split(/\r?\n/gu).map((id) => id.trim()).filter((id) => id.length > 0).sort();
  if (ids.length === 0 || ids.length > MAX_FORGET_IDS || new Set(ids).size !== ids.length
    || ids.some((id) => !MEMORY_ID_RE.test(id))) {
    throw new MemoryForgetOperationError("forget_prepare_failed");
  }
  return ids;
}

function memoryForgetPlanDigest(payload: MemoryForgetPlanPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function readMemoryForgetPlan(path: string): Promise<MemoryForgetPlan> {
  const value = await readPrivateJson(path, MAX_FORGET_PLAN_BYTES);
  if (!isObject(value)
    || !hasExactKeys(value, [
      "createdAt",
      "memoryIds",
      "operation",
      "planDigest",
      "reason",
      "rootFingerprint",
      "schemaVersion",
      "sourceFingerprint",
    ])
    || value.schemaVersion !== MEMORY_FORGET_SCHEMA_VERSION
    || value.operation !== "forget"
    || !isSha256(value.rootFingerprint)
    || !isSha256(value.sourceFingerprint)
    || typeof value.reason !== "string" || !INTAKE_REASON_RE.test(value.reason)
    || typeof value.createdAt !== "string" || !isCanonicalIso(value.createdAt)
    || !Array.isArray(value.memoryIds) || value.memoryIds.length === 0
    || value.memoryIds.length > MAX_FORGET_IDS
    || value.memoryIds.some((id) => typeof id !== "string" || !MEMORY_ID_RE.test(id))
    || new Set(value.memoryIds).size !== value.memoryIds.length
    || typeof value.planDigest !== "string" || !isSha256(value.planDigest)) {
    throw new MemoryForgetOperationError("forget_apply_failed");
  }
  const payload: MemoryForgetPlanPayload = {
    schemaVersion: MEMORY_FORGET_SCHEMA_VERSION,
    operation: "forget",
    rootFingerprint: value.rootFingerprint,
    sourceFingerprint: value.sourceFingerprint,
    reason: value.reason,
    createdAt: value.createdAt,
    memoryIds: value.memoryIds as string[],
  };
  if (value.planDigest !== memoryForgetPlanDigest(payload)) {
    throw new MemoryForgetOperationError("forget_apply_failed");
  }
  return { ...payload, planDigest: value.planDigest };
}

function renderMemoryForgetResult(result: {
  readonly operation: string;
  readonly status: string;
  readonly count?: number;
  readonly planPath?: string;
  readonly backupPath?: string;
  readonly sourceFingerprint?: string;
}): string {
  return `${ui.banner("mono-agent memory", result.operation)}\n${ui.keyValue([
    ["status", result.status],
    ...(result.count === undefined ? [] : [["count", String(result.count)] as const]),
    ...(result.planPath === undefined ? [] : [["plan", result.planPath] as const]),
    ...(result.backupPath === undefined ? [] : [["backup", result.backupPath] as const]),
    ...(result.sourceFingerprint === undefined ? [] : [["source fingerprint", result.sourceFingerprint] as const]),
  ])}\n`;
}
