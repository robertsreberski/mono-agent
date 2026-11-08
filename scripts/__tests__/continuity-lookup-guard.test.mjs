import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Socket } from "node:net";
import { guardedLookupModels, LOOKUP_GUARD_POLICY_REFUSALS, LOOKUP_PRE_SEND_REFUSALS, LOOKUP_ASSUMPTIONS as A, LOOKUP_GUARD_CONTRACT as C, lookupInputEnvelope, lookupBodyDigest,
  createTestOnlyLookupPermitSource, assertRealLookupPermitSource, assertLookupAuxiliaryCallersOff, assertLookupChildSafety, lookupSettledCost } from "../lib/continuity-lookup-guard.mjs";
import { fauxLookupSafety, lookupForwardedObserver } from "../lib/continuity-lookup-pilot-runtime.mjs";
import { lookupWitness } from "../lib/continuity-lookup.mjs";
let network, fetch;
beforeEach(() => {
  network = vi.spyOn(Socket.prototype, "connect").mockImplementation(() => { throw Error("egress_denied"); });
  fetch = vi.fn(() => { throw Error("egress_denied"); }); vi.stubGlobal("fetch", fetch);
});
afterEach(() => { expect(network).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const model = { provider: C.provider, id: C.model, api: C.api, baseUrl: C.baseUrl };
const payload = () => ({ model: C.model, store: false, stream: true, reasoning: { effort: "high" }, instructions: "Fictional instructions.", input: [{ role: "user", content: "Fictional input." }] });
function sized(U) { const p = payload(); p.input[0].content += "x".repeat(U - lookupInputEnvelope(p).U); return p; }
const message = (stopReason = "stop", text = "Fictional answer.") => ({ stopReason, content: [{ type: "text", text }] });
const usage = (input_tokens = 1, output_tokens = 1) => ({ input_tokens, output_tokens });
function fixture({ body = payload(), raw = usage(), tier = "default", event = "response.completed", final = message(), failure, mutate, noSend = false, doubleSend = false, duplicateTerminal = false, repeatedPayload = false, sendUrl, sendHeaders, skipPayload = false, contractPatch = {}, onForwarded, permitSource, resolvedSafety, sendBody = value => value } = {}) {
  const permit = permitSource ?? createTestOnlyLookupPermitSource(), send = vi.fn(async () => new Response(""));
  const underlying = { streamSimple: vi.fn((_m, _c, options) => {
    const result = (async () => {
      try {
        if (skipPayload) { await options.fetch(`${C.baseUrl}/codex/responses`, { method: "POST", body: "{}" }); return final; }
        const p = await options.onPayload(body, model);
        if (repeatedPayload) await options.onPayload(body, model);
        mutate?.(p);
        if (noSend) throw Error("fictional_before_send_abort");
        await options.fetch(sendUrl ?? `${C.baseUrl}/codex/responses`, { method: "POST", headers: sendHeaders, body: sendBody(JSON.stringify(p)) });
        if (doubleSend) await options.fetch(sendUrl ?? `${C.baseUrl}/codex/responses`, { method: "POST", headers: sendHeaders, body: sendBody(JSON.stringify(p)) });
        if (failure) { failure(options); throw Error("fictional_stream_failure"); }
        await options.onProviderStreamEvent({ type: event, response: { usage: raw, ...(tier !== "OMIT" ? { service_tier: tier } : {}) } }, model);
        if (duplicateTerminal) await options.onProviderStreamEvent({ type: event, response: { usage: raw, service_tier: tier } }, model);
        return final;
      } catch { return message("error"); }
    })();
    return { result: () => result, async *[Symbol.asyncIterator]() { yield { type: "done", message: await result }; } };
  }), getModel: () => model };
  const guarded = guardedLookupModels(underlying, { contract: { ...C, slotId: "fictional-slot", runId: "fictional-run", ...contractPatch }, permit, send, resolvedSafety, onForwarded });
  const options = { reasoning: "high", transport: "sse", maxRetries: 0 };
  return { guarded, permit, send, underlying, options, call: (overrides = {}, context = {}) => guarded.streamSimple(model, context, { ...options, ...overrides }).result() };
}
const settles = f => f.permit.events.filter(e => e.type === "settle");
it.each([271999, 272000, 272001])("gates final U=%i after all payload mutations", async U => {
  const f = fixture({ body: sized(U) });
  if (U > A.inputMax) { await expect(f.call()).rejects.toThrow("not_admitted_input_envelope"); expect(f.permit.events).toEqual([]); expect(f.send).not.toHaveBeenCalled(); }
  else { await f.call(); expect(f.send).toHaveBeenCalledOnce(); expect(settles(f)[0].outcome.kind).toBe("settled"); }
});
it("counts H across input, reasoning, tools, nested schema properties and instructions", () => {
  const p = payload(); p.input.push({ type: "reasoning", encrypted_content: "FAKE" });
  p.tools = [{ type: "function", parameters: { properties: { outer: { properties: { inner: {} } } } } }];
  const { H } = lookupInputEnvelope(p);
  expect(H).toBe(4096 + 2 * 256 + 1024 + 1024 + 2 * 256 + 4096);
});
it("refuses initial reasoning without a hold", async () => {
  const body = payload(); body.input.push({ type: "reasoning", encrypted_content: "FAKE" }); const f = fixture({ body });
  await expect(f.call()).rejects.toThrow("lookup_initial_reasoning_forbidden"); expect(f.permit.events).toEqual([]);
});
it("admits request ten and refuses eleven without hold or send", async () => {
  const f = fixture(); for (let i = 0; i < 10; i++) await f.call();
  expect(f.send).toHaveBeenCalledTimes(10); expect(settles(f)).toHaveLength(10);
  expect(() => f.call()).toThrow("lookup_request_limit"); expect(f.permit.events.filter(e => e.type === "admit")).toHaveLength(10);
});
it.each([undefined, { input_tokens: 1 }, { input_tokens: 1, output_tokens: "1" }])("never substitutes normalized zero usage for missing raw usage (%j)", async raw => {
  const f = fixture({ raw: null }); // null represents missing raw response usage
  const g = raw ? fixture({ raw }) : f;
  await g.call(); expect(settles(g)[0].outcome.kind).toBe("lost");
  expect(() => g.call()).toThrow("lookup_slot_terminal"); expect(g.send).toHaveBeenCalledOnce();
});
it.each(["response.failed", "response.output_text.done"])("does not settle from %s", async event => {
  const f = fixture({ event }); await f.call(); expect(settles(f)[0].outcome.kind).toBe("lost");
});
it.each([[null, 2], ["OMIT", 2], ["default", 1], ["flex", 0.5], ["priority", 2]])("accounts tier %s conservatively", async (tier, multiplier) => {
  const f = fixture({ tier, raw: usage(10, 20) });
  await f.call(); expect(settles(f)[0].outcome.cost).toBe(lookupSettledCost(usage(10, 20), "default") * multiplier);
});
it("unknown tier is a sticky integrity stop", async () => {
  const f = fixture({ tier: "unknown" }); await expect(f.call()).rejects.toThrow("lookup_unknown_tier");
  expect(settles(f)[0].outcome.kind).toBe("integrity_stop"); expect(() => f.call()).toThrow("lookup_stopped");
});
it.each([128000, 128001])("checks output boundary %i", async output => {
  const f = fixture({ raw: usage(1, output) });
  if (output === 128000) await f.call(); else await expect(f.call()).rejects.toThrow("lookup_output_envelope_violated");
});
it("checks cached-inclusive input against U", async () => {
  const body = payload(), U = lookupInputEnvelope(body).U;
  const f = fixture({ body, raw: { ...usage(U + 1, 1), input_tokens_details: { cached_tokens: U } } });
  await expect(f.call()).rejects.toThrow("lookup_input_envelope_violated");
});
it("checks reasoning <= output", async () => {
  const f = fixture({ raw: { ...usage(), output_tokens_details: { reasoning_tokens: 2 } } });
  await expect(f.call()).rejects.toThrow("lookup_reasoning_envelope_violated");
});
it("settles exact hold and stops above it (never double-counts reasoning)", async () => {
  const raw = { ...usage(272000, 128000), input_tokens_details: { cache_write_tokens: 272000 }, output_tokens_details: { reasoning_tokens: 128000 } };
  expect(lookupSettledCost(raw, "priority")).toBe(3.92);
  expect(lookupSettledCost({ ...raw, output_tokens: 128001 }, "priority")).toBeGreaterThan(3.92);
  const f = fixture({ body: sized(272000), raw, tier: "priority" }); await f.call(); expect(settles(f)[0].outcome.cost).toBe(3.92);
  const g = fixture({ body: sized(272000), raw: { ...raw, output_tokens: 128001 }, tier: "priority" }); await expect(g.call()).rejects.toThrow(); expect(settles(g)[0].outcome.kind).toBe("integrity_stop");
});
it("adds settled outputs to the next envelope", async () => {
  const f = fixture({ body: sized(271999), raw: usage(1, 2) }); await f.call();
  await expect(f.call()).rejects.toThrow("not_admitted_input_envelope"); expect(f.send).toHaveBeenCalledOnce();
});
it("composes hooks and refuses onPayload exceptions without hold or pilot stop", async () => {
  const f = fixture(); await expect(f.call({ onPayload() { throw Error("fictional_hook_refusal"); } })).rejects.toThrow("fictional_hook_refusal");
  expect(f.permit.events).toEqual([]); expect(f.send).not.toHaveBeenCalled(); await f.call();
  const hook = vi.fn(); await f.call({ onProviderStreamEvent: hook }); expect(hook).toHaveBeenCalledOnce();
});
it("gates the payload returned by the last mutation hook", async () => {
  const f = fixture(); await expect(f.call({ onPayload: () => sized(272001) })).rejects.toThrow("not_admitted_input_envelope"); expect(f.send).not.toHaveBeenCalled();
});
it("detects late mutation before injected network", async () => {
  const f = fixture({ mutate: p => { p.instructions += "late"; } }); await expect(f.call()).rejects.toThrow("lookup_body_mismatch"); expect(f.send).not.toHaveBeenCalled();
});
it("consumes once and binds the body digest", () => {
  const p = createTestOnlyLookupPermitSource(), digest = lookupBodyDigest(Buffer.from("fictional"));
  const grant = p.admit({ requestId: "fictional", payloadDigest: digest });
  expect(() => p.consume(grant, "wrong")).toThrow("lookup_permit_invalid"); p.consume(grant, digest);
  expect(() => p.consume(grant, digest)).toThrow("lookup_permit_invalid");
});
it.each(["completeSimple", "complete", "stream", "streamDeferred", "fetchDeferred", "cancelDeferred", "setProvider"])("refuses method %s", method => {
  const f = fixture(); expect(() => f.guarded[method]()).toThrow("lookup_method_forbidden"); expect(f.underlying.streamSimple).not.toHaveBeenCalled();
});
it.each([["stop", ""], ["length", "Fictional partial."]])("refuses %s finalization", async (stop, text) => {
  const f = fixture({ final: message(stop, text) }); await f.call();
  let refusal;
  try { f.call(); } catch (error) { refusal = error; }
  expect(refusal).toMatchObject({ code: "pilot_empty_final_output", classification: "failed/pilot_empty_final_output" });
  expect(f.send).toHaveBeenCalledOnce();
});
it("own abort after send retains hold without pilot stop", async () => {
  const controller = new AbortController(); const f = fixture({ failure: () => controller.abort() });
  await expect(f.call({ signal: controller.signal })).resolves.toMatchObject({ stopReason: "error" });
  expect(() => f.call()).toThrow("lookup_slot_terminal");
  expect(settles(f)[0].outcome.kind).toBe("own_abort_after_send"); expect(f.permit.events.some(e => e.type === "stop")).toBe(false);
});
it("admission followed by abort before fetch is lost, never released", async () => {
  const f = fixture({ noSend: true }); await expect(f.call()).resolves.toMatchObject({ stopReason: "error" }); expect(settles(f)[0].outcome.kind).toBe("lost"); expect(f.send).not.toHaveBeenCalled();
});
it("faux is branded and refused by the real-route guard", () => { expect(() => assertRealLookupPermitSource(createTestOnlyLookupPermitSource())).toThrow("lookup_faux_permit_forbidden"); });
it("asserts auxiliary callers in parent and child", () => {
  const settings = { plan: { judge: null }, memory: false, subagents: false, upkeep: false, compaction: false, outputSchema: null };
  for (const helper of [assertLookupAuxiliaryCallersOff, assertLookupChildSafety]) {
    expect(() => helper(settings)).not.toThrow();
    for (const key of ["memory", "subagents", "upkeep", "compaction", "outputSchema"]) expect(() => helper({ ...settings, [key]: true })).toThrow("lookup_auxiliary_callers_forbidden");
    expect(() => helper({ ...settings, plan: { judge: {} } })).toThrow("lookup_auxiliary_callers_forbidden");
  }
});
it.each([{ transport: "auto" }, { maxRetries: 1 }, { reasoning: "low" }, { context1MModels: {} }, { fallbacks: [] }, { model: "other" }, { serviceTier: "priority" }])("rejects route/options overrides %j", options => {
  const f = fixture(); expect(() => f.call(options)).toThrow(); expect(f.send).not.toHaveBeenCalled();
});

it("settles incomplete terminal events using raw usage", async () => {
  const f = fixture({ event: "response.incomplete" }); await f.call(); expect(settles(f)[0].outcome.kind).toBe("settled");
});
it("cap refusal creates neither hold nor send and is not sticky", async () => {
  const source = createTestOnlyLookupPermitSource(); let refuse = true;
  const permit = { ...source, admit: request => refuse ? { refused: true, code: "not_admitted_cap" } : source.admit(request) };
  const f = fixture({ permitSource: permit }); await expect(f.call()).rejects.toThrow("not_admitted_cap");
  expect(source.events).toEqual([]); expect(f.send).not.toHaveBeenCalled(); refuse = false; await f.call();
});
it("settlement transport failure closes local admission even if controller stop also fails", async () => {
  const source = createTestOnlyLookupPermitSource();
  const f = fixture({ permitSource: { ...source, settle: async () => { throw Error("fictional_ipc_disconnect"); }, stop: async () => { throw Error("fictional_ipc_disconnect"); } } });
  await expect(f.call()).rejects.toThrow("lookup_settlement_failed"); expect(() => f.call()).toThrow("lookup_stopped"); expect(f.send).toHaveBeenCalledOnce();
});
it.each(["provider", "id", "api", "baseUrl", "contextWindow"])("asserts model field %s on each request", field => {
  const f = fixture(); expect(() => f.guarded.streamSimple({ ...model, [field]: "fictional-other" }, {}, f.options)).toThrow("lookup_route_mismatch"); expect(f.send).not.toHaveBeenCalled();
});
it("snapshots toJSON only once before envelope and digest", async () => {
  const f = fixture(); let calls = 0;
  await f.call({ onPayload: () => ({ toJSON() { calls++; return calls === 1 ? payload() : sized(272001); } }) });
  expect(calls).toBe(1); expect(f.send).toHaveBeenCalledOnce();
});
it("refuses concurrent requests while settlement is in flight", async () => {
  const f = fixture(); const first = f.call(); expect(() => f.call()).toThrow("lookup_concurrent_request"); await first;
});
it.each([
  { type: "input_image", image_url: "https://example.invalid/fictional" },
  { type: "item_reference", id: "fictional" },
  { role: "user", content: [{ type: "input_file", file_id: "fictional" }] },
])("refuses nonliteral input without admission", async item => {
  const body = payload(); body.input = [item]; const f = fixture({ body });
  await expect(f.call()).rejects.toThrow("lookup_payload_forbidden"); expect(f.permit.events).toEqual([]);
});

it("reusing a consumed permit at fetch cannot send twice", async () => {
  const f = fixture({ doubleSend: true }); await expect(f.call()).rejects.toThrow("lookup_permit_invalid"); expect(f.send).toHaveBeenCalledOnce(); expect(settles(f)[0].outcome.kind).toBe("integrity_stop");
});
it("a thrown failed response is lost, never zero-usage settlement", async () => {
  const f = fixture({ failure: () => {} }); await expect(f.call()).resolves.toMatchObject({ stopReason: "error" }); expect(settles(f)[0].outcome.kind).toBe("lost");
});
it("pins assumed-v1 rates, strict tier threshold and output max to the installed catalog without auth or dispatch", async () => {
  const pi = fileURLToPath(new URL("../../packages/turn/node_modules/@earendil-works/pi-ai/", import.meta.url));
  const pkg = JSON.parse(await readFile(join(pi, "package.json"), "utf8"));
  const { openaiCodexProvider } = await import(pathToFileURL(join(pi, pkg.exports["./providers/*"].import.replace("*", "openai-codex"))).href);
  const provider = openaiCodexProvider();
  const selected = provider.getModels().find(m => m.id === C.model);
  expect(selected.contextWindow).toBe(A.inputMax); expect(selected.maxTokens).toBe(A.outputMax);
  for (const [key, rate] of Object.entries(A.rates)) expect(selected.cost[key]).toBe(rate);
  expect(selected.cost.tiers.every(t => t.inputTokensAbove >= A.inputMax)).toBe(true);
  expect(2 * (A.inputMax * Math.max(A.rates.input, A.rates.cacheRead, A.rates.cacheWrite) + A.outputMax * A.rates.output) / 1000000).toBe(A.rmax);
});

it("settles before terminal iterator delivery even without result() consumption", async () => {
  const f = fixture();
  for await (const event of f.guarded.streamSimple(model, {}, f.options)) { expect(event.type).toBe("done"); expect(settles(f)).toHaveLength(1); }
  await f.call(); expect(f.send).toHaveBeenCalledTimes(2);
});
it("captures raw usage before a composed hook can mutate it", async () => {
  const f = fixture({ raw: usage(10, 20) });
  await f.call({ onProviderStreamEvent: event => { event.response.usage.output_tokens = 0; event.response.service_tier = "unknown"; } });
  expect(settles(f)[0].rawUsage.output_tokens).toBe(20); expect(settles(f)[0].tier).toBe("default");
});

it("unknown raw terminal tier stops even when usage is missing", async () => {
  const f = fixture({ raw: null, tier: "unknown" }); await expect(f.call()).rejects.toThrow("lookup_unknown_tier"); expect(settles(f)[0].outcome.kind).toBe("integrity_stop");
});
it("refuses payload-level non-SSE and output-schema overrides before admission", async () => {
  for (const override of [{ stream: false }, { text: { format: { type: "json_schema" } } }]) {
    const f = fixture({ body: { ...payload(), ...override } }); await expect(f.call()).rejects.toThrow("lookup_payload_forbidden"); expect(f.permit.events).toEqual([]);
  }
});

it("permit records allowlist numeric raw usage and fixed tier values only", async () => {
  const f = fixture({ raw: { ...usage(), extra: "Fictional event extension.", input_tokens_details: { cached_tokens: 0, extra: "Fictional extension." } } });
  await f.call(); expect(settles(f)[0].rawUsage).toEqual({ ...usage(), input_tokens_details: { cached_tokens: 0 } });
  const g = fixture({ tier: "Fictional unknown tier." }); await expect(g.call()).rejects.toThrow("lookup_unknown_tier"); expect(settles(g)[0].tier).toBeNull();
});

it("refuses caller fetch even when it is undefined, and never enters the provider", () => {
  for (const fetch of [undefined, vi.fn()]) {
    const f = fixture(); expect(() => f.call({ fetch })).toThrow("lookup_external_fetch_forbidden");
    expect(f.underlying.streamSimple).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  }
});
it.each([{ piMaxRetries: 1 }, { maxRetries: 1 }, { piRequestRetryBudgetMs: 0 }, { retryBudgetMs: 1 }, { retryProfile: "outage" }, { unexpectedOption: true }])("refuses retry/unknown request option %j", options => {
  const f = fixture(); expect(() => f.call(options)).toThrow(); expect(f.permit.events).toEqual([]);
});
it("refuses constructor retry profiles and nonzero retry declarations", () => {
  for (const extra of [{ piMaxRetries: 1 }, { maxRetries: 1 }, { piRequestRetryBudgetMs: 0 }, { retryProfile: "outage" }]) {
    expect(() => guardedLookupModels({}, { contract: { ...C, slotId: "fictional", runId: "fictional", ...extra }, permit: createTestOnlyLookupPermitSource(), send: vi.fn() })).toThrow();
  }
});
it("accepts the matching model spread by the real agent loop", async () => { const f = fixture(); await f.call({ model }); expect(f.send).toHaveBeenCalledOnce(); });
it("rejects send endpoint mismatch before send and retains the hold", async () => {
  const f = fixture({ sendUrl: "https://example.invalid/fictional" }); await expect(f.call()).rejects.toThrow("lookup_send_mismatch");
  expect(f.send).not.toHaveBeenCalled(); expect(settles(f)[0].outcome.kind).toBe("integrity_stop");
});
it.each([
  usage(0, 0), usage(-1, 0),
  { ...usage(), input_tokens_details: { cached_tokens: 2 } },
  { ...usage(), output_tokens_details: { reasoning_tokens: "fictional" } },
])("stops on invalid raw usage %j", async raw => {
  const f = fixture({ raw }); await expect(f.call()).rejects.toThrow("lookup_invalid_usage"); expect(settles(f)[0].outcome.kind).toBe("integrity_stop");
});
it("stops on duplicate raw terminal events", async () => {
  const f = fixture({ duplicateTerminal: true }); await expect(f.call()).rejects.toThrow("lookup_duplicate_terminal"); expect(f.send).toHaveBeenCalledOnce();
});
it("repeated payload callback cannot reserve or send twice", async () => {
  const f = fixture({ repeatedPayload: true }); await expect(f.call()).rejects.toThrow("lookup_payload_repeated");
  expect(f.permit.events.filter(e => e.type === "admit")).toHaveLength(1); expect(f.send).not.toHaveBeenCalled();
});
it("awaits sticky stop before exposing the integrity error", async () => {
  const source = createTestOnlyLookupPermitSource(); let release;
  const stop = vi.fn(() => new Promise(resolve => { release = resolve; }));
  const f = fixture({ raw: usage(1, 128001), permitSource: { ...source, stop } });
  let done = false; const result = f.call().finally(() => { done = true; });
  const assertion = expect(result).rejects.toMatchObject({ code: "lookup_output_envelope_violated" });
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce()); expect(done).toBe(false);
  release(); await assertion; expect(done).toBe(true);
});
it("stop failure retains integrity code and identifies the IPC stop failure separately", async () => {
  const source = createTestOnlyLookupPermitSource(), ipc = Error("fictional_stop_disconnect");
  const f = fixture({ tier: "unknown", permitSource: { ...source, stop: async () => { throw ipc; } } });
  await expect(f.call()).rejects.toMatchObject({ code: "lookup_unknown_tier", outcome: "integrity_stop", stopCode: "lookup_stop_failed", cause: ipc });
  expect(() => f.call()).toThrow("lookup_stopped");
});
it.each(["lost", "own_abort_after_send"])("a request after %s is slot-terminal, never a pilot stop", async outcome => {
  const controller = new AbortController();
  const f = fixture({ failure: () => { if (outcome === "own_abort_after_send") controller.abort(); } });
  await f.call({ signal: controller.signal }); const before = f.permit.events.length;
  expect(settles(f)[0].outcome.kind).toBe(outcome); expect(() => f.call()).toThrow("lookup_slot_terminal");
  expect(f.permit.events).toHaveLength(before); expect(f.send).toHaveBeenCalledOnce(); expect(f.permit.events.some(e => e.type === "stop")).toBe(false);
});
it("is not thenable and has no accidental serialization methods", async () => {
  const f = fixture(); expect(f.guarded.then).toBeUndefined(); expect(f.guarded.toJSON).toBeUndefined(); expect(f.guarded.fictional).toBeUndefined();
  expect(await Promise.resolve(f.guarded)).toBe(f.guarded);
});
it.each(["conversation", "prompt", "background", "truncation", "previous_response_id"])("refuses server expansion key %s before admission", async key => {
  const f = fixture({ body: { ...payload(), [key]: "fictional" } });
  await expect(f.call()).rejects.toThrow("lookup_payload_forbidden"); expect(f.permit.events).toEqual([]); expect(f.send).not.toHaveBeenCalled();
});
it.each([
  { role: "user", content: "Fictional", conversation: "fictional" },
  { type: "function_call", arguments: "{}", prompt: "fictional" },
  { type: "function_call_output", call_id: "fictional", output: "Fictional", background: true },
])("refuses unknown input-item keys before admission", async item => {
  const body = payload(); body.input = [item]; const f = fixture({ body });
  await expect(f.call()).rejects.toThrow("lookup_payload_forbidden"); expect(f.permit.events).toEqual([]);
});

it("verifies the body locally before a permissive permit source can consume", async () => {
  const source = createTestOnlyLookupPermitSource(), consume = vi.fn();
  const f = fixture({ permitSource: { ...source, consume }, mutate: p => { p.instructions += " late"; } });
  await expect(f.call()).rejects.toMatchObject({ code: "lookup_body_mismatch", outcome: "integrity_stop" });
  expect(consume).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
});
it.each([null, [], [{ type: "reasoning_text", text: "Fictional reasoning." }]])("accepts supported verbatim reasoning content %j after settlement", async content => {
  const f = fixture(); await f.call();
  await f.call({ onPayload: p => ({ ...p, input: [...p.input, { type: "reasoning", id: "rs_fictional", encrypted_content: "FAKE", summary: [{ type: "summary_text", text: "Fictional summary." }], content }] }) });
  expect(f.send).toHaveBeenCalledTimes(2);
});
it.each(["fictional", {}, [{ type: "input_text", text: "Fictional" }], [{ type: "reasoning_text", text: 1 }], [{ type: "reasoning_text", text: "a" }, { type: "reasoning_text", text: "b" }]])("refuses unsupported reasoning content %j", async content => {
  const f = fixture(); await f.call();
  await expect(f.call({ onPayload: p => ({ ...p, input: [...p.input, { type: "reasoning", content }] }) })).rejects.toThrow("lookup_payload_forbidden");
  expect(f.send).toHaveBeenCalledOnce();
});
it("requires the declared exact transport cache key and rejects missing or mismatched keys", async () => {
  const key = "fictional-run-slot-arm";
  const valid = fixture({ contractPatch: { promptCacheKey: key }, body: { ...payload(), prompt_cache_key: key }, sendHeaders: { "session-id": key, "x-client-request-id": key } }); await valid.call();
  for (const f of [fixture({ body: { ...payload(), prompt_cache_key: key } }), fixture({ contractPatch: { promptCacheKey: key }, body: { ...payload(), prompt_cache_key: "other-slot" } })]) {
    await expect(f.call()).rejects.toThrow("lookup_prompt_cache_key_forbidden"); expect(f.permit.events).toEqual([]); expect(f.send).not.toHaveBeenCalled();
  }
  expect(() => fixture({ contractPatch: { promptCacheKey: "x".repeat(65) } })).toThrow("lookup_prompt_cache_key_forbidden");
});
it.each([
  [{ headers: { "x-fictional": "value" } }, "lookup_headers_forbidden"],
  [{ headers: new Headers({ "x-fictional": "value" }) }, "lookup_headers_forbidden"],
  [{ headers: [["malformed"]] }, "lookup_headers_forbidden"],
  [{ env: { FICTIONAL: "value" } }, "lookup_env_forbidden"],
])("refuses non-empty or malformed request headers/env %j before admission", (options, code) => {
  const f = fixture(); expect(() => f.call(options)).toThrow(code); expect(f.permit.events).toEqual([]);
});
it("permits empty headers/env without changing the real harness's options", async () => { const f = fixture(); await f.call({ headers: {}, env: {} }); expect(f.send).toHaveBeenCalledOnce(); });
it.each([
  [{ "x-fictional": "value" }, "lookup_headers_forbidden"],
  [[["malformed"]], "lookup_headers_forbidden"],
  [{ "session-id": "shared-key" }, "lookup_prompt_cache_key_forbidden"],
  [{ "x-client-request-id": "shared-key" }, "lookup_prompt_cache_key_forbidden"],
])("rejects unexpected, malformed or shared send headers before consumption %j", async (sendHeaders, code) => {
  const source = createTestOnlyLookupPermitSource(), consume = vi.fn();
  // A declared run-bound key, so the shared-key cases exercise a real mismatch.
  const f = fixture({ permitSource: { ...source, consume }, sendHeaders, body: { ...payload(), prompt_cache_key: "fictional-run-slot-arm" }, contractPatch: { promptCacheKey: "fictional-run-slot-arm" } });
  await expect(f.call()).rejects.toMatchObject({ code, outcome: "integrity_stop" }); expect(consume).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
});
it("accepts send headers that carry the declared run-bound key", async () => {
  const f = fixture({ body: { ...payload(), prompt_cache_key: "fictional-run-slot-arm" }, sendHeaders: { "session-id": "fictional-run-slot-arm", "x-client-request-id": "fictional-run-slot-arm" }, contractPatch: { promptCacheKey: "fictional-run-slot-arm" } });
  await f.call(); expect(f.send).toHaveBeenCalledOnce();
});
it("retains both settlement and stop failures", async () => {
  const source = createTestOnlyLookupPermitSource(), settleCause = Error("fictional_settle_failure"), cause = Error("fictional_stop_failure");
  const f = fixture({ permitSource: { ...source, settle: async () => { throw settleCause; }, stop: async () => { throw cause; } } });
  await expect(f.call()).rejects.toMatchObject({ code: "lookup_settlement_failed", stopCode: "lookup_stop_failed", cause, settleCause });
});
it.each([["unknown", "integrity_stop"], ["default", "lost"], [null, "lost"]])("validates failed-response tier %s while retaining lost usage", async (tier, outcome) => {
  const f = fixture({ event: "response.failed", tier });
  if (outcome === "integrity_stop") await expect(f.call()).rejects.toThrow("lookup_unknown_tier"); else await f.call();
  expect(settles(f)[0].outcome.kind).toBe(outcome);
});
it("fetch without admission awaits the sticky stop and cannot consume or send", async () => {
  const source = createTestOnlyLookupPermitSource(); let release;
  const stop = vi.fn(() => new Promise(resolve => { release = resolve; }));
  const f = fixture({ skipPayload: true, permitSource: { ...source, stop } });
  let finished = false; const result = f.call().finally(() => { finished = true; });
  const assertion = expect(result).rejects.toMatchObject({ code: "lookup_permit_invalid", outcome: "integrity_stop" });
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce()); expect(finished).toBe(false); release(); await assertion;
  expect(source.events).toEqual([]); expect(f.send).not.toHaveBeenCalled();
});

it.each(["prompt_cache_key", "session-id", "x-client-request-id"])("requires assigned %s to be present and exact", async field => {
  for (const value of [undefined, "wrong-key"]) {
    const key = "lk-short-independent-nonce", body = { ...payload(), prompt_cache_key: key }, headers = { "session-id": key, "x-client-request-id": key };
    const target = field === "prompt_cache_key" ? body : headers; if (value === undefined) delete target[field]; else target[field] = value;
    const f = fixture({ body, sendHeaders: headers, contractPatch: { promptCacheKey: key } });
    await expect(f.call()).rejects.toMatchObject({ code: "lookup_prompt_cache_key_forbidden" }); expect(f.send).not.toHaveBeenCalled();
  }
});

it("rechecks resolved safety at every stream and after payload preparation", async () => {
  const safety = fauxLookupSafety({ judge: null }, { midCheckpoint: null, ledgerUpkeep: false });
  const f = fixture({ resolvedSafety: safety }); await f.call();
  safety.config.runtime.session.modelSwitch = { enabled: true };
  expect(() => f.call()).toThrow("lookup_model_switch_forbidden"); expect(f.send).toHaveBeenCalledOnce();
  delete safety.config.runtime.session.modelSwitch;
  const prepared = fixture({ resolvedSafety: safety });
  await expect(prepared.call({ onPayload: payload => { safety.captureUpkeepOutput = {}; return payload; } })).rejects.toThrow("lookup_preparation_forbidden");
  expect(prepared.permit.events).toEqual([]); expect(prepared.send).not.toHaveBeenCalled();
});

it("requires key and resolved safety for pilot and non-test permit sources without changing legacy callers", () => {
  const legacy = createTestOnlyLookupPermitSource(), safety = fauxLookupSafety({ judge: null }, { midCheckpoint: null, ledgerUpkeep: false });
  const base = { contract: { ...C, slotId: "fictional-slot", runId: "fictional-run" }, send: vi.fn() };
  for (const permit of [{ ...legacy, pilot: true }, { ...legacy, testOnly: false }]) {
    expect(() => guardedLookupModels({}, { ...base, permit, resolvedSafety: safety })).toThrow("lookup_prompt_cache_key_forbidden");
    const assigned = { ...base, permit, contract: { ...base.contract, promptCacheKey: "lk-fictional-assigned" } };
    expect(() => guardedLookupModels({}, assigned)).toThrow("lookup_auxiliary_callers_forbidden");
    if (permit.testOnly === false) expect(() => guardedLookupModels({}, { ...assigned, resolvedSafety: safety })).toThrow("lookup_faux_permit_forbidden");
    else expect(() => guardedLookupModels({}, { ...assigned, resolvedSafety: safety })).not.toThrow();
    expect(base.send).not.toHaveBeenCalled();
  }
  expect(() => guardedLookupModels({}, { ...base, permit: legacy })).not.toThrow();
});

it("limits pilot continuation to the five capacity/terminal refusals", () => {
  expect(LOOKUP_PRE_SEND_REFUSALS).toEqual(["not_admitted_input_envelope", "lookup_request_limit", "not_admitted_cap", "lookup_stopped", "lookup_slot_terminal"]);
});

it("keeps repeated payload refusal a fixed sticky policy code", async () => {
  expect(LOOKUP_GUARD_POLICY_REFUSALS).toContain("lookup_payload_repeated");
  const f = fixture({ repeatedPayload: true }); await expect(f.call()).rejects.toThrow("lookup_payload_repeated");
  expect(settles(f)[0].outcome).toMatchObject({ kind: "integrity_stop", code: "lookup_payload_repeated" });
  expect(f.permit.events.some(e => e.type === "stop" && e.code === "lookup_payload_repeated")).toBe(true);
  expect(() => f.call()).toThrow("lookup_stopped"); expect(f.send).not.toHaveBeenCalled();
});

it.each(["string", "Uint8Array", "ArrayBuffer"])("guard consumes the same owned %s bytes sent by transports", async kind => {
  const f = fixture({sendBody: text => kind === "string" ? text : kind === "Uint8Array" ? new Uint8Array(Buffer.from(text)) : Uint8Array.from(Buffer.from(text)).buffer});
  await f.call();
  expect(f.send).toHaveBeenCalledOnce(); const bytes = f.send.mock.calls[0][1].body;
  expect(Buffer.isBuffer(bytes)).toBe(true);
  expect(f.permit.events.find(e => e.type === "admit").payloadDigest).toBe(lookupBodyDigest(bytes));
  expect(f.permit.events.filter(e => e.type === "consume")).toHaveLength(1);
});
it.each([new DataView(new ArrayBuffer(4)), new Uint16Array(2), new Int8Array(2), new Uint8ClampedArray(2), new FormData(), new URLSearchParams(), new Blob(["fictional"]), null, undefined])("guard refuses unsupported body %# before consume or send", async body => {
  const f = fixture({sendBody: () => body});
  await expect(f.call()).rejects.toMatchObject({code: "lookup_body_type_forbidden"});
  expect(f.send).not.toHaveBeenCalled(); expect(f.permit.events.filter(e => e.type === "consume")).toHaveLength(0);
  expect(f.permit.events).toContainEqual(expect.objectContaining({type: "stop", code: "lookup_body_type_forbidden"}));
});

it("observes each forwarded context synchronously after the persisted consume and before the single send", async () => {
  const seen = [];
  const f = fixture({ onForwarded: (context, round) => { seen.push({ context, round, events: f.permit.events.map(e => e.type), sends: f.send.mock.calls.length }); } });
  const first = { messages: [{ role: "user", content: "Fictional first context." }] }, second = { messages: [] };
  await f.call({}, first); await f.call({}, second);
  expect(seen).toEqual([{ context: first, round: 1, events: ["admit", "consume"], sends: 0 },
    { context: second, round: 2, events: ["admit", "consume", "settle", "admit", "consume"], sends: 1 }]);
  expect(f.send).toHaveBeenCalledTimes(2);
});
it("still sends exactly once with the identical admitted body when the observer throws, leaving presence unknown", async () => {
  const witness = lookupWitness({ availability: "retained" }, { value: "MORGAN-7Q4" }), observer = lookupForwardedObserver();
  const attempted = vi.fn(context => witness.initial(context)); observer.register(attempted);
  const f = fixture({ onForwarded: observer.notify });
  // A BigInt makes the witness's own serialization throw before it records anything.
  const context = { messages: [{ role: "user", content: "MORGAN-7Q4", unserializable: 1n }] };
  await f.call({}, context);
  expect(attempted).toHaveBeenCalledExactlyOnceWith(context, 1); expect(attempted.mock.results[0].type).toBe("throw");
  expect(f.send).toHaveBeenCalledOnce();
  const admitted = f.permit.events.find(e => e.type === "admit");
  expect(lookupBodyDigest(Buffer.from(f.send.mock.calls[0][1].body))).toBe(admitted.payloadDigest);
  expect(settles(f)[0].outcome.kind).toBe("settled");
  expect(witness.snapshot()).toMatchObject({ initiallyPresent: "unknown", initialContextBytes: null });
  const throwing = vi.fn(() => { throw Error("fictional_observer_failure"); }), raw = fixture({ onForwarded: throwing });
  await raw.call(); expect(throwing).toHaveBeenCalledExactlyOnceWith({}, 1); expect(throwing.mock.results[0].type).toBe("throw");
  expect(raw.send).toHaveBeenCalledOnce(); expect(settles(raw)[0].outcome.kind).toBe("settled");
});
it("never awaits or leaks a rejected thenable from an observer, directly or through the runtime channel", async () => {
  const unhandled = []; const onUnhandled = reason => unhandled.push(reason); process.on("unhandledRejection", onUnhandled);
  try {
    const observer = lookupForwardedObserver(), rejecting = vi.fn(() => Promise.reject(Error("fictional_async_observer")));
    observer.register(rejecting);
    const viaChannel = fixture({ onForwarded: observer.notify }), direct = fixture({ onForwarded: () => Promise.reject(Error("fictional_direct_observer")) });
    await viaChannel.call(); await direct.call();
    const getter = lookupForwardedObserver(); getter.register(() => ({ get then() { throw Error("fictional_then_getter"); } }));
    expect(() => getter.notify({}, 1)).not.toThrow();
    for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
    expect(rejecting).toHaveBeenCalledExactlyOnceWith({}, 1);
    expect(viaChannel.send).toHaveBeenCalledOnce(); expect(direct.send).toHaveBeenCalledOnce(); expect(unhandled).toEqual([]);
  } finally { process.off("unhandledRejection", onUnhandled); }
});
it("does not observe refused requests and refuses a non-function observer binding", async () => {
  const onForwarded = vi.fn(), f = fixture({ body: sized(A.inputMax + 1), onForwarded });
  await expect(f.call()).rejects.toThrow("not_admitted_input_envelope"); expect(onForwarded).not.toHaveBeenCalled();
  expect(() => fixture({ onForwarded: "observer" })).toThrow("lookup_pilot_capability_invalid");
});
it("registers exactly one forwarded observer", () => {
  const observer = lookupForwardedObserver(), fn = vi.fn();
  expect(() => observer.register(null)).toThrow("lookup_pilot_capability_invalid");
  observer.register(fn); expect(() => observer.register(fn)).toThrow("lookup_pilot_capability_invalid");
  observer.notify("fictional-context", 1); expect(fn).toHaveBeenCalledExactlyOnceWith("fictional-context", 1);
});
