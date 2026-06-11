import type { LocalProviderDefinition, RuntimeExecutionMode, RuntimeModelReference } from "@mono-agent/runtime-adapter";
import type { SandboxPolicy } from "@mono-agent/sandbox";
import type { RedactedSecretValue } from "@mono-agent/settings";

import type { EFFORT_LEVELS, PERMISSION_MODES, REASONING_SUMMARIES } from "./field-groups.js";

export type MemoryWriteMode = "disabled" | "append-host-summary";
export type MemoryScope = "single-file" | "per-conversation";
export type MemoryMode = "markdown" | "journal";
export interface MemoryToolsConfig {
  readonly enabled: boolean;
  readonly allowJournalAppend: boolean;
}
export type SessionMode = "continuous" | "per-message";
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export type ReasoningSummary = (typeof REASONING_SUMMARIES)[number];

export interface MonoAgentConfig {
  readonly runtime: {
    readonly model: RuntimeModelReference;
    /**
     * Ordered backup models tried after `model` when a run fails with a
     * retryable provider error. Each entry runs under its default execution
     * mode.
     */
    readonly fallbackModels?: readonly RuntimeModelReference[];
    readonly executionMode: RuntimeExecutionMode;
    readonly effort?: EffortLevel;
    /** Tool-permission posture forwarded to the runtime (CLI execution modes). */
    readonly permissionMode?: PermissionMode;
    /** Verbosity of provider reasoning summaries surfaced by the runtime. */
    readonly reasoningSummary?: ReasoningSummary;
    readonly maxTurns: number;
    readonly workspace: string;
    readonly session: {
      readonly mode: SessionMode;
      readonly idleTimeoutMs: number;
    };
  };
  readonly context: {
    readonly identityPath: string;
    readonly soulPath?: string;
    readonly skillsRoot?: string;
    readonly selectedSkills: readonly string[];
  };
  readonly memory?: {
    readonly mode: MemoryMode;
    readonly path: string;
    readonly maxBytes: number;
    readonly scope: MemoryScope;
    readonly writeMode: MemoryWriteMode;
    readonly tools?: MemoryToolsConfig;
  };
  readonly tools: {
    readonly allowedTools: readonly string[];
    readonly disallowedTools: readonly string[];
    readonly mcpConfigPath?: string;
  };
  readonly sandbox?: SandboxPolicy;
  readonly artifacts: {
    readonly dir: string;
  };
  readonly traceability: {
    readonly registryDir: string;
    readonly sourceId?: string;
    readonly sourceLabel?: string;
    readonly heartbeatMs?: number;
    readonly staleAfterMs?: number;
  };
  readonly providers?: {
    readonly piAuthPath?: string;
    readonly local?: readonly LocalProviderDefinition[];
  };
}

export type RedactedLocalProviderDefinition = Omit<LocalProviderDefinition, "apiKey"> & {
  readonly apiKey?: RedactedSecretValue;
};

export interface RedactedMonoAgentConfig {
  readonly runtime: MonoAgentConfig["runtime"];
  readonly context: MonoAgentConfig["context"];
  readonly memory?: MonoAgentConfig["memory"];
  readonly tools: MonoAgentConfig["tools"];
  readonly sandbox?: MonoAgentConfig["sandbox"];
  readonly artifacts: MonoAgentConfig["artifacts"];
  readonly traceability: MonoAgentConfig["traceability"];
  readonly providers?: {
    readonly piAuthPath?: string;
    readonly local?: readonly RedactedLocalProviderDefinition[];
  };
}
