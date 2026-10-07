import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createRuntime } from "../../runtime.js";
import { createRouterRuntime } from "../../ai/runtime/router.js";
import { preparePiNativeDispatch, generatePiNativeResponse } from "../../ai/providers/pi-native.js";
import { resolveDurableNativeSessionRepo } from "../../ai/providers/pi-native/session-lifecycle.js";
import { refreshProviderSession } from "../../ai/runtime/sessions.js";
import { probeNativeAccountProvenance } from "../../ai/providers/pi-native/account-provenance.js";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
async function fixture(provider = "faux", api) {
  const root = await mkdtemp(join(tmpdir(), "native-prepared-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider({ provider, ...(api ? { api } : {}), models: [{ id: "fixture", ...(api ? { api } : {}), contextWindow: 100000, maxTokens: 4096 }], tokensPerSecond: undefined });
  const models = createModels(); models.setProvider(faux.provider);
  const options = { model: { provider, model: "fixture", reference: `${provider}:fixture` }, piResolvedModel: faux.getModel(), piResolvedModels: models,
    messages: [{ role: "user", content: "Current fictional input" }], piSessionsRoot: root, allowedTools: [], effort: "none", compaction: { enabled: false } };
  return { root, faux, models, options };
}
async function mcp() {
  const methods = [], calls = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); methods.push(request.method);
    if (request.id === undefined) { res.writeHead(202).end(); return; }
    const result = request.method === "initialize" ? { protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: "fictional-mcp", version: "1" } }
      : request.method === "tools/list" ? { tools: [{ name: "Lookup", description: "Actual resolved fictional declaration",
        inputSchema: { type: "object", properties: { color: { type: "string", enum: ["amber", "blue"] } }, required: ["color"] } }] }
      : { content: [{ type: "text", text: "Fictional MCP result" }] };
    if (request.method === "tools/call") calls.push(request.params);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, methods, calls };
}
async function prepare(f, extra = {}, runtime) {
  const lease = await (runtime ? runtime.prepareNativeDispatch("Fictional rules", { ...f.options, ...extra }) : preparePiNativeDispatch("Fictional rules", { ...f.options, ...extra }));
  cleanups.push(() => lease.close()); return lease;
}

it("resolves actual built-in/MCP/StructuredOutput declarations before opening any session and reuses MCP once", async () => {
  const f = await fixture(), endpoint = await mcp(), requests = [];
  const instruction = vi.fn((prompt) => `${prompt}\nFictional StructuredOutput instructions`);
  const lease = await prepare(f, { allowedTools: ["Read"], mcpServers: { fictional: { type: "http", url: endpoint.url } },
    prompts: { structuredOutputInstruction: instruction },
    outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } });
  expect(await readdir(f.root)).toEqual([]); expect(endpoint.methods.filter((method) => method === "tools/list")).toHaveLength(1);
  expect(lease.snapshot.tools.map((tool) => tool.name)).toEqual(["Read", "Lookup", "StructuredOutput"]);
  expect(lease.snapshot.tools.find((tool) => tool.name === "Lookup")).toMatchObject({ description: "Actual resolved fictional declaration",
    parameters: { properties: { color: { enum: ["amber", "blue"] } }, required: ["color"] } });
  expect(lease.snapshot.systemPrompt).toContain("StructuredOutput");
  f.faux.setResponses([(context) => { requests.push(context); return fauxAssistantMessage([fauxToolCall("Lookup", { color: "amber" })]); },
    fauxAssistantMessage([fauxToolCall("StructuredOutput", { answer: "Fictional result" })])]);
  const result = await lease.run(); expect(result.error).toBeNull(); expect(result.structuredResult).toEqual({ answer: "Fictional result" });
  expect(endpoint.methods.filter((method) => method === "initialize")).toHaveLength(1);
  expect(endpoint.methods.filter((method) => method === "tools/list")).toHaveLength(1); expect(endpoint.calls).toHaveLength(1);
  expect(requests[0].messages[0].content).toBe(lease.snapshot.systemPrompt); expect(instruction).toHaveBeenCalledTimes(1);
  expect(requests[0].messages[0].toolsAdded.map(({ name, description, parameters }) => ({ name, description, parameters }))).toEqual(lease.snapshot.tools);
  await expect(lease.run()).rejects.toThrow("no longer available"); await lease.close(); await lease.close();
});

it("freezes request data synchronously and retains tool-context configuration at preparation time", async () => {
  const f = await fixture(), runtime = createRuntime({ workspace: f.root }), requests = [];
  await writeFile(join(f.root, "evidence.txt"), "Fictional retained workspace");
  f.options.allowedTools = ["Read"];
  const pending = runtime.prepareNativeDispatch("Fictional rules", f.options);
  f.options.messages[0].content = "Caller mutation"; f.options.allowedTools.push("Write");
  runtime.configureTools({ workspace: "/fictional/changed" });
  const lease = await pending; cleanups.push(() => lease.close());
  expect(lease.snapshot.messages[0].content).toBe("Current fictional input"); expect(lease.snapshot.tools.map((tool) => tool.name)).toEqual(["Read"]);
  expect(Object.isFrozen(lease.snapshot.messages[0])).toBe(true);
  expect(() => { lease.snapshot.model.contextWindow = 1; }).toThrow();
  await expect(lease.run({ model: f.options.model })).rejects.toThrow("only host session binding");
  f.faux.setResponses([(context) => { requests.push(context); return fauxAssistantMessage([fauxToolCall("Read", { file_path: "evidence.txt" })]); },
    (context) => { requests.push(context); return fauxAssistantMessage([fauxText("Accepted")]); }]);
  const running = lease.run(); const duplicate = lease.run();
  await expect(duplicate).rejects.toThrow("no longer available"); expect((await running).text).toBe("Accepted");
  expect(JSON.stringify(requests)).toContain("Current fictional input"); expect(JSON.stringify(requests)).not.toContain("Caller mutation");
  expect(JSON.stringify(requests)).toContain("Fictional retained workspace");
});

it.each(["close", "abort"])("cleans idle prepared MCP resources after %s without native mutation or model dispatch", async (action) => {
  const f = await fixture(), endpoint = await mcp(), controller = new AbortController();
  const provider = vi.spyOn(f.faux.provider, "streamSimple"), closed = vi.spyOn(Client.prototype, "close");
  const lease = await prepare(f, { abortSignal: controller.signal, mcpServers: { fictional: { type: "http", url: endpoint.url } } });
  if (action === "abort") controller.abort(new Error("Fictional cancellation"));
  await lease.close(); await lease.close();
  await expect(lease.run()).rejects.toThrow("no longer available");
  expect(await readdir(f.root)).toEqual([]); expect(provider).not.toHaveBeenCalled(); expect(endpoint.calls).toEqual([]); expect(closed).toHaveBeenCalledTimes(1);
});

it.each(["missing-auth", "auth-error", "missing-model", "canonical-mismatch", "mcp-failure"])("fails preparation for %s before native creation", async (variant) => {
  const f = await fixture();
  if (variant === "missing-auth") f.models.setProvider({ ...f.faux.provider, auth: { apiKey: { resolve: async () => undefined } } });
  if (variant === "auth-error") f.models.setProvider({ ...f.faux.provider, auth: { apiKey: { resolve: async () => { throw new Error("Fictional auth failure"); } } } });
  if (variant === "canonical-mismatch") f.options.model = { provider: "other-fictional", model: "fixture", reference: "other-fictional:fixture" };
  if (variant === "missing-model") f.models.setProvider({ ...f.faux.provider, getModels: () => [] });
  if (variant === "mcp-failure") f.options.mcpServers = { broken: { type: "http", url: "http://127.0.0.1:9/mcp" } };
  await expect(prepare(f)).rejects.toThrow(); expect(await readdir(f.root)).toEqual([]);
});

const token = (account, generation) => `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account }, generation })).toString("base64url")}.fixture`;
it.each([false, true])("pins actual selected OAuth account and dispatch auth including refresh=%s, never current host credential guesses", async (refresh) => {
  const f = await fixture("openai-codex", "openai-codex-responses"), requests = [];
  let credential = { type: "oauth", accountId: "fictional-selected", access: token("fictional-selected", 1), expires: refresh ? 0 : Date.now() + 3600000 };
  const refreshed = { ...credential, access: token("fictional-selected", 2), expires: Date.now() + 3600000 };
  const store = { read: vi.fn(async () => credential), modify: vi.fn(async (_id, update) => { credential = await update(credential); return credential; }),
    delete: vi.fn(), list: vi.fn(async () => []) };
  const models = createModels({ credentials: store });
  models.setProvider({ ...f.faux.provider, auth: { oauth: { refresh: vi.fn(async () => refreshed), toAuth: (selected) => ({ apiKey: selected.access }) } },
    streamSimple(model, context, options) { requests.push({ model, context, options }); return f.faux.provider.streamSimple(model, context, options); } });
  const lease = await prepare(f, { piResolvedModels: models, resolvePiApiKey: Object.assign(vi.fn(), { readCredential: vi.fn(async () => ({ ...credential, accountId: "wrong-host-account" })) }) });
  const actual = refresh ? refreshed : credential;
  expect(lease.snapshot.provenance.account).toBe(probeNativeAccountProvenance({ provider: "openai-codex", api: "openai-codex-responses",
    credential: actual, dispatchApiKey: actual.access }).provenance.account);
  expect(lease.snapshot.authSource).toBe("oauth"); expect(store.modify).toHaveBeenCalledTimes(refresh ? 1 : 0);
  const reads = store.read.mock.calls.length;
  credential = { ...credential, accountId: "other-fictional", access: token("other-fictional", 3) };
  f.faux.setResponses([fauxAssistantMessage([fauxText("Pinned")])]); expect((await lease.run()).text).toBe("Pinned");
  expect(requests[0].options.apiKey).toBe(actual.access); expect(store.read).toHaveBeenCalledTimes(reads);
  expect(JSON.stringify(lease.snapshot)).not.toContain("fixture."); expect(JSON.stringify(lease.snapshot)).not.toContain("fictional-selected");
});

it("keeps API-key account unknown while resolving ambient auth exactly once before dispatch", async () => {
  const f = await fixture(), requests = [], resolve = vi.fn(async () => ({ auth: { apiKey: "fictional-key", headers: { "x-fictional": "selected" }, baseUrl: "https://example.invalid/frozen" } }));
  f.models.setProvider({ ...f.faux.provider, auth: { apiKey: { resolve } }, streamSimple(model, context, options) {
    requests.push({ model, options }); return f.faux.provider.streamSimple(model, context, options); } });
  const lease = await prepare(f); expect(resolve).toHaveBeenCalledTimes(1); expect(lease.snapshot.provenance.account).toBeNull();
  f.faux.setResponses([fauxAssistantMessage([fauxText("Ambient pinned")])]); expect((await lease.run()).text).toBe("Ambient pinned");
  expect(resolve).toHaveBeenCalledTimes(1); expect(requests[0].model.baseUrl).toBe("https://example.invalid/frozen");
  expect(requests[0].options.apiKey).toBe("fictional-key"); expect(JSON.stringify(lease.snapshot)).not.toContain("fictional-key");
});

it("opens only the late-bound current handle, preserving the frozen root and protected authority", async () => {
  const f = await fixture(), handle = "a".repeat(64), assertCurrent = vi.fn(async () => {});
  cleanups.push(() => refreshProviderSession(handle));
  const lease = await prepare(f);
  expect(assertCurrent).not.toHaveBeenCalled(); expect(await readdir(f.root)).toEqual([]);
  f.faux.setResponses([fauxAssistantMessage([fauxText("Current binding")])]);
  const result = await lease.run({ sessionId: handle, providerSessionId: handle, sessionKeepAlive: true,
    sessionTurn: { kind: "host", ownerKey: "fictional-owner", historyBucket: "fictional-bucket", turnId: "fictional-turn", handleId: handle, baseRevision: 0,
      reconciliation: { version: 1, purpose: "execution", fenceDigest: "c".repeat(64), initialInputId: "fictional-input" } },
    nativeSessionAuthority: { version: 1, currentHandleId: handle, sessionsRoot: f.root,
      hostAuthority: { version: 1, canonicalVersion: 4, rootId: "1".repeat(64), authorityId: "2".repeat(64), ownerKey: "fictional-owner", historyBucket: "fictional-bucket" }, assertCurrent } });
  expect(result.error).toBeNull(); expect(assertCurrent).toHaveBeenCalled();
  expect(assertCurrent.mock.calls.every(([request]) => request.handleId === handle && request.sessionsRoot === f.root)).toBe(true);
});

it("prepares the certified router primary once, keeps resolver resources until settlement and never retries/backups", async () => {
  const f = await fixture(), cleanup = vi.fn(), resolveAttempt = vi.fn(async () => ({ options: { piResolvedModel: f.faux.getModel(), piResolvedModels: f.models }, cleanup }));
  const router = createRouterRuntime({ chain: [{ model: f.options.model, attempts: 3 }, { model: { provider: "faux", model: "backup", reference: "faux:backup" } }],
    resolveAttempt, sessionTurnReconciliation: "v1" });
  expect(router.nativePreparedDispatch).toBe("v1"); const lease = await prepare(f, {}, router);
  expect(resolveAttempt).toHaveBeenCalledTimes(1); expect(cleanup).not.toHaveBeenCalled();
  f.faux.setResponses([new Error("Fictional terminal failure")]); const result = await lease.run(); expect(result.error).toBeTruthy();
  await lease.close(); expect(resolveAttempt).toHaveBeenCalledTimes(1); expect(cleanup).toHaveBeenCalledTimes(1);
});

it("does not certify an arbitrary router resolver from method presence", async () => {
  const f = await fixture(), resolveAttempt = vi.fn();
  const router = createRouterRuntime({ chain: [{ model: f.options.model }], resolveAttempt });
  expect(router.nativePreparedDispatch).toBeUndefined();
  await expect(router.prepareNativeDispatch("Rules", f.options)).rejects.toThrow("does not support"); expect(resolveAttempt).not.toHaveBeenCalled();
});


it("aborts during auth preparation and cleans already-resolved MCP resources before rejecting", async () => {
  const f = await fixture(), endpoint = await mcp(), controller = new AbortController(), closed = vi.spyOn(Client.prototype, "close");
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  f.models.setProvider({ ...f.faux.provider, auth: { apiKey: { resolve: async () => { entered(); await gate; return { auth: {} }; } } } });
  const pending = prepare(f, { abortSignal: controller.signal, mcpServers: { fictional: { type: "http", url: endpoint.url } } });
  await started; controller.abort(new Error("Fictional setup cancellation")); release();
  await expect(pending).rejects.toThrow(); expect(closed).toHaveBeenCalledTimes(1); expect(await readdir(f.root)).toEqual([]);
});

it("close during a running dispatch waits without prematurely closing its MCP client", async () => {
  const f = await fixture(), endpoint = await mcp(), closed = vi.spyOn(Client.prototype, "close");
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  f.faux.setResponses([async () => { entered(); await gate; return fauxAssistantMessage([fauxText("Completed once")]); }]);
  const lease = await prepare(f, { mcpServers: { fictional: { type: "http", url: endpoint.url } } });
  const running = lease.run(); await started;
  let settled = false; const close = lease.close().then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false); expect(closed).not.toHaveBeenCalled(); release();
  expect((await running).text).toBe("Completed once"); await close; await lease.close(); expect(closed).toHaveBeenCalledTimes(1);
});


it("does not inspect, repair or detach an existing native session during preparation or unused close", async () => {
  const f = await fixture(), handle = "fictional-warm-handle";
  cleanups.push(() => refreshProviderSession(handle));
  f.faux.setResponses([fauxAssistantMessage([fauxText("Earlier fictional reply")])]);
  expect((await generatePiNativeResponse("Earlier rules", { ...f.options, sessionId: handle, sessionKeepAlive: true })).error).toBeNull();
  const repo = resolveDurableNativeSessionRepo(f.root), metadata = (await repo.list())[0], original = await readFile(metadata.path);
  const listed = vi.spyOn(repo, "list"), opened = vi.spyOn(repo, "open"), created = vi.spyOn(repo, "create");
  const lease = await prepare(f, { sessionId: handle, sessionKeepAlive: true }); await lease.close();
  expect(listed).not.toHaveBeenCalled(); expect(opened).not.toHaveBeenCalled(); expect(created).not.toHaveBeenCalled();
  expect(await readFile(metadata.path)).toEqual(original);
});

it("cleans successfully initialized MCP clients when authentication then fails", async () => {
  const f = await fixture(), endpoint = await mcp(), closed = vi.spyOn(Client.prototype, "close");
  f.models.setProvider({ ...f.faux.provider, auth: { apiKey: { resolve: async () => undefined } } });
  await expect(prepare(f, { mcpServers: { fictional: { type: "http", url: endpoint.url } } })).rejects.toThrow();
  expect(closed).toHaveBeenCalledTimes(1); expect(endpoint.methods).toContain("tools/list"); expect(await readdir(f.root)).toEqual([]);
});
