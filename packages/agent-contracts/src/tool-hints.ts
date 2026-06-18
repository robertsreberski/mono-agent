/**
 * Maps a tool name to a short, friendly, present-tense activity hint for chat
 * channels (e.g. "Searching the web…"). Shared so every channel renders the
 * same hint for the same tool. Returns a generic "Working…"-style hint for
 * unknown tools so a channel always has something natural to show — never a
 * raw tool name and never reasoning text.
 */

const BUILTIN_HINTS: Readonly<Record<string, string>> = {
  websearch: "Searching the web…",
  webfetch: "Reading a page…",
  bash: "Running a command…",
  read: "Reading files…",
  write: "Writing a file…",
  edit: "Editing a file…",
  glob: "Looking through files…",
  grep: "Searching the workspace…",
};

// Keyword hints matched against the tool segment of MCP tool names
// (mcp__server__tool) so integrations get a natural hint without enumerating
// every tool. Ordered: first match wins.
const KEYWORD_HINTS: ReadonlyArray<readonly [test: RegExp, hint: string]> = [
  [/calendar|event|gcal/u, "Checking the calendar…"],
  [/mail|gmail|email/u, "Checking email…"],
  [/search|find|query|lookup/u, "Searching…"],
  [/todo|task|reminder/u, "Checking your tasks…"],
  [/note|draft|doc/u, "Looking through notes…"],
  [/slack|message|chat|send/u, "Checking messages…"],
  [/file|read|fetch|get|list/u, "Looking something up…"],
  [/web|browse|http|url/u, "Browsing the web…"],
];

export function toolHintFor(toolName: string): string {
  const raw = typeof toolName === "string" ? toolName.trim() : "";
  if (raw.length === 0) {
    return "Working…";
  }

  // mcp__server__tool → use the tool segment (last) for matching + humanizing.
  const segment = raw.startsWith("mcp__")
    ? (raw.split("__").pop() ?? raw)
    : raw;
  const normalized = segment.toLowerCase();

  const builtin = BUILTIN_HINTS[normalized];
  if (builtin !== undefined) {
    return builtin;
  }
  for (const [test, hint] of KEYWORD_HINTS) {
    if (test.test(normalized)) {
      return hint;
    }
  }
  return "Working…";
}
