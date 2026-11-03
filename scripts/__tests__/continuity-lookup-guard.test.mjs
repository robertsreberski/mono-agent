import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Socket } from "node:net";
import { guardedLookupModels, LOOKUP_ASSUMPTIONS as A, LOOKUP_GUARD_CONTRACT as C, lookupInputEnvelope, lookupBodyDigest,
  createTestOnlyLookupPermitSource, assertRealLookupPermitSource, assertLookupAuxiliaryCallersOff, assertLookupChildSafety, lookupSettledCost } from "../lib/continuity-lookup-guard.mjs";
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
function fixture({ body = payload(), raw = usage(), tier = "default", event = "response.completed", final = message(), failure, mutate, noSend = false, doubleSend = false, permitSource } = {}) {
  const permit = permitSource ?? createTestOnlyLookupPermitSource(), send = vi.fn(async () => new Response(""));
  const underlying = { streamSimple: vi.fn((_m, _c, options) => {
    const result = (async () => {
      try {
        const p = await options.onPayload(body, model);
        mutate?.(p);
        if (noSend) throw Error("fictional_before_send_abort");
        await options.fetch(`${C.baseUrl}/codex/responses`, { method: "POST", body: JSON.stringify(p) });
        if (doubleSend) await options.fetch(`${C.baseUrl}/codex/responses`, { method: "POST", body: JSON.stringify(p) });
        if (failure) { failure(options); throw Error("fictional_stream_failure"); }
        await options.onProviderStreamEvent({ type: event, response: { usage: raw, ...(tier !== "OMIT" ? { service_tier: tier } : {}) } }, model);
        return final;
      } catch (error) { if (error.code) return message("error"); throw error; }
    })();
    return { result: () => result, async *[Symbol.asyncIterator]() { yield { type: "done", message: await result }; } };
  }), getModel: () => model };
  const guarded = guardedLookupModels(underlying, { contract: { ...C, slotId: "fictional-slot", runId: "fictional-run" }, permit });
  const options = { reasoning: "high", transport: "sse", maxRetries: 0, fetch: send };
  return { guarded, permit, send, underlying, options, call: (overrides = {}) => guarded.streamSimple(model, {}, { ...options, ...overrides }).result() };
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
  expect(() => g.call()).toThrow("lookup_unsettled_dependency"); expect(g.send).toHaveBeenCalledOnce();
});
it.each(["response.failed", "response.output_text.done"])("does not settle from %s", async event => {
  const f = fixture({ event }); await f.call(); expect(settles(f)[0].outcome.kind).toBe("lost");
});
it.each([["OMIT", 2], ["default", 1], ["flex", 0.5], ["priority", 2]])("accounts tier %s conservatively", async (tier, multiplier) => {
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
  const f = fixture({ mutate: p => { p.instructions += "late"; } }); await expect(f.call()).rejects.toThrow("lookup_permit_invalid"); expect(f.send).not.toHaveBeenCalled();
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
  try { f.call(); throw Error("not_refused"); } catch (error) { expect(error.classification).toBe("failed/pilot_empty_final_output"); }
  expect(f.send).toHaveBeenCalledOnce();
});
it("own abort after send retains hold without pilot stop", async () => {
  const controller = new AbortController(); const f = fixture({ failure: () => controller.abort() });
  await expect(f.call({ signal: controller.signal })).rejects.toThrow("fictional_stream_failure");
  expect(settles(f)[0].outcome.kind).toBe("own_abort_after_send"); expect(f.permit.events.some(e => e.type === "stop")).toBe(false);
});
it("admission followed by abort before fetch is lost, never released", async () => {
  const f = fixture({ noSend: true }); await expect(f.call()).rejects.toThrow("fictional_before_send_abort"); expect(settles(f)[0].outcome.kind).toBe("lost"); expect(f.send).not.toHaveBeenCalled();
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
  const f = fixture({ failure: () => {} }); await expect(f.call()).rejects.toThrow("fictional_stream_failure"); expect(settles(f)[0].outcome.kind).toBe("lost");
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
