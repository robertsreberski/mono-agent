import { readFile } from "node:fs/promises";
// Retirement validation, never aliases. Identifier boundaries avoid matching storage types.
const RETIRED = /(?<![A-Za-z0-9_])(?:mcp__mono-agent-conversation-history__ConversationHistory|mcp__mono-agent-session-history__SessionHistory|mcp__mono-agent-run-history__RunHistory|mcp__mono-agent-conversation-history__conversation_history|mcp__mono-agent-session-history__session_history|mcp__mono-agent-run-history__run_history|ConversationHistory|SessionHistory|RunHistory|conversation_history|session_history|run_history)(?![A-Za-z0-9_])/gu;
export function historyPromptReferences(text: string, source: string): readonly string[] {
  return text.split(/\r?\n/u).flatMap((line, index) => [...line.matchAll(RETIRED)].map(match =>
    `${source}:${index + 1}: removed history tool ${match[0]}; reword even prose mentions and use History with scope said, tools or runs. No aliases; files are never rewritten.`));
}
export async function historySoulReferences(path: string): Promise<readonly string[]> {
  return historyPromptReferences(await readFile(path, "utf8"), path);
}
export async function assertCurrentHistorySoul(path: string | undefined): Promise<void> {
  if (path === undefined) return;
  let errors: readonly string[];
  try {
    errors = await historySoulReferences(path);
  } catch (cause) {
    // Same diagnostic as the conversation file loader, before runtime setup.
    throw Object.assign(new Error("Unable to read soulPath.", { cause }), { code: "file_read_failed", details: { path } });
  }
  if (errors.length) throw new TypeError(errors.join("\n"));
}
