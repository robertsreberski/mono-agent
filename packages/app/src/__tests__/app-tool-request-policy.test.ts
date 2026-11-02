// Build the app dependency closure first; this suite exercises built dist bridges and the adapter child.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { createRuntime } from "@mono-agent/turn";
import { generateEngineTurnResponse } from "@mono-agent/turn/ai";
import type { MonoAgentConfig } from "@mono-agent/config";
import { createToolPolicy, type ConversationHarnessRuntimeOptionsInput } from "@mono-agent/conversation";
import type { RuntimeRunOptions } from "@mono-agent/turn/host/types";
import { createBujoMemoryStore } from "@mono-agent/memory/bujo";
import { createConfiguredConversationHarness } from "../composition/configured-agent.js";
import { composeRuntimeOptionExtensions, type RuntimeOptionsExtension } from "../composition/runtime-option-extensions.js";
import { APP_OWNED_MCP_SERVERS, appOwnedMcpServerSpec } from "../mcp/app-owned-tool-policy.js";
import { createRequestScopedMcpRuntimeExtension } from "../mcp/request-scoped-mcp.js";
import { createConversationHistoryRuntimeExtension, isConversationHistoryToolAllowed, historyToolAvailabilityForRuntime, CONVERSATION_HISTORY_MCP_SERVER_NAME } from "../request-tools/conversation-history.js";
import { createSessionHistoryRuntimeExtension, isSessionHistoryToolAllowed, SESSION_HISTORY_MCP_SERVER_NAME } from "../request-tools/session-history.js";
import { createRunHistoryRuntimeExtension, isRunHistoryToolAllowed, RUN_HISTORY_MCP_SERVER_NAME } from "../request-tools/run-history.js";
import { isMemoryJournalToolAllowed, MEMORY_JOURNAL_MCP_SERVER_NAME } from "../memory/memory-journal.js";
import { isRememberToolAllowed, MEMORY_REMEMBER_MCP_SERVER_NAME } from "../memory/memory-remember.js";
import { isProviderUsageToolAllowed, SERVER as PROVIDER_USAGE_MCP_SERVER_NAME } from "../providers/provider-usage-tool.js";
import { isSetConversationTitleToolAllowed, SET_CONVERSATION_TITLE_MCP_SERVER_NAME } from "../request-tools/conversation-title.js";
import { isSuggestRepliesToolAllowed, SUGGEST_REPLIES_SERVER_NAME } from "../request-tools/suggest-replies.js";
import { isProposeRestartToolAllowed, PROPOSE_RESTART_SERVER_NAME } from "../service/restart/restart-proposal.js";
import { createReplyArtifactService, isPublishReplyFileToolAllowed, REPLY_ARTIFACT_MCP_SERVER_NAME } from "../artifacts/reply-artifacts.js";
import { CONSOLE_PROJECT_SCHEMAS, isConsoleProjectToolAllowed, SERVER as CONSOLE_PROJECT_MCP_SERVER_NAME } from "../request-tools/console-projects.js";
import { isAdapterSendToolAllowed } from "../delivery/send-tools/adapter-send-tools.js";
import { SERVER as PEER_AGENT_MCP_SERVER_NAME } from "../peers/peer-agent.js";
import { ADAPTER_SEND_TOOLS_MCP_SERVER_NAME } from "../delivery/send-tools/child-config.js";
const { adapterSendToolsMcpServerSpec } = await import("../../dist/delivery/send-tools/host-extension.js");

// Exercise the built bridge without widening a package API only for tests.
const { createMcpToolPolicyGuard } = await import(new URL("../../../turn/dist/tools/mcp/tool-policy.js", import.meta.url).href) as typeof import("../../../turn/dist/tools/mcp/tool-policy.js");
const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const input = (): ConversationHarnessRuntimeOptionsInput => ({ runId: "fictional-run", request: {
  conversationId: "web:fictional", userMessage: "Check fictional evidence.", abortSignal: new AbortController().signal,
}, context: {} as never });
const toolsByServer: Record<string, string[]> = {
  [CONVERSATION_HISTORY_MCP_SERVER_NAME]: ["ConversationHistory"], [SESSION_HISTORY_MCP_SERVER_NAME]: ["SessionHistory"],
  [RUN_HISTORY_MCP_SERVER_NAME]: ["RunHistory"], [MEMORY_JOURNAL_MCP_SERVER_NAME]: ["MemoryJournal"], [MEMORY_REMEMBER_MCP_SERVER_NAME]: ["Remember"],
  [PROVIDER_USAGE_MCP_SERVER_NAME]: ["ProviderUsage"], [SET_CONVERSATION_TITLE_MCP_SERVER_NAME]: ["SetConversationTitle"],
  [SUGGEST_REPLIES_SERVER_NAME]: ["SuggestReplies"], [PROPOSE_RESTART_SERVER_NAME]: ["ProposeRestart"],
  [REPLY_ARTIFACT_MCP_SERVER_NAME]: ["PublishReplyFile"], [PEER_AGENT_MCP_SERVER_NAME]: ["PeerAgent"],
  [CONSOLE_PROJECT_MCP_SERVER_NAME]: Object.keys(CONSOLE_PROJECT_SCHEMAS),
  [ADAPTER_SEND_TOOLS_MCP_SERVER_NAME]: ["SlackSendMessage", "TelegramSendMessage", "TelegramSendFile", "AskUser"],
};
const predicates: Record<string, (policy: { allowedTools: string[]; disallowedTools: string[] }) => boolean> = {
  ConversationHistory: isConversationHistoryToolAllowed, SessionHistory: isSessionHistoryToolAllowed, RunHistory: isRunHistoryToolAllowed,
  MemoryJournal: isMemoryJournalToolAllowed, Remember: isRememberToolAllowed, ProviderUsage: isProviderUsageToolAllowed,
  SetConversationTitle: isSetConversationTitleToolAllowed, SuggestReplies: isSuggestRepliesToolAllowed,
  ProposeRestart: isProposeRestartToolAllowed, PublishReplyFile: isPublishReplyFileToolAllowed,
  // Mirror PeerAgent's private config predicate (peers/peer-agent.ts).
  PeerAgent: ({ allowedTools, disallowedTools }) => {
    const names = ["PeerAgent", `mcp__${PEER_AGENT_MCP_SERVER_NAME}__PeerAgent`, `mcp__${PEER_AGENT_MCP_SERVER_NAME}__*`];
    return !disallowedTools.includes("*") && !names.some((name) => disallowedTools.includes(name))
      && (allowedTools.includes("*") || names.some((name) => allowedTools.includes(name)));
  },
  ...Object.fromEntries(Object.keys(CONSOLE_PROJECT_SCHEMAS).map((name) => [name, (policy: Parameters<typeof isConsoleProjectToolAllowed>[1]) => isConsoleProjectToolAllowed(name as keyof typeof CONSOLE_PROJECT_SCHEMAS, policy)])),
  ...Object.fromEntries(toolsByServer["mono-agent-adapter-send"]!.map((name) => [name, (policy: Parameters<typeof isAdapterSendToolAllowed>[1]) => isAdapterSendToolAllowed(name, policy)])),
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "app-request-policy-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "workspace")); await writeFile(join(root, "IDENTITY.md"), "You are a fictional test agent.");
  const faux = fauxProvider({ provider: "faux", models: [{ id: "fixture", contextWindow: 100000, maxTokens: 4096 }], tokensPerSecond: undefined! });
  const models = createModels(); models.setProvider(faux.provider);
  const model = { provider: "faux", model: "fixture", reference: "faux:fixture" };
  const native = createRuntime({ workspace: join(root, "workspace") });
  const inference = { model, piResolvedModel: faux.getModel(), piResolvedModels: models, effort: "none", compaction: { enabled: false } };
  const config: MonoAgentConfig = {
    runtime: { model, workspace: join(root, "workspace"), maxTurns: 3, session: { mode: "per-message", idleTimeoutMs: 60000 } },
    context: { identityPath: join(root, "IDENTITY.md"), selectedSkills: [] }, tools: { allowedTools: ["*"], disallowedTools: [] },
    artifacts: { dir: join(root, ".mono-agent", "artifacts"), retention: { maxAgeDays: 365, maxCount: 50000, dryRun: false }, memoryRetention: { maxAgeDays: 7, maxCount: 5000, dryRun: false } },
    traceability: { registryDir: join(root, "traces") },
  };
  async function declarations(mcpServers: Record<string, unknown>, allowedTools: string[], disallowedTools: string[] = []) {
    const lease = await native.prepareNativeDispatch!("Fictional rules", { ...inference, mcpServers, allowedTools, disallowedTools,
      messages: [{ role: "user", content: "Check fictional tools." }], abortSignal: new AbortController().signal });
    try { return lease.snapshot.tools.map((tool) => tool.name); } finally { await lease.close(); }
  }
  return { root, faux, config, inference, declarations };
}
async function synthetic(serverName: string, names: string[], call = vi.fn()) {
  const extension = await createRequestScopedMcpRuntimeExtension({ serverName, startingMessage: "Fictional tool starting", createServer: () => {
    const server = new McpServer({ name: serverName, version: "1" });
    for (const name of names) server.registerTool(name, { inputSchema: {} }, async () => { call(name); return { content: [{ type: "text", text: "Fictional evidence." }] }; });
    return server;
  } })(input());
  cleanup.push(() => extension.cleanup?.());
  return extension.runtimeOptions!.mcpServers as Record<string, unknown>;
}

describe("app-owned tool descriptor parity", () => {
  it("marks every real factory server name and pins the registry to those constants", () => {
    // These keys come from the factory modules, not a second literal registry.
    expect(Object.keys(APP_OWNED_MCP_SERVERS).sort()).toEqual(Object.keys(toolsByServer).sort());
    for (const serverName of Object.keys(toolsByServer)) {
      expect(Object.hasOwn(APP_OWNED_MCP_SERVERS, serverName), serverName).toBe(true);
      expect(appOwnedMcpServerSpec(serverName, {}).appOwnedTools, serverName).toMatchObject({ version: 1, aliases: {} });
    }
  });

  it("covers every app-owned server and preserves all current aliases and case-sensitive matching", () => {
    expect(Object.keys(predicates).sort()).toEqual(Object.values(toolsByServer).flat().sort());
    for (const [serverName, tools] of Object.entries(toolsByServer)) for (const tool of tools) {
      const spec = appOwnedMcpServerSpec(serverName, {});
      const descriptor = spec.appOwnedTools as { aliases: Record<string, string[]> };
      const names = [tool, `mcp__${serverName}__${tool}`, `mcp__${serverName}__*`, "*", ...(descriptor.aliases[tool] ?? [])];
      for (const alias of [...names, tool.toLowerCase(), `mcp__${serverName}__${tool.toLowerCase()}`, "Other"]) {
        for (const policy of [{ allowedTools: [alias], disallowedTools: [] }, { allowedTools: ["*"], disallowedTools: [alias] }, { allowedTools: [], disallowedTools: [] }]) {
          const actual = createMcpToolPolicyGuard(structuredClone(spec), serverName, policy.allowedTools, policy.disallowedTools)(tool);
          expect(actual, `${serverName}:${tool}:${JSON.stringify(policy)}`).toBe(predicates[tool]!(policy));
        }
      }
      expect(createMcpToolPolicyGuard(spec, serverName, ["*"], ["*"])(tool)).toBe(false);
    }
    expect(appOwnedMcpServerSpec("mono-agent-memory", {})).toEqual({});
    expect(appOwnedMcpServerSpec("external", {})).toEqual({});
  });

  it("removes every affected tool from actual Pi declarations while retaining permitted siblings", async () => {
    const f = await fixture();
    for (const [server, tools] of Object.entries(toolsByServer)) {
      const servers = await synthetic(server, tools);
      expect(await f.declarations(servers, tools)).toEqual([...tools].sort());
      for (const tool of tools) expect(await f.declarations(servers, tools, [tool])).toEqual(tools.filter((name) => name !== tool).sort());
      expect(await f.declarations(servers, tools, ["*"])).toEqual([]);
      expect(await f.declarations(servers, [])).toEqual([]);
    }
  }, 30000);

  it("keeps external same-name tools unchanged, even with an app-like server key", async () => {
    const f = await fixture();
    const servers = await synthetic("external", ["ConversationHistory"]);
    expect(await f.declarations({ "mono-agent-conversation-history": servers.external }, [], ["ConversationHistory", "*"])).toEqual(["ConversationHistory"]);
  });

  it("preserves adapter metadata and filters real compiled stdio tools after JSON/clone forwarding", async () => {
    const f = await fixture(), configPath = join(f.root, "adapter.json"); await writeFile(configPath, "{}");
    const spec = adapterSendToolsMcpServerSpec(configPath, f.root, ["AskUser"], {
      conversationId: "web:fictional", interactionConversationId: "web:fictional", runId: "fictional-run",
    }, { bridgeUrl: "http://127.0.0.1:9", bridgeToken: "fictional-token", timeoutMs: null });
    expect(Object.getOwnPropertyDescriptor(spec, Symbol.for("@mono-agent/app-owned-local-binding"))).toMatchObject({ value: true, enumerable: false });
    const forwarded = structuredClone(JSON.parse(JSON.stringify(spec)));
    expect(await f.declarations({ "mono-agent-adapter-send": forwarded }, ["AskUser"])).toEqual(["AskUser"]);
    expect(await f.declarations({ "mono-agent-adapter-send": forwarded }, ["AskUser"], ["*"])).toEqual([]);
  });

  it("retains reply-file private capability metadata when marking the actual factory spec", async () => {
    const f = await fixture(), service = createReplyArtifactService({ artifactDir: f.config.artifacts.dir, workspace: f.config.runtime.workspace, privateRoots: [], retentionDays: 1 });
    const extension = await service.createExtension(input()); cleanup.push(() => extension.cleanup?.()); cleanup.push(() => extension.settleCleanup?.());
    const servers = extension.runtimeOptions!.mcpServers as Record<string, Record<PropertyKey, unknown>>;
    expect(servers["mono-agent-reply-artifacts"]![Symbol.for("@mono-agent/private-capability-url")]).toBe(true);
    expect(await f.declarations(servers, ["PublishReplyFile"], ["publish_reply_file"])).toEqual([]);
  });
});

describe("configured request merge and actual model offers", () => {
  it.each(["request", "static", "override", "allow-all", "config-deny", "empty", "continuation"])("enforces %s policy and agrees with history availability", async (mode) => {
    const f = await fixture(), offered: string[][] = [], calls = vi.fn(), effective: RuntimeRunOptions[] = [];
    const session = createSessionHistoryRuntimeExtension({ historyRoot: join(f.root, ".mono-agent", "history") });
    const history = createRunHistoryRuntimeExtension({ artifactDir: f.config.artifacts.dir });
    const usage = async () => ({ runtimeOptions: { mcpServers: await synthetic("mono-agent-provider-usage", ["ProviderUsage"], calls) } });
    const base = composeRuntimeOptionExtensions([session, history, usage])!;
    const denied = ["ConversationHistory", "SessionHistory", "RunHistory", "ProviderUsage"];
    const requestExtension: RuntimeOptionsExtension = async (request) => {
      const extension = await base(request);
      if (mode === "override") return { ...extension, toolPolicyOverride: createToolPolicy({ allowedTools: ["*"], disallowedTools: denied, mcpServers: extension.runtimeOptions?.mcpServers as Record<string, unknown> }) };
      return { ...extension, runtimeOptions: { ...extension.runtimeOptions, ...(mode === "request" ? { disallowedTools: denied } : {}) } };
    };
    const runtime = { async run(system: string, options: RuntimeRunOptions) {
      effective.push(options);
      f.faux.setResponses([(context) => { offered.push(getCurrentTools(context.messages).map((tool) => tool.name)); return fauxAssistantMessage([fauxToolCall("ProviderUsage", {})]); }, fauxAssistantMessage([fauxText("Fictional answer.")])]);
      return await generateEngineTurnResponse(system, { ...options, ...f.inference });
    } };
    const config = { ...f.config, tools: { allowedTools: mode === "empty" ? [] : ["*"], disallowedTools: mode === "config-deny" ? denied : [] } };
    const harness = await createConfiguredConversationHarness({ config, cwd: f.root, runtime, runtimeOptionsForRequest: requestExtension,
      ...(mode === "static" ? { runtimeOptions: { disallowedTools: denied } } : {}) });
    cleanup.push(() => harness.dispose?.());
    const request = input().request;
    await harness.run({ ...request, ...(mode === "continuation" ? { continuation: { continuationId: "fictional-continuation", originRunId: "fictional-origin", originContextPolicy: "detached_latest", toolsDisabled: true, deferHistoryCommit: true } } : {}) });
    expect(offered).toHaveLength(1);
    const allowed = mode === "allow-all";
    for (const tool of denied) expect(offered[0]!.includes(tool), `${mode}:${tool}`).toBe(allowed);
    expect(calls).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(historyToolAvailabilityForRuntime(effective[0]! as unknown as Record<string, unknown>)).toEqual({ conversationHistory: allowed, sessionHistory: allowed });
  });

  it("applies each request-level deny to every app tool in actual model declarations and rejects fabricated calls", async () => {
    const f = await fixture(), calls = vi.fn();
    const allNames = Object.values(toolsByServer).flat();
    const servers = Object.assign({}, ...await Promise.all(Object.entries(toolsByServer).map(([server, tools]) => synthetic(server, tools, calls))));
    let denied = "", offered: string[] = [];
    const harness = await createConfiguredConversationHarness({ config: { ...f.config, tools: { allowedTools: allNames, disallowedTools: [] } }, cwd: f.root,
      runtimeOptionsForRequest: () => ({ runtimeOptions: { mcpServers: servers, disallowedTools: [denied] } }),
      runtime: { async run(system, options) {
        f.faux.setResponses([(context) => { offered = getCurrentTools(context.messages).map((tool) => tool.name); return fauxAssistantMessage([fauxToolCall(denied, {})]); }, fauxAssistantMessage([fauxText("Fictional answer.")])]);
        return await generateEngineTurnResponse(system, { ...options, ...f.inference });
      } },
    });
    try {
      for (const name of allNames) {
        denied = name;
        await harness.run({ ...input().request, conversationId: `fictional-${name}` });
        expect(offered.sort(), name).toEqual(allNames.filter((tool) => tool !== name).sort());
      }
      expect(calls).not.toHaveBeenCalled();
    } finally { await harness.dispose?.(); }
  }, 30000);

  it("keeps MemoryRecall exempt from deny/empty policy and preserved under override, but not MemoryJournal", async () => {
    const f = await fixture(), memory = createBujoMemoryStore({ root: join(f.root, "memory"), tier: "lite" }); cleanup.push(() => memory.close());
    for (const mode of ["allow", "deny", "empty", "override", "config-deny"]) {
      let names: string[] = [];
      const harness = await createConfiguredConversationHarness({ config: { ...f.config, tools: { allowedTools: mode === "empty" ? [] : ["*"], disallowedTools: mode === "config-deny" ? ["MemoryRecall"] : [] }, memory: { mode: "lite", backend: "bujo", path: join(f.root, "memory"), maxBytes: 64000, writeMode: "disabled" } }, cwd: f.root, memory,
        runtime: { async run(system, options) {
          f.faux.setResponses([(context) => { names = getCurrentTools(context.messages).map((tool) => tool.name); return fauxAssistantMessage([fauxText("Fictional answer.")]); }]);
          return await generateEngineTurnResponse(system, { ...options, ...f.inference });
        } },
        runtimeOptionsForRequest: () => mode === "override" ? { toolPolicyOverride: createToolPolicy({ allowedTools: [], disallowedTools: ["MemoryRecall", "MemoryJournal"] }) }
          : { runtimeOptions: { disallowedTools: mode === "deny" ? ["MemoryRecall", "MemoryJournal"] : [] } },
      });
      try { await harness.run(input().request); expect(names).toContain("MemoryRecall"); expect(names.includes("MemoryJournal"), mode).toBe(mode === "allow" || mode === "config-deny"); } finally { await harness.dispose?.(); }
    }
  });

  it("omits history after endpoint startup failure without changing the request cleanup contract", async () => {
    const f = await fixture(), warning = vi.fn();
    const failed = await createRequestScopedMcpRuntimeExtension({ serverName: "mono-agent-session-history", startingMessage: "Starting", createServer: () => new McpServer({ name: "fixture", version: "1" }),
      listen: async () => { throw new Error("Fictional startup failure"); }, onUnavailable: warning })(input());
    cleanup.push(() => failed.cleanup?.());
    const real = await createConversationHistoryRuntimeExtension({ historyRoot: join(f.root, "history") })(input()); cleanup.push(() => real.cleanup?.());
    const servers = { ...real.runtimeOptions?.mcpServers as object, ...failed.runtimeOptions?.mcpServers as object };
    const names = await f.declarations(servers, ["ConversationHistory", "SessionHistory"]);
    expect(warning).toHaveBeenCalledOnce(); expect(names).toEqual(["ConversationHistory"]);
    expect(historyToolAvailabilityForRuntime({ mcpServers: servers, allowedTools: ["ConversationHistory", "SessionHistory"] })).toEqual({ conversationHistory: true, sessionHistory: false });
  });
});
