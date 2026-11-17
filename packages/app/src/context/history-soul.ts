import { readFile } from "node:fs/promises";
// Retirement validation, never aliases. Identifier boundaries avoid matching storage types.
const RETIRED = /(?<![A-Za-z0-9_])(?:mcp__mono-agent-conversation-history__ConversationHistory|mcp__mono-agent-session-history__SessionHistory|mcp__mono-agent-run-history__RunHistory|mcp__mono-agent-conversation-history__conversation_history|mcp__mono-agent-session-history__session_history|mcp__mono-agent-run-history__run_history|ConversationHistory|SessionHistory|RunHistory|conversation_history|session_history|run_history)(?![A-Za-z0-9_])/gu;
export async function historySoulReferences(path: string): Promise<readonly string[]> {
  const text = await readFile(path, "utf8");
  return text.split(/\r?\n/u).flatMap((line, index) => [...line.matchAll(RETIRED)].map(match =>
    `${path}:${index + 1}: removed history tool ${match[0]}; reword even prose mentions and use History with scope said, tools or runs. No aliases; files are never rewritten.`));
}
export async function assertCurrentHistorySoul(path: string | undefined): Promise<void> {
  if (path === undefined) return;
  const errors = await historySoulReferences(path);
  if (errors.length) throw new TypeError(errors.join("\n"));
}
