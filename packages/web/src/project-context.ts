import type { WebConversationMarkerPart, WebRouteSelection } from "./contracts.js";

/**
 * Project and conversation-tag context injection for operator dispatches.
 *
 * A project's free-text CONTEXT is prepended, operator-facing text only and at
 * dispatch time, to every turn of every member conversation -- so existing
 * conversations pick it up on their next turn. It is never persisted in
 * messages, live-input text or submission hashes, and never shown as
 * part of the user's message.
 *
 * The envelope technique mirrors the harness's `composeHostTurnEnvelope`
 * (packages/agent-harness/src/context/turn-envelope.ts), which this package
 * must not modify: reserved delimiters are neutralised in prompt copies, never
 * in canonical storage.
 */

export interface ProjectContextSource {
  readonly name: string;
  readonly context: string;
  readonly tags?: readonly string[];
}

const PROJECT_CONTEXT_TAG = /<(\/?(?:project_context|conversation_tags|conversation_markers)\b[^>]*>)/giu;

/** Neutralise reserved delimiters in prompt copies, never canonical storage. */
export function neutraliseProjectContext(value: string): string {
  return value.replace(PROJECT_CONTEXT_TAG, "‹$1");
}

const escapeProjectAttribute = (value: string): string =>
  value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");

/** The operator-facing envelope for one project's context. */
export function composeProjectPrefix(name: string, context: string): string {
  return `<project_context name="${escapeProjectAttribute(name)}">\n${neutraliseProjectContext(context)}\n</project_context>`;
}

/**
 * Prepend the project envelope to operator-facing text.
 *
 * Without project prose or tags the text stays untouched. The stored and
 * displayed user message never passes through here.
 */
export function withProjectContext(
  operatorText: string,
  project: ProjectContextSource | undefined,
  markers: readonly WebConversationMarkerPart[] = [],
): string {

  const prefixes: string[] = [];
  if (project !== undefined && project.context.trim().length > 0) prefixes.push(composeProjectPrefix(project.name, project.context));
  if (project !== undefined && project.tags !== undefined && project.tags.length > 0) {
    prefixes.push(`<conversation_tags>${project.tags.map((name) => JSON.stringify(neutraliseProjectContext(name))).join(", ")}</conversation_tags>`);
  }
  if (markers.length > 0) prefixes.push(composeConversationMarkers(markers));
  return prefixes.length === 0 ? operatorText : `${prefixes.join("\n")}\n\n${neutraliseProjectContext(operatorText)}`;
}

/** Server-local time with an explicit offset and IANA zone; no user configuration. */
export function markerLocalTime(at: string): string {
  const date = new Date(at);
  const offset = -date.getTimezoneOffset();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const iso = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const local = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return `${iso} (${local} ${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
}

export function composeConversationMarkers(markers: readonly WebConversationMarkerPart[]): string {
  const route = (r: WebRouteSelection): string => `${r.model ?? "unknown"}${r.effort === null ? "" : ` (${r.effort})`}`;
  const lines = markers.map((marker) => {
    if (marker.kind === "model") return `model changed: ${route(marker.before)} → ${route(marker.after)}`;
    if (marker.kind === "project") return `project changed: ${marker.before === null ? "none" : JSON.stringify(marker.before.name)} → ${marker.after === null ? "none" : JSON.stringify(marker.after.name)}`;
    const minutes = Math.floor(marker.idleMs / 60_000);
    return `conversation resumed ${markerLocalTime(marker.at)} after ${Math.floor(minutes / 60)}h ${minutes % 60}m idle`;
  });
  return `<conversation_markers>\n${lines.map((line) => `- ${neutraliseProjectContext(line)}`).join("\n")}\n</conversation_markers>`;
}

export function formatQuotedTurn(quote: string, text: string): string {
  const blockquote = quote
    .trim()
    .split(/\r?\n/u)
    .map((line) => `> ${line}`)
    .join("\n");
  return `Quoted context:\n${blockquote}\n\n${text}`;
}
