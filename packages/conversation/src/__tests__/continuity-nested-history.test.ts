import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ToolHistoryReader } from "../tool-history/reader.js";
import { ToolHistoryWriter } from "../tool-history/writer.js";
import { UncommittedTurnCollector, cancelledTurnReason } from "../harness/turn-continuity.js";
import { buildToolHistoryProjection } from "../tool-history/projection.js";

const tools = ["ConversationHistory", "conversation_history", "SessionHistory", "session_history", "RunHistory", "run_history"];
it.each(tools.flatMap((tool) => [tool, `mcp__fictional-history__${tool}`]))("omits nested %s results only on positive capture and preserves OFF runs sharing the writer", async (toolName) => {
  const root = await mkdtemp(join(tmpdir(), "continuity-nested-"));
  const writer = await ToolHistoryWriter.open({ root, continuityEnabled: true });
  try {
    const reader = new ToolHistoryReader(root), id = "web:fiction";
    const scope = { logicalConversationId: id, currentConversationId: id, currentRunId: "reading-run" };
    const text = "Fictional nested-body-cobalt evidence must not recursively accumulate.";
    for (const enabled of [true, false]) {
      const binding = { conversationId: id, logicalConversationId: id, runId: enabled ? "positive" : "legacy", isolated: false,
        ...(enabled ? { continuityEnabled: true as const } : {}) };
      const collector = new UncommittedTurnCollector(enabled), sink = collector.wrapToolLifecycleSink(writer.createSink(binding));
      await sink({ phase: "invocation", toolCallId: "fixture-call", toolName, arguments: { action: "search" } });
      const persisted = (await sink({ phase: "result", toolCallId: "fixture-call", state: "success", content: [{ type: "text", text }] }))!;
      collector.seal("cancelled");
      const account = collector.buildMessages({ outcome: "cancelled", reason: cancelledTurnReason(undefined, "cancelled"), runId: binding.runId,
        userMessage: "Fictional request.", liveInputs: [], settledAt: "2026-05-17T10:00:00.000Z" });
      expect(JSON.stringify(account).includes(text)).toBe(!enabled);
      const record = reader.get({ ...scope, recordId: persisted.recordId! });
      expect(record.chunk?.includes(text)).toBe(!enabled);
      expect(record.record?.truncated).toBe(enabled);
      if (enabled) expect(record.chunk).toContain("nested history-tool result omitted");
    }
    const projection = buildToolHistoryProjection(reader, id, id, "reading-run", new Set(), true)!;
    expect(projection.text).not.toContain(text);
    const found = reader.search({ ...scope, query: "nested-body-cobalt", limit: 10 });
    expect(found.items.map(({ runId }) => runId)).toEqual(["legacy"]);
  } finally { await writer.close(); await rm(root, { recursive: true, force: true }); }
});
