import type { FieldGroup } from "@worklab-ai/settings";
import type { SettingsJson } from "@worklab-ai/settings";

export interface OperatorConsoleObservabilityOptions {
  /** Artifact directory containing *.summary.json and *.events.jsonl files. */
  readonly artifactDir: string | (() => string | undefined | Promise<string | undefined>);
  /** Maximum number of runs returned by the list endpoint. */
  readonly maxRuns?: number;
  /** Maximum events returned for a single run detail. */
  readonly maxEventsPerRun?: number;
  /** Maximum string bytes retained per payload field. */
  readonly maxStringBytes?: number;
}

export interface OperatorConsoleTraceabilityOptions {
  /** Registry directory containing trace source manifests. */
  readonly registryDir: string | (() => string | undefined | Promise<string | undefined>);
  /** Maximum number of runs returned by the aggregate endpoint. */
  readonly maxRuns?: number;
  /** Maximum events returned for a single run detail. */
  readonly maxEventsPerRun?: number;
  /** Maximum string bytes retained per payload field. */
  readonly maxStringBytes?: number;
  /** Milliseconds before a running source heartbeat is reported as stale. */
  readonly staleAfterMs?: number | (() => number | undefined | Promise<number | undefined>);
}

export interface OperatorConsoleConfigWriteContext {
  readonly configPath: string;
  readonly version: string;
  readonly patch: SettingsJson;
}

export type ConfigApplyResult =
  | { readonly kind: "applied"; readonly message: string; readonly transports: readonly string[] }
  | { readonly kind: "waiting_for_config"; readonly message: string; readonly transports: readonly string[] }
  | { readonly kind: "failed"; readonly message: string; readonly transports: readonly string[] };

export interface OperatorConsoleOptions {
  /** Absolute path to the JSON settings file the console reads/writes. */
  readonly configPath: string;
  /**
   * Deprecated and ignored. The console resolves paths from `configPath`
   * (and the observability/traceability dir options) directly, so no
   * separate workspace root is needed. Accepted for backwards compatibility.
   */
  readonly cwd?: string;
  /** Field group registry rendered by the Settings view. Defaults to none. */
  readonly fieldGroups?: readonly FieldGroup[];
  /** Bind host. Defaults to 127.0.0.1. Refuses non-loopback values. */
  readonly host?: string;
  /** Bind port. 0 means "pick a free port". Defaults to 0. */
  readonly port?: number;
  /** Override the per-boot bearer token (testing only). */
  readonly token?: string;
  /** Optional recorded-run artifact reader configuration for the Observability view. */
  readonly observability?: OperatorConsoleObservabilityOptions;
  /** Optional host-level trace source registry configuration for the Traceability view. */
  readonly traceability?: OperatorConsoleTraceabilityOptions;
  /** Optional host callback invoked after a successful config write. */
  readonly applyConfigWrite?: (context: OperatorConsoleConfigWriteContext) => Promise<ConfigApplyResult>;
  /** Optional logger for operator console server events. */
  readonly log?: (event: OperatorConsoleEvent) => void;
}

export interface OperatorConsoleStartResult {
  readonly url: string;
  readonly token: string;
  readonly stop: () => Promise<void>;
}

export type OperatorConsoleEvent =
  | { readonly kind: "listening"; readonly url: string }
  | { readonly kind: "read"; readonly path: string }
  | { readonly kind: "write"; readonly path: string; readonly version: string }
  | { readonly kind: "unauthorized"; readonly path: string }
  | { readonly kind: "validation_failed"; readonly path: string; readonly reason: string }
  | { readonly kind: "stopped" };
