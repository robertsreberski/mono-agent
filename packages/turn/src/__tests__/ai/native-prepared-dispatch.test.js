import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createRuntime } from "../../runtime.js";
import { createRouterRuntime } from "../../ai/runtime/router.js";
import { preparePiNativeDispatch, generateEngineTurnResponse } from "../../ai/providers/engine-turn.js";
import { resolveDurableNativeSessionRepo } from "../../engine/session-lifecycle.js";
import { refreshProviderSession } from "../../ai/runtime/sessions.js";
import { createPreparedDispatchLease, prepareDispatchAuth, copyDispatchData, freezeDispatchData } from "../../ai/providers/engine-turn/prepared-dispatch.js";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { Type } from "@earendil-works/pi-ai";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
async function fixture(provider = "faux", api) {
  const root = await mkdtemp(join(tmpdir(), "native-prepared-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const faux = fauxProvider({ provider, ...(api ? { api } : {}), models: [{ id: "fixture", ...(api ? { api } : {}), contextWindow: 100000, maxTokens: 4096 }], tokensPerSecond: undefined });
  const models = createModels(); models.setProvider(faux.provider);
  const options = { model: { provider, model: "fixture", reference: `${provider}:fixture` }, piResolvedModel: faux.getModel(), piResolvedModels: models,
    messages: [{ role: "user", content: "Current fictional input" }], sessionsRoot: root, allowedTools: [], effort: "none", compaction: { enabled: false } };
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
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  cleanups.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve(undefined)); }));
  return { url: `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}/mcp`, methods, calls };
}
/** @returns {Promise<import("../../contracts/runtime.js").NativePreparedDispatch & Required<Pick<import("../../contracts/runtime.js").NativePreparedDispatch, 'produceHandoffSummary'|'checkHandoffSummary'|'assertReady'>>>} */
async function prepare(f, extra = {}, runtime) {
  const lease = await (runtime ? runtime.prepareNativeDispatch("Fictional rules", { ...f.options, ...extra }) : preparePiNativeDispatch("Fictional rules", { ...f.options, ...extra }));
  cleanups.push(() => lease.close());
  if (!lease.produceHandoffSummary || !lease.checkHandoffSummary || !lease.assertReady) throw new Error("Expected prepared producer");
  return /** @type {import("../../contracts/runtime.js").NativePreparedDispatch & Required<Pick<import("../../contracts/runtime.js").NativePreparedDispatch, 'produceHandoffSummary'|'checkHandoffSummary'|'assertReady'>>} */ (lease);
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
  // @ts-expect-error Intentionally rejected binding shape.
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

it.each(["missing-provider", "missing-auth", "auth-error", "missing-model", "canonical-mismatch", "mcp-failure"])("fails preparation for %s before native creation", async (variant) => {
  const f = await fixture();
  if (variant === "missing-provider") vi.spyOn(f.models, "getProvider").mockReturnValue(undefined);
  if (variant === "missing-auth") f.models.setProvider({ ...f.faux.provider, auth: { apiKey: { name: "Fictional key", resolve: async () => undefined } } });
  if (variant === "auth-error") f.models.setProvider({ ...f.faux.provider, auth: { apiKey: { name: "Fictional key", resolve: async () => { throw new Error("Fictional auth failure"); } } } });
  if (variant === "canonical-mismatch") f.options.model = { provider: "other-fictional", model: "fixture", reference: "other-fictional:fixture" };
  if (variant === "missing-model") f.models.setProvider({ ...f.faux.provider, getModels: () => [] });
  if (variant === "mcp-failure") f.options.mcpServers = { broken: { type: "http", url: "http://127.0.0.1:9/mcp" } };
  await expect(prepare(f)).rejects.toThrow(); expect(await readdir(f.root)).toEqual([]);
});

const token = (account, generation) => `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account }, generation })).toString("base64url")}.fixture`;
it.each([false, true])("prepared requests use ordinary OAuth resolution, refreshing expiry=%s", async (expired) => {
  const f = await fixture("openai-codex", "openai-codex-responses"), requests = [];
  /** @type {import("@earendil-works/pi-ai").OAuthCredential} */
  let credential = { type: /** @type {const} */ ("oauth"), refresh: "fictional-refresh", access: token("fictional-account", 1), expires: Date.now() + 3600000 };
  const refresh = vi.fn(async (..._args) => ({ ...credential, access: token("fictional-other", 2), expires: Date.now() + 3600000 }));
  const store = { read: vi.fn(async () => credential), modify: vi.fn(async (_id, update) => { credential = await update(credential) ?? credential; return credential; }),
    delete: vi.fn(), list: async () => [] };
  const models = createModels({ credentials: store });
  models.setProvider({ ...f.faux.provider, auth: { oauth: { name: "Fictional OAuth", refresh, login: async () => credential, toAuth: async (value) => ({ apiKey: value.access }) } },
    streamSimple(model, context, options) { requests.push(options.apiKey); return f.faux.provider.streamSimple(model, context, options); } });
  const lease = await prepare(f, { piResolvedModels: models });
  credential = { ...credential, access: token("fictional-other", 3), expires: expired ? 0 : Date.now() + 3600000 };
  f.faux.setResponses([fauxAssistantMessage([fauxText("Ordinary OAuth")])]);
  expect((await lease.run()).text).toBe("Ordinary OAuth");
  expect(refresh).toHaveBeenCalledTimes(expired ? 1 : 0); expect(store.modify).toHaveBeenCalledTimes(expired ? 1 : 0);
  expect(requests).toEqual([credential.access]); expect(store.read.mock.calls.length).toBeGreaterThan(1);
  expect(lease.snapshot.provenance.account).toBeNull(); expect(JSON.stringify(lease.snapshot)).not.toContain("fixture.");
});

it("resolves ordinary API-key auth again at dispatch without capturing secrets", async () => {
  const f = await fixture(), requests = [];
  let apiKey = "fictional-before";
  const resolve = vi.fn(async (..._args) => ({ auth: { apiKey, baseUrl: "https://example.invalid/ordinary" } }));
  f.models.setProvider({ ...f.faux.provider, auth: { apiKey: { name: "Fictional key", resolve } }, streamSimple(model, context, options) {
    requests.push({ model, options }); return f.faux.provider.streamSimple(model, context, options); } });
  const lease = await prepare(f); expect(resolve).toHaveBeenCalledTimes(1);
  apiKey = "fictional-current"; f.faux.setResponses([fauxAssistantMessage([fauxText("Ordinary API key")])]);
  expect((await lease.run()).text).toBe("Ordinary API key"); expect(resolve).toHaveBeenCalledTimes(2);
  expect(requests[0].model.baseUrl).toBe("https://example.invalid/ordinary"); expect(requests[0].options.apiKey).toBe(apiKey);
  expect(JSON.stringify(lease.snapshot)).not.toContain("fictional-before"); expect(JSON.stringify(lease.snapshot)).not.toContain(apiKey);
});

it("opens only the late-bound current handle, preserving the frozen root and protected authority", async () => {
  const f = await fixture(), handle = "a".repeat(64), assertCurrent = vi.fn(async (..._args) => {});
  cleanups.push(() => refreshProviderSession(handle));
  const lease = await prepare(f);
  expect(assertCurrent).not.toHaveBeenCalled(); expect(await readdir(f.root)).toEqual([]);
  f.faux.setResponses([fauxAssistantMessage([fauxText("Current binding")])]);
  const result = await lease.run({ sessionId: handle, providerSessionId: handle, sessionKeepAlive: true,
    sessionTurn: { kind: "host", ownerKey: "fictional-owner", historyBucket: "fictional-bucket", turnId: "fictional-turn", handleId: handle, baseRevision: 0,
      reconciliation: { version: 1, purpose: "execution", fenceDigest: "c".repeat(64), initialInputId: "fictional-input" } },
    nativeSessionAuthority: { version: 1, currentHandleId: handle, sessionsRoot: f.root,
      hostAuthority: { version: 1, rootId: "1".repeat(64), authorityId: "2".repeat(64), ownerKey: "fictional-owner", historyBucket: "fictional-bucket" }, assertCurrent } });
  expect(result.error).toBeNull(); expect(assertCurrent).toHaveBeenCalled();
  expect(assertCurrent.mock.calls.every(([request]) => request.handleId === handle && request.sessionsRoot === f.root)).toBe(true);
});

it("prepares the certified router primary once, keeps resolver resources until settlement and never retries/backups", async () => {
  const f = await fixture(), cleanup = vi.fn(), resolveAttempt = vi.fn(async (..._args) => ({ options: { piResolvedModel: f.faux.getModel(), piResolvedModels: f.models }, cleanup }));
  const router = createRouterRuntime({ chain: [{ model: f.options.model, attempts: 3 }, { model: { provider: "faux", model: "backup", reference: "faux:backup" } }],
    resolveAttempt, sessionTurnReconciliation: "v1" });
  expect(router.prepareNativeDispatch).toBeTypeOf("function"); const lease = await prepare(f, {}, router);
  expect(resolveAttempt).toHaveBeenCalledTimes(1); expect(cleanup).not.toHaveBeenCalled();
  // @ts-expect-error Faux accepts thrown failures at runtime.
  f.faux.setResponses([new Error("Fictional terminal failure")]); const result = await lease.run(); expect(result.error).toBeTruthy();
  await lease.close(); expect(resolveAttempt).toHaveBeenCalledTimes(1); expect(cleanup).toHaveBeenCalledTimes(1);
});

it("does not certify an arbitrary router resolver from method presence", async () => {
  const f = await fixture(), resolveAttempt = vi.fn();
  const router = createRouterRuntime({ chain: [{ model: f.options.model }], resolveAttempt });
  await expect(router.prepareNativeDispatch("Rules", f.options)).rejects.toThrow("does not support"); expect(resolveAttempt).not.toHaveBeenCalled();
});


it("aborts during auth preparation and cleans already-resolved MCP resources before rejecting", async () => {
  const f = await fixture(), endpoint = await mcp(), controller = new AbortController(), closed = vi.spyOn(Client.prototype, "close");
  let entered; /** @type {(value?: any) => void} */ let release = () => {};
  const started = new Promise((resolve) => { entered = resolve; }), gate = new Promise((resolve) => { release = () => resolve(undefined); });
  f.models.setProvider({ ...f.faux.provider, auth: { apiKey: { name: "Fictional key", resolve: async () => { entered(); await gate; return { auth: {} }; } } } });
  const pending = prepare(f, { abortSignal: controller.signal, mcpServers: { fictional: { type: "http", url: endpoint.url } } });
  await started; controller.abort(new Error("Fictional setup cancellation")); release?.();
  await expect(pending).rejects.toThrow(); expect(closed).toHaveBeenCalledTimes(1); expect(await readdir(f.root)).toEqual([]);
});

it("close during a running dispatch waits without prematurely closing its MCP client", async () => {
  const f = await fixture(), endpoint = await mcp(), closed = vi.spyOn(Client.prototype, "close");
  let entered; /** @type {(value?: any) => void} */ let release = () => {};
  const started = new Promise((resolve) => { entered = resolve; }), gate = new Promise((resolve) => { release = () => resolve(undefined); });
  f.faux.setResponses([async () => { entered(); await gate; return fauxAssistantMessage([fauxText("Completed once")]); }]);
  const lease = await prepare(f, { mcpServers: { fictional: { type: "http", url: endpoint.url } } });
  const running = lease.run(); await started;
  let settled = false; const close = lease.close().then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false); expect(closed).not.toHaveBeenCalled(); release?.();
  expect((await running).text).toBe("Completed once"); await close; await lease.close(); expect(closed).toHaveBeenCalledTimes(1);
});


it("does not inspect, repair or detach an existing native session during preparation or unused close", async () => {
  const f = await fixture(), handle = "fictional-warm-handle";
  cleanups.push(() => refreshProviderSession(handle));
  f.faux.setResponses([fauxAssistantMessage([fauxText("Earlier fictional reply")])]);
  expect((await generateEngineTurnResponse("Earlier rules", { ...f.options, sessionId: handle, sessionKeepAlive: true })).error).toBeNull();
  const repo = resolveDurableNativeSessionRepo(f.root), metadata = (await repo.list())[0], original = await readFile(metadata.path);
  const listed = vi.spyOn(repo, "list"), opened = vi.spyOn(repo, "open"), created = vi.spyOn(repo, "create");
  const lease = await prepare(f, { sessionId: handle, sessionKeepAlive: true }); await lease.close();
  expect(listed).not.toHaveBeenCalled(); expect(opened).not.toHaveBeenCalled(); expect(created).not.toHaveBeenCalled();
  expect(await readFile(metadata.path)).toEqual(original);
});

it("cleans successfully initialized MCP clients when authentication then fails", async () => {
  const f = await fixture(), endpoint = await mcp(), closed = vi.spyOn(Client.prototype, "close");
  f.models.setProvider({ ...f.faux.provider, auth: { apiKey: { name: "Fictional key", resolve: async () => undefined } } });
  await expect(prepare(f, { mcpServers: { fictional: { type: "http", url: endpoint.url } } })).rejects.toThrow();
  expect(closed).toHaveBeenCalledTimes(1); expect(endpoint.methods).toContain("tools/list"); expect(await readdir(f.root)).toEqual([]);
});


it.each([false, true])("invalid binding retains the direct/routed lease and resource claim: routed=%s", async (routed) => {
  const f = await fixture(), cleanup = vi.fn(), closed = vi.spyOn(Client.prototype, "close"), endpoint = await mcp();
  const runtime = routed ? createRouterRuntime({ chain: [f.options.model], sessionTurnReconciliation: "v1",
    resolveAttempt: async () => ({ options: { piResolvedModel: f.faux.getModel(), piResolvedModels: f.models }, cleanup }) }) : undefined;
  const lease = await prepare(f, { mcpServers: { fictional: { type: "http", url: endpoint.url } } }, runtime);
  // @ts-expect-error Intentionally rejected binding shape.
  await expect(lease.run({ model: f.options.model })).rejects.toThrow("only host session binding");
  await expect(lease.run({ [Symbol("invalid-binding")]: true })).rejects.toThrow("only host session binding");
  await expect(lease.run(Object.create({ model: f.options.model }))).rejects.toThrow("only host session binding");
  // @ts-expect-error Intentionally throwing getter has no string return.
  await expect(lease.run({ get sessionId() { throw new Error("Fictional binding getter rejection"); } })).rejects.toThrow("binding getter rejection");
  expect(closed).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled(); expect(await readdir(f.root)).toEqual([]);
  f.faux.setResponses([fauxAssistantMessage([fauxText("Corrected binding")])]);
  expect((await lease.run()).text).toBe("Corrected binding");
  await lease.close(); expect(closed).toHaveBeenCalledTimes(1); expect(cleanup).toHaveBeenCalledTimes(routed ? 1 : 0);
  await expect(lease.run()).rejects.toThrow("no longer available");
});

it("routed prepared failure normalizes authentication and records one attempt without failover", async () => {
  const f = await fixture(), close = vi.fn(), run = vi.fn(async (..._args) => ({ error: "401 Unauthorized: invalid API key", failureKind: "provider_unavailable",
    text: null, events: [], usage: {}, cancelled: false }));
  const resolveAttempt = vi.fn(async (..._args) => ({ runtime: { run: vi.fn(), configureTools: vi.fn(), nativePreparedDispatch: "v1",
    prepareNativeDispatch: async () => ({ snapshot: {}, run, close }) } }));
  const router = createRouterRuntime({ chain: [{ model: f.options.model, attempts: 3 }, { model: { provider: "faux", model: "backup", reference: "faux:backup" } }],
    // @ts-expect-error Deliberately partial rejecting runtime double.
    resolveAttempt, sessionTurnReconciliation: "v1" });
  const lease = await router.prepareNativeDispatch("Rules", f.options), result = await lease.run();
  expect(result.failureKind).toBe("provider_auth");
  expect(result.failoverHistory).toMatchObject([{ model: f.options.model, failureKind: "provider_auth" }]);
  expect(run).toHaveBeenCalledOnce(); expect(resolveAttempt).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
});

it.each([false, true])("close settles rather than rethrowing a consumed run's rejection: routed=%s", async (routed) => {
  const direct = await createPreparedDispatchLease(async ({ ready }) => { await ready({}); throw new Error("Fictional execution rejection"); }, undefined);
  const f = await fixture(), router = createRouterRuntime({ chain: [f.options.model], sessionTurnReconciliation: "v1",
  // @ts-expect-error Deliberately partial runtime double.
    resolveAttempt: async () => ({ runtime: { run: vi.fn(), configureTools: vi.fn(), prepareNativeDispatch: async () => direct } }) });
  const lease = routed ? await router.prepareNativeDispatch("Fictional rules", f.options) : direct;
  await expect(lease.run()).rejects.toThrow("Fictional execution rejection");
  await expect(lease.close()).resolves.toBeUndefined(); await expect(lease.close()).resolves.toBeUndefined();
});

it("keeps a prepared lease valid after a long delay without pinning auth", async () => {
  const f = await fixture(), lease = await prepare(f), now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 10 * 60_000);
  expect(() => lease.assertReady()).not.toThrow();
  expect(lease.snapshot).not.toHaveProperty("expiresAt");
  f.faux.setResponses([fauxAssistantMessage([fauxText("Delayed dispatch")])]);
  expect((await lease.run()).text).toBe("Delayed dispatch");
});

it("preserves prototype methods and their original private-field receiver", async () => {
  const f = await fixture();
  class Provider {
    #delegate = f.faux.provider;
    get id() { return this.#delegate.id; }
    get auth() { return this.#delegate.auth; }
    getModels() { return this.#delegate.getModels(); }
    get name() { return this.#delegate.name; }
    stream(model, context, options) { return this.#delegate.stream(model, context, options); }
    streamSimple(model, context, options) { return this.#delegate.streamSimple(model, context, options); }
  }
  const models = createModels(); models.setProvider(new Provider());
  const pin = await prepareDispatchAuth(models, f.faux.getModel(), undefined);
  f.faux.setResponses([fauxAssistantMessage([fauxText("Prototype preserved")])]);
  const result = await pin.models.completeSimple(pin.model, { messages: [{ role: "user", content: "Fictional input", timestamp: 0 }] });
  expect(result.errorMessage).toBeUndefined();
  expect(result).toMatchObject({ stopReason: "stop" });
  expect(result.content[0].text).toBe("Prototype preserved");
});

it("real Codex provider serializes frozen TypeBox/StructuredOutput declarations without mutation", async () => {
  const provider = openaiCodexProvider(), model = provider.getModels()[0], schema = Type.Object({ answer: Type.String() }, { additionalProperties: false });
  const legacyKind = Symbol.for("TypeBox.Kind"), declaration = Type.Unsafe(schema);
  declaration[legacyKind] = "Object"; /** @type {any} */ (declaration).properties.answer[legacyKind] = "String";
  const parameters = freezeDispatchData(copyDispatchData(declaration));
  expect(parameters[legacyKind]).toBe("Object"); expect(parameters.properties.answer[legacyKind]).toBe("String");
  expect(parameters["~kind"]).toBe(schema["~kind"]); expect(parameters.properties.answer["~kind"]).toBe("String");
  const credential = { type: /** @type {const} */ ("oauth"), access: token("fictional-account", 1), expires: Date.now() + 3600000, refresh: "fictional-refresh" };
  const models = createModels({ credentials: { read: async () => credential, list: async () => [], delete: vi.fn(), modify: vi.fn() } }); models.setProvider(provider);
  const pin = await prepareDispatchAuth(models, model, undefined), payload = vi.fn();
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Fictional transport refusal", { status: 400 }));
  const result = await pin.models.completeSimple(pin.model, { messages: [{ role: "system", content: "Fictional instructions",
    toolsAdded: [{ name: "StructuredOutput", description: "Fictional structure", parameters }] }, { role: "user", content: "Fictional input", timestamp: 0 }] },
    { transport: "sse", maxRetries: 0, onPayload: payload });
  expect(result.errorMessage).toContain("Fictional transport refusal"); expect(fetch).toHaveBeenCalledOnce();
  expect(payload).toHaveBeenCalledOnce(); expect(payload.mock.calls[0][0].tools[0].parameters).toMatchObject({ type: "object", required: ["answer"] });
  expect(parameters["~kind"]).toBe(schema["~kind"]); expect(parameters.properties.answer["~kind"]).toBe("String"); expect(Object.isFrozen(parameters.properties.answer)).toBe(true);
});

/** @returns {import("../../contracts/runtime.js").NativeHandoffProducerRequest} */
const producerInput = () => ({ prepared: { status: "prepared", checkpoints: [], ledger: [{ kind: "tool", outcome: "unknown" }],
  recent: [], older: [], coverage: [] }, outputReserve: 256 });
const summaryText = () => JSON.stringify(Object.fromEntries(["intent", "constraints", "decisions", "completedWork", "failures", "openWork", "nextActions", "references"]
  .map((key) => [key, key === "intent" ? ["Fictional pending work"] : []])));
it.each([false, true])("one typed prepared producer uses ordinary auth, no tools/session/retry and leaves dispatch reusable: routed=%s", async (routed) => {
  const f = await fixture(), requests = [], resolve = vi.fn(async (..._args) => ({ auth: { apiKey: "fictional-ordinary-producer" } }));
  f.models.setProvider({ ...f.faux.provider, auth: { apiKey: { name: "Fictional key", resolve } }, streamSimple(model, context, options) {
    requests.push({ model, context, options }); return f.faux.provider.streamSimple(model, context, options); } });
  const router = routed ? createRouterRuntime({ chain: [{ model: f.options.model, attempts: 3 }], sessionTurnReconciliation: "v1",
    resolveAttempt: async () => ({ options: { piResolvedModel: f.faux.getModel(), piResolvedModels: f.models } }) }) : undefined;
  const lease = await prepare(f, { allowedTools: ["Read"], piTransport: "auto" }, router), input = producerInput();
  expect(lease.checkHandoffSummary(input)).toEqual({ status: "ready" }); expect(await readdir(f.root)).toEqual([]);
  f.faux.setResponses([fauxAssistantMessage([fauxText(summaryText())]), fauxAssistantMessage([fauxText("Incoming dispatch")])]);
  const result = await lease.produceHandoffSummary(input); expect(result.status).toBe("ready");
  expect(requests[0].context.messages[0].toolsAdded ?? []).toEqual([]); expect(requests[0].options.maxRetries).toBe(0); expect(requests[0].options.transport).toBe("sse");
  expect(requests[0].options.apiKey).toBe("fictional-ordinary-producer"); expect(resolve).toHaveBeenCalledTimes(2);
  expect(await readdir(f.root)).toEqual([]); await expect(lease.produceHandoffSummary(input)).rejects.toThrow("no longer available");
  expect((await lease.run()).text).toBe("Incoming dispatch"); expect(requests).toHaveLength(2); expect(resolve).toHaveBeenCalledTimes(3);
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
  // @ts-expect-error Faux accepts thrown failures at runtime.
  f.faux.setResponses([variant === "error" ? new Error("Fictional summary error") : fauxAssistantMessage([fauxText(variant === "malformed" ? "not JSON" : summaryText())],
    variant === "truncated" ? { stopReason: "length" } : {})]);
  expect((await lease.produceHandoffSummary(producerInput())).status).toBe("summary_rejected");
  await expect(lease.produceHandoffSummary(producerInput())).rejects.toThrow("no longer available"); expect(provider).toHaveBeenCalledOnce();
});
it("close waits for an active producer before closing native/MCP resources; run rejects without consumption", async () => {
  const f = await fixture(), endpoint = await mcp(), closed = vi.spyOn(Client.prototype, "close");
  let enter; /** @type {(value?: any) => void} */ let release = () => {}; const entered = new Promise((resolve) => { enter = resolve; }), gate = new Promise((resolve) => { release = () => resolve(undefined); });
  f.faux.setResponses([async () => { enter(); await gate; return fauxAssistantMessage([fauxText(summaryText())]); }]);
  const lease = await prepare(f, { mcpServers: { fictional: { type: "http", url: endpoint.url } } });
  const production = lease.produceHandoffSummary(producerInput()); await entered;
  await expect(lease.run()).rejects.toThrow("still running"); let done = false; const closing = lease.close().then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false); expect(closed).not.toHaveBeenCalled();
  release?.(); expect((await production).status).toBe("ready"); await closing; expect(closed).toHaveBeenCalledOnce(); expect(await readdir(f.root)).toEqual([]);
});


it("idle native leases have no expiry timer and close MCP/runState exactly once", async () => {
  const f = await fixture(), endpoint = await mcp(), closed = vi.spyOn(Client.prototype, "close"), provider = vi.spyOn(f.faux.provider, "streamSimple");
  const observed = [];
  const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, ms, ...args) => {
    const actual = originalTimer(callback, ms, ...args); if (ms > 290000 && ms <= 300000) observed.push(actual); return actual;
  });
  const lease = await prepare(f, { mcpServers: { fictional: { type: "http", url: endpoint.url } } });
  expect(observed).toHaveLength(0); expect(closed).not.toHaveBeenCalled();
  await lease.close(); await lease.close(); timer.mockRestore();
  expect(closed).toHaveBeenCalledOnce(); expect(provider).not.toHaveBeenCalled(); expect(await readdir(f.root)).toEqual([]);
  await expect(lease.run()).rejects.toThrow("no longer available");
});
const originalTimer = globalThis.setTimeout;


it("routed assertReady checks availability after a long delay without consuming the lease", async () => {
  const f = await fixture(), router = createRouterRuntime({ chain: [f.options.model], sessionTurnReconciliation: "v1",
    resolveAttempt: async () => ({ options: { piResolvedModel: f.faux.getModel(), piResolvedModels: f.models } }) });
  const lease = await prepare(f, {}, router);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000);
  expect(() => lease.assertReady()).not.toThrow();
  f.faux.setResponses([fauxAssistantMessage([fauxText("Routed delayed dispatch")])]);
  expect((await lease.run()).text).toBe("Routed delayed dispatch");
});

it("installed pi-ai Codex oauth.refresh returns a complete typed OAuth credential without normalisation", async () => {
  const provider = openaiCodexProvider(), access = token("fictional-stock-account", 2);
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ access_token: access,
    refresh_token: "fictional-rotated", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } }));
  // @ts-expect-error The installed provider accepts an omitted refresh signal.
  const refreshed = await provider.auth.oauth.refresh({ type: /** @type {const} */ ("oauth"), accountId: "fictional-stock-account", access: token("fictional-stock-account", 1), refresh: "fictional-old", expires: 0 });
  expect(refreshed).toMatchObject({ type: /** @type {const} */ ("oauth"), access, refresh: "fictional-rotated", accountId: "fictional-stock-account" });
  expect(refreshed.expires).toBeGreaterThan(Date.now() + 3500000); expect(fetch).toHaveBeenCalledOnce();
});

it.each([false, true])("recovers one empty reply on the prepared path without tools or router failover: routed=%s", async (routed) => {
  const f = await fixture("anthropic"), requests = [];
  const runtime = routed ? createRouterRuntime({ chain: [{ model: f.options.model, attempts: 3 },
    { model: { provider: "openai", model: "backup", reference: "openai:backup" } }] }) : createRuntime();
  f.faux.setResponses([
    (context) => { requests.push(context); return fauxAssistantMessage([]); },
    (context) => { requests.push(context); return fauxAssistantMessage([fauxText("Fictional recovered reply")]); },
  ]);
  const lease = await prepare(f, { allowedTools: ["Read"], prompts: { emptyReplyFinalization: () => "Fictional final reply nudge" } }, runtime);
  const result = await lease.run();
  expect(result.error).toBeNull(); expect(result.text).toBe("Fictional recovered reply"); expect(requests).toHaveLength(2);
  expect(requests[0].messages[0].toolsAdded.map((tool) => tool.name)).toEqual(["Read"]);
  const activeTools = new Set();
  for (const message of requests[1].messages) {
    for (const tool of message.toolsAdded ?? []) activeTools.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) activeTools.delete(tool);
  }
  expect([...activeTools]).toEqual([]);
  expect(JSON.stringify(requests[1].messages)).toContain("Fictional final reply nudge");
  expect(result.events.some((event) => event.type === "user" && JSON.stringify(event).includes("Fictional final reply nudge"))).toBe(false);
  expect(result.runtimeWarnings).toContainEqual(expect.objectContaining({ warning_kind: "empty_reply_retry", outcome: "text" }));
  if (routed) expect(result.failoverHistory).toEqual([]);
});


it("prepared OpenCode requests attribute the bound id rather than the preparation id", async () => {
  const f = await fixture("opencode-go"), headers = [];
  f.models.setProvider({ ...f.faux.provider, streamSimple(model, context, options) {
    headers.push(options.headers); return f.faux.provider.streamSimple(model, context, options);
  } });
  const lease = await prepare(f, { providerAttributionSessionId: "fictional-preparation-id" });
  f.faux.setResponses([fauxAssistantMessage([fauxText("Fictional bound reply")])]);
  expect((await lease.run({ providerAttributionSessionId: "fictional-bound-id" })).text).toBe("Fictional bound reply");
  expect(headers).toEqual([{ "x-opencode-session": "fictional-bound-id", "x-opencode-client": "mono-agent" }]);
});
