import { SUPPORTED_PROTOCOL_VERSIONS as EXT_APPS_SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/ext-apps/app-bridge";

/** Revisions whose request/result schemas are intentionally supported by this host. */
export const MCP_APP_PROTOCOL_VERSIONS = ["2026-01-26", "2025-11-21"] as const;

export type McpAppProtocolVersion = (typeof MCP_APP_PROTOCOL_VERSIONS)[number];

/**
 * ext-apps 1.7.5 exposes its mutable negotiation list but initializes it with
 * only the latest revision. Both shipped revisions share the bridge surface we
 * implement, so extend that exact list before constructing any AppBridge. Its
 * initialize handler then returns the requested revision only when it is in
 * this explicit intersection, and otherwise falls back to the current one.
 */
export function enableMcpAppProtocolCompatibility(
  bridgeVersions: string[] = EXT_APPS_SUPPORTED_PROTOCOL_VERSIONS,
): readonly McpAppProtocolVersion[] {
  for (const version of MCP_APP_PROTOCOL_VERSIONS) {
    if (!bridgeVersions.includes(version)) bridgeVersions.push(version);
  }
  return MCP_APP_PROTOCOL_VERSIONS.filter((version) => bridgeVersions.includes(version));
}

export const EFFECTIVE_MCP_APP_PROTOCOL_VERSIONS = enableMcpAppProtocolCompatibility();

export function isMcpAppProtocolVersion(value: unknown): value is McpAppProtocolVersion {
  return typeof value === "string"
    && EFFECTIVE_MCP_APP_PROTOCOL_VERSIONS.includes(value as McpAppProtocolVersion);
}
