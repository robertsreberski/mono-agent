export type HostCheckId = "runtime.node" | "runtime.node-abi" | "native.memory" | "native.sharp"
  | "service.manager" | "models.ollama" | "models.lmstudio" | "sandbox.runtime" | "console.port";
export interface HostRemediation {
  readonly command: string;
  readonly explanation: string;
  readonly prerequisite?: string;
}
export interface HostCheck {
  readonly id: HostCheckId;
  readonly status: "ok" | "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly observed: Readonly<Record<string, unknown>>;
  readonly remediations: readonly HostRemediation[];
}
export interface HostPreflightReport {
  readonly schemaVersion: 1;
  readonly operation: "host-preflight";
  readonly ok: boolean;
  readonly runtime: {
    readonly nodeVersion: string;
    readonly requiredNode: string;
    readonly nodeAbi: string;
    readonly platform: string;
    readonly arch: string;
  };
  readonly checks: readonly HostCheck[];
  /** Present only for usage or unexpected collector failures. */
  readonly failure?: { readonly code: "usage" | "preflight_failed"; readonly message: string };
}
