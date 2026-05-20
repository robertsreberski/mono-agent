const MCP_NAME_RE = /^[A-Za-z0-9_-]+$/;

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

export function translateMcpServersForCodex(
  input: Record<string, unknown> | undefined,
): Record<string, CodexMcpServerEntry> {
  if (input === undefined) {
    return {};
  }
  const out: Record<string, CodexMcpServerEntry> = {};
  for (const [name, raw] of Object.entries(input)) {
    if (!MCP_NAME_RE.test(name) || !isObject(raw)) {
      continue;
    }
    const entry = entryFromRecord(raw);
    if (entry !== undefined) {
      out[name] = entry;
    }
  }
  return out;
}

function entryFromRecord(value: Record<string, unknown>): CodexMcpServerEntry | undefined {
  if (typeof value.command === "string") {
    return {
      enabled: true,
      required: false,
      command: value.command,
      ...(Array.isArray(value.args) ? { args: value.args.filter((arg): arg is string => typeof arg === "string") } : {}),
      ...(isObject(value.env) ? { env: stringValueRecord(value.env) } : {}),
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    };
  }
  if (typeof value.url === "string") {
    return {
      enabled: true,
      required: false,
      url: value.url,
      ...(isObject(value.headers) ? { http_headers: stringValueRecord(value.headers) } : {}),
    };
  }
  return undefined;
}

function stringValueRecord(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
