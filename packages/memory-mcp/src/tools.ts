import type { BujoMemoryStore } from "@mono-agent/memory-bujo";

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface MemoryToolDeps {
  readonly store: BujoMemoryStore;
}

export interface MemoryTools {
  recall(args: { query: string; limit?: number }): Promise<ToolResult>;
  capture(args: { text: string }): Promise<ToolResult>;
  note(args: { text: string }): Promise<ToolResult>;
}

function textResult(text: string, structured?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], ...(structured !== undefined && { structuredContent: structured }) };
}
function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(50, Math.max(1, Math.trunc(limit)));
}

export function createMemoryTools(deps: MemoryToolDeps): MemoryTools {
  return {
    async recall(args) {
      const topK = clampLimit(args.limit, 8);
      const hits = await deps.store.recall(args.query, { topK });
      if (hits.length === 0) return textResult(`No memories matched "${args.query}".`, { hits: [] });
      const text = hits.map((h) => `${h.score.toFixed(3)}  ${h.record.text}`).join("\n");
      return textResult(text, { hits: hits.map((h) => ({ id: h.record.id, score: h.score, text: h.record.text })) });
    },

    async capture(args) {
      const result = await deps.store.capture("mcp", args.text);
      if (result === undefined) {
        return errorResult("memory_capture requires the bujo tier (a chat LLM). This store has no LLM configured.");
      }
      return textResult(
        `Captured: ${result.actions} memory action(s), ${result.entities} entit${result.entities === 1 ? "y" : "ies"}.`,
        { actions: result.actions, entities: result.entities },
      );
    },

    async note(args) {
      const res = await deps.store.appendHostSummary("mcp", args.text);
      return textResult(`Noted to ${res.source}.`, { source: res.source, bytesWritten: res.bytesWritten });
    },
  };
}
