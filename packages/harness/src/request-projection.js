// @ts-check
import { buildHarnessSessionContext } from "./session-context.js";
import { assertEvidenceView, nativeCompatibility, matchesEvidenceCoverage } from "./evidence-view.js";
import { checkHandoffDispatch } from "./handoff.js";

/**
 * The sole request-context seam. Arrays preserve the v2 contract byte for byte.
 * Validated chain views are opt-in; evidence inspection never merges predecessors.
 * @param {any[]|any} source
 * @param {any} [options]
 */
export function projectContext(source, options = {}) {
  if (Array.isArray(source) && options.mode === "evidence") return { entries: source };
  if (Array.isArray(source) && options.mode === "compaction") {
    const messages = buildHarnessSessionContext(source, options);
    return { entries: options.repairs?.length ? messages.map((message, index) => ({ type: "message", message,
      id: source.find((entry) => entry.type === "message" && entry.message === message)?.id ?? `derived:repair:${index}`,
      parentId: null, timestamp: message.timestamp, seq: index })) : source };
  }
  if (Array.isArray(source)) return { messages: buildHarnessSessionContext(source, options),
    coverage: { source: "native", repair: options.repairs?.length ? "prompt-only" : "none", entryCount: source.length } };
  assertEvidenceView(source);
  const current = source.segments.at(-1);
  if (options.mode === "evidence") return { entries: current.entries, records: current.records, turns: current.turns, calls: current.allCalls };
  if (source.gaps.length) return { status: "handoff_required", reason: "canonical_only_gap", gaps: source.gaps.map((g) => g.reference) };
  if (!options.target || options.switching !== true) throw new TypeError("Chain projection requires an explicit switch target");
  for (const segment of source.segments) {
    const compatible = nativeCompatibility(segment.descriptor.provenance, options.target);
    if (!compatible.compatible) return { status: "handoff_required", reason: compatible.reason, journalId: segment.descriptor.journalId };
  }
  let start = 0;
  // A composed checkpoint summarizes exactly the frozen prefix it names. Never
  // replay that prefix on top of the checkpoint or accept changed source tips.
  for (let index = 0; index < source.segments.length; index++) {
    const checkpoint = source.segments[index].entries.filter((e) => e.type === "compaction").at(-1)?.checkpoint;
    if (checkpoint?.inheritedCoverage) {
      validateComposedCoverage(checkpoint.inheritedCoverage, source.segments.slice(0, index).map((s) => s.descriptor), source.segments.slice(0, index));
      start = index;
    }
  }
  const messages = source.segments.slice(start).flatMap((segment) => buildHarnessSessionContext(segment.entries, { ...options, repairs: segment.repairs }));
  const coverage = { version: 2, sources: source.segments.map((s) => s.descriptor), entryCount: source.segments.reduce((n, s) => n + s.entries.length, 0) };
  if (!options.budget) throw new TypeError("Chain projection requires a frozen budget");
  const fit = checkHandoffDispatch({ ...options.hostContext, messages }, options.budget);
  if (fit.status !== "ready") return { status: "handoff_required", reason: "native_budget", failure: fit, coverage };
  return { status: "ready", messages, coverage };
}

/** @param {any} coverage @param {any[]} descriptors @param {any[]} [segments] */
export function validateComposedCoverage(coverage, descriptors, segments) {
  if (coverage?.version !== 1 || !Array.isArray(coverage.sources) || coverage.sources.length !== descriptors.length
    || coverage.sources.some((s, i) => segments ? !matchesEvidenceCoverage(s, segments[i]) : ["journalId", "sourceTipId", "sourceSeq", "sourceDigest"].some((key) => s[key] !== descriptors[i][key]))) {
    throw new TypeError("Invalid composed checkpoint coverage");
  }
  return coverage;
}

/** Raw current-journal references for P2 matching; no filtering or ancestry merging.
 * @param {any} store
 */
export async function inspectCurrentEvidence(store) {
  return { entries: await store.getEntries(), ...inspectCurrentLifecycle(store) };
}

/** Synchronous current-journal lifecycle references; deliberately no payload I/O.
 * @param {any} store
 */
export function inspectCurrentLifecycle(store) {
  return { turns: [...store.validator.turns.values()], calls: [...store.validator.calls.values()] };
}

/** Host-accepted inherited projection plus this epoch's delta. Content stays in
 * the host artifact/predecessors, never seeded into the current native journal.
 * @param {any[]} entries @param {any} inherited @param {any} [options]
 */
export function projectInheritedContext(entries, inherited, options = {}) {
  if (!inherited || !Array.isArray(inherited.messages) || !inherited.messages.length
    || inherited.coverage?.version !== 1 || !Array.isArray(inherited.coverage.sources)
    || !inherited.coverage.sources.length || inherited.messages.some((message) => !message
      || !["user", "assistant", "toolResult", "compactionSummary", "branchSummary"].includes(message.role))) throw new TypeError("Invalid inherited projection");
  const sources = inherited.coverage.sources;
  if (sources.some((source) => typeof source.journalId !== "string" || !source.journalId
    || !(source.sourceTipId === null || typeof source.sourceTipId === "string")
    || !Number.isSafeInteger(source.sourceSeq) || source.sourceSeq < 0
    || !/^[a-f0-9]{64}$/.test(source.sourceDigest))
    || new Set(sources.map((source) => source.journalId)).size !== sources.length) throw new TypeError("Invalid inherited coverage");
  const checkpoint = entries.filter((entry) => entry.type === "compaction").at(-1)?.checkpoint;
  if (!checkpoint?.inheritedCoverage && entries.some((entry) => entry.checkpoint?.inheritedCoverage)) {
    throw new TypeError("Composed checkpoint coverage was lost");
  }
  if (checkpoint?.inheritedCoverage) {
    validateComposedCoverage(checkpoint.inheritedCoverage, sources);
    return { ...projectContext(entries, options), nonRetainablePrefixLength: 0 };
  }
  if (options.mode === "compaction") {
    const prefix = inherited.messages.map((message, index) => ({ type: "message", message,
      id: `inherited:${index}`, parentId: null, timestamp: message.timestamp, seq: index }));
    return { entries: [...prefix, ...projectContext(entries, options).entries], nonRetainablePrefixLength: prefix.length, messages: undefined };
  }
  const current = projectContext(entries, options);
  return { ...current, messages: [...inherited.messages, ...current.messages] };
}
