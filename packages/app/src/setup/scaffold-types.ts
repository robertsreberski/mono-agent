import type { FirstRunManagedMemoryHooks } from "../first-run-managed-memory.js";
import type { WizardAnswers, WizardPlan } from "./wizard-types.js";
import type { defaultAnswers } from "../wizard/answers.js";
import type { InitFileChange, SecretPersistenceOutcome } from "./types.js";

export interface InitMonoAgentFolderOptions {
  /** Folder the agent is constructed in. Defaults to process.cwd(). */
  readonly dir?: string;
  /** The composed capability selection; omitted → {@link defaultAnswers} (the silent default scaffold). */
  readonly answers?: WizardAnswers;
  /** Plan the scaffold and report it without writing anything. */
  readonly dryRun?: boolean;
  /** Required capability secrets held only for this init run; never written to config JSON. */
  readonly secretValues?: Readonly<Record<string, string>>;
  /** Recheck and harden an existing credential-bearing `.env` even when no new value is written. */
  readonly secureExistingDotenv?: boolean;
  /** Guided-first-run guard: atomically create config and fail if another writer won the path. */
  readonly requireConfigCreation?: boolean;
  /** Effective CLI environment for credential names explicitly referenced by JSON. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Init-authoring only: persist the chosen Pi auth store when .env selected it. */
  readonly authPathForConfig?: string;
  /** @internal Test-only fault/race seams for first-run managed-memory publication. */
  readonly firstRunManagedMemoryHooks?: FirstRunManagedMemoryHooks;
}

export interface InitMonoAgentFolderResult {
  readonly dir: string;
  readonly configPath: string;
  readonly identityPath: string;
  /** Exact outcome for the wizard Role's one canonical destination. */
  readonly identityRole: {
    readonly path: string;
    readonly section: "## Role";
    /** `preserved` means the entered Role was not written anywhere. */
    readonly status: "created" | "preserved" | "planned-create";
  };
  /** Files and directories created (or, with dryRun, that would be created). */
  readonly created: readonly string[];
  /** Files that already existed and were left untouched (absolute paths). */
  readonly skipped: readonly string[];
  /** Existing knowledge files the generated identity references. */
  readonly knowledgeFiles: readonly string[];
  /** True when nothing was written because dryRun was set. */
  readonly dryRun: boolean;
  /** True when this init securely merged in-run required secrets into `.env`. */
  readonly secretsPersisted: boolean;
  /** Precise per-path outcomes, including updates that the legacy arrays cannot represent. */
  readonly changes: readonly InitFileChange[];
  /** The outcome of the optional secure `.env` persistence operation. */
  readonly secretPersistence: SecretPersistenceOutcome;
  /** The composed plan (config, secrets, env example, files, validate expectations). */
  readonly plan: WizardPlan;
}
