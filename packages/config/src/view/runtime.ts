import { DEFAULT_RUNTIME_RETRY_BACKOFF_MS, DEFAULT_RUNTIME_RETRY_MAX_BACKOFF_MS } from "@mono-agent/turn/host/config";
import { DEFAULT_RUNTIME_PRIMARY_ATTEMPTS } from "../defaults.js";


import type { RedactedMonoAgentConfig } from "../types.js";

import type { BuildMonoAgentConfigViewInput, ConfigViewSection } from "./types.js";

import { PLACEHOLDER, toField } from "./fields.js";

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

export function buildAgentSection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
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

export function buildRuntimeSection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
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
        value: `${formatModelReference(runtime.model)}${runtime.context1MModels?.[`${runtime.model.provider}:${runtime.model.model}`] === true ? " · 1M context" : ""}`,
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
        value: String(runtime.retry?.primaryAttempts ?? DEFAULT_RUNTIME_PRIMARY_ATTEMPTS),
        jsonPresent: json.runtime?.retry?.primaryAttempts !== undefined,
      }),
      toField({
        id: "runtime.retry.backoffMs",
        label: "Retry backoff (ms)",
        value: String(runtime.retry?.backoffMs ?? DEFAULT_RUNTIME_RETRY_BACKOFF_MS),
        jsonPresent: json.runtime?.retry?.backoffMs !== undefined,
      }),
      toField({
        id: "runtime.retry.maxBackoffMs",
        label: "Retry backoff cap (ms)",
        value: String(runtime.retry?.maxBackoffMs ?? DEFAULT_RUNTIME_RETRY_MAX_BACKOFF_MS),
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
        id: "runtime.compaction.maxInputTokens",
        label: "Compaction absolute ceiling",
        value: compaction.maxInputTokens === 0 ? "disabled" : String(compaction.maxInputTokens ?? 200_000),
        jsonPresent: json.runtime?.compaction?.maxInputTokens !== undefined,
        jsonValue: json.runtime?.compaction?.maxInputTokens,
        defaultValue: 200_000,
      }),
      toField({
        id: "runtime.compaction.keepRecentTokens",
        label: "Compaction retained tokens",
        value: compaction.keepRecentTokens === undefined ? "adaptive by model" : String(compaction.keepRecentTokens),
        jsonPresent: json.runtime?.compaction?.keepRecentTokens !== undefined,
      }),
      toField({ id: "runtime.compaction.effort", label: "Summary effort", value: compaction.effort || "auto", jsonPresent: json.runtime?.compaction?.effort !== undefined }),
      toField({ id: "runtime.compaction.failureCooldownMs", label: "Summary failure cooldown", value: String(compaction.failureCooldownMs ?? 900000), jsonPresent: json.runtime?.compaction?.failureCooldownMs !== undefined }),
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
        id: "runtime.session.root",
        label: "Sessions root",
        value: runtime.session.root ?? "in-memory",
        jsonPresent: json.runtime?.session?.root !== undefined,
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
      ...(session.continuity?.enabled ? [
        toField({ id: "runtime.session.continuity.enabled", label: "Retained conversation evidence", value: "yes",
          jsonPresent: json.runtime?.session?.continuity?.enabled !== undefined }),
      ] : []),
      ...(session.modelSwitch?.enabled ? [
        toField({ id: "runtime.session.modelSwitch.enabled", label: "Web model switching", value: "yes",
          jsonPresent: json.runtime?.session?.modelSwitch?.enabled !== undefined }),
      ] : []),
      toField({
        id: "runtime.session.isolateProactive",
        label: "Isolate proactive runs",
        value: session.isolateProactive === true ? "yes" : "no",
        jsonPresent: json.runtime?.session?.isolateProactive !== undefined,
      }),
    ],
  };
}

export function buildConcurrencySection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
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

export function buildContextSection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
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
