import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveJsonMonoAgentConfig } from "@mono-agent/config";
import { acquireToolHistoryWriter, createInMemoryHistoryStore } from "@mono-agent/conversation";
import type { RuntimeRunOptions } from "@mono-agent/turn/host/types";
import { expect, it } from "vitest";
import { createConfiguredAgentResponderForApp, createConfiguredConversationHarness } from "../composition/configured-agent.js";
import { CONVERSATION_HISTORY_MCP_SERVER_NAME, CONVERSATION_HISTORY_TOOL_NAME } from "../request-tools/conversation-history.js";

it.each([
  { allow: ["*"], deny: [], enabled: undefined, present: true },
  { allow: ["ConversationHistory"], deny: [], enabled: undefined, present: true },
  { allow: ["conversation_history"], deny: [], enabled: undefined, present: true },
  { allow: [`mcp__${CONVERSATION_HISTORY_MCP_SERVER_NAME}__*`], deny: [], enabled: true, present: true },
  { allow: ["*"], deny: ["ConversationHistory"], enabled: undefined, present: false },
  { allow: ["*"], deny: ["conversation_history"], enabled: true, present: false },
  { allow: ["*"], deny: [`mcp__${CONVERSATION_HISTORY_MCP_SERVER_NAME}__*`], enabled: true, present: false },
  { allow: ["ConversationHistory"], deny: ["*"], enabled: true, present: false },
  { allow: ["SessionHistory", "Read"], deny: [], enabled: true, present: false },
  { allow: ["*"], deny: [], enabled: false, present: false },
])("configured tool policy $allow / $deny with continuity=$enabled exposes=$present", async ({ allow, deny, enabled, present }) => {
  const cwd = await mkdtemp(join(tmpdir(), "configured-conversation-history-"));
  try {
    await writeFile(join(cwd, "IDENTITY.md"), "You are a fictional fixture.");
    const config = resolveJsonMonoAgentConfig({ cwd, json: {
      runtime: { model: "openai-codex:gpt-5.5", session: { mode: "per-message", ...(enabled === undefined ? {} : { continuity: { enabled } }) } },
      context: { identityPath: "IDENTITY.md" }, tools: { allowedTools: allow, disallowedTools: deny },
    } });
    let received: RuntimeRunOptions | undefined;
    const harness = await createConfiguredConversationHarness({ config, cwd, env: {}, historyStore: createInMemoryHistoryStore(),
      runtime: { async run(_prompt, options) {
        received = options;
        const spec = (options.mcpServers as Record<string, { url: string }> | undefined)?.[CONVERSATION_HISTORY_MCP_SERVER_NAME];
        expect(spec !== undefined).toBe(present);
        if (spec) {
          const client = new Client({ name: "configured-fictional-client", version: "1.0.0" });
          try { await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
            expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([CONVERSATION_HISTORY_TOOL_NAME]);
          } finally { await client.close(); }
        }
        return { text: "Fictional answer." };
      } } });
    try {
      const result = await harness.run({ conversationId: "web:fiction", userMessage: "A fictional request.", abortSignal: new AbortController().signal });
      expect(result.failure).toBeUndefined(); expect(received).toBeDefined();
    } finally { await harness.dispose?.(); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it.each([true, false])("retrieves finalized current-run tool text only with an owned store (owned=%s)", async (owned) => {
  const cwd = await mkdtemp(join(tmpdir(), "configured-live-tool-evidence-"));
  const text = "Fictional cobalt tool output. ".repeat(1000);
  let evidenceRunId: string | undefined, actualRunId: string | undefined;
  let writerLease: Awaited<ReturnType<typeof acquireToolHistoryWriter>> | undefined;
  try {
    await writeFile(join(cwd, "IDENTITY.md"), "You are a fictional fixture.");
    const config = resolveJsonMonoAgentConfig({ cwd, json: {
      runtime: { model: "openai-codex:gpt-5.5", session: { mode: "per-message" } },
      context: { identityPath: "IDENTITY.md" }, tools: { allowedTools: ["ConversationHistory", "Read"] },
      artifacts: { dir: join(cwd, "artifacts") },
    } });
    // This is a durable storage assertion, not a test of the production 250 ms
    // foreground receipt ceiling. Share a 5 s fixture writer with the harness.
    writerLease = await acquireToolHistoryWriter({ root: join(cwd, "history"), artifactRoot: join(cwd, "artifacts", "tool-output"), continuityEnabled: true, persistenceCeilingMs: 5_000 });
    const harness = await createConfiguredConversationHarness({ config, cwd, env: {},
      ...(owned ? {} : { historyStore: createInMemoryHistoryStore() }),
      runtimeOptionsForRequest: ({ runId }) => { actualRunId = runId; return {}; },
      runtime: { async run(_prompt, options) {
        await options.toolLifecycleSink!({ phase: "invocation", toolCallId: "fictional-live-call", toolName: "Read", arguments: {} });
        await options.toolLifecycleSink!({ phase: "result", toolCallId: "fictional-live-call", toolName: "Read", state: "success", content: [{ type: "text", text }] });
        const spec = (options.mcpServers as Record<string, { url: string }>)[CONVERSATION_HISTORY_MCP_SERVER_NAME]!;
        const client = new Client({ name: "configured-live-evidence", version: "1.0.0" });
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
          const found = (await client.callTool({ name: CONVERSATION_HISTORY_TOOL_NAME, arguments: { query: "cobalt" } })).structuredContent as any;
          expect(found.items ?? []).toHaveLength(owned ? 1 : 0);
          if (owned) {
            const item = found.items[0]; evidenceRunId = item.runId;
            expect(item).toMatchObject({ kind: "tool", provenance: "tool", truncated: false, originalBytes: Buffer.byteLength(text) });
            let actual = "", args: any = { action: "get", recordId: item.recordId };
            do {
              const body = (await client.callTool({ name: CONVERSATION_HISTORY_TOOL_NAME, arguments: args })).structuredContent as any;
              expect(body.status).toBe("available"); actual += body.chunk;
              args = body.nextCursor ? body.navigation.nextActions[0].arguments : undefined;
            } while (args);
            expect(actual).toBe(text);
          }
        } finally { await client.close(); }
        return { text: "Fictional final answer." };
      } } });
    try {
      const result = await harness.run({ conversationId: "web:fiction", userMessage: "Inspect the fictional tool fixture.", abortSignal: new AbortController().signal });
      expect(result.failure).toBeUndefined(); if (owned) expect(evidenceRunId).toBe(actualRunId);
    } finally { await harness.dispose?.(); }
  } finally { await writerLease?.release(); await rm(cwd, { recursive: true, force: true }); }
}, 20_000);

it("does not upgrade the sidecar for a caller-supplied store with no configured continuity participant", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "configured-custom-history-"));
  try {
    await writeFile(join(cwd, "IDENTITY.md"), "Fictional fixture.");
    const config = resolveJsonMonoAgentConfig({ cwd, json: { runtime: { model: "openai-codex:gpt-5.5" }, context: { identityPath: "IDENTITY.md" }, artifacts: { dir: join(cwd, "artifacts") } } });
    const harness = await createConfiguredConversationHarness({ config, cwd, env: {}, historyStore: createInMemoryHistoryStore(),
      runtime: { async run(_prompt, options) {
        await options.toolLifecycleSink!({ phase: "invocation", toolCallId: "fictional-call", toolName: "Read", arguments: {} });
        await options.toolLifecycleSink!({ phase: "result", toolCallId: "fictional-call", toolName: "Read", state: "success", content: "Fictional tool result." });
        return { text: "Fictional answer." };
      } } });
    try { expect((await harness.run({ conversationId: "web:fiction", userMessage: "Fictional request.", abortSignal: new AbortController().signal })).failure).toBeUndefined(); }
    finally { await harness.dispose?.(); }
    const database = new DatabaseSync(join(cwd, "history", "tool-history", "tool-lifecycles.sqlite"), { readOnly: true });
    try { expect(database.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 2 }); }
    finally { database.close(); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it("respects explicit controller suppression instead of creating a standalone history endpoint", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "configured-suppressed-history-"));
  try {
    await writeFile(join(cwd, "IDENTITY.md"), "Fictional fixture.");
    const config = resolveJsonMonoAgentConfig({ cwd, json: { runtime: { model: "openai-codex:gpt-5.5" }, context: { identityPath: "IDENTITY.md" } } });
    let observed = false;
    const responder = await createConfiguredAgentResponderForApp({ config, cwd, env: {}, historyStore: createInMemoryHistoryStore(),
      runtime: { async run(_prompt, options) {
        observed = true;
        expect((options.mcpServers as Record<string, unknown> | undefined)?.[CONVERSATION_HISTORY_MCP_SERVER_NAME]).toBeUndefined();
        return { text: "Fictional answer." };
      } } }, { conversationHistoryExtension: null });
    await responder.respond({ conversationId: "web:fiction", text: "Fictional request.", abortSignal: new AbortController().signal }, { append: async () => {} });
    expect(observed).toBe(true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
