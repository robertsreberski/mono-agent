import type { MonoAgentConfigJson } from "@mono-agent/config";
import type { GeneratedFile } from "./types.js";
import type { ModuleInputValues,CapabilityModule,ModuleValidateExpectation } from "../modules/types.js";
/**
 * The complete set of choices the wizard (or a preset) makes. This is the single
 * input to {@link composeWizardPlan}: everything the composer needs to emit a full
 * `mono-agent.config.json`, `.env.example`, and follow-up files is derived from it.
 */
export interface WizardFallback {
  readonly model: string;
  readonly effort?: string;
}

export interface WizardAnswers {
  /** Public display identity. Omitted only by legacy/programmatic callers. */
  readonly name?: string;
  /** Concise role statement used to generate the initial Identity. */
  readonly purpose?: string;
  readonly model: string;
  /** Optional primary-route effort; omitted means provider default. */
  readonly effort?: string;
  /** Ordered fallback routes; omitted effort means provider default. */
  readonly fallbacks: readonly WizardFallback[];
  /** Channel module ids, e.g. `["channel:webhook","channel:telegram"]`. */
  readonly channels: readonly string[];
  /** Memory module id, or `undefined` for no memory section. */
  readonly memory?: string;
  readonly sandbox: boolean;
  /** Final tool selection written into `tools.allowedTools`. */
  readonly allowedTools: readonly string[];
  /** Per module id → non-secret input overrides. Secret inputs are stripped by the composer. */
  readonly moduleInputs: Readonly<Record<string, ModuleInputValues>>;
}

/** Folder-derived context the base skeleton needs (not from wizard inputs). */
export interface ComposeContext {
  readonly dirBasename: string;
  readonly skillsRootExists: boolean;
}

/**
 * One secret the composed agent still needs. The CLI prints the checklist as
 * `- <label>: <description>` and points the operator at `<envVar>` in `.env`.
 */
export interface SecretChecklistItem {
  readonly moduleId: string;
  readonly label: string;
  readonly envVar: string;
  readonly description: string;
  readonly required: boolean;
}

/**
 * The single artifact of config generation: the JSON to write (with `$schema`),
 * the optional `.env.example`, follow-up files, the secret checklist, the selected
 * modules, the validate expectations, and any authoring warnings.
 */
export interface WizardPlan {
  readonly configJson: MonoAgentConfigJson;
  /** Joined module `envExampleLines` plus a trailing newline; `undefined` when none. */
  readonly envExample?: string;
  readonly files: readonly GeneratedFile[];
  readonly secrets: readonly SecretChecklistItem[];
  readonly selectedModules: readonly CapabilityModule[];
  readonly validateExpectations: readonly ModuleValidateExpectation[];
  readonly warnings: readonly string[];
}
