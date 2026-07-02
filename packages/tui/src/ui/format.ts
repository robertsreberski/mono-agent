/** Small pure formatters shared by the chat, replay, and status-bar surfaces. */

export function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
  return String(count);
}

export function formatUsd(usd: number): string {
  return usd >= 0.995 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`;
}

export function formatDurationMs(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return `${minutes}m${seconds > 0 ? ` ${seconds}s` : ""}`;
  }
  if (ms >= 1_000) {
    return `${(ms / 1_000).toFixed(1)}s`;
  }
  return `${Math.round(ms)}ms`;
}

/** Render an unknown payload (tool args/results) as compact single-or-multi-line text. */
export function previewValue(value: unknown, maxChars = 600): string {
  if (value === undefined) {
    return "";
  }
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, value !== null && typeof value === "object" ? 1 : undefined) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  text = text.trimEnd();
  if (text.length > maxChars) {
    return `${text.slice(0, maxChars)}…`;
  }
  return text;
}

export function lastLines(text: string, maxLines: number): string {
  const lines = text.split("\n");
  return lines.length <= maxLines ? text : lines.slice(lines.length - maxLines).join("\n");
}

export function formatClock(iso: string | undefined): string {
  if (iso === undefined) {
    return "";
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString();
}
