import type { MonoAgentConfigJson } from "@mono-agent/config";

import type { ValidationStatus } from "../doctor.js";

/** The kind of capability a module contributes, used to group the wizard's steps. */
export type ModuleKind = "channel" | "memory" | "sandbox" | "observability" | "provider";

/**
 * A value a module templates against. Non-secret inputs carry a default and may
 * be overridden by the wizard/CLI; secret inputs are never written into JSON —
 * they only emit a `.env.example` placeholder via {@link CapabilityModule.envExampleLines}.
 * (Same shape as the old `RecipeInput`.)
 */
export interface ModuleInput {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Default used when the wizard/CLI does not override the input. */
  readonly default?: string;
  /** Secret inputs are externalized to `.env.example`, never inlined in JSON. */
  readonly secret?: boolean;
  /** The `MONO_AGENT_*` env var a secret input maps to (for `.env.example`). */
  readonly envVar?: string;
}

/** Resolved input values keyed by {@link ModuleInput.id}. */
export type ModuleInputValues = Readonly<Record<string, string | undefined>>;

/** An auxiliary file a module scaffolds beside the config (e.g. a cron job markdown). */
export interface GeneratedFile {
  /** Path relative to the agent folder. */
  readonly path: string;
  readonly contents: string;
}

/**
 * A capability a module promises once its secrets are filled in. The composer
 * checks each expectation against the doctor report and reports the module as
 * incomplete when a required section is not yet at the promised status.
 */
export interface ModuleValidateExpectation {
  /** Doctor section id: `runtime|memory|sandbox|tools|observability|channel:<driver>`. */
  readonly sectionId: string;
  /** The status the section must reach for the module to be considered live. */
  readonly mustBe: ValidationStatus;
  /** Human note explaining what to do if the expectation is unmet. */
  readonly note?: string;
}

/**
 * A composable capability: a partial config fragment plus the inputs, secrets,
 * tools, and validate-expectations it owns. The composer spreads fragments onto
 * a shared base skeleton — a module never writes secrets into the config and only
 * emits JSON the existing loader already accepts.
 */
export interface CapabilityModule {
  /** `channel:telegram`, `memory:bujo`, `sandbox`, `observability:phoenix`, ... */
  readonly id: string;
  readonly kind: ModuleKind;
  readonly title: string;
  /** One-line wizard hint. */
  readonly summary: string;
  readonly riskLevel: "low" | "medium" | "high";
  /** The `docs/playbooks/<file>` this module mirrors, parity-checked to exist. */
  readonly playbook?: string;
  readonly inputs: readonly ModuleInput[];
  /** Partial config this module contributes; composed onto the base skeleton. */
  readonly configFragment: (values: ModuleInputValues) => Partial<MonoAgentConfigJson> & Record<string, unknown>;
  /** `.env.example` placeholder lines for this module's secrets (no trailing newline per line). */
  readonly envExampleLines?: (values: ModuleInputValues) => readonly string[];
  /** `allowedTools` entries this capability wants (pre-checked in the wizard tools step). */
  readonly recommendedTools?: readonly string[];
  /** Extra files to scaffold (cron job markdown, etc.). */
  readonly files?: (values: ModuleInputValues) => readonly GeneratedFile[];
  /** Capabilities the composer checks once secrets are supplied. */
  readonly validateExpectations: readonly ModuleValidateExpectation[];
}

/** Resolve declared input defaults, then layer overrides on top. */
export function resolveModuleInputs(
  module: CapabilityModule,
  overrides: ModuleInputValues = {},
): ModuleInputValues {
  const values: Record<string, string | undefined> = {};
  for (const input of module.inputs) {
    values[input.id] = overrides[input.id] ?? input.default;
  }
  // Preserve overrides that don't correspond to a declared input (forward-compat).
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in values)) {
      values[key] = value;
    }
  }
  return values;
}
