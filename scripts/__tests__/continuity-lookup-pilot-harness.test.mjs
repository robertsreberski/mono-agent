import { afterEach, beforeAll, afterAll, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, lstat } from "node:fs/promises";
import { userInfo } from "node:os";
import { dependencySnapshot } from "./fixtures/lookup-dependency-witness.mjs";
import { createServer } from "node:http";
import { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { openHarness, productionModules, scriptedModels, controlledRuntime, createJudge, prepareLedgerCheckpoint } from "../lib/continuity-runner.mjs";
import { armById, mergePatch } from "../lib/continuity-arms.mjs";
import { issueLookupCacheKey, assertResolvedLookupSafety, assertLookupCacheAssignment, fauxLookupSafety, lookupOfflineBoundary } from "../lib/continuity-lookup-pilot-runtime.mjs";
import { guardedLookupModels, createTestOnlyLookupPermitSource, LOOKUP_GUARD_CONTRACT as C } from "../lib/continuity-lookup-guard.mjs";

const cleanups = [];
const ROOT = fileURLToPath(new URL("../../", import.meta.url)), registry = join(userInfo().homedir, ".local/state/mono-agent/lookup-pilot/consumed-v1");
const metadata = async path => { try { const s = await lstat(path, { bigint: true }); return [s.ino, s.mtimeNs, s.ctimeNs]; } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
let dependencies, realHome;
beforeAll(async () => { dependencies = await dependencySnapshot(ROOT); realHome = await metadata(registry); });
afterAll(async () => { expect(await dependencySnapshot(ROOT)).toEqual(dependencies); expect(await metadata(registry)).toEqual(realHome); });
afterEach(async () => { try { for (const close of cleanups.splice(0).reverse()) await close(); } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); } }, 120_000);
const arm = armById("native-lookup"), plan = { judge: null };
const reasoning = { type: "reasoning", id: "rs_fictional", status: "completed", encrypted_content: "FAKE-ENCRYPTED-REASONING",
  summary: [{ type: "summary_text", text: "Fictional summary." }], content: [{ type: "reasoning_text", text: "Fictional reasoning." }] };
const message = text => ({ type: "message", id: "msg_fictional", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
function response(items) {
  const events = items.flatMap((item, index) => [
    { type: "response.output_item.added", output_index: index, item: item.type === "function_call" ? { ...item, arguments: "" } : { ...item, content: [], summary: [] } },
    ...(item.type === "message" ? [{ type: "response.content_part.added", output_index: index, content_index: 0, item_id: item.id, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", output_index: index, content_index: 0, item_id: item.id, delta: item.content[0].text }] : []),
    { type: "response.output_item.done", output_index: index, item },
  ]);
  events.push({ type: "response.completed", response: { id: "fictional-response", status: "completed", output: items, service_tier: "priority", usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } } } });
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
async function historyFixture() {
  const [{ Server }, { StreamableHTTPServerTransport }, { ListToolsRequestSchema, CallToolRequestSchema }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/index.js"), import("@modelcontextprotocol/sdk/server/streamableHttp.js"), import("@modelcontextprotocol/sdk/types.js"),
  ]);
  let calls = 0;
  const server = createServer(async (req, res) => {
    const mcp = new Server({ name: "mono-agent-conversation-history", version: "1.0.0" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "ConversationHistory", description: "Fictional retained evidence.", inputSchema: { type: "object", properties: { query: { type: "string" } } } }] }));
    mcp.setRequestHandler(CallToolRequestSchema, async request => { expect(request.params.name).toBe("ConversationHistory"); calls++; return { content: [{ type: "text", text: "Fictional retained tool evidence." }] }; });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void mcp.close(); });
    try { let body = ""; for await (const chunk of req) body += chunk; await mcp.connect(transport); await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined); }
    catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, port: server.address().port, calls: () => calls };
}

it.each(["native-lookup", "continuity-pack-cold"])("configured %s preserves native checkpoint context with only guarded faux dispatch", async id => {
  const root = fileURLToPath(new URL("../../", import.meta.url)), scratch = join(root, ".worklab-tmp"); await mkdir(scratch, { recursive: true });
  const work = await mkdtemp(join(scratch, "lookup-harness-")); cleanups.push(() => rm(work, { recursive: true, force: true }));
  for (const key of ["HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"]) vi.stubEnv(key, work);
  await writeFile(join(work, "IDENTITY.md"), "Fictional harness identity.");
  const fixture = await historyFixture(), destinations = [], rejected = [];
  const originalConnect = Socket.prototype.connect;
  vi.spyOn(Socket.prototype, "connect").mockImplementation(function (...args) {
    const input = Array.isArray(args[0]) ? args[0][0] : args[0], host = input?.host ?? input?.hostname ?? args[1], port = Number(input?.port ?? input);
    if (host !== "127.0.0.1" || port !== fixture.port) { rejected.push(`${host}:${port}`); throw Error("test_egress_denied"); }
    destinations.push(`${host}:${port}`); return originalConnect.apply(this, args);
  });
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (url, init) => { if (new URL(String(url)).origin !== new URL(fixture.url).origin) throw Error("test_global_fetch_denied"); return realFetch(url, init); });
  vi.stubGlobal("WebSocket", class { constructor() { throw Error("test_websocket_denied"); } });
  const modules = await productionModules(root), selected = armById(id), keys = [issueLookupCacheKey("fictional-harness"), issueLookupCacheKey("fictional-harness")];
  expect(new Set(keys).size).toBe(2);
  const encode = x => Buffer.from(JSON.stringify(x)).toString("base64url");
  const access = `${encode({ alg: "none" })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "FAKE-TEST-ACCOUNT-NOT-REAL" } })}.FAKE-TEST-SIGNATURE`;
  const authPath = join(work, "fictional-auth.json");
  await writeFile(authPath, JSON.stringify({ "openai-codex": { type: "oauth", access, refresh: "FAKE-TEST-REFRESH-NOT-REAL", expires: Date.now() + 3600000 } }));
  const configPatch = mergePatch(selected.sessionConfig ?? {}, { runtime: { compaction: { enabled: false }, retry: { primaryAttempts: 1 }, session: { rollover: "none" } }, providers: { piNative: { transport: "sse", piMaxRetries: 0 } }, tools: { allowedTools: ["ConversationHistory"] } });
  let run = 0, sends = 0; const outer = [], consumed = [], boundaries = [];
  const request = { conversationId: "fictional-conversation", captureSpeakerKind: "human-turn", metadata: { source: "web" }, onEvent: e => { if (e.type === "session_boundary") boundaries.push({ kind: e.kind, reason: e.reason, context: e.context }); } };
  const pilot = { authorization: { schema: "continuity-lookup-faux-authorization-v1" }, plan, arm: selected, historyEndpoint: fixture.url };
  const route = async options => {
    const index = run++, key = keys[index], permit = createTestOnlyLookupPermitSource(); let round = 0;
    expect(index).toBeLessThan(2); outer.push({ sessionId: options.sessionId, providerSessionId: options.providerSessionId, nativeAuthority: options.nativeSessionAuthority });
    const send = async (url, init) => {
      sends++; round++; expect(String(url)).toBe(`${C.baseUrl}/codex/responses`);
      const headers = new Headers(init.headers), bytes = headers.get("content-encoding") === "zstd" ? zstdDecompressSync(init.body) : Buffer.from(init.body), body = JSON.parse(bytes);
      for (const name of ["session-id", "x-client-request-id"]) expect(headers.get(name)).toBe(key);
      expect(body.prompt_cache_key).toBe(key); expect(options.sessionId).toBe(outer[index].sessionId); expect(options.nativeSessionAuthority).toBe(outer[index].nativeAuthority); expect(options.sessionId).not.toBe(key);
      expect(body.tools.every(t => t.name.endsWith("ConversationHistory"))).toBe(true);
      if (id === "native-lookup" && index === 0) return response([message("Fictional checkpoint material.")]);
      if (round === 1) {
        expect(JSON.stringify(body.input)).toContain("Fictional checkpoint material.");
        const tool = body.tools.find(t => t.name.endsWith("ConversationHistory")); expect(tool).toBeTruthy();
        return response([reasoning, { type: "function_call", id: "fc_fictional", call_id: "call_fictional", name: tool.name, arguments: JSON.stringify({ query: "fictional" }), status: "completed" }]);
      }
      expect(round).toBe(2); expect(body.input.find(item => item.type === "reasoning")).toEqual(reasoning);
      expect(body.input.find(item => item.type === "function_call_output")?.output).toContain("Fictional retained tool evidence.");
      return response([message("Fictional final answer.")]);
    };
    consumed.push(permit.events);
    return { mcpServers: { "mono-agent-conversation-history": { type: "http", url: fixture.url } },
      piModelsDecorator: models => guardedLookupModels(models, { contract: { ...C, runId: "fictional-harness", slotId: `slot-${index}`, promptCacheKey: key }, permit, send, resolvedSafety: { ...pilot, config: opened.config } }) };
  };
  let opened;
  const open = async () => { opened = await openHarness({ modules, work, authPath, model: `${C.provider}:${C.model}`, effort: "high", tools: false, configPatch, route, pilot, clock: { value: new Date("2026-01-01T00:00:00Z") } }); cleanups.push(opened.close); return opened; };
  let offlineCalls = 0;
  if (id === "continuity-pack-cold") {
    const boundary = lookupOfflineBoundary({ plan, arm: selected, work }), reference = { provider: C.provider, model: "fictional-checkpoint" };
    expect(boundary.mode).toBe("offline");
    const scripted = scriptedModels(modules.pi, [reference]); scripted.respondWith(reference, () => { offlineCalls++; return modules.pi.fauxAssistantMessage("Fictional checkpoint material."); });
    const prep = await openHarness({ modules, work, authPath: boundary.authPath, model: `${reference.provider}:${reference.model}`, tools: false, configPatch, clock: { value: new Date("2026-01-01T00:00:00Z") }, route: async options => ({ piResolvedModel: scripted.route(options).model, piResolvedModels: scripted.models, compaction: { enabled: false } }) });
    cleanups.push(prep.close); const seeded = await prep.harness.run({ ...request, userMessage: "Remember fictional checkpoint material.", abortSignal: AbortSignal.timeout(20000) });
    expect(seeded.failure).toBeUndefined(); await prep.close();
  } else {
  await open();
  const first = await opened.harness.run({ ...request, abortSignal: AbortSignal.timeout(20000), turnId: "fictional-seed", userMessage: "Remember fictional checkpoint material." });
  expect(first.failure).toBeUndefined(); await opened.close();
  }
  await open();
  const second = await opened.harness.run({ ...request, abortSignal: AbortSignal.timeout(20000), turnId: "fictional-probe", userMessage: "Retrieve the fictional retained evidence." });
  expect(second.failure).toBeUndefined(); expect(second.text).toBe("Fictional final answer.");
  if (id === "native-lookup") { expect(outer[1].sessionId).toBe(outer[0].sessionId); expect(boundaries.some(b => b.kind === "resume_replay")).toBe(false); }
  else { expect(offlineCalls).toBe(1); expect(boundaries).toContainEqual(expect.objectContaining({ kind: "resume_replay", reason: "model_change" })); }
  expect(typeof outer.at(-1).sessionId).toBe("string"); expect(outer.at(-1).providerSessionId).toBe(outer.at(-1).sessionId);
  expect(boundaries.some(b => b.kind === "compaction")).toBe(false); expect(sends).toBe(id === "native-lookup" ? 3 : 2); expect(fixture.calls()).toBe(1);
  expect(consumed.flat().filter(e => e.type === "consume")).toHaveLength(sends);
  expect(destinations.length).toBeGreaterThan(0); expect(new Set(destinations)).toEqual(new Set([`127.0.0.1:${fixture.port}`]));
  expect(rejected).toEqual([]); expect(() => new Socket().connect({ host: "127.0.0.1", port: fixture.port === 9 ? 10 : 9 })).toThrow("test_egress_denied");
  expect(() => fetch("https://provider.invalid/forbidden")).toThrow("test_global_fetch_denied");
}, 30_000);

it.each([
  [s => { s.config.runtime.session.modelSwitch = { enabled: true }; }, "lookup_model_switch_forbidden"],
  [s => { s.captureUpkeepOutput = {}; }, "lookup_preparation_forbidden"],
  [s => { s.arm = { ...s.arm, midCheckpoint: 1 }; }, "lookup_preparation_forbidden"],
  [s => { s.plan = { judge: {} }; }, "lookup_auxiliary_callers_forbidden"],
  [s => { s.config.memory = {}; }, "lookup_auxiliary_callers_forbidden"],
  [s => { s.config.subagents = { enabled: true }; }, "lookup_auxiliary_callers_forbidden"],
  [s => { s.config.runtime.compaction.enabled = true; }, "lookup_auxiliary_callers_forbidden"],
  [s => { s.config.runtime.outputSchema = {}; }, "lookup_auxiliary_callers_forbidden"],
  [s => { s.config.runtime.session.continuity.upkeep.enabled = true; }, "lookup_auxiliary_callers_forbidden"],
  [s => { s.config.runtime.session.continuity.ledgerEnabled = true; }, "lookup_auxiliary_callers_forbidden"],
  [s => { s.arm = { ...s.arm, ledgerUpkeep: true }; }, "lookup_preparation_forbidden"],
  [s => { s.config.runtime.context1MModels = { [C.model]: true }; }, "lookup_route_mismatch"],
  [s => { s.config.providers.local = { fictional: {} }; }, "lookup_route_mismatch"],
  [s => { s.config.runtime.fallbacks = [{}]; }, "lookup_route_mismatch"],
  [s => { s.config.providers.piNative.transport = "websocket"; }, "lookup_route_mismatch"],
  [s => { s.config.providers.piNative.piMaxRetries = 1; }, "lookup_route_mismatch"],
  [s => { s.config.tools.allowedTools = ["Bash"]; }, "lookup_tools_forbidden"],
  [s => { s.historyEndpoint = "https://provider.invalid/mcp"; }, "lookup_tools_forbidden"],
  [s => { s.config.runtime.retry.primaryAttempts = 2; }, "lookup_route_mismatch"],
  [s => { s.config.providers.piNative.piRequestRetryBudgetMs = 1; }, "lookup_retry_profile_forbidden"],
])("refuses resolved unsafe settings before dispatch", (change, code) => { const s = fauxLookupSafety(plan, arm); assertResolvedLookupSafety(s); change(s); expect(() => assertResolvedLookupSafety(s)).toThrow(code); });
it.each(["prepareNativeDispatch", "prepareContinuityUpkeep", "prepareUpkeep", "compactSession", "checkProvider", "futureDispatch"])("does not expose %s on the pilot runtime", method => {
  const dispatch = vi.fn(), base = { [method]: dispatch }, runtime = controlledRuntime(base, dispatch, () => {});
  expect(() => runtime[method]).toThrow("lookup_method_forbidden"); expect(dispatch).not.toHaveBeenCalled();
});
it("rejects capture/preparation before constructing any runtime", async () => {
  expect(() => createJudge({ plan: { judge: {} }, pilot: {} })).toThrow("lookup_auxiliary_callers_forbidden");
  await expect(prepareLedgerCheckpoint({ pilot: {}, plan: {} })).rejects.toThrow("lookup_preparation_forbidden");
  expect(() => lookupOfflineBoundary({ plan, arm, work: "/home/example/work", captureUpkeepOutput: {} })).toThrow("lookup_preparation_forbidden");
  expect(lookupOfflineBoundary({ plan, arm, work: "/home/example/work" })).toEqual({ mode: "offline", authPath: "/home/example/work/.lookup-no-credentials/absent.json" });
});
it("refuses duplicate or foreign assigned cache keys", () => {
  for (const state of [{ cacheKeysUnique: true, slots: [{ cacheKey: "same" }, { cacheKey: "same" }] }, { cacheKeysUnique: true, slots: [{ cacheKey: "assigned" }] }])
    expect(() => assertLookupCacheAssignment(state, { index: 0, cacheKey: "foreign" })).toThrow("lookup_cache_assignment_invalid");
});

it("checks resolved model-switch configuration before either configured constructor", async () => {
  const modules = await productionModules(ROOT), construct = vi.fn();
  const isolated = { config: modules.config, app: { createConfiguredAgentRuntime: construct, createConfiguredConversationHarness: construct } };
  await expect(openHarness({ modules: isolated, work: "/home/example/work", authPath: "/home/example/absent.json", model: `${C.provider}:${C.model}`, effort: "high", tools: false,
    configPatch: { runtime: { session: { modelSwitch: { enabled: true } }, compaction: { enabled: false } }, providers: { piNative: { transport: "sse", piMaxRetries: 0 } } },
    pilot: { authorization: { schema: "continuity-lookup-faux-authorization-v1" }, plan, arm } })).rejects.toThrow("lookup_model_switch_forbidden");
  expect(construct).not.toHaveBeenCalled();
});
it("rechecks policy after route preparation and prevents native overrides", async () => {
  const settings = fauxLookupSafety(plan, arm), dispatch = vi.fn(), options = { model: settings.config.runtime.model, compaction: { enabled: false }, piTransport: "sse", piMaxRetries: 0 };
  const check = opts => assertResolvedLookupSafety({ ...settings, options: opts });
  const runtime = controlledRuntime({ run: dispatch }, async () => { settings.config.runtime.session.modelSwitch = { enabled: true }; return { piModelsDecorator: x => x }; }, check);
  await expect(runtime.run("fictional", options)).rejects.toThrow("lookup_model_switch_forbidden"); expect(dispatch).not.toHaveBeenCalled();
  delete settings.config.runtime.session.modelSwitch;
  const forged = controlledRuntime({ run: dispatch }, async () => ({ piModelsDecorator: x => x, sessionId: "replacement" }), check);
  await expect(forged.run("fictional", options)).rejects.toThrow("lookup_native_identity_forbidden"); expect(dispatch).not.toHaveBeenCalled();
});
