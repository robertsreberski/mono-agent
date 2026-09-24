import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { resolveJsonMonoAgentConfig } from "@mono-agent/config";
import { createMonoRuntime, createSandboxPolicy } from "@mono-agent/runtime-adapter";
import { createSubagentRecoveryAccess } from "../subagent-recovery-access.js";
import { buildSubagentsOptions, createSubagentsRuntimeExtension } from "../configured-agent.js";
import { createSubagentInstanceRegistry, subagentConversationRoot } from "../subagent-instances.js";
// @ts-expect-error Private kernel test seam; no new public tool export.
import { createAgentTool } from "../../../agent-runtime/src/agent/tools/agent-tool.js";
// @ts-expect-error Private kernel test seam; no new public tool export.
import { createAgentManageTool } from "../../../agent-runtime/src/agent/tools/agent-manage-tool.js";
// @ts-expect-error Private provider seam uses the real Pi harness and durable repository.
import { generatePiNativeResponse } from "../../../agent-runtime/src/ai/providers/pi-native.js";

const piPath: string = fileURLToPath(new URL("../../../agent-runtime/node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url));
const { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, getCurrentTools } = await import(piPath);

describe("app persistent subagent durable sessions", () => {
  it.each(["loss", "late-timeout"])("G07: configured foreground Pi %s requires native continuity before ordinary resume", async (mode) => {
    const root = await mkdtemp(resolve(process.cwd(), "node_modules/.foreground-recovery-")); const owner = createMonoRuntime();
    let deliver!: () => void; const delivery = new Promise<void>((done) => { deliver = done; });
    let nativeReturned = false;
    try {
      const config = resolveJsonMonoAgentConfig({ cwd: root, json: {
        runtime: { model: "openai-codex:gpt-5.5" },
        context: { identityPath: resolve(root, "IDENTITY.md") },
        tools: { allowedTools: ["Agent", "AgentManage"] },
        subagents: { enabled: true, timeoutMs: mode === "late-timeout" ? 1500 : 10_000,
          inline: { enabled: false }, instances: { root: resolve(root, "children") } },
      } });
      const faux = fauxProvider({ provider: config.runtime.model.provider, models: [{ id: config.runtime.model.model }], tokensPerSecond: undefined });
      const models = createModels(); models.setProvider(faux.provider);
      const calls: Record<string, unknown>[] = [];
      const runtime = { recoverSession: owner.recoverSession!.bind(owner), run: async (prompt: string, options: Record<string, unknown>) => {
        calls.push(options);
        const first = calls.length === 1;
        // Fault at the real native handoff: execute outside the requested epoch,
        // rather than fabricating a retained/lost registry status or result id.
        const result = await generatePiNativeResponse(prompt, { ...options, allowedTools: [],
          ...(first && mode === "loss" ? { sessionId: `outside-${String(options.sessionId)}` } : {}),
          piResolvedModel: faux.getModel(), piResolvedModels: models, resolvePiApiKey: async () => "faux-key" });
        nativeReturned = true;
        if (first && mode === "late-timeout") await delivery; // Native answer exists; host delivery ignores abort.
        return result;
      } };
      const access = { workspace: root, readableRoots: [], sandboxPolicy: createSandboxPolicy({ root }) };
      const registry = createSubagentInstanceRegistry({ root: resolve(root, "children"),
        ...createSubagentRecoveryAccess({ privateRoots: async () => [resolve(root, "children")], hostAccess: () => access }),
        retireSession: async (id, sessionsRoot) => owner.retireDurableSession!(id, sessionsRoot),
      });
      const handle = await registry.open("foreground-recovery");
      const options = buildSubagentsOptions(config, { runtime: runtime as never, baseModel: config.runtime.model },
        { conversationId: "foreground-recovery", runId: "parent", instances: handle })!.subagents;
      const context = { model: config.runtime.model, recoveryAccess: access };
      const agent = createAgentTool(options, context); const send = createAgentManageTool(options, context);
      expect(options).not.toHaveProperty("backgroundSubagentController");
      faux.setResponses([fauxAssistantMessage([fauxText("first native answer is not continuation authority")])]);
      const failed = await agent.execute("foreground", { id: "critic", persist: true, prompt: "first foreground task" });
      expect(nativeReturned).toBe(true); expect(failed.details.jobId).toBeUndefined();
      expect(failed.details.subagent.status).toBe(mode === "loss" ? "failed" : "timeout");
      const original = (await handle.get("critic"))!;
      if (mode === "late-timeout") {
        expect(original.status).toBe("running");
        const held = await send.execute("inspect-pending", { id: "critic", inspect: true });
        expect(held.details.recovery).toMatchObject({ status: "held", recovery: { continuity: "unknown" } });
        await expect(send.execute("close-pending", { id: "critic", close: true })).rejects.toThrow(/busy/);
        await expect(send.execute("replay-pending", { id: "critic", message: "do not replay" })).rejects.toThrow();
        expect(calls).toHaveLength(1);
        deliver(); await vi.waitFor(async () => expect((await handle.get("critic"))?.status).toBe("idle"), { timeout: 3000 });
      }
      const inspected = await send.execute("inspect-settled", { id: "critic", inspect: true });
      const persisted = JSON.parse(await readFile(resolve(subagentConversationRoot(resolve(root, "children"), "foreground-recovery"), "instances.json"), "utf8"))[0];
      expect(persisted.ownerLink).toBeUndefined(); expect(persisted.ownerReceipt).toBeUndefined();
      expect(calls[0]?.ownedForegroundProcesses).toBeUndefined();
      // Remaining-budget clamp: allow a few ms of scheduler drift before the child starts.
      const expectedLimit = mode === "late-timeout" ? 1350 : 9000;
      const bashTimeoutMs = (calls[0]?.toolLimits as { readonly bashTimeoutMs?: number } | undefined)?.bashTimeoutMs;
      expect(bashTimeoutMs).toBeLessThanOrEqual(expectedLimit);
      expect(bashTimeoutMs).toBeGreaterThanOrEqual(expectedLimit - 250);
      if (mode === "late-timeout") {
        expect(inspected.details.recovery).toMatchObject({ status: "ready", resumable: true,
          recovery: { reason: "timeout", continuity: "retained", certifiedTimeout: true } });
        expect(inspected.details.recovery.ack).toBeUndefined();
        let context: { messages: { role: string; content: unknown }[] } | undefined;
        faux.setResponses([(input: typeof context) => { context = input; return fauxAssistantMessage([fauxText("continued same child")]); }]);
        const resumed = await send.execute("resume", { id: "critic", message: "check unfinished work" });
        expect(resumed.details.subagent.status).toBe("ok");
        expect(calls[1]?.sessionId).toBe(calls[0]?.sessionId);
        expect(JSON.stringify(context?.messages)).toContain("first foreground task");
        expect(JSON.stringify(context?.messages)).toContain("check unfinished work");
        expect(JSON.stringify(context?.messages)).toContain("previous turn stopped at its timeout");
        await send.execute("close-resumed", { id: "critic", close: true });
      } else {
        expect(inspected.details).toMatchObject({ executed: false, recovery: { status: "structured_job_recovery_unavailable",
          recovery: { reason: "session_continuity_lost", continuity: "lost" } } });
        expect(inspected.details.recovery.ack).toBeUndefined(); expect(inspected.details.recovery.jobId).toBeUndefined();
        await expect(send.execute("replay-settled", { id: "critic", message: "must not infer retained context" })).rejects.toThrow("subagent_recovery_required");
        expect(calls).toHaveLength(1);
        await send.execute("close", { id: "critic", close: true });
        let replacementContext: unknown;
        faux.setResponses([(input: unknown) => { replacementContext = input; return fauxAssistantMessage([fauxText("explicit replacement succeeded")]); }]);
        const replacement = await agent.execute("replacement", { id: "critic", persist: true, prompt: "explicitly supplied fresh context" });
        expect(replacement.details.subagent.status).toBe("ok"); expect(calls).toHaveLength(2);
        expect(JSON.stringify(replacementContext)).toContain("explicitly supplied fresh context");
        expect(JSON.stringify(replacementContext)).not.toContain("first foreground task");
        expect((await handle.get("critic"))!.incarnation).not.toBe(original.incarnation);
        await send.execute("close-replacement", { id: "critic", close: true });
      }
    } finally { deliver(); await owner.disposeAllSessions?.(); await rm(root, { recursive: true, force: true }); }
  }, 15_000);

  it("fails closed when native receipt capture throws after a foreground answer", async () => {
    const root = await mkdtemp(resolve(process.cwd(), "node_modules/.foreground-capture-failure-"));
    const owner = createMonoRuntime();
    try {
      const config = resolveJsonMonoAgentConfig({ cwd: root, json: {
        runtime: { model: "openai-codex:gpt-5.5" }, context: { identityPath: resolve(root, "IDENTITY.md") },
        tools: { allowedTools: ["Agent", "AgentManage"] },
        subagents: { enabled: true, instances: { root: resolve(root, "children") } },
      } });
      const faux = fauxProvider({ provider: config.runtime.model.provider, models: [{ id: config.runtime.model.model }], tokensPerSecond: undefined });
      const models = createModels(); models.setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage([fauxText("Pi answered before capture failed")])]);
      let answered = false;
      const runtime = { recoverSession: owner.recoverSession!.bind(owner), run: async (prompt: string, options: Record<string, unknown>) => {
        expect(options.sessionRecovery).toBeDefined();
        const result = await generatePiNativeResponse(prompt, { ...options, allowedTools: [],
          piResolvedModel: faux.getModel(), piResolvedModels: models, resolvePiApiKey: async () => "faux-key" });
        expect(result.text).toContain("Pi answered before capture failed");
        answered = true;
        // Simulate the established Pi capture/close throw path after a genuine answer.
        throw new Error("native receipt capture failed");
      } };
      const registry = createSubagentInstanceRegistry({ root: resolve(root, "children"), retireSession: async (id, sessionsRoot) => owner.retireDurableSession!(id, sessionsRoot) });
      const handle = await registry.open("capture-failure");
      const subagents = buildSubagentsOptions(config, { runtime: runtime as never, baseModel: config.runtime.model },
        { conversationId: "capture-failure", runId: "parent", instances: handle })!.subagents;
      const first = await createAgentTool(subagents, { model: config.runtime.model }).execute("capture", { persist: true, id: "critic", prompt: "work" });
      expect(answered).toBe(true);
      expect(first.details.subagent.status).toBe("failed");
      expect((await handle.get("critic"))?.recovery).toMatchObject({ continuity: "unknown" });
      await expect(createAgentManageTool(subagents, { model: config.runtime.model }).execute("unsafe", { id: "critic", message: "continue" })).rejects.toThrow("subagent_recovery_required");
    } finally { await owner.disposeAllSessions?.(); await rm(root, { recursive: true, force: true }); }
  });
  it("creates and resumes a real Pi transcript through AgentManage after warm-session disposal, then retires it", async () => {
    const root = await mkdtemp(resolve(process.cwd(), ".durable-subagent-test-"));
    const owner = createMonoRuntime();
    try {
      const config = resolveJsonMonoAgentConfig({ cwd: root, json: {
        runtime: { model: "openai-codex:gpt-5.5" },
        context: { identityPath: resolve(root, "IDENTITY.md") },
        tools: { allowedTools: ["Agent", "AgentManage"] },
        subagents: { enabled: true, inline: { enabled: false }, instances: { root: resolve(root, "children") } },
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
      const second = await createAgentManageTool(resumed.runtimeOptions!.subagents, { parentRunId: "parent-2" }).execute("call-2", { id: "critic", message: "second-task" });
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
      await createAgentManageTool(resumed.runtimeOptions!.subagents).execute("close", { id: "critic", close: true });
      expect((await handle.get("critic"))!.status).toBe("closed");
      expect(await transcript()).toBe("");
    } finally { await owner.disposeAllSessions?.(); await rm(root, { recursive: true, force: true }); }
  });
  it.each(["single", "mixed", "preceding-error"])("AskParent terminates %s and AgentManage resumes the same durable transcript after restart", async (batch) => {
    const root = await mkdtemp(resolve(process.cwd(), ".durable-subagent-test-"));
    const owner = createMonoRuntime();
    try {
      const config = resolveJsonMonoAgentConfig({ cwd: root, json: {
        runtime: { model: "openai-codex:gpt-5.5" },
        context: { identityPath: resolve(root, "IDENTITY.md") },
        tools: { allowedTools: ["Agent", "AgentManage"] },
        subagents: { enabled: true, inline: { enabled: false }, instances: { root: resolve(root, "children") } },
      } });
      const faux = fauxProvider({ provider: config.runtime.model.provider, models: [{ id: config.runtime.model.model }], tokensPerSecond: undefined });
      const models = createModels(); models.setProvider(faux.provider);
      const calls: Record<string, unknown>[] = [];
      const runtime = {
        run: async (prompt: string, options: Record<string, unknown>) => {
          calls.push(options);
          return await generatePiNativeResponse(prompt, { ...options,
            piResolvedModel: faux.getModel(), piResolvedModels: models, resolvePiApiKey: async () => "faux-key" });
        },
      };
      const retireSession = async (id: string, sessionsRoot: string) => owner.retireDurableSession!(id, sessionsRoot);
      const registry = createSubagentInstanceRegistry({ root: config.subagents!.instances!.root!, retireSession });
      const handle = await registry.open("conversation-1");
      const deps = { runtime: runtime as never, baseModel: config.runtime.model };
      const firstOptions = buildSubagentsOptions(config, deps, { conversationId: "conversation-1", runId: "parent-1", instances: handle })!;
      const events: any[] = [];
      let afterQuestionCalls = 0;
      faux.setResponses([fauxAssistantMessage([
        ...(batch === "preceding-error" ? [fauxToolCall("Read", { file_path: "missing-before-question" })] : []),
        fauxToolCall("AskParent", { question: "Which scope?", options: ["Small", "Large"] }),
        ...(batch === "single" ? [] : [fauxToolCall("Read", { file_path: "must-not-be-read" })]),
      ]), () => { afterQuestionCalls++; return fauxAssistantMessage([fauxText("unexpected continuation")]); }]);
      const first = await createAgentTool(firstOptions.subagents, { parentRunId: "parent-1", model: config.runtime.model, onEvent: (event: any) => events.push(event) }).execute("call-1", { persist: true, id: "critic", prompt: "first-task" });
      expect(first.details.subagent.status).toBe("awaiting_reply");
      expect(first.details.subagent.question).toEqual({ question: "Which scope?", options: ["Small", "Large"] });
      expect(first.content[0].text).toContain("Which scope?");
      expect(afterQuestionCalls).toBe(0);
      expect((await handle.get("critic"))?.pendingQuestion?.question).toBe("Which scope?");
      const record = (await handle.get("critic"))!;
      const transcript = async () => {
        const files = (await readdir(record.sessionsRoot, { recursive: true })).filter((file) => file.endsWith(".jsonl"));
        return (await Promise.all(files.map((file) => readFile(resolve(record.sessionsRoot, file), "utf8")))).join("\n");
      };
      const before = await transcript();
      expect(before).toContain("first-task");
      if (batch !== "single") expect(before).toContain("Child turn ended awaiting a parent reply");
      expect(events.find((event) => event.phase === "agent_completed")?.isError).toBe(false);
      before.trim().split("\n").filter(Boolean).forEach((line) => expect(() => JSON.parse(line)).not.toThrow());
      await owner.disposeSession!(record.sessionId);
      const restarted = createSubagentInstanceRegistry({ root: config.subagents!.instances!.root!, retireSession });
      const extension = createSubagentsRuntimeExtension(config, deps, restarted);
      const resumed = await extension({ request: { conversationId: "conversation-1" }, runId: "parent-2" } as never);
      let context: { messages: { role: string; content: unknown }[] } | undefined;
      faux.setResponses([(input: typeof context) => { context = input; return fauxAssistantMessage([fauxText("second-answer")]); }]);
      const second = await createAgentManageTool(resumed.runtimeOptions!.subagents, { parentRunId: "parent-2" }).execute("call-2", { id: "critic", message: "second-task" });
      expect(second.details.subagent.status).toBe("ok");
      expect((await handle.get("critic"))?.pendingQuestion).toBeUndefined();
      expect((await handle.get("critic"))?.status).toBe("idle");
      expect(second.details.subagent.instance.turns).toBe(2);
      expect(calls[1]?.sessionId).toBe(calls[0]?.sessionId);
      expect(calls[1]?.piSessionsRoot).toBe(record.sessionsRoot);
      expect(calls[1]?.sessionKeepAlive).toBe(true);
      expect(calls[1]?.providerAttributionSessionId).toBeUndefined();
      const users = context!.messages.filter((message) => message.role === "user");
      expect(users).toHaveLength(2);
      expect(JSON.stringify(users[0])).toContain("first-task");
      expect(JSON.stringify(users[1])).toContain("second-task");
      expect(JSON.stringify(users[1])).toContain("parent's reply");
      expect(JSON.stringify(users[1])).toContain("Which scope?");
      const questionResult = context!.messages.find((message: any) => message.role === "toolResult" && message.toolName === "AskParent") as any;
      expect(questionResult?.isError).toBe(false);
      expect((await transcript()).length).toBeGreaterThan(before.length);
      expect((await handle.get("critic"))!.usage.input).toBeGreaterThan(0);
      await createAgentManageTool(resumed.runtimeOptions!.subagents).execute("close", { id: "critic", close: true });
      expect((await handle.get("critic"))!.status).toBe("closed");
      expect(await transcript()).toBe("");
    } finally { await owner.disposeAllSessions?.(); await rm(root, { recursive: true, force: true }); }
  });
  it("a real parent Pi turn sees Agent awaiting_reply as a non-error and has no AskParent", async () => {
    const root = await mkdtemp(resolve(process.cwd(), ".parent-dialogue-test-"));
    const owner = createMonoRuntime();
    try {
      const config = resolveJsonMonoAgentConfig({ cwd: root, json: {
        runtime: { model: "openai-codex:gpt-5.5" },
        context: { identityPath: resolve(root, "IDENTITY.md") },
        tools: { allowedTools: ["Agent", "AgentManage"] },
        subagents: { enabled: true, instances: { root: resolve(root, "children") } },
      } });
      const child = fauxProvider({ provider: config.runtime.model.provider, models: [{ id: config.runtime.model.model }], tokensPerSecond: undefined });
      const parent = fauxProvider({ provider: config.runtime.model.provider, models: [{ id: config.runtime.model.model }], tokensPerSecond: undefined });
      const childModels = createModels(); childModels.setProvider(child.provider);
      const parentModels = createModels(); parentModels.setProvider(parent.provider);
      const handle = await createSubagentInstanceRegistry({ root: config.subagents!.instances!.root!, retireSession: async (id, sessionsRoot) => owner.retireDurableSession!(id, sessionsRoot) }).open("parent");
      const runtime = { run: async (prompt: string, options: any) => generatePiNativeResponse(prompt, { ...options,
        piResolvedModel: child.getModel(), piResolvedModels: childModels, resolvePiApiKey: async () => "faux-key" }) };
      const subagents = buildSubagentsOptions(config, { runtime: runtime as never, baseModel: config.runtime.model }, { conversationId: "parent", runId: "p", instances: handle })!.subagents;
      child.setResponses([fauxAssistantMessage([fauxToolCall("AskParent", { question: "Which scope?" })])]);
      let observed = false;
      parent.setResponses([
        (context: any) => {
          // pi-ai 0.86.0 folds request tools into the transcript's leading
          // system message: replay them with getCurrentTools().
          expect(getCurrentTools(context.messages).map((tool: any) => tool.name)).not.toContain("AskParent");
          return fauxAssistantMessage([fauxToolCall("Agent", { persist: true, id: "helper", prompt: "Review" })]);
        },
        (context: any) => {
          const result = context.messages.find((message: any) => message.role === "toolResult" && message.toolName === "Agent");
          expect(result?.isError).toBe(false);
          expect(JSON.stringify(result?.content)).toContain("awaiting_reply");
          expect(JSON.stringify(result?.content)).toContain("Which scope?");
          observed = true;
          return fauxAssistantMessage([fauxText("I can answer that.")]);
        },
      ]);
      const result = await generatePiNativeResponse("Coordinate the review", { model: config.runtime.model,
        messages: [{ role: "user", content: "Review" }], allowedTools: ["Agent", "AgentManage", "AskParent"], subagents,
        piResolvedModel: parent.getModel(), piResolvedModels: parentModels, resolvePiApiKey: async () => "faux-key" });
      expect(result.error).toBeFalsy();
      expect(observed).toBe(true);
    } finally { await owner.disposeAllSessions?.(); await rm(root, { recursive: true, force: true }); }
  });

});
