/**
 * Project context injection for operator dispatches.
 *
 * A project's free-text CONTEXT is prepended, operator-facing text only and at
 * dispatch time, to every turn of every member conversation -- so existing
 * conversations pick it up on their next turn. It is never persisted in
 * messages, turns, live-input text or submission hashes, and never shown as
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
}

const PROJECT_CONTEXT_TAG = /<(\/?project_context\b[^>]*>)/giu;

/** Neutralise both reserved delimiters in prompt copies, never canonical storage. */
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
 * Empty or whitespace-only context, or no membership, leaves the text
 * untouched. The stored and displayed user message never passes through here.
 */
export function withProjectContext(
  operatorText: string,
  project: ProjectContextSource | undefined,
): string {
  if (project === undefined || project.context.trim().length === 0) return operatorText;
  return `${composeProjectPrefix(project.name, project.context)}\n\n${neutraliseProjectContext(operatorText)}`;
}
