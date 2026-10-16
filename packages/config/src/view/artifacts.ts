

import type { BuildMonoAgentConfigViewInput, ConfigViewSection } from "./types.js";

import { PLACEHOLDER, resolveSource, toField } from "./fields.js";

export function buildArtifactsSection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json } = input;
  const memoryDryRunJsonPresent = json.artifacts?.memoryRetention?.dryRun !== undefined;
  const inheritedDryRunSource = resolveSource(json.artifacts?.retention?.dryRun !== undefined);
  const memoryDryRunSource = memoryDryRunJsonPresent ? "json" : inheritedDryRunSource;
  return {
    id: "artifacts",
    label: "Artifacts",
    status: "active",
    fields: [
      toField({
        id: "artifacts.dir",
        label: "Artifact directory",
        value: redacted.artifacts.dir,
        jsonPresent: json.artifacts?.dir !== undefined,
      }),
      toField({
        id: "artifacts.replyFiles.maxStorageBytes",
        label: "Reply artifact storage budget",
        value: String(redacted.artifacts.replyFiles?.maxStorageBytes ?? 2_147_483_648),
        jsonPresent: json.artifacts?.replyFiles?.maxStorageBytes !== undefined,
      }),
      toField({
        id: "artifacts.replyFiles.maxFileBytes",
        label: "Reply file maximum bytes",
        value: String(redacted.artifacts.replyFiles?.maxFileBytes ?? 20_971_520),
        jsonPresent: json.artifacts?.replyFiles?.maxFileBytes !== undefined,
      }),
      toField({
        id: "artifacts.retention.maxAgeDays",
        label: "Retention max age",
        value: `${redacted.artifacts.retention.maxAgeDays} day(s)`,
        jsonPresent: json.artifacts?.retention?.maxAgeDays !== undefined,
      }),
      toField({
        id: "artifacts.retention.maxCount",
        label: "Retention max count",
        value: String(redacted.artifacts.retention.maxCount),
        jsonPresent: json.artifacts?.retention?.maxCount !== undefined,
      }),
      toField({
        id: "artifacts.retention.dryRun",
        label: "Retention dry run",
        value: redacted.artifacts.retention.dryRun ? "yes" : "no",
        jsonPresent: json.artifacts?.retention?.dryRun !== undefined,
      }),
      toField({
        id: "artifacts.memoryRetention.maxAgeDays",
        label: "Memory retention max age",
        value: `${redacted.artifacts.memoryRetention.maxAgeDays} day(s)`,
        jsonPresent: json.artifacts?.memoryRetention?.maxAgeDays !== undefined,
      }),
      toField({
        id: "artifacts.memoryRetention.maxCount",
        label: "Memory retention max count",
        value: String(redacted.artifacts.memoryRetention.maxCount),
        jsonPresent: json.artifacts?.memoryRetention?.maxCount !== undefined,
      }),
      toField({
        id: "artifacts.memoryRetention.dryRun",
        label: "Memory retention dry run",
        value: redacted.artifacts.memoryRetention.dryRun ? "yes" : "no",
        jsonPresent: memoryDryRunJsonPresent,
        source: memoryDryRunSource,
      }),
    ],
  };
}

export function buildTraceabilitySection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json } = input;
  const trace = redacted.traceability;
  return {
    id: "traceability",
    label: "Traceability",
    status: "active",
    fields: [
      toField({
        id: "traceability.registryDir",
        label: "Trace registry",
        value: trace.registryDir,
        jsonPresent: json.traceability?.registryDir !== undefined,
      }),
      toField({
        id: "traceability.sourceId",
        label: "Source ID",
        value: trace.sourceId ?? PLACEHOLDER,
        jsonPresent: json.traceability?.sourceId !== undefined,
      }),
      toField({
        id: "traceability.sourceLabel",
        label: "Source label",
        value: trace.sourceLabel ?? PLACEHOLDER,
        jsonPresent: json.traceability?.sourceLabel !== undefined,
      }),
      toField({
        id: "traceability.heartbeatMs",
        label: "Heartbeat (ms)",
        value: trace.heartbeatMs === undefined ? "default" : String(trace.heartbeatMs),
        jsonPresent: json.traceability?.heartbeatMs !== undefined,
        jsonValue: json.traceability?.heartbeatMs,
        defaultValue: 10_000,
      }),
      toField({
        id: "traceability.staleAfterMs",
        label: "Stale after (ms)",
        value: trace.staleAfterMs === undefined ? "default" : String(trace.staleAfterMs),
        jsonPresent: json.traceability?.staleAfterMs !== undefined,
        jsonValue: json.traceability?.staleAfterMs,
        defaultValue: 30_000,
      }),
      toField({
        id: "traceability.globalDiscovery",
        label: "Global discovery",
        value: trace.globalDiscovery === false ? "no" : "yes",
        jsonPresent: json.traceability?.globalDiscovery !== undefined,
      }),
    ],
  };
}
