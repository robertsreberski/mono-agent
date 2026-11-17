import { isKnownToolName, suggestToolName } from "../tools/known-tools.js";
import { validateMonoAgentFolder } from "../doctor/doctor.js";
import { toolMultiselectOptions } from "../setup/wizard/prompts.js";
import { createHistoryRuntimeExtension } from "../request-tools/history.js";
import { buildSubagentsOptions } from "../composition/configured-subagents.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveJsonMonoAgentConfig } from "@mono-agent/config";
import { createToolPolicy, ToolHistoryWriter, continuityGenerationId, continuityRecordId } from "@mono-agent/conversation";
import { expect, it } from "vitest";
import { createConfiguredAgentResponderForApp, createConfiguredConversationHarness } from "../composition/configured-agent.js";
import { historyToolAvailabilityForRuntime } from "../request-tools/conversation-history.js";
import { toolsSection } from "../doctor/tools.js";
import { sessionToolHistorySection } from "../doctor/doctor-session-history.js";

// Model the controller-owned endpoint injection without widening the standalone
// harness API. Actual controller/TUI registration is exercised separately.
async function controllerHarness(options: Parameters<typeof createConfiguredConversationHarness>[0]) {
  const config = options.config;
  const responder = await createConfiguredAgentResponderForApp(options, { historyExtension: createHistoryRuntimeExtension({
    historyRoot: join(config.artifacts.dir, "..", "history"), artifactDir: config.artifacts.dir, policy: config.tools,
    capabilities: { said: config.runtime.session.continuity?.enabled !== false, tools: true, runs: true },
  }) ?? null });
  return { run: async (request: Parameters<Awaited<ReturnType<typeof createConfiguredConversationHarness>>["run"]>[0]) => {
    const { userMessage, ...rest } = request;
    const response = await responder.respond({ ...rest, text: userMessage }, { append: async () => {} });
    return { ...response, failure: (response as { failure?: unknown }).failure };
  }, dispose: async () => await (responder as { dispose?: () => Promise<void> }).dispose?.() };
}

const noScopes = { said: false, tools: false, runs: false };
const denies = ["SessionHistory", "session_history", "mcp__mono-agent-session-history__SessionHistory", "mcp__mono-agent-session-history__*", "*"];
it.each(["healthy", "continuity-off", "config-deny", "runs-only", "override", "disabled", ...denies] as const)(
  "assembles unified tool/prompt/pack/projection surfaces for %s", async mode => {
    const cwd = await mkdtemp(join(tmpdir(), "configured-unified-"));
    try {
      await writeFile(join(cwd, "IDENTITY.md"), "You are a fictional fixture.");
      const config = resolveJsonMonoAgentConfig({ cwd, json: {
        runtime: { model: "openai-codex:gpt-5.5", session: { mode: "per-message", ...(mode === "continuity-off" ? { continuity: { enabled: false } } : {}) } },
        context: { identityPath: "IDENTITY.md" }, artifacts: { dir: join(cwd, "artifacts") },
        tools: { history: { unified: true }, allowedTools: mode === "runs-only" ? ["RunHistory"] : ["*"], disallowedTools: mode === "config-deny" ? ["SessionHistory"] : [] },
      } });
      if (mode !== "continuity-off") {
        const writer = await ToolHistoryWriter.open({ root: join(cwd, "history"), continuityEnabled: true });
        const generationId = continuityGenerationId();
        try {
          await writer.prepareContinuity({ generationId, conversationId: "web:fiction", logicalConversationId: "web:fiction", beforeDigest: null, afterDigest: "b".repeat(64),
            records: [{ recordId: continuityRecordId("web:fiction", "fictional-earlier-tool"), runId: "old-independent", sequence: 0, kind: "tool", provenance: "tool", text: "Fictional earlier retained tool record." }] });
          await writer.commitContinuity({ generationId, conversationId: "web:fiction", canonicalDigest: "b".repeat(64) });
        } finally { await writer.close(); }
      }
      let calls = 0, forwarded = "";
      const hidden = mode === "override" || mode === "disabled" || denies.includes(mode);
      const expected = hidden ? noScopes : { said: mode !== "continuity-off" && mode !== "runs-only", tools: mode !== "config-deny" && mode !== "runs-only", runs: true };
      const harness = await controllerHarness({ cwd, config, env: {},
        runtimeOptionsForRequest: ({ request }) => request.userMessage === "seed" ? {} : mode === "override" ? { toolPolicyOverride: createToolPolicy({ allowedTools: ["Read"] }) }
          : denies.includes(mode) ? { runtimeOptions: { disallowedTools: [mode] } } : {},
        runtime: { async run(prompt, options) {
          calls++;
          expect(prompt).toContain('History');
          expect(prompt).not.toContain("ConversationHistory");
          const servers = options.mcpServers as Record<string, { url: string }> | undefined;
          for (const name of ["mono-agent-conversation-history", "mono-agent-session-history", "mono-agent-run-history"]) expect(servers?.[name]).toBeUndefined();
          if (calls === 1) {
            await options.toolLifecycleSink!({ phase: "invocation", toolCallId: "fictional-read", toolName: "Read", arguments: { file_path: "fiction.txt" } });
            await options.toolLifecycleSink!({ phase: "result", toolCallId: "fictional-read", toolName: "Read", state: "success", content: "Fictional cobalt evidence." });
            // History results must not become evidence in the next cold projection.
            await options.toolLifecycleSink!({ phase: "invocation", toolCallId: "history-read", toolName: "History", arguments: { scope: "runs" } });
            await options.toolLifecycleSink!({ phase: "result", toolCallId: "history-read", toolName: "History", state: "success", content: "Fictional nested history must be omitted." });
          } else {
            const pack = await options.coldContext?.({ maxTokens: 16000, reason: "cold_rebuild", primaryAttempt: true });
            forwarded = [...options.messages!, ...(pack?.messages ?? [])].map(message => message.content).join("\n");
            expect(historyToolAvailabilityForRuntime(options, true).history).toEqual(expected);
            if (servers?.["mono-agent-history"] !== undefined) {
              const client = new Client({ name: "fictional-configured", version: "1" });
              try { await client.connect(new StreamableHTTPClientTransport(new URL(servers["mono-agent-history"].url)) as never);
                expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["History"]);
              } finally { await client.close(); }
            }
          }
          return { text: calls === 1 ? "Fictional earlier answer." : "Fictional answer." };
        } },
      });
      try {
        expect((await harness.run({ conversationId: "web:fiction", userMessage: "seed", abortSignal: new AbortController().signal })).failure).toBeUndefined();
        const result = await harness.run({ conversationId: "web:fiction", userMessage: "recover", abortSignal: new AbortController().signal,
          ...(mode === "disabled" ? { continuation: { continuationId: "fictional", originRunId: "old", originContextPolicy: "detached_latest" as const, toolsDisabled: true as const, deferHistoryCommit: true as const } } : {}) });
        expect(result.failure).toBeUndefined(); expect(calls).toBe(2);
        expect(forwarded).toContain("Fictional cobalt evidence.");
        expect(forwarded).not.toContain("Fictional nested history must be omitted.");
        expect(forwarded).not.toMatch(/Use (ConversationHistory|SessionHistory)/u);
        if (expected.said || expected.tools) expect(forwarded).toContain("Use History");
        else expect(forwarded).not.toContain("Use History");
        if (expected.said) expect(forwarded).toContain('History recordId (scope "said")');
        else expect(forwarded).not.toContain('History recordId (scope "said")');
      } finally { await harness.dispose?.(); }
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

it("keeps flag-off prompts and doctor output byte-identical; custom souls win", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "unified-soul-parity-"));
  try {
    await writeFile(join(cwd, "IDENTITY.md"), "Fictional identity.");
    const custom = "Fictional custom soul uses ConversationHistory; do not rewrite it.";
    await writeFile(join(cwd, "SOUL.md"), custom);
    const base = { runtime: { model: "openai-codex:gpt-5.5", session: { mode: "per-message" as const } }, context: { identityPath: "IDENTITY.md" }, tools: { allowedTools: ["*"], disallowedTools: [] } };
    const configFor = (unified?: boolean, soulPath?: string) => resolveJsonMonoAgentConfig({ cwd, json: { ...base,
      context: { ...base.context, ...(soulPath === undefined ? {} : { soulPath }) },
      tools: { ...base.tools, ...(unified === undefined ? {} : { history: { unified } }) } } });
    const prompts: string[] = [];
    for (const [unified, soul] of [[undefined, undefined], [false, undefined], [true, undefined], [true, "SOUL.md"]] as const) {
      const harness = await createConfiguredConversationHarness({ cwd, config: configFor(unified, soul), env: {},
        runtime: { async run(prompt) { prompts.push(prompt); return { text: "Fictional answer." }; } } });
      try { expect((await harness.run({ conversationId: `web:fiction-${prompts.length}`, userMessage: "Fictional request.", abortSignal: new AbortController().signal })).failure).toBeUndefined(); }
      finally { await harness.dispose?.(); }
    }
    expect(prompts[0]).toBe(prompts[1]);
    expect(prompts[0]).toContain("ConversationHistory");
    expect(prompts[2]).not.toContain("ConversationHistory");
    expect(prompts[2]).toContain("History");
    expect(prompts[3]).toContain(custom);
    const a = await toolsSection(configFor(), { cwd, configPath: join(cwd, "mono-agent.config.json"), env: {}, subprocessProbes: false });
    const b = await toolsSection(configFor(false), { cwd, configPath: join(cwd, "mono-agent.config.json"), env: {}, subprocessProbes: false });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = await toolsSection(configFor(true, "SOUL.md"), { cwd, configPath: join(cwd, "mono-agent.config.json"), env: {}, subprocessProbes: false });
    expect(c.details.join("\n")).toContain("ConversationHistory → said; SessionHistory → tools; RunHistory → runs");
    expect(c.details.join("\n")).toContain("Custom soulPath mentions legacy history tools");
    const legacy = await sessionToolHistorySection({ historyRoot: join(cwd, "nonexistent"), requestScopedToolSupported: false });
    expect(JSON.stringify(legacy)).toBe(JSON.stringify(await sessionToolHistorySection({ historyRoot: join(cwd, "nonexistent"), requestScopedToolSupported: false, unifiedHistory: false })));
    const unified = await sessionToolHistorySection({ historyRoot: join(cwd, "nonexistent"), requestScopedToolSupported: false, unifiedHistory: true });
    expect(unified.details.join("\n")).toContain('History (scope "tools")');
    expect(unified.details.join("\n")).not.toContain("SessionHistory");
    const soulFile = await readFile(new URL("../../../conversation/src/context/default-soul.ts", import.meta.url));
    expect(createHash("sha256").update(soulFile).digest("hex")).toBe("a1050836c51d4492977078f95bc96c297c9b5c48a2f1867037c158d73e7f9270");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});


it.each(["openai-api", "acp"])("keeps request policy boundaries on %s turns", async source => {
  const cwd = await mkdtemp(join(tmpdir(), "history-request-boundary-"));
  try {
    await writeFile(join(cwd, "IDENTITY.md"), "Fictional fixture.");
    const config = resolveJsonMonoAgentConfig({ cwd, json: { runtime: { model: "openai-codex:gpt-5.5" }, context: { identityPath: "IDENTITY.md" }, tools: { history: { unified: true }, allowedTools: ["History"] } } });
    let calls = 0;
    const harness = await createConfiguredConversationHarness({ cwd, config, env: {},
      runtimeOptionsForRequest: ({ request }) => request.userMessage === "override" ? { toolPolicyOverride: createToolPolicy({ allowedTools: ["Read"] }) } : {},
      runtime: { async run(_prompt, options) {
        calls++;
        expect(historyToolAvailabilityForRuntime(options, true).history).toEqual(calls === 1 ? { said: true, tools: false, runs: false } : noScopes);
        expect(Object.keys(options.mcpServers ?? {})).toEqual(calls === 1 ? ["mono-agent-history"] : []);
        return { text: "Fictional answer." };
      } },
    });
    try {
      for (const userMessage of ["normal", "override"]) expect((await harness.run({ conversationId: `${source}:fiction`, userMessage, metadata: { source }, abortSignal: new AbortController().signal })).failure).toBeUndefined();
      expect(calls).toBe(2);
    } finally { await harness.dispose?.(); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it("does not change subagent child tools, MCP servers or system prompt", async () => {
  const captured: unknown[] = [], definitions: unknown[] = [];
  for (const unified of [false, true]) {
    const config = resolveJsonMonoAgentConfig({ cwd: "/fictional-agent", json: { runtime: { model: "openai-codex:gpt-5.5" }, context: { identityPath: "IDENTITY.md" },
      tools: { history: { unified } }, subagents: { enabled: true, definitions: [{ name: "reader", description: "Read fictional evidence.", prompt: "Fictional child rules.", allowedTools: ["Read"] }] } } });
    const runtime = { async run(prompt: string, options: any) { captured.push({ prompt, allowedTools: options.allowedTools, disallowedTools: options.disallowedTools, mcpServers: options.mcpServers }); return { text: "Fictional child answer." }; } };
    const options = buildSubagentsOptions(config, { runtime, baseModel: config.runtime.model }) as any;
    definitions.push(options.subagents.definitions);
    await options.subagents.run({ definition: options.subagents.definitions[0], prompt: "Read fictional evidence.", maxTurns: 1, depth: 1, abortSignal: new AbortController().signal, onEvent: () => {} });
  }
  expect(JSON.stringify(definitions[0])).toBe(JSON.stringify(definitions[1]));
  expect(JSON.stringify(captured[0])).toBe(JSON.stringify(captured[1]));
  expect(captured[1]).toMatchObject({ allowedTools: ["Read"], mcpServers: {} });
});


it.each([
  { allow: ["History"], continuity: true, offered: true },
  { allow: ["History"], continuity: false, offered: false },
  { allow: ["RunHistory"], continuity: true, offered: false },
  { allow: ["SessionHistory"], continuity: true, offered: false },
])("standalone unified exposure matches split composition: %j", async ({ allow, continuity, offered }) => {
  const cwd = await mkdtemp(join(tmpdir(), "standalone-history-review-"));
  try {
    await writeFile(join(cwd, "IDENTITY.md"), "Fictional fixture.");
    const config = resolveJsonMonoAgentConfig({ cwd, json: { runtime: { model: "openai-codex:gpt-5.5", session: { continuity: { enabled: continuity } } }, context: { identityPath: "IDENTITY.md" }, tools: { allowedTools: allow, history: { unified: true } } } });
    let called = false;
    const harness = await createConfiguredConversationHarness({ cwd, config, env: {}, runtime: { async run(_prompt, options) {
      called = true;
      expect(historyToolAvailabilityForRuntime(options, true).history).toEqual({ said: offered, tools: false, runs: false });
      const spec = (options.mcpServers as Record<string, { url: string }>)?.["mono-agent-history"];
      expect(spec !== undefined).toBe(offered);
      if (spec) {
        const client = new Client({ name: "fictional-standalone", version: "1" });
        try { await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
          expect((await client.listTools()).tools[0]!.description).not.toMatch(/scope tools:|scope runs:/u);
          expect((await client.callTool({ name: "History", arguments: { scope: "runs" } })).structuredContent).toMatchObject({ error: { code: "invalid_scope", permittedScopes: ["said"] } });
        } finally { await client.close(); }
      }
      return { text: "Fictional answer." };
    } } });
    try { expect((await harness.run({ conversationId: "web:fiction", userMessage: "Fictional request.", abortSignal: new AbortController().signal })).failure).toBeUndefined(); expect(called).toBe(true); }
    finally { await harness.dispose?.(); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

it.each([false, true])("doctor gates History while leaving other unknown-tool diagnostics intact (unified=%s)", async unified => {
  const config = resolveJsonMonoAgentConfig({ cwd: "/fictional-agent", json: { runtime: { model: "openai-codex:gpt-5.5" }, context: { identityPath: "IDENTITY.md" }, tools: { history: { unified }, allowedTools: ["History", "FictionalUnknownTool"] } } });
  const result = await toolsSection(config, { cwd: "/fictional-agent", configPath: "/fictional-agent/mono-agent.config.json", env: {}, subprocessProbes: false });
  expect(result.details.some(detail => detail.includes("History requires tools.history.unified: true"))).toBe(!unified);
  expect(result.details.some(detail => detail.includes("Unknown tool name") && detail.includes("FictionalUnknownTool"))).toBe(true);
});


it.each([undefined, false])("pins assembled prompt and full doctor JSON to a096834a2 (unified=%s)", async unified => {
  const golden = JSON.parse(await readFile(new URL("./fixtures/history-main-parity.json", import.meta.url), "utf8"));
  expect(golden.baseRevision).toBe("a096834a2");
  const cwd = await mkdtemp(join(tmpdir(), "history-base-parity-"));
  try {
    await writeFile(join(cwd, "IDENTITY.md"), "Fictional identity.");
    const json = { runtime: { model: "openai-codex:gpt-5.5", session: { mode: "per-message" as const } }, context: { identityPath: "IDENTITY.md" },
      tools: { allowedTools: ["Read", "ConversationHistory", "FictionalUnknownTool"], disallowedTools: [], ...(unified === undefined ? {} : { history: { unified } }) }, providers: { piAuthPath: join(cwd, "fictional-auth.json") } };
    await writeFile(join(cwd, "mono-agent.config.json"), JSON.stringify(json));
    const config = resolveJsonMonoAgentConfig({ cwd, json });
    const doctor = await validateMonoAgentFolder({ cwd, configPath: join(cwd, "mono-agent.config.json"), env: {}, drivers: [], liveness: false, subprocessProbes: false, allowFilesystemWrites: false, verifiedRuntimeProvenanceDetail: "Fictional runtime build." });
    const normalize = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(cwd, "<fixture>"));
    expect(JSON.stringify(normalize(doctor))).toBe(JSON.stringify(golden.fullDoctor));
    expect(JSON.stringify(normalize(await toolsSection(config, { cwd, configPath: join(cwd, "mono-agent.config.json"), env: {}, subprocessProbes: false })))).toBe(JSON.stringify(golden.doctor));
    let prompt = "";
    const harness = await createConfiguredConversationHarness({ cwd, config, env: {}, runtime: { async run(value) { prompt = value; return { text: "Fictional answer." }; } } });
    try { expect((await harness.run({ conversationId: "web:fiction", userMessage: "Fictional request.", abortSignal: new AbortController().signal })).failure).toBeUndefined(); }
    finally { await harness.dispose?.(); }
    expect(normalize(prompt)).toBe(golden.prompt);
    expect(JSON.stringify(toolMultiselectOptions([]))).toBe(JSON.stringify(golden.wizardOptions));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});


for (const kind of ["inline", "profile"] as const) {
  it.each([false, true])(`keeps main's ${kind} subagent History error (unified=%s)`, async unified => {
    const golden = JSON.parse(await readFile(new URL("./fixtures/history-main-parity.json", import.meta.url), "utf8")).review2;
    expect(golden.baseRevision).toBe("a096834a2");
    const entry = golden.cases[kind], cwd = "/fictional-agent";
    const config = resolveJsonMonoAgentConfig({ cwd, json: { ...entry.json, tools: { ...entry.json.tools, history: { unified } } } });
    const result = await toolsSection(config, { cwd, configPath: `${cwd}/mono-agent.config.json`, env: {}, subprocessProbes: false });
    // Unified's parent mapping is intentional; child diagnostics remain main's.
    const comparable = { ...result, details: result.details.filter(detail => !detail.startsWith("Unified History policy:")) };
    expect(JSON.stringify(comparable)).toBe(JSON.stringify(entry.doctor));
    expect(result.status).toBe("error");
    expect(isKnownToolName("History")).toBe(golden.historyKnown);
    expect(suggestToolName("history")).toBe(golden.historySuggestion ?? undefined);
  });
}

it("preserves main's flag-off doctor output for unreserved external History MCP names", async () => {
  const entry = JSON.parse(await readFile(new URL("./fixtures/history-main-parity.json", import.meta.url), "utf8")).review2.cases.externalMcp;
  const cwd = "/fictional-agent";
  const config = resolveJsonMonoAgentConfig({ cwd, json: { ...entry.json, tools: { ...entry.json.tools, history: { unified: false } } } });
  const result = await toolsSection(config, { cwd, configPath: `${cwd}/mono-agent.config.json`, env: {}, subprocessProbes: false });
  expect(JSON.stringify(result)).toBe(JSON.stringify(entry.doctor));
  expect(result.status).toBe("ok");
});
