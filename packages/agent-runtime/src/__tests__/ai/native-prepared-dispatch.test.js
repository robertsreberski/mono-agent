import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createRuntime } from "../../runtime.js";
import { createRouterRuntime } from "../../ai/runtime/router.js";
import { preparePiNativeDispatch, generatePiNativeResponse, createDynamicCredentialStore } from "../../ai/providers/pi-native.js";
import { resolveDurableNativeSessionRepo } from "../../ai/providers/pi-native/session-lifecycle.js";
import { refreshProviderSession } from "../../ai/runtime/sessions.js";
import { probeNativeAccountProvenance } from "../../ai/providers/pi-native/account-provenance.js";
import { createPreparedDispatchLease, prepareDispatchAuth, copyDispatchData, freezeDispatchData, PREPARED_DISPATCH_MAX_AGE_MS } from "../../ai/providers/pi-native/prepared-dispatch.js";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { Type } from "@earendil-works/pi-ai";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
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
    compaction: { enabled: true }, // Proactive estimation must not augment the prepared prompt a second time.
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


it.each([false, true])("invalid binding retains the direct/routed lease and resource claim: routed=%s", async (routed) => {
  const f = await fixture(), cleanup = vi.fn(), closed = vi.spyOn(Client.prototype, "close"), endpoint = await mcp();
  const runtime = routed ? createRouterRuntime({ chain: [f.options.model], sessionTurnReconciliation: "v1",
    resolveAttempt: async () => ({ options: { piResolvedModel: f.faux.getModel(), piResolvedModels: f.models }, cleanup }) }) : undefined;
  const lease = await prepare(f, { mcpServers: { fictional: { type: "http", url: endpoint.url } } }, runtime);
  await expect(lease.run({ model: f.options.model })).rejects.toThrow("only host session binding");
  await expect(lease.run({ [Symbol("invalid-binding")]: true })).rejects.toThrow("only host session binding");
  await expect(lease.run(Object.create({ model: f.options.model }))).rejects.toThrow("only host session binding");
  await expect(lease.run({ get sessionId() { throw new Error("Fictional binding getter rejection"); } })).rejects.toThrow("binding getter rejection");
  expect(closed).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled(); expect(await readdir(f.root)).toEqual([]);
  f.faux.setResponses([fauxAssistantMessage([fauxText("Corrected binding")])]);
  expect((await lease.run()).text).toBe("Corrected binding");
  await lease.close(); expect(closed).toHaveBeenCalledTimes(1); expect(cleanup).toHaveBeenCalledTimes(routed ? 1 : 0);
  await expect(lease.run()).rejects.toThrow("no longer available");
});

it("routed prepared failure normalizes authentication and records one attempt without failover", async () => {
  const f = await fixture(), close = vi.fn(), run = vi.fn(async () => ({ error: "401 Unauthorized: invalid API key", failureKind: "provider_unavailable",
    text: null, events: [], usage: {}, cancelled: false }));
  const resolveAttempt = vi.fn(async () => ({ runtime: { run: vi.fn(), configureTools: vi.fn(), nativePreparedDispatch: "v1",
    prepareNativeDispatch: async () => ({ snapshot: {}, run, close }) } }));
  const router = createRouterRuntime({ chain: [{ model: f.options.model, attempts: 3 }, { model: { provider: "faux", model: "backup" } }],
    resolveAttempt, sessionTurnReconciliation: "v1" });
  const lease = await router.prepareNativeDispatch("Rules", f.options), result = await lease.run();
  expect(result.failureKind).toBe("provider_auth");
  expect(result.failoverHistory).toMatchObject([{ model: f.options.model, failureKind: "provider_auth" }]);
  expect(run).toHaveBeenCalledOnce(); expect(resolveAttempt).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
});

it.each([false, true])("close settles rather than rethrowing a consumed run's rejection: routed=%s", async (routed) => {
  const direct = await createPreparedDispatchLease(async ({ ready }) => { await ready({}); throw new Error("Fictional execution rejection"); });
  const f = await fixture(), router = createRouterRuntime({ chain: [f.options.model], sessionTurnReconciliation: "v1",
    resolveAttempt: async () => ({ runtime: { run: vi.fn(), configureTools: vi.fn(), nativePreparedDispatch: "v1", prepareNativeDispatch: async () => direct } }) });
  const lease = routed ? await router.prepareNativeDispatch("Fictional rules", f.options) : direct;
  await expect(lease.run()).rejects.toThrow("Fictional execution rejection");
  await expect(lease.close()).resolves.toBeUndefined(); await expect(lease.close()).resolves.toBeUndefined();
});

it("refuses a stale prepared lease before any native mutation or provider call", async () => {
  const f = await fixture(), provider = vi.spyOn(f.faux.provider, "streamSimple"), lease = await prepare(f), now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + PREPARED_DISPATCH_MAX_AGE_MS + 1);
  expect(() => lease.assertReady()).toThrow("lease expired");
  expect((await lease.run()).error).toContain("lease expired"); expect(await readdir(f.root)).toEqual([]); expect(provider).not.toHaveBeenCalled();
});

it("requires ten-minute OAuth validity after refresh and never accepts a near-expiry pin", async () => {
  const f = await fixture("openai-codex", "openai-codex-responses");
  let credential = { type: "oauth", access: token("fictional-account", 1), expires: Date.now() + 60_000 };
  const refresh = vi.fn(async () => credential), store = { read: async () => credential, list: async () => [], delete: vi.fn(),
    modify: async (_id, update) => { credential = await update(credential); return credential; } };
  const models = createModels({ credentials: store });
  models.setProvider({ ...f.faux.provider, auth: { oauth: { refresh, toAuth: (value) => ({ apiKey: value.access }) } } });
  await expect(prepare(f, { piResolvedModels: models })).rejects.toThrow("expires too soon");
  expect(refresh).toHaveBeenCalledOnce(); expect(await readdir(f.root)).toEqual([]);
});

it("unknown-account long runs refuse refresh distinctly without touching the shared store", async () => {
  const f = await fixture("openai-codex", "openai-codex-responses"), now = Date.now();
  const credential = { type: "oauth", access: token("fictional-account", 1), expires: now + 60 * 60_000 };
  const read = vi.fn(async () => credential), models = createModels({ credentials: { read, list: async () => [], delete: vi.fn(), modify: vi.fn() } });
  models.setProvider({ ...f.faux.provider, auth: { oauth: { refresh: vi.fn(), toAuth: (value) => ({ apiKey: value.access }) } } });
  const pin = await prepareDispatchAuth(models, f.faux.getModel()); const reads = read.mock.calls.length;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60_000);
  await expect(pin.models.getAuth(pin.model)).resolves.toMatchObject({ auth: { apiKey: credential.access } });
  expect(() => pin.assertValid(true)).toThrow("lease expired");
  clock.mockReturnValue(credential.expires - 5 * 60_000 + 1);
  await expect(pin.models.getAuth(pin.model)).rejects.toThrow("Prepared credential refresh refused"); expect(read).toHaveBeenCalledTimes(reads);
});

it("the pinned collection refuses another model even when it shares the same provider/API", async () => {
  const f = await fixture(), provider = vi.spyOn(f.faux.provider, "streamSimple"), pin = await prepareDispatchAuth(f.models, f.faux.getModel());
  expect(pin.models.getModel("faux", "other")).toBeUndefined();
  await expect(pin.models.getAuth({ ...pin.model, id: "other" })).rejects.toThrow("cannot select another model");
  const result = await pin.models.completeSimple({ ...pin.model, id: "other" }, { messages: [{ role: "user", content: "Fictional input", timestamp: 0 }] });
  expect(result.errorMessage).toContain("cannot select another model"); expect(provider).not.toHaveBeenCalled();
});

it("preserves prototype methods and their original private-field receiver", async () => {
  const f = await fixture();
  class Provider {
    #delegate = f.faux.provider;
    get id() { return this.#delegate.id; }
    get auth() { return this.#delegate.auth; }
    getModels() { return this.#delegate.getModels(); }
    streamSimple(...args) { return this.#delegate.streamSimple(...args); }
  }
  const models = createModels(); models.setProvider(new Provider());
  const pin = await prepareDispatchAuth(models, f.faux.getModel());
  f.faux.setResponses([fauxAssistantMessage([fauxText("Prototype preserved")])]);
  const result = await pin.models.completeSimple(pin.model, { messages: [{ role: "user", content: "Fictional input", timestamp: 0 }] });
  expect(result.errorMessage).toBeUndefined();
  expect(result).toMatchObject({ stopReason: "stop" });
  expect(result.content[0].text).toBe("Prototype preserved");
});

it("real Codex provider serializes frozen TypeBox/StructuredOutput declarations without mutation", async () => {
  const provider = openaiCodexProvider(), model = provider.getModels()[0], schema = Type.Object({ answer: Type.String() }, { additionalProperties: false });
  const legacyKind = Symbol.for("TypeBox.Kind"), declaration = Type.Unsafe(schema);
  declaration[legacyKind] = "Object"; declaration.properties.answer[legacyKind] = "String";
  const parameters = freezeDispatchData(copyDispatchData(declaration));
  expect(parameters[legacyKind]).toBe("Object"); expect(parameters.properties.answer[legacyKind]).toBe("String");
  expect(parameters["~kind"]).toBe(schema["~kind"]); expect(parameters.properties.answer["~kind"]).toBe("String");
  const credential = { type: "oauth", access: token("fictional-account", 1), expires: Date.now() + 3600000, refresh: "fictional-refresh" };
  const models = createModels({ credentials: { read: async () => credential, list: async () => [], delete: vi.fn(), modify: vi.fn() } }); models.setProvider(provider);
  const pin = await prepareDispatchAuth(models, model), payload = vi.fn();
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Fictional transport refusal", { status: 400 }));
  const result = await pin.models.completeSimple(pin.model, { messages: [{ role: "system", content: "Fictional instructions",
    toolsAdded: [{ name: "StructuredOutput", description: "Fictional structure", parameters }] }, { role: "user", content: "Fictional input", timestamp: 0 }] },
    { transport: "sse", maxRetries: 0, onPayload: payload });
  expect(result.errorMessage).toContain("Fictional transport refusal"); expect(fetch).toHaveBeenCalledOnce();
  expect(payload).toHaveBeenCalledOnce(); expect(payload.mock.calls[0][0].tools[0].parameters).toMatchObject({ type: "object", required: ["answer"] });
  expect(parameters["~kind"]).toBe(schema["~kind"]); expect(parameters.properties.answer["~kind"]).toBe("String"); expect(Object.isFrozen(parameters.properties.answer)).toBe(true);
});

const producerInput = () => ({ prepared: { status: "prepared", checkpoints: [], ledger: [{ kind: "tool", outcome: "unknown" }],
  recent: [], older: [], coverage: [] }, outputReserve: 256 });
const summaryText = () => JSON.stringify(Object.fromEntries(["intent", "constraints", "decisions", "completedWork", "failures", "openWork", "nextActions", "references"]
  .map((key) => [key, key === "intent" ? ["Fictional pending work"] : []])));
it.each([false, true])("one typed prepared producer uses pinned auth, no tools/session/retry and leaves dispatch reusable: routed=%s", async (routed) => {
  const f = await fixture(), requests = [], resolve = vi.fn(async () => ({ auth: { apiKey: "fictional-pinned-producer" } }));
  f.models.setProvider({ ...f.faux.provider, auth: { apiKey: { resolve } }, streamSimple(model, context, options) {
    requests.push({ model, context, options }); return f.faux.provider.streamSimple(model, context, options); } });
  const router = routed ? createRouterRuntime({ chain: [{ model: f.options.model, attempts: 3 }], sessionTurnReconciliation: "v1",
    resolveAttempt: async () => ({ options: { piResolvedModel: f.faux.getModel(), piResolvedModels: f.models } }) }) : undefined;
  const lease = await prepare(f, { allowedTools: ["Read"], piTransport: "auto" }, router), input = producerInput();
  expect(lease.checkHandoffSummary(input)).toEqual({ status: "ready" }); expect(await readdir(f.root)).toEqual([]);
  f.faux.setResponses([fauxAssistantMessage([fauxText(summaryText())]), fauxAssistantMessage([fauxText("Incoming dispatch")])]);
  const result = await lease.produceHandoffSummary(input); expect(result.status).toBe("ready");
  expect(requests[0].context.messages[0].toolsAdded ?? []).toEqual([]); expect(requests[0].options.maxRetries).toBe(0); expect(requests[0].options.transport).toBe("auto");
  expect(requests[0].options.apiKey).toBe("fictional-pinned-producer"); expect(resolve).toHaveBeenCalledOnce();
  expect(await readdir(f.root)).toEqual([]); await expect(lease.produceHandoffSummary(input)).rejects.toThrow("no longer available");
  expect((await lease.run()).text).toBe("Incoming dispatch"); expect(requests).toHaveLength(2); expect(resolve).toHaveBeenCalledOnce();
});
it("producer preflight refuses unfit complete input without consuming the producer or creating native state", async () => {
  const f = await fixture(), provider = vi.spyOn(f.faux.provider, "streamSimple"), lease = await prepare(f);
  const oversized = producerInput(); oversized.prepared.older = [{ text: "x".repeat(400000) }];
  expect(lease.checkHandoffSummary(oversized)).toMatchObject({ status: "budget_failure" });
  expect(await lease.produceHandoffSummary(oversized)).toMatchObject({ status: "budget_failure" });
  expect(provider).not.toHaveBeenCalled(); expect(await readdir(f.root)).toEqual([]);
  f.faux.setResponses([fauxAssistantMessage([fauxText(summaryText())])]); expect((await lease.produceHandoffSummary(producerInput())).status).toBe("ready");
});
it.each(["malformed", "truncated", "error"])("producer rejects %s without automatic rebilling", async (variant) => {
  const f = await fixture(), provider = vi.spyOn(f.faux.provider, "streamSimple"), lease = await prepare(f);
  f.faux.setResponses([variant === "error" ? new Error("Fictional summary error") : fauxAssistantMessage([fauxText(variant === "malformed" ? "not JSON" : summaryText())],
    variant === "truncated" ? { stopReason: "length" } : {})]);
  expect((await lease.produceHandoffSummary(producerInput())).status).toBe("summary_rejected");
  await expect(lease.produceHandoffSummary(producerInput())).rejects.toThrow("no longer available"); expect(provider).toHaveBeenCalledOnce();
});
it("close waits for an active producer before closing native/MCP resources; run rejects without consumption", async () => {
  const f = await fixture(), endpoint = await mcp(), closed = vi.spyOn(Client.prototype, "close");
  let enter, release; const entered = new Promise((resolve) => { enter = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  f.faux.setResponses([async () => { enter(); await gate; return fauxAssistantMessage([fauxText(summaryText())]); }]);
  const lease = await prepare(f, { mcpServers: { fictional: { type: "http", url: endpoint.url } } });
  const production = lease.produceHandoffSummary(producerInput()); await entered;
  await expect(lease.run()).rejects.toThrow("still running"); let done = false; const closing = lease.close().then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false); expect(closed).not.toHaveBeenCalled();
  release(); expect((await production).status).toBe("ready"); await closing; expect(closed).toHaveBeenCalledOnce(); expect(await readdir(f.root)).toEqual([]);
});


it.each(["same", "different", "missing", "failure", "provider", "api", "short"])("long native run crosses the old window with %s-account refresh under the original store lock", async (variant) => {
  const f = await fixture("openai-codex", "openai-codex-responses"), now = Date.now(), requests = [];
  let credential = { type: "oauth", accountId: "fictional-selected", access: token("fictional-selected", 1), refresh: "fictional-old", expires: now + 10 * 60_000 + 5000 };
  let locked = false;
  const refresh = vi.fn(async (current) => {
    expect(locked).toBe(true); expect(current.refresh).toBe("fictional-rotated-by-peer");
    if (variant === "failure") throw new Error("Fictional refresh refusal");
    if (variant === "provider") models.getProvider("openai-codex").id = "foreign-provider";
    if (variant === "api") models.setProvider({ ...models.getProvider("openai-codex"), getModels: () => [{ ...f.faux.getModel(), api: "foreign-api" }] });
    const accountId = variant === "different" ? "fictional-other" : "fictional-selected";
    return { ...current, accountId: variant === "missing" ? undefined : accountId, access: token(accountId, 2), refresh: "fictional-next", expires: Date.now() + (variant === "short" ? 240000 : 3600000) };
  });
  const store = { read: vi.fn(async () => credential), list: async () => [], delete: vi.fn(), modify: vi.fn(async (id, update) => {
    expect(id).toBe("openai-codex"); expect(locked).toBe(false); locked = true;
    try { credential = await update(credential) ?? credential; return credential; } finally { locked = false; }
  }) };
  const models = createModels({ credentials: store });
  models.setProvider({ ...f.faux.provider, auth: { oauth: { refresh, toAuth: (value) => ({ apiKey: value.access }) } },
    streamSimple(model, context, options) { requests.push(options.apiKey); return f.faux.provider.streamSimple(model, context, options); } });
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const lease = await prepare(f, { piResolvedModels: models, allowedTools: ["Write"] }, createRuntime({ workspace: f.root }));
  const original = credential.access;
  f.faux.setResponses([() => { credential = { ...credential, refresh: "fictional-rotated-by-peer" }; clock.mockReturnValue(now + 6 * 60_000);
    return fauxAssistantMessage([fauxToolCall("Write", { file_path: "effect.txt", content: "Fictional effect once" })]); }, fauxAssistantMessage([fauxText("Refreshed success")])]);
  const result = await lease.run(); expect(await readFile(join(f.root, "effect.txt"), "utf8")).toBe("Fictional effect once");
  expect(store.modify).toHaveBeenCalledOnce(); expect(refresh).toHaveBeenCalledOnce();
  if (variant === "same") { expect(result.error).toBeNull(); expect(result.text).toBe("Refreshed success"); expect(requests).toEqual([original, credential.access]); }
  else { expect(result.failureKind).toBe("safety_prepared_credentials"); expect(result.error).toContain("Prepared credential refresh refused"); expect(requests).toEqual([original]); }
  if (variant === "different") expect(credential.accountId).toBe("fictional-other"); // Keep rotated tokens consistent, but do not use them in this lease.
});

it("locally rejects insufficient idle-age plus reserve after a resolver spent part of the token lifetime", async () => {
  const f = await fixture("openai-codex", "openai-codex-responses"), now = Date.now();
  const credential = { type: "oauth", accountId: "fictional-selected", access: token("fictional-selected", 1), expires: now + 10 * 60_000 + 5000 };
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const models = createModels({ credentials: { read: async () => credential, list: async () => [], delete: vi.fn(), modify: vi.fn() } });
  models.setProvider({ ...f.faux.provider, auth: { oauth: { refresh: vi.fn(), toAuth: (value) => { clock.mockReturnValue(now + 60_000); return { apiKey: value.access }; } } } });
  await expect(prepare(f, { piResolvedModels: models })).rejects.toThrow("expires too soon"); expect(await readdir(f.root)).toEqual([]);
});

it("forgotten idle native leases expire and close MCP/runState exactly once without provider/native mutation", async () => {
  const f = await fixture(), endpoint = await mcp(), closed = vi.spyOn(Client.prototype, "close"), provider = vi.spyOn(f.faux.provider, "streamSimple");
  // Capture just lease-age callbacks instead of advancing filesystem/network timers.
  const observed = [];
  const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, ms, ...args) => {
    const actual = originalTimer(callback, ms, ...args); if (ms > 290000 && ms <= 300000) observed.push({ callback, actual }); return actual;
  });
  const second = await prepare(f, { mcpServers: { fictional: { type: "http", url: endpoint.url } } });
  expect(observed).toHaveLength(1); expect(observed[0].actual.hasRef()).toBe(false);
  observed[0].callback(); await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce()); await second.close(); timer.mockRestore();
  expect(closed).toHaveBeenCalledOnce(); expect(provider).not.toHaveBeenCalled(); expect(await readdir(f.root)).toEqual([]);
  await expect(second.run()).rejects.toThrow("no longer available"); expect(closed).toHaveBeenCalledOnce();
});
const originalTimer = globalThis.setTimeout;


it("routed assertReady forwards the requested minimum start allowance without consuming the lease", async () => {
  const f = await fixture(), router = createRouterRuntime({ chain: [f.options.model], sessionTurnReconciliation: "v1",
    resolveAttempt: async () => ({ options: { piResolvedModel: f.faux.getModel(), piResolvedModels: f.models } }) });
  const lease = await prepare(f, {}, router), clock = vi.spyOn(Date, "now").mockReturnValue(lease.snapshot.expiresAt - 29999);
  expect(() => lease.assertReady(30000)).toThrow("start allowance"); expect(() => lease.assertReady(5000)).not.toThrow();
  clock.mockReturnValue(lease.snapshot.expiresAt - 30000); expect(() => lease.assertReady(30000)).not.toThrow();
  f.faux.setResponses([fauxAssistantMessage([fauxText("Routed allowance")])]); expect((await lease.run()).text).toBe("Routed allowance");
});

it.each(["dynamic-read-only", "lying-modify", "persisting-dynamic"])("in-lease OAuth refresh requires persisted modification: %s", async (kind) => {
  const f = await fixture("openai-codex", "openai-codex-responses"), now = Date.now();
  let credential = { type: "oauth", accountId: "fictional-selected", access: token("fictional-selected", 1), refresh: "fictional-old", expires: now + 10 * 60_000 + 5000 };
  const refresh = vi.fn(async () => ({ ...credential, access: token("fictional-selected", 2), refresh: "fictional-new", expires: Date.now() + 3600000 }));
  const modifier = vi.fn(async (_id, update) => { credential = await update(credential) ?? credential; return credential; });
  const resolver = Object.assign(async () => credential.access, { readCredential: async () => credential,
    ...(kind === "persisting-dynamic" ? { modifyCredential: modifier } : {}) });
  const store = kind === "lying-modify" ? { read: async () => credential, list: async () => [], delete: vi.fn(),
    modify: vi.fn(async (_id, update) => await update(credential) ?? credential) } : createDynamicCredentialStore(undefined, resolver, []);
  const models = createModels({ credentials: store }); models.setProvider({ ...f.faux.provider,
    auth: { oauth: { refresh, toAuth: (value) => ({ apiKey: value.access }) } } });
  const pin = await prepareDispatchAuth(models, f.faux.getModel()); vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60_000);
  if (kind === "persisting-dynamic") { expect((await pin.models.getAuth(pin.model)).auth.apiKey).toBe(credential.access); expect(modifier).toHaveBeenCalledOnce(); expect(refresh).toHaveBeenCalledOnce(); }
  else { await expect(pin.models.getAuth(pin.model)).rejects.toThrow("Prepared credential refresh refused"); expect(refresh).toHaveBeenCalledTimes(kind === "dynamic-read-only" ? 0 : 1); }
  if (kind === "dynamic-read-only") { await expect(store.modify("openai-codex", refresh)).rejects.toThrow("persisting credential resolver"); expect(refresh).not.toHaveBeenCalled(); }
});

it("installed pi-ai Codex oauth.refresh returns a complete typed OAuth credential without normalisation", async () => {
  const provider = openaiCodexProvider(), access = token("fictional-stock-account", 2);
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ access_token: access,
    refresh_token: "fictional-rotated", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } }));
  const refreshed = await provider.auth.oauth.refresh({ type: "oauth", accountId: "fictional-stock-account", access: token("fictional-stock-account", 1), refresh: "fictional-old", expires: 0 });
  expect(refreshed).toMatchObject({ type: "oauth", access, refresh: "fictional-rotated", accountId: "fictional-stock-account" });
  expect(refreshed.expires).toBeGreaterThan(Date.now() + 3500000); expect(fetch).toHaveBeenCalledOnce();
});
