import { parseMcpServers } from "@mono-agent/runtime-adapter";
import type { NormalizedMcpServer, RuntimeEventLike } from "@mono-agent/runtime-adapter";

export interface OpenAIStreamEventLike {
  readonly type?: string;
  readonly [key: string]: unknown;
}

export function translateOpenAIStreamEvent(event: OpenAIStreamEventLike): RuntimeEventLike | undefined {
  if (!isObject(event) || typeof event.type !== "string") {
    return undefined;
  }
  return { ...event };
}

export interface McpServerSpec {
  readonly kind: "streamable_http" | "sse" | "stdio";
  readonly name: string;
  readonly options: Record<string, unknown>;
}

/**
 * Projects the canonical MCP model onto the @openai/agents constructor specs.
 * Thin projector over {@link parseMcpServers}: http -> MCPServerStreamableHttp,
 * sse -> MCPServerSSE, stdio -> MCPServerStdio.
 */
export function translateMcpServers(input: Record<string, unknown> | undefined): readonly McpServerSpec[] {
  return parseMcpServers(input).map((server) => projectOpenAIMcpSpec(server));
}

function projectOpenAIMcpSpec(server: NormalizedMcpServer): McpServerSpec {
  if (server.transport === "sse") {
    return {
      kind: "sse",
      name: server.name,
      options: { name: server.name, ...(server.url === undefined ? {} : { url: server.url }) },
    };
  }
  if (server.transport === "stdio") {
    return {
      kind: "stdio",
      name: server.name,
      options: {
        name: server.name,
        ...(server.command === undefined ? {} : { command: server.command }),
        ...(server.args === undefined ? {} : { args: [...server.args] }),
        ...(server.env === undefined ? {} : { env: { ...server.env } }),
        ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
      },
    };
  }
  return {
    kind: "streamable_http",
    name: server.name,
    options: {
      name: server.name,
      ...(server.url === undefined ? {} : { url: server.url }),
      ...(server.headers === undefined ? {} : { requestInit: { headers: { ...server.headers } } }),
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
