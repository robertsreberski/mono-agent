// Controller-only native request derivation. No submitted payload is an input.
import { readFile } from "node:fs/promises";
import { digest } from "./continuity-dataset.mjs";
import { verifyE2SummaryResult, e2SummaryResultPath } from "./continuity-e2-summary-receipts.mjs";
const need = ok => { if (!ok) throw Object.assign(Error("e2_summary_receipt_invalid"), { code: "e2_summary_receipt_invalid" }); };
export const E2_PROTECTED_POLICY = Object.freeze({ enabled: true, summaryMaxTokens: 3000, keepRecentTokens: 1000, compactionMinSavingsTokens: 0, effort: "none", failureCooldownMs: 900000 });
export async function e2ProtectedSummaryPolicies(models) {
  const { resolveAgentCompactionPolicy } = await import("../../packages/turn/dist/agent/compaction.js");
  return { version: 1, source: "protected-control-v1", trigger: "proactive", models: models.map(model => {
    const target = { ...model, api: "openai-codex-responses", input: ["text"], reasoning: false };
    return { model: target, policy: { ...resolveAgentCompactionPolicy({}, { contextWindow: target.contextWindow }), ...E2_PROTECTED_POLICY } };
  }) };
}
export async function e2DefaultSummaryPolicies(pilot) {
  const raw = await readFile(new URL("../../packages/turn/node_modules/@earendil-works/pi-ai/dist/providers/data/openai-codex.json", import.meta.url));
  const { digest: bytesDigest } = await import("./continuity-recorded-schema.mjs");
  const all = Object.values(JSON.parse(raw)).flatMap(rows => Object.values(rows));
  const { resolveAgentCompactionPolicy } = await import("../../packages/turn/dist/agent/compaction.js");
  return { version: 1, source: "bound-build-defaults-v1", trigger: "proactive", buildOutputSha256: pilot.registration.build?.outputSha256 ?? null,
    models: pilot.registration.catalog.map(row => {
      need(bytesDigest(raw) === row.fileSha256);
      const [provider, id] = row.model.split(":"), matches = all.filter(m => m.id === id && m.api === row.api); need(matches.length === 1);
      const model = { ...matches[0], provider, id };
      need(model.contextWindow === row.contextWindow && model.maxTokens === row.maxTokens);
      return { model, policy: resolveAgentCompactionPolicy({}, { contextWindow: model.contextWindow }) };
    }) };
}
// Bounded cache of derived projections, never of an authorization supplied by a
// child. Every use still authenticates the archive, native prefix and live tip.
const plans = new Map();
export async function deriveE2SummaryRequest({ root, state, index, hold, native, predecessor, readArtifact }) {
  const policyBinding = state.summaryPolicies;
  need(policyBinding?.version === 1 && ["bound-build-defaults-v1", "protected-control-v1"].includes(policyBinding.source) && Array.isArray(policyBinding.models));
  // Frozen E2 scopes use proactive compaction. Native journals do not bind
  // the outer hook trigger (their cause can say manual even for proactive).
  // Neither policy nor preservation/fallback mode is inferred from that cause.
  need(policyBinding.trigger === "proactive" && !native.validator.projectionBinding);
  if (policyBinding.source === "bound-build-defaults-v1") need(/^[a-f0-9]{64}$/u.test(policyBinding.buildOutputSha256));
  const matches = policyBinding.models.filter(row => `${row.model.provider}:${row.model.id}` === hold.model); need(matches.length === 1);
  const { model, policy } = matches[0];
  need(native.operation.start.payload.config.model.provider === model.provider && native.operation.start.payload.config.model.id === model.id);
  const slot = state.slots[index], previous = slot.holds.filter(h => h.paidRole === "summary" && h.operationDigest === hold.operationDigest
    && h.round < hold.round && h.summaryReceipt?.verified && h.settlement?.kind === "settled");
  need(previous.length <= 1);
  const key = digest([hold.nativeCompaction.prefixSha256, hold.nativeCompaction.nativeOperationDigest, policyBinding, predecessor.textSha256,
    previous.map(h => h.summaryReceipt.sha256)]);
  if (plans.has(key)) return plans.get(key);
  const [{ SessionStore }, { projectContext }, { createCompactionAccounting, createGuardedCompactionHook, piSummaryReserveTokens }, { estimateTokens }, { planSummaryBudget }, { prepareSummaryInput }, { sumKnownSummaryUsage }, { convertResponsesMessages }, { clampThinkingLevel, normalizeContext }] = await Promise.all([
    import("../../packages/turn/dist/engine/session-store.js"), import("../../packages/turn/dist/engine/request-projection.js"),
    import("../../packages/turn/dist/execution/pi/compaction/compaction-driver.js"), import("../../packages/turn/dist/engine/compaction-kit/compaction.js"),
    import("../../packages/turn/dist/engine/compaction-kit/historical-preservation.js"), import("../../packages/turn/dist/execution/pi/compaction/compaction-summary.js"),
    import("../../packages/turn/dist/engine/compaction-kit/usage.js"),
    import("../../packages/turn/node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js"),
    import("../../packages/turn/node_modules/@earendil-works/pi-ai/dist/index.js"),
  ]);
  const store = new SessionStore(native.header, native.records, undefined, () => {});
  const branchEntries = projectContext(await store.getEntries(), { mode: "compaction", repairs: await store.getRepairEntries() }).entries;
  const accounting = createCompactionAccounting(), warnings = [], requests = [], replies = [];
  for (const prior of previous) {
    const readPrivate = async path => JSON.parse(await readArtifact(path, "e2_summary_receipt_invalid", 8 * 1024 * 1024));
    await verifyE2SummaryResult(root, slot.slotId, prior, { schema: prior.summaryReceipt.schema, sha256: prior.summaryReceipt.sha256 }, readPrivate);
    replies.push((await readPrivate(e2SummaryResultPath(root, slot.slotId, prior.round))).message);
  }
  let budgetPlan;
  const harness = { getModel: () => model, models: { completeSimple: async (_model, context, options) => {
    requests.push({ context, options });
    if (replies[requests.length - 1]) return replies[requests.length - 1];
    // Use the structured shipping plan, never a frame quoted in conversation.
    // Only a generated history needs to copy tuples; a prefix follows generated
    // or reused history that already owns them. No inference or evidence here.
    const history = requests.length === 1 && budgetPlan.generateHistory && accounting.preservation?.protectionActive;
    const text = history ? budgetPlan.protectedText : "Controller preflight placeholder.";
    return { role: "assistant", content: [{ type: "text", text: text || "Controller preflight placeholder." }], stopReason: "stop", usage: sumKnownSummaryUsage() };
  } } };
  const trigger = policyBinding.trigger;
  const hook = createGuardedCompactionHook({ harness, trigger, operationId: native.operation.start.operationId, effectivePolicy: policy,
    compactionSettings: { enabled: true, reserveTokens: piSummaryReserveTokens(policy.summaryMaxTokens, false), keepRecentTokens: policy.keepRecentTokens },
    accounting, runtimeWarnings: warnings, beforeSummary: ({ prepared }) => {
      const input = prepareSummaryInput(prepared);
      input.preparation.settings = { ...input.preparation.settings, summaryMaxTokens: policy.summaryMaxTokens };
      budgetPlan = planSummaryBudget(input.preparation, estimateTokens);
    } });
  const result = await hook.handler({ branchEntries, retainedPredecessor: { admissionId: predecessor.admissionId, text: predecessor.text }, nonRetainablePrefixLength: 0 });
  need(result.compaction && hook.getDecision()?.kind === "accepted" && requests.length > previous.length);
  const fallback = warnings.some(w => w.warning_kind === "retained_summary_legacy_fallback");
  need(fallback === (result.retainedAuthorityUsed === false));
  const { context, options } = requests[previous.length];
  // Derive the same Codex transcript from the independently replayed request
  // options. Never choose wire format, source text, or effort from the child.
  const level = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : "off";
  let configurationUpdateEffort;
  if (model.compat?.supportsMidConvoEffort) {
    if (level !== "off") configurationUpdateEffort = model.thinkingLevelMap?.[level] ?? level;
    else if (model.reasoning && model.thinkingLevelMap?.off !== null) configurationUpdateEffort = model.thinkingLevelMap?.off ?? "none";
  }
  const plan = { assembly: fallback ? "legacy-fallback" : accounting.splitTurn && (!budgetPlan.generateHistory || previous.length > 0) ? "split-prefix" : "summary",
    input: convertResponsesMessages({ ...model, input: ["text"] }, normalizeContext(context), new Set(["openai-codex"]), {
      supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages,
      supportsAdditionalTools: model.compat?.supportsAdditionalTools,
      supportsToolSearch: model.compat?.supportsToolSearch,
      configurationUpdateEffort,
    }) };
  plans.set(key, plan); while (plans.size > 4) plans.delete(plans.keys().next().value);
  return plan;
}
