import type { SandboxPolicy } from "@mono-agent/sandbox";

export type RuntimeExecutionMode = "sdk" | "cli";

export interface RuntimeModelReference {
  readonly sdk: string;
  readonly model: string;
  readonly provider?: string;
  readonly reference?: string;
}

export type MonoRuntimeBackendId =
  | "claude-sdk"
  | "claude-code-cli"
  | "codex-app-cli"
  | "pi-sdk";

/**
 * One row of the additive (sdk, executionMode) -> backend selection table. This
 * is a declarative building block exported alongside the backend descriptors; it
 * does not itself perform routing. `sdkAliases` lists every accepted spelling of
 * the sdk id for that backend (canonical first), so a runtime's fail-closed
 * `model.sdk` guard and the table share one vocabulary.
 */
export interface MonoRuntimeSelectionEntry {
  readonly sdk: string;
  readonly sdkAliases: readonly string[];
  readonly executionMode: RuntimeExecutionMode;
  readonly backendId: MonoRuntimeBackendId;
}

export type MonoRuntimeBackendTransport = "sdk" | "cli";

export interface MonoRuntimeBackendCapabilities {
  readonly kind?: string;
  readonly runtime?: string;
  readonly streaming?: boolean;
  readonly structured_output?: boolean;
  readonly supports_session_resume?: boolean;
  readonly native_runtime_config?: unknown;
  readonly supports_mcp?: boolean;
  readonly supports_skills?: boolean;
  readonly supports_builtin_tools?: boolean;
  readonly supports_live_input?: boolean;
  readonly supports_native_subagents?: boolean;
  readonly [key: string]: unknown;
}

export interface MonoRuntimeBackendDescriptor {
  readonly id: MonoRuntimeBackendId;
  readonly runtimeBridgeId: string;
  readonly label: string;
  readonly sdk: RuntimeModelReference["sdk"];
  readonly executionMode: RuntimeExecutionMode;
  readonly transport: MonoRuntimeBackendTransport;
  readonly providerBoundary: string;
  readonly modelReferenceExamples: readonly string[];
  readonly acceptsProviderIds: boolean;
  readonly capabilities: MonoRuntimeBackendCapabilities;
}

export interface MonoRuntimeSupportDescription {
  readonly model: RuntimeModelReference;
  readonly executionMode: RuntimeExecutionMode;
  readonly compatible: boolean;
  readonly backend?: MonoRuntimeBackendDescriptor;
  readonly incompatibilityReason?: string;
}

export interface RuntimeMessage {
  readonly role: string;
  readonly content: unknown;
  readonly timestamp?: number | string;
  readonly [key: string]: unknown;
}

export interface RuntimeEventLike {
  readonly type?: string;
  readonly [key: string]: unknown;
}

export interface RuntimeResult {
  readonly text?: string | null;
  readonly structuredResult?: unknown;
  readonly structuredResultSource?: string | null;
  readonly events?: readonly RuntimeEventLike[];
  readonly usage?: unknown;
  readonly cost?: unknown;
  readonly durationMs?: number;
  readonly numTurns?: number;
  readonly model?: string;
  readonly effort?: string;
  readonly sdk?: string;
  readonly cancelled?: boolean;
  readonly error?: string | null;
  readonly errorDetails?: unknown;
  readonly failureKind?: string | null;
  readonly providerSessionId?: string | null;
  readonly runtimeWarnings?: unknown;
  readonly diagnostics?: unknown;
  readonly capabilitiesUsed?: unknown;
  readonly [key: string]: unknown;
}

export interface RuntimeRunOptions {
  readonly model: RuntimeModelReference;
  readonly messages: readonly RuntimeMessage[];
  readonly abortSignal: AbortSignal;
  readonly executionMode?: string;
  readonly onEvent?: (event: RuntimeEventLike) => void;
  readonly effort?: string;
  readonly cwd?: string;
  readonly maxTurns?: number;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpServers?: Record<string, unknown>;
  readonly mcpConfigPath?: string;
  readonly sandboxPolicy?: SandboxPolicy;
  // Pi-native provider knobs (optional; ignored by other bridges).
  readonly piMaxRetries?: number;
  readonly maxRetryDelayMs?: number;
  readonly piSessionsRoot?: string;
  /** Tool steering: "one-at-a-time" (default) or "all" (concurrent tool calls). */
  readonly piToolParallelismMode?: "one-at-a-time" | "all";
  readonly [key: string]: unknown;
}

export interface MonoRuntimeLike {
  run(systemPrompt: string, options: RuntimeRunOptions): Promise<RuntimeResult>;
  configureTools?(next?: RuntimeToolOptions): void;
  disposeSession?(providerSessionId: string): Promise<boolean | void>;
  disposeAllSessions?(): Promise<void>;
}

export interface RuntimeToolOptions {
  readonly workspace?: string;
  readonly repoRoot?: string;
  readonly ripgrepPath?: string;
  readonly qaOutputDir?: string;
  readonly sandboxPolicy?: SandboxPolicy;
  readonly [key: string]: unknown;
}

/** A parsed model reference as agent-runtime's pricing resolvers receive it (see ai/cost.js's ParsedModelReference). */
export interface MonoRuntimeParsedPricingModel {
  readonly sdk: string | null;
  readonly provider?: string;
  readonly model: string;
}

/** agent-runtime's normalized per-token pricing row (see ai/cost.js's NormalizedPricing). */
export interface MonoRuntimePricing {
  readonly input: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly output: number | null;
  readonly source: string;
  readonly priced: boolean;
}

/** Payload passed to `onToolApprovalRequest` (see agent/approval.js's ApprovalRequestPayload). */
export interface MonoRuntimeApprovalRequest {
  readonly requestId: string;
  readonly toolName: string;
  readonly toolUseId: string | null;
  readonly argumentsSummary: string;
  readonly riskTier: "low" | "medium" | "high";
  readonly model: string | null;
}

/** A host's response to a MonoRuntimeApprovalRequest. */
export interface MonoRuntimeApprovalDecision {
  readonly decision: "approve" | "deny" | "always";
  readonly reason?: string;
}

/** Payload passed to `onCompactionRecorded` after a successful context compaction (see ai/providers/pi-native.js). */
export interface MonoRuntimeCompactionRecord {
  readonly task_run_id: string | null;
  readonly trigger: string;
  readonly provider_kind: string;
  readonly model: string | null;
  readonly tokens_before: number | null;
  readonly summary: string;
  readonly first_kept_entry_id: string | null;
  readonly status: "succeeded";
  readonly created_at: number;
}

export interface MonoRuntimeHostOptions extends RuntimeToolOptions {
  readonly observers?: readonly unknown[];
  readonly runtimeBrand?: unknown;
  readonly resolveCustomPricing?: (parsed: MonoRuntimeParsedPricingModel) => MonoRuntimePricing | null;
  readonly resolvePiApiKey?: (provider: string) => Promise<string | undefined>;
  readonly persistArtifact?: (artifact: {
    readonly filename: string;
    readonly buffer: Buffer;
    readonly toolName: string;
    readonly toolUseId: string | null;
  }) => string | null;
  readonly onCompactionRecorded?: (record: MonoRuntimeCompactionRecord) => void;
  readonly onToolApprovalRequest?: (payload: MonoRuntimeApprovalRequest) => Promise<MonoRuntimeApprovalDecision>;
  readonly toolRiskTiers?: Readonly<Record<string, "low" | "medium" | "high">>;
  readonly approvalDefaultRiskTier?: "low" | "medium" | "high";
  readonly approvalTimeoutMs?: number;
  readonly approvalAlwaysAllowTools?: readonly string[];
  readonly [key: string]: unknown;
}
