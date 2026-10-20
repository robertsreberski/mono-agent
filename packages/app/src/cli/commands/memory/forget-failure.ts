import * as ui from "../../ui.js";
import { write } from "./render.js";
export const MEMORY_FORGET_SCHEMA_VERSION = 1;

export type MemoryForgetFailureCode =
  | "forget_requires_bujo"
  | "forget_usage"
  | "forget_config_invalid"
  | "forget_prepare_failed"
  | "forget_apply_failed"
  | "forget_apply_failed_recovered"
  | "forget_apply_recovery_failed"
  | "forget_restore_failed";

const MEMORY_FORGET_FAILURE_MESSAGES: Readonly<Record<MemoryForgetFailureCode, string>> = Object.freeze({
  forget_requires_bujo: "Memory forget requires a configured built-in BuJo store with embeddings.",
  forget_usage: "Memory forget arguments are invalid.",
  forget_config_invalid: "Memory forget requires a valid private configuration.",
  forget_prepare_failed: "Forget-plan preparation failed without changing the memory store.",
  forget_apply_failed: "Forget-plan application failed before a recoverable backup was available.",
  forget_apply_failed_recovered: "Forget-plan application failed and the complete pre-apply backup was restored.",
  forget_apply_recovery_failed: "Forget-plan application failed and automatic recovery could not be verified; keep the agent stopped and restore the reported backup manually.",
  forget_restore_failed: "Backup restore was refused or failed; the current memory store was not intentionally overwritten.",
});

export function writeMemoryForgetFailure(
  json: boolean,
  operation: string,
  code: MemoryForgetFailureCode,
  recovered = false,
  backupPath?: string,
): void {
  const safeOperation = operation === "prepare" || operation === "apply" || operation === "restore"
    ? operation
    : "unknown";
  const result = {
    schemaVersion: MEMORY_FORGET_SCHEMA_VERSION,
    operation: `forget-${safeOperation}`,
    status: "failed" as const,
    code,
    message: MEMORY_FORGET_FAILURE_MESSAGES[code],
    ...(recovered ? { recovered: true } : {}),
    ...(backupPath === undefined ? {} : { backupPath }),
  };
  if (json) {
    write(true, result, () => "");
    return;
  }
  process.stderr.write(ui.errorLine(`[${code}] ${result.message}`));
}
