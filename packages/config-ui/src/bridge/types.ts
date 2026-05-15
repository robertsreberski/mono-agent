import type { FieldGroup } from "../schema/types.js";

export interface ConfigUiBridgeOptions {
  /** Absolute path to the JSON config file the bridge reads/writes. */
  readonly configPath: string;
  /** Workspace root used for resolving relative paths in field validation. */
  readonly cwd: string;
  /** Field group registry. Defaults to CORE_FIELD_GROUPS. */
  readonly fieldGroups?: readonly FieldGroup[];
  /** Bind host. Defaults to 127.0.0.1. Refuses non-loopback values. */
  readonly host?: string;
  /** Bind port. 0 means "pick a free port". Defaults to 0. */
  readonly port?: number;
  /** Override the per-boot bearer token (testing only). */
  readonly token?: string;
  /** Optional logger for bridge events. */
  readonly log?: (event: ConfigUiBridgeEvent) => void;
}

export interface ConfigUiBridgeStartResult {
  readonly url: string;
  readonly token: string;
  readonly stop: () => Promise<void>;
}

export type ConfigUiBridgeEvent =
  | { readonly kind: "listening"; readonly url: string }
  | { readonly kind: "read"; readonly path: string }
  | { readonly kind: "write"; readonly path: string; readonly version: string }
  | { readonly kind: "unauthorized"; readonly path: string }
  | { readonly kind: "validation_failed"; readonly path: string; readonly reason: string }
  | { readonly kind: "stopped" };
