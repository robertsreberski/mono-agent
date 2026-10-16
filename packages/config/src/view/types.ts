
import type { MonoAgentConfigJson } from "../json-types.js";

import type { RedactedMonoAgentConfig } from "../types.js";

/**
 * Where a displayed value came from. Core fields emit only `json` or
 * `default`; the shared app view retains `env` for adapter-owned fields.
 */
export type ConfigViewFieldSource = "env" | "json" | "default";

/**
 * Section-level lifecycle, aligned with the doctor's vocabulary. Optional
 * blocks (memory, sandbox, observability, local providers) report `disabled`
 * when absent and `active` when configured. The core view never emits
 * `waiting` — that is reserved for channel sections the app composes on top.
 */
export type ConfigViewSectionStatus = "active" | "disabled";

export interface ConfigViewField {
  /** Stable id, e.g. `runtime.model`. Matches the key in {@link CORE_CONFIG_FIELD_IDS}. */
  readonly id: string;
  readonly label: string;
  /** Already-redacted, display-ready value (never a raw secret). */
  readonly value: string;
  readonly source: ConfigViewFieldSource;
  /** True when a JSON-sourced value only restates the built-in default. */
  readonly restatesDefault?: boolean;
  /** True when the underlying value is a secret that has been redacted. */
  readonly redacted?: boolean;
  /** Adapter-owned env var for channel sections composed outside the core view. */
  readonly envKey?: string;
}

export interface ConfigViewSection {
  readonly id: string;
  readonly label: string;
  readonly status: ConfigViewSectionStatus;
  readonly fields: readonly ConfigViewField[];
}

export interface BuildMonoAgentConfigViewInput {
  readonly redacted: RedactedMonoAgentConfig;
  readonly json: MonoAgentConfigJson;
}
