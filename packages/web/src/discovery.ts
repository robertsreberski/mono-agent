import { constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseEnv } from "node:util";

import { isLoopbackHost } from "@mono-agent/agent-contracts";
import { listTraceSources, mergeTraceSources, type TraceSourceListItem } from "@mono-agent/observability";

import {
  ACP_BRIDGE_DISCOVERY_SCHEMA,
  ACP_BRIDGE_SOURCE_SCHEMA,
  ACP_BRIDGE_VERSION,
  ACP_PROTOCOL_VERSION,
  type AcpBridgeDiscovery,
  type AcpBridgeSourceDescriptor,
} from "./contracts.js";

const BACKGROUND_SNAPSHOT_SCHEMA = "mono-agent.background-snapshot.v1";
const MAX_LOCAL_CONFIGURATION_BYTES = 1024 * 1024;

export interface DiscoverOperatorAgentsOptions {
  readonly registryDirs?: readonly string[];
  readonly staleAfterMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export type DiscoverAcpBridgeAgentsOptions = DiscoverOperatorAgentsOptions;

export interface DiscoveredOperatorAgent {
  readonly source: TraceSourceListItem;
  readonly baseUrl?: string;
  readonly apiKey?: string;
}

export function defaultTraceRegistryDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const override = env.MONO_AGENT_TRACE_REGISTRY_DIR?.trim();
  return resolve(override === undefined || override.length === 0
    ? resolve(homedir(), ".mono-agent", "trace-sources")
    : override);
}

export async function discoverOperatorAgents(
  options: DiscoverOperatorAgentsOptions = {},
): Promise<readonly DiscoveredOperatorAgent[]> {
  const env = options.env ?? process.env;
  const sources = await discoverTraceSources(options, env);
  return Promise.all(sources
    .filter((source) => source.health !== "stopped")
    .map(async (source): Promise<DiscoveredOperatorAgent> => {
      const baseUrl = operatorBaseUrlFromMetadata(source.metadata);
      const apiKey = baseUrl === undefined ? undefined : await resolveOperatorApiKey(source, env);
      return {
        source,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(apiKey === undefined ? {} : { apiKey }),
      };
    }));
}

/**
 * Discover local mono-agent ACP targets without exposing operator credentials,
 * endpoint details, configuration paths, or trace metadata.
 */
export async function discoverAcpBridgeAgents(
  options: DiscoverAcpBridgeAgentsOptions = {},
): Promise<AcpBridgeDiscovery> {
  const env = options.env ?? process.env;
  const sources = await discoverTraceSources(options, env);
  return {
    schema: ACP_BRIDGE_DISCOVERY_SCHEMA,
    bridgeVersion: ACP_BRIDGE_VERSION,
    protocolVersion: ACP_PROTOCOL_VERSION,
    sources: await Promise.all(sources
      .filter((source) => source.health !== "stopped")
      .map(async (source) => buildAcpSourceDescriptor(source))),
  };
}

interface PublishedAcpBridgeMetadata {
  readonly bridgeVersion: number;
  readonly protocolVersion: number;
  readonly installedVersion: string;
  readonly workspacePath: string;
}

async function buildAcpSourceDescriptor(
  source: TraceSourceListItem,
): Promise<AcpBridgeSourceDescriptor> {
  const warnings: string[] = [];
  const published = publishedAcpBridgeMetadata(source.metadata);
  const operatorAvailable = operatorBaseUrlFromMetadata(source.metadata) !== undefined;
  const workspacePath = await canonicalPath(
    published?.workspacePath ?? await fallbackWorkspacePath(source),
  );

  if (published === undefined) warnings.push("bridge_metadata_missing_or_invalid");
  if (published !== undefined && published.bridgeVersion !== ACP_BRIDGE_VERSION) {
    warnings.push("bridge_version_unsupported");
  }
  if (published !== undefined && published.protocolVersion !== ACP_PROTOCOL_VERSION) {
    warnings.push("protocol_version_unsupported");
  }
  if (!operatorAvailable) warnings.push("operator_endpoint_unavailable");
  if (published === undefined) warnings.push("workspace_resolved_from_configuration");

  return {
    schema: ACP_BRIDGE_SOURCE_SCHEMA,
    bridgeVersion: published?.bridgeVersion ?? 0,
    protocolVersion: published?.protocolVersion ?? 0,
    installedVersion: published?.installedVersion ?? "unknown",
    sourceId: source.sourceId,
    label: source.label,
    health: source.health,
    compatible: published !== undefined
      && published.bridgeVersion === ACP_BRIDGE_VERSION
      && published.protocolVersion === ACP_PROTOCOL_VERSION
      && operatorAvailable,
    workspace: { path: workspacePath, owner: "agent" },
    ownership: {
      configuration: "agent",
      workspace: "agent",
      mcp: "agent",
    },
    constraints: {
      promptContent: ["text"],
      clientMcp: false,
      clientFilesystem: false,
      clientTerminal: false,
      attachments: false,
      additionalDirectories: false,
    },
    warnings,
  };
}

function publishedAcpBridgeMetadata(
  metadata: Record<string, unknown> | undefined,
): PublishedAcpBridgeMetadata | undefined {
  const channels = record(metadata?.channels);
  const tui = record(channels?.tui);
  const acp = record(tui?.acpBridge);
  if (
    acp?.schema !== ACP_BRIDGE_SOURCE_SCHEMA
    || typeof acp.bridgeVersion !== "number"
    || !Number.isSafeInteger(acp.bridgeVersion)
    || acp.bridgeVersion < 1
    || typeof acp.protocolVersion !== "number"
    || !Number.isSafeInteger(acp.protocolVersion)
    || acp.protocolVersion < 1
    || typeof acp.installedVersion !== "string"
    || acp.installedVersion.trim().length === 0
    || typeof acp.workspacePath !== "string"
    || !isAbsolute(acp.workspacePath)
  ) return undefined;
  return {
    bridgeVersion: acp.bridgeVersion,
    protocolVersion: acp.protocolVersion,
    installedVersion: acp.installedVersion,
    workspacePath: resolve(acp.workspacePath),
  };
}

async function fallbackWorkspacePath(source: TraceSourceListItem): Promise<string> {
  if (source.configPath !== undefined) {
    try {
      const parsed = JSON.parse(await readOwnerRegularFile(source.configPath)) as {
        runtime?: { readonly workspace?: unknown };
      };
      const configured = parsed.runtime?.workspace;
      if (typeof configured === "string" && configured.trim().length > 0) {
        return resolve(dirname(source.configPath), configured);
      }
      return dirname(resolve(source.configPath));
    } catch {
      return dirname(resolve(source.configPath));
    }
  }
  return dirname(resolve(source.artifactDir));
}

async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

async function discoverTraceSources(
  options: DiscoverOperatorAgentsOptions,
  env: Readonly<Record<string, string | undefined>>,
): Promise<readonly TraceSourceListItem[]> {
  const registryDirs = normalizeRegistryDirs(options.registryDirs, env);
  const results = await Promise.all(registryDirs.map(async (registryDir) => listTraceSources({
    registryDir,
    ...(options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
  })));
  return mergeTraceSources(...results.map((result) => result.sources));
}

export function operatorBaseUrlFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  const channels = record(metadata?.channels);
  const operator = record(channels?.tui);
  if (operator?.kind !== "running" || typeof operator.baseUrl !== "string") return undefined;
  return isTrustedOperatorBaseUrl(operator.baseUrl) ? operator.baseUrl.replace(/\/+$/u, "") : undefined;
}

/** Only loopback operator endpoints are trusted; manifests are local files but not an SSRF authority. */
export function isTrustedOperatorBaseUrl(value: string): boolean {
  if (value.trim().length === 0) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && isLoopbackHost(url.hostname)
      && url.username.length === 0
      && url.password.length === 0;
  } catch {
    return false;
  }
}

async function resolveOperatorApiKey(
  source: TraceSourceListItem,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  const fromEnv = env.MONO_AGENT_TUI_API_KEY?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  if (source.configPath === undefined) return undefined;

  // Managed workers publish only the path/fingerprint of their selected
  // dotenv. Read the one exact key locally; never copy secret values into the
  // trace registry or browser-facing agent metadata.
  const dotenvPath = dotenvPathFromMetadata(source);
  if (dotenvPath !== undefined) {
    const fromDotenv = await readDotenvOperatorApiKey(dotenvPath);
    if (fromDotenv !== undefined) return fromDotenv;
  }

  try {
    const parsed = JSON.parse(await readOwnerRegularFile(source.configPath)) as { tui?: { apiKey?: unknown } };
    const key = typeof parsed.tui?.apiKey === "string" ? parsed.tui.apiKey.trim() : "";
    return key.length === 0 ? undefined : key;
  } catch {
    return undefined;
  }
}

function dotenvPathFromMetadata(source: TraceSourceListItem): string | undefined {
  if (source.configPath === undefined) return undefined;
  const snapshot = record(source.metadata?.backgroundSnapshot);
  if (
    snapshot?.schema !== BACKGROUND_SNAPSHOT_SCHEMA
    || typeof snapshot.configPath !== "string"
    || typeof snapshot.configFingerprint !== "string"
    || typeof snapshot.dotenvPath !== "string"
    || typeof snapshot.dotenvFingerprint !== "string"
    || snapshot.configFingerprint.length === 0
    || snapshot.dotenvFingerprint.length === 0
    || !isAbsolute(snapshot.configPath)
    || !isAbsolute(snapshot.dotenvPath)
    || resolve(snapshot.configPath) !== resolve(source.configPath)
  ) return undefined;
  return resolve(snapshot.dotenvPath);
}

async function readDotenvOperatorApiKey(path: string): Promise<string | undefined> {
  try {
    const parsed = parseEnv(await readOwnerRegularFile(path));
    const key = parsed.MONO_AGENT_TUI_API_KEY?.trim();
    return key === undefined || key.length === 0 ? undefined : key;
  } catch {
    // Discovery is best effort. A keyed agent will surface as unavailable
    // rather than weakening the local-file checks or leaking parser details.
    return undefined;
  }
}

async function readOwnerRegularFile(path: string): Promise<string> {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!info.isFile() || (currentUid !== undefined && info.uid !== currentUid)) {
      throw new Error("Local agent configuration is not an owner-owned regular file.");
    }
    if (info.size > MAX_LOCAL_CONFIGURATION_BYTES) {
      throw new Error("Local agent configuration exceeds its size limit.");
    }
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

function normalizeRegistryDirs(
  values: readonly string[] | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const requested = values !== undefined && values.length > 0 ? values : [defaultTraceRegistryDir(env)];
  return [...new Set(requested.map((value) => resolve(value)))];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
