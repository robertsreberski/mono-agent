import { homedir } from "node:os";

import { resolve } from "node:path";

import { normalizeOptionalString } from "@mono-agent/contracts";

import type { MonoAgentConfig } from "../types.js";

import { jsonBoolean, jsonInteger, jsonRecord, jsonString } from "./scalars.js";

import { readPath } from "./paths.js";

const DEFAULT_TRACE_HEARTBEAT_MS = 10_000;

const DEFAULT_TRACE_STALE_AFTER_MS = 30_000;

export function readTraceabilityConfig(
  value: unknown,
  cwd: string,
  agentName: string | undefined,
): MonoAgentConfig["traceability"] {
  const traceability = jsonRecord(value, "traceability") ?? {};
  const registryDir = readPath(
    jsonString(traceability.registryDir, "traceability.registryDir"),
    cwd,
    resolve(homedir(), ".mono-agent", "trace-sources"),
  );
  const sourceId = normalizeOptionalString(jsonString(traceability.sourceId, "traceability.sourceId"));
  // An explicit trace label remains authoritative. Otherwise the public agent
  // name becomes the display label without changing the stable source id.
  const sourceLabel = normalizeOptionalString(jsonString(traceability.sourceLabel, "traceability.sourceLabel")) ?? agentName;
  const heartbeatMs = jsonInteger(traceability.heartbeatMs, "traceability.heartbeatMs", DEFAULT_TRACE_HEARTBEAT_MS, {
    min: 250,
    max: 86_400_000,
  });
  const staleAfterMs = jsonInteger(traceability.staleAfterMs, "traceability.staleAfterMs", DEFAULT_TRACE_STALE_AFTER_MS, {
    min: 1_000,
    max: 604_800_000,
  });
  const globalDiscovery = jsonBoolean(traceability.globalDiscovery, "traceability.globalDiscovery", true);
  return {
    registryDir,
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(sourceLabel === undefined ? {} : { sourceLabel }),
    heartbeatMs,
    staleAfterMs,
    globalDiscovery,
  };
}
