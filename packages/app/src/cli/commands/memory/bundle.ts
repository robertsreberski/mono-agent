import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type { MonoAgentConfig } from "@mono-agent/config";
import { effectiveEmbeddingIdentity } from "@mono-agent/memory/search";
import type {
  MemoryBundleExportErrorCode,
  MemoryBundleImportErrorCode,
} from "@mono-agent/memory/bujo";

import * as ui from "../../../ui.js";
import { assertNoLiveConfiguredAgent, memoryRegistryDirs, previewRecallSettings } from "./context.js";
import {
  canonicalProspectivePath,
  hasExactKeys,
  isCanonicalIso,
  isObject,
  isSameOrUnderDirectory,
  isSha256,
  memoryRootFingerprint,
  readPrivateJson,
  writePrivateJsonExclusive,
} from "./private-plan.js";
import { isIntrinsicError, readErrorProperty } from "./read.js";
import type { ErrorPropertyRead } from "./read.js";
import { write } from "./render.js";
import { loadBujoModule, loadMemoryRecallModule } from "./store-access.js";
import type { MemoryCommandContext, RunMemoryCommandInput } from "./types.js";

const MEMORY_BUNDLE_CLI_SCHEMA_VERSION = 1;
const MAX_IMPORT_PLAN_BYTES = 64 * 1024;
const MAX_MEMORY_BUNDLE_CAUSE_DEPTH = 8;

export type BujoModule = typeof import("@mono-agent/memory/bujo");

type MemoryBundleFailureCode =
  | "export_requires_bujo"
  | "export_usage"
  | "export_config_invalid"
  | "export_destination_invalid"
  | "export_pending_work"
  | "export_source_changed"
  | "export_source_invalid"
  | "export_failed"
  | "import_requires_bujo"
  | "import_usage"
  | "import_config_invalid"
  | "import_bundle_invalid"
  | "import_derived_drift"
  | "import_conflict"
  | "import_prepare_failed"
  | "import_pending_work"
  | "import_stale_plan"
  | "import_apply_failed"
  | "import_apply_failed_recovered"
  | "import_apply_recovery_failed"
  | "import_restore_failed";

/**
 * Frozen operator-facing messages. Package errors are never interpolated:
 * they can carry memory text, memory ids, entity names, and absolute paths.
 */
const MEMORY_BUNDLE_FAILURE_MESSAGES: Readonly<Record<MemoryBundleFailureCode, string>> = Object.freeze({
  export_requires_bujo: "Memory export requires a configured built-in BuJo store with embeddings.",
  export_usage: "Memory export arguments are invalid.",
  export_config_invalid: "Memory export requires a valid private configuration.",
  export_destination_invalid: "The bundle destination must be a new directory outside the memory root.",
  export_pending_work: "The memory store has unreplayed durable work; let it drain or re-run with --allow-pending.",
  export_source_changed: "The memory store kept changing during export; retry with the agent idle.",
  export_source_invalid: "The canonical memory source is invalid; repair it before exporting.",
  export_failed: "Memory export failed; no bundle was published.",
  import_requires_bujo: "Memory import requires a configured built-in BuJo store with embeddings.",
  import_usage: "Memory import arguments are invalid.",
  import_config_invalid: "Memory import requires a valid private configuration.",
  import_bundle_invalid: "The bundle failed verification; the memory store was not changed.",
  import_derived_drift: "Importing these entities would remove derived associations from existing memories; re-run with --accept-derived-association-drift to proceed.",
  import_conflict: "Incoming memory ids already exist with different content; re-run with --on-conflict skip to keep this store's versions.",
  import_prepare_failed: "Import-plan preparation failed without changing the memory store.",
  import_pending_work: "The memory store has unreplayed durable work; let it drain, stop the agent, and prepare a fresh plan.",
  import_stale_plan: "The import plan no longer matches this memory store or bundle; prepare a fresh plan.",
  import_apply_failed: "Import application failed before a recoverable backup was available.",
  import_apply_failed_recovered: "Import application failed and the complete pre-import backup was restored.",
  import_apply_recovery_failed: "Import application failed and automatic recovery could not be verified; keep the agent stopped and restore the reported backup manually.",
  import_restore_failed: "Backup restore was refused or failed; the current memory store was not intentionally overwritten.",
});

class MemoryBundleOperationError extends Error {
  constructor(
    readonly code: MemoryBundleFailureCode,
    readonly recovered = false,
    readonly backupPath?: string,
  ) {
    super(code);
    this.name = "MemoryBundleOperationError";
  }
}

interface MemoryImportPlanPayload {
  readonly schemaVersion: typeof MEMORY_BUNDLE_CLI_SCHEMA_VERSION;
  readonly operation: "import";
  readonly rootFingerprint: string;
  readonly destinationSourceFingerprint: string;
  readonly bundlePath: string;
  readonly bundleDigest: string;
  readonly mergeDigest: string;
  readonly mergedSourceFingerprint: string;
  readonly onConflict: "fail" | "skip";
  readonly entityConflict: "target" | "source";
  readonly acceptDerivedAssociationDrift: boolean;
  readonly createdAt: string;
}

interface MemoryImportPlan extends MemoryImportPlanPayload {
  readonly planDigest: string;
}

/** Shared precondition: the built-in BuJo backend with a usable embedding provider. */
function bundleMemorySettings(context: MemoryCommandContext): NonNullable<MonoAgentConfig["memory"]> | undefined {
  const memory = context.config.memory;
  if (memory === undefined || memory.mode !== "bujo" || memory.embeddings === undefined) {
    return undefined;
  }
  return memory;
}

export async function runMemoryBundleExport(
  context: MemoryCommandContext,
  input: RunMemoryCommandInput,
): Promise<number> {
  const memory = bundleMemorySettings(context);
  if (memory === undefined) {
    writeMemoryBundleFailure(input.json, "export", "export_requires_bujo");
    return 1;
  }
  let bujo: BujoModule;
  try {
    bujo = await loadBujoModule();
  } catch {
    writeMemoryBundleFailure(input.json, "export", "export_failed");
    return 1;
  }
  const { MemoryBundleExportError } = bujo;
  try {
    const root = resolve(context.cwd, memory.path);
    const bundlePath = await canonicalProspectivePath(resolve(context.cwd, input.bundlePath!));
    const result = await bujo.exportMemoryBundle({
      root,
      bundlePath,
      scope: input.includeExtras === true ? "canonical+extras" : "canonical",
      ...(input.allowPending === true ? { allowPending: true } : {}),
      // Label the bundle with the identity of the index actually serving the
      // root: a pre-preset index keeps its legacy identity under `auto`.
      ...(memory.embeddings?.model === undefined
        ? {}
        : {
            embeddingModel: effectiveEmbeddingIdentity(
              memory.embeddings,
              bujo.readManagedIndexManifest(root)?.active.embeddingModel
                ?? `${memory.embeddings.provider}:${memory.embeddings.model}`,
            ),
          }),
      dimension: memory.embeddings?.dim ?? 768,
    });
    const published = {
      schemaVersion: MEMORY_BUNDLE_CLI_SCHEMA_VERSION,
      operation: "memory-export" as const,
      status: "exported" as const,
      bundlePath: result.bundlePath,
      scope: result.scope,
      sourceFingerprint: result.sourceFingerprint,
      treeFingerprint: result.treeFingerprint,
      counts: result.counts,
      ...(result.pendingWork ? { pendingWork: true as const } : {}),
    };
    write(input.json, published, () => renderMemoryBundleExport(published));
    return 0;
  } catch (error) {
    writeMemoryBundleFailure(
      input.json,
      "export",
      classifyMemoryBundleExportFailure(MemoryBundleExportError, error),
    );
    return 1;
  }
}

export async function runMemoryBundleImport(
  context: MemoryCommandContext,
  rest: readonly string[],
  input: RunMemoryCommandInput,
): Promise<number> {
  const operation = rest[0] as "prepare" | "apply" | "restore";
  const label = memoryImportOperationLabel(operation);
  const memory = bundleMemorySettings(context);
  if (memory === undefined) {
    writeMemoryBundleFailure(input.json, label, "import_requires_bujo");
    return 1;
  }
  try {
    const bujo = await loadBujoModule();
    // Canonicalize once through the import operation's recovery-aware resolver.
    // Every containment check, fingerprint, and package call below must bind to
    // this same root identity (not a lexical Darwin system alias).
    const root = bujo.resolveMemoryBundleImportRoot(resolve(context.cwd, memory.path));
    if (operation === "prepare") {
      const result = await prepareMemoryImportPlan(context, root, input, bujo);
      write(input.json, result, () => renderMemoryBundleImport(result));
      return 0;
    }
    if (operation === "apply") {
      const result = await applyMemoryImportPlan(context, root, input.planPath!, bujo);
      write(input.json, result, () => renderMemoryBundleImport(result));
      return 0;
    }
    const result = await restoreMemoryImportBackup(context, root, input.backupPath!, bujo);
    write(input.json, result, () => renderMemoryBundleImport(result));
    return 0;
  } catch (error) {
    const failure = error instanceof MemoryBundleOperationError
      ? error
      : new MemoryBundleOperationError(
          operation === "prepare"
            ? "import_prepare_failed"
            : operation === "restore"
              ? "import_restore_failed"
              : "import_apply_failed",
        );
    writeMemoryBundleFailure(input.json, label, failure.code, failure.recovered, failure.backupPath);
    return 1;
  }
}

async function prepareMemoryImportPlan(
  context: MemoryCommandContext,
  root: string,
  input: RunMemoryCommandInput,
  bujo: BujoModule,
) {
  const planPath = await canonicalProspectivePath(resolve(context.cwd, input.planPath!));
  if (isSameOrUnderDirectory(root, planPath)) {
    throw new MemoryBundleOperationError("import_prepare_failed");
  }
  const bundlePath = resolve(context.cwd, input.bundlePath!);
  let preview;
  try {
    preview = bujo.prepareMemoryBundleImport({
      root,
      bundlePath,
      onConflict: input.onConflict ?? "fail",
      entityConflict: input.entityConflict ?? "target",
      acceptDerivedAssociationDrift: input.acceptDerivedAssociationDrift === true,
    });
  } catch (error) {
    throw new MemoryBundleOperationError(classifyImportPrepareFailure(bujo.MemoryBundleImportError, error));
  }

  const payload: MemoryImportPlanPayload = {
    schemaVersion: MEMORY_BUNDLE_CLI_SCHEMA_VERSION,
    operation: "import",
    rootFingerprint: preview.rootFingerprint,
    destinationSourceFingerprint: preview.destinationSourceFingerprint,
    bundlePath: preview.bundlePath,
    bundleDigest: preview.bundleDigest,
    mergeDigest: preview.mergeDigest,
    mergedSourceFingerprint: preview.mergedSourceFingerprint,
    onConflict: preview.onConflict,
    entityConflict: preview.entityConflict,
    acceptDerivedAssociationDrift: input.acceptDerivedAssociationDrift === true,
    createdAt: new Date().toISOString(),
  };
  const plan: MemoryImportPlan = {
    ...payload,
    planDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  };
  await writePrivateJsonExclusive(planPath, plan);
  return {
    schemaVersion: MEMORY_BUNDLE_CLI_SCHEMA_VERSION,
    operation: "memory-import-prepare" as const,
    status: "prepared" as const,
    planPath,
    planDigest: plan.planDigest,
    counts: preview.counts,
    // Counts only: entity ids and memory ids never enter the operator plan.
    derivedAssociationsAdded: preview.derivedAssociationsAdded.length,
    derivedAssociationsRemoved: preview.derivedAssociationsRemoved.length,
    ...(preview.bundlePendingWork ? { bundlePendingWork: true } : {}),
  };
}

async function applyMemoryImportPlan(
  context: MemoryCommandContext,
  root: string,
  rawPlanPath: string,
  bujo: BujoModule,
) {
  const planPath = resolve(context.cwd, rawPlanPath);
  if (isSameOrUnderDirectory(root, await canonicalProspectivePath(planPath))) {
    throw new MemoryBundleOperationError("import_apply_failed");
  }
  const plan = await readMemoryImportPlan(planPath);
  if (plan.rootFingerprint !== memoryRootFingerprint(root)) {
    throw new MemoryBundleOperationError("import_stale_plan");
  }
  // Preserve the user-facing same-config diagnostic; the package transaction
  // independently enforces the authoritative shared-root writer lease.
  await assertNoLiveConfiguredAgent(context.configPath, await memoryRegistryDirs(context));
  const settings = previewRecallSettings(context.config);
  if (settings === undefined || settings.embeddings === undefined) {
    throw new MemoryBundleOperationError("import_config_invalid");
  }
  const { createMemoryEmbeddingProvider } = await loadMemoryRecallModule();
  const embeddings = await createMemoryEmbeddingProvider(settings.embeddings);
  try {
    const result = await bujo.applyMemoryBundleImport({
      root,
      bundlePath: plan.bundlePath,
      expectedRootFingerprint: plan.rootFingerprint,
      expectedSourceFingerprint: plan.destinationSourceFingerprint,
      expectedBundleDigest: plan.bundleDigest,
      expectedMergeDigest: plan.mergeDigest,
      expectedMergedSourceFingerprint: plan.mergedSourceFingerprint,
      planDigest: plan.planDigest,
      onConflict: plan.onConflict,
      entityConflict: plan.entityConflict,
      acceptDerivedAssociationDrift: plan.acceptDerivedAssociationDrift,
      embeddings,
      dimension: settings.embeddings.dim ?? 768,
    });
    return {
      schemaVersion: MEMORY_BUNDLE_CLI_SCHEMA_VERSION,
      operation: "memory-import-apply" as const,
      status: "applied" as const,
      imported: result.imported,
      skipped: result.skipped,
      identical: result.identical,
      sourceFingerprint: result.sourceFingerprint,
      backupPath: result.backupPath,
      planDigest: plan.planDigest,
      rollbackRetained: false,
    };
  } catch (error) {
    throw new MemoryBundleOperationError(...classifyImportApplyFailure(bujo, error));
  }
}

async function restoreMemoryImportBackup(
  context: MemoryCommandContext,
  root: string,
  rawBackupPath: string,
  bujo: BujoModule,
) {
  const backupPath = resolve(context.cwd, rawBackupPath);
  await assertNoLiveConfiguredAgent(context.configPath, await memoryRegistryDirs(context));
  try {
    const result = await bujo.restoreMemoryBundleImport({
      root,
      backupPath,
      expectedRootFingerprint: memoryRootFingerprint(root),
    });
    return {
      schemaVersion: MEMORY_BUNDLE_CLI_SCHEMA_VERSION,
      operation: "memory-import-restore" as const,
      status: "restored" as const,
      sourceFingerprint: result.sourceFingerprint,
      backupPath: result.backupPath,
      planDigest: result.planDigest,
    };
  } catch {
    throw new MemoryBundleOperationError("import_restore_failed");
  }
}

export function classifyMemoryBundleExportFailure(
  MemoryBundleExportError: BujoModule["MemoryBundleExportError"],
  error: unknown,
): MemoryBundleFailureCode {
  if (!(error instanceof MemoryBundleExportError)) return "export_failed";
  return classifyMemoryBundleExportCode(error.code);
}

function classifyMemoryBundleExportCode(code: MemoryBundleExportErrorCode): MemoryBundleFailureCode {
  switch (code) {
    case "export_destination_invalid":
    case "export_pending_work":
    case "export_source_changed":
    case "export_source_invalid":
    case "export_failed":
      return code;
    default:
      return unexpectedMemoryBundleExportCode(code);
  }
}

function unexpectedMemoryBundleExportCode(_code: never): "export_failed" {
  return "export_failed";
}

export function classifyImportPrepareFailure(
  MemoryBundleImportError: BujoModule["MemoryBundleImportError"],
  error: unknown,
): MemoryBundleFailureCode {
  if (!(error instanceof MemoryBundleImportError)) return "import_prepare_failed";
  const code: MemoryBundleImportErrorCode = error.code;
  switch (code) {
    case "import_derived_drift":
      return "import_derived_drift";
    case "import_bundle_invalid":
    case "import_bundle_incompatible":
      return "import_bundle_invalid";
    case "import_prepare_failed":
      return hasExplicitCauseCode(error, "id_conflict") ? "import_conflict" : "import_prepare_failed";
    case "import_pending_work":
    case "import_stale_plan":
    case "import_apply_failed":
    case "import_apply_failed_recovered":
    case "import_apply_recovery_failed":
    case "import_restore_failed":
      return "import_prepare_failed";
    default:
      return unexpectedImportPrepareCode(code);
  }
}

function unexpectedImportPrepareCode(_code: never): "import_prepare_failed" {
  return "import_prepare_failed";
}

export function classifyImportApplyFailure(
  bujo: Pick<BujoModule, "MemoryBundleImportError">,
  error: unknown,
): [MemoryBundleFailureCode, boolean, string | undefined] {
  if (error instanceof bujo.MemoryBundleImportError) {
    const code: MemoryBundleImportErrorCode = error.code;
    switch (code) {
      case "import_apply_failed_recovered":
        return ["import_apply_failed_recovered", true, error.backupPath];
      case "import_apply_recovery_failed":
        return ["import_apply_recovery_failed", false, error.backupPath];
      case "import_stale_plan":
        return ["import_stale_plan", false, undefined];
      case "import_derived_drift":
        return ["import_derived_drift", false, undefined];
      case "import_bundle_invalid":
      case "import_bundle_incompatible":
        return ["import_bundle_invalid", false, undefined];
      case "import_pending_work":
        return ["import_pending_work", false, undefined];
      case "import_apply_failed":
      case "import_prepare_failed":
      case "import_restore_failed":
        return ["import_apply_failed", false, undefined];
      default:
        return unexpectedImportApplyCode(code);
    }
  }
  return ["import_apply_failed", false, undefined];
}

function unexpectedImportApplyCode(
  _code: never,
): ["import_apply_failed", false, undefined] {
  return ["import_apply_failed", false, undefined];
}

function hasExplicitCauseCode(error: Error, expectedCode: string): boolean {
  const seen = new Set<Error>();
  let current = readErrorProperty(error, "cause");
  for (let depth = 0; depth < MAX_MEMORY_BUNDLE_CAUSE_DEPTH; depth += 1) {
    if (!current.ok || !isIntrinsicError(current.value) || seen.has(current.value)) return false;
    const candidate = current.value;
    seen.add(candidate);
    const code = readOwnErrorCode(candidate);
    if (code.ok && code.value === expectedCode) return true;
    current = readErrorProperty(candidate, "cause");
  }
  return false;
}

function readOwnErrorCode(error: Error): ErrorPropertyRead {
  try {
    if (!Object.prototype.hasOwnProperty.call(error, "code")) return { ok: true, value: undefined };
  } catch {
    return { ok: false };
  }
  return readErrorProperty(error, "code");
}

async function readMemoryImportPlan(path: string): Promise<MemoryImportPlan> {
  const value = await readPrivateJson(path, MAX_IMPORT_PLAN_BYTES);
  if (!isObject(value)
    || !hasExactKeys(value, [
      "acceptDerivedAssociationDrift",
      "bundleDigest",
      "bundlePath",
      "createdAt",
      "destinationSourceFingerprint",
      "entityConflict",
      "mergeDigest",
      "mergedSourceFingerprint",
      "onConflict",
      "operation",
      "planDigest",
      "rootFingerprint",
      "schemaVersion",
    ])
    || value.schemaVersion !== MEMORY_BUNDLE_CLI_SCHEMA_VERSION
    || value.operation !== "import"
    || !isSha256(value.rootFingerprint)
    || !isSha256(value.destinationSourceFingerprint)
    || typeof value.bundlePath !== "string"
    || !isSha256(value.bundleDigest)
    || !isSha256(value.mergeDigest)
    || !isSha256(value.mergedSourceFingerprint)
    || (value.onConflict !== "fail" && value.onConflict !== "skip")
    || (value.entityConflict !== "target" && value.entityConflict !== "source")
    || typeof value.acceptDerivedAssociationDrift !== "boolean"
    || typeof value.createdAt !== "string" || !isCanonicalIso(value.createdAt)
    || !isSha256(value.planDigest)) {
    throw new MemoryBundleOperationError("import_stale_plan");
  }
  const plan = value as unknown as MemoryImportPlan;
  const { planDigest, ...payload } = plan;
  if (createHash("sha256").update(JSON.stringify(payload)).digest("hex") !== planDigest) {
    throw new MemoryBundleOperationError("import_stale_plan");
  }
  return plan;
}

export function memoryImportOperationLabel(operation: string | undefined):
  "import-prepare" | "import-apply" | "import-restore" | "import-unknown" {
  return operation === "prepare" || operation === "apply" || operation === "restore"
    ? `import-${operation}`
    : "import-unknown";
}

export function writeMemoryBundleFailure(
  json: boolean,
  operation: string,
  code: MemoryBundleFailureCode,
  recovered = false,
  backupPath?: string,
): void {
  const safeOperation = operation === "export"
    || operation === "import-prepare"
    || operation === "import-apply"
    || operation === "import-restore"
    || operation === "import-unknown"
    ? operation
    : "import-unknown";
  const result = {
    schemaVersion: MEMORY_BUNDLE_CLI_SCHEMA_VERSION,
    operation: `memory-${safeOperation}`,
    status: "failed" as const,
    code,
    message: MEMORY_BUNDLE_FAILURE_MESSAGES[code],
    ...(recovered ? { recovered: true } : {}),
    ...(backupPath === undefined ? {} : { backupPath }),
  };
  if (json) {
    write(true, result, () => "");
    return;
  }
  process.stderr.write(ui.errorLine(`[${code}] ${result.message}`));
}

function renderMemoryBundleExport(result: {
  readonly bundlePath: string;
  readonly scope: string;
  readonly sourceFingerprint: string;
  readonly counts: {
    readonly memories: number;
    readonly dailyFiles: number;
    readonly graphEntities: number;
  };
  readonly pendingWork?: true;
}): string {
  return `${ui.banner("mono-agent memory", "export")}\n${ui.keyValue([
    ["bundle", result.bundlePath],
    ["scope", result.scope],
    ["memories", String(result.counts.memories)],
    ["daily files", String(result.counts.dailyFiles)],
    ["entities", String(result.counts.graphEntities)],
    ["source fingerprint", result.sourceFingerprint],
    ...(result.pendingWork === true ? [["pending work", "yes"] as const] : []),
  ])}\n`;
}

function renderMemoryBundleImport(result: {
  readonly operation: string;
  readonly status: string;
  readonly planPath?: string;
  readonly backupPath?: string;
  readonly sourceFingerprint?: string;
  readonly imported?: number;
  readonly skipped?: number;
  readonly identical?: number;
  readonly counts?: { readonly newMemories: number; readonly conflictingMemories: number };
  readonly derivedAssociationsAdded?: number;
  readonly derivedAssociationsRemoved?: number;
}): string {
  return `${ui.banner("mono-agent memory", result.operation)}\n${ui.keyValue([
    ["status", result.status],
    ...(result.counts === undefined ? [] : [["new memories", String(result.counts.newMemories)] as const]),
    ...(result.counts === undefined ? [] : [["conflicts", String(result.counts.conflictingMemories)] as const]),
    ...(result.derivedAssociationsAdded === undefined
      ? []
      : [["derived associations +/-",
          `${result.derivedAssociationsAdded}/${result.derivedAssociationsRemoved ?? 0}`] as const]),
    ...(result.imported === undefined ? [] : [["imported", String(result.imported)] as const]),
    ...(result.skipped === undefined ? [] : [["skipped", String(result.skipped)] as const]),
    ...(result.identical === undefined ? [] : [["identical", String(result.identical)] as const]),
    ...(result.planPath === undefined ? [] : [["plan", result.planPath] as const]),
    ...(result.backupPath === undefined ? [] : [["backup", result.backupPath] as const]),
    ...(result.sourceFingerprint === undefined ? [] : [["source fingerprint", result.sourceFingerprint] as const]),
  ])}\n`;
}
