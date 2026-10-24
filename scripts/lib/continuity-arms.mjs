// Conversation-continuity benchmark arms.
//
// An arm is DATA, not code: which production boundary the probe turn crosses,
// the production config patch that produces it, and the evidence each sample
// must show. The runner merges `probeConfig` (and `midCheckpoint.config`) into
// a mono-agent config JSON that production `resolveJsonMonoAgentConfig`
// resolves and `createConfiguredConversationHarness` serves. Nothing here
// reimplements context assembly, cold replay or compaction.
//
// Arms for features that do not exist yet are declared with their intended
// patch and evidence but `available: false`; selecting one fails plan creation
// with `arm_not_available_at_revision:<id>` instead of running silently.

/**
 * Smallest proactive trigger the production policy clamps allow:
 * window 32,000 (minimum), ratio 0.2 (minimum) -> 6,400-token trigger, with the
 * minimum 4,000-token recent tail. Cooldown 0 keeps every summary attempt
 * independent of earlier failures in the same process.
 */
export const SMALL_PROACTIVE_COMPACTION = Object.freeze({
  triggerRatio: 0.2,
  contextWindowOverride: 32000,
  keepRecentTokens: 4000,
  minSavingsTokens: 1000,
  failureCooldownMs: 0,
});
/** The merged production default absolute ceiling (`runtime.compaction.maxInputTokens`). */
export const DEFAULT_MAX_INPUT_TOKENS = 200_000;

export const BASELINE_ARM = "native";
export const NOT_AVAILABLE = "not available at this revision";

const runtime = (patch) => Object.freeze({ runtime: Object.freeze(patch) });

export const ARMS = Object.freeze([
  Object.freeze({
    id: "native",
    label: "(a) full native context",
    description: "Scripted history is replayed into the reader's own durable Pi session; each probe resumes that native transcript (tool calls and results included). The default 200k proactive ceiling is disabled so the probe crosses no boundary.",
    available: true, families: ["original", "long"],
    replayBinding: "reader", midCheckpoint: null, restart: false,
    probeConfig: runtime({ compaction: { maxInputTokens: 0 } }),
    expect: Object.freeze({ probeBoundary: null, probeCompactions: 0, midCompactions: 0 }),
    pressure: Object.freeze([{ metric: "probeInputTokens", min: 150_000 }]),
  }),
  Object.freeze({
    id: "cold-rebuild",
    label: "(b) cold model-change rebuild",
    description: "History is bound to a different configured model; the probe turn runs on the reader model, so the production default model-change path reseeds from canonical text (last 64 messages) plus the bounded tool-history projection.",
    available: true, families: ["original", "long"],
    replayBinding: "alternate", midCheckpoint: null, restart: false,
    probeConfig: Object.freeze({}),
    expect: Object.freeze({ probeBoundary: "model_change", probeCompactions: 0, midCompactions: 0 }),
    pressure: Object.freeze([{ metric: "replayedMessages", min: 64 }, { metric: "projectionDroppedRecords", min: 32 }]),
  }),
  Object.freeze({
    id: "compaction-1",
    label: "(c) one proactive compaction",
    description: "Native session as in (a); the probe turn runs with the smallest runtime.compaction trigger so production proactive compaction summarizes the history before answering (one summary per probe).",
    available: true, families: ["original", "long"],
    replayBinding: "reader", midCheckpoint: null, restart: false,
    probeConfig: runtime({ compaction: SMALL_PROACTIVE_COMPACTION }),
    expect: Object.freeze({ probeBoundary: null, probeCompactions: 1, midCompactions: 0 }),
    pressure: Object.freeze([{ metric: "compactionTokensBefore", min: 150_000 }]),
  }),
  Object.freeze({
    id: "compaction-2",
    label: "(d) two successive compactions",
    description: "A promptless manual compaction (the same guarded production summary driver, no live reply) runs before the designated mid-trace turn; scripted history continues; the probe turn compacts proactively again.",
    available: true, families: ["original", "long"],
    replayBinding: "reader",
    midCheckpoint: Object.freeze({ kind: "manual-compaction", config: runtime({ compaction: SMALL_PROACTIVE_COMPACTION }) }),
    restart: false,
    probeConfig: runtime({ compaction: SMALL_PROACTIVE_COMPACTION }),
    expect: Object.freeze({ probeBoundary: null, probeCompactions: 1, midCompactions: 1 }),
    pressure: Object.freeze([{ metric: "midCompactionTokensBefore", min: 80_000 }, { metric: "compactionTokensBefore", min: 40_000 }]),
  }),
  Object.freeze({
    id: "ceiling",
    label: "(e) default 200k ceiling",
    description: "Native session with production default compaction: the merged runtime.compaction.maxInputTokens ceiling (200k) is reached naturally by the long trace and compacts before the probe answers.",
    available: true, families: ["long"],
    replayBinding: "reader", midCheckpoint: null, restart: false,
    probeConfig: Object.freeze({}),
    expect: Object.freeze({ probeBoundary: null, probeCompactions: 1, midCompactions: 0 }),
    pressure: Object.freeze([{ metric: "compactionTokensBefore", min: DEFAULT_MAX_INPUT_TOKENS }]),
  }),
  Object.freeze({
    id: "restart-switch-compact",
    label: "(f) restart + model switch + compaction",
    description: "History bound to the alternate model; the probe runs in a fresh process (restart over the durable roots), on the reader model (production model-change reseed), with the smallest proactive trigger (compaction of the reseeded context), in that order.",
    available: true, families: ["original", "long"],
    replayBinding: "alternate", midCheckpoint: null, restart: true,
    probeConfig: runtime({ compaction: SMALL_PROACTIVE_COMPACTION }),
    expect: Object.freeze({ probeBoundary: "model_change", probeCompactions: 1, midCompactions: 0 }),
    pressure: Object.freeze([{ metric: "replayedMessages", min: 64 }, { metric: "projectionDroppedRecords", min: 32 }]),
  }),
  // Planned continuity-state arms (B children). Patches and evidence are the
  // intended contract; they stay unavailable until the production feature lands.
  Object.freeze({
    id: "continuity-store",
    label: "(B) continuity store",
    description: "Durable continuity store recording constraints, identifiers, commitments and artifacts alongside canonical history; cold rebuild reads it.",
    available: false, unavailableReason: NOT_AVAILABLE, families: ["original", "long"],
    replayBinding: "alternate", midCheckpoint: null, restart: false,
    probeConfig: runtime({ continuity: { store: { enabled: true } } }),
    expect: Object.freeze({ probeBoundary: "model_change", probeCompactions: 0, midCompactions: 0, evidence: ["continuity_store_read"] }),
    pressure: Object.freeze([{ metric: "replayedMessages", min: 64 }]),
  }),
  Object.freeze({
    id: "continuity-pack-boundary",
    label: "(B) continuity pack at boundaries",
    description: "Continuity pack injected only when a boundary (reseed or compaction) occurs.",
    available: false, unavailableReason: NOT_AVAILABLE, families: ["original", "long"],
    replayBinding: "reader", midCheckpoint: null, restart: false,
    probeConfig: runtime({ continuity: { store: { enabled: true }, pack: { inject: "boundary" } }, compaction: SMALL_PROACTIVE_COMPACTION }),
    expect: Object.freeze({ probeBoundary: null, probeCompactions: 1, midCompactions: 0, evidence: ["continuity_pack_injected"] }),
    pressure: Object.freeze([{ metric: "compactionTokensBefore", min: 60_000 }]),
  }),
  Object.freeze({
    id: "continuity-pack-per-turn",
    label: "(B) continuity pack every turn",
    description: "Continuity pack injected on every turn regardless of boundaries.",
    available: false, unavailableReason: NOT_AVAILABLE, families: ["original", "long"],
    replayBinding: "reader", midCheckpoint: null, restart: false,
    probeConfig: runtime({ continuity: { store: { enabled: true }, pack: { inject: "per-turn" } }, compaction: SMALL_PROACTIVE_COMPACTION }),
    expect: Object.freeze({ probeBoundary: null, probeCompactions: 1, midCompactions: 0, evidence: ["continuity_pack_injected"] }),
    pressure: Object.freeze([{ metric: "compactionTokensBefore", min: 60_000 }]),
  }),
  Object.freeze({
    id: "pack+stubs",
    label: "(B) continuity pack + tool-result stubs",
    description: "Boundary continuity pack plus stubbed historical tool results that keep identifiers and status but drop bulk.",
    available: false, unavailableReason: NOT_AVAILABLE, families: ["original", "long"],
    replayBinding: "reader", midCheckpoint: null, restart: false,
    probeConfig: runtime({ continuity: { store: { enabled: true }, pack: { inject: "boundary" }, toolResultStubs: true }, compaction: SMALL_PROACTIVE_COMPACTION }),
    expect: Object.freeze({ probeBoundary: null, probeCompactions: 1, midCompactions: 0, evidence: ["continuity_pack_injected", "tool_result_stubbed"] }),
    pressure: Object.freeze([{ metric: "compactionTokensBefore", min: 60_000 }]),
  }),
]);

export const ARM_IDS = Object.freeze(ARMS.map((arm) => arm.id));
export const AVAILABLE_ARM_IDS = Object.freeze(ARMS.filter((arm) => arm.available).map((arm) => arm.id));
/** The four arms of the original (#1334) plan, kept for comparability reruns. */
export const ORIGINAL_ARM_IDS = Object.freeze(["native", "cold-rebuild", "compaction-1", "compaction-2"]);
export const DEFAULT_ARMS = Object.freeze({
  original: ORIGINAL_ARM_IDS,
  hard: Object.freeze(["native", "cold-rebuild", "compaction-1", "compaction-2", "ceiling", "restart-switch-compact"]),
});

export function armById(id) {
  const arm = ARMS.find((candidate) => candidate.id === id);
  if (arm === undefined) throw new Error("unknown_arm");
  return arm;
}

/** Refuse unavailable arms and arms that cannot apply to the selected trace family. */
export function assertRunnableArms(ids, families) {
  for (const id of ids) {
    const arm = armById(id);
    if (!arm.available) throw new Error(`arm_not_available_at_revision:${id}`);
    for (const family of families) if (!arm.families.includes(family)) throw new Error(`arm_not_applicable_to_family:${id}:${family}`);
  }
}

/**
 * A checkpoint without a live or summarized step is deterministic scripted
 * state, so every repeat of that arm reuses it. A mid-trace compaction makes it
 * repeat-specific. Arms never share a checkpoint: probes forked from one share a
 * provider session identity and are therefore never run concurrently.
 */
export function checkpointKey(arm, repeat) {
  return arm.midCheckpoint === null ? `scripted-${arm.id}` : `mid-${arm.id}-r${repeat}`;
}

/** Plain-JSON deep merge for config patches (arrays and scalars replace). */
export function mergePatch(base, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = { ...(base !== null && typeof base === "object" && !Array.isArray(base) ? base : {}) };
  for (const [key, value] of Object.entries(patch)) out[key] = mergePatch(out[key], value);
  return out;
}

/**
 * Verify that the probe (or mid-trace step) actually crossed the arm's boundary.
 * A sample that did not is excluded from accuracy and reported separately —
 * a missing compaction or reseed is never scored as if it happened.
 */
export function verifyBoundary(expected, observed) {
  const reasons = [];
  const replays = observed.boundaries.filter((boundary) => boundary.kind === "resume_replay");
  if (expected.boundary === null) {
    if (replays.length > 0) reasons.push(`unexpected_resume_replay:${replays.map((row) => row.reason ?? "unknown").join(",")}`);
  } else {
    const matching = replays.filter((row) => row.reason === expected.boundary && row.context !== "retained");
    if (matching.length !== 1 || replays.length !== 1) reasons.push(`expected_one_${expected.boundary}_got_${replays.length}`);
  }
  const succeeded = observed.compactions.filter((row) => row.status === "succeeded").length;
  const failed = observed.compactions.filter((row) => !["running", "succeeded"].includes(row.status)).length;
  if (succeeded !== expected.compactions) reasons.push(`expected_${expected.compactions}_compactions_got_${succeeded}`);
  if (failed > 0) reasons.push(`compaction_not_succeeded:${failed}`);
  if (expected.restart === true && observed.restart?.processRestart !== true) reasons.push("expected_process_restart");
  return { verified: reasons.length === 0, reasons };
}

/** Per-sample pressure metrics from observed evidence (null when not observable). */
export function pressureMetrics(observed, { usage, traceToolRecords, mid = null }) {
  const replay = observed.boundaries.find((row) => row.kind === "resume_replay");
  const before = observed.compactions.filter((row) => row.status === "succeeded").map((row) => row.tokensBefore).filter((value) => typeof value === "number");
  const sum = (...values) => (values.some((value) => typeof value !== "number") ? null : values.reduce((a, b) => a + b, 0));
  return {
    probeInputTokens: usage ? sum(usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens) : null,
    compactionTokensBefore: before.length ? Math.max(...before) : null,
    midCompactionTokensBefore: typeof mid?.tokensBefore === "number" ? mid.tokensBefore : null,
    replayedMessages: typeof replay?.replayedMessageCount === "number" ? replay.replayedMessageCount : null,
    projectionDroppedRecords: typeof replay?.toolProjectionRecords === "number" && Number.isSafeInteger(traceToolRecords) ? traceToolRecords - replay.toolProjectionRecords : null,
  };
}

/** Pressure applies to long traces only: the original hand-written traces are too small by design. */
export function verifyPressure(arm, family, metrics) {
  if (family !== "long") return { applicable: false, verified: true, reasons: [] };
  const reasons = [];
  for (const { metric, min } of arm.pressure) {
    const value = metrics[metric];
    if (typeof value !== "number") reasons.push(`pressure_unobserved:${metric}`);
    else if (value < min) reasons.push(`pressure_below_threshold:${metric}:${value}<${min}`);
  }
  return { applicable: true, verified: reasons.length === 0, reasons };
}
