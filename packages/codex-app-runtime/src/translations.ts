import { parseMcpServers } from "@worklab-ai/runtime-adapter";
import type { NormalizedMcpServer } from "@worklab-ai/runtime-adapter";

export interface CodexMcpServerEntry {
  readonly enabled: true;
  readonly required: false;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly url?: string;
  readonly http_headers?: Record<string, string>;
}

/**
 * Projects the canonical MCP model onto Codex app-server `mcp_servers` entries.
 * Thin projector over {@link parseMcpServers}: stdio -> command entry,
 * http/sse -> url entry with `http_headers`. Each entry is keyed by server name.
 */
export function translateMcpServersForCodex(
  input: Record<string, unknown> | undefined,
): Record<string, CodexMcpServerEntry> {
  const out: Record<string, CodexMcpServerEntry> = {};
  for (const server of parseMcpServers(input)) {
    out[server.name] = projectCodexMcpEntry(server);
  }
  return out;
}

function projectCodexMcpEntry(server: NormalizedMcpServer): CodexMcpServerEntry {
  if (server.transport === "stdio") {
    return {
      enabled: true,
      required: false,
      ...(server.command === undefined ? {} : { command: server.command }),
      ...(server.args === undefined ? {} : { args: [...server.args] }),
      ...(server.env === undefined ? {} : { env: { ...server.env } }),
      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
    };
  }
  return {
    enabled: true,
    required: false,
    ...(server.url === undefined ? {} : { url: server.url }),
    ...(server.headers === undefined ? {} : { http_headers: { ...server.headers } }),
  };
}
