// Closed content-free refusal record. Never persist arbitrary exception fields.
import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "./continuity-observation-input.mjs";
const REFUSAL_CODES = new Set(["E2_CHECKPOINT_ORDER_INVALID", "E2_SIZING_PHASE_REQUIRED", "E2_PROBE_COUNTS_REQUIRED", "E2_PRICING_INVALID", "E2_CATALOG_INVALID", "E2_ESTIMATE_INVALID", "E2_COST_ROLE_INVALID", "E2_SIZING_PAID_ROLE_REQUIRED", "E2_ROUTE_CAPABILITY_UNKNOWN", "E2_OUTPUT_LIMIT_UNENFORCED", "E2_PROOF_TOOL_REFUSED", "E2_ARGUMENTS_INVALID", "INVALID_RECORDED_SOURCE", "INVALID_RECORDED_TOOL", "INVALID_RECORDED_STEP", "INVALID_RECORDED_GAP", "INVALID_RECORDED_INVENTORY", "INVALID_INPUT_PATH", "INPUT_NOT_FILE", "E2_SOURCE_REIMPORT_REQUIRED", "E2_SOURCE_REPLY_REFUSED", "E2_DIAGNOSTICS_REFUSED", "E2_STEER_INVALID", "E2_STEER_REFUSED", "E2_STEER_NOT_DELIVERED", "E2_ESTIMATOR_BUILD_REQUIRED", "E2_PROTOCOL_INVALID", "E2_SOURCE_PARTS_INVALID", "E2_SOUL_MISMATCH", "E2_SUMMARY_ROUTE_INVALID", "E2_MODEL_UNREGISTERED", "E2_COMPACTION_LIMIT", "E2_COMPACTION_LIFECYCLE_INVALID", "E2_COMPACTION_NOT_DURABLE", "E2_SOURCE_REQUEST_LIMIT", "E2_SUMMARY_NOT_AUTHORIZED", "E2_SUMMARY_OPTIONS_INVALID", "E2_SUMMARY_REQUEST_LIMIT", "E2_MODELS_METHOD_REFUSED", "E2_SNAPSHOT_PATH_REFUSED", "E2_SNAPSHOT_MISMATCH", "E2_ASSISTANT_SOURCE_UNAVAILABLE", "E2_OWNER_SOURCE_UNAVAILABLE", "E2_RECORDED_ARGUMENTS_UNAVAILABLE", "E2_TOOL_CALL_MISMATCH", "E2_PROBE_REQUEST_LIMIT", "E2_PROBE_TOOLS_REFUSED", "E2_PROBE_SUMMARY_FORBIDDEN", "E2_HISTORY_DEGRADED", "E2_MODELS_SEAM_REFUSED", "E2_BOUNDARY_MISMATCH", "E2_REPLAY_FAILED", "E2_CHECKPOINT_MODEL_INVALID", "E2_CHECKPOINT_POSITION_INVALID", "E2_PROBE_FAILED", "E2_SCORING_INVALID", "E2_INPUT_TOO_LARGE", "E2_INPUT_INVALID", "RECORDED_OUTPUT_REFUSED", "RECORDED_REPLAY_COVERAGE_GAP", "RECORDED_TOOL_COVERAGE_GAP", "RECORDED_AMBIGUOUS_PARALLEL_GROUP", "RECORDED_TOOL_COLLISION", "EEXIST"]);
const KINDS = new Set(["provider_unavailable", "provider_unavailable_exhausted", "provider_auth", "context_limit", "usage_limit", "process_death", "runtime_error", "cancelled", "cancelled_user", "cancelled_stale", "cancelled_shutdown", "cancelled_signal"]);
const ROUTE_CODES = new Set(["E2_MODEL_UNREGISTERED", "E2_COMPACTION_LIMIT", "E2_COMPACTION_LIFECYCLE_INVALID", "E2_COMPACTION_NOT_DURABLE", "E2_SOURCE_REQUEST_LIMIT", "E2_SUMMARY_NOT_AUTHORIZED", "E2_SUMMARY_OPTIONS_INVALID", "E2_SUMMARY_REQUEST_LIMIT", "E2_MODELS_METHOD_REFUSED", "E2_SOURCE_REPLY_REFUSED", "E2_STEER_INVALID", "E2_STEER_REFUSED", "E2_STEER_NOT_DELIVERED", "E2_TOOL_CALL_MISMATCH", "E2_PROBE_REQUEST_LIMIT", "E2_PROBE_TOOLS_REFUSED", "E2_SOUL_MISMATCH"]);
export const knownRefusalCode = value => REFUSAL_CODES.has(value) ? value : null;
const ordinal = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
export function diagnosticRecord(value = {}) {
  return { turnOrdinal: ordinal(value.turnOrdinal), replyCursor: ordinal(value.replyCursor), replyCount: ordinal(value.replyCount),
    cancelled: value.cancelled === true, aborted: value.aborted === true,
    failureKind: value.failureKind == null ? null : KINDS.has(value.failureKind) ? value.failureKind : "runtime_error",
    routeRefusalCode: ROUTE_CODES.has(value.routeRefusalCode) ? value.routeRefusalCode : null,
    errorName: value.errorName == null ? null : ["TypeError", "RangeError", "Error"].includes(value.errorName) ? value.errorName : "other",
    errorCode: knownRefusalCode(value.errorCode), site: safeSite(value.site) };
}

function safeSite(site) {
  if (typeof site !== "string") return null;
  const match = site.match(/^(scripts\/[A-Za-z0-9._/-]+\.mjs|packages\/[a-z0-9-]+\/dist\/[A-Za-z0-9._/-]+\.js):([1-9][0-9]*)$/);
  if (!match || match[1].split("/").includes("..") || !Number.isSafeInteger(Number(match[2]))) return null;
  try { if (relative(ROOT, realpathSync(`${ROOT}/${match[1]}`)) !== match[1]) return null; } catch { return null; }
  return site;
}
export function errorDiagnostic(error) {
  let site = null;
  if (typeof error?.stack === "string") for (const frame of error.stack.split("\n").slice(1)) {
    const match = frame.match(/(?:\(|\s)((?:file:\/\/\/|\/)[^\r\n]*):([1-9][0-9]*):[0-9]+\)?$/);
    if (!match) continue;
    try {
      const path = match[1].startsWith("file:") ? fileURLToPath(match[1]) : match[1];
      const candidate = safeSite(`${relative(ROOT, path)}:${match[2]}`);
      if (candidate) { site = candidate; break; }
    } catch { /* Not a canonical repository frame. */ }
  }
  return { errorName: error?.name == null ? "other" : ["TypeError", "RangeError", "Error"].includes(error.name) ? error.name : "other",
    errorCode: knownRefusalCode(error?.code), site };
}
