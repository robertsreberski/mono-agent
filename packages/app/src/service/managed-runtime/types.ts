import type { ProcessIncarnation, SameProcessIncarnation } from "@mono-agent/conversation/process-incarnation";
// Launchd repair can inspect markers from older installed versions. This is a
// stable persisted discriminator, not the installed npm package name.
export const MANAGED_RUNTIME_MARKER_PACKAGE = "@mono-agent/agent-app";
export const RUNTIME_REUSE_PROOF_SCHEMA = "mono-agent.managed-runtime-reuse-proof.v1";

export type ManagedRuntimeVerificationMode = "fast-reuse" | "full-reuse" | "installed" | "repaired";

export interface ManagedBackgroundRuntime {
  readonly cliPath: string;
  readonly nodePath: string;
  readonly installRoot: string;
  readonly packageVersion: string;
  readonly cliSha256: string;
  readonly nodeAbi: string;
  /** How the durable runtime was established for this invocation. */
  readonly verificationMode: ManagedRuntimeVerificationMode;
  /** Opaque, path-free proof consumed only by the managed LaunchAgent worker. */
  readonly launchProof: string;
}

export interface ManagedRuntimeLaunchVerification {
  /** Exact verified closure root; safe to add as an app-owned read-only SRT root. */
  readonly installRoot: string;
  /** Operator-facing provenance derived from the same verified marker. */
  readonly provenanceDetail: string;
  readonly packageVersion: string;
  readonly cliSha256: string;
}

export interface ManagedRuntimeSourceIdentity {
  readonly packageVersion: string;
  readonly cliSha256: string;
}

export interface ManagedRuntimeLaunchVerificationInput {
  readonly currentCliPath: string;
  readonly launchProof: string;
  readonly homeDir?: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ManagedRuntimeProvenanceVerificationInput {
  readonly packageRoot: string;
  readonly packageVersion: string;
  readonly cliSha256: string;
  readonly sourceClosureSha256: string;
  readonly closureManifestSha256: string;
  readonly executionProofSha256: string;
  readonly nodeAbi: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly installedAt: string;
}

export interface ManagedRuntimeProvenanceVerificationDeps {
  /** Deterministic race-test seam; production never supplies this hook. */
  readonly afterInitialClosureCapture?: () => Promise<void>;
  /** In-capture race seam after root files were read but before the final proof pass. */
  readonly afterFinalRootCapture?: () => Promise<void>;
  /** Full-manifest race seam after traversal but before its global identity pass. */
  readonly beforeFinalManifestProof?: () => Promise<void>;
}

/** One config-selected package that is loaded dynamically rather than declared by app. */
export interface ManagedRuntimeAdditionalPackage {
  readonly packageName: string;
  /** Resolved package root containing package.json (not a node_modules symlink). */
  readonly packageSource: string;
}

export type ManagedRuntimePreparationPhase = "reuse" | "source" | "source-verification" | "copy"
  | "staged-verification" | "promotion" | "proof-publication" | "final-verification" | "waiting" | "cleanup" | "ready";

export type ManagedRuntimeStagingWarning = "unsafe-staging" | "staging-changed" | "staging-cleanup-failed";

/** Path-free preparation observations; never authority to launch or accept bytes. */
export interface ManagedRuntimeProgress {
  readonly phase: ManagedRuntimePreparationPhase;
  readonly elapsedMs: number;
  readonly completed: number;
  readonly total?: number;
  readonly ownerPid?: number;
  readonly warning?: ManagedRuntimeStagingWarning;
}

export interface ManagedBackgroundRuntimeInput {
  /** Optional, throttled, path-free phase/work observations. Throwing aborts at the next safe phase boundary. */
  readonly onProgress?: (progress: ManagedRuntimeProgress) => void;
  /** The CLI currently executing. Its exact bytes are the trust anchor. */
  readonly currentCliPath: string;
  readonly nodePath: string;
  readonly homeDir?: string;
  readonly packageVersion?: string;
  readonly nodeAbi?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  /** Test/packaging seam; defaults to the package root containing currentCliPath. */
  readonly packageSource?: string;
  /** Config-selected channel/memory plugin packages that must survive outside the caller's install tree. */
  readonly additionalPackages?: readonly ManagedRuntimeAdditionalPackage[];
}

/** Inputs for the read-only fleet attestation of an already materialized runtime. */
export interface ManagedBackgroundRuntimeAttestationInput {
  /** CLI from the trusted deploy checkout whose execution closure is expected. */
  readonly currentCliPath: string;
  /** CLI path persisted in the managed LaunchAgent. */
  readonly runtimeCliPath: string;
  readonly homeDir?: string;
  readonly packageVersion?: string;
  readonly nodeAbi?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly packageSource?: string;
  readonly additionalPackages?: readonly ManagedRuntimeAdditionalPackage[];
}

export interface ManagedBackgroundRuntimeAttestation {
  readonly schema: "mono-agent.managed-runtime-attestation.v1";
  /** Opaque, path-free identity used only to compare an initial and final probe. */
  readonly fingerprint: string;
  /** Safe lifecycle boundary: a managed worker must start after this install. */
  readonly installedAt: string;
}

export interface ManagedBackgroundRuntimeAttestationDeps {
  /** Deterministic race-test seam; production never supplies this hook. */
  readonly afterInitialCaptures?: () => Promise<void>;
}

export interface ManagedRuntimeInstallInput {
  readonly stagingDir: string;
  readonly packageVersion: string;
  readonly packageSource: string;
  readonly nodePath: string;
  readonly additionalPackages: readonly ManagedRuntimeAdditionalPackage[];
  readonly expectedSourceClosureSha256: string;
}

export interface ManagedBackgroundRuntimeDeps {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly randomId: () => string;
  readonly installPackage: (input: ManagedRuntimeInstallInput) => Promise<void>;
  /** Test/embed seams for persistent install-lock ownership. */
  readonly currentProcessIncarnation?: () => Promise<ProcessIncarnation>;
  readonly isSameProcessIncarnation?: SameProcessIncarnation;
}

export interface RuntimeIdentity {
  readonly packageVersion: string;
  readonly cliSha256: string;
  readonly sourceClosureSha256: string;
  readonly nodeAbi: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

export interface RuntimeLayout {
  readonly versionAbiDir: string;
  readonly installRoot: string;
  readonly cliPath: string;
  readonly maintenanceEntryPath: string;
  readonly packageJsonPath: string;
  readonly packageLockPath: string;
  readonly closureManifestPath: string;
  readonly markerPath: string;
  readonly reuseProofDir: string;
  readonly reuseProofPath: string;
  readonly lockDir: string;
  readonly stagingDir: string;
  readonly quarantineDir: string;
}

export interface RuntimeMarkerV4 extends RuntimeIdentity {
  readonly schema: "mono-agent.managed-runtime.v4";
  readonly packageName: typeof MANAGED_RUNTIME_MARKER_PACKAGE;
  readonly closureManifestSha256: string;
  readonly executionProofSha256: string;
  readonly installedAt: string;
}

export interface RuntimeMarkerV5 extends RuntimeIdentity {
  readonly schema: "mono-agent.managed-runtime.v5";
  readonly packageName: typeof MANAGED_RUNTIME_MARKER_PACKAGE;
  readonly closureManifestSha256: string;
  readonly executionProofSha256: string;
  readonly reuseProofSha256: string;
  readonly installedAt: string;
}

export type RuntimeMarker = RuntimeMarkerV4 | RuntimeMarkerV5;

export interface RuntimeClosureManifest {
  readonly schema: "mono-agent.execution-closure.v1";
  readonly entries: readonly RuntimeClosureEntry[];
}

export type RuntimeClosureEntry =
  | { readonly path: string; readonly type: "directory"; readonly mode: string }
  | { readonly path: string; readonly type: "file"; readonly mode: string; readonly sha256: string }
  | { readonly path: string; readonly type: "symlink"; readonly mode: string; readonly target: string };

export interface InstalledPackageMetadata {
  readonly name: string;
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly optionalPeers: ReadonlySet<string>;
}

export interface ExecutionClosureNode {
  readonly id: number;
  readonly sourceRoot: string;
  readonly metadata: InstalledPackageMetadata;
  readonly dependencies: ReadonlyMap<string, number>;
  readonly sourcePackage: SourcePackageManifest;
}

export interface MutableExecutionClosureNode {
  readonly id: number;
  readonly sourceRoot: string;
  readonly metadata: InstalledPackageMetadata;
  readonly dependencies: Map<string, number>;
  readonly sourcePackage: SourcePackageManifest;
}

export interface ExecutionClosureCapture {
  readonly nodes: readonly ExecutionClosureNode[];
  readonly additionalRoots: readonly { readonly packageName: string; readonly nodeId: number }[];
  readonly sourceClosureSha256: string;
  readonly sourceProofSha256: string;
  /** Path-independent post-promotion inode/time proof for the private install root. */
  readonly filesystemProofSha256: string;
  /** Owner-private stat proof used only to validate a warm source closure. */
  readonly reuseProof: SourceClosureReuseProof;
}

export interface SourceClosureReuseProof {
  readonly sourceProofSha256: string;
  readonly packages: readonly {
    readonly id: number;
    readonly sourceRoot: string;
    readonly entries: readonly SourcePackageProofEntry[];
  }[];
  readonly links: readonly {
    readonly path: string;
    readonly logicalPath: string;
    readonly proof: SourcePackageProofEntry;
  }[];
}

export interface RuntimeClosureReuseProof {
  readonly rootEntries: readonly string[];
  readonly entries: readonly {
    readonly path: string;
    readonly proof: SourcePackageProofEntry;
  }[];
  readonly closureManifestSha256: string;
  readonly executionProofSha256: string;
}

export interface ManagedRuntimeReuseProof {
  readonly schema: typeof RUNTIME_REUSE_PROOF_SCHEMA;
  readonly identity: RuntimeIdentity;
  readonly packageSource: string;
  readonly additionalPackages: readonly ManagedRuntimeAdditionalPackage[];
  readonly source: SourceClosureReuseProof;
  readonly runtime: RuntimeClosureReuseProof;
}

/** Freshly descriptor-hashed source bytes, scoped to one preparation invocation only. */
export type SourceCaptureCache = Map<string, SourcePackageCapture>;

export interface ExecutionClosureCaptureDeps {
  readonly sourceCaptures?: SourceCaptureCache;
  readonly afterRootCapture?: () => Promise<void>;
}

export interface RuntimeClosureManifestCaptureDeps {
  readonly beforeFinalProof?: () => Promise<void>;
}

interface SourcePackageManifest {
  readonly schema: "mono-agent.source-package.v1";
  readonly entries: readonly SourcePackageEntry[];
}

export type SourcePackageEntry =
  | { readonly path: string; readonly type: "directory"; readonly mode: string }
  | { readonly path: string; readonly type: "file"; readonly mode: string; readonly sha256: string }
  | { readonly path: string; readonly type: "symlink"; readonly mode: string; readonly target: string };

export interface SourcePackageCapture {
  readonly manifest: SourcePackageManifest;
  readonly proof: readonly SourcePackageProofEntry[];
  readonly packageJson: Buffer;
}

export interface SourcePackageProofEntry {
  readonly path: string;
  readonly type: "directory" | "file" | "symlink";
  readonly dev: string;
  readonly ino: string;
  readonly nlink: string;
  readonly mode: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly target?: string;
}

export interface ResolvedInstalledDependency {
  readonly candidatePath: string;
  readonly packageRoot: string;
  readonly proof: SourcePackageProofEntry;
}
