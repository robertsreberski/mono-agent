import type { RuntimeExecutionMode, RuntimeModelReference } from "@worklab-ai/runtime-adapter";

export type MemoryWriteMode = "disabled" | "append-host-summary";
export type MemoryScope = "single-file" | "per-conversation";

export interface MonoAgentConfig {
  readonly runtime: {
    readonly model: RuntimeModelReference;
    readonly executionMode: RuntimeExecutionMode;
    readonly effort?: string;
    readonly maxTurns: number;
    readonly workspace: string;
  };
  readonly context: {
    readonly identityPath: string;
    readonly soulPath?: string;
    readonly skillsRoot?: string;
    readonly selectedSkills: readonly string[];
  };
  readonly memory?: {
    readonly path: string;
    readonly maxBytes: number;
    readonly scope: MemoryScope;
    readonly writeMode: MemoryWriteMode;
  };
  readonly tools: {
    readonly allowedTools: readonly string[];
    readonly disallowedTools: readonly string[];
    readonly mcpConfigPath?: string;
  };
  readonly artifacts: {
    readonly dir: string;
  };
}

export interface RedactedMonoAgentConfig {
  readonly runtime: MonoAgentConfig["runtime"];
  readonly context: MonoAgentConfig["context"];
  readonly memory?: MonoAgentConfig["memory"];
  readonly tools: MonoAgentConfig["tools"];
  readonly artifacts: MonoAgentConfig["artifacts"];
}
