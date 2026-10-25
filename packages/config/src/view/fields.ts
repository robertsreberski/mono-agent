

import type { ConfigViewField, ConfigViewFieldSource } from "./types.js";

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
  "runtime.compaction.effort": true,
  "runtime.compaction.failureCooldownMs": true,
  "runtime.compaction.triggerRatio": true,
  "runtime.compaction.maxInputTokens": true,
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
  "runtime.session.modelSwitch.enabled": true,
  "runtime.session.continuity.enabled": true,
  "runtime.session.continuity.packEnabled": true,
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
  "memory.capture.cron": true,
  "memory.capture.webhook": true,
  "memory.capture.focus": true,
  "memory.capture.only": true,
  "memory.capture.reconcileModel": true,
  "memory.embeddings.provider": true,
  "memory.embeddings.model": true,
  "memory.embeddings.endpoint": true,
  "memory.embeddings.apiKey": true,
  "memory.embeddings.apiKeyEnv": true,
  "memory.embeddings.dim": true,
  "memory.embeddings.timeoutMs": true,
  "memory.embeddings.instructions": true,
  "memory.embeddings.circuitBreaker.failureThreshold": true,
  "memory.embeddings.circuitBreaker.cooldownMs": true,
  "memory.llm.provider": true,
  "memory.llm.model": true,
  "memory.llm.trace": true,
  "memory.llm.timeoutMs": true,
  "memory.llm.endpoint": true,
  "memory.recallTool.enabled": true,
  "memory.recall.intentExpiry": true,
  "memory.recall.recency": true,
  "memory.capture.intentLifecycle": true,
  "memory.profile.enabled": true,
  "memory.rememberTool.enabled": true,
  "memory.consolidation.enabled": true,
  "memory.consolidation.cron": true,
  "tools.allowedTools": true,
  "tools.disallowedTools": true,
  "tools.filesystem.readableRoots": true,
  "tools.filesystem.writableRoots": true,
  "tools.conversationSearch.datedSnippets": true,
  "tools.computerUse.backend": true,
  "tools.computerUse.command": true,
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
  "artifacts.replyFiles.maxStorageBytes": true,
  "artifacts.replyFiles.maxFileBytes": true,
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
  "runtime.session.root": true,
} as const satisfies Record<string, true>;

type ConfigViewFieldId = keyof typeof CORE_CONFIG_FIELD_IDS;

export const PLACEHOLDER = "—";

export function resolveSource(
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
  /** Conventional `.env` name suggested when an inline JSON secret is flagged. */
  readonly envKey?: string;
}

export function toField(
  spec: FieldSpec,
): ConfigViewField {
  const source = spec.source ?? resolveSource(spec.jsonPresent);
  return {
    id: spec.id,
    label: spec.label,
    value: spec.value,
    source,
    ...(source === "json" && spec.defaultValue !== undefined && sameJsonValue(spec.jsonValue, spec.defaultValue)
      ? { restatesDefault: true }
      : {}),
    ...(spec.redacted === true ? { redacted: true } : {}),
    ...(spec.envKey === undefined ? {} : { envKey: spec.envKey }),
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
