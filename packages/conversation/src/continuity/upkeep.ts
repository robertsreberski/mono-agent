import type { RuntimeEventLike } from "@mono-agent/observability";
import type { ContinuityUpkeepResult } from "@mono-agent/turn/host";
import type { ConversationHarnessOptions, ConversationHarnessRequest } from "../harness/contracts.js";
import { selectLedgerSources, validateLedgerOutput } from "./ledger.js";

export interface UpkeepEligibility {
  readonly sessionsEnabled: boolean; readonly isolated: boolean; readonly ownedStore: boolean; readonly primaryAttempt: boolean;
  readonly maxTokens: number; readonly withOwner?: <T>(operation: () => Promise<T>) => Promise<T>;
}
export function createLedgerSupplier(options: ConversationHarnessOptions, request: ConversationHarnessRequest, runId: string) {
  const history = options.toolHistory, config = history?.upkeep;
  const scope = { logicalConversationId: history?.logicalConversationId(request.conversationId) ?? request.conversationId,
    currentConversationId: request.conversationId, currentRunId: runId };
  let frozen: ReturnType<NonNullable<typeof history>["reader"]["ledger"]>;
  let prepared: Promise<void> | undefined, gap = false;
  const emitSafe = (emit: (event: RuntimeEventLike) => void, event: RuntimeEventLike) => { try { emit(event); } catch { /* diagnostics never block an answer */ } };
  return {
    get gap() { return gap; },
    current() {
      if (!frozen || !history) return undefined;
      try { if (history.reader.continuitySuppressed(scope) || history.reader.ledger(scope)?.generation.id !== frozen.generation.id) { frozen = undefined; gap = true; } }
      catch { frozen = undefined; gap = true; }
      return frozen;
    },
    async prepare(eligibility: UpkeepEligibility, reason: string, emit: (event: RuntimeEventLike) => void) {
      if (!config?.enabled && !history?.ledgerEnabled) return;
      prepared ??= (async () => {
        const skip = !history?.continuityEnabled || history.packEnabled === false ? "disabled" : request.continuation ? "continuation_boundary"
          : !eligibility.sessionsEnabled ? "per_message" : eligibility.isolated ? "isolated" : !eligibility.ownedStore ? "unowned_store"
          : !eligibility.primaryAttempt || reason === "detached_context" ? "detached_attempt" : eligibility.maxTokens < 500 ? "trigger_headroom" : undefined;
        if (!request.continuation && !eligibility.isolated && eligibility.ownedStore && eligibility.sessionsEnabled && history?.continuityEnabled && history.packEnabled !== false) {
          try { frozen = history.reader.ledger(scope); } catch { gap = true; }
        }
        if (skip || !config?.enabled) { emitSafe(emit, { type: "continuity_upkeep", status: "skipped", reason: skip ?? "read_only", providerInvoked: false }); return; }
        let completion: ContinuityUpkeepResult | undefined;
        let published: string | undefined, localSkip: string | undefined, uncovered: number | undefined;
        try {
          if (history!.reader.continuitySuppressed(scope) || !history!.publishLedger || !eligibility.withOwner) throw new Error("unavailable");
          frozen = history!.reader.ledger(scope);
          const source = history!.reader.snapshotContinuity({ ...scope, selection: "upkeep" });
          if (["unavailable", "purge_pending", "source_unavailable"].includes(source.degradedReason ?? "")) throw new Error("source_unavailable");
          const selection = selectLedgerSources(source, frozen?.generation); uncovered = selection.uncovered;
          if (!selection.spans.length || selection.manifest === frozen?.generation.manifest) {
            localSkip = selection.spans.length ? "unchanged" : "no_source"; return;
          }
          completion = await config.complete(selection.prompt, request.abortSignal);
          if (completion.receipt.status !== "valid" || !completion.text) { gap = true; return; }
          const generation = validateLedgerOutput(completion.text, selection, scope, frozen?.generation);
          await eligibility.withOwner(async () => { request.abortSignal.throwIfAborted(); await history!.publishLedger!(generation); });
          frozen = history!.reader.ledger(scope); published = frozen?.generation.id;
          if (!published) throw new Error("publication_unavailable");
        } catch {
          gap = true;
          if (completion) completion = { receipt: { ...completion.receipt, status: "invalid", reason: "validation_or_publication" } };
        } finally {
          // This host callback records before the provider attempt can fail over;
          // it is deliberately not attached to an attempt's return value.
          emitSafe(emit, { type: "continuity_upkeep", ...(completion?.receipt ?? { status: "skipped", reason: localSkip ?? "unavailable", providerInvoked: false }),
            ...(published ? { generationId: published } : {}), uncovered: uncovered ?? frozen?.generation.uncovered ?? 0 });
          if (completion?.receipt.outputOverrun) emitSafe(emit, { type: "upkeep_output_overrun", outputTokens: completion.receipt.outputTokens });
          if (gap) emitSafe(emit, { type: "runtime_warning", warning_kind: "continuity_upkeep_degraded", error_code: completion?.receipt.reason ?? "unavailable",
            message: "Continuity upkeep incomplete; deterministic evidence remains available." });
        }
      })();
      await prepared;
    },
  };
}
