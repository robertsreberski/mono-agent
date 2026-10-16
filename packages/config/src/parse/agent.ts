








import type { MonoAgentConfig } from "../types.js";

import { MonoAgentConfigError } from "../errors.js";



import { jsonOptionalInteger,jsonRecord } from "./scalars.js";




const PEER_NAME = /^[a-z][a-z0-9-]{0,39}$/u;

const PEER_SOURCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

/** Reject ambiguous peer aliases, prototype keys, and duplicate target identities. */
export function readPeerConfig(value: unknown): MonoAgentConfig["peers"] {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MonoAgentConfigError("invalid_json", "peers must be an object.", { path: "peers" });
  }
  const result: Record<string, { sourceId: string }> = Object.create(null) as Record<string, { sourceId: string }>;
  const sources = new Set<string>();
  for (const [name, entry] of Object.entries(value)) {
    if (!PEER_NAME.test(name) || name.endsWith("-") || name === "__proto__" || name === "constructor") {
      throw new MonoAgentConfigError("invalid_json", `Invalid peer name '${name}'.`, { path: "peers" });
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)
      || Object.keys(entry).sort().join(",") !== "sourceId"
      || typeof (entry as { sourceId?: unknown }).sourceId !== "string"
      || !PEER_SOURCE_ID.test((entry as { sourceId: string }).sourceId)
      || (entry as { sourceId: string }).sourceId.includes("..")) {
      throw new MonoAgentConfigError("invalid_json", `Peer '${name}' requires only a valid sourceId.`, { path: `peers.${name}` });
    }
    const sourceId = (entry as { sourceId: string }).sourceId;
    if (sources.has(sourceId)) {
      throw new MonoAgentConfigError("invalid_json", `Duplicate peer sourceId '${sourceId}'.`, { path: `peers.${name}.sourceId` });
    }
    sources.add(sourceId);
    result[name] = { sourceId };
  }
  return result;
}

export const MAX_AGENT_NAME_LENGTH = 80;

export function readAgentName(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const name = raw.trim();
  const length = Array.from(name).length;
  if (length === 0 || length > MAX_AGENT_NAME_LENGTH || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new MonoAgentConfigError(
      "invalid_json",
      `agent.name must be a single-line name between 1 and ${MAX_AGENT_NAME_LENGTH} characters.`,
      { path: "agent.name", maxLength: MAX_AGENT_NAME_LENGTH },
    );
  }
  return name;
}

export function readConcurrencyConfig(value: unknown): MonoAgentConfig["concurrency"] | undefined {
  const concurrency = jsonRecord(value, "concurrency");
  if (concurrency === undefined) {
    return undefined;
  }
  const maxConcurrentRuns = jsonOptionalInteger(
    concurrency.maxConcurrentRuns,
    "concurrency.maxConcurrentRuns",
    { min: 1, max: 100_000 },
  );
  const maxPendingRuns = jsonOptionalInteger(
    concurrency.maxPendingRuns,
    "concurrency.maxPendingRuns",
    { min: 1, max: 100_000 },
  );
  if (maxConcurrentRuns === undefined && maxPendingRuns === undefined) {
    return undefined;
  }
  return {
    ...(maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns }),
    ...(maxPendingRuns === undefined ? {} : { maxPendingRuns }),
  };
}
