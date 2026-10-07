import { randomBytes, createHash } from "node:crypto";
import { resolve } from "node:path";
import { NativeEvidenceCapacityError, parseMonoRuntimeModelReference, type RuntimeNativePreparationStorage, type RuntimeRunOptions, type RuntimeResult } from "@mono-agent/runtime-adapter";
import { DurableConversationHistoryStore, NativeHistoryAuthorityBusyError, type ManagedProviderSessionPreparation } from "../durable-history.js";
import { MAX_JOURNAL_CHAIN, MAX_MODEL_SWITCH_BYTES, ModelSwitchCapacityError } from "../durable-model-switch-contract.js";
import type { AgentHarnessRequest, ProviderSessionTurnBinding } from "../types.js";
import { AgentHarnessError } from "./error.js";
import { prepareHarnessRuntime, type HarnessRuntimePreparationInput } from "./runtime-execution.js";
import { advancePreparedModelSwitch, createPreparedModelSwitchState, recoverPreparedModelSwitch, runPreparedModelSwitch, prepareNativeSwitchProjection, type PreparedSwitchProducer } from "./model-switch-preparation.js";

/** @internal
 * @unstable Constructor capability, structurally callable but not
 * passed by app/config/createAgentHarness. Not a supported public opt-in. */
export interface InternalNativeSwitchPolicy {
  readonly exclusiveWriters: true;
  readonly native: RuntimeNativePreparationStorage;
  readonly sessionsRoot: string;
  /** Durable host delivery identity, never run ID or text hash. Undefined means
   * this is NOT an explicit-message authorization (cron/continuation/recovery). */
  readonly deliveryId: (request: AgentHarnessRequest) => string | undefined;
}
export interface ConfiguredPreparedTurn {
  readonly context: Awaited<ReturnType<typeof prepareHarnessRuntime>>["context"];
  readonly protectedHandles: Set<string>;
  run(binding: ProviderSessionTurnBinding, onAdmitted: (turn: Awaited<ReturnType<ManagedProviderSessionPreparation["admit"]>>) => void): Promise<RuntimeResult>;
  close(): Promise<void>;
}
const pending = () => new AgentHarnessError("handoff_pending", "Model handoff is pending. This message was not admitted or queued; send another explicit message to authorize further summary work.");
const budgetFailure = (reason: string) => new AgentHarnessError("handoff_budget_exceeded", `Model handoff cannot fit: ${reason}. No incoming turn was admitted or queued.`);
const capacity = (error: unknown) => error instanceof ModelSwitchCapacityError || error instanceof NativeEvidenceCapacityError;

/** Host path behind the private capability. Unsupported custom stores/runtimes
 * retain the original path without preparing resources or issuing authority. */
export async function prepareConfiguredModelSwitch(input: {
  readonly policy: InternalNativeSwitchPolicy; readonly preparation: Omit<HarnessRuntimePreparationInput, "assertOwned" | "prepareContext">;
  readonly prepareContext: HarnessRuntimePreparationInput["prepareContext"];
}): Promise<ConfiguredPreparedTurn | undefined> {
  const { policy, preparation: host } = input, options = host.options;
  const runtime = host.routing.runtimeForSession(host.routing.modelKey), store = options.historyStore;
  const checkInheritedPrefix = policy.native.checkInheritedPrefix?.bind(policy.native);
  if (!(store instanceof DurableConversationHistoryStore) || policy.native.nativeEvidence !== "v1" || !checkInheritedPrefix
    || runtime.nativePreparedDispatch !== "v1" || !runtime.prepareNativeDispatch || runtime.sessionTurnReconciliation !== "v1" || !runtime.reconcileSessionTurn) return undefined;
  if (policy.exclusiveWriters !== true || resolve(policy.sessionsRoot) !== resolve(host.durablePiSessionsRoot)) throw new AgentHarnessError("native_switch_authority_unavailable", "Explicit upgraded-writer acknowledgement and the configured native root are required.");
  const owner = await store.beginProviderSessionPreparation(host.request.conversationId, host.runId);
  let assertOwned = () => owner.assertOwned();
  let incoming: Awaited<ReturnType<typeof prepareHarnessRuntime>> | undefined;
  let outgoing: PreparedSwitchProducer | undefined;
  const protectedHandles = new Set<string>();
  let ready: Extract<Awaited<ReturnType<typeof advancePreparedModelSwitch>>, { status: "ready" }> | undefined;
  let switched = false, cold = false;
  try {
    let snapshot = await owner.read();
    if (snapshot.source.status === "unsupported" && !snapshot.native && !snapshot.pending) { await owner.abort(); return undefined; }
    if (snapshot.pending) {
      const recovered = await recoverPreparedModelSwitch(owner, { exclusiveWriters: true });
      if (recovered.status === "ready") {
        snapshot = await owner.read(); switched = true;
        if (recovered.modelKey !== host.routing.modelKey) throw pending(); // Finish recorded switch; never dispatch this message on a different target.
        ready = recovered;
      }
    }
    incoming = await prepareHarnessRuntime({ ...host, assertOwned: () => assertOwned(), prepareContext: input.prepareContext });
    const compaction = incoming.snapshot.compactionSummaryMaxTokens === undefined ? {} : { summaryMaxTokens: incoming.snapshot.compactionSummaryMaxTokens };
    if (!ready && (snapshot.source.status === "supported" && snapshot.source.fromModelKey !== host.routing.modelKey || snapshot.pending)) {
      const messageId = policy.deliveryId(host.request);
      if (messageId === undefined) { if (snapshot.pending) throw pending(); cold = true; }
      else {
        try {
          if (snapshot.native && snapshot.native.chain.length >= MAX_JOURNAL_CHAIN && !snapshot.pending) cold = true;
          else {
            const from = snapshot.pending?.identity.fromModelKey ?? (snapshot.source.status === "supported" ? snapshot.source.fromModelKey : undefined);
            if (!from) throw new Error("Pending switch has no source owner");
            // Capture owned bytes without old auth/provider availability. Resolve
            // the outgoing no-tools lease lazily at its unbilled producer slot.
            const captured = await owner.captureNativeEvidence();
            const prepareOutgoing = async (): Promise<PreparedSwitchProducer | undefined> => {
              try {
                const outgoingRuntime = host.routing.runtimeForSession(from);
                if (outgoingRuntime.nativePreparedDispatch !== "v1" || !outgoingRuntime.prepareNativeDispatch) return undefined;
                const outgoingOptions: RuntimeRunOptions = { ...options.runtimeOptions, model: parseMonoRuntimeModelReference(from), messages: [],
                  abortSignal: host.request.abortSignal, allowedTools: [], disallowedTools: [], mcpServers: {}, skills: [], piSessionsRoot: host.durablePiSessionsRoot };
                for (const key of ["outputSchema", "piResolvedModel", "sessionId", "providerSessionId", "providerAttributionSessionId", "sessionTurn", "sessionRecovery", "nativeSessionAuthority", "nativeSessionProjection", "liveInput"]) delete (outgoingOptions as Record<string, unknown>)[key];
                const lease = await outgoingRuntime.prepareNativeDispatch("Produce only the requested structured conversation handoff.", outgoingOptions);
                if (!lease.checkHandoffSummary || !lease.produceHandoffSummary) { await lease.close(); return undefined; }
                outgoing = { snapshot: lease.snapshot, checkHandoffSummary: (request) => {
                  try { return lease.checkHandoffSummary!(request); } catch { return { status: "budget_failure", reason: "outgoing_unavailable" }; }
                }, produceHandoffSummary: (request) => lease.produceHandoffSummary!(request), close: () => lease.close() };
                return outgoing;
              } catch (error) {
                // No paid attempt exists yet. Unavailable old auth/provider skips
                // its slot; abort/lost ownership still stop the entire operation.
                if (host.request.abortSignal.aborted) throw error;
                await owner.assertOwned(); return undefined;
              }
            };
            let state = snapshot.pending;
            if (!state) {
              if (snapshot.source.status !== "supported") throw new Error("Switch source is unavailable");
              const targetEpoch = randomBytes(32).toString("hex");
              state = createPreparedModelSwitchState({ source: snapshot.source, sources: captured.sources, incoming: incoming.snapshot, native: policy.native,
                targetEpoch, timestamp: Date.now(), messageId, outputReserve: incoming.snapshot.model.maxTokens,
                reservation: { canonicalBytes: 0, artifactBytes: 0, retainedNativeBytes: 0, headerCopyBytes: 0, pendingBytes: 0 } });
              const handoffOptions = { target: state.identity.targetProvenance, budget: state.frozenBudget!, timestamp: state.identity.timestamp, hostContext: {} };
              let nativeProposal = prepareNativeSwitchProjection(policy.native, captured.view, state);
              if (nativeProposal && (await checkInheritedPrefix(nativeProposal.nativeProjection.messages, incoming.snapshot.model, compaction)).status !== "ready") nativeProposal = undefined;
              const prepared = policy.native.prepareHandoff(captured.view, handoffOptions);
              if (!nativeProposal && prepared.status !== "prepared") throw budgetFailure(prepared.reason);
              // Bound ANY subsequently accepted structured artifact, including a
              // not-yet-produced summary: its serialized projection is capped by
              // historyAllowance. Add that cap to the real empty summary envelope.
              const capacityFit = await checkInheritedPrefix([], incoming.snapshot.model, compaction, state.frozenBudget!.historyAllowance);
              if (capacityFit.status !== "ready") throw budgetFailure(capacityFit.reason);
              const proposal = nativeProposal ? { status: "ready" as const, messages: nativeProposal.nativeProjection.messages }
                : policy.native.buildHandoff(captured.view, handoffOptions);
              // Prove the exact free projection's future compaction viability before
              // intent/paid work. Paid proposals are checked again before acceptance.
              if (proposal.status === "ready") {
                const fit = await checkInheritedPrefix(proposal.messages, incoming.snapshot.model, compaction);
                if (fit.status !== "ready") throw budgetFailure(fit.reason);
              }
              const authority = await owner.acquireNativeHistoryAuthority({ exclusiveWriters: policy.exclusiveWriters });
              if (authority.status !== "owned") cold = true;
              else {
                const targetHandleId = switchProviderSessionId(host.request.conversationId, targetEpoch);
                const measured = await policy.native.measureSwitch(captured.sources, { hostAuthority: authority.authority, assertOwned: () => owner.assertOwned(),
                  targetHandleId, targetEpoch, timestamp: state.identity.timestamp, sourceRevision: state.identity.sourceRevision, fromModelKey: state.identity.fromModelKey,
                  targetProvenance: state.identity.targetProvenance, event: { switchId: state.identity.switchId, timestamp: state.identity.timestamp,
                    from: captured.sources.at(-1)!.provenance, to: state.identity.targetProvenance, artifactRef: { id: "0".repeat(64), hash: "0".repeat(64) } } });
                const canonicalBytes = Math.min(MAX_MODEL_SWITCH_BYTES, Buffer.byteLength(JSON.stringify(snapshot)) + 16384 + captured.sources.length * 4096);
                const artifactBytes = Math.min(MAX_MODEL_SWITCH_BYTES, Math.max(4096, state.frozenBudget!.historyAllowance * 3 + 4096));
                state = { ...state, reservation: { canonicalBytes, artifactBytes, ...measured, pendingBytes: Buffer.byteLength(JSON.stringify(state)) * 3 + 65536 } };
              }
            }
            if (!cold) {
              const result = await advancePreparedModelSwitch({ preparation: owner, native: policy.native, incoming, state, view: captured.view, messageId,
                exclusiveWriters: policy.exclusiveWriters, outgoing: prepareOutgoing,
                checkInheritedPrefix: (messages) => checkInheritedPrefix(messages, incoming!.snapshot.model, compaction) });
              if (result.status === "pending") throw pending();
              if (result.status === "budget_failure") throw budgetFailure(result.reason);
              if (result.status === "unsupported") cold = true;
              else { ready = result; switched = true; snapshot = await owner.read(); }
            }
          }
        } catch (error) {
          // Only typed PRE-INTENT capacity/size refusal is cold fallback. Never
          // disguise corruption, lost ownership, unknown paid work or pending.
          if (!snapshot.pending && capacity(error) && !(await owner.read()).pending) cold = true;
          else throw error;
        }
      }
    }
    if (snapshot.source.status === "unsupported") cold = true;
    if (cold && snapshot.native) throw new AgentHarnessError("native_cold_model_change_unavailable", "Cold model change on a guarded chain requires the unactivated whole-chain lifecycle coordinator; native evidence was preserved.");
    if (!ready && !cold && snapshot.native?.projection && snapshot.lastSwitch?.artifact) ready = {
      status: "ready", switchId: snapshot.lastSwitch.switchId, artifact: snapshot.native.projection, modelKey: host.routing.modelKey };
    snapshot.native?.chain.forEach((row) => protectedHandles.add(row.handleId));
    const prepared = incoming;
    const onTurn = (turn: Awaited<ReturnType<typeof owner.admit>>, notify: Parameters<ConfiguredPreparedTurn["run"]>[1]) => {
      assertOwned = () => turn.assertOwned(); turn.native?.chain.forEach((row) => protectedHandles.add(row.handleId)); notify(turn);
    };
    return { context: prepared.context, protectedHandles,
      run: async (binding, notify) => {
        const refresh = async (turn: Awaited<ReturnType<typeof owner.admit>>) => { if (!runtime.refreshSession) throw new Error("Strict native refresh unavailable"); await runtime.refreshSession(turn.providerSessionId); };
        if (ready) return await runPreparedModelSwitch({ preparation: owner, incoming: prepared, ready, binding, sessionsRoot: host.durablePiSessionsRoot,
          switching: switched, onAdmitted: (turn) => onTurn(turn, notify), beforeDispatch: refresh });
        return await prepared.run(async () => {
          const turn = await owner.admit(binding, cold ? { coldModelChange: true } : undefined); onTurn(turn, notify); await refresh(turn);
          if (!turn.reconciliation) throw new Error("Prepared host requires owned native execution reconciliation");
          const id = turn.providerSessionId;
          return { reconciliation: turn.reconciliation, assertOwned: () => turn.assertOwned(), turnRevision: turn.providerSessionRevision,
            sessionId: id, providerSessionId: id, providerAttributionSessionId: id, sessionKeepAlive: true, sessionTurn: turn.reconciliation.descriptor,
            ...(turn.native ? { nativeSessionAuthority: { version: 1 as const, currentHandleId: id, sessionsRoot: host.durablePiSessionsRoot, hostAuthority: turn.native.authority,
              assertCurrent: async (request: { handleId: string; sessionsRoot: string }) => { await turn.assertOwned(); if (request.handleId !== id || resolve(request.sessionsRoot) !== resolve(host.durablePiSessionsRoot)) throw new Error("Prepared native current authority changed"); } } } : {}) };
        });
      }, close: async () => { try { await prepared.close(); } finally { await owner.abort(); } } };
  } catch (error) { try { await incoming?.close(); } finally { await owner.abort(); } if (error instanceof NativeHistoryAuthorityBusyError) throw new AgentHarnessError("native_switch_busy", error.message, { retryable: true }); throw error; }
  finally { await outgoing?.close().catch(() => {}); }
}
// Same epoch/handle identity as durable history; never a process/run identifier.
function switchProviderSessionId(id: string, epoch: string): string { return createHash("sha256").update("mono-agent-provider-session-v2\0").update(id).update("\0").update(epoch).digest("hex"); }
