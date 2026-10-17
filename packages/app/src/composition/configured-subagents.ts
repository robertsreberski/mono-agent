import { readFileSync } from "node:fs";
import type { MonoAgentConfig } from "@mono-agent/config";
import { composeHostTurnEnvelope, formatHostCapabilities, HOST_TURN_CONTEXT_GUIDANCE, renderSkillIndexSection } from "@mono-agent/conversation";
import type { ConversationHarnessOptions, LiveInputMailbox, SkillIndexSummary } from "@mono-agent/conversation";
import { describeMonoRuntimeSupport, monoRuntimeSupportsLiveInput } from "@mono-agent/turn/host";
import { modelReferenceKey } from "@mono-agent/turn/host/config";
import { mergeSandboxPolicies } from "@mono-agent/turn/host/sandbox";
import type { MonoRuntimeLike, OwnedForegroundProcesses, RuntimeModelReference, RuntimeResult, RuntimeRunOptions, SandboxEngine, SandboxPolicy } from "@mono-agent/turn/host/types";

import { configuredToolPolicyInput as toolPolicyInput } from "../host/computer-use.js";
import { BUILTIN_TOOL_NAMES, canonicalToolName, isAllowAllTools } from "../tools/known-tools.js";
import { attestProcessJobsRootRegistrySnapshot, loadProcessJobsRootRegistryProtection, processJobsProtectionPolicyRoots, type ProcessJobsRootRegistrySnapshot } from "../process-jobs/process-jobs-root-registry.js";
import { clearSessionsSandboxPolicy, type ClearSessionsRuntimeBoundaryOptions } from "./runtime-option-extensions.js";
import { isReadSkillDenied } from "../skills/skill-registry.js";
import { createSubagentInstanceRegistry, persistentSubagentsEnabled, subagentInstancesRoot } from "../subagents/subagent-instances.js";
import { createSubagentRecoveryAccess } from "../subagents/subagent-recovery-access.js";
import type { InstanceRegistryHandle } from "../subagents/types.js";
import { createHostWebRequestCoordinator } from "../host/web-request-coordinator.js";
import type { ConfiguredAgentInternalHooks, ConfiguredConversationHarnessOptions, StaticRuntimeOptions } from "./configured-agent-options.js";

/**
 * Narrow the loaded MCP servers to the ones a profile names.
 *
 * An unknown name is a configuration error the loader cannot catch (it does not
 * read mcp.json), and silently dropping it would leave the subagent quietly
 * less capable than its config claims.
 */
function selectMcpServers(
  available: Record<string, unknown>,
  names: readonly string[] | undefined,
  profile: string,
): Record<string, unknown> {
  if (names === undefined || names.length === 0) {
    return {};
  }
  const selected: Record<string, unknown> = {};
  for (const name of names) {
    if (!Object.hasOwn(available, name)) {
      throw new Error(
        `Subagent "${profile}" references MCP server "${name}", which is not defined in tools.mcpConfigPath or tools.computerUse.`,
      );
    }
    selected[name] = available[name];
  }
  return selected;
}

/** Denied for every subagent regardless of profile. Mirrors the kernel's own list. */
const SUBAGENT_HARD_DENY = [
  "Agent",
  "AgentManage",
  "AskUser",
  "SlackSendMessage",
  "TelegramSendMessage",
  "TelegramSendFile",
] as const;

/** Read-only default when a profile does not enumerate its tools. */
const DEFAULT_SUBAGENT_TOOLS = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"] as const;

/**
 * Cap on the tools the agent may grant a subagent it authors at call time.
 *
 * A subagent's `allowedTools` become its real tool set, so an unbounded list
 * would let the model hand a helper a tool its own policy denies it. An
 * operator-authored profile may legitimately exceed the parent (they wrote it);
 * one the model invents may not. Absent an explicit ceiling, the parent's own
 * effective built-ins are the bound — an authored helper never reaches further
 * than its author.
 */
function inlineSubagentCeiling(config: MonoAgentConfig): readonly string[] {
  const configured = config.subagents?.inline?.allowedTools;
  const parentTools = isAllowAllTools(config.tools.allowedTools)
    ? [...BUILTIN_TOOL_NAMES]
    : config.tools.allowedTools.map(canonicalToolName);
  const denied = new Set([
    ...SUBAGENT_HARD_DENY as readonly string[],
    ...config.tools.disallowedTools.map(canonicalToolName),
  ]);
  const ceiling = configured ?? parentTools.filter((name) => (BUILTIN_TOOL_NAMES as readonly string[]).includes(name));
  return ceiling.filter((name) => !denied.has(canonicalToolName(name)));
}

interface SubagentRunRequest {
  readonly ownedForegroundProcesses?: OwnedForegroundProcesses;
  /** Host mailbox for parent steering of this detached turn; used only if this route supports live input. */
  readonly liveInput?: LiveInputMailbox;
  readonly detached?: true;
  readonly turnToken?: string;
  readonly deadlineAt?: number;
  readonly instance?: { readonly id: string; readonly sessionId: string; readonly sessionsRoot: string };
  readonly model?: RuntimeModelReference;
  readonly effort?: string;
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly definition: {
    readonly name: string;
    readonly model?: RuntimeModelReference;
    readonly effort?: string;
    readonly allowedTools?: readonly string[];
    readonly disallowedTools?: readonly string[];
    readonly mcpServers?: Record<string, unknown>;
    readonly mcpServerNames?: readonly string[];
  };
  readonly maxTurns: number;
  readonly depth: number;
  readonly cwd?: string;
  readonly sandboxPolicy?: unknown;
  readonly sandboxEngine?: unknown;
  /** The parent turn's disclosed skills, offered by the `Agent` tool. */
  readonly skills?: readonly SkillIndexSummary[];
  readonly skillsRoot?: string;
  readonly toolEnvironment?: RuntimeRunOptions["toolEnvironment"];
  readonly abortSignal: AbortSignal;
  readonly onEvent: (event: unknown) => void;
}

/**
 * Whether a child on this route can be handed `skills` at all.
 *
 * This is a correctness guard, not an optimization. A non-empty `options.skills`
 * makes `supports_skills` a ROUTING REQUIREMENT (see the router's capability
 * matching), and a chain entry that does not advertise it is skipped — so
 * threading skills onto a child pinned to a runtime without skill support turns
 * a working subagent into `skipped_capability_mismatch`. Direct OpenCode is the
 * live example. The parent's own chain is already validated for this by doctor;
 * a profile that pins its own model is not, which is why the check lives here.
 *
 * Fails closed: an unparseable or incompatible route means no skills, never a
 * throw from what is otherwise a plain forwarding decision.
 */
function childRuntimeSupportsSkills(
  model: RuntimeModelReference,
): boolean {
  try {
    const support = describeMonoRuntimeSupport(model);
    return support.backend?.capabilities.supports_skills !== false;
  } catch {
    return false;
  }
}

/** Inline prompt, or the contents of promptPath; the loader guarantees exactly one. */
function resolveSubagentPrompt(definition: { readonly prompt?: string; readonly promptPath?: string }): string {
  if (definition.prompt !== undefined) {
    return definition.prompt;
  }
  return readFileSync(definition.promptPath as string, "utf8");
}

/**
 * Build the `subagents` runtime option: the profiles the `Agent` tool offers,
 * its caps, and the callback that runs one child turn.
 *
 * agent-app owns this rather than the harness or the adapter because it alone
 * holds the config, the router runtime, and `runtimeForModel`. Routing a child
 * through the shared router is what gives subagents the configured fallback
 * chain and same-model retries for free.
 */
export function buildSubagentsOptions(
  config: MonoAgentConfig,
  deps: {
    readonly runtime: MonoRuntimeLike;
    readonly baseModel: RuntimeModelReference;
    readonly runtimeForModel?: ConversationHarnessOptions["runtimeForModel"];
  },
  scope?: { conversationId: string; runId: string; instances: InstanceRegistryHandle },
): StaticRuntimeOptions | undefined {
  const subagents = config.subagents;
  if (subagents?.enabled !== true) {
    return undefined;
  }
  // Config, schema, doctor, and docs all advertise per-profile MCP servers, so
  // resolve the named subset here rather than silently handing every child an
  // empty map. Only the servers a profile names are exposed.
  const availableMcpServers = (toolPolicyInput(config).mcpServers ?? {}) as Record<string, unknown>;
  const definitions = (subagents.definitions ?? []).map((definition) => ({
    name: definition.name,
    description: definition.description,
    systemPrompt: resolveSubagentPrompt(definition),
    ...(definition.model === undefined ? {} : { model: definition.model }),
    ...(definition.effort === undefined ? {} : { effort: definition.effort }),
    allowedTools: definition.allowedTools ?? [...DEFAULT_SUBAGENT_TOOLS],
    disallowedTools: [...new Set([...(definition.disallowedTools ?? []), ...SUBAGENT_HARD_DENY])],
    mcpServers: selectMcpServers(availableMcpServers, definition.mcpServers, definition.name),
    ...(definition.maxTurns === undefined ? {} : { maxTurns: definition.maxTurns }),
    ...(definition.timeoutMs === undefined ? {} : { timeoutMs: definition.timeoutMs }),
  }));

  // An operator who denied ReadSkill agent-wide must not get it back through a
  // child. Both spellings, because pi-bridge's deny gate honors the legacy alias
  // and a policy that only blocks one of them is not a policy.
  const skillsDeniedGlobally = isReadSkillDenied(config.tools.disallowedTools);

  const run = async (request: SubagentRunRequest): Promise<RuntimeResult & { subagentContinuity?: { turnToken: string; state: "retained" | "unknown" | "lost" } }> => {
    // A profile model must go through `runtimeForModel`: the router overrides
    // `options.model` per chain entry, so handing a different model to the
    // shared router is silently ignored and the child would run on the chain
    // primary instead of the model its profile asked for.
    const childModel = request.definition.model ?? request.model ?? deps.baseModel;
    const overrides = modelReferenceKey(childModel) !== modelReferenceKey(deps.baseModel);
    if (request.instance && overrides && deps.runtimeForModel === undefined) {
      throw new Error(`Persistent subagent route ${childModel.reference} is unavailable; the retained model was not changed.`);
    }
    const runtime = overrides && deps.runtimeForModel !== undefined
      ? deps.runtimeForModel(childModel)
      : deps.runtime;

    // Whether this child may inherit the parent's skill index. Decided here
    // because this is the only layer holding all four inputs: the offered
    // entries, the config's deny list, the profile's, and the child's RESOLVED
    // route. Undefined means the child runs exactly as it did before — the
    // prompt is untouched and neither run option is set.
    const profileDeniesSkills = isReadSkillDenied(request.definition.disallowedTools ?? []);
    const childSkills = request.skillsRoot !== undefined
      && (request.skills?.length ?? 0) > 0
      && !skillsDeniedGlobally
      && !profileDeniesSkills
      && childRuntimeSupportsSkills(childModel)
      ? request.skills
      : undefined;

    // Appended, not prepended: the parent's own context orders these as
    // Core -> Identity -> ... -> Skill Index -> user message, and a profile's
    // systemPrompt IS the child's identity. Putting skills ahead of it is an
    // order no other surface uses.
    const childSystemPrompt = childSkills === undefined
      ? request.systemPrompt
      : `${request.systemPrompt}\n\n${renderSkillIndexSection(childSkills)}`;

    let subagentQuestion: RuntimeResult["subagentQuestion"];
    let submitted = false;
    const currentProfileDenies = subagents.definitions?.find((profile) => profile.name === request.definition.name)?.disallowedTools ?? [];
    const askParentExposed = Boolean(request.instance) && ![...config.tools.disallowedTools, ...currentProfileDenies, ...(request.definition.disallowedTools ?? [])].includes("AskParent");
    const askParentController = askParentExposed && scope
      ? { submit: async (question: NonNullable<RuntimeResult["subagentQuestion"]>): Promise<void> => {
        if (submitted) throw new Error("AskParent already submitted a question this turn.");
        submitted = true;
        try { await scope.instances.markAwaiting(request.instance!.id, question); } catch (error) {
          submitted = false; // Preserve exclusion while publishing, but permit a retry after rejection.
          throw error;
        }
        subagentQuestion = structuredClone(question);
      } } : undefined;
    // Snapshot the command ceiling after child setup/queueing. Detached jobs
    // retain their job deadline; foreground children reserve settlement time
    // inside their own timer. Either abort signal can stop a command sooner.
    const remainingMs = Number.isFinite(request.deadlineAt) ? Math.floor(request.deadlineAt! - Date.now()) : undefined;
    const settlementMarginMs = remainingMs === undefined || request.detached === true
      ? 0 : Math.min(15_000, Math.max(1, Math.floor(remainingMs / 10)));
    const commandTimeoutMs = remainingMs === undefined ? undefined
      : Math.max(1, Math.min(remainingMs - settlementMarginMs, subagents.commandTimeoutMs ?? 1_800_000));
    const childCapabilityOptions = {
      toolExposure: { askParent: askParentExposed, persistentSubagents: false, },
      ...(commandTimeoutMs === undefined ? {} : { toolLimits: { bashTimeoutMs: commandTimeoutMs } }),
      ...(askParentController === undefined ? {} : { askParentController }),
    };
    const recovery = request.instance && request.turnToken && runtime.recoverSession
      ? { runId: request.turnToken, revision: 0 } : undefined;
    // Mirrors the harness's main-conversation gate: an unsupported route must
    // say so through the mailbox, so a parent steer reports unsupported instead
    // of waiting on a loop that can never read it.
    let steeringSupported = false;
    if (request.liveInput !== undefined) {
      try { steeringSupported = monoRuntimeSupportsLiveInput(); } catch { steeringSupported = false; }
      if (!steeringSupported) request.liveInput.markUnsupported();
    }
    const result = await runtime.run(`${childSystemPrompt}\n\n${HOST_TURN_CONTEXT_GUIDANCE}`, {
      ...(request.liveInput !== undefined && steeringSupported ? { liveInput: request.liveInput } : {}),
      ...childCapabilityOptions,
      ...(recovery ? { sessionRecovery: recovery } : {}),
      ...(request.instance && request.turnToken ? { sessionTurn: {
        kind: "instance" as const, ownerKey: request.instance.id, historyBucket: null,
        turnId: request.turnToken, handleId: request.instance.sessionId, baseRevision: null,
      } } : {}),
      ...(config.providers?.piNative?.cacheRetention === undefined ? {} : { cacheRetention: config.providers.piNative.cacheRetention }),
      ...(config.providers?.piNative?.promptCacheDiagnostics === undefined ? {} : { promptCacheDiagnostics: config.providers.piNative.promptCacheDiagnostics }),
      ...(commandTimeoutMs === undefined ? {} : { toolLimits: { bashTimeoutMs: commandTimeoutMs } }),
      ...(askParentController === undefined ? {} : { askParentController }),
      ...(request.instance === undefined ? {} : {
        sessionId: request.instance.sessionId,
        sessionsRoot: request.instance.sessionsRoot,
        sessionKeepAlive: true,
        sessionIdleTimeoutMs: subagents.instances?.idleTtlMs ?? 86_400_000,
        ...(config.runtime.compaction === undefined ? {} : { compaction: config.runtime.compaction }),
      }),
      model: childModel,
      ...(config.runtime.context1MModels === undefined ? {} : { context1MModels: config.runtime.context1MModels }),
      messages: [{ role: "user", content: composeHostTurnEnvelope(formatHostCapabilities(childCapabilityOptions), request.prompt) }],
      maxTurns: request.maxTurns,
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      // Monotonic: the child is confined by the same policy as the parent turn.
      // This runs outside the harness, which is where the policy is normally
      // attached, so dropping it would leave the child entirely unsandboxed.
      ...(request.sandboxPolicy === undefined ? {} : { sandboxPolicy: request.sandboxPolicy }),
      ...(request.sandboxEngine === undefined ? {} : { sandboxEngine: request.sandboxEngine }),
      ...(request.toolEnvironment === undefined ? {} : { toolEnvironment: request.toolEnvironment }),
      // Inherited for the same reason as the sandbox policy above: a child runs
      // outside the harness and builds its OWN web controller, so without these
      // it gets `searchConfig: undefined` and silently falls back to keyless
      // search — which rate-limits into a cooldown where every query fails in
      // milliseconds. The parent keeps working, so the degradation is invisible
      // until you read the child's activity log.
      ...(config.tools.web?.search === undefined ? {} : { webSearchConfig: config.tools.web.search }),
      ...(config.tools.web?.coordination === "host" ? { webRequestCoordinator: createHostWebRequestCoordinator() } : {}),
      ...(config.tools.web?.fetch === undefined ? {} : { webFetchConfig: config.tools.web.fetch }),
      // Both keys or neither: pi-bridge builds ReadSkill only when it has the
      // names AND the root, and a half-set pair fails by silently omitting the
      // tool rather than erroring.
      ...(childSkills === undefined
        ? {}
        : { skills: childSkills, skillsRoot: request.skillsRoot }),
      ...((request.definition.effort ?? request.effort) === undefined
        ? {} : { effort: request.definition.effort ?? request.effort }),
      allowedTools: [...new Set([...(request.definition.allowedTools ?? DEFAULT_SUBAGENT_TOOLS), ...(askParentExposed ? ["AskParent"] : [])])],
      disallowedTools: [...new Set([...(request.definition.disallowedTools ?? []), ...config.tools.disallowedTools, ...SUBAGENT_HARD_DENY])],
      // Only the servers this profile named. A profile that names none gets an
      // empty map, keeping the app-owned AskUser and channel-send tools
      // structurally out of reach rather than merely denied by name.
      mcpServers: request.instance
        ? selectMcpServers((toolPolicyInput(config).mcpServers ?? {}) as Record<string, unknown>, request.definition.mcpServerNames ?? [], request.definition.name)
        : request.definition.mcpServers ?? {},
      abortSignal: request.abortSignal,
      ...(request.ownedForegroundProcesses ? { ownedForegroundProcesses: request.ownedForegroundProcesses } : {}),
      onEvent: request.onEvent,
      // Depth propagation is the recursion lock the kernel also enforces.
      subagents: { depth: request.depth },
    } as unknown as RuntimeRunOptions);
    // Only the selected runtime can certify its durable tail. A matching id alone
    // is not recovery evidence; router fallback intentionally drops the receipt.
    let retained = false;
    const receipt = result.providerSessionRecovery;
    if (recovery && receipt && receipt.runId === recovery.runId && receipt.revision === 0
      && receipt.providerSessionId === request.instance!.sessionId
      && result.providerSessionId === request.instance!.sessionId
      && receipt.modelKey === modelReferenceKey(childModel) && typeof receipt.tipId === "string" && receipt.tipId.length > 0) {
      try { retained = await runtime.recoverSession!(receipt, { appliedInputIds: [] }); } catch { /* Fail closed. */ }
    }
    const continuity = request.turnToken ? { subagentContinuity: { turnToken: request.turnToken,
      state: result.failureKind === "session_continuity_lost" ? "lost" as const : retained ? "retained" as const : "unknown" as const } } : {};
    // Router retries/backups deliberately withhold session ids. Do not promise
    // retained child context for an answer that was produced outside this epoch.
    if (request.instance && !result.error && !result.failureKind && !result.cancelled
      && result.providerSessionId !== request.instance.sessionId) {
      return { ...result, ...continuity, ...(request.turnToken ? { subagentContinuity: { turnToken: request.turnToken, state: "lost" as const } } : {}), failureKind: "session_continuity_lost",
        error: "The child answered outside its persistent session (for example after retry or fallback). This turn was not retained; close the instance and create another with the context it needs." };
    }
    return subagentQuestion && !result.error && !result.failureKind && !result.cancelled
      ? { ...result, ...continuity, subagentQuestion } : { ...result, ...continuity };
  };

  return {
    toolExposure: { persistentSubagents: persistentSubagentsEnabled(config) },
    subagents: {
      ...(scope === undefined || !persistentSubagentsEnabled(config) ? {} : { instances: scope.instances }),
      definitions,
      ...(subagents.models === undefined ? {} : { models: subagents.models.map((choice) => ({
        name: choice.name ?? modelReferenceKey(choice.model),
        model: choice.model,
        key: modelReferenceKey(choice.model),
      })) }),
      // Authoring is on unless an operator turns it off; the ceiling is what
      // keeps that safe, so it is always resolved here rather than left to the
      // kernel's conservative read-only fallback.
      ...(config.subagents?.inline?.enabled === false
        ? {}
        : { inline: { allowedTools: inlineSubagentCeiling(config) } }),
      ...(subagents.maxConcurrent === undefined ? {} : { maxConcurrent: subagents.maxConcurrent }),
      ...(subagents.maxPerTurn === undefined ? {} : { maxPerTurn: subagents.maxPerTurn }),
      ...(subagents.maxTurns === undefined ? {} : { maxTurns: subagents.maxTurns }),
      ...(subagents.timeoutMs === undefined ? {} : { timeoutMs: subagents.timeoutMs }),
      run,
    },
  } as unknown as StaticRuntimeOptions;
}


/** Complete options object, constructed once per logical request and reused by router attempts. */
export function createSubagentsRuntimeExtension(
  config: MonoAgentConfig,
  deps: Parameters<typeof buildSubagentsOptions>[1],
  registry: ReturnType<typeof createSubagentInstanceRegistry>,
): NonNullable<ConfiguredConversationHarnessOptions["runtimeOptionsForRequest"]> {
  return async ({ request, runId }) => !persistentSubagentsEnabled(config)
    ? { runtimeOptions: buildSubagentsOptions(config, deps)! }
    : ({
    runtimeOptions: buildSubagentsOptions(config, deps, {
      conversationId: request.conversationId, runId,
      instances: await registry.open(request.conversationId),
    })!,
  });
}

export function createConfiguredSubagentRegistry(input: {
  readonly config: MonoAgentConfig;
  readonly runtime: MonoRuntimeLike;
  readonly agentRoot: string;
  readonly processJobsRegistry: ProcessJobsRootRegistrySnapshot;
  readonly processJobs: ConfiguredAgentInternalHooks["processJobs"];
  readonly harnessSandboxPolicy: SandboxPolicy | undefined;
  readonly clearSessionsBoundaryOptions: ClearSessionsRuntimeBoundaryOptions;
  readonly sandboxEngine: SandboxEngine | undefined;
}): ReturnType<typeof createSubagentInstanceRegistry> | undefined {
  const { config, runtime, agentRoot, processJobsRegistry, processJobs, harnessSandboxPolicy,
    clearSessionsBoundaryOptions, sandboxEngine } = input;
  const subagentRecoveryAccess = createSubagentRecoveryAccess({
    ...(processJobs?.service ? { service: processJobs.service } : {}),
    privateRoots: async () => {
      const loaded = await loadProcessJobsRootRegistryProtection(agentRoot, config.runtime.workspace);
      if (loaded.kind === "failed") throw new Error("Subagent observation policy is unavailable.");
      const current = await attestProcessJobsRootRegistrySnapshot(loaded, config.runtime.workspace);
      return [...processJobsProtectionPolicyRoots(current), subagentInstancesRoot(config)];
    },
    hostAccess: () => ({ workspace: config.runtime.workspace, readableRoots: [...(config.tools.filesystem?.readableRoots ?? [])],
      sandboxPolicy: mergeSandboxPolicies(harnessSandboxPolicy, clearSessionsSandboxPolicy(clearSessionsBoundaryOptions)), sandboxEngine }),
  });
  const instanceRegistry = persistentSubagentsEnabled(config)
    ? createSubagentInstanceRegistry({
        root: subagentInstancesRoot(config),
        ...config.subagents?.instances,
        ...subagentRecoveryAccess,
        ...(processJobs?.service?.bindManagedSubagents ? {
          ownerForReservation: (jobId: string) => ({ jobId, storeRoot: processJobs!.service!.settings.stateDir }),
          resolveOwner: (identity: import("../subagents/subagent-registry-ownership.js").SubagentOwnerIdentity) => processJobs!.service!.resolveSubagentOwner!(identity),
        } : {}),
        checkOwnerIndex: async (conversationId, known) => {
          // Only existing registered history is authoritative. Never scan/open an old root here.
          if (processJobsRegistry.kind === "empty") return "clear";
          const service = processJobs?.service;
          if (processJobsRegistry.kind !== "ready" || !service?.checkSubagentOwnerIndex
            || processJobsRegistry.roots.some((root) => root.canonicalPath !== service.settings.stateDir)) return "unavailable";
          return await service.checkSubagentOwnerIndex(conversationId, known);
        },
        salvageSession: async (id, root) => {
          if (!runtime.salvageDurableSession) throw new Error("Runtime cannot salvage durable sessions.");
          return runtime.salvageDurableSession(id, root);
        },
        retireSession: async (id, root) => {
          if (!runtime.retireDurableSession) throw new Error("Runtime cannot retire durable subagent sessions.");
          await runtime.retireDurableSession(id, root);
        },
      })
    : undefined;
  return instanceRegistry;
}

export function bindConfiguredManagedSubagents(
  config: MonoAgentConfig,
  instanceRegistry: ReturnType<typeof createSubagentInstanceRegistry> | undefined,
  processJobs: ConfiguredAgentInternalHooks["processJobs"],
): void {
  if (instanceRegistry && processJobs?.service?.bindManagedSubagents) {
    processJobs.service.bindManagedSubagents({ root: subagentInstancesRoot(config),
      salvage: async (identity) => await (await instanceRegistry.open(identity.conversationId, { existingOnly: true })).salvageReleased(identity),
      verify: async (identity) => await (await instanceRegistry.open(identity.conversationId, { existingOnly: true })).verifyOwner(identity),
      publish: async (phase, publication) => await (await instanceRegistry.open(publication.identity.conversationId, { existingOnly: true })).publishOwned(phase, publication),
    });
  }
}
