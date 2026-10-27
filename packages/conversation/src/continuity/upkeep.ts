import { fitsLedgerPrefix } from "./render-fit.js";
import { randomUUID } from "node:crypto";
import type { UpkeepAdmission, UpkeepReservation } from "./admission.js";
import { LedgerError, ledgerFailure } from "./ledger-error.js";
import type { RuntimeEventLike } from "@mono-agent/observability";
import type { ContinuityUpkeepResult } from "@mono-agent/turn/host";
import type { ConversationHarnessOptions, ConversationHarnessRequest } from "../harness/contracts.js";
import { selectLedgerSources, validateLedgerOutput, fitLedgerSelection, renderLedger, spanKey } from "./ledger.js";

export interface UpkeepEligibility {
  readonly sessionsEnabled: boolean; readonly isolated: boolean; readonly ownedStore: boolean; readonly primaryAttempt: boolean;
  readonly historyAvailable?: boolean; readonly maxTokens: number; readonly withOwner?: <T>(operation: (ownerToken: string) => Promise<T>) => Promise<T>;
}
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
        let publishing = false;
        let published: string | undefined, localSkip: string | undefined, uncovered: number | undefined;
        let reservation: UpkeepReservation | undefined;
        let outcomeRecorded = false, barrierRequested = false;
        try {
          if (history!.reader.continuitySuppressed(scope) || !history!.publishLedger || !history!.mutateUpkeep || !eligibility.withOwner) throw new Error("unavailable");
          if (!config.model) { localSkip = "model_unavailable"; return; }
          const fence = await eligibility.withOwner(async ownerToken => {
            if (!ownerToken) throw new Error("owner_unavailable");
            const expected = await history!.mutateUpkeep!({ kind: "inspect", scope: { logicalId: scope.logicalConversationId, conversationId: scope.currentConversationId } });
            if (!expected) throw new Error("scope_unavailable");
            return await history!.mutateUpkeep!({ kind: "claim", expected, ownerToken }) as UpkeepAdmission;
          });
          if (fence.uncertain) throw new LedgerError("upkeep_repeat_suppressed");
          const inputTokens = fence.bootstrap ? 128000 : 64000;
          const source = history!.reader.snapshotContinuity({ ...scope, selection: "upkeep", priorCovered: frozen?.generation.spans.filter(s => frozen!.generation.entries.some(e => e.sources.includes(s.id))).map(spanKey) });
          if (source.upkeep?.scan) emitSafe(emit, { type: "continuity_upkeep_scan", ...source.upkeep.scan, watermark: source.upkeep.watermark, reason: source.degradedReason ?? "complete" });
          if (["unavailable", "purge_pending", "source_unavailable"].includes(source.degradedReason ?? "")) throw new Error("source_unavailable");
          if (source.degradedReason === "scan_capacity" || source.upkeep?.scan && !source.upkeep.scan.complete) { gap = true; localSkip = "ledger_scan_capacity"; return; }
          const preflightStarted = performance.now();
          const selected = selectLedgerSources(source, frozen?.generation, inputTokens, { maxTokens: eligibility.maxTokens, priorRecords: frozen?.records });
          if (selected.oversizedProgress) {
            await eligibility.withOwner(async () => { await history!.mutateUpkeep!({ kind: "oversized", fence, progress: selected.oversizedProgress!, operationId: randomUUID(), advance: selected.oversizedAdvance === true }); });
            gap = true;
          }
          const admission = fitLedgerSelection(selected, scope, frozen, { maxTokens: eligibility.maxTokens, deltaEntries: config.model.startsWith("openai-codex:") ? 8 : 24 });
          const { selection, projectedBytes } = admission; uncovered = selection.uncovered;
          emitSafe(emit, { type: "continuity_upkeep_selection", candidates: selected.spans.length, fitted: selection.spans.length, trimmed: admission.trimmedSpans, deltaCap: selection.maxEntries, projectedBytes, lineageBytes: admission.lineageBytes, projectionAttempts: admission.projectionAttempts, exclusions: admission.exclusions, elapsedMs: performance.now() - preflightStarted, scores: selected.ranked?.reduce<Record<string, number>>((counts, s) => { counts[s.score] = (counts[s.score] ?? 0) + 1; return counts; }, {}), reason: admission.reason ?? "fitted" });
          if (admission.reason) { gap = true; localSkip = admission.reason; return; }
          if (!selection.spans.length || selection.manifest === frozen?.generation.manifest) {
            if (frozen && selection.manifest === frozen.generation.manifest) uncovered = frozen.generation.uncovered;
            gap ||= selection.uncovered > 0;
            localSkip = selection.spans.length ? "unchanged" : selected.oversizedProgress ? "source_oversized" : source.gaps > 0 ? "upkeep_repeat_suppressed" : frozen ? "already_covered" : "no_source"; return;
          }
          const covered = new Set(frozen?.generation.coveredSpans ?? frozen?.generation.entries.flatMap(entry => entry.sources));
          if (frozen && selection.spans.every(span => frozen!.generation.spans.some(old => covered.has(old.id) && old.recordId === span.recordId && old.sha256 === span.sha256 && old.start === span.start && old.end === span.end && old.digest === span.digest))) { localSkip = "already_covered"; return; }
          const stats = history!.reader.stats();
          if (!stats) throw new Error("quota_unavailable");
          if (stats.retainedBytes - (frozen?.payloadBytes ?? 0) + projectedBytes > stats.limits.maxBytes) { localSkip = "ledger_quota_budget"; return; }
          reservation = { databaseId: fence.databaseId, logicalId: fence.logicalId, conversationId: fence.conversationId,
            incarnation: fence.incarnation, fence: fence.fence, ownerToken: fence.ownerToken,
            operationId: randomUUID(), runId, recorderNamespace: config.recorderNamespace ?? "",
            model: config.model, manifest: selection.manifest, parent: frozen?.generation.id ?? null,
            budget: fence.bootstrap ? "bootstrap" : "incremental", payloadReserve: Math.max(0, projectedBytes - (frozen?.payloadBytes ?? 0)), ...(selection.progress ? { progress: selection.progress } : {}) };
          await eligibility.withOwner(async () => {
            if (selection.deadline !== undefined && performance.now() >= selection.deadline) throw new LedgerError("ledger_scan_capacity");
            if (!history!.reader.continuitySnapshotVisible(scope, { ...source, records: selection.records }) || history!.reader.ledger(scope)?.generation.id !== frozen?.generation.id) throw new LedgerError("source_changed");
            await history!.mutateUpkeep!({ kind: "reserve", reservation: reservation! });
            request.abortSignal.throwIfAborted();
            if (selection.deadline !== undefined && performance.now() >= selection.deadline) throw new LedgerError("ledger_scan_capacity");
            barrierRequested = true;
            await history!.mutateUpkeep!({ kind: "dispatch", reservation: reservation! });
          });
          // No invocation until BOTH the durable acknowledgement and canonical
          // owner's post-check succeed. Lost waiters never speculate or retry.
          completion = await config.complete(selection.prompt, request.abortSignal, { operationId: reservation.operationId, inputTokens, maxEntries: selection.maxEntries });
          let generation: ReturnType<typeof validateLedgerOutput> | undefined, validationError: unknown;
          if (completion.receipt.status === "valid" && completion.text) {
            try {
              generation = validateLedgerOutput(completion.text, selection, scope, frozen?.generation, completion.receipt.capEnforcement);
              completion = { ...completion, receipt: { ...completion.receipt, outcomeDowngrades: generation.outcomeDowngrades ?? 0, decisionRelabels: generation.decisionRelabels ?? 0 } };
            } catch (error) { validationError = error; }
          }
          // Record paid usage even when integrity validation rejects everything.
          await eligibility.withOwner(async () => {
            await history!.mutateUpkeep!({ kind: "outcome", reservation: reservation!, receipt: completion!.receipt });
          });
          outcomeRecorded = true;
          if (validationError) throw validationError;
          if (completion.receipt.status !== "valid" || !completion.text) {
            if (completion.receipt.providerInvoked && completion.receipt.status === "valid") await eligibility.withOwner(async () => { await history!.mutateUpkeep!({ kind: "reject", reservation: reservation! }); });
            gap = true; return;
          }
          if (!generation) throw new LedgerError("output_schema");
          uncovered = generation.uncovered;
          const deltaEntries = JSON.parse(completion.text).entries.length as number;
          if (deltaEntries && !fitsLedgerPrefix(renderLedger(generation, [...(frozen?.records ?? []), ...selection.records]), eligibility.maxTokens)) throw new LedgerError("ledger_render_budget");
          await eligibility.withOwner(async () => { await history!.mutateUpkeep!({ kind: "settle", reservation: reservation!, saturated: deltaEntries === selection.maxEntries, analysisOnly: deltaEntries === 0 }); });
          if (!deltaEntries) {
            completion = { ...completion, receipt: { ...completion.receipt, reason: "analyzed" } };
            // A valid "nothing new" result is normal analysis, not a degraded ledger:
            // like a publishing delta, it discloses uncovered counts without a warning.
            return;
          }
          publishing = true;
          await eligibility.withOwner(async () => { if (request.abortSignal.aborted) throw new LedgerError("publish_cancelled"); await history!.publishLedger!(generation, reservation); });
          frozen = history!.reader.ledger(scope); published = frozen?.generation.id;
          if (!published) throw new LedgerError("publish_unavailable");
        } catch (error) {
          gap = true;
          if ((error as { code?: string }).code === "upkeep_dispatch_rejected") { barrierRequested = false; localSkip = "upkeep_dispatch_rejected"; }
          if (completion && outcomeRecorded && reservation && completion.receipt.providerInvoked && completion.receipt.status === "valid") {
            try { await eligibility.withOwner!(async () => { await history!.mutateUpkeep!({ kind: "reject", reservation: reservation!, retry: ["publish_cas", "publish_cancelled"].includes(request.abortSignal.aborted ? "publish_cancelled" : ledgerFailure(error, publishing ? "publish_unavailable" : "output_schema")) }); }); } catch { /* pending offers remain suppressed if invalidation loses ownership */ }
          }
          if ((error as { code?: string }).code === "namespace_invalid") localSkip = "namespace_invalid";
          if ((error as { code?: string }).code === "upkeep_repeat_suppressed") localSkip = "upkeep_repeat_suppressed";
          if ((error as { code?: string }).code === "ledger_scan_capacity") localSkip = "ledger_scan_capacity";
          if (completion && outcomeRecorded) { completion = { receipt: { ...completion.receipt, status: "invalid", reason: "validation_or_publication", failure: request.abortSignal.aborted ? "publish_cancelled" : ledgerFailure(error, publishing ? "publish_unavailable" : "output_schema") } }; }
        } finally {
          const uncertain = !outcomeRecorded && barrierRequested ? { status: "uncertain", reason: "dispatch_or_outcome_unacknowledged",
            operationId: reservation!.operationId, model: reservation!.model, providerInvoked: completion?.receipt.providerInvoked ?? false,
            costUsd: null, inputTokens: null, outputTokens: null } : undefined;
          if (!outcomeRecorded) completion = undefined;
          // This host callback records before the provider attempt can fail over;
          // it is deliberately not attached to an attempt's return value.
          emitSafe(emit, { type: "continuity_upkeep", ...(completion?.receipt ?? uncertain ?? { status: "skipped", reason: localSkip ?? "unavailable", providerInvoked: false }),
            ...(published ? { generationId: published } : {}), uncovered: uncovered ?? frozen?.generation.uncovered ?? 0 });
          if (completion?.receipt.outputOverrun) emitSafe(emit, { type: "upkeep_output_overrun", outputTokens: completion.receipt.outputTokens });
          if (gap) emitSafe(emit, { type: "runtime_warning", warning_kind: "continuity_upkeep_degraded", error_code: completion?.receipt.failure ?? completion?.receipt.reason ?? localSkip ?? "unavailable",
            message: "Continuity upkeep incomplete; deterministic evidence remains available." });
        }
      })();
      await prepared;
    },
  };
}
