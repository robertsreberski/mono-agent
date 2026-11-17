/** Mode-specific tool-authored routing only; never apply to stored memory text. */
export function historyRoutingText(text: string, unified = false): string {
  return !unified ? text : text.replaceAll("RunHistory with {}", 'History with {scope:"runs"}')
    .replaceAll("RunHistory {}", 'History {scope:"runs"}')
    .replaceAll("ConversationHistory", 'History (scope "said")')
    .replaceAll("SessionHistory", 'History (scope "tools")')
    .replaceAll("RunHistory", 'History (scope "runs")');
}
