// @ts-check
import { buildHarnessSessionContext } from "./session-context.js";

/**
 * The sole request-context seam. Arrays preserve the v2 contract byte for byte.
 * Validated evidence views feed handoffs only; they are never projected natively.
 * @param {any[]} source
 * @param {any} [options]
 */
export function projectContext(source: any[], options: any = {}): {
  entries: any[];
  messages?: undefined;
  coverage?: undefined;
} | {
  messages: any[];
  coverage: {
    source: string;
    repair: string;
    entryCount: number;
  };
  entries?: undefined;
} {
  if (!Array.isArray(source)) throw new TypeError("projectContext requires native journal entries");
  if (options.mode === "evidence") return { entries: source };
  if (options.mode === "compaction") {
    const messages = buildHarnessSessionContext(source, options);
    return { entries: options.repairs?.length ? messages.map((message, index) => ({ type: "message", message,
      id: source.find((entry) => entry.type === "message" && entry.message === message)?.id ?? `derived:repair:${index}`,
      parentId: null, timestamp: message.timestamp, seq: index })) : source };
  }
  return { messages: buildHarnessSessionContext(source, options),
    coverage: { source: "native", repair: options.repairs?.length ? "prompt-only" : "none", entryCount: source.length } };
}

/** A composed checkpoint summarizes exactly the frozen prefix it names.
 * @param {any} coverage @param {any[]} descriptors */
function validateComposedCoverage(coverage: any, descriptors: any[]) {
  if (coverage?.version !== 1 || !Array.isArray(coverage.sources) || coverage.sources.length !== descriptors.length
    || coverage.sources.some((s: any, i: number) => ["journalId", "sourceTipId", "sourceSeq", "sourceDigest"].some((key) => s[key] !== descriptors[i][key]))) {
    throw new TypeError("Invalid composed checkpoint coverage");
  }
  return coverage;
}

/** Raw current-journal references for P2 matching; no filtering or ancestry merging.
 * @param {any} store
 */
export async function inspectCurrentEvidence(store: any) {
  return { entries: await store.getEntries(), ...inspectCurrentLifecycle(store) };
}

/** Synchronous current-journal lifecycle references; deliberately no payload I/O.
 * @param {any} store
 */
export function inspectCurrentLifecycle(store: any) {
  return { turns: [...store.validator.turns.values()], calls: [...store.validator.calls.values()] };
}

/** Host-accepted inherited projection plus this epoch's delta. Content stays in
 * the host artifact/predecessors, never seeded into the current native journal.
 * @param {any[]} entries @param {any} inherited @param {any} [options]
 */
export function projectInheritedContext(entries: any[], inherited: any, options: any = {}): {
  nonRetainablePrefixLength: number;
  entries: any[];
  messages?: undefined;
  coverage?: undefined;
} | {
  nonRetainablePrefixLength: number;
  messages: any[];
  coverage: {
    source: string;
    repair: string;
    entryCount: number;
  };
  entries?: undefined;
} | {
  entries: any[];
  nonRetainablePrefixLength: any;
  messages: any;
} | {
  messages: any[];
  entries: any[];
  coverage?: undefined;
  nonRetainablePrefixLength?: undefined;
} | {
  messages: any[];
  coverage: {
    source: string;
    repair: string;
    entryCount: number;
  };
  entries?: undefined;
  nonRetainablePrefixLength?: undefined;
} {
  if (!inherited || !Array.isArray(inherited.messages) || !inherited.messages.length
    || inherited.coverage?.version !== 1 || !Array.isArray(inherited.coverage.sources)
    || inherited.messages.some((message: any) => !message
      || !["user", "assistant", "toolResult", "compactionSummary", "branchSummary"].includes(message.role))) throw new TypeError("Invalid inherited projection");
  const sources = inherited.coverage.sources;
  if (sources.some((source: any) => typeof source.journalId !== "string" || !source.journalId
    || !(source.sourceTipId === null || typeof source.sourceTipId === "string")
    || !Number.isSafeInteger(source.sourceSeq) || source.sourceSeq < 0
    || !/^[a-f0-9]{64}$/.test(source.sourceDigest))
    || new Set(sources.map((source: any) => source.journalId)).size !== sources.length) throw new TypeError("Invalid inherited coverage");
  const checkpoint = entries.filter((entry) => entry.type === "compaction").at(-1)?.checkpoint;
  if (!checkpoint?.inheritedCoverage && entries.some((entry) => entry.checkpoint?.inheritedCoverage)) {
    throw new TypeError("Composed checkpoint coverage was lost");
  }
  if (checkpoint?.inheritedCoverage) {
    validateComposedCoverage(checkpoint.inheritedCoverage, sources);
    return { ...projectContext(entries, options), nonRetainablePrefixLength: 0 };
  }
  if (options.mode === "compaction") {
    const prefix = inherited.messages.map((message: any, index: number) => ({ type: "message", message,
      id: `inherited:${index}`, parentId: null, timestamp: message.timestamp, seq: index }));
    return { entries: [...prefix, ...projectContext(entries, options).entries!], nonRetainablePrefixLength: prefix.length, messages: undefined };
  }
  const current = projectContext(entries, options);
  return { ...current, messages: [...inherited.messages, ...current.messages!] };
}
