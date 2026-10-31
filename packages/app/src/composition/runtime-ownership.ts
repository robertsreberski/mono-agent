import type { ConversationHarness } from "@mono-agent/conversation";
import type { MonoAgentConfig } from "@mono-agent/config";
import type { LlmComplete } from "@mono-agent/memory/bujo";
import { createSrtSandboxEngine, mergeSandboxPolicies } from "@mono-agent/turn/host/sandbox";
import type { MonoRuntimeLike, RuntimeRunOptions, SandboxEngine } from "@mono-agent/turn/host/types";

import { completionOnlyRuntime } from "./configured-runtime-capabilities.js";
import { acquireAgentRootOwnership, assertAgentRootLeaseOutsideWorkspace, releaseAgentRootOwnershipWhenIdle, type AgentRootOwnership } from "../durable-state/agent-root-coordinator.js";
import { attestProcessJobsRootRegistrySnapshot, loadProcessJobsRootRegistryProtection, processJobsProtectionPolicyRoots } from "../process-jobs/process-jobs-root-registry.js";
import { processJobsSandboxPolicy, PROCESS_JOBS_PI_NATIVE_REQUIRED_ERROR, PROCESS_JOBS_PROTECTION_UNAVAILABLE_ERROR } from "../process-jobs/process-jobs-runtime.js";
import type { ProcessJobsProtectionPosture } from "../process-jobs/process-jobs-protection.js";
import type { ConfiguredEmbeddingProvider } from "./configured-agent-options.js";
import { configuredRoutesOnlyPiNative } from "./configured-runtime-routes.js";

// Explicit ownership boundary: new runtime/prepared methods require disposition.
const ownedRuntimeKeys = {
  run: true, prepareNativeDispatch: true, prepareContinuityUpkeep: true,
  configureTools: true, syncSession: true, sessionTurnReconciliation: true,
  reconcileSessionTurn: true, recoverSession: true, refreshSession: true,
  // Deliberately omitted: switch dispatch does not need default-path salvage.
  salvageDurableSession: false, retireDurableSession: true, disposeSession: true,
  invalidateSession: true, disposeAllSessions: true,
} satisfies Record<keyof MonoRuntimeLike, boolean>;
const ownedPreparedKeys = {
  snapshot: true, assertReady: true, checkHandoffSummary: true,
  produceHandoffSummary: true, run: true, close: true,
} satisfies Record<keyof import("@mono-agent/turn/host/types").RuntimeNativePreparedDispatch, true>;
void ownedRuntimeKeys; void ownedPreparedKeys;

/** @internal Package-private ownership wrapper test seam; absent from root exports. */
export function wrapOwnedConfiguredRuntime(
  runtime: MonoRuntimeLike,
  config: MonoAgentConfig,
  agentRoot: string | undefined,
  configuredSandboxEngine: SandboxEngine | undefined,
): MonoRuntimeLike {
  let security: Promise<{ readonly ownership: AgentRootOwnership }> | undefined;
  let disposed = false;
  const loadSecurity = async () => {
    const ownership = await acquireAgentRootOwnership(agentRoot);
    try {
      assertAgentRootLeaseOutsideWorkspace(ownership, config.runtime.workspace);
      return { ownership };
    } catch (error) {
      await releaseAgentRootOwnershipWhenIdle(ownership).catch(() => undefined);
      throw error;
    }
  };
  const secured = () => {
    if (security !== undefined) return security;
    const attempt = loadSecurity();
    security = attempt;
    // Never cache a failed acquisition: a transient condition such as a busy
    // ownership gate must not disable this runtime. Only clear our own attempt.
    attempt.catch(() => { if (security === attempt) security = undefined; });
    return attempt;
  };
  const releaseOwnership = async (): Promise<void> => {
    const current = security;
    security = undefined;
    if (current === undefined) return;
    const { ownership } = await current.catch(() => ({ ownership: undefined }));
    if (ownership !== undefined) {
      await releaseAgentRootOwnershipWhenIdle(ownership);
    }
  };
  const withReconciliationLease = async <T>(action: () => Promise<T>): Promise<T> => {
    if (disposed) throw new Error("Configured runtime has been disposed.");
    const { ownership } = await secured();
    const registry = await loadProcessJobsRootRegistryProtection(ownership.agentRoot, config.runtime.workspace);
    ownership.coordinator.synchronizeGeneration(registry.generation);
    const boundary = await attestProcessJobsRootRegistrySnapshot(registry, config.runtime.workspace);
    if (disposed) throw new Error("Configured runtime has been disposed.");
    const lease = ownership.coordinator.acquireRequestLease(boundary.generation);
    try { await attestProcessJobsRootRegistrySnapshot(boundary, config.runtime.workspace); return await action(); }
    finally { lease.releaseAfterSettlement(); }
  };
  // A prepared lease owns the same protection generation as ordinary run(),
  // but its lifetime ends at dispatch/close, not when preparation returns.
  const secureOptions = async (runOptions: RuntimeRunOptions) => {
    if (disposed) throw new Error("Configured runtime has been disposed.");
    const { ownership } = await secured();
    const registry = await loadProcessJobsRootRegistryProtection(
      ownership.agentRoot,
      config.runtime.workspace,
    );
    ownership.coordinator.synchronizeGeneration(registry.generation);
    const boundary = await attestProcessJobsRootRegistrySnapshot(registry, config.runtime.workspace);
    if (disposed) throw new Error("Configured runtime has been disposed.");
    const lease = ownership.coordinator.acquireRequestLease(boundary.generation);
    try {
      const attested = await attestProcessJobsRootRegistrySnapshot(boundary, config.runtime.workspace);
      const protectedRoots = processJobsProtectionPolicyRoots(attested);
      let effectiveOptions = runOptions;
      if (protectedRoots.length > 0) {
        const verdict = configuredRoutesOnlyPiNative(config, runOptions.model);
        if (!verdict.ok) {
          throw new Error(
            `${PROCESS_JOBS_PI_NATIVE_REQUIRED_ERROR} Rejected the configured runtime chain: ${verdict.reason}.`,
          );
        }
        const sandboxEngine = runOptions.sandboxEngine
          ?? configuredSandboxEngine
          ?? createSrtSandboxEngine();
        if (!await sandboxEngine.isAvailable().catch(() => false)) {
          throw new Error(PROCESS_JOBS_PROTECTION_UNAVAILABLE_ERROR);
        }
        const sandboxPolicy = mergeSandboxPolicies(
          runOptions.sandboxPolicy,
          processJobsSandboxPolicy({ coreConfig: config, protectedRoots }),
        );
        if (sandboxPolicy === undefined) {
          throw new Error(PROCESS_JOBS_PROTECTION_UNAVAILABLE_ERROR);
        }
        effectiveOptions = {
          ...runOptions,
          sandboxPolicy,
          sandboxEngine,
        };
      }
      return { effectiveOptions, release: () => lease.releaseAfterSettlement() };
    } catch (error) {
      lease.releaseAfterSettlement();
      throw error;
    }
  };
  return {
    ...(runtime.prepareContinuityUpkeep === undefined ? {} : { prepareContinuityUpkeep: runtime.prepareContinuityUpkeep.bind(runtime) }),
    async run(systemPrompt, runOptions) {
      const secured = await secureOptions(runOptions);
      try { return await runtime.run(systemPrompt, secured.effectiveOptions); }
      finally { secured.release(); }
    },
    ...(runtime.prepareNativeDispatch === undefined ? {} : {
      async prepareNativeDispatch(systemPrompt: string, runOptions: RuntimeRunOptions) {
        const secured = await secureOptions(runOptions);
        let nativeLease: import("@mono-agent/turn/host/types").RuntimeNativePreparedDispatch | undefined;
        try {
          const prepared = await runtime.prepareNativeDispatch!(systemPrompt, secured.effectiveOptions);
          nativeLease = prepared;
          let released = false, started = false, closed = false;
          const release = () => { if (!released) { released = true; secured.release(); } };
          return {
            snapshot: prepared.snapshot,
            ...(prepared.assertReady === undefined ? {} : { assertReady: prepared.assertReady.bind(prepared) }),
            ...(prepared.checkHandoffSummary === undefined ? {} : { checkHandoffSummary: prepared.checkHandoffSummary.bind(prepared) }),
            ...(prepared.produceHandoffSummary === undefined ? {} : { produceHandoffSummary: prepared.produceHandoffSummary.bind(prepared) }),
            async run(binding) {
              if (started || closed) throw new Error("Prepared dispatch has already been consumed.");
              started = true;
              try { return await prepared.run(binding); }
              finally { release(); }
            },
            async close() {
              closed = true;
              try { await prepared.close(); }
              finally { release(); }
            },
          } satisfies import("@mono-agent/turn/host/types").RuntimeNativePreparedDispatch;
        } catch (error) {
          try { await nativeLease?.close(); } catch { /* Preserve preparation failure. */ }
          finally { secured.release(); }
          throw error;
        }
      },
    }),
    ...(runtime.configureTools === undefined
      ? {}
      : { configureTools: runtime.configureTools.bind(runtime) }),
    ...(runtime.sessionTurnReconciliation === undefined ? {} : { sessionTurnReconciliation: runtime.sessionTurnReconciliation }),
    ...(runtime.reconcileSessionTurn === undefined ? {} : { reconcileSessionTurn: (request) => withReconciliationLease(() => runtime.reconcileSessionTurn!(request)) }),
    ...(runtime.recoverSession === undefined ? {} : { recoverSession: (receipt, context) => withReconciliationLease(() => runtime.recoverSession!(receipt, context)) }),
    ...(runtime.syncSession === undefined ? {} : { syncSession: runtime.syncSession.bind(runtime) }),
    ...(runtime.refreshSession === undefined ? {} : { refreshSession: runtime.refreshSession.bind(runtime) }),
    ...(runtime.retireDurableSession === undefined
      ? {}
      : { retireDurableSession: runtime.retireDurableSession.bind(runtime) }),
    ...(runtime.disposeSession === undefined ? {} : { disposeSession: runtime.disposeSession.bind(runtime) }),
    ...(runtime.invalidateSession === undefined
      ? {}
      : { invalidateSession: runtime.invalidateSession.bind(runtime) }),
    async disposeAllSessions(): Promise<void> {
      if (disposed) return;
      disposed = true;
      try {
        await runtime.disposeAllSessions?.();
      } finally {
        await releaseOwnership();
      }
    },
  };
}

// Deliberately inventory the explicit forwarding boundary. Adding even an
// optional harness capability must force a review of this wrapper.
const ownedHarnessKeys = {
  compactConversation: true,
  liveInputOwnership: true,
  run: true,
  offerLiveInput: true,
  submit: true,
  cancel: true,
  resetConversation: true,
  appendVerbatimTurn: true,
  importContext: true,
  dispose: true,
} satisfies Record<keyof ConversationHarness, true>;
void ownedHarnessKeys;

export function harnessWithAgentRootOwnership(
  harness: ConversationHarness,
  ownership: AgentRootOwnership,
): ConversationHarness {
  let disposePromise: Promise<void> | undefined;
  return {
    ...(harness.liveInputOwnership === undefined ? {} : { liveInputOwnership: harness.liveInputOwnership }),
    ...(harness.compactConversation === undefined
      ? {}
      : { compactConversation: harness.compactConversation.bind(harness) }),
    run: harness.run.bind(harness),
    ...(harness.submit === undefined ? {} : { submit: harness.submit.bind(harness) }),
    ...(harness.offerLiveInput === undefined
      ? {}
      : { offerLiveInput: harness.offerLiveInput.bind(harness) }),
    ...(harness.cancel === undefined ? {} : { cancel: harness.cancel.bind(harness) }),
    ...(harness.resetConversation === undefined
      ? {}
      : { resetConversation: harness.resetConversation.bind(harness) }),
    ...(harness.appendVerbatimTurn === undefined
      ? {}
      : { appendVerbatimTurn: harness.appendVerbatimTurn.bind(harness) }),
    ...(harness.importContext === undefined
      ? {}
      : { importContext: harness.importContext.bind(harness) }),
    dispose: () => {
      disposePromise ??= Promise.resolve()
        .then(async () => await harness.dispose?.())
        .finally(async () => {
          await releaseAgentRootOwnershipWhenIdle(ownership);
        });
      return disposePromise;
    },
  };
}

/**
 * Memory completion is a model-running surface even when no channel harness is
 * present. Acquire the canonical-root owner and protection generation for the
 * exact duration of the provider call; release follows actual runtime
 * settlement, never its abort signal.
 */
export function wrapPerRunOwnedConfiguredRuntime(
  runtime: MonoRuntimeLike,
  config: MonoAgentConfig,
  agentRoot: string | undefined,
  protectionPosture: ProcessJobsProtectionPosture | undefined,
): MonoRuntimeLike {
  // Memory completion has no storage-settlement caller. Do not advertise
  // inherited recovery methods that would bypass this per-run ownership lease.
  const completionRuntime = completionOnlyRuntime(runtime);
  return {
    ...completionRuntime,
    async run(systemPrompt, runOptions) {
      const ownership = await acquireAgentRootOwnership(agentRoot);
      let requestLease: ReturnType<AgentRootOwnership["coordinator"]["acquireRequestLease"]> | undefined;
      try {
        assertAgentRootLeaseOutsideWorkspace(ownership, config.runtime.workspace);
        const loaded = await loadProcessJobsRootRegistryProtection(
          ownership.agentRoot,
          config.runtime.workspace,
        );
        ownership.coordinator.synchronizeGeneration(loaded.generation);
        const boundary = await attestProcessJobsRootRegistrySnapshot(loaded, config.runtime.workspace);
        requestLease = ownership.coordinator.acquireRequestLease(boundary.generation);
        const attested = await attestProcessJobsRootRegistrySnapshot(boundary, config.runtime.workspace);
        const protectedRoots = processJobsProtectionPolicyRoots(attested);
        let effectiveOptions = runOptions;
        if (protectedRoots.length > 0) {
          if (protectionPosture?.suppressSyntheticSandbox !== true) {
            const sandboxEngine = runOptions.sandboxEngine ?? createSrtSandboxEngine();
            if (!await sandboxEngine.isAvailable().catch(() => false)) {
              throw new Error(PROCESS_JOBS_PROTECTION_UNAVAILABLE_ERROR);
            }
            const sandboxPolicy = mergeSandboxPolicies(
              runOptions.sandboxPolicy,
              processJobsSandboxPolicy({ coreConfig: config, protectedRoots }),
            );
            if (sandboxPolicy === undefined) {
              throw new Error(PROCESS_JOBS_PROTECTION_UNAVAILABLE_ERROR);
            }
            effectiveOptions = {
              ...runOptions,
              sandboxPolicy,
              sandboxEngine,
            };
          }
        }
        return await runtime.run(systemPrompt, effectiveOptions);
      } finally {
        requestLease?.releaseAfterSettlement();
        await releaseAgentRootOwnershipWhenIdle(ownership);
      }
    },
  };
}

/**
 * The direct (non-agent-host) memory LLM executes outside the channel harness.
 * Hold the same canonical-root owner and generation lease through the true
 * complete() settlement so an out-of-harness provider call cannot outlive the
 * protection generation it started under.
 *
 * A retained process-job root does NOT reject this provider. SRT confines the
 * MODEL'S TOOL LOOP; the host process is already unconfined and already reads
 * the private state dir. `LlmComplete` is a single `complete(prompt) => string`
 * over HTTP with no tools and no filesystem access, so there is nothing here
 * for confinement to protect — while rejecting it made `processJobs.enabled`
 * mutually exclusive with the bujo/journal memory tiers (mono-agent#664). The
 * lease, not the sandbox, is this seam's control.
 */
export function wrapOwnedDirectMemoryLlm(
  llm: LlmComplete,
  config: MonoAgentConfig,
  agentRoot: string | undefined,
): LlmComplete {
  return {
    ...llm,
    async complete(prompt, options) {
      const ownership = await acquireAgentRootOwnership(agentRoot);
      let requestLease: ReturnType<AgentRootOwnership["coordinator"]["acquireRequestLease"]> | undefined;
      try {
        assertAgentRootLeaseOutsideWorkspace(ownership, config.runtime.workspace);
        const loaded = await loadProcessJobsRootRegistryProtection(
          ownership.agentRoot,
          config.runtime.workspace,
        );
        ownership.coordinator.synchronizeGeneration(loaded.generation);
        const boundary = await attestProcessJobsRootRegistrySnapshot(loaded, config.runtime.workspace);
        requestLease = ownership.coordinator.acquireRequestLease(boundary.generation);
        await attestProcessJobsRootRegistrySnapshot(boundary, config.runtime.workspace);
        return await llm.complete(prompt, options);
      } finally {
        requestLease?.releaseAfterSettlement();
        await releaseAgentRootOwnershipWhenIdle(ownership);
      }
    },
  };
}

/**
 * Configured embedding providers execute outside the channel harness. Hold the
 * same canonical-root owner and generation lease through the true embed()
 * settlement so an out-of-harness provider call cannot outlive the protection
 * generation it started under.
 *
 * A retained process-job root does NOT reject this provider — see the sibling
 * `wrapOwnedDirectMemoryLlm` doc for the reasoning. `embed(texts) =>
 * number[][]` is one method with no model-steerable surface, and the bujo and
 * journal tiers REQUIRE it, so rejecting it disabled memory outright under the
 * safe posture (mono-agent#664).
 */
export function wrapOwnedDirectEmbeddingProvider(
  provider: ConfiguredEmbeddingProvider,
  config: MonoAgentConfig,
  agentRoot: string | undefined,
): ConfiguredEmbeddingProvider {
  return {
    ...provider,
    async embed(texts) {
      const ownership = await acquireAgentRootOwnership(agentRoot);
      let requestLease: ReturnType<AgentRootOwnership["coordinator"]["acquireRequestLease"]> | undefined;
      try {
        assertAgentRootLeaseOutsideWorkspace(ownership, config.runtime.workspace);
        const loaded = await loadProcessJobsRootRegistryProtection(
          ownership.agentRoot,
          config.runtime.workspace,
        );
        ownership.coordinator.synchronizeGeneration(loaded.generation);
        const boundary = await attestProcessJobsRootRegistrySnapshot(loaded, config.runtime.workspace);
        requestLease = ownership.coordinator.acquireRequestLease(boundary.generation);
        await attestProcessJobsRootRegistrySnapshot(boundary, config.runtime.workspace);
        return await provider.embed(texts);
      } finally {
        requestLease?.releaseAfterSettlement();
        await releaseAgentRootOwnershipWhenIdle(ownership);
      }
    },
  };
}
