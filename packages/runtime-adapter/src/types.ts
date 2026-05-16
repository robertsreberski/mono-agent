export type RuntimeExecutionMode = "sdk" | "cli";

export interface RuntimeModelReference {
  readonly sdk: string;
  readonly model: string;
  readonly provider?: string;
  readonly reference?: string;
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
  readonly executionMode?: RuntimeExecutionMode;
  readonly onEvent?: (event: RuntimeEventLike) => void;
  readonly effort?: string;
  readonly cwd?: string;
  readonly maxTurns?: number;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpServers?: Record<string, unknown>;
  readonly mcpConfigPath?: string;
  readonly [key: string]: unknown;
}

export interface MonoRuntimeLike {
  run(systemPrompt: string, options: RuntimeRunOptions): Promise<RuntimeResult>;
  configureTools?(next?: RuntimeToolOptions): void;
}

export interface RuntimeToolOptions {
  readonly workspace?: string;
  readonly repoRoot?: string;
  readonly ripgrepPath?: string;
  readonly qaOutputDir?: string;
  readonly [key: string]: unknown;
}

export interface MonoRuntimeHostOptions extends RuntimeToolOptions {
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
