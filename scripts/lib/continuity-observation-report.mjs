import { REASONS, CONTEXTS, COMPACTION_STATUSES, TRIGGERS, PACK_REASONS } from "./continuity-observation-events.mjs";
import { fail, object } from "./continuity-observation-input.mjs";

const count = "count";
const enums = (...values) => ({ enum: values });
const array = (items) => ({ array: items });
const coverage = enums("complete", "partial", "unknown");
const closure = enums("target", "other", "unknown"), soul = enums("default", "custom", "unknown");
const numeric = (fields) => Object.fromEntries(fields.map(k => [k, count]));
export const RECORD_FIELDS = ["messages", "userMessages", "assistantMessages", "systemMessages", "otherMessages", "missingRecords", "invalidRecords", "oversizedRecords", "duplicateRecords", "attachmentReferences", "markers", "unassignedMessages"];
export const WINDOW_STATUSES = ["eligible", "missing_followup", "cancelled", "stratum_changed", "incomplete"];
export const OUTCOME_FIELDS = ["windows", "eligible", "excluded", "reviewed", "unreviewed", "reasks", "corrections", "repeatedEffectCandidates", "confirmedCases", "ambiguousCases"];
export const PACK_FIELDS = ["ownerEntries", "toolEntries", "summaryEntries", "evidenceEntries", "omittedCount", "tokens"];
const distribution = { samples: count, sum: count, min: count, max: count, missing: count };
const cells = (field, values) => array({ [field]: enums(...values), count });
export const EXPORT_ALLOWLIST = {
  inventory: {
    schema: enums("continuity-observation-inventory-v2"), sources: numeric(["web", "sidecar", "journal"]),
    entries: array({ entry: "ordinal", excludedAgentThreads: count }),
    records: numeric(RECORD_FIELDS), auxiliary: {
      sidecarCoverage: enums("supplied", "unknown"), journalCoverage: enums("supplied", "unknown"),
      ...numeric(["sidecarCalls", "sidecarRecords", "continuityRecords", "continuityGenerations", "journalRecords", "journalCompactions", "journalToolCalls", "journalToolResults"]),
    },
    strata: array({ entry: "ordinal", closure, soul, ...numeric(["conversations", "excludedConversations", "turns", "excludedTurns", "cancelledTurns", "windows", "eligibleWindows", "excludedWindows"]) }),
  },
  metrics: { schema: enums("continuity-observation-metrics-v2"), strata: array({ entry: "ordinal", closure, soul,
    boundaries: { coverage, total: count, kinds: cells("kind", ["rollover", "isolated", "resume_replay", "unknown"]), reasons: cells("reason", REASONS), contexts: cells("context", CONTEXTS) },
    compactions: { coverage, total: count, statuses: cells("status", COMPACTION_STATUSES), triggers: cells("trigger", TRIGGERS) },
    packs: { coverage, injected: count, skipped: count, degraded: count, gap: count, boundedSelection: count, unknownDegradation: count, reasons: cells("reason", PACK_REASONS), distributions: Object.fromEntries(PACK_FIELDS.map(k => [k, distribution])) },
    retrieval: { coverage, total: count, actions: cells("action", ["search", "get", "unknown"]), outcomes: cells("outcome", ["success", "error", "unavailable", "unknown"]),
      reconciliation: cells("status", ["not_supplied", "matched", "unmatched", "ambiguous", "conflict"]) },
    followup: { ...numeric(["windows", "observedRetrieval", "noObservedRetrieval", "unknownRetrieval"]), statuses: cells("status", WINDOW_STATUSES) },
  }) },
  outcomes: { schema: enums("continuity-observation-outcomes-v2"), strata: array({ entry: "ordinal", closure, soul, coverage, ...numeric(OUTCOME_FIELDS) }) },
};
// This is also run immediately before serializing. No source-provided key or
// string can enter exports, including report.md, through a generic spread.
export function assertAllowed(value, contract) {
  if (contract === "ordinal") {
    if (!Number.isSafeInteger(value) || value < 1) fail("INVALID_EXPORT");
  } else if (contract === count) {
    if (value !== "unknown" && (!Number.isSafeInteger(value) || value < 0)) fail("INVALID_EXPORT");
  } else if (contract.enum) {
    if (!contract.enum.includes(value)) fail("INVALID_EXPORT");
  } else if (contract.array) {
    if (!Array.isArray(value)) fail("INVALID_EXPORT");
    for (const item of value) assertAllowed(item, contract.array);
  } else {
    if (!object(value) || Object.keys(value).length !== Object.keys(contract).length) fail("INVALID_EXPORT");
    for (const [key, spec] of Object.entries(contract)) {
      if (!Object.hasOwn(value, key)) fail("INVALID_EXPORT");
      assertAllowed(value[key], spec);
    }
  }
}
export function renderReport(reports) {
  for (const [name, contract] of Object.entries(EXPORT_ALLOWLIST)) assertAllowed(reports[name], contract);
  const lines = ["# Continuity observation", "", "Observed counts only; no correctness or population-prevalence claim.", "",
    "Unknown is missing coverage, not zero. Complete coverage is a caller declaration, not independently proven.",
    "Auxiliary snapshots are not globally atomic. Journal counts are separate and never added to web telemetry.",
    "Deduplication is scoped to a turn. Markers are inventory only, not substitutes for telemetry.",
    "Retrieval counts cover top-level web tool-call parts, not nested subagent activity.",
    "Entry ordinals separate agent-bound declarations; no agent identities are exported.",
    "Pack degraded counts include all non-empty flags; gap and boundedSelection separate their meanings.",
    "Follow-up includes later calls in the boundary turn and the next three subsequent owner turns.",
    "Cancelled, unfinished, truncated and stratum-crossing windows are excluded from adjudication.",
    "Review ordinals are local to this exact manifest and its unchanged snapshots. No automated text classification.", ""];
  function table(title, rows) {
    lines.push(`## ${title}`, "", "| Field | Value |", "| --- | --- | ");
    function visit(value, path) {
      if (Array.isArray(value)) value.forEach((v, i) => visit(v, `${path}.${i + 1}`));
      else if (object(value)) for (const [k, v] of Object.entries(value)) visit(v, path ? `${path}.${k}` : k);
      else lines.push(`| ${path} | ${value} |`);
    }
    visit(rows, ""); lines.push("");
  }
  table("Inventory", reports.inventory); table("Metrics", reports.metrics); table("Outcomes", reports.outcomes);
  return `${lines.join("\n")}\n`;
}
