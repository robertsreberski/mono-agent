import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveJsonMonoAgentConfig } from "@mono-agent/config";
import { createInMemoryHistoryStore } from "@mono-agent/conversation";
import type { RuntimeRunOptions } from "@mono-agent/turn/host/types";
import { expect, it } from "vitest";
import { createConfiguredConversationHarness } from "../composition/configured-agent.js";
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
