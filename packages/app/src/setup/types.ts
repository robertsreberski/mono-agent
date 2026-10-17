/** An auxiliary file a module scaffolds beside the config (e.g. a cron job markdown). */
export interface GeneratedFile {
  /** Path relative to the agent folder. */
  readonly path: string;
  readonly contents: string;
}

export type SecretPersistenceStatus = "not-requested" | "planned" | "persisted" | "refused";

export interface SecretPersistenceOutcome {
  readonly status: SecretPersistenceStatus;
  readonly path?: string;
  /** Whether at least one supplied value would be or was written. */
  readonly changed: boolean;
  /** Stable refusal code suitable for programmatic recovery handling. */
  readonly reason?: SecretEnvRefusalCode;
  /** Non-secret operator guidance, including an external lock/recovery path when relevant. */
  readonly detail?: string;
}

export type SecretEnvRefusalCode =
  | "git-safety-unavailable"
  | "invalid-secret-name"
  | "malformed-env"
  | "malformed-gitignore"
  | "owner-only-permissions-unsupported"
  | "tracked-env"
  | "unrepresentable-secret-value"
  | "unsafe-env-path"
  | "unsafe-gitignore-path"
  | "unsafe-lock-path";

import type { CliEnvironment } from "../service/background/source-inputs.js";

export interface RunInitEnvironmentContext {
  readonly shellEnv: CliEnvironment;
  readonly dotenvEnv: CliEnvironment;
  readonly dotenvPath: string;
}
