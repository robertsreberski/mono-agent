const PREVIEW_MAX = 72;
const PATH_LIKE = /^(?:\.{0,2}\/|~\/|\/)?[\p{L}\p{N}._@+-]+(?:\/[\p{L}\p{N}._@+-]+)+$/u;
const PREVIEW_KEYS = ["file_path", "path", "filePath", "pattern", "command", "query", "url", "prompt", "description", "name"] as const;

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized || undefined;
};

/** A bare leading directory change only: do not rewrite a command's later cd or shell pipeline. */
function leadingCd(command: string): { command: string; directory?: string } {
  const match = /^cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&]+))\s*(?:&&|;)\s*(.+)$/u.exec(command);
  if (!match) return { command };
  return { command: match[4]!, directory: match[1] ?? match[2] ?? match[3] };
}

export function shortenPreview(value: string, kind: "command" | "path" | "text", max = PREVIEW_MAX): string {
  const normalized = text(value) ?? "";
  if (normalized.length <= max) return normalized;
  if (kind === "command") {
    const head = Math.ceil((max - 1) / 2);
    return `${normalized.slice(0, head)}…${normalized.slice(-(max - 1 - head))}`;
  }
  return kind === "path" ? `…${normalized.slice(-(max - 1))}` : `${normalized.slice(0, max - 1)}…`;
}

export interface ToolPreview {
  readonly full: string;
  readonly preview: string;
  readonly location?: string;
  readonly locationLabel?: string;
  readonly command: boolean;
}

/** Shared foreground/background preview; background progress supplies an already-redacted string. */
export function formatToolPreview(toolName: string, args: unknown, workdir?: string, max = PREVIEW_MAX): ToolPreview | undefined {
  const isCommand = toolName === "Bash" || toolName === "Exec";
  const record = args !== null && typeof args === "object" && !Array.isArray(args)
    ? args as Record<string, unknown> : undefined;
  const selected = isCommand && record
    ? toolName === "Bash" ? text(record.command) : text(record.executable) === undefined ? undefined
      : [text(record.executable)!, ...(Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === "string") : [])]
        .map((arg) => /[^\w@%+=:,./-]/u.test(arg) ? `'${arg.replaceAll("'", "'\\''")}'` : arg).join(" ")
    : undefined;
  const named = record && !isCommand
    ? PREVIEW_KEYS.map((key) => text(record[key])).find((value) => value !== undefined)
      ?? Object.values(record).map(text).find((value) => value !== undefined)
    : undefined;
  const original = selected ?? named ?? (typeof args === "string" ? text(args) : undefined);
  if (original === undefined) return undefined;
  const stripped = isCommand ? leadingCd(original) : { command: original, directory: undefined };
  const full = stripped.command;
  const location = isCommand ? text(workdir ?? record?.workdir) ?? stripped.directory : undefined;
  const locationLabel = location?.replace(/\/+$/u, "").split("/").pop() || location;
  const kind = isCommand ? "command" : PATH_LIKE.test(full) && !/^[\d/]+$/u.test(full) ? "path" : "text";
  return { full, preview: shortenPreview(full, kind, max), ...(location ? { location, locationLabel } : {}), command: isCommand };
}

/** Existing callers without a tool name preserve the key-selection behavior. */
export function toolArgumentPreview(args: unknown): string | undefined {
  return formatToolPreview("", args)?.preview;
}
