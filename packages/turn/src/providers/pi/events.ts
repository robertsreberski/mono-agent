import { normalizePiBuiltinToolParams } from "../../tools/pi-tools.js";

export function streamContentKey(streamEvent: any, fallback: any): any {
  return streamEvent?.contentIndex ?? fallback;
}

export function jsonSerializable(value: any, fallback: any = null): any {
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return fallback;
  }
}

function compactJsonPreview(value: any, { limit = 4000 } = {}) {
  let raw;
  try {
    raw = JSON.stringify(value || {});
  } catch {
    raw = String(value ?? "");
  }
  if (raw.length <= limit) return { value, truncated: false, originalLength: raw.length };
  return {
    value: {
      truncated: true,
      original_length: raw.length,
      preview: `${raw.slice(0, limit)}\n[truncated raw tool result]`,
    },
    truncated: true,
    originalLength: raw.length,
  };
}

export function compactToolRawResult(result: any, resultContent: any): {
    details_truncated?: boolean;
    content: {
        omitted: boolean;
        reason: string;
        original_length: number;
    };
    details: any;
    truncated?: boolean;
    original_length?: number;
    preview?: any;
} {
  const raw = compactJsonPreview(result);
  const details = compactJsonPreview(result?.details || {});
  return {
    ...(raw.truncated ? {
      truncated: true,
      original_length: raw.originalLength,
      preview: raw.value.preview,
    } : {}),
    content: {
      omitted: true,
      reason: "already represented by tool_result.content",
      original_length: String(resultContent || "").length,
    },
    details: details.value,
    ...(details.truncated ? { details_truncated: true } : {}),
  };
}

export function eventToolArgs(toolName: any, args: any, { cwd, toolLimits }: {
    cwd?: any;
    toolLimits?: any;
} = {}): any {
  return normalizePiBuiltinToolParams(toolName, args || {}, { cwd, toolLimits });
}

export function emitCaptured(events: any, onEvent: any, event: any): void {
  if (!event) return;
  events.push(event);
  onEvent?.(event);
}
