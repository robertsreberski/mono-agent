import { createHostWebRequestCoordinator } from "./web-request-coordinator.js";
import {
  createAgentHarness,
  createAgentResponder,
  acquireToolHistoryWriter,
  createDurableHistoryStore,
  createToolPolicy,
  loadToolPolicyFromJsonFileSync,
  renderSkillIndexSection,
  ToolHistoryReader,
  toolHistoryLogicalConversationId,
} from "@mono-agent/agent-harness";
import type {
  AgentHarness,
  AgentHarnessOptions,
  AgentHarnessRuntimeOptionsExtension,
  AgentHarnessRuntimeOptionsInput,
  AgentHarnessToolHistoryOptions,
  ConversationHistoryStore,
  SkillIndexSummary,
  ToolHistoryWriterHandle,
} from "@mono-agent/agent-harness";
import type { ToolPolicyInput } from "@mono-agent/agent-harness";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";

import { setToolActivityPathRoots } from "@mono-agent/agent-contracts";
import type { AgentResponder, MemoryStore } from "@mono-agent/agent-contracts";
import { resolveSupermemoryContainer } from "@mono-agent/config";
import type { MonoAgentConfig } from "@mono-agent/config";
import type { LlmComplete } from "@mono-agent/memory/bujo";
import { createCompositeRunRecorder, createJsonlRunRecorder } from "@mono-agent/observability";
import type {
  PhoenixExporterConfig,
  RunExportContext,
  RunExporter,
  RunRecorder,
  RunSummary,
  RuntimeResultLike,
} from "@mono-agent/observability";
import { createPhoenixRunExporter } from "@mono-agent/observability/otel";
import {
  createMonoRuntime,
  createPiOAuthApiKeyResolver,
  createSrtSandboxEngine,
  describeMonoRuntimeSupport,
  modelReferenceKey,
  monoRuntimeSupportsSessionResume,
  parseMonoRuntimeModelReference,
  runtimeOptionsForLocalProvider,
  mergeSandboxPolicies,
} from "@mono-agent/runtime-adapter";
import type {
  MonoRuntimeFallbackChainEntry,
  MonoRuntimeLike,
  RuntimeModelReference,
  RuntimeResult,
  RuntimeRunOptions,
} from "@mono-agent/runtime-adapter";
import type { SandboxEngine, SandboxPolicy } from "@mono-agent/runtime-adapter";

import { agentArtifactDerivedRoots } from "./agent-artifact-paths.js";
import {
  acquireAgentRootOwnership,
  assertAgentRootLeaseOutsideWorkspace,
  releaseAgentRootOwnershipWhenIdle,
  type AgentRootOwnership,
} from "./agent-root-coordinator.js";
import type { ChannelId } from "./channels.js";
import { resolveMemoryRecallSettings } from "./memory-recall.js";
import { BUILTIN_TOOL_NAMES, canonicalToolName, isAllowAllTools } from "./modules/known-tools.js";
import {
  createSharedMemoryRecallRuntimeExtension,
  isSharedRecallStore,
  MemoryRetrievalService,
} from "./memory-retrieval.js";
import {
  createMemoryRememberRuntimeExtension,
  isRememberCapableStore,
  isRememberToolAllowed,
} from "./memory-remember.js";
import {
  clearSessionsSandboxPolicy,
  composeRuntimeOptionExtensions,
  createClearSessionsRuntimeExtension,
  type ClearSessionsRuntimeBoundaryOptions,
} from "./runtime-option-extensions.js";
import {
  configuredRuntimeFallbackModels,
  runtimeUsesFallbackRouter,
} from "./runtime-routes.js";
import type { ProcessJobsSettings } from "./process-jobs-config.js";
import {
  resolveProcessJobsProtectionPosture,
  type ProcessJobsProtectionPosture,
} from "./process-jobs-protection.js";
import { createMonitorsRuntimeExtension, monitorsAvailableForRequest } from "./monitors-runtime.js";
import type { MonitorsServiceHandle } from "./monitors-service.js";
import {
  createProcessJobsRuntimeExtension,
  processJobsAvailableForRequest,
  processJobsSandboxPolicy,
  PROCESS_JOBS_PI_NATIVE_REQUIRED_ERROR,
  PROCESS_JOBS_PROTECTION_UNAVAILABLE_ERROR,
} from "./process-jobs-runtime.js";
import {
  attestProcessJobsRootRegistrySnapshot,
  loadProcessJobsRootRegistryProtection,
  processJobsProtectionPolicyRoots,
  registerProcessJobsRoot,
  type ProcessJobsRootRegistrySnapshot,
} from "./process-jobs-root-registry.js";
import type { ProcessJobsServiceHandle } from "./process-jobs-service.js";
import { isReadSkillDenied } from "./skill-registry.js";
import { loadSupermemoryPlugin } from "./supermemory-plugin.js";

type StaticRuntimeOptions = NonNullable<AgentHarnessOptions["runtimeOptions"]>;

export interface ConfiguredAgentRuntimeOptions {
  readonly config: MonoAgentConfig;
  /** Canonical agent-root authority. A raw public runtime fails before run() when omitted. */
  readonly cwd?: string;
  readonly model?: RuntimeModelReference;
  readonly sandboxEngine?: SandboxEngine;
}

export type ConfiguredAgentSessionEventKind = "acquired" | "released" | "saved" | "evicted" | "isolated" | "cold";

export interface ConfiguredAgentSessionSnapshot {
  readonly conversationId: string;
  readonly providerSessionId: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly busy: boolean;
}

export interface ConfiguredAgentSessionEvent {
  readonly kind: ConfiguredAgentSessionEventKind;
  readonly conversationId: string;
  readonly providerSessionId?: string;
  readonly createdAt?: number;
  readonly lastActivityAt?: number;
  readonly busy?: boolean;
  readonly reason?: string;
  readonly snapshot?: readonly ConfiguredAgentSessionSnapshot[];
}

type ConfiguredAgentSessionEventHandler = (event: ConfiguredAgentSessionEvent) => void | Promise<void>;
type AgentHarnessSessionOptionsWithEvents = NonNullable<AgentHarnessOptions["session"]> & {
  readonly onSessionEvent?: ConfiguredAgentSessionEventHandler;
};

export interface ConfiguredAgentHarnessOptions {
  readonly config: MonoAgentConfig;
  /**
   * Canonical agent-root authority and plugin-resolution folder. Configured
   * harnesses/responders retain their historical current-folder default.
   */
  readonly cwd?: string;
  readonly runtime?: MonoRuntimeLike;
  readonly model?: RuntimeModelReference;
  readonly memory?: MemoryStore;
  /**
   * Authoritative process environment, as resolved by the host. Credential
   * checks that must recognize this agent's own configured secrets read it, so
   * a host started with an explicit `env` must pass the same map here rather
   * than let those checks fall back to `process.env`.
   */
  readonly env?: Record<string, string | undefined>;
  readonly historyStore?: ConversationHistoryStore;
  /** App-owned run-scoped interaction details to add only to replay history. */
  readonly turnHistoryEnricher?: AgentHarnessOptions["turnHistoryEnricher"];
  /** App-owned issuer for request-scoped project-MCP progress credentials. */
  readonly progressCapabilityIssuer?: NonNullable<AgentHarnessOptions["mcpRequestContext"]>["progressCapabilityIssuer"];
  /** App-owned issuer for destination-bound asynchronous continuation claims. */
  readonly continuationCapabilityIssuer?: NonNullable<AgentHarnessOptions["continuationContext"]>["capabilityIssuer"];
  readonly createRunId?: AgentHarnessOptions["createRunId"];
  readonly now?: AgentHarnessOptions["now"];
  readonly runtimeOptions?: AgentHarnessOptions["runtimeOptions"];
  readonly sandboxEngine?: SandboxEngine;
  readonly runtimeOptionsForRequest?: (
    input: AgentHarnessRuntimeOptionsInput,
  ) => AgentHarnessRuntimeOptionsExtension | Promise<AgentHarnessRuntimeOptionsExtension>;
  /** Best-effort diagnostic when the default MemoryRecall endpoint cannot start. */
  readonly onMemoryRecallUnavailable?: (error: unknown) => void;
  /** Best-effort diagnostic when the durable Remember endpoint cannot start. */
  readonly onMemoryRememberUnavailable?: (error: unknown) => void;
  /** Best-effort host diagnostic for post-provider memory write failures. */
  readonly onMemoryWarning?: (message: string) => void;
  /** Best-effort diagnostic for bounded lifecycle-sidecar write failures. */
  readonly onToolHistoryWarning?: (message: string) => void;
  readonly onSessionEvent?: ConfiguredAgentSessionEventHandler;
  /**
   * Factory for a runtime bound to a per-request override model (cron/webhook
   * per-trigger model). Wired by the app so override runtimes share the
   * configured fallback chain and participate in config-reload disposal.
   */
  readonly runtimeForModel?: AgentHarnessOptions["runtimeForModel"];
  /**
   * Exporter-context fields the factory input cannot supply. Surfaced on the
   * exported root span so Phoenix traces map back to the running host and its
   * local artifacts.
   */
  readonly observabilityContext?: {
    readonly sourceId?: string;
    readonly sourceLabel?: string;
    readonly configPath?: string;
  };
  /** Best-effort exporter warnings (timeouts, transport failures). */
  readonly exporterWarn?: (warning: { phase: string; message: string }) => void;
  /** Injection seam (tests); defaults to createPhoenixRunExporter. */
  readonly exporterFactory?: (config: PhoenixExporterConfig) => RunExporter;
}

export interface ConfiguredAgentResponderOptions extends ConfiguredAgentHarnessOptions {}

interface RunArtifactCommitEvent {
  readonly phase: "started" | "finished";
  readonly runId: string;
  readonly conversationId: string;
}

type RunArtifactCommitHook = (event: RunArtifactCommitEvent) => void | Promise<void>;

interface ConfiguredAgentInternalHooks {
  /**
   * App-owned hook invoked after the local JSONL running/terminal summary is
   * committed. Invocation runs before best-effort exporter work; a returned
   * promise is not awaited and all hook failures are ignored.
   */
  readonly onRunArtifactCommitted?: RunArtifactCommitHook;
  /** App-only read decoration around the configured canonical history store. */
  readonly wrapHistoryStore?: (store: ConversationHistoryStore) => ConversationHistoryStore;
  /**
   * Overrides `runtime.session.rollover` for THIS channel's responder. The app
   * builds one responder per channel, and a channel whose conversations already
   * carry an explicit user-owned session boundary (the console's threads) must
   * not have a second one imposed by the calendar.
   */
  readonly sessionRollover?: MonoAgentConfig["runtime"]["session"]["rollover"];
  /** App-published generation and live-controller injection for this channel. */
  readonly processJobs?: {
    readonly registry: ProcessJobsRootRegistrySnapshot;
    readonly service: ProcessJobsServiceHandle | undefined;
    readonly channelId: ChannelId | undefined;
    readonly conversationScheme?: string | undefined;
    readonly protectionPosture: ProcessJobsProtectionPosture;
    readonly routesOnlyPiNative?: (metadata: Record<string, unknown> | undefined) => boolean;
  };
  /**
   * App-local bootstrap seam for a configured responder that does not own the
   * ProcessJobs service (currently `tui --local`). Registration happens only
   * after this harness acquires the canonical agent-root owner.
   */
  readonly bootstrapProcessJobs?: {
    readonly settings: ProcessJobsSettings;
    readonly stateDir?: string;
  };
  /** Live monitor-controller injection for this channel. */
  readonly monitors?: {
    readonly service: MonitorsServiceHandle | undefined;
    readonly channelId: ChannelId | undefined;
    readonly conversationScheme?: string | undefined;
    readonly routesOnlyPiNative?: (metadata: Record<string, unknown> | undefined) => boolean;
  };
}

/**
 * Inputs the recorder composition needs that are stable across a run: the
 * artifact directory, the configured exporters, and the per-host export
 * context. Shared by the channel-run `recorderFactory` and the memory LLM so
 * both produce identical JSONL artifacts + Phoenix spans.
 */
interface RecorderCompositionDeps {
  readonly artifactDir: string;
  readonly exporters: readonly PhoenixExporterConfig[];
  readonly observabilityContext?: ConfiguredAgentHarnessOptions["observabilityContext"];
  readonly exporterWarn?: ConfiguredAgentHarnessOptions["exporterWarn"];
  readonly exporterFactory?: ConfiguredAgentHarnessOptions["exporterFactory"];
  readonly onRunArtifactCommitted?: RunArtifactCommitHook;
}

/**
 * Build a recorder for one run. The JSONL recorder is always built first and is
 * returned unchanged when neither an artifact hook nor exporter is configured.
 * The optional artifact hook wraps only its commit boundary. When an exporter is
 * present the result is wrapped again so export is best-effort and additive —
 * exporter failures only surface as warnings and never change the run outcome.
 */
function composeRunRecorder(
  deps: RecorderCompositionDeps,
  args: {
    readonly runId: string;
    readonly conversationId: string;
    readonly userInput?: string;
    readonly systemPrompt?: string;
    readonly runKind?: "memory" | "channel";
    readonly memoryOperation?: string;
    readonly isolated?: boolean;
    /** Originating channel/trigger kind, e.g. "tui" | "cron" | "webhook" | "memory". */
    readonly source?: string;
    /** Trigger name for `source`, e.g. the cron job id or webhook endpoint name. */
    readonly sourceDetail?: string;
  },
): RunRecorder {
  const jsonl = withArtifactCommitHook(createJsonlRunRecorder({
    runId: args.runId,
    conversationId: args.conversationId,
    artifactDir: deps.artifactDir,
    ...(args.runKind === "memory" ? { artifactKind: "memory" as const } : {}),
    ...(args.isolated === undefined ? {} : { isolated: args.isolated }),
    ...(args.userInput === undefined ? {} : { userInput: args.userInput }),
    ...(args.systemPrompt === undefined ? {} : { systemPrompt: args.systemPrompt }),
    ...(args.source === undefined ? {} : { source: args.source }),
    ...(args.sourceDetail === undefined ? {} : { sourceDetail: args.sourceDetail }),
  }), deps.onRunArtifactCommitted, args);
  const exporterCfg = deps.exporters[0];
  if (exporterCfg === undefined) {
    return jsonl;
  }
  const exporter = (deps.exporterFactory ?? createPhoenixRunExporter)(exporterCfg);
  const context: RunExportContext = {
    runId: args.runId,
    conversationId: args.conversationId,
    ...(deps.observabilityContext?.sourceId === undefined
      ? {}
      : { sourceId: deps.observabilityContext.sourceId }),
    ...(deps.observabilityContext?.sourceLabel === undefined
      ? {}
      : { sourceLabel: deps.observabilityContext.sourceLabel }),
    ...(deps.observabilityContext?.configPath === undefined
      ? {}
      : { configPath: deps.observabilityContext.configPath }),
    artifactDir: deps.artifactDir,
    includeSensitiveData: exporterCfg.includeSensitiveData ?? false,
    contentPatternRedaction: exporterCfg.contentPatternRedaction ?? false,
    ...(args.userInput === undefined ? {} : { userInput: args.userInput }),
    ...(args.runKind === undefined ? {} : { runKind: args.runKind }),
    ...(args.memoryOperation === undefined ? {} : { memoryOperation: args.memoryOperation }),
  };
  const composite = createCompositeRunRecorder({
    recorder: jsonl,
    exporter,
    context,
    timeoutMs: exporterCfg.timeoutMs ?? 5000,
    ...(deps.exporterWarn === undefined ? {} : { onWarning: deps.exporterWarn }),
  });
  return composite;
}

/**
 * Notify the app at the exact local-artifact boundary. This wrapper sits inside
 * the exporter composite, so slow exporter start/finish
 * work cannot leave artifact-derived caches stale after JSONL has committed.
 */
function withArtifactCommitHook(
  recorder: RunRecorder,
  onCommitted: RunArtifactCommitHook | undefined,
  args: { readonly runId: string; readonly conversationId: string },
): RunRecorder {
  if (onCommitted === undefined) {
    return recorder;
  }
  let terminalPromise: Promise<RunSummary> | undefined;
  const notify = (phase: "started" | "finished"): void => {
    try {
      // The cache invalidation used by the app is synchronous. Promise.resolve
      // also contains an async implementation without delaying
      // the JSONL/export pipeline or leaking an unhandled rejection.
      void Promise.resolve(onCommitted({ phase, runId: args.runId, conversationId: args.conversationId }))
        .catch(() => undefined);
    } catch {
      // Best-effort host bookkeeping must never alter the recorded run outcome.
    }
  };
  const commitTerminal = (operation: () => Promise<RunSummary>): Promise<RunSummary> => {
    terminalPromise ??= operation().then((summary) => {
      notify("finished");
      return summary;
    });
    return terminalPromise;
  };
  const wrapped: RunRecorder = {
    onEvent(event): void {
      recorder.onEvent(event);
    },
    async prepareFinish(result: RuntimeResultLike): Promise<void> {
      await recorder.prepareFinish?.(result);
    },
    async commitFinish(result: RuntimeResultLike): Promise<RunSummary> {
      return await commitTerminal(async () => recorder.commitFinish === undefined
        ? await recorder.finish(result)
        : await recorder.commitFinish(result));
    },
    async finish(result: RuntimeResultLike): Promise<RunSummary> {
      await wrapped.prepareFinish?.(result);
      return await wrapped.commitFinish!(result);
    },
    async fail(error: unknown, context?: { readonly systemPrompt?: string }): Promise<RunSummary> {
      return await commitTerminal(async () => context === undefined
        ? await recorder.fail(error)
        : await recorder.fail(error, context));
    },
  };
  if (recorder.start !== undefined) {
    wrapped.start = async (): Promise<RunSummary> => {
      const summary = await recorder.start!();
      notify("started");
      return summary;
    };
  }
  return wrapped;
}

/** Collect the recorder-composition deps from the host config + harness options. */
function recorderCompositionDeps(
  config: MonoAgentConfig,
  options: Pick<
    ConfiguredAgentHarnessOptions,
    "observabilityContext" | "exporterWarn" | "exporterFactory"
  >,
  internalHooks: ConfiguredAgentInternalHooks = {},
): RecorderCompositionDeps {
  const sourceLabel = options.observabilityContext?.sourceLabel ?? config.agent?.name;
  const observabilityContext = options.observabilityContext === undefined && sourceLabel === undefined
    ? undefined
    : {
        ...options.observabilityContext,
        ...(sourceLabel === undefined ? {} : { sourceLabel }),
      };
  return {
    artifactDir: config.artifacts.dir,
    exporters: config.observability?.exporters ?? [],
    ...(observabilityContext === undefined
      ? {}
      : { observabilityContext }),
    ...(options.exporterWarn === undefined ? {} : { exporterWarn: options.exporterWarn }),
    ...(options.exporterFactory === undefined ? {} : { exporterFactory: options.exporterFactory }),
    ...(internalHooks.onRunArtifactCommitted === undefined
      ? {}
      : { onRunArtifactCommitted: internalHooks.onRunArtifactCommitted }),
  };
}

export function createConfiguredAgentRuntime(config: MonoAgentConfig): MonoRuntimeLike;
export function createConfiguredAgentRuntime(options: ConfiguredAgentRuntimeOptions): MonoRuntimeLike;
export function createConfiguredAgentRuntime(
  input: MonoAgentConfig | ConfiguredAgentRuntimeOptions,
): MonoRuntimeLike {
  const config = isRuntimeOptions(input) ? input.config : input;
  const options = isRuntimeOptions(input) ? input : undefined;
  return wrapOwnedConfiguredRuntime(
    createConfiguredAgentRuntimeBase(config, options),
    config,
    options?.cwd,
    options?.sandboxEngine,
  );
}

/** @internal App/harness seam; callers are already inside the shared root/request choke point. */
export function createConfiguredAgentRuntimeForApp(
  input: MonoAgentConfig | ConfiguredAgentRuntimeOptions,
  internal: { readonly suppressSandboxEngine?: boolean } = {},
): MonoRuntimeLike {
  const config = isRuntimeOptions(input) ? input.config : input;
  const options = isRuntimeOptions(input) ? input : undefined;
  return createConfiguredAgentRuntimeBase(config, options, internal.suppressSandboxEngine === true);
}

function createConfiguredAgentRuntimeBase(
  config: MonoAgentConfig,
  options: ConfiguredAgentRuntimeOptions | undefined,
  suppressSandboxEngine = false,
): MonoRuntimeLike {
  const fallback = fallbackChainForConfig(config, options);
  const sandboxEngine = suppressSandboxEngine
    ? undefined
    : configuredSandboxEngine(options?.sandboxEngine);
  const runtimeOptions: Parameters<typeof createMonoRuntime>[0] = {
    ...runtimeHostOptionsForConfig(config),
    ...(sandboxEngine === undefined ? {} : { sandboxEngine }),
    ...fallback,
    ...(fallback.fallbackChain === undefined
      ? {}
      : {
          ...(config.runtime.retry === undefined
            ? {}
            : {
                retry: {
                  backoffMs: config.runtime.retry.backoffMs,
                  maxBackoffMs: config.runtime.retry.maxBackoffMs,
                },
              }),
          // Resolve custom/local Pi options from the ACTUAL route selected by
          // the fallback router. Secrets stay inside this private return value
          // and are never copied into route metadata or events.
          resolveAttempt: ({ model }) => ({
            options: runtimeOptionsForLocalProvider(model, config.providers?.local),
          }),
        }),
  };
  return createMonoRuntime(runtimeOptions);
}

function configuredSandboxEngine(
  explicit: SandboxEngine | undefined,
): SandboxEngine {
  return explicit ?? createSrtSandboxEngine();
}

function wrapOwnedConfiguredRuntime(
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
  const secured = () => (security ??= loadSecurity());
  const releaseOwnership = async (): Promise<void> => {
    const current = security;
    security = undefined;
    if (current === undefined) return;
    const { ownership } = await current.catch(() => ({ ownership: undefined }));
    if (ownership !== undefined) {
      await releaseAgentRootOwnershipWhenIdle(ownership);
    }
  };
  return {
    async run(systemPrompt, runOptions) {
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
        return await runtime.run(systemPrompt, effectiveOptions);
      } finally {
        lease.releaseAfterSettlement();
      }
    },
    ...(runtime.configureTools === undefined
      ? {}
      : { configureTools: runtime.configureTools.bind(runtime) }),
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
        `Subagent "${profile}" references MCP server "${name}", which is not defined in tools.mcpConfigPath.`,
      );
    }
    selected[name] = available[name];
  }
  return selected;
}

/** Denied for every subagent regardless of profile. Mirrors the kernel's own list. */
const SUBAGENT_HARD_DENY = [
  "Agent",
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
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly definition: {
    readonly name: string;
    readonly model?: RuntimeModelReference;
    readonly effort?: string;
    readonly allowedTools?: readonly string[];
    readonly disallowedTools?: readonly string[];
    readonly mcpServers?: Record<string, unknown>;
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
function subagentsRuntimeOptions(
  config: MonoAgentConfig,
  deps: {
    readonly runtime: MonoRuntimeLike;
    readonly baseModel: RuntimeModelReference;
    readonly runtimeForModel?: AgentHarnessOptions["runtimeForModel"];
  },
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

  const run = async (request: SubagentRunRequest): Promise<RuntimeResult> => {
    // A profile model must go through `runtimeForModel`: the router overrides
    // `options.model` per chain entry, so handing a different model to the
    // shared router is silently ignored and the child would run on the chain
    // primary instead of the model its profile asked for.
    const overrides = request.definition.model !== undefined
      && modelReferenceKey(request.definition.model) !== modelReferenceKey(deps.baseModel);
    const childModel = overrides
      ? (request.definition.model as RuntimeModelReference)
      : deps.baseModel;
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

    return await runtime.run(childSystemPrompt, {
      model: childModel,
      messages: [{ role: "user", content: request.prompt }],
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
      ...(request.definition.effort === undefined ? {} : { effort: request.definition.effort }),
      allowedTools: request.definition.allowedTools ?? [...DEFAULT_SUBAGENT_TOOLS],
      disallowedTools: [...new Set([...(request.definition.disallowedTools ?? []), ...SUBAGENT_HARD_DENY])],
      // Only the servers this profile named. A profile that names none gets an
      // empty map, keeping the app-owned AskUser and channel-send tools
      // structurally out of reach rather than merely denied by name.
      mcpServers: request.definition.mcpServers ?? {},
      abortSignal: request.abortSignal,
      onEvent: request.onEvent,
      // Depth propagation is the recursion lock the kernel also enforces.
      subagents: { depth: request.depth },
    } as unknown as RuntimeRunOptions);
  };

  return {
    subagents: {
      definitions,
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


/**
 * When backup models are configured, runs go through the agent-runtime fallback
 * router with the effective primary model first.
 */
function fallbackChainForConfig(
  config: MonoAgentConfig,
  options: ConfiguredAgentRuntimeOptions | undefined,
): { fallbackChain?: readonly MonoRuntimeFallbackChainEntry[] } {
  const canonicalFallbacks = config.runtime.fallbacks;
  // The loader always materializes `retry`, but this package is published and
  // `createConfiguredAgentRuntime` accepts a caller-built MonoAgentConfig — an
  // older hand-built object must degrade to single-shot, not crash.
  const primaryAttempts = config.runtime.retry?.primaryAttempts ?? 1;
  if ((canonicalFallbacks?.length ?? 0) === 0) {
    // Without a chain `createMonoRuntime` takes the plain `createRuntime` path
    // and the router never runs — so same-model retries would silently do
    // nothing for every agent with no configured backups. Build a retry-only
    // single-entry chain instead whenever the primary asks for more than one
    // attempt. `hasConfiguredFallback` deliberately stays false for this shape,
    // keeping `sessionOptions.supportsResume` true: the router only drops the
    // provider session on the retry itself (retryIndex > 0).
    if (primaryAttempts <= 1) {
      return {};
    }
    return {
      fallbackChain: [{
        model: options?.model ?? config.runtime.model,
        attempts: primaryAttempts,
      }],
    };
  }
  const primaryModel = options?.model ?? config.runtime.model;
  // Drop any fallback equal to the primary so a per-trigger override that happens
  // to match a configured backup is not retried against itself before advancing.
  const primaryKey = modelReferenceKey(primaryModel);
  const fallbackEntries: readonly MonoRuntimeFallbackChainEntry[] = (canonicalFallbacks ?? [])
    .filter((entry) => modelReferenceKey(entry.model) !== primaryKey)
    .map((entry) => ({
      model: entry.model,
      // Canonical omission means provider default.
      effort: entry.effort ?? null,
      // Omitted per-route attempts stay single-shot: only the primary
      // retries unless a backup opts in explicitly.
      ...(entry.attempts === undefined ? {} : { attempts: entry.attempts }),
    }));
  return {
    fallbackChain: [
      {
        model: primaryModel,
        ...(primaryAttempts > 1 ? { attempts: primaryAttempts } : {}),
      },
      ...fallbackEntries,
    ],
  };
}

/**
 * Whether every configured route reachable behind `primary` is Pi-native.
 *
 * Returns a VERDICT, not a bare boolean: this fails closed on an unresolvable
 * chain, and a caller that turns `false` into a thrown
 * PROCESS_JOBS_PI_NATIVE_REQUIRED_ERROR would otherwise emit the same opaque
 * sentence for "could not resolve" as for "genuinely non-Pi" — the ambiguity
 * that made mono-agent#664 undiagnosable from outside.
 */
type ConfiguredRoutesPiNativeVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

function configuredRoutesOnlyPiNative(
  config: MonoAgentConfig,
  primary: RuntimeModelReference,
): ConfiguredRoutesPiNativeVerdict {
  let routes: readonly RuntimeModelReference[];
  try {
    const fallback = fallbackChainForConfig(config, { config, model: primary });
    routes = fallback.fallbackChain?.map((entry) => entry.model) ?? [primary];
  } catch (error) {
    return {
      ok: false,
      reason: `the configured route chain could not be resolved (${
        error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (routes.length === 0) {
    return { ok: false, reason: "the configured route chain is empty" };
  }
  return { ok: true };
}

/**
 * Memory backends load lazily: the SQLite/BuJo stack (better-sqlite3,
 * sqlite-vec) and the Supermemory REST client are imported only when
 * `config.memory` selects them, so a memory-less or supermemory-only agent
 * never pays for the other backend. This is what makes the configured
 * composition functions async.
 */
type MemoryBujoModule = typeof import("@mono-agent/memory/bujo");
type MemorySearchModule = typeof import("@mono-agent/memory/search");
type ConfiguredEmbeddingProvider = ReturnType<
  MemorySearchModule["createCircuitBreakerEmbeddingProvider"]
>;

let memoryBujoModule: MemoryBujoModule | undefined;
let memorySearchModule: MemorySearchModule | undefined;

const loadMemoryBujoModule = async (): Promise<MemoryBujoModule> =>
  (memoryBujoModule ??= await import("@mono-agent/memory/bujo"));
const loadMemorySearchModule = async (): Promise<MemorySearchModule> =>
  (memorySearchModule ??= await import("@mono-agent/memory/search"));

export async function createConfiguredAgentHarness(options: ConfiguredAgentHarnessOptions): Promise<AgentHarness> {
  return await createConfiguredAgentHarnessInternal(options);
}

async function createConfiguredAgentHarnessInternal(
  options: ConfiguredAgentHarnessOptions,
  internalHooks: ConfiguredAgentInternalHooks = {},
): Promise<AgentHarness> {
  const config = options.config;
  const ownership = await acquireAgentRootOwnership(options.cwd ?? process.cwd());
  const agentRoot = ownership.agentRoot;
  let ownershipTransferred = false;
  try {
  assertAgentRootLeaseOutsideWorkspace(ownership, config.runtime.workspace);
  const loadedProcessJobsRegistry = internalHooks.processJobs?.registry
    ?? (internalHooks.bootstrapProcessJobs?.stateDir === undefined
      ? await loadProcessJobsRootRegistryProtection(ownership.agentRoot, config.runtime.workspace)
      : (await registerProcessJobsRoot({
          agentRoot: ownership.agentRoot,
          workspace: config.runtime.workspace,
          stateDir: internalHooks.bootstrapProcessJobs.stateDir,
          coordinator: ownership.coordinator,
        })).snapshot);
  const processJobsRegistry = loadedProcessJobsRegistry.kind === "failed"
    ? loadedProcessJobsRegistry
    : await attestProcessJobsRootRegistrySnapshot(
        loadedProcessJobsRegistry,
        config.runtime.workspace,
      );
  ownership.coordinator.synchronizeGeneration(processJobsRegistry.generation);
  const processJobsProtectionPosture = internalHooks.processJobs?.protectionPosture
    ?? resolveProcessJobsProtectionPosture({
      settings: internalHooks.bootstrapProcessJobs?.settings
        ?? { enabled: false, unsafeAllowUnprotectedState: false },
      registry: processJobsRegistry,
      coreConfig: config,
    });
  const processJobsProtectedRoots = processJobsProtectionPolicyRoots(processJobsRegistry);
  const artifactDerivedRoots = agentArtifactDerivedRoots(config.artifacts.dir);
  // Chat activity lines are formatted deep in the streaming layer, which has no
  // per-message workspace to hand down. Without this the root falls back to
  // `process.cwd()` — for a service-managed agent, whatever directory the
  // supervisor started it in — and tool previews expose the full machine layout.
  setToolActivityPathRoots({ workspaceRoot: config.runtime.workspace, homeDir: homedir() });
  const model = options.model ?? config.runtime.model;
  const fallbackModels = configuredRuntimeFallbackModels(config.runtime);
  const sandboxEngine = processJobsProtectionPosture.suppressSyntheticSandbox
    ? undefined
    : configuredSandboxEngine(options.sandboxEngine);
  const harnessSandboxPolicy: SandboxPolicy | undefined = processJobsProtectionPosture.suppressSyntheticSandbox
    ? config.sandbox
    : processJobsProtectedRoots.length === 0
    ? config.sandbox
    : processJobsSandboxPolicy({ coreConfig: config, protectedRoots: processJobsProtectedRoots });
  const runtime = options.runtime ?? createConfiguredAgentRuntimeForApp({
    config,
    cwd: agentRoot,
    model,
    ...(sandboxEngine === undefined ? {} : { sandboxEngine }),
  }, {
    suppressSandboxEngine: processJobsProtectionPosture.suppressSyntheticSandbox,
  });
  const clearSessionsBoundaryOptions = {
    cwd: agentRoot,
    workspace: config.runtime.workspace,
    baseModel: model,
    fallbackModels,
    ...(harnessSandboxPolicy === undefined ? {} : { sandboxPolicy: harnessSandboxPolicy }),
    ...(processJobsProtectionPosture.suppressSyntheticSandbox
      ? { suppressSyntheticSandbox: true }
      : {}),
  } satisfies ClearSessionsRuntimeBoundaryOptions;
  const routedClearSessionsPolicy = runtimeUsesFallbackRouter(config.runtime)
    ? clearSessionsSandboxPolicy(clearSessionsBoundaryOptions)
    : undefined;
  // Request policy is still attested and applied per turn below. Configure the
  // same stable engine/policy into the routed ToolContext so Pi filesystem
  // builtins resolve their native boundary there; per-route-native projection
  // clears both fields from every non-Pi attempt.
  runtime.configureTools?.({
    workspace: config.runtime.workspace,
    ...(sandboxEngine === undefined ? {} : { sandboxEngine }),
    ...(routedClearSessionsPolicy === undefined ? {} : { sandboxPolicy: routedClearSessionsPolicy }),
  });
  // The memory LLM must NOT ride the channel `runtime`: that runtime carries the
  // channel fallback chain whose primary is `config.runtime.model`, and the
  // fallback router overrides each run's per-call `model` — so reusing it would
  // execute memory capture on `config.runtime.model` instead of
  // `config.memory.llm.model`. createConfiguredMemory builds the memory LLM its own
  // fallback-free runtime when no `memoryRuntime` is injected.
  const configuredMemory = options.memory ?? (await createConfiguredMemoryInternal(
    config,
    { cwd: agentRoot },
    processJobsProtectionPosture,
  ));
  const memory = configuredMemoryForHarness(config, configuredMemory);
  const memoryRecall = resolveMemoryRecallSettings(config) === undefined
    || !(memory instanceof MemoryRetrievalService)
    ? undefined
    : createSharedMemoryRecallRuntimeExtension(memory, {
        ...(options.onMemoryRecallUnavailable === undefined
          ? {}
          : { onUnavailable: options.onMemoryRecallUnavailable }),
      });
  // The durable write surface is gated three ways: the store must affirm the
  // capability (a read-only or external backend never does), the operator must
  // not have disabled it, and tool policy must allow it. Unlike MemoryRecall it
  // is allowlist-gated, so an operator can withhold writes while keeping recall.
  const memoryRemember = config.memory?.rememberTool?.enabled === false
    || !(memory instanceof MemoryRetrievalService)
    || !isRememberCapableStore(memory)
    || !isRememberToolAllowed(config.tools)
    ? undefined
    : createMemoryRememberRuntimeExtension(memory, {
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.onMemoryRememberUnavailable === undefined
          ? {}
          : { onUnavailable: options.onMemoryRememberUnavailable }),
      });
  const composedRuntimeOptionsForRequest = composeRuntimeOptionExtensions([
    memoryRecall,
    memoryRemember,
    options.runtimeOptionsForRequest,
  ], {
    // The app-owned, read-only MemoryRecall endpoint is part of every configured
    // memory tier. Preserve only this exact extension under an authenticated
    // request override; arbitrary caller/action MCP extensions remain excluded.
    preserveMcpServersUnderOverride: memoryRecall === undefined ? [] : [memoryRecall],
  });
  const clearSessionsRuntimeOptionsForRequest = createClearSessionsRuntimeExtension(
    composedRuntimeOptionsForRequest,
    clearSessionsBoundaryOptions,
  );
  const processJobsRuntimeOptionsForRequest = createProcessJobsRuntimeExtension({
    next: clearSessionsRuntimeOptionsForRequest,
    ownership,
    registry: processJobsRegistry,
    service: internalHooks.processJobs?.service,
    coreConfig: config,
    baseModel: model,
    channelId: internalHooks.processJobs?.channelId,
    conversationScheme: internalHooks.processJobs?.conversationScheme,
    sandboxEngine,
    protectionPosture: processJobsProtectionPosture,
    routesOnlyPiNative: internalHooks.processJobs?.routesOnlyPiNative
      ?? (() => configuredRoutesOnlyPiNative(config, model).ok),
  });
  const runtimeOptionsForRequest = createMonitorsRuntimeExtension({
    next: processJobsRuntimeOptionsForRequest,
    service: internalHooks.monitors?.service,
    coreConfig: config,
    channelId: internalHooks.monitors?.channelId ?? internalHooks.processJobs?.channelId,
    conversationScheme: internalHooks.monitors?.conversationScheme
      ?? internalHooks.processJobs?.conversationScheme,
    routesOnlyPiNative: internalHooks.monitors?.routesOnlyPiNative
      ?? internalHooks.processJobs?.routesOnlyPiNative
      ?? (() => configuredRoutesOnlyPiNative(config, model).ok),
  });
  const subagents = subagentsRuntimeOptions(config, {
    runtime,
    baseModel: model,
    ...(options.runtimeForModel === undefined ? {} : { runtimeForModel: options.runtimeForModel }),
  });
  const runtimeOptions = mergeStaticRuntimeOptions(
    runtimeOptionsForLocalProvider(model, config.providers?.local),
    configRuntimeFlags(config),
    sandboxEngine === undefined ? undefined : { sandboxEngine },
    subagents,
    options.runtimeOptions,
  );
  const sessionOptions: AgentHarnessSessionOptionsWithEvents = {
    mode: config.runtime.session.mode,
    idleTimeoutMs: config.runtime.session.idleTimeoutMs,
    // Any fallback makes the logical run stateless. A provider-owned session
    // cannot safely cross the route boundary, even when both bridges happen to
    // expose resume support. History replay remains available to every attempt.
    supportsResume: hasConfiguredFallback(config)
      ? false
      : supportsSessionResume(),
    ...(config.runtime.session.isolateProactive === undefined
      ? {}
      : { isolateProactive: config.runtime.session.isolateProactive }),
    ...(options.onSessionEvent === undefined ? {} : { onSessionEvent: options.onSessionEvent }),
  };
  const piSessionsRoot = config.providers?.piNative?.piSessionsRoot;
  const retireDurableSession = runtime.retireDurableSession?.bind(runtime);
  const historyRoot = artifactDerivedRoots.history;
  const baseHistoryStore = options.historyStore ?? createDurableHistoryStore({
    root: historyRoot,
    maxMessages: DEFAULT_HISTORY_MAX_MESSAGES,
    ...(piSessionsRoot === undefined || retireDurableSession === undefined
      ? {}
      : {
          retireProviderSession: async (providerSessionId: string): Promise<void> => {
            await retireDurableSession(providerSessionId, piSessionsRoot);
          },
        }),
  });
  const historyStore = internalHooks.wrapHistoryStore?.(baseHistoryStore) ?? baseHistoryStore;
  const rollover = internalHooks.sessionRollover ?? config.runtime.session.rollover;
  // Conversation history and managed-tool history are distinct contracts. A
  // caller-supplied message store remains the sole message-history owner, while
  // the configured app keeps its independent lifecycle sidecar and
  // SessionHistory capability. Acquisition stays lazy so tool-free runs do not
  // create either the sidecar or its owner database.
  const toolHistory = lazyConfiguredToolHistory({
    root: historyRoot,
    artifactRoot: resolvePath(config.artifacts.dir, "tool-output"),
    rollover,
    ...(options.onToolHistoryWarning === undefined
      ? {}
      : { onWarning: options.onToolHistoryWarning }),
  });

  try {
    const harness = createAgentHarness({
    identityPath: config.context.identityPath,
    ...(config.context.soulPath === undefined ? {} : { soulPath: config.context.soulPath }),
    ...(config.context.skillsRoot === undefined ? {} : { skillsRoot: config.context.skillsRoot }),
    ...(config.context.skillMaxBytes === undefined ? {} : { skillMaxBytes: config.context.skillMaxBytes }),
    ...(config.context.skillDisclosure === undefined ? {} : { skillDisclosure: config.context.skillDisclosure }),
    selectedSkills: config.context.selectedSkills,
    runtime,
    model,
    cwd: config.runtime.workspace,
    ...(config.runtime.effort === undefined ? {} : { effort: config.runtime.effort }),
    ...(config.runtime.maxTurns === undefined ? {} : { maxTurns: config.runtime.maxTurns }),
    ...(config.providers?.piNative?.piSessionsRoot === undefined
      ? {}
      : { piSessionsRoot: config.providers.piNative.piSessionsRoot }),
    session: sessionOptions,
    ...(config.concurrency?.maxConcurrentRuns === undefined && config.concurrency?.maxPendingRuns === undefined
      ? {}
      : {
          concurrency: {
            ...(config.concurrency?.maxConcurrentRuns === undefined
              ? {}
              : { maxConcurrentRuns: config.concurrency.maxConcurrentRuns }),
            ...(config.concurrency?.maxPendingRuns === undefined
              ? {}
              : { maxPendingRuns: config.concurrency.maxPendingRuns }),
          },
        }),
    runtimeOptions,
    ...(runtimeOptionsForRequest === undefined
      ? {}
      : { runtimeOptionsForRequest }),
    // Same predicate the process-jobs extension uses, so the session block only
    // describes backgrounding on turns whose Exec/Bash actually offer it.
    backgroundProcessJobsAvailable: (input) => processJobsAvailableForRequest(input, {
      service: internalHooks.processJobs?.service,
      coreConfig: config,
      channelId: internalHooks.processJobs?.channelId,
      conversationScheme: internalHooks.processJobs?.conversationScheme,
      routesOnlyPiNative: internalHooks.processJobs?.routesOnlyPiNative
        ?? (() => configuredRoutesOnlyPiNative(config, model).ok),
    }),
    // Same predicate the monitors extension uses, for the same reason.
    monitorsAvailable: (input) => monitorsAvailableForRequest(input, {
      service: internalHooks.monitors?.service,
      coreConfig: config,
      channelId: internalHooks.monitors?.channelId ?? internalHooks.processJobs?.channelId,
      conversationScheme: internalHooks.monitors?.conversationScheme
        ?? internalHooks.processJobs?.conversationScheme,
      routesOnlyPiNative: internalHooks.monitors?.routesOnlyPiNative
        ?? internalHooks.processJobs?.routesOnlyPiNative
        ?? (() => configuredRoutesOnlyPiNative(config, model).ok),
    }),
    ...(config.tools.mcpRequestContextServers === undefined
      ? {}
      : {
          mcpRequestContext: {
            serverNames: config.tools.mcpRequestContextServers,
            runOutputRoot: artifactDerivedRoots.outbound,
            ...(options.progressCapabilityIssuer === undefined
              ? {}
              : { progressCapabilityIssuer: options.progressCapabilityIssuer }),
          },
        }),
    ...(config.tools.continuationServers === undefined || options.continuationCapabilityIssuer === undefined
      ? {}
      : {
          continuationContext: {
            serverNames: config.tools.continuationServers,
            capabilityIssuer: options.continuationCapabilityIssuer,
          },
        }),
    ...(options.runtimeForModel === undefined ? {} : { runtimeForModel: options.runtimeForModel }),
    ...(memory === undefined ? {} : { memory }),
    memoryWriteMode: config.memory?.writeMode ?? "disabled",
    ...(options.onMemoryWarning === undefined ? {} : { onMemoryWarning: options.onMemoryWarning }),
    historyStore,
    toolHistory,
    ...(options.turnHistoryEnricher === undefined ? {} : { turnHistoryEnricher: options.turnHistoryEnricher }),
    // Inbound channel attachments are saved here (under the artifacts dir, which
    // sits inside a sandbox-readable root) so the agent can open them by path.
    attachmentsDir: artifactDerivedRoots.attachments,
    toolPolicy: createToolPolicy(toolPolicyInput(config)),
    ...(harnessSandboxPolicy === undefined ? {} : { sandboxPolicy: harnessSandboxPolicy }),
    recorderFactory: ({ runId, conversationId, userInput, source, sourceDetail, isolated }) =>
      composeRunRecorder(recorderCompositionDeps(config, options, internalHooks), {
        runId,
        conversationId,
        runKind: "channel",
        ...(isolated === undefined ? {} : { isolated }),
        ...(userInput === undefined ? {} : { userInput }),
        ...(source === undefined ? {} : { source }),
        ...(sourceDetail === undefined ? {} : { sourceDetail }),
      }),
    ...(options.createRunId === undefined ? {} : { createRunId: options.createRunId }),
    ...(options.now === undefined ? {} : { now: options.now }),
    });
    ownershipTransferred = true;
    return harnessWithAgentRootOwnership(harness, ownership);
  } catch (error) {
    await toolHistory?.release?.().catch(() => undefined);
    throw error;
  }
  } finally {
    if (!ownershipTransferred) {
      await releaseAgentRootOwnershipWhenIdle(ownership).catch(() => undefined);
    }
  }
}

function harnessWithAgentRootOwnership(
  harness: AgentHarness,
  ownership: AgentRootOwnership,
): AgentHarness {
  let disposePromise: Promise<void> | undefined;
  return {
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

interface LazyConfiguredToolHistoryOptions {
  readonly root: string;
  readonly artifactRoot: string;
  readonly rollover: "none" | "daily" | undefined;
  readonly onWarning?: (message: string) => void;
  /** Internal seam for deterministic acquisition-retry tests. */
  readonly acquireWriter?: typeof acquireToolHistoryWriter;
  /** Internal seam for deterministic progressive post-failure backoff tests. */
  readonly acquisitionFailureBackoffMs?: number;
  /** Internal seam for the bounded progressive-backoff ceiling. */
  readonly acquisitionFailureBackoffMaxMs?: number;
  /** Internal monotonic-enough clock seam; production uses wall time. */
  readonly now?: () => number;
}

interface ConfiguredWriterAttempt {
  promise: Promise<ToolHistoryWriterHandle>;
  failurePromise?: Promise<ToolHistoryWriterHandle>;
  handle?: ToolHistoryWriterHandle;
  failed: boolean;
  retryAtMs?: number;
  retired: boolean;
}

interface ConfiguredTurnWriterState {
  readonly generation: number;
  attempt?: ConfiguredWriterAttempt;
  failure?: Promise<ToolHistoryWriterHandle>;
}

const TOOL_HISTORY_ACQUISITION_FAILURE_BACKOFF_MS = 30_000;
const TOOL_HISTORY_ACQUISITION_FAILURE_BACKOFF_MAX_MS = 5 * 60_000;

export function lazyConfiguredToolHistory(
  options: LazyConfiguredToolHistoryOptions,
): AgentHarnessToolHistoryOptions {
  const failureBackoffMs = options.acquisitionFailureBackoffMs
    ?? TOOL_HISTORY_ACQUISITION_FAILURE_BACKOFF_MS;
  if (!Number.isSafeInteger(failureBackoffMs) || failureBackoffMs < 1) {
    throw new TypeError("tool history acquisition failure backoff must be a positive integer.");
  }
  const failureBackoffMaxMs = options.acquisitionFailureBackoffMaxMs
    ?? Math.max(TOOL_HISTORY_ACQUISITION_FAILURE_BACKOFF_MAX_MS, failureBackoffMs);
  if (
    !Number.isSafeInteger(failureBackoffMaxMs)
    || failureBackoffMaxMs < failureBackoffMs
  ) {
    throw new TypeError("tool history acquisition failure backoff maximum must be an integer at least as large as the initial backoff.");
  }
  const now = options.now ?? Date.now;
  let sharedAttempt: ConfiguredWriterAttempt | undefined;
  let latestTurnGeneration = 0;
  const turnStates = new Map<string, ConfiguredTurnWriterState>();
  let resetTail: Promise<void> = Promise.resolve();
  let retirementTail: Promise<void> = Promise.resolve();
  let acquisitionOutage = false;
  let consecutiveAcquisitionFailures = 0;
  const reader = new ToolHistoryReader(options.root);
  const warn = (message: string): void => {
    try { options.onWarning?.(message); } catch { /* diagnostics are best-effort */ }
  };
  const turnKey = (conversationId: string, runId: string): string =>
    JSON.stringify([conversationId, runId]);
  const stateFor = (conversationId: string, runId: string): ConfiguredTurnWriterState => {
    const key = turnKey(conversationId, runId);
    const existing = turnStates.get(key);
    if (existing !== undefined) return existing;
    const state: ConfiguredTurnWriterState = { generation: ++latestTurnGeneration };
    if (
      sharedAttempt?.failed === true
      && sharedAttempt.retryAtMs !== undefined
      && now() < sharedAttempt.retryAtMs
    ) {
      state.attempt = sharedAttempt;
    }
    turnStates.set(key, state);
    return state;
  };
  const failedPromise = (code: string): Promise<ToolHistoryWriterHandle> => {
    const error = Object.assign(new Error("Tool history writer became unavailable; a fresh boundary must reacquire it."), { code });
    const failure = Promise.reject<ToolHistoryWriterHandle>(error);
    void failure.catch(() => undefined);
    return failure;
  };
  const nextFailureBackoffMs = (): number => {
    let backoffMs = failureBackoffMs;
    for (let index = 0; index < consecutiveAcquisitionFailures && backoffMs < failureBackoffMaxMs; index += 1) {
      backoffMs = backoffMs > Math.floor(failureBackoffMaxMs / 2)
        ? failureBackoffMaxMs
        : Math.min(failureBackoffMaxMs, backoffMs * 2);
    }
    consecutiveAcquisitionFailures += 1;
    return backoffMs;
  };
  const retire = (attempt: ConfiguredWriterAttempt): void => {
    if (attempt.retired || attempt.handle === undefined) return;
    attempt.retired = true;
    retirementTail = retirementTail.then(async () => {
      try { await attempt.handle?.release(); } catch { /* replacement acquisition must remain armed */ }
    });
  };
  const latchExistingTurns = (
    attempt: ConfiguredWriterAttempt,
    failure: Promise<ToolHistoryWriterHandle>,
  ): void => {
    const failedThrough = latestTurnGeneration;
    for (const state of turnStates.values()) {
      if (state.generation > failedThrough) continue;
      if (state.attempt === undefined || state.attempt === attempt) state.failure = failure;
    }
  };
  const invalidate = (attempt: ConfiguredWriterAttempt, code: string): Promise<ToolHistoryWriterHandle> => {
    if (attempt.failed) return attempt.failurePromise ?? attempt.promise;
    const failure = failedPromise(code);
    attempt.failed = true;
    attempt.failurePromise = failure;
    attempt.retryAtMs = now() + nextFailureBackoffMs();
    latchExistingTurns(attempt, failure);
    retire(attempt);
    if (sharedAttempt === attempt) {
      sharedAttempt = {
        promise: failure,
        failurePromise: failure,
        failed: true,
        retryAtMs: attempt.retryAtMs,
        retired: true,
      };
    }
    acquisitionOutage = true;
    return failure;
  };
  const startAttempt = (): ConfiguredWriterAttempt => {
    const acquisition = retirementTail.then(async () => await (options.acquireWriter ?? acquireToolHistoryWriter)({
      root: options.root,
      artifactRoot: options.artifactRoot,
      ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
    }));
    const attempt: ConfiguredWriterAttempt = {
      promise: acquisition,
      failed: false,
      retired: false,
    };
    attempt.promise = acquisition.then((handle) => {
      attempt.handle = handle;
      consecutiveAcquisitionFailures = 0;
      if (acquisitionOutage) {
        warn("Tool history writer acquisition recovered; lifecycle persistence resumed.");
      }
      acquisitionOutage = false;
      return handle;
    }).catch((error: unknown) => {
      attempt.failed = true;
      attempt.failurePromise = attempt.promise;
      const retryBackoffMs = nextFailureBackoffMs();
      attempt.retryAtMs = now() + retryBackoffMs;
      latchExistingTurns(attempt, attempt.promise);
      if (!acquisitionOutage) {
        acquisitionOutage = true;
        warn(`Tool history writer acquisition failed (${toolHistoryAcquisitionErrorCode(error)}); new turns fail fast for ${String(retryBackoffMs)} ms and repeated failures back off to ${String(failureBackoffMaxMs)} ms, while explicit reset may retry immediately.`);
      }
      throw error;
    });
    void attempt.promise.catch(() => undefined);
    sharedAttempt = attempt;
    return attempt;
  };
  const selectAttempt = (bypassFailureBackoff: boolean): ConfiguredWriterAttempt => {
    if (sharedAttempt !== undefined) {
      if (sharedAttempt.handle?.writer.isClosed === true) {
        invalidate(sharedAttempt, "history_writer_closed");
      }
      const withinFailureBackoff = sharedAttempt.retryAtMs !== undefined
        && now() < sharedAttempt.retryAtMs;
      if (
        !sharedAttempt.failed
        || (!bypassFailureBackoff && withinFailureBackoff)
      ) {
        return sharedAttempt;
      }
      sharedAttempt = undefined;
    }
    return startAttempt();
  };
  const acquireForTurn = async (state: ConfiguredTurnWriterState): Promise<ToolHistoryWriterHandle> => {
    if (state.failure !== undefined) return await state.failure;
    state.attempt ??= selectAttempt(false);
    const handle = await state.attempt.promise;
    if (handle.writer.isClosed) {
      state.failure = invalidate(state.attempt, "history_writer_closed");
      return await state.failure;
    }
    return handle;
  };
  const writer: AgentHarnessToolHistoryOptions["writer"] = {
    createSink(binding) {
      const state = stateFor(binding.conversationId, binding.runId);
      return async (event) => {
        const handle = await acquireForTurn(state);
        try {
          const result = await handle.writer.persist(binding, event);
          const terminalCode = terminalToolHistoryWriterFailureCode(result, handle);
          if (terminalCode !== undefined && state.attempt !== undefined) {
            state.failure = invalidate(state.attempt, terminalCode);
          }
          return result;
        } catch (error) {
          const terminalCode = terminalToolHistoryWriterFailureCode(error, handle);
          if (terminalCode !== undefined && state.attempt !== undefined) {
            state.failure = invalidate(state.attempt, terminalCode);
          }
          throw error;
        }
      };
    },
    async finishRun(binding, status, failureKind, cancellationReasonCode) {
      const key = turnKey(binding.conversationId, binding.runId);
      const state = turnStates.get(key);
      try {
        if (state?.attempt === undefined || state.failure !== undefined) return;
        const handle = await state.attempt.promise.catch(() => undefined);
        try {
          await handle?.writer.finishRun(binding, status, failureKind, cancellationReasonCode);
        } catch (error) {
          if (handle === undefined) return;
          const terminalCode = terminalToolHistoryWriterFailureCode(error, handle);
          if (terminalCode === undefined) throw error;
          invalidate(state.attempt, terminalCode);
          return;
        }
        const terminalCode = handle === undefined
          ? undefined
          : terminalToolHistoryWriterFailureCode(undefined, handle);
        if (terminalCode !== undefined) invalidate(state.attempt, terminalCode);
      } finally {
        turnStates.delete(key);
      }
    },
    async resetConversation(logicalConversationId) {
      const reset = resetTail.then(async () => {
        if (!await reader.exists()) return;
        // Reset is serialized and host-explicit, so it may bypass only the
        // progressive post-failure cooldown. It still reuses a healthy/pending handle
        // and every fresh acquisition keeps the full restart-handoff ceiling.
        const observedAttempt = sharedAttempt;
        if (observedAttempt !== undefined && !observedAttempt.failed) {
          await observedAttempt.promise.catch(() => undefined);
        }
        let recoveryRetriesRemaining = 1;
        for (;;) {
          const attempt = selectAttempt(true);
          const handle = await attempt.promise;
          try {
            await handle.writer.resetConversation(logicalConversationId);
          } catch (error) {
            const terminalCode = reportedToolHistoryWriterFailureCode(error);
            if (terminalCode === undefined) {
              if (handle.writer.isClosed) invalidate(attempt, "history_writer_closed");
              throw error;
            }
            invalidate(attempt, terminalCode);
            if (recoveryRetriesRemaining === 0) throw error;
            recoveryRetriesRemaining -= 1;
            continue;
          }
          const terminalCode = terminalToolHistoryWriterFailureCode(undefined, handle);
          if (terminalCode !== undefined) invalidate(attempt, terminalCode);
          // A resolved reset was acknowledged only after its transaction
          // committed. Retire a concurrently closed handle, but never open a
          // second destructive reset window for an operation that succeeded.
          return;
        }
      });
      resetTail = reset.then(
        () => undefined,
        () => undefined,
      );
      await reset;
    },
  };
  return {
    writer,
    reader,
    logicalConversationId: (conversationId) =>
      toolHistoryLogicalConversationId(conversationId, options.rollover),
    async release(): Promise<void> {
      const attempt = sharedAttempt;
      sharedAttempt = undefined;
      if (attempt !== undefined) {
        await attempt.promise.catch(() => undefined);
        retire(attempt);
      }
      await retirementTail;
    },
  };
}

function terminalToolHistoryWriterFailureCode(
  value: unknown,
  handle: ToolHistoryWriterHandle,
): string | undefined {
  return reportedToolHistoryWriterFailureCode(value)
    ?? (handle.writer.isClosed ? "history_writer_closed" : undefined);
}

function reportedToolHistoryWriterFailureCode(value: unknown): string | undefined {
  const candidate = typeof value === "object" && value !== null
    ? "errorCode" in value
      ? (value as { readonly errorCode?: unknown }).errorCode
      : "code" in value
        ? (value as { readonly code?: unknown }).code
        : undefined
    : undefined;
  if (candidate === "history_writer_closed") return candidate;
  return undefined;
}

function toolHistoryAcquisitionErrorCode(error: unknown): string {
  const candidate = typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
  return typeof candidate === "string" && /^history_[a-z0-9_]+$/u.test(candidate)
    ? candidate
    : "history_writer_unavailable";
}

function configuredMemoryForHarness(
  config: MonoAgentConfig,
  memory: MemoryStore | undefined,
): MemoryStore | undefined {
  if (memory instanceof MemoryRetrievalService || config.memory === undefined || !isSharedRecallStore(memory)) {
    return memory;
  }
  return new MemoryRetrievalService(memory, {
    maxBytes: config.memory.maxBytes,
    source: (config.memory.backend ?? "bujo") === "supermemory" ? "supermemory" : "memory-bujo",
  });
}

export async function createConfiguredAgentResponder(options: ConfiguredAgentResponderOptions): Promise<AgentResponder> {
  return await createConfiguredAgentResponderInternal(options);
}

/**
 * @internal Application-composition seam. This is deliberately absent from the
 * package root so cache bookkeeping does not enlarge the supported harness API.
 */
export async function createConfiguredAgentResponderForApp(
  options: ConfiguredAgentResponderOptions,
  internalHooks: ConfiguredAgentInternalHooks,
): Promise<AgentResponder> {
  return await createConfiguredAgentResponderInternal(options, internalHooks);
}

async function createConfiguredAgentResponderInternal(
  options: ConfiguredAgentResponderOptions,
  internalHooks: ConfiguredAgentInternalHooks = {},
): Promise<AgentResponder> {
  const session = options.config.runtime.session;
  const rollover = internalHooks.sessionRollover ?? session.rollover;
  return createAgentResponder({
    harness: await createConfiguredAgentHarnessInternal(options, internalHooks),
    ...(rollover === undefined ? {} : { rollover }),
    ...(session.rolloverTimezone === undefined ? {} : { rolloverTimezone: session.rolloverTimezone }),
    ...(session.rolloverNotice === undefined ? {} : { rolloverNotice: session.rolloverNotice }),
    ...(options.now === undefined ? {} : { now: options.now }),
  }) as AgentResponder;
}

/** @internal Shared only with app-local history decorators; absent from the package root. */
export const DEFAULT_HISTORY_MAX_MESSAGES = 64;

function hasConfiguredFallback(config: MonoAgentConfig): boolean {
  return (config.runtime.fallbacks?.length ?? 0) > 0;
}

function supportsSessionResume(): boolean {
  try {
    return monoRuntimeSupportsSessionResume();
  } catch {
    return false;
  }
}

// Bound embeddings calls so a slow/cold backend cannot stall a turn for the
// provider default (30s). The harness degrades recall to empty on timeout.
const DEFAULT_EMBEDDINGS_TIMEOUT_MS = 10_000;

interface ConfiguredMemoryDependencies {
  /** Canonical agent-root authority and folder used to resolve optional plugins. */
  readonly cwd?: string;
  /** Managed workers must use the plugin frozen into their app-side runtime closure. */
  readonly preferAppPluginInstall?: boolean;
  readonly logger?: { warn(message: string): void };
  /**
   * Injection seam for the bujo memory LLM's runtime (tests). This runtime MUST
   * NOT carry the channel runtime's fallback chain: the agent-runtime fallback
   * router overrides each run's per-call `model` with the chain's primary entry.
   */
  readonly memoryRuntime?: MonoRuntimeLike;
  /** Optional app-owned recording context for memory LLM calls. */
  readonly observability?: Pick<
    ConfiguredAgentHarnessOptions,
    "observabilityContext" | "exporterWarn" | "exporterFactory"
  >;
}

export async function createConfiguredMemory(
  config: MonoAgentConfig,
  deps: ConfiguredMemoryDependencies = {},
): Promise<MemoryStore | undefined> {
  return await createConfiguredMemoryInternal(config, deps);
}

/** @internal App-only unsafe authority; deliberately absent from the package root. */
export async function createConfiguredMemoryForApp(
  config: MonoAgentConfig,
  deps: ConfiguredMemoryDependencies,
  protectionPosture: ProcessJobsProtectionPosture,
): Promise<MemoryStore | undefined> {
  return await createConfiguredMemoryInternal(config, deps, protectionPosture);
}

async function createConfiguredMemoryInternal(
  config: MonoAgentConfig,
  deps: ConfiguredMemoryDependencies,
  protectionPosture?: ProcessJobsProtectionPosture,
): Promise<MemoryStore | undefined> {
  if (config.memory === undefined) {
    return undefined;
  }
  const backend = config.memory.backend ?? "bujo";
  if (backend === "supermemory") {
    const sm = config.memory.supermemory;
    if (sm === undefined) {
      // Defensive: the loader already rejects this combination.
      throw new Error("memory.backend 'supermemory' requires a memory.supermemory block.");
    }
    const { createSupermemoryStore } = await loadSupermemoryPlugin({
      ...(deps.cwd === undefined ? {} : { cwd: deps.cwd }),
      ...(deps.preferAppPluginInstall === undefined
        ? {}
        : { preferAppInstall: deps.preferAppPluginInstall }),
    });
    // External backend: `mode`/`embeddings`/`llm` are bujo-only and intentionally ignored. Recall +
    // capture both go over the REST client; Supermemory extracts/consolidates server-side.
    return createSupermemoryStore({
      baseUrl: sm.baseUrl,
      container: resolveSupermemoryContainer(config),
      ...(sm.apiKey === undefined ? {} : { apiKey: sm.apiKey }),
      ...(sm.timeoutMs === undefined ? {} : { timeoutMs: sm.timeoutMs }),
      ...(config.memory.maxBytes === undefined ? {} : { maxBytes: config.memory.maxBytes }),
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    });
  }
  const { mode, path: root, maxBytes, embeddings: embeddingsConfig, llm: llmConfig } = config.memory;
  const bujo = await loadMemoryBujoModule();

  if (mode === "lite") {
    if (embeddingsConfig !== undefined || llmConfig !== undefined || config.memory.consolidation !== undefined) {
      throw new Error("memory.mode 'lite' is lexical-only and rejects embeddings, memory.llm, and consolidation.");
    }
    // Lite tier: FTS-only recall, no external deps.
    return bujo.createBujoMemoryStore({
      root,
      tier: "lite",
      ...(maxBytes !== undefined && { maxBytes }),
      ...(deps.logger !== undefined && { logger: deps.logger }),
    });
  }

  // journal and bujo tiers both need embeddings for hybrid recall. A bounded
  // timeout keeps a slow backend (e.g. Ollama loading the model) from stalling
  // the request, and the circuit breaker fast-fails after repeated failures so
  // a sustained outage stops blocking recall entirely. The harness degrades
  // recall to empty (with a memory_degraded warning) when this errors.
  const search = await loadMemorySearchModule();
  if (embeddingsConfig?.apiKeyEnv !== undefined && embeddingsConfig.apiKey === undefined) {
    throw new Error(
      `memory.embeddings.apiKeyEnv ${embeddingsConfig.apiKeyEnv} is declared but has no resolved value; ` +
      `set ${embeddingsConfig.apiKeyEnv} before starting managed memory.`,
    );
  }
  const embeddings = wrapOwnedDirectEmbeddingProvider(
    search.createCircuitBreakerEmbeddingProvider(
      search.createEmbeddingProvider({
        provider: embeddingsConfig?.provider ?? "ollama",
        model: embeddingsConfig?.model ?? "nomic-embed-text:v1.5",
        ...(embeddingsConfig?.endpoint !== undefined && { endpoint: embeddingsConfig.endpoint }),
        ...(embeddingsConfig?.apiKey !== undefined && { apiKey: embeddingsConfig.apiKey }),
        timeoutMs: embeddingsConfig?.timeoutMs ?? DEFAULT_EMBEDDINGS_TIMEOUT_MS,
      }),
      {
        ...(embeddingsConfig?.circuitBreaker?.failureThreshold !== undefined && {
          failureThreshold: embeddingsConfig.circuitBreaker.failureThreshold,
        }),
        ...(embeddingsConfig?.circuitBreaker?.cooldownMs !== undefined && {
          cooldownMs: embeddingsConfig.circuitBreaker.cooldownMs,
        }),
      },
    ),
    config,
    deps.cwd ?? process.cwd(),
  );
  const dim = embeddingsConfig?.dim ?? 768;

  if (mode === "journal") {
    if (embeddingsConfig === undefined) {
      throw new Error("memory.mode 'journal' requires memory.embeddings; configuration must not downshift tiers.");
    }
    if (llmConfig !== undefined || config.memory.consolidation !== undefined) {
      throw new Error("memory.mode 'journal' rejects memory.llm and consolidation; select bujo for curated capture.");
    }
    // Journal tier: hybrid recall + static, non-decaying salience; no chat LLM.
    return bujo.createBujoMemoryStore({
      root,
      tier: "journal",
      embeddings,
      dim,
      ...(maxBytes !== undefined && { maxBytes }),
      ...(deps.logger !== undefined && { logger: deps.logger }),
    });
  }

  // BuJo is a strict full-stack tier. The config loader enforces both
  // prerequisites; keep the composition boundary defensive for programmatic
  // callers that may construct MonoAgentConfig directly.
  if (embeddingsConfig === undefined || llmConfig === undefined) {
    throw new Error("memory.mode 'bujo' requires memory.embeddings and memory.llm; configuration must not downshift tiers.");
  }
  const recording =
    deps.observability === undefined
      ? undefined
      : recorderCompositionDeps(config, deps.observability);
  const llm = configuredMemoryLlm(
    bujo,
    config,
    llmConfig,
    deps.memoryRuntime,
    recording,
    deps.cwd ?? process.cwd(),
    protectionPosture,
  );
  if (llm === undefined) {
    throw new Error("memory.mode 'bujo' could not construct the required memory.llm.");
  }
  return bujo.createBujoMemoryStore({
    root,
    tier: "bujo",
    embeddings,
    dim,
    ...(maxBytes !== undefined && { maxBytes }),
    llm,
    ...(deps.logger !== undefined && { logger: deps.logger }),
  });
}

function runtimeHostOptionsForConfig(config: MonoAgentConfig): Parameters<typeof createMonoRuntime>[0] {
  return {
    workspace: config.runtime.workspace,
    ...(config.tools.filesystem === undefined
      ? {}
      : {
          additionalReadRoots: config.tools.filesystem.readableRoots,
          additionalWriteRoots: config.tools.filesystem.writableRoots,
        }),
    qaOutputDir: config.artifacts.dir,
    ...(config.providers?.piAuthPath === undefined
      ? {}
      : { resolvePiApiKey: createPiOAuthApiKeyResolver({ path: config.providers.piAuthPath }) }),
  };
}

function configuredMemoryLlm(
  bujo: MemoryBujoModule,
  config: MonoAgentConfig,
  llmConfig: NonNullable<MonoAgentConfig["memory"]>["llm"],
  // Explicit memory-LLM runtime (tests). MUST be fallback-chain-free — see the
  // `memoryRuntime` doc on createConfiguredMemory. When undefined the memory LLM
  // builds its own fallback-free runtime so the per-call memory model is primary.
  memoryRuntimeOverride: MonoRuntimeLike | undefined,
  recording: RecorderCompositionDeps | undefined,
  agentRoot: string | undefined,
  protectionPosture: ProcessJobsProtectionPosture | undefined,
): LlmComplete | undefined {
  if (llmConfig === undefined) {
    return undefined;
  }
  if (llmConfig.provider === "ollama") {
    // The ollama memory LLM does not ride `runtime.run`, so it is not recorded.
    return wrapOwnedDirectMemoryLlm(bujo.createOllamaLlm({
      model: llmConfig.model,
      ...(llmConfig.endpoint !== undefined && { endpoint: llmConfig.endpoint }),
    }), config, agentRoot);
  }
  const model = parseMonoRuntimeModelReference(llmConfig.model);
  // NOTE: createMonoRuntime is called WITHOUT a fallbackChain here on purpose, so
  // the per-call `model: config.memory.llm.model` is the sole/primary model. The
  // channel runtime (which carries the fallback chain whose primary is
  // `config.runtime.model`) is intentionally NOT reused — see the `memoryRuntime`
  // doc on createConfiguredMemory.
  const runtime = wrapPerRunOwnedConfiguredRuntime(
    memoryRuntimeOverride ?? createMonoRuntime(runtimeHostOptionsForConfig(config)),
    config,
    agentRoot,
    protectionPosture,
  );
  return createAgentHostMemoryLlm({
    runtime,
    model,
    cwd: config.runtime.workspace,
    runtimeOptions: mergeStaticRuntimeOptions(
      runtimeOptionsForLocalProvider(model, config.providers?.local),
      configRuntimeFlags(config),
    ),
    // Per-call timeout; default 60s. Configurable so a slow local model can be
    // given room on the heavier reconcile/entities steps.
    ...(llmConfig.timeoutMs === undefined ? {} : { timeoutMs: llmConfig.timeoutMs }),
    // `memory.llm.trace` (default on) gates recording; it only takes effect when
    // the app threaded observability deps into createConfiguredMemory.
    ...(recording !== undefined && llmConfig.trace !== false
      ? { recording: { deps: recording, baseConversationId: MEMORY_CONVERSATION_ID } }
      : {}),
  });
}

/**
 * Memory completion is a model-running surface even when no channel harness is
 * present. Acquire the canonical-root owner and protection generation for the
 * exact duration of the provider call; release follows actual runtime
 * settlement, never its abort signal.
 */
function wrapPerRunOwnedConfiguredRuntime(
  runtime: MonoRuntimeLike,
  config: MonoAgentConfig,
  agentRoot: string | undefined,
  protectionPosture: ProcessJobsProtectionPosture | undefined,
): MonoRuntimeLike {
  return {
    ...runtime,
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
function wrapOwnedDirectMemoryLlm(
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
function wrapOwnedDirectEmbeddingProvider(
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

const MEMORY_LLM_SYSTEM_PROMPT = [
  "You are the private memory maintenance LLM for mono-agent.",
  "Return only the requested JSON or plain text.",
  "Do not use tools, inspect files, or perform external actions.",
].join(" ");

/** Fallback conversation id for recorded memory LLM runs that carry no ritual label. */
const MEMORY_CONVERSATION_ID = "memory:bujo";

function createAgentHostMemoryLlm(options: {
  readonly runtime: MonoRuntimeLike;
  readonly model: RuntimeModelReference;
  readonly cwd: string;
  readonly runtimeOptions?: StaticRuntimeOptions;
  readonly timeoutMs?: number;
  /**
   * When set, each `complete()` is recorded as one run through the shared
   * JSONL + Phoenix pipeline. The per-call `label` (e.g. "capture:extract")
   * selects the run's conversation id and id slug. Omitted → bare, unrecorded run.
   */
  readonly recording?: {
    readonly deps: RecorderCompositionDeps;
    readonly baseConversationId?: string;
  };
}): LlmComplete {
  const timeoutMs = options.timeoutMs ?? 60_000;
  return {
    id: `agent-host:${referenceOf(options.model)}`,
    async complete(prompt: string, opts?: { readonly label?: string; readonly abortSignal?: AbortSignal }): Promise<string> {
      const ctrl = new AbortController();
      const abort = (): void => ctrl.abort(opts?.abortSignal?.reason);
      if (opts?.abortSignal?.aborted === true) abort();
      else opts?.abortSignal?.addEventListener("abort", abort, { once: true });
      // Track whether OUR timeout fired vs an external abort. A provider that is slow or
      // misconfigured (e.g. a dead OAuth token whose refresh hangs) trips this timeout and the
      // runtime reports `cancelled` — without this flag the failure is mislabeled as a generic
      // "run was cancelled", which is exactly what made a 10-day memory outage hard to diagnose.
      let timedOut = false;
      const timer = setTimeout(() => {
        if (ctrl.signal.aborted) return;
        timedOut = true;
        ctrl.abort();
      }, timeoutMs);
      const memoryOperation = memoryOperationFromLabel(opts?.label);
      const recorder =
        options.recording === undefined
          ? undefined
          : composeRunRecorder(options.recording.deps, {
              runId: createMemoryRunId(opts?.label),
              conversationId: memoryConversationId(options.recording.baseConversationId, opts?.label),
              userInput: prompt,
              systemPrompt: MEMORY_LLM_SYSTEM_PROMPT,
              runKind: "memory",
              source: "memory",
              ...(memoryOperation === undefined ? {} : { memoryOperation }),
              ...(memoryOperation === undefined ? {} : { sourceDetail: memoryOperation }),
            });
      try {
        await safeRecorderCall(() => recorder?.start?.());
        let result: RuntimeResult;
        try {
          result = await options.runtime.run(MEMORY_LLM_SYSTEM_PROMPT, {
            ...options.runtimeOptions,
            model: options.model,
            messages: [{ role: "user", content: prompt }],
            abortSignal: ctrl.signal,
            cwd: options.cwd,
            maxTurns: 1,
            allowedTools: [],
            disallowedTools: [],
            mcpServers: {},
            ...(recorder === undefined ? {} : { onEvent: (event) => { recorder.onEvent(event); } }),
          } satisfies RuntimeRunOptions);
        } catch (error) {
          // `runtime.run` itself threw (e.g. the abort/timeout above) — record the
          // failure, then surface a timeout distinctly from an external abort.
          await safeRecorderCall(() => recorder?.fail(error));
          if (timedOut) {
            throw new Error(`agent-host memory LLM timed out after ${timeoutMs}ms (provider too slow or unavailable).`);
          }
          throw error;
        }
        // Record with the real outcome BEFORE textFromMemoryRuntimeResult, which throws
        // on failureKind/error; recorder.finish() classifies failed/succeeded/cancelled itself.
        await safeRecorderCall(() => recorder?.finish(result));
        return textFromMemoryRuntimeResult(result, { timedOut, timeoutMs });
      } finally {
        clearTimeout(timer);
        opts?.abortSignal?.removeEventListener("abort", abort);
      }
    },
  };
}

/**
 * Run a recorder lifecycle call best-effort. Recording is additive: a recorder
 * or artifact-write failure must never mask the memory LLM's real result or error.
 */
async function safeRecorderCall(fn: () => Promise<unknown> | undefined): Promise<void> {
  try {
    await fn();
  } catch {
    // Swallow: recording failures are non-fatal by design.
  }
}

/** Build a `mem-`-prefixed run id (distinct from channel `run-` ids) with the ritual slug. */
function createMemoryRunId(label: string | undefined): string {
  return `mem-${memorySlug(label)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Conversation id for a recorded memory run: `memory:<label>` (per-ritual), else the base. */
function memoryConversationId(base: string | undefined, label: string | undefined): string {
  if (label !== undefined && label.length > 0) {
    return `memory:${label}`;
  }
  return base ?? MEMORY_CONVERSATION_ID;
}

function memorySlug(label: string | undefined): string {
  const slug = (label ?? "bujo")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug.length > 0 ? slug : "bujo";
}

/**
 * Memory sub-operation for the `mono.agent.memory.operation` trace attribute.
 * The capture ritual labels are `capture:extract` / `capture:reconcile-batch`
 * (take the part after the colon) and the bare `reflect` / `migrate` (verbatim).
 */
function memoryOperationFromLabel(label: string | undefined): string | undefined {
  if (label === undefined || label.length === 0) {
    return undefined;
  }
  const op = label.includes(":") ? label.slice(label.indexOf(":") + 1) : label;
  return op.length > 0 ? op : undefined;
}

function textFromMemoryRuntimeResult(
  result: RuntimeResult,
  opts?: { readonly timedOut?: boolean; readonly timeoutMs?: number },
): string {
  if (result.cancelled === true) {
    if (opts?.timedOut === true) {
      throw new Error(`agent-host memory LLM timed out after ${opts.timeoutMs ?? "?"}ms (provider too slow or unavailable).`);
    }
    throw new Error("agent-host memory LLM run was cancelled.");
  }
  if (typeof result.failureKind === "string" && result.failureKind.length > 0) {
    throw new Error(`agent-host memory LLM failed (${result.failureKind}): ${result.error ?? "unknown error"}`);
  }
  if (typeof result.error === "string" && result.error.length > 0) {
    throw new Error(`agent-host memory LLM failed: ${result.error}`);
  }
  return typeof result.text === "string" ? result.text : "";
}

function referenceOf(model: RuntimeModelReference): string {
  return modelReferenceKey(model);
}

function mergeStaticRuntimeOptions(
  ...optionsList: readonly (StaticRuntimeOptions | undefined)[]
): StaticRuntimeOptions {
  const merged: Record<string, unknown> = {};
  for (const options of optionsList) {
    if (options === undefined) {
      continue;
    }
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined) {
        continue;
      }
      if (key === "allowedTools" || key === "disallowedTools") {
        merged[key] = mergeStringLists(merged[key], value);
        continue;
      }
      if (key === "mcpServers") {
        merged[key] = {
          ...(isRecord(merged[key]) ? merged[key] : {}),
          ...(isRecord(value) ? value : {}),
        };
        continue;
      }
      merged[key] = value;
    }
  }
  return merged;
}

function mergeStringLists(current: unknown, next: unknown): readonly string[] {
  const out: string[] = [];
  for (const value of [...stringList(current), ...stringList(next)]) {
    if (!out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolPolicyInput(config: MonoAgentConfig): ToolPolicyInput {
  if (config.tools.mcpConfigPath === undefined) {
    return {
      allowedTools: config.tools.allowedTools,
      disallowedTools: config.tools.disallowedTools,
    };
  }
  // SDK runtimes only consume inline mcpServers, so the referenced mcp.json is
  // resolved here; the path is still forwarded for CLI runtimes that take it.
  const filePolicy = loadToolPolicyFromJsonFileSync(config.tools.mcpConfigPath);
  return {
    allowedTools: config.tools.allowedTools,
    disallowedTools: config.tools.disallowedTools,
    mcpConfigPath: config.tools.mcpConfigPath,
    ...(filePolicy.mcpServers === undefined ? {} : { mcpServers: filePolicy.mcpServers }),
  };
}

function configRuntimeFlags(config: MonoAgentConfig): StaticRuntimeOptions | undefined {
  const { permissionMode, compaction } = config.runtime;
  // NOTE: there is intentionally no reasoning-summary runtime option. The sole pi
  // runtime (pi-native) derives reasoning from `effort` and does not consume an
  // explicit summary level, and the codex/claude CLIs emit summaries
  // unconditionally — so the former `piReasoningSummary` runtime option was dead
  // plumbing and the `runtime.reasoningSummary` config field was removed.
  const piNative = config.providers?.piNative;
  // MCP call timeouts ride the runtime's `settings` bag (the same channel the
  // agent loop reads via resolveAgentCompactionPolicy) — only when configured, so
  // the runtime defaults (120s inactivity / 45 min total) stay authoritative.
  const { mcpCallTimeoutMs, mcpCallMaxTotalTimeoutMs } = config.tools;
  const webSearchConfig = config.tools.web?.search;
  const webFetchConfig = config.tools.web?.fetch;
  const settings = mcpCallTimeoutMs === undefined && mcpCallMaxTotalTimeoutMs === undefined
    ? undefined
    : {
        ...(mcpCallTimeoutMs === undefined ? {} : { agent_mcp_call_timeout_ms: mcpCallTimeoutMs }),
        ...(mcpCallMaxTotalTimeoutMs === undefined
          ? {}
          : { agent_mcp_call_max_total_timeout_ms: mcpCallMaxTotalTimeoutMs }),
      };
  if (
    permissionMode === undefined
    && piNative?.transport === undefined
    && piNative?.piMaxRetries === undefined
    && piNative?.maxRetryDelayMs === undefined
    && compaction === undefined
    && settings === undefined
    && webSearchConfig === undefined
    && webFetchConfig === undefined
  ) {
    return undefined;
  }
  return {
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(piNative?.transport === undefined ? {} : { piTransport: piNative.transport }),
    ...(piNative?.piMaxRetries === undefined ? {} : { piMaxRetries: piNative.piMaxRetries }),
    ...(piNative?.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: piNative.maxRetryDelayMs }),
    ...(compaction === undefined ? {} : { compaction }),
    ...(settings === undefined ? {} : { settings }),
    ...(webSearchConfig === undefined ? {} : { webSearchConfig }),
    ...(webFetchConfig === undefined ? {} : { webFetchConfig }),
    ...(config.tools.web?.coordination === "host" ? { webRequestCoordinator: createHostWebRequestCoordinator() } : {}),
  };
}

function isRuntimeOptions(value: MonoAgentConfig | ConfiguredAgentRuntimeOptions): value is ConfiguredAgentRuntimeOptions {
  return "config" in value;
}
