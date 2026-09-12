import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadMonoAgentConfig } from "@mono-agent/config";
import { createMonoRuntime } from "@mono-agent/runtime-adapter";
import { buildSubagentsOptions, createSubagentsRuntimeExtension } from "../configured-agent.js";
import { createSubagentInstanceRegistry } from "../subagent-instances.js";
// @ts-expect-error Private kernel test seam; no new public tool export.
import { createAgentTool } from "../../../agent-runtime/src/agent/tools/agent-tool.js";
// @ts-expect-error Private kernel test seam; no new public tool export.
import { createAgentSendTool } from "../../../agent-runtime/src/agent/tools/agent-send-tool.js";
// @ts-expect-error Private provider seam uses the real Pi harness and durable repository.
import { generatePiNativeResponse } from "../../../agent-runtime/src/ai/providers/pi-native.js";

const piPath: string = fileURLToPath(new URL("../../../agent-runtime/node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url));
const { createModels, fauxProvider, fauxAssistantMessage, fauxText } = await import(piPath);

describe("app persistent subagent durable sessions", () => {
  it("creates and resumes a real Pi transcript through AgentSend after warm-session disposal, then retires it", async () => {
    const root = await mkdtemp(resolve(process.cwd(), ".durable-subagent-test-"));
    const owner = createMonoRuntime();
    try {
      const config = loadMonoAgentConfig({ cwd: root, env: {
        MONO_AGENT_MODEL: "openai-codex:gpt-5.5",
        MONO_AGENT_ALLOWED_TOOLS: "Agent,AgentSend",
        MONO_AGENT_IDENTITY_PATH: resolve(root, "IDENTITY.md"),
        MONO_AGENT_SUBAGENTS_JSON: JSON.stringify({ enabled: true, inline: { enabled: false }, instances: { root: resolve(root, "children") } }),
      } });
      const faux = fauxProvider({ provider: config.runtime.model.provider, models: [{ id: config.runtime.model.model }], tokensPerSecond: undefined });
      const models = createModels(); models.setProvider(faux.provider);
      const calls: Record<string, unknown>[] = [];
      const runtime = {
        run: async (prompt: string, options: Record<string, unknown>) => {
          calls.push(options);
          return await generatePiNativeResponse(prompt, { ...options, allowedTools: [],
            piResolvedModel: faux.getModel(), piResolvedModels: models, resolvePiApiKey: async () => "faux-key" });
        },
      };
      const retireSession = async (id: string, sessionsRoot: string) => owner.retireDurableSession!(id, sessionsRoot);
      const registry = createSubagentInstanceRegistry({ root: config.subagents!.instances!.root!, retireSession });
      const handle = await registry.open("conversation-1");
      const deps = { runtime: runtime as never, baseModel: config.runtime.model };
      const firstOptions = buildSubagentsOptions(config, deps, { conversationId: "conversation-1", runId: "parent-1", instances: handle })!;
      faux.setResponses([fauxAssistantMessage([fauxText("first-answer")])]);
      const first = await createAgentTool(firstOptions.subagents, { parentRunId: "parent-1", model: config.runtime.model }).execute("call-1", { persist: true, id: "critic", prompt: "first-task" });
      expect(first.details.subagent.status).toBe("ok");
      const record = (await handle.get("critic"))!;
      const transcript = async () => {
        const files = (await readdir(record.sessionsRoot, { recursive: true })).filter((file) => file.endsWith(".jsonl"));
        return (await Promise.all(files.map((file) => readFile(resolve(record.sessionsRoot, file), "utf8")))).join("\n");
      };
      const before = await transcript();
      expect(before).toContain("first-task");
      await owner.disposeSession!(record.sessionId);
      const restarted = createSubagentInstanceRegistry({ root: config.subagents!.instances!.root!, retireSession });
      const extension = createSubagentsRuntimeExtension(config, deps, restarted);
      const resumed = await extension({ request: { conversationId: "conversation-1" }, runId: "parent-2" } as never);
      let context: { messages: { role: string; content: unknown }[] } | undefined;
      faux.setResponses([(input: typeof context) => { context = input; return fauxAssistantMessage([fauxText("second-answer")]); }]);
      const second = await createAgentSendTool(resumed.runtimeOptions!.subagents, { parentRunId: "parent-2" }).execute("call-2", { id: "critic", message: "second-task" });
      expect(second.details.subagent.status).toBe("ok");
      expect(second.details.subagent.instance.turns).toBe(2);
      expect(calls[1]?.sessionId).toBe(calls[0]?.sessionId);
      expect(calls[1]?.piSessionsRoot).toBe(record.sessionsRoot);
      expect(calls[1]?.sessionKeepAlive).toBe(true);
      expect(calls[1]?.providerAttributionSessionId).toBeUndefined();
      const users = context!.messages.filter((message) => message.role === "user");
      expect(users).toHaveLength(2);
      expect(JSON.stringify(users[0])).toContain("first-task");
      expect(JSON.stringify(users[1])).toContain("second-task");
      expect((await transcript()).length).toBeGreaterThan(before.length);
      expect((await handle.get("critic"))!.usage.input).toBeGreaterThan(0);
      await createAgentSendTool(resumed.runtimeOptions!.subagents).execute("close", { id: "critic", close: true });
      expect((await handle.get("critic"))!.status).toBe("closed");
      expect(await transcript()).toBe("");
    } finally { await owner.disposeAllSessions?.(); await rm(root, { recursive: true, force: true }); }
  });
});
