import type { SandboxEngine } from "@mono-agent/turn/host/types";
import type { MonoAgentAppConfigInput } from "../app-config.js";
import type { ChannelDriver } from "../channels/types.js";

interface DoctorStatusExecOptions {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly encoding: "utf8";
}

interface DoctorStatusExecResult {
  readonly stdout: string;
}

/** Injectable process seam for bounded, read-only local tool version checks. */
export type DoctorStatusExecFile = (
  file: string,
  args: readonly string[],
  options: DoctorStatusExecOptions,
) => Promise<DoctorStatusExecResult>;

type CodexWebSearchProbe = (options: {
  readonly model: string;
}) => Promise<{ readonly ok: boolean; readonly reason: string; readonly model: string }>;

export interface ValidateMonoAgentFolderOptions extends MonoAgentAppConfigInput {
  readonly drivers?: readonly ChannelDriver[];
  /** Optional sandbox engine override for deterministic validation tests. */
  readonly sandboxEngine?: SandboxEngine;
  /**
   * When false, validation must not create directories or otherwise mutate the
   * target filesystem. This is used for downstream consumer validation from a
   * different working directory. Defaults to true.
   */
  readonly allowFilesystemWrites?: boolean;
  /**
   * When false, skip live probes (Ollama reachability, the
   * local run health and local tool version checks) and validate
   * only structure/shape. Those probes can only ever downgrade a section to
   * `waiting`, never `error`, so skipping them leaves the pass/fail verdict
   * (`ok`) unchanged — the start preflight relies on this. Defaults to true.
   */
  readonly liveness?: boolean;
  /** Start preflight remains permissive for duplicates; validate/doctor defaults to error. */
  readonly ignoreDuplicateKeys?: boolean;
  /** Model refs whose credentials were proven by a successful live turn. */
  readonly verifiedCredentialModelRefs?: readonly string[];
  /** Injectable subprocess seam for deterministic local tool version checks. */
  readonly statusExecFile?: DoctorStatusExecFile;
  /** Injectable ChatGPT-subscription Codex search readiness probe. */
  readonly codexWebSearchProbe?: CodexWebSearchProbe;
  /** Managed workers resolve optional plugins only from their attested app closure. */
  /**
   * Internal managed-worker fast path. The launch verifier has already bound
   * this informational detail to the exact private runtime marker, so doctor
   * must not repeat the full dependency-tree provenance traversal.
   */
  readonly verifiedRuntimeProvenanceDetail?: string;
}
