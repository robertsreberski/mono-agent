import { splitRequestScopedModelText } from "../mcp/request-scoped-mcp.js";
import type { HistoryScope } from "./history-policy.js";

export interface HistoryPresentation {
  readonly scope: HistoryScope;
  readonly scopes: readonly HistoryScope[];
}
export interface Action {
  readonly kind: string;
  readonly description: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}
interface Navigation {
  readonly guidance: string;
  readonly nextPage?: Readonly<Record<string, unknown>>;
  readonly nextActions: readonly Action[];
  readonly relatedTools?: readonly { readonly arguments: Readonly<Record<string, unknown>>; readonly description: string }[];
}
interface Result {
  readonly structuredContent: Record<string, unknown>;
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly isError?: boolean;
}

/** Only tool-authored navigation is rewritten. Retained evidence is never edited. */
export function presentHistoryResult(result: Result, presentation: HistoryPresentation) {
  const { scope, scopes } = presentation;
  const body = result.structuredContent;
  const old = body.navigation as Navigation | undefined;
  const args = (input: Readonly<Record<string, unknown>>) => {
    if (scope !== "runs") return { scope, ...input };
    const { action: _action, ...rest } = input;
    return { scope, action: input.runId === undefined ? "search" : "get", ...rest };
  };
  const text = (input: string) => input.replaceAll("ConversationHistory", 'History (scope "said")')
    .replaceAll("SessionHistory", 'History (scope "tools")').replaceAll("RunHistory", 'History (scope "runs")');
  const actions: Action[] = (old?.nextActions ?? []).map(action => ({ ...action, description: text(action.description), arguments: args(action.arguments) }));
  if (scope === "runs" && scopes.includes("tools")) {
    for (const related of old?.relatedTools ?? []) actions.push({ kind: "search", description: text(related.description), arguments: { scope: "tools", ...related.arguments } });
  }
  const navigation = { guidance: text(old?.guidance ?? String((body.error as { message?: string } | undefined)?.message ?? "Read-only historical evidence.")),
    ...(old?.nextPage === undefined ? {} : { nextPage: args(old.nextPage) }), nextActions: actions };
  const structuredContent = { ...body, scope, navigation };
  const header = [`History navigation (scope: ${scope}; tool-authored guidance):`, ...(body.notice === undefined ? [] : [String(body.notice)]), navigation.guidance,
    ...(navigation.nextPage === undefined ? [] : [`Next search page: ${JSON.stringify(navigation.nextPage)}`]),
    ...actions.map(action => `${action.description} Exact arguments: ${JSON.stringify(action.arguments)}`),
    ...(actions.length === 0 ? ["No follow-up History call is available."] : [])].join("\n");
  return { ...result, content: [...splitRequestScopedModelText(header), ...splitRequestScopedModelText(`${String(body.notice ?? "")}\n${JSON.stringify(structuredContent)}`)], structuredContent };
}
