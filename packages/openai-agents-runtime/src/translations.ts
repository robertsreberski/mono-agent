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
  const thoughtDelta = outputReasoningDelta(event);
  if (thoughtDelta !== undefined) {
    return {
      type: "assistant",
      message: { content: [{ type: "thinking", text: thoughtDelta }] },
      raw_event: event,
    };
  }
  const textDelta = outputTextDelta(event);
  if (textDelta !== undefined) {
    return {
      type: "assistant",
      message: { content: [{ type: "text", text: textDelta }] },
      raw_event: event,
    };
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

function outputTextDelta(event: OpenAIStreamEventLike): string | undefined {
  if (event.type !== "raw_model_stream_event" || !isObject(event.data)) {
    return undefined;
  }
  if (event.data.type !== "output_text_delta" || typeof event.data.delta !== "string" || event.data.delta.length === 0) {
    return undefined;
  }
  return event.data.delta;
}

function outputReasoningDelta(event: OpenAIStreamEventLike): string | undefined {
  if (event.type !== "raw_model_stream_event" || !isObject(event.data)) {
    return undefined;
  }

  const dataType = stringField(event.data, "type");
  if (dataType !== undefined && isReasoningDeltaEventType(dataType)) {
    const directDelta = stringField(event.data, "delta") ?? stringField(event.data, "text");
    if (directDelta !== undefined) {
      return directDelta;
    }
  }

  const nestedEvent = event.data.event;
  return responseReasoningDelta(nestedEvent) ?? chatCompletionReasoningDelta(nestedEvent);
}

function responseReasoningDelta(event: unknown): string | undefined {
  if (!isObject(event)) {
    return undefined;
  }
  const eventType = stringField(event, "type");
  if (eventType === undefined || !isReasoningDeltaEventType(eventType)) {
    return undefined;
  }
  return stringField(event, "delta") ?? stringField(event, "text");
}

function chatCompletionReasoningDelta(event: unknown): string | undefined {
  if (!isObject(event) || !Array.isArray(event.choices)) {
    return undefined;
  }
  for (const choice of event.choices) {
    if (!isObject(choice) || !isObject(choice.delta)) {
      continue;
    }
    const index = typeof choice.index === "number" ? choice.index : 0;
    if (index !== 0) {
      continue;
    }
    const reasoning = stringField(choice.delta, "reasoning");
    if (reasoning !== undefined) {
      return reasoning;
    }
  }
  return undefined;
}

function isReasoningDeltaEventType(type: string): boolean {
  return isReasoningEventType(type) && (type.endsWith(".delta") || type.endsWith("_delta"));
}

function isReasoningEventType(type: string): boolean {
  return type.includes("reasoning") || type.includes("thinking");
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  const candidate = value[field];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}
