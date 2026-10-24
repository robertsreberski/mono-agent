// Conversation-continuity benchmark arms.
//
// An arm is DATA, not code: it names which production boundary the probe turn
// crosses and the production config patch that produces it. The runner applies
// `probeRuntime` / `midCheckpoint.runtime` as a JSON patch to the `runtime`
// block of a mono-agent config, which is then resolved by the production
// `resolveJsonMonoAgentConfig` and served by `createConfiguredConversationHarness`.
// Nothing here reimplements context assembly, cold replay, or compaction.
//
// Extension point: a later arm (continuity ledger/pack, tool-result stubs,
// `runtime.maxInputTokens`) is one more entry whose patch enables the new
// production feature, plus the boundary evidence it must produce. Unknown
// config keys fail in production config resolution, never silently.

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

export const BASELINE_ARM = "native";

export const ARMS = Object.freeze([
  Object.freeze({
    id: "native",
    label: "(a) full native context",
    description: "Scripted history is replayed into the reader's own durable Pi session; each probe resumes that native transcript (tool calls and results included) with production default compaction.",
    replayBinding: "reader",
    midCheckpoint: null,
    probeRuntime: Object.freeze({}),
    expect: Object.freeze({ probeBoundary: null, probeCompactions: 0, midCompactions: 0 }),
  }),
  Object.freeze({
    id: "cold-rebuild",
    label: "(b) cold model-change rebuild",
    description: "History is bound to a different configured model; the probe turn runs on the reader model, so the production default model-change path reseeds from canonical text (last 64 messages) plus the bounded tool-history projection.",
    replayBinding: "alternate",
    midCheckpoint: null,
    probeRuntime: Object.freeze({}),
    expect: Object.freeze({ probeBoundary: "model_change", probeCompactions: 0, midCompactions: 0 }),
  }),
  Object.freeze({
    id: "compaction-1",
    label: "(c) one proactive compaction",
    description: "Native session as in (a); the probe turn runs with a small runtime.compaction trigger so production proactive compaction summarizes the history before answering.",
    replayBinding: "reader",
    midCheckpoint: null,
    probeRuntime: Object.freeze({ compaction: SMALL_PROACTIVE_COMPACTION }),
    expect: Object.freeze({ probeBoundary: null, probeCompactions: 1, midCompactions: 0 }),
  }),
  Object.freeze({
    id: "compaction-2",
    label: "(d) two successive compactions",
    description: "A designated mid-trace owner turn is answered live with the small trigger (compaction 1); scripted history continues; the probe turn compacts again (compaction 2).",
    replayBinding: "reader",
    midCheckpoint: Object.freeze({ runtime: Object.freeze({ compaction: SMALL_PROACTIVE_COMPACTION }) }),
    probeRuntime: Object.freeze({ compaction: SMALL_PROACTIVE_COMPACTION }),
    expect: Object.freeze({ probeBoundary: null, probeCompactions: 1, midCompactions: 1 }),
  }),
]);

export const ARM_IDS = Object.freeze(ARMS.map((arm) => arm.id));

export function armById(id) {
  const arm = ARMS.find((candidate) => candidate.id === id);
  if (arm === undefined) throw new Error("unknown_arm");
  return arm;
}

/**
 * A checkpoint without a live turn is deterministic scripted state, so every
 * repeat of that arm reuses it. A live mid-trace turn makes it repeat-specific.
 * Arms never share a checkpoint: probes forked from one checkpoint share a
 * provider session identity and are therefore never run concurrently.
 */
export function checkpointKey(arm, repeat) {
  return arm.midCheckpoint === null ? `scripted-${arm.id}` : `live-${arm.id}-r${repeat}`;
}

/** Plain-JSON deep merge for config patches (arrays and scalars replace). */
export function mergePatch(base, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = { ...(base !== null && typeof base === "object" && !Array.isArray(base) ? base : {}) };
  for (const [key, value] of Object.entries(patch)) out[key] = mergePatch(out[key], value);
  return out;
}

/**
 * Verify that the probe (or mid-trace) turn actually crossed the arm's boundary.
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
  return { verified: reasons.length === 0, reasons };
}
