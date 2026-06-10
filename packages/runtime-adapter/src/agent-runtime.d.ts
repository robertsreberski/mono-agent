declare module "@worklab-ai/agent-runtime" {
  export interface AgentRuntimeHostOptions {
    readonly workspace?: string;
    readonly repoRoot?: string;
    readonly ripgrepPath?: string;
    readonly qaOutputDir?: string;
    readonly observers?: readonly unknown[];
    readonly runtimeBrand?: unknown;
    readonly resolveCustomPricing?: unknown;
    readonly resolvePiApiKey?: unknown;
    readonly persistArtifact?: unknown;
    readonly onCompactionRecorded?: unknown;
    readonly onToolApprovalRequest?: unknown;
    readonly toolRiskTiers?: unknown;
    readonly approvalDefaultRiskTier?: unknown;
    readonly approvalTimeoutMs?: unknown;
    readonly approvalAlwaysAllowTools?: unknown;
    readonly [key: string]: unknown;
  }

  export interface AgentRuntimeInstance {
    run(systemPrompt: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
    configureTools?(next?: Record<string, unknown>): void;
    disposeSession?(providerSessionId: string): Promise<boolean | void>;
    disposeAllSessions?(): Promise<void>;
  }

  export function createRuntime(host?: AgentRuntimeHostOptions): AgentRuntimeInstance;
}

declare module "@worklab-ai/agent-runtime/ai/runtime/model-refs.js" {
  export function parseRuntimeModelReference(value: string): unknown;
  export function normalizeRuntimeModelReference(value: string): unknown;
  export function executionModeIncompatibilityReason(modelRefOrParsed: unknown, executionMode: string): string | null;
  export function isModelCompatibleWithExecutionMode(modelRefOrParsed: unknown, executionMode: string): boolean;
}

declare module "@worklab-ai/agent-runtime/ai/runtime/registry.js" {
  export interface RuntimeBridgeDescriptor {
    readonly id: string;
    readonly supports: (modelRef: unknown, options?: Record<string, unknown>) => boolean;
    readonly capabilities: () => Record<string, unknown>;
  }

  export function listRuntimeBridges(): RuntimeBridgeDescriptor[];
  export function runtimeCapabilities(sdkOrModel: unknown): Record<string, unknown>;
}
