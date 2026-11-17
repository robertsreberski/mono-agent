import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createConversationHarness, createToolPolicy, loadToolPolicyFromJsonFile, ToolHistoryWriter } from "../index.js";
import { renderToolHistoryProjection } from "../tool-history/projection.js";

const names = ([['ConversationHistory', 'conversation_history', 'conversation', 'said'], ['SessionHistory', 'session_history', 'session', 'tools'], ['RunHistory', 'run_history', 'run', 'runs']] as const)
  .flatMap(([name, snake, server, scope]) => [name, snake, `mcp__mono-agent-${server}-history__${name}`, `mcp__mono-agent-${server}-history__${snake}`, `mcp__mono-agent-${server}-history__*`].map(name => ({ name, scope })));
it.each(names)("refuses retired $name in constructed and JSON-loaded policies", async ({ name, scope }) => {
  const root = await mkdtemp(join(tmpdir(), "history-retirement-"));
  try {
    for (const field of ["allowedTools", "disallowedTools"]) {
      const policy = { [field]: [name] };
      expect(() => createToolPolicy(policy)).toThrow(`${field}[0] lists removed tool ${name}`);
      const file = join(root, "policy.json");
      await writeFile(file, JSON.stringify(policy));
      await expect(loadToolPolicyFromJsonFile(file)).rejects.toThrow(`scope:"${scope}"`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("preserves unrelated external namespaces and unknown names", () => {
  expect(createToolPolicy({ allowedTools: ["mcp__other__History", "mcp__other__ConversationHistory", "UnknownTool"] }).allowedTools).toHaveLength(3);
});
it.each(["sessionHistoryAvailable", "conversationHistoryAvailable", "unifiedHistory"])("refuses the removed public option %s", key => {
  expect(() => createConversationHarness({ identityPath: "/nonexistent", toolHistory: { [key]: false } } as never)).toThrow(`${key} was removed`);
});
it("rejects legacy availability even when there is no projection", () => {
  expect(() => renderToolHistoryProjection(undefined, { conversationHistory: false, sessionHistory: false } as never)).toThrow(/legacy HistoryToolAvailability shape was removed/);
});
it("refuses removed run binding options at all public writer entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "history-binding-"));
  const writer = await ToolHistoryWriter.open({ root });
  const binding = { conversationId: "fictional", logicalConversationId: "fictional", runId: "old", isolated: false, unifiedHistory: false };
  try {
    expect(() => writer.createSink(binding)).toThrow(/unifiedHistory was removed/);
    await expect(writer.persist(binding, { phase: "invocation", toolCallId: "call", toolName: "Read", arguments: {} })).rejects.toThrow(/unifiedHistory was removed/);
    await expect(writer.finishRun(binding, "completed")).rejects.toThrow(/unifiedHistory was removed/);
  } finally { await writer.close(); await rm(root, { recursive: true, force: true }); }
});
