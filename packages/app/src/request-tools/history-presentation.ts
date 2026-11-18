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
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
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
    return { scope, action: input.action === "inspect" || input.runId !== undefined ? "get" : "search", ...rest };
  };
  const actions: Action[] = (old?.nextActions ?? []).map(action => ({ ...action, description: action.description, arguments: args(action.arguments) }));
  if (scope === "runs" && scopes.includes("tools")) {
    for (const related of old?.relatedTools ?? []) actions.push({ kind: "search", description: related.description, arguments: { scope: "tools", ...related.arguments } });
  }
  const navigation = { guidance: old?.guidance ?? String((body.error as { message?: string } | undefined)?.message ?? "Read-only historical evidence."),
    ...(old?.nextPage === undefined ? {} : { nextPage: args(old.nextPage) }), nextActions: actions,
    ...(scope === "runs" && scopes.includes("tools") && old?.relatedTools?.length ? { relatedTools: (old?.relatedTools ?? []).map(related => ({tool: "History", description: related.description, arguments: {scope: "tools", ...related.arguments}})) } : {}) };
  const structuredContent = { ...body, ...(scope === "runs" ? { action: body.action === "inspect" ? "get" : "search" } : {}), scope, navigation };
  const header = [`History navigation (scope: ${scope}; tool-authored guidance):`,
    ...(scope === "said" && body.notice !== undefined ? [String(body.notice)] : []), navigation.guidance,
    ...(navigation.nextPage === undefined ? [] : [`Next search page: ${JSON.stringify(navigation.nextPage)}`]),
    ...actions.map((action, index) => `${scope === "said" ? "" : `${index + 1}. `}${action.description} Exact arguments: ${JSON.stringify(action.arguments)}`),
    ...(actions.length === 0 ? ["No follow-up History call is available."] : [])].join("\n");
  // Runs already renders separately bounded evidence sections. Preserve those
  // bytes AND block boundaries rather than serializing the entire overview.
  if (scope === "runs") return { ...result, content: [{ type: "text" as const, text: header }, ...result.content.slice(1)], structuredContent };
  // Match each legacy renderer: said splits navigation, tools has one header;
  // both split the notice + JSON envelope with the same 10,000-char algorithm.
  // Scoped metadata changes envelope offsets, never retained record chunks.
  return { ...result, content: [...(scope === "said" ? splitRequestScopedModelText(header) : [{ type: "text" as const, text: header }]),
    ...splitRequestScopedModelText(`${String(body.notice ?? "")}\n${JSON.stringify(structuredContent)}`)], structuredContent };
}
