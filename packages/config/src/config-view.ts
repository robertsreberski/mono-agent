import { ALLOW_ALL_TOOLS } from "./enums.js";
import type { MonoAgentConfigJson } from "./json-source.js";
import type {
  RedactedProviderDefinition,
  RedactedMemoryConfig,
  RedactedMonoAgentConfig,
} from "./types.js";

/**
 * Where a displayed value came from. Core fields emit only `json` or
 * `default`; the shared app view retains `env` for adapter-owned fields.
 */
export type ConfigViewFieldSource = "env" | "json" | "default";

/**
 * Section-level lifecycle, aligned with the doctor's vocabulary. Optional
 * blocks (memory, sandbox, observability, local providers) report `disabled`
 * when absent and `active` when configured. The core view never emits
 * `waiting` — that is reserved for channel sections the app composes on top.
 */
export type ConfigViewSectionStatus = "active" | "disabled";

export interface ConfigViewField {
  /** Stable id, e.g. `runtime.model`. Matches the key in {@link CORE_CONFIG_FIELD_IDS}. */
  readonly id: string;
  readonly label: string;
  /** Already-redacted, display-ready value (never a raw secret). */
  readonly value: string;
  readonly source: ConfigViewFieldSource;
  /** True when a JSON-sourced value only restates the built-in default. */
  readonly restatesDefault?: boolean;
  /** True when the underlying value is a secret that has been redacted. */
  readonly redacted?: boolean;
  /** Adapter-owned env var for channel sections composed outside the core view. */
  readonly envKey?: string;
}

export interface ConfigViewSection {
  readonly id: string;
  readonly label: string;
  readonly status: ConfigViewSectionStatus;
  readonly fields: readonly ConfigViewField[];
}

export interface BuildMonoAgentConfigViewInput {
  readonly redacted: RedactedMonoAgentConfig;
  readonly json: MonoAgentConfigJson;
}

/** Stable field-id registry shared by core provenance and generated reference surfaces. */
export const CORE_CONFIG_FIELD_IDS = {
  "agent.name": true,
  "runtime.model": true,
  "runtime.fallbacks": true,
  "subagents": true,
  "runtime.retry.primaryAttempts": true,
  "runtime.retry.backoffMs": true,
  "runtime.retry.maxBackoffMs": true,
  "runtime.effort": true,
  "runtime.maxTurns": true,
  "runtime.compaction.enabled": true,
  "runtime.compaction.triggerRatio": true,
  "runtime.compaction.keepRecentTokens": true,
  "runtime.compaction.summaryMaxTokens": true,
  "runtime.compaction.minSavingsTokens": true,
  "runtime.compaction.fixedOverheadEnabled": true,
  "runtime.compaction.contextWindowOverride": true,
  "runtime.workspace": true,
  "runtime.session.mode": true,
  "runtime.session.idleTimeoutMs": true,
  "runtime.session.rollover": true,
  "runtime.session.rolloverTimezone": true,
  "runtime.session.rolloverNotice": true,
  "runtime.session.isolateProactive": true,
  "concurrency.maxConcurrentRuns": true,
  "concurrency.maxPendingRuns": true,
  "context.identityPath": true,
  "context.soulPath": true,
  "context.skillsRoot": true,
  "context.selectedSkills": true,
  "context.skillMaxBytes": true,
  "context.skillDisclosure": true,
  "memory.backend": true,
  "memory.mode": true,
  "memory.path": true,
  "memory.maxBytes": true,
  "memory.writeMode": true,
  "memory.embeddings.provider": true,
  "memory.embeddings.model": true,
  "memory.embeddings.endpoint": true,
  "memory.embeddings.apiKey": true,
  "memory.embeddings.apiKeyEnv": true,
  "memory.embeddings.dim": true,
  "memory.embeddings.timeoutMs": true,
  "memory.embeddings.circuitBreaker.failureThreshold": true,
  "memory.embeddings.circuitBreaker.cooldownMs": true,
  "memory.llm.provider": true,
  "memory.llm.model": true,
  "memory.llm.trace": true,
  "memory.llm.timeoutMs": true,
  "memory.llm.endpoint": true,
  "memory.recallTool.enabled": true,
  "memory.rememberTool.enabled": true,
  "memory.consolidation.enabled": true,
  "memory.consolidation.cron": true,
  "tools.allowedTools": true,
  "tools.disallowedTools": true,
  "tools.filesystem.readableRoots": true,
  "tools.filesystem.writableRoots": true,
  "tools.mcpConfigPath": true,
  "tools.mcpRequestContextServers": true,
  "tools.continuationServers": true,
  "tools.mcpCallTimeoutMs": true,
  "tools.mcpCallMaxTotalTimeoutMs": true,
  "tools.web.coordination": true,
  "tools.web.search.backend": true,
  "tools.web.search.maxRequestsPerRun": true,
  "tools.web.search.endpoint": true,
  "tools.web.search.searxng.endpoint": true,
  "tools.web.search.ollama.baseUrl": true,
  "tools.web.search.ollama.apiKeyEnv": true,
  "tools.web.search.ollama.trustPublicUrl": true,
  "tools.web.search.codex.model": true,
  "tools.web.search.parallel.apiKeyEnv": true,
  "tools.web.fetch.parallel.apiKeyEnv": true,
  "tools.web.fetch.provider": true,
  "tools.web.fetch.render": true,
  "tools.web.fetch.browserCommand": true,
  "sandbox.mode": true,
  "sandbox.network.mode": true,
  "sandbox.network.allowlist": true,
  "sandbox.readableRoots": true,
  "sandbox.writableRoots": true,
  "sandbox.denyWrite": true,
  "sandbox.fallback": true,
  "sandbox.unsafeAllowHostProcess": true,
  "artifacts.dir": true,
  "artifacts.retention.maxAgeDays": true,
  "artifacts.retention.maxCount": true,
  "artifacts.retention.dryRun": true,
  "artifacts.memoryRetention.maxAgeDays": true,
  "artifacts.memoryRetention.maxCount": true,
  "artifacts.memoryRetention.dryRun": true,
  "traceability.registryDir": true,
  "traceability.sourceId": true,
  "traceability.sourceLabel": true,
  "traceability.heartbeatMs": true,
  "traceability.staleAfterMs": true,
  "traceability.globalDiscovery": true,
  "providers": true,
  "providers.piAuthPath": true,
  "providers.piNative.transport": true,
  "providers.piNative.promptCacheDiagnostics": true,
  "providers.piNative.cacheRetention": true,
  "providers.piNative.piMaxRetries": true,
  "providers.piNative.maxRetryDelayMs": true,
  "providers.piNative.piSessionsRoot": true,
} as const satisfies Record<string, true>;

export type ConfigViewFieldId = keyof typeof CORE_CONFIG_FIELD_IDS;

const PLACEHOLDER = "—";

function resolveSource(
  _id: ConfigViewFieldId,
  jsonPresent: boolean,
): ConfigViewFieldSource {
  return jsonPresent ? "json" : "default";
}

interface FieldSpec {
  readonly id: ConfigViewFieldId;
  readonly label: string;
  readonly value: string;
  readonly jsonPresent: boolean;
  readonly jsonValue?: unknown;
  readonly defaultValue?: unknown;
  readonly source?: ConfigViewFieldSource;
  readonly redacted?: boolean;
}

function toField(
  spec: FieldSpec,
): ConfigViewField {
  const source = spec.source ?? resolveSource(spec.id, spec.jsonPresent);
  return {
    id: spec.id,
    label: spec.label,
    value: spec.value,
    source,
    ...(source === "json" && spec.defaultValue !== undefined && sameJsonValue(spec.jsonValue, spec.defaultValue)
      ? { restatesDefault: true }
      : {}),
    ...(spec.redacted === true ? { redacted: true } : {}),
  };
}

export function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => sameJsonValue(value, right[index]));
  }
  if (isJsonObject(left) || isJsonObject(right)) {
    if (!isJsonObject(left) || !isJsonObject(right)) {
      return false;
    }
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    return leftKeys.every((key, index) => key === rightKeys[index] && sameJsonValue(left[key], right[key]));
  }
  return false;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function formatModelReference(
  reference: RedactedMonoAgentConfig["runtime"]["model"],
): string {
  if (typeof reference === "string") {
    return reference;
  }
  return reference.reference;
}

function formatFallbacks(
  fallbacks: RedactedMonoAgentConfig["runtime"]["fallbacks"],
): string {
  if (fallbacks === undefined || fallbacks.length === 0) {
    return PLACEHOLDER;
  }
  return fallbacks
    .map((entry) => {
      const attempts = entry.attempts !== undefined && entry.attempts > 1 ? ` x${entry.attempts}` : "";
      return `${formatModelReference(entry.model)} (${entry.effort ?? "provider default"})${attempts}`;
    })
    .join(", ");
}

function buildAgentSection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json } = input;
  return {
    id: "agent",
    label: "Agent",
    status: redacted.agent === undefined ? "disabled" : "active",
    fields: [
      toField({
        id: "agent.name",
        label: "Display name",
        value: redacted.agent?.name ?? PLACEHOLDER,
        jsonPresent: json.agent?.name !== undefined,
      }),
    ],
  };
}

function buildRuntimeSection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json } = input;
  const runtime = redacted.runtime;
  const session = runtime.session;
  const compaction = runtime.compaction ?? {};
  return {
    id: "runtime",
    label: "Runtime",
    status: "active",
    fields: [
      toField({
        id: "runtime.model",
        label: "Model",
        value: formatModelReference(runtime.model),
        jsonPresent: json.runtime?.model !== undefined,
      }),
      toField({
        id: "runtime.fallbacks",
        label: "Fallback routes",
        value: formatFallbacks(runtime.fallbacks),
        jsonPresent: json.runtime?.fallbacks !== undefined,
      }),
      toField({
        id: "runtime.retry.primaryAttempts",
        label: "Primary attempts",
        value: String(runtime.retry?.primaryAttempts ?? 2),
        jsonPresent: json.runtime?.retry?.primaryAttempts !== undefined,
      }),
      toField({
        id: "runtime.retry.backoffMs",
        label: "Retry backoff (ms)",
        value: String(runtime.retry?.backoffMs ?? 1_000),
        jsonPresent: json.runtime?.retry?.backoffMs !== undefined,
      }),
      toField({
        id: "runtime.retry.maxBackoffMs",
        label: "Retry backoff cap (ms)",
        value: String(runtime.retry?.maxBackoffMs ?? 15_000),
        jsonPresent: json.runtime?.retry?.maxBackoffMs !== undefined,
      }),
      toField({
        id: "runtime.effort",
        label: "Effort",
        value: runtime.effort ?? PLACEHOLDER,
        jsonPresent: json.runtime?.effort !== undefined,
      }),
      toField({
        id: "runtime.maxTurns",
        label: "Max turns",
        value: runtime.maxTurns === undefined ? "unlimited" : String(runtime.maxTurns),
        jsonPresent: json.runtime?.maxTurns !== undefined,
      }),
      toField({
        id: "runtime.compaction.enabled",
        label: "Context compaction",
        value: compaction.enabled === false ? "no" : "yes",
        jsonPresent: json.runtime?.compaction?.enabled !== undefined,
        jsonValue: json.runtime?.compaction?.enabled,
        defaultValue: true,
      }),
      toField({
        id: "runtime.compaction.triggerRatio",
        label: "Compaction trigger ratio",
        value: String(compaction.triggerRatio ?? 0.90),
        jsonPresent: json.runtime?.compaction?.triggerRatio !== undefined,
        jsonValue: json.runtime?.compaction?.triggerRatio,
        defaultValue: 0.90,
      }),
      toField({
        id: "runtime.compaction.keepRecentTokens",
        label: "Compaction retained tokens",
        value: compaction.keepRecentTokens === undefined ? "adaptive by model" : String(compaction.keepRecentTokens),
        jsonPresent: json.runtime?.compaction?.keepRecentTokens !== undefined,
      }),
      toField({
        id: "runtime.compaction.summaryMaxTokens",
        label: "Compaction summary budget",
        value: compaction.summaryMaxTokens === undefined ? "adaptive by model" : String(compaction.summaryMaxTokens),
        jsonPresent: json.runtime?.compaction?.summaryMaxTokens !== undefined,
      }),
      toField({
        id: "runtime.compaction.minSavingsTokens",
        label: "Compaction minimum savings",
        value: compaction.minSavingsTokens === undefined ? "adaptive by model" : String(compaction.minSavingsTokens),
        jsonPresent: json.runtime?.compaction?.minSavingsTokens !== undefined,
      }),
      toField({
        id: "runtime.compaction.fixedOverheadEnabled",
        label: "Compaction fixed overhead",
        value: compaction.fixedOverheadEnabled === false ? "no" : "yes",
        jsonPresent: json.runtime?.compaction?.fixedOverheadEnabled !== undefined,
        jsonValue: json.runtime?.compaction?.fixedOverheadEnabled,
        defaultValue: true,
      }),
      toField({
        id: "runtime.compaction.contextWindowOverride",
        label: "Context window override",
        value: compaction.contextWindowOverride === undefined ? "auto" : String(compaction.contextWindowOverride),
        jsonPresent: json.runtime?.compaction?.contextWindowOverride !== undefined,
      }),
      toField({
        id: "runtime.workspace",
        label: "Workspace",
        value: runtime.workspace,
        jsonPresent: json.runtime?.workspace !== undefined,
      }),
      toField({
        id: "runtime.session.mode",
        label: "Session mode",
        value: session.mode,
        jsonPresent: json.runtime?.session?.mode !== undefined,
      }),
      toField({
        id: "runtime.session.idleTimeoutMs",
        label: "Session idle timeout (ms)",
        value: String(session.idleTimeoutMs),
        jsonPresent: json.runtime?.session?.idleTimeoutMs !== undefined,
      }),
      toField({
        id: "runtime.session.rollover",
        label: "Session rollover",
        value: session.rollover ?? "none",
        jsonPresent: json.runtime?.session?.rollover !== undefined,
      }),
      toField({
        id: "runtime.session.rolloverTimezone",
        label: "Session rollover timezone",
        value: session.rolloverTimezone ?? PLACEHOLDER,
        jsonPresent: json.runtime?.session?.rolloverTimezone !== undefined,
      }),
      toField({
        id: "runtime.session.rolloverNotice",
        label: "Session rollover notice",
        value: session.rolloverNotice === true ? "yes" : "no",
        jsonPresent: json.runtime?.session?.rolloverNotice !== undefined,
      }),
      toField({
        id: "runtime.session.isolateProactive",
        label: "Isolate proactive runs",
        value: session.isolateProactive === true ? "yes" : "no",
        jsonPresent: json.runtime?.session?.isolateProactive !== undefined,
      }),
    ],
  };
}

function buildConcurrencySection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json } = input;
  const concurrency = redacted.concurrency;
  const present = concurrency !== undefined;
  return {
    id: "concurrency",
    label: "Concurrency",
    status: present ? "active" : "disabled",
    fields: [
      toField({
        id: "concurrency.maxConcurrentRuns",
        label: "Max concurrent runs",
        value: concurrency?.maxConcurrentRuns === undefined ? "unbounded" : String(concurrency.maxConcurrentRuns),
        jsonPresent: json.concurrency?.maxConcurrentRuns !== undefined,
      }),
      toField({
        id: "concurrency.maxPendingRuns",
        label: "Max pending runs",
        value: concurrency?.maxPendingRuns === undefined ? "unbounded" : String(concurrency.maxPendingRuns),
        jsonPresent: json.concurrency?.maxPendingRuns !== undefined,
      }),
    ],
  };
}

function buildContextSection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json } = input;
  const context = redacted.context;
  return {
    id: "context",
    label: "Context",
    status: "active",
    fields: [
      toField({
        id: "context.identityPath",
        label: "Identity document",
        value: context.identityPath,
        jsonPresent: json.context?.identityPath !== undefined,
      }),
      toField({
        id: "context.soulPath",
        label: "Soul document",
        value: context.soulPath ?? PLACEHOLDER,
        jsonPresent: json.context?.soulPath !== undefined,
      }),
      toField({
        id: "context.skillsRoot",
        label: "Skills root",
        value: context.skillsRoot ?? PLACEHOLDER,
        jsonPresent: json.context?.skillsRoot !== undefined,
      }),
      toField({
        id: "context.selectedSkills",
        label: "Selected skills",
        value: context.selectedSkills.length === 0 ? "none" : context.selectedSkills.join(", "),
        jsonPresent: json.context?.selectedSkills !== undefined,
      }),
      toField({
        id: "context.skillMaxBytes",
        label: "Skill byte cap",
        value: context.skillMaxBytes === undefined ? "default" : String(context.skillMaxBytes),
        jsonPresent: json.context?.skillMaxBytes !== undefined,
      }),
      toField({
        id: "context.skillDisclosure",
        label: "Skill disclosure",
        value: context.skillDisclosure ?? "full",
        jsonPresent: json.context?.skillDisclosure !== undefined,
      }),
    ],
  };
}

function buildMemorySection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json } = input;
  const memory: RedactedMemoryConfig | undefined = redacted.memory;
  if (memory === undefined) {
    return {
      id: "memory",
      label: "Memory",
      status: "disabled",
      fields: [{ id: "memory.mode", label: "Status", value: "not configured", source: "default" }],
    };
  }

  const fields: ConfigViewField[] = [
    toField({
      id: "memory.backend",
      label: "Backend",
      value: memory.backend ?? "bujo",
      jsonPresent: json.memory?.backend !== undefined,
    }),
    toField({
      id: "memory.mode",
      label: "Mode",
      value: memory.mode,
      jsonPresent: json.memory?.mode !== undefined,
    }),
    toField({
      id: "memory.path",
      label: "Path",
      value: memory.path,
      jsonPresent: json.memory?.path !== undefined,
    }),
    toField({
      id: "memory.maxBytes",
      label: "Max bytes",
      value: String(memory.maxBytes),
      jsonPresent: json.memory?.maxBytes !== undefined,
    }),
    toField({
      id: "memory.writeMode",
      label: "Write mode",
      value: memory.writeMode,
      jsonPresent: json.memory?.writeMode !== undefined,
    }),
    toField({
      id: "memory.recallTool.enabled",
      label: "Recall tool",
      value: memory.recallTool === undefined ? "default" : memory.recallTool.enabled ? "on" : "off",
      jsonPresent: json.memory?.recallTool?.enabled !== undefined,
    }),
    toField({
      id: "memory.rememberTool.enabled",
      label: "Remember tool",
      value: memory.rememberTool === undefined ? "default" : memory.rememberTool.enabled ? "on" : "off",
      jsonPresent: json.memory?.rememberTool?.enabled !== undefined,
    }),
  ];

  const embeddings = memory.embeddings;
  if (embeddings !== undefined) {
    fields.push(
      toField({
        id: "memory.embeddings.provider",
        label: "Embeddings provider",
        value: embeddings.provider,
        jsonPresent: json.memory?.embeddings?.provider !== undefined,
      }),
      toField({
        id: "memory.embeddings.model",
        label: "Embeddings model",
        value: embeddings.model,
        jsonPresent: json.memory?.embeddings?.model !== undefined,
      }),
      toField({
        id: "memory.embeddings.endpoint",
        label: "Embeddings endpoint",
        value: embeddings.endpoint ?? PLACEHOLDER,
        jsonPresent: json.memory?.embeddings?.endpoint !== undefined,
      }),
      toField({
        id: "memory.embeddings.apiKey",
        label: "Embeddings API key",
        value: embeddings.apiKey?.present === true ? "set" : "unset",
        jsonPresent: json.memory?.embeddings?.apiKey !== undefined,
        redacted: true,
      }),
      toField({
        id: "memory.embeddings.apiKeyEnv",
        label: "Embeddings API key env",
        value: embeddings.apiKeyEnv ?? PLACEHOLDER,
        jsonPresent: json.memory?.embeddings?.apiKeyEnv !== undefined,
      }),
      toField({
        id: "memory.embeddings.dim",
        label: "Embeddings dimension",
        value: embeddings.dim === undefined ? "default" : String(embeddings.dim),
        jsonPresent: json.memory?.embeddings?.dim !== undefined,
      }),
      toField({
        id: "memory.embeddings.timeoutMs",
        label: "Embeddings timeout (ms)",
        value: embeddings.timeoutMs === undefined ? "default" : String(embeddings.timeoutMs),
        jsonPresent: json.memory?.embeddings?.timeoutMs !== undefined,
      }),
      toField({
        id: "memory.embeddings.circuitBreaker.failureThreshold",
        label: "Embeddings breaker threshold",
        value: embeddings.circuitBreaker?.failureThreshold === undefined ? "default" : String(embeddings.circuitBreaker.failureThreshold),
        jsonPresent: json.memory?.embeddings?.circuitBreaker?.failureThreshold !== undefined,
      }),
      toField({
        id: "memory.embeddings.circuitBreaker.cooldownMs",
        label: "Embeddings breaker cooldown (ms)",
        value: embeddings.circuitBreaker?.cooldownMs === undefined ? "default" : String(embeddings.circuitBreaker.cooldownMs),
        jsonPresent: json.memory?.embeddings?.circuitBreaker?.cooldownMs !== undefined,
      }),
    );
  }

  const llm = memory.llm;
  if (llm !== undefined) {
    fields.push(
      toField({
        id: "memory.llm.provider",
        label: "LLM provider",
        value: llm.provider,
        jsonPresent: json.memory?.llm?.provider !== undefined,
      }),
      toField({
        id: "memory.llm.model",
        label: "LLM model",
        value: llm.model,
        jsonPresent: json.memory?.llm?.model !== undefined,
      }),
    );
    if (llm.provider === "ollama") {
      fields.push(
        toField({
          id: "memory.llm.endpoint",
          label: "LLM endpoint",
          value: llm.endpoint ?? PLACEHOLDER,
          jsonPresent: json.memory?.llm?.endpoint !== undefined,
        }),
      );
    } else {
      fields.push(
        toField({
          id: "memory.llm.trace",
          label: "LLM trace",
          value: llm.trace === false ? "off" : "on",
          jsonPresent: json.memory?.llm?.trace !== undefined,
        }),
        toField({
          id: "memory.llm.timeoutMs",
          label: "LLM timeout (ms)",
          value: llm.timeoutMs === undefined ? "default" : String(llm.timeoutMs),
          jsonPresent: json.memory?.llm?.timeoutMs !== undefined,
        }),
      );
    }
  }

  if (memory.mode === "bujo" || memory.consolidation !== undefined) {
    fields.push(
      toField({
        id: "memory.consolidation.enabled",
        label: "Consolidation",
        value: memory.consolidation?.enabled === false ? "off" : "on",
        jsonPresent: json.memory?.consolidation?.enabled !== undefined,
      }),
      toField({
        id: "memory.consolidation.cron",
        label: "Consolidation cron",
        value: memory.consolidation?.cron ?? "default (0 */2 * * *)",
        jsonPresent: json.memory?.consolidation?.cron !== undefined,
      }),
    );
  }

  return { id: "memory", label: "Memory", status: "active", fields };
}

function buildToolsSection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json } = input;
  const tools = redacted.tools;
  return {
    id: "tools",
    label: "Tools",
    status: "active",
    fields: [
      toField({
        id: "tools.allowedTools",
        label: "Allowed tools",
        value: tools.allowedTools.includes(ALLOW_ALL_TOOLS)
          ? "All tools allowed"
          : tools.allowedTools.length === 0
            ? "none (chat-only)"
            : tools.allowedTools.join(", "),
        jsonPresent: json.tools?.allowedTools !== undefined,
      }),
      toField({
        id: "tools.disallowedTools",
        label: "Disallowed tools",
        value: tools.disallowedTools.length === 0 ? "none" : tools.disallowedTools.join(", "),
        jsonPresent: json.tools?.disallowedTools !== undefined,
      }),
      toField({
        id: "tools.filesystem.readableRoots",
        label: "Additional file-tool read roots",
        value: tools.filesystem?.readableRoots.join(", ") ?? "none",
        jsonPresent: json.tools?.filesystem?.readableRoots !== undefined,
      }),
      toField({
        id: "tools.filesystem.writableRoots",
        label: "Additional file-tool write roots",
        value: tools.filesystem?.writableRoots.join(", ") ?? "none",
        jsonPresent: json.tools?.filesystem?.writableRoots !== undefined,
      }),
      toField({
        id: "tools.mcpConfigPath",
        label: "MCP config",
        value: tools.mcpConfigPath ?? PLACEHOLDER,
        jsonPresent: json.tools?.mcpConfigPath !== undefined,
      }),
      toField({
        id: "tools.mcpRequestContextServers",
        label: "Request-context MCP servers",
        value: tools.mcpRequestContextServers?.join(", ") ?? "none",
        jsonPresent: json.tools?.mcpRequestContextServers !== undefined,
      }),
      toField({
        id: "tools.continuationServers",
        label: "Continuation MCP servers",
        value: tools.continuationServers?.join(", ") ?? "none",
        jsonPresent: json.tools?.continuationServers !== undefined,
      }),
      toField({
        id: "tools.mcpCallTimeoutMs",
        label: "MCP call inactivity timeout",
        value: tools.mcpCallTimeoutMs === undefined ? "runtime default (120s)" : `${tools.mcpCallTimeoutMs}ms`,
        jsonPresent: json.tools?.mcpCallTimeoutMs !== undefined,
      }),
      toField({
        id: "tools.mcpCallMaxTotalTimeoutMs",
        label: "MCP call max total timeout",
        value: tools.mcpCallMaxTotalTimeoutMs === undefined
          ? "runtime default (45 min)"
          : `${tools.mcpCallMaxTotalTimeoutMs}ms`,
        jsonPresent: json.tools?.mcpCallMaxTotalTimeoutMs !== undefined,
      }),
      toField({
        id: "tools.web.coordination",
        label: "Web request coordination",
        value: tools.web?.coordination ?? "process",
        jsonPresent: json.tools?.web?.coordination !== undefined,
        jsonValue: json.tools?.web?.coordination,
        defaultValue: "process",
      }),
      toField({
        id: "tools.web.search.backend",
        label: "Web search backend",
        value: typeof tools.web?.search.backend === "string" ? tools.web.search.backend : JSON.stringify(tools.web?.search.backend ?? ["parallel", "ollama"]),
        jsonPresent: json.tools?.web?.search?.backend !== undefined,
        jsonValue: json.tools?.web?.search?.backend,
        defaultValue: ["parallel", "ollama"],
      }),
      toField({
        id: "tools.web.search.maxRequestsPerRun",
        label: "Web search requests per run",
        value: String(tools.web?.search.maxRequestsPerRun ?? 4),
        jsonPresent: json.tools?.web?.search?.maxRequestsPerRun !== undefined,
        jsonValue: json.tools?.web?.search?.maxRequestsPerRun,
        defaultValue: 4,
      }),
      toField({
        id: "tools.web.search.searxng.endpoint",
        label: "SearXNG endpoint",
        value: tools.web?.search.searxng?.endpoint ?? "not configured",
        jsonPresent: json.tools?.web?.search?.searxng?.endpoint !== undefined
          || json.tools?.web?.search?.endpoint !== undefined,
        source: json.tools?.web?.search?.searxng?.endpoint !== undefined
            || json.tools?.web?.search?.endpoint !== undefined
          ? "json"
          : "default",
      }),
      toField({
        id: "tools.web.search.endpoint",
        label: "Legacy SearXNG endpoint alias",
        value: tools.web?.search.searxng?.endpoint ?? "not configured",
        jsonPresent: json.tools?.web?.search?.endpoint !== undefined,
        source: json.tools?.web?.search?.searxng?.endpoint !== undefined
            || json.tools?.web?.search?.endpoint !== undefined
          ? "json"
          : "default",
      }),
      toField({
        id: "tools.web.search.ollama.baseUrl",
        label: "Ollama web search base URL",
        value: tools.web?.search.ollama?.baseUrl ?? "not configured",
        jsonPresent: json.tools?.web?.search?.ollama?.baseUrl !== undefined,
      }),
      toField({
        id: "tools.web.search.ollama.apiKeyEnv",
        label: "Ollama web search API key env",
        value: tools.web?.search.ollama?.apiKeyEnv ?? PLACEHOLDER,
        jsonPresent: json.tools?.web?.search?.ollama?.apiKeyEnv !== undefined,
      }),
      toField({
        id: "tools.web.search.ollama.trustPublicUrl",
        label: "Trust custom public Ollama origin",
        value: tools.web?.search.ollama?.trustPublicUrl === true ? "on" : "off",
        jsonPresent: json.tools?.web?.search?.ollama?.trustPublicUrl !== undefined,
      }),
      toField({
        id: "tools.web.search.codex.model",
        label: "Codex web search model",
        value: tools.web?.search.codex?.model ?? "gpt-5.6-luna",
        jsonPresent: json.tools?.web?.search?.codex?.model !== undefined,
        jsonValue: json.tools?.web?.search?.codex?.model,
        defaultValue: "gpt-5.6-luna",
      }),
      toField({
        id: "tools.web.search.parallel.apiKeyEnv", label: "Parallel search API key env", value: tools.web?.search.parallel?.apiKeyEnv ?? PLACEHOLDER,
        jsonPresent: json.tools?.web?.search?.parallel?.apiKeyEnv !== undefined,
      }),
      toField({
        id: "tools.web.fetch.parallel.apiKeyEnv", label: "Parallel fetch API key env", value: tools.web?.fetch.parallel?.apiKeyEnv ?? PLACEHOLDER,
        jsonPresent: json.tools?.web?.fetch?.parallel?.apiKeyEnv !== undefined,
      }),
      toField({
        id: "tools.web.fetch.provider", label: "Web fetch provider", value: typeof tools.web?.fetch.provider === "string" ? tools.web.fetch.provider : JSON.stringify(tools.web?.fetch.provider ?? "local"),
        jsonPresent: json.tools?.web?.fetch?.provider !== undefined,
      }),
      toField({
        id: "tools.web.fetch.render",
        label: "Web fetch browser render",
        value: tools.web?.fetch.render ?? "never",
        jsonPresent: json.tools?.web?.fetch?.render !== undefined,
        jsonValue: json.tools?.web?.fetch?.render,
        defaultValue: "never",
      }),
      toField({
        id: "tools.web.fetch.browserCommand",
        label: "Web browser command",
        value: tools.web?.fetch.browserCommand ?? "agent-browser",
        jsonPresent: json.tools?.web?.fetch?.browserCommand !== undefined,
        jsonValue: json.tools?.web?.fetch?.browserCommand,
        defaultValue: "agent-browser",
      }),
    ],
  };
}

function buildSandboxSection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json } = input;
  const sandbox = redacted.sandbox;
  if (sandbox === undefined) {
    return {
      id: "sandbox",
      label: "Sandbox",
      status: "disabled",
      fields: [{ id: "sandbox.mode", label: "Status", value: "not configured", source: "default" }],
    };
  }
  return {
    id: "sandbox",
    label: "Sandbox",
    status: "active",
    fields: [
      toField({
        id: "sandbox.mode",
        label: "Mode",
        value: sandbox.mode,
        jsonPresent: json.sandbox?.mode !== undefined,
      }),
      toField({
        id: "sandbox.network.mode",
        label: "Network",
        value: sandbox.network.mode,
        jsonPresent: json.sandbox?.network?.mode !== undefined,
      }),
      toField({
        id: "sandbox.network.allowlist",
        label: "Network allowlist",
        value: sandbox.network.allowlist.length === 0 ? "none" : sandbox.network.allowlist.join(", "),
        jsonPresent: json.sandbox?.network?.allowlist !== undefined,
      }),
      toField({
        id: "sandbox.readableRoots",
        label: "Readable roots",
        value: sandbox.readableRoots.join(", "),
        jsonPresent: json.sandbox?.readableRoots !== undefined,
      }),
      toField({
        id: "sandbox.writableRoots",
        label: "Writable roots",
        value: sandbox.writableRoots.join(", "),
        jsonPresent: json.sandbox?.writableRoots !== undefined,
      }),
      toField({
        id: "sandbox.denyWrite",
        label: "Deny-write patterns",
        value: sandbox.denyWrite.join(", "),
        jsonPresent: json.sandbox?.denyWrite !== undefined,
      }),
      toField({
        id: "sandbox.fallback",
        label: "Fallback",
        value: sandbox.fallback,
        jsonPresent: json.sandbox?.fallback !== undefined,
      }),
      toField({
        id: "sandbox.unsafeAllowHostProcess",
        label: "Allow host process",
        value: sandbox.unsafeAllowHostProcess ? "yes" : "no",
        jsonPresent: json.sandbox?.unsafeAllowHostProcess !== undefined,
      }),
    ],
  };
}

function buildArtifactsSection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json } = input;
  const memoryDryRunJsonPresent = json.artifacts?.memoryRetention?.dryRun !== undefined;
  const inheritedDryRunSource = resolveSource("artifacts.retention.dryRun", json.artifacts?.retention?.dryRun !== undefined);
  const memoryDryRunSource = memoryDryRunJsonPresent ? "json" : inheritedDryRunSource;
  return {
    id: "artifacts",
    label: "Artifacts",
    status: "active",
    fields: [
      toField({
        id: "artifacts.dir",
        label: "Artifact directory",
        value: redacted.artifacts.dir,
        jsonPresent: json.artifacts?.dir !== undefined,
      }),
      toField({
        id: "artifacts.retention.maxAgeDays",
        label: "Retention max age",
        value: `${redacted.artifacts.retention.maxAgeDays} day(s)`,
        jsonPresent: json.artifacts?.retention?.maxAgeDays !== undefined,
      }),
      toField({
        id: "artifacts.retention.maxCount",
        label: "Retention max count",
        value: String(redacted.artifacts.retention.maxCount),
        jsonPresent: json.artifacts?.retention?.maxCount !== undefined,
      }),
      toField({
        id: "artifacts.retention.dryRun",
        label: "Retention dry run",
        value: redacted.artifacts.retention.dryRun ? "yes" : "no",
        jsonPresent: json.artifacts?.retention?.dryRun !== undefined,
      }),
      toField({
        id: "artifacts.memoryRetention.maxAgeDays",
        label: "Memory retention max age",
        value: `${redacted.artifacts.memoryRetention.maxAgeDays} day(s)`,
        jsonPresent: json.artifacts?.memoryRetention?.maxAgeDays !== undefined,
      }),
      toField({
        id: "artifacts.memoryRetention.maxCount",
        label: "Memory retention max count",
        value: String(redacted.artifacts.memoryRetention.maxCount),
        jsonPresent: json.artifacts?.memoryRetention?.maxCount !== undefined,
      }),
      toField({
        id: "artifacts.memoryRetention.dryRun",
        label: "Memory retention dry run",
        value: redacted.artifacts.memoryRetention.dryRun ? "yes" : "no",
        jsonPresent: memoryDryRunJsonPresent,
        source: memoryDryRunSource,
      }),
    ],
  };
}

function buildTraceabilitySection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json } = input;
  const trace = redacted.traceability;
  return {
    id: "traceability",
    label: "Traceability",
    status: "active",
    fields: [
      toField({
        id: "traceability.registryDir",
        label: "Trace registry",
        value: trace.registryDir,
        jsonPresent: json.traceability?.registryDir !== undefined,
      }),
      toField({
        id: "traceability.sourceId",
        label: "Source ID",
        value: trace.sourceId ?? PLACEHOLDER,
        jsonPresent: json.traceability?.sourceId !== undefined,
      }),
      toField({
        id: "traceability.sourceLabel",
        label: "Source label",
        value: trace.sourceLabel ?? PLACEHOLDER,
        jsonPresent: json.traceability?.sourceLabel !== undefined,
      }),
      toField({
        id: "traceability.heartbeatMs",
        label: "Heartbeat (ms)",
        value: trace.heartbeatMs === undefined ? "default" : String(trace.heartbeatMs),
        jsonPresent: json.traceability?.heartbeatMs !== undefined,
        jsonValue: json.traceability?.heartbeatMs,
        defaultValue: 10_000,
      }),
      toField({
        id: "traceability.staleAfterMs",
        label: "Stale after (ms)",
        value: trace.staleAfterMs === undefined ? "default" : String(trace.staleAfterMs),
        jsonPresent: json.traceability?.staleAfterMs !== undefined,
        jsonValue: json.traceability?.staleAfterMs,
        defaultValue: 30_000,
      }),
      toField({
        id: "traceability.globalDiscovery",
        label: "Global discovery",
        value: trace.globalDiscovery === false ? "no" : "yes",
        jsonPresent: json.traceability?.globalDiscovery !== undefined,
      }),
    ],
  };
}

function formatProviders(
  providers: readonly RedactedProviderDefinition[],
): string {
  if (providers.length === 0) {
    return "none";
  }
  return providers.map((provider) => provider.type === undefined
    ? provider.id
    : `${provider.id} (${provider.type})`).join(", ");
}

function buildProvidersSection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json } = input;
  const providers = redacted.providers;
  const present = providers !== undefined;
  const entries = providers?.entries ?? providers?.local ?? [];
  const configuredProviderIds = Object.keys(json.providers ?? {}).filter((key) =>
    key !== "local" && key !== "piAuthPath" && key !== "piNative",
  );
  const providerMapPresent = json.providers?.local !== undefined || configuredProviderIds.length > 0;
  return {
    id: "providers",
    label: "Providers",
    status: present ? "active" : "disabled",
    fields: [
      toField({
        id: "providers.piAuthPath",
        label: "Pi auth path",
        value: providers?.piAuthPath ?? PLACEHOLDER,
        jsonPresent: json.providers?.piAuthPath !== undefined,
      }),
      toField({
        id: "providers.piNative.transport",
        label: "Pi transport",
        value: providers?.piNative?.transport ?? "auto",
        jsonPresent: json.providers?.piNative?.transport !== undefined,
      }),
      toField({
        id: "providers.piNative.promptCacheDiagnostics",
        label: "Pi prompt cache diagnostics",
        value: String(providers?.piNative?.promptCacheDiagnostics ?? false),
        jsonPresent: json.providers?.piNative?.promptCacheDiagnostics !== undefined,
      }),
      toField({
        id: "providers.piNative.cacheRetention",
        label: "Anthropic cache retention",
        value: providers?.piNative?.cacheRetention ?? PLACEHOLDER,
        jsonPresent: json.providers?.piNative?.cacheRetention !== undefined,
      }),

      toField({
        id: "providers.piNative.piMaxRetries",
        label: "Pi max retries",
        value: providers?.piNative?.piMaxRetries === undefined ? "default" : String(providers.piNative.piMaxRetries),
        jsonPresent: json.providers?.piNative?.piMaxRetries !== undefined,
      }),
      toField({
        id: "providers.piNative.maxRetryDelayMs",
        label: "Pi max retry delay (ms)",
        value: providers?.piNative?.maxRetryDelayMs === undefined ? "default" : String(providers.piNative.maxRetryDelayMs),
        jsonPresent: json.providers?.piNative?.maxRetryDelayMs !== undefined,
      }),
      toField({
        id: "providers.piNative.piSessionsRoot",
        label: "Pi sessions root",
        value: providers?.piNative?.piSessionsRoot ?? "in-memory",
        jsonPresent: json.providers?.piNative?.piSessionsRoot !== undefined,
      }),
      toField({
        id: "providers",
        label: "Configured providers",
        value: formatProviders(entries),
        jsonPresent: providerMapPresent,
      }),
    ],
  };
}

/**
 * Build the single, complete, source-annotated view of a resolved
 * `MonoAgentConfig`. Every core section and field is represented exactly once,
 * including nested `providers` blocks that the
 * retired field-group registry omitted. Drives both the read-only TUI config
 * pane and the `mono-agent config` CLI command, so the two surfaces can never
 * disagree about what the loader produced.
 */
export function buildMonoAgentConfigView(
  input: BuildMonoAgentConfigViewInput,
): readonly ConfigViewSection[] {
  return [
    buildAgentSection(input),
    buildRuntimeSection(input),
    buildConcurrencySection(input),
    buildContextSection(input),
    buildMemorySection(input),
    buildToolsSection(input),
    buildSandboxSection(input),
    buildArtifactsSection(input),
    buildTraceabilitySection(input),
    buildProvidersSection(input),
  ];
}


/**
 * Find advisory warnings for secret-marked fields whose resolved source is the
 * committed JSON config. The warning uses only stable field ids and env-var
 * names, never the secret value itself.
 */
export function findJsonSecretConfigWarnings(
  sections: readonly ConfigViewSection[],
): readonly string[] {
  const warnings: string[] = [];
  for (const section of sections) {
    for (const field of section.fields) {
      if (field.redacted !== true || field.source !== "json") {
        continue;
      }
      const envVar = field.envKey;
      if (envVar === undefined) {
        continue;
      }
      warnings.push(`[WARN] ${field.id} is a secret read from mono-agent.config.json — move it to .env (${envVar}).`);
    }
  }
  return warnings;
}

export interface RemovedConfigWarningsInput {
  readonly json: MonoAgentConfigJson;
}

/**
 * Find advisory migration warnings for removed or one-release deprecated
 * config surfaces. Warnings mention only stable paths/names, never values.
 */
export function findRemovedConfigWarnings(input: RemovedConfigWarningsInput): readonly string[] {
  const warnings: string[] = [];
  if (input.json.memory?.reflection !== undefined) {
    warnings.push("[WARN] memory.reflection is removed and ignored; use memory.consolidation instead.");
  }
  if (input.json.memory?.migration !== undefined) {
    warnings.push("[WARN] memory.migration is removed and ignored; use memory.consolidation instead.");
  }
  return warnings;
}
