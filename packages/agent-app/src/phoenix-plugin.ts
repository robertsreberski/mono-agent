import type {
  PhoenixExporterConfig,
  RunExportContext,
  RunExporter,
  RunSummary,
  RuntimeEventLike,
} from "@mono-agent/observability";

import {
  isOptionalPluginInstalled,
  loadOptionalPlugin,
  missingOptionalPluginMessage,
  resolveOptionalPluginManifest,
} from "./optional-plugin.js";
import type { OptionalPluginDefinition, OptionalPluginResolutionOptions } from "./optional-plugin.js";

export const PHOENIX_PLUGIN_PACKAGE = "@mono-agent/observability-phoenix";

/** App-owned plugin boundary deliberately contains no OpenTelemetry SDK types. */
export interface PhoenixPluginModule {
  readonly createPhoenixRunExporter: (config: PhoenixExporterConfig) => RunExporter;
  readonly serializeRunTrace: (input: {
    readonly summary: RunSummary;
    readonly events: readonly RuntimeEventLike[];
    readonly context: RunExportContext;
    readonly projectName: string;
    readonly startTimeUnixNanos: bigint;
    readonly endTimeUnixNanos: bigint;
  }) => { readonly body: Uint8Array; readonly spanCount: number };
  readonly serializeEmptyTrace: () => Uint8Array;
  readonly postOtlpProtobuf: (input: {
    readonly endpoint: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
    readonly timeoutMs: number;
  }) => Promise<{ readonly ok: boolean; readonly status: number }>;
}

const definition: OptionalPluginDefinition<PhoenixPluginModule> = {
  packageName: PHOENIX_PLUGIN_PACKAGE,
  selector: "observability.exporters type 'phoenix'",
  expectedApi: "Phoenix exporter and protobuf API",
  isModule: (value): value is PhoenixPluginModule => typeof value === "object"
    && value !== null
    && ["createPhoenixRunExporter", "serializeRunTrace", "serializeEmptyTrace", "postOtlpProtobuf"]
      .every((name) => typeof (value as Record<string, unknown>)[name] === "function"),
};

export async function loadPhoenixPlugin(
  options: OptionalPluginResolutionOptions = {},
): Promise<PhoenixPluginModule> {
  return await loadOptionalPlugin(definition, options);
}

export function resolvePhoenixPluginManifest(
  options: Omit<OptionalPluginResolutionOptions, "importModule"> = {},
): string {
  return resolveOptionalPluginManifest(definition, options);
}

/** True only when the configured resolution path contains a matching-version plugin. */
export function isPhoenixPluginInstalled(
  options: Omit<OptionalPluginResolutionOptions, "importModule"> = {},
): boolean {
  return isOptionalPluginInstalled(PHOENIX_PLUGIN_PACKAGE, options);
}

export function missingPhoenixPluginMessage(): string {
  return missingOptionalPluginMessage(definition);
}
