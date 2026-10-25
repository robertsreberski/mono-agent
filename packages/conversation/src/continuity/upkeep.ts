import type { RuntimeEventLike } from "@mono-agent/observability";
import type { ContinuityUpkeepResult } from "@mono-agent/turn/host";
import type { ConversationHarnessOptions, ConversationHarnessRequest } from "../harness/contracts.js";
import { selectLedgerSources, validateLedgerOutput, fitLedgerSelection, ledgerHash } from "./ledger.js";

export interface UpkeepEligibility {
  readonly sessionsEnabled: boolean; readonly isolated: boolean; readonly ownedStore: boolean; readonly primaryAttempt: boolean;
  readonly historyAvailable?: boolean; readonly maxTokens: number; readonly withOwner?: <T>(operation: () => Promise<T>) => Promise<T>;
}
// Host-lifetime, process-local per-binding LRU (256 scopes); no historical prose or raw errors.
const failedSelections = new WeakMap<Function, Map<string, string>>();
export function createLedgerSupplier(options: ConversationHarnessOptions, request: ConversationHarnessRequest, runId: string) {
  const history = options.toolHistory, config = history?.upkeep;
  const scope = { logicalConversationId: history?.logicalConversationId(request.conversationId) ?? request.conversationId,
    currentConversationId: request.conversationId, currentRunId: runId };
  let frozen: ReturnType<NonNullable<typeof history>["reader"]["ledger"]>;
  let prepared: Promise<void> | undefined, gap = false, integrityFailed = false;
  const emitSafe = (emit: (event: RuntimeEventLike) => void, event: RuntimeEventLike) => { try { emit(event); } catch { /* diagnostics never block an answer */ } };
  const integrityWarning = (emit: (event: RuntimeEventLike) => void) => emitSafe(emit, { type: "runtime_warning", warning_kind: "ledger_integrity", error_code: "ledger_integrity", message: "Continuity ledger integrity failed; use continuity reset for recovery. Deterministic evidence remains available." });
  return {
    get gap() { return gap; },
    current(emit: (event: RuntimeEventLike) => void) {
      if (integrityFailed) { integrityWarning(emit); return undefined; }
      if (!frozen || !history) return undefined;
      try { if (history.reader.continuitySuppressed(scope) || history.reader.ledger(scope)?.generation.id !== frozen.generation.id) { frozen = undefined; gap = true; } }
      catch { frozen = undefined; gap = true; integrityFailed = true; integrityWarning(emit); }
      return frozen;
    },
    async prepare(eligibility: UpkeepEligibility, reason: string, emit: (event: RuntimeEventLike) => void) {
      if (!config?.enabled && !history?.ledgerEnabled) return;
      prepared ??= (async () => {
        const skip = !history?.continuityEnabled || history.packEnabled === false ? "disabled" : request.continuation ? "continuation_boundary"
          : eligibility.historyAvailable === false ? "history_unavailable" : !eligibility.sessionsEnabled ? "per_message" : eligibility.isolated ? "isolated" : !eligibility.ownedStore ? "unowned_store"
          : !eligibility.primaryAttempt || reason === "detached_context" ? "detached_attempt" : eligibility.maxTokens < 500 ? "trigger_headroom" : undefined;
        if (!request.continuation && !eligibility.isolated && eligibility.ownedStore && eligibility.sessionsEnabled && history?.continuityEnabled && history.packEnabled !== false) {
          try { frozen = history.reader.ledger(scope); } catch { gap = true; integrityFailed = true; integrityWarning(emit); }
        }
        if (skip || integrityFailed || !config?.enabled) { emitSafe(emit, { type: "continuity_upkeep", status: "skipped", reason: skip ?? (integrityFailed ? "ledger_integrity" : "read_only"), providerInvoked: false }); return; }
        let completion: ContinuityUpkeepResult | undefined;
        let published: string | undefined, localSkip: string | undefined, uncovered: number | undefined, fingerprint: string | undefined;
        const failures = failedSelections.get(config.complete) ?? new Map<string, string>(); failedSelections.set(config.complete, failures);
        const cacheScope = ledgerHash(JSON.stringify([scope.currentConversationId, scope.logicalConversationId]));
        const rememberPaidFailure = () => {
          if (!fingerprint || !completion?.receipt.providerInvoked) return;
          failures.delete(cacheScope); failures.set(cacheScope, fingerprint);
          if (failures.size > 256) failures.delete(failures.keys().next().value!);
        };
        try {
          if (history!.reader.continuitySuppressed(scope) || !history!.publishLedger || !eligibility.withOwner) throw new Error("unavailable");
          const source = history!.reader.snapshotContinuity({ ...scope, selection: "upkeep" });
          if (["unavailable", "purge_pending", "source_unavailable"].includes(source.degradedReason ?? "")) throw new Error("source_unavailable");
          const admission = fitLedgerSelection(selectLedgerSources(source, frozen?.generation), scope, frozen);
          const { selection, projectedBytes } = admission; uncovered = selection.uncovered;
          if (admission.reason) { localSkip = admission.reason; return; }
          if (!selection.spans.length || selection.manifest === frozen?.generation.manifest) {
            if (frozen && selection.manifest === frozen.generation.manifest) uncovered = frozen.generation.uncovered;
            localSkip = selection.spans.length ? "unchanged" : "no_source"; return;
          }
          const covered = new Set(frozen?.generation.coveredSpans ?? frozen?.generation.entries.flatMap(entry => entry.sources));
          if (frozen && selection.spans.every(span => frozen!.generation.spans.some(old => covered.has(old.id) && old.recordId === span.recordId && old.sha256 === span.sha256 && old.start === span.start && old.end === span.end && old.digest === span.digest))) { localSkip = "already_covered"; return; }
          const stats = history!.reader.stats();
          if (!stats) throw new Error("quota_unavailable");
          if (stats.retainedBytes - (frozen?.payloadBytes ?? 0) + projectedBytes > stats.limits.maxBytes) { localSkip = "ledger_quota_budget"; return; }
          fingerprint = ledgerHash(JSON.stringify([selection.manifest, frozen?.generation.id ?? null, config.model ?? "bound-completion"]));
          if (failures.get(cacheScope) === fingerprint) { failures.delete(cacheScope); failures.set(cacheScope, fingerprint); localSkip = "upkeep_repeat_suppressed"; gap = true; return; }
          failures.delete(cacheScope);
          completion = await config.complete(selection.prompt, request.abortSignal);
          if (completion.receipt.status !== "valid" || !completion.text) { gap = true; if (completion.receipt.status === "invalid") rememberPaidFailure(); return; }
          const generation = validateLedgerOutput(completion.text, selection, scope, frozen?.generation, completion.receipt.capEnforcement); uncovered = generation.uncovered;
          await eligibility.withOwner(async () => { request.abortSignal.throwIfAborted(); await history!.publishLedger!(generation); });
          frozen = history!.reader.ledger(scope); published = frozen?.generation.id;
          if (!published) throw new Error("publication_unavailable");
        } catch {
          gap = true;
          if (completion) { rememberPaidFailure(); completion = { receipt: { ...completion.receipt, status: "invalid", reason: "validation_or_publication" } }; }
        } finally {
          // This host callback records before the provider attempt can fail over;
          // it is deliberately not attached to an attempt's return value.
          emitSafe(emit, { type: "continuity_upkeep", ...(completion?.receipt ?? { status: "skipped", reason: localSkip ?? "unavailable", providerInvoked: false }),
            ...(published ? { generationId: published } : {}), uncovered: uncovered ?? frozen?.generation.uncovered ?? 0 });
          if (completion?.receipt.outputOverrun) emitSafe(emit, { type: "upkeep_output_overrun", outputTokens: completion.receipt.outputTokens });
          if (gap) emitSafe(emit, { type: "runtime_warning", warning_kind: "continuity_upkeep_degraded", error_code: completion?.receipt.reason ?? localSkip ?? "unavailable",
            message: "Continuity upkeep incomplete; deterministic evidence remains available." });
        }
      })();
      await prepared;
    },
  };
}
