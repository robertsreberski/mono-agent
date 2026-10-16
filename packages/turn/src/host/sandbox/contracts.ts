// Host sandbox data contracts; enforcement lives in sandbox.ts.


export const SANDBOX_MODES = ["native", "off"] as const;

export type SandboxMode = (typeof SANDBOX_MODES)[number];


export const SANDBOX_NETWORK_MODES = ["none", "localhost", "allowlist", "all"] as const;

export type SandboxNetworkMode = (typeof SANDBOX_NETWORK_MODES)[number];


export const SANDBOX_FALLBACKS = ["fail-closed", "unsafe-host-process"] as const;

export type SandboxFallback = (typeof SANDBOX_FALLBACKS)[number];


export type SandboxEngineId = string;


export interface SandboxNetworkPolicy {
  readonly mode: SandboxNetworkMode;
  readonly allowlist: readonly string[];
}


export interface SandboxPolicy {
  readonly mode: SandboxMode;
  readonly engine: SandboxEngineId;
  readonly root: string;
  readonly readableRoots: readonly string[];
  readonly writableRoots: readonly string[];
  /** Host-internal canonical roots that model tools must never read or mutate. */
  readonly protectedRoots?: readonly string[];
  readonly denyWrite: readonly string[];
  readonly tempRoot: string;
  readonly network: SandboxNetworkPolicy;
  readonly fallback: SandboxFallback;
  readonly unsafeAllowHostProcess: boolean;
}


export interface SandboxCommandSpec {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  /** Trusted per-command capability; never derived from model/user tool input. */
  readonly allowLocalBinding?: boolean;
}


export interface PreparedSandboxCommand extends SandboxCommandSpec {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly sandboxed: boolean;
  readonly sandboxSettingsPath?: string;
  readonly cleanup?: () => Promise<void>;
}


export interface SandboxEngine {
  readonly id: SandboxEngineId;
  isAvailable(): Promise<boolean>;
  prepareCommand(command: SandboxCommandSpec, policy: SandboxPolicy): Promise<PreparedSandboxCommand>;
}


export type SandboxEffectiveMode =
  | "off"
  | "native"
  | "blocked"
  | "unsafe-host-process";


export interface SandboxEffectiveState {
  readonly configured: boolean;
  readonly configuredMode: SandboxMode | undefined;
  readonly effective: SandboxEffectiveMode;
  readonly engine: SandboxEngineId | undefined;
  readonly engineAvailable: boolean | undefined;
  readonly fallback: SandboxFallback | undefined;
  readonly fallbackActive: boolean;
  readonly unsafeAllowHostProcess: boolean;
}
