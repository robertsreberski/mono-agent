import type { RuntimeEventLike } from "@worklab-ai/runtime-adapter";

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

export function translateMcpServers(input: Record<string, unknown> | undefined): readonly McpServerSpec[] {
  if (input === undefined) {
    return [];
  }
  const specs: McpServerSpec[] = [];
  for (const [name, raw] of Object.entries(input)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name) || !isObject(raw)) {
      continue;
    }
    const spec = specFromRecord(name, raw);
    if (spec !== undefined) {
      specs.push(spec);
    }
  }
  return specs;
}

function specFromRecord(name: string, value: Record<string, unknown>): McpServerSpec | undefined {
  const type = typeof value.type === "string" ? value.type : undefined;
  const command = typeof value.command === "string" ? value.command : undefined;
  if (type === "http" || (type === undefined && typeof value.url === "string" && command === undefined)) {
    if (typeof value.url !== "string") {
      return undefined;
    }
    return {
      kind: "streamable_http",
      name,
      options: stripUndefined({
        url: value.url,
        name,
        ...(isObject(value.headers) ? { requestInit: { headers: value.headers } } : {}),
      }),
    };
  }
  if (type === "sse") {
    if (typeof value.url !== "string") {
      return undefined;
    }
    return {
      kind: "sse",
      name,
      options: stripUndefined({ url: value.url, name }),
    };
  }
  if (type === "stdio" || command !== undefined) {
    if (command === undefined) {
      return undefined;
    }
    return {
      kind: "stdio",
      name,
      options: stripUndefined({
        command,
        ...(Array.isArray(value.args) ? { args: value.args } : {}),
        ...(isObject(value.env) ? { env: value.env } : {}),
        ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
        name,
      }),
    };
  }
  return undefined;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
