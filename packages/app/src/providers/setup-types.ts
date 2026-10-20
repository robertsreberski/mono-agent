import type { spawn } from "node:child_process";

type ProviderSetupKind = "auth" | "preflight";

interface ProviderSetupCommandAction {
  readonly id: string;
  readonly kind: ProviderSetupKind;
  readonly label: string;
  readonly modelRefs: readonly string[];
  readonly command: readonly [string, ...string[]];
  readonly cwd: string;
  readonly detail: string;
}

export interface ProviderSetupPiLoginAction extends ProviderSetupCommandAction {
  readonly id: `pi-login:${string}`;
  readonly piAuthPath: string;
}

interface ProviderSetupHttpAction {
  readonly id: string;
  readonly kind: ProviderSetupKind;
  readonly label: string;
  readonly modelRefs: readonly string[];
  readonly url: string;
  readonly cwd: string;
  readonly detail: string;
}

export interface ProviderSetupPiApiKeyAction {
  readonly id: string;
  readonly kind: "auth";
  readonly label: string;
  readonly modelRefs: readonly string[];
  readonly provider: string;
  readonly envVar: string;
  readonly persistence: "secure-store" | "environment";
  readonly piAuthPath: string;
  readonly cwd: string;
  readonly detail: string;
}

export type ProviderSetupAction =
  | ProviderSetupPiLoginAction
  | ProviderSetupCommandAction
  | ProviderSetupHttpAction
  | ProviderSetupPiApiKeyAction;

export interface ProviderSetupPlan {
  readonly actions: readonly ProviderSetupAction[];
  /** Auth actions omitted because a credential/sign-in was detected. */
  readonly detectedModelRefs: readonly string[];
}

export type ProviderCredentialState = "auth_required" | "credential_detected" | "verified";

export interface DetectProviderCredentialStatesOptions {
  readonly modelRefs: readonly string[];
  readonly cwd: string;
  readonly piAuthPath?: string;
  /** Values parsed from the destination `.env`; ambient shell credentials are intentionally excluded. */
  readonly persistedEnv?: Readonly<Record<string, string | undefined>>;
  readonly abortSignal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly execFile?: (
    file: string,
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly timeout: number;
      readonly env?: Readonly<Record<string, string | undefined>>;
      readonly abortSignal?: AbortSignal;
    },
  ) => Promise<unknown>;
}

export type ProviderSetupStatus = "ok" | "failed" | "skipped";
export type ProviderSetupFailureKind = "child_exit_unconfirmed" | "cleanup_failed";

export interface ProviderSetupResult {
  readonly action: ProviderSetupAction;
  readonly status: ProviderSetupStatus;
  readonly detail: string;
  readonly failureKind?: ProviderSetupFailureKind;
}

export interface PlanProviderSetupOptions {
  readonly modelRefs: readonly string[];
  readonly cwd: string;
  readonly piAuthPath?: string;
  /** Internal test seam for verifying bundled Pi CLI resolution in packed layouts. */
  readonly piCliPath?: string;
  /** Credential/status observations keyed by provider id or exact model reference. */
  readonly credentialStates?: Readonly<Record<string, ProviderCredentialState | undefined>>;
  /** Explicit repair path: rerun authentication even when a credential was detected. */
  readonly forceAuthentication?: boolean;
  /** Select OAuth or API-key setup for Pi providers that support both. */
  readonly piAuthMethods?: Readonly<Record<string, "oauth" | "api-key" | undefined>>;
  /** API keys can be used from env without being copied into Pi's secure store. */
  readonly piApiKeyPersistence?: "secure-store" | "environment";
  /** Per-provider wizard selections override the global API-key persistence mode. */
  readonly piApiKeyPersistenceByProvider?: Readonly<Record<string, "secure-store" | "environment" | undefined>>;
}

export interface ExecuteProviderSetupOptions {
  readonly spawn?: typeof spawn;
  readonly fetch?: typeof fetch;
  readonly apiKeys?: Readonly<Record<string, string | undefined>>;
  /** Bounded only for non-interactive local-provider preflight probes. */
  readonly preflightTimeoutMs?: number;
  /** Test seam; automatic credential persistence fails closed on Windows. */
  readonly platform?: NodeJS.Platform;
  /** Test seam immediately before the target pathname is claimed. */
  readonly beforePiAuthPromotion?: (targetPath: string, stagedPath: string) => void | Promise<void>;
  /** Test seam after exclusive link installation and before immutable-byte verification. */
  readonly afterPiAuthLink?: (targetPath: string, stagedPath: string) => void | Promise<void>;
  /** Test seam immediately before stale-lock identity/liveness is rechecked. */
  readonly beforeStalePiAuthLockRemoval?: (lockPath: string) => void | Promise<void>;
  /** Test seam after a stale lock is unlinked but before directory sync. */
  readonly afterStalePiAuthLockRemoval?: (lockPath: string) => void | Promise<void>;
  /** Test seam immediately before a staged Pi OAuth directory is removed. */
  readonly beforePiAuthCleanup?: (stagingDir: string) => void | Promise<void>;
  /** Test seam after a new lock is durable but before setup begins. */
  readonly afterPiAuthLockCreated?: (lockPath: string) => void | Promise<void>;
  /** Test seam before confirming an already-absent owned lock is durable. */
  readonly beforePiAuthMissingLockSync?: (lockPath: string) => void | Promise<void>;
  /** Test seam immediately before an API-key transaction directory is removed. */
  readonly beforePiAuthTempCleanup?: (tempDir: string) => void | Promise<void>;
  /** Test seam immediately before an old credential backup is removed. */
  readonly beforePiAuthBackupCleanup?: (backupPath: string) => void | Promise<void>;
  /** Test seam after credentials are installed but before parent-directory sync. */
  readonly beforePiAuthPostMutationSync?: (authPath: string) => void | Promise<void>;
  /** Stop before launching the next independent action after user interruption. */
  readonly abortSignal?: AbortSignal;
}

export type PiAuthPromotionHooks = Pick<
  ExecuteProviderSetupOptions,
  | "beforePiAuthPromotion"
  | "afterPiAuthLink"
  | "beforeStalePiAuthLockRemoval"
  | "afterStalePiAuthLockRemoval"
  | "beforePiAuthCleanup"
  | "afterPiAuthLockCreated"
  | "beforePiAuthMissingLockSync"
  | "beforePiAuthTempCleanup"
  | "beforePiAuthBackupCleanup"
  | "beforePiAuthPostMutationSync"
>;

export interface PersistPiProviderCredentialOptions extends PiAuthPromotionHooks {
  readonly authPath: string;
  readonly provider: string;
  readonly platform?: NodeJS.Platform;
  /**
   * Called only while the cross-process auth-store lock is held. The returned
   * credential is validated, merged into the latest store snapshot, and never
   * included in an error message.
   */
  readonly resolveCredential: (signal?: AbortSignal) => Promise<unknown>;
  readonly abortSignal?: AbortSignal;
  /** Secret-free signal that target-store mutation began; the callback must not throw. */
  readonly onCredentialStoreMutation?: () => void;
}
