import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";

const mocks = vi.hoisted(() => ({ buildCheckpoint: vi.fn(), runProbe: vi.fn(), createJudge: vi.fn() }));
vi.mock("../lib/continuity-runner.mjs", async original => ({ ...await original(), ...mocks }));
import { aggregate, execute } from "../continuity-benchmark.mjs";
import { loadTraces, makePlan } from "../lib/continuity-dataset.mjs";
import { LOOKUP_ASSUMPTIONS } from "../lib/continuity-lookup-guard.mjs";
import { digest } from "../lib/continuity-dataset.mjs";
import { lookupPilotReadiness } from "../lib/continuity-lookup-roles.mjs";
import { LOOKUP_MODE, LOOKUP_SLOT_CODES, lookupSlotDisposition } from "../lib/continuity-lookup.mjs";
import { renderLookupMarkdown, summarizeLookup } from "../lib/continuity-lookup-score.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url)), dirs = [];
let network, globalFetch;
beforeEach(() => {
  vi.clearAllMocks();
  // No fallback transport, credential refresh or accidental fetch may leave this process.
  network = vi.spyOn(Socket.prototype, "connect").mockImplementation(() => { throw new Error("test_network_denied"); });
  globalFetch = vi.fn(() => { throw new Error("test_fetch_denied"); });
  vi.stubGlobal("fetch", globalFetch);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("test_websocket_denied"); } });
});
afterEach(async () => {
  expect(network).not.toHaveBeenCalled(); expect(globalFetch).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function scratch() {
  const base = join(root, ".worklab-tmp"); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "lookup-b1-test-")); dirs.push(dir);
  await mkdir(join(dir, "units")); return dir;
}

// Payloads are JSON: traverse objects and array elements without inspecting values
// as field names. Return full paths so a nested cap cannot hide behind reasoning.
function maxOutputFields(value, path = []) {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(/max.*(token|output)|(token|output).*max/iu.test(key) ? [[...path, key].join(".")] : []),
    ...maxOutputFields(child, [...path, key]),
  ]);
}
it("finds max-output spellings at every payload depth, including arrays (serialized only)", () => {
  expect(maxOutputFields({ reasoning: { max_output_tokens: 17 }, input: [{ options: { outputTokenMax: 9 } }], maxTokens: 3 }))
    .toEqual(["reasoning.max_output_tokens", "input.0.options.outputTokenMax", "maxTokens"]);
  expect(maxOutputFields({ reasoning: { effort: "high" }, input: [{ text: "max_output_tokens is text, not a key" }] })).toEqual([]);
});

it("captures the installed Codex Sol serializer through options.fetch: no request-local output cap, one send, no egress", async () => {
  const piRoot = join(root, "packages/turn/node_modules/@earendil-works/pi-ai");
  const pkg = JSON.parse(await readFile(join(piRoot, "package.json"), "utf8"));
  const { createModels } = await import(pathToFileURL(join(piRoot, pkg.exports["."].import)).href);
  const { openaiCodexProvider } = await import(pathToFileURL(join(piRoot, pkg.exports["./providers/*"].import.replace("*", "openai-codex"))).href);
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  // Obviously fake, unsigned and unexpired. No credential files or refresh path.
  const credential = { type: "oauth", access: `${encode({ alg: "none", typ: "FAKE-TEST-JWT" })}.${encode({
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "FAKE-TEST-ACCOUNT-NOT-REAL" },
  })}.FAKE-TEST-SIGNATURE`, refresh: "FAKE-TEST-REFRESH-NOT-REAL", expires: Date.now() + 3600000 };
  const read = vi.fn(async provider => provider === "openai-codex" ? credential : undefined);
  const modify = vi.fn(() => { throw new Error("test_refresh_denied"); });
  const models = createModels({ credentials: { read, modify } });
  const provider = openaiCodexProvider(); models.setProvider(provider);
  const model = models.getModel("openai-codex", "gpt-6.1-sol");
  expect(model).toMatchObject({ provider: "openai-codex", id: "gpt-6.1-sol", baseUrl: "https://chatgpt.com/backend-api" });
  const captures = [];
  const fetch = vi.fn(async (url, options) => {
    const encoding = new Headers(options.headers).get("content-encoding");
    expect([null, "zstd"]).toContain(encoding);
    const bytes = encoding === "zstd" ? zstdDecompressSync(options.body) : Buffer.from(options.body);
    captures.push({ url: String(url), method: options.method, encoding, payload: JSON.parse(bytes.toString("utf8")) });
    // Stop at serialization. This is not a backend response or enforcement proof.
    return new Response(JSON.stringify({ error: { message: "offline_capture_only" } }), { status: 400 });
  });
  const result = await models.completeSimple(model, { messages: [{ role: "user", content: "Fictional serializer check.", timestamp: 0 }] },
    { reasoning: "high", maxTokens: 17, transport: "sse", maxRetries: 0, fetch });
  expect(result.stopReason).toBe("error");
  expect(fetch).toHaveBeenCalledOnce(); expect(captures).toHaveLength(1); expect(modify).not.toHaveBeenCalled();
  const capture = captures[0];
  expect(capture.url).toBe("https://chatgpt.com/backend-api/codex/responses"); expect(capture.method).toBe("POST");
  expect(capture.encoding).toBe("zstd"); // Node 24 exercises the real compressed-body path.
  expect(capture.payload.model).toBe("gpt-6.1-sol"); expect(capture.payload.reasoning.effort).toBe("high");
  // Fail on any new max-output spelling, not just max_output_tokens.
  expect(maxOutputFields(capture.payload)).toEqual([]);
});

it("reports output-cap, input-envelope and pricing readiness independently, with unknown/unsupported blocking", () => {
  expect(lookupPilotReadiness()).toMatchObject({ ready: false, outputCap: { status: "unsupported" }, inputEnvelope: { status: "unknown" }, pricing: { status: "unknown" } });
  const catalog = { model: "openai-codex:gpt-6.1-sol", cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } };
  const readiness = lookupPilotReadiness({ catalog });
  expect(readiness.pricing.status).toBe("ready"); expect(readiness.ready).toBe(false);
  expect(readiness.blockers).toEqual(["lookup_output_cap_unsupported", "lookup_input_envelope_unknown"]);
  for (const cost of [{ ...catalog.cost, cacheWrite: undefined }, { ...catalog.cost, input: NaN }, { ...catalog.cost, tiers: [{ inputTokensAbove: 10 }] }])
    expect(lookupPilotReadiness({ catalog: { ...catalog, cost } }).pricing.status).toBe("unknown");
  expect(lookupPilotReadiness({ model: "fictional:unknown", catalog }).outputCap.status).toBe("unknown");
});

async function fixture() {
  const loaded = await loadTraces();
  const traces = loaded.traces.slice(0, 2);
  const plan = makePlan({ ...loaded, traces, probeMode: LOOKUP_MODE, arms: ["native-lookup"], probeLimit: 2, profile: { judge: null } });
  plan.lookup.budget = structuredClone(plan.lookup.budget);
  // Synthetic complete inventory, including probes without a checked-in reference path.
  plan.lookup.budget.paths = plan.corpus.traces.flatMap(trace => trace.probes.map(probeId => ({
    traceId: trace.id, probeId, arm: "native-lookup", calls: 0, bytes: 0, cumulativeBytes: 0,
    discovered: true, initialTokens: 1000000, admissionCap: 6000000,
  })));
  return { traces, plan };
}
const slot = (plan, trace = 0, probe = 0) => ({ traceId: plan.corpus.traces[trace].id, probeId: plan.corpus.traces[trace].probes[probe], arm: "native-lookup" });

it("recomputes inventory geometry, respects role identity and reserves distinct later refusal codes", async () => {
  const { plan } = await fixture(), id = slot(plan);
  const path = plan.lookup.budget.paths.find(p => p.traceId === id.traceId && p.probeId === id.probeId && p.arm === id.arm);
  path.feasibility = { classification: "feasible", reasons: [] }; // untrusted cached label
  expect(lookupSlotDisposition(plan, id)).toMatchObject({ status: "infeasible", code: "inventory_infeasible" });
  const feasible = { ...path, initialTokens: 10, calls: 0, bytes: 0, cumulativeBytes: 0, discovered: true };
  plan.lookup.role = { id: "native-soul" }; plan.lookup.source = {};
  plan.lookup.budget.paths = [{ ...feasible, role: "native" }, { ...path, role: "native-soul" }];
  expect(lookupSlotDisposition(plan, id).status).toBe("infeasible");
  plan.lookup.role.id = "unknown-role";
  expect(lookupSlotDisposition(plan, id)).toMatchObject({ status: "blocked", code: "lookup_unknown_feasibility" });
  plan.lookup.role.id = "native";
  expect(lookupSlotDisposition(plan, id).status).toBe("eligible");
  plan.lookup.budget.paths[0] = { ...feasible, role: "native", method: "identifier-reference", exhausted: "latency" };
  expect(lookupSlotDisposition(plan, id).status).toBe("blocked");
  expect(new Set(Object.values(LOOKUP_SLOT_CODES)).size).toBe(4);
  expect(LOOKUP_SLOT_CODES).toMatchObject({ inputEnvelope: "not_admitted_input_envelope", cap: "not_admitted_cap" });
});

it("writes planned/infeasible records without loading runtime, creating checkpoints, holds, provider counts or scores", async () => {
  const { traces, plan } = await fixture(), output = await scratch();
  const modulesLoader = vi.fn(() => { throw new Error("runtime_must_not_load"); }), onPhase = vi.fn();
  await execute({ flags: {}, plan, traces, mode: "offline", output, modulesLoader, onPhase, head: "a".repeat(40), dirty: false });
  expect(modulesLoader).not.toHaveBeenCalled(); expect(mocks.buildCheckpoint).not.toHaveBeenCalled();
  expect(mocks.runProbe).not.toHaveBeenCalled(); expect(mocks.createJudge).not.toHaveBeenCalled(); expect(onPhase).not.toHaveBeenCalled();
  const units = await Promise.all((await readdir(join(output, "units"))).map(async file => JSON.parse(await readFile(join(output, "units", file), "utf8"))));
  expect(units).toHaveLength(2);
  for (const unit of units) {
    expect(unit.complete).toBe(false); expect(unit.eligibleComplete).toBe(true); expect(unit.checkpoint).toBeNull();
    expect(unit.trials).toHaveLength(2);
    for (const trial of unit.trials) {
      expect(trial.status).toBe("infeasible"); expect(trial.disposition).toBe("inventory_infeasible");
      for (const key of ["usage", "score", "answer", "reservation"]) expect(trial).not.toHaveProperty(key);
      expect(trial.lookup).not.toHaveProperty("calls");
    }
  }
  const results = await aggregate({ plan, traces, mode: "offline", output });
  expect(results.coverage).toMatchObject({ unitsComplete: 0, unitsExpected: 2 });
  expect(results.summary.lookup.arms["native-lookup"]).toMatchObject({ planned: 4, skipped: 4, statuses: { infeasible: 4 }, exact: { n: 0 }, calls: { n: 0 } });
  expect(results.summary.arms["native-lookup"].usage.calls).toBe(0);
  expect(results.summary.arms["native-lookup"].excluded.failed).toBe(0);
  expect(renderLookupMarkdown(results.summary.lookup)).toContain("| native-lookup | 4 | 4 | 0 | 0 |");
  const absent = summarizeLookup([], plan).arms["native-lookup"];
  expect(absent.statuses).toEqual({ infeasible: 4 }); expect(absent.planned).toBe(4);
});

it.each(["completed", "failed"])("resumes terminal mixed units without replay or skipped completions (%s)", async status => {
  const { traces, plan } = await fixture(), output = await scratch(), id = slot(plan);
  const path = plan.lookup.budget.paths.find(p => p.traceId === id.traceId && p.probeId === id.probeId && p.arm === id.arm);
  Object.assign(path, { initialTokens: 10, calls: 0, bytes: 0, cumulativeBytes: 0, discovered: true });
  mocks.buildCheckpoint.mockResolvedValue({ work: "fictional-work", record: { continuity: {}, conversationId: "fictional-conversation" } });
  mocks.runProbe.mockImplementation(async ({ trace, probe, arm, repeat }) => ({ traceId: trace.id, probeId: probe.id, arm: arm.id, repeat, category: probe.category,
    status, score: status === "completed" ? { pass: true } : null, usage: { calls: 1 }, lookup: { exactAccuracy: status === "completed", calls: 0, bytes: 0 } }));
  mocks.createJudge.mockReturnValue(null);
  await execute({ flags: {}, plan, traces, mode: "offline", output, modulesLoader: async () => ({}), onPhase: () => {}, head: "a".repeat(40), dirty: false });
  expect(mocks.buildCheckpoint).toHaveBeenCalledOnce(); expect(mocks.runProbe).toHaveBeenCalledOnce();
  expect(mocks.runProbe.mock.calls[0][0].probe.id).toBe(id.probeId);
  const results = await aggregate({ plan, traces, mode: "offline", output });
  const completed = status === "completed" ? 1 : 0;
  expect(results.summary.lookup.arms["native-lookup"]).toMatchObject({ planned: 4, skipped: 3, statuses: { infeasible: 3, [status]: 1 }, exact: { n: completed, correct: completed } });
  expect(results.summary.arms["native-lookup"].usage.calls).toBe(1);
  expect(results.summary.arms["native-lookup"].excluded.failed).toBe(status === "failed" ? 1 : 0);
  expect(results.coverage.unitsComplete).toBe(0);
  const files = await readdir(join(output, "units"));
  const before = await Promise.all(files.map(file => readFile(join(output, "units", file), "utf8")));
  expect(before.every(bytes => JSON.parse(bytes).eligibleComplete === true)).toBe(true);
  const modulesLoader = vi.fn(() => { throw new Error("resume_must_not_load_runtime"); });
  await execute({ flags: {}, plan, traces, mode: "offline", output, modulesLoader });
  expect(modulesLoader).not.toHaveBeenCalled();
  expect(mocks.buildCheckpoint).toHaveBeenCalledOnce(); expect(mocks.runProbe).toHaveBeenCalledOnce();
  expect(await Promise.all(files.map(file => readFile(join(output, "units", file), "utf8")))).toEqual(before);
  // Older B1 mixed receipts have no marker. Their terminal slot records suffice.
  for (let i = 0; i < files.length; i++) {
    const unit = JSON.parse(before[i]); delete unit.eligibleComplete;
    await writeFile(join(output, "units", files[i]), JSON.stringify(unit));
  }
  await execute({ flags: {}, plan, traces, mode: "offline", output, modulesLoader });
  expect(modulesLoader).not.toHaveBeenCalled(); expect(mocks.runProbe).toHaveBeenCalledOnce();
});

it.each(["real", "unknown"])("retains the paid/non-offline refusal at the execution seam (%s)", async mode => {
  const { traces, plan } = await fixture(), modulesLoader = vi.fn();
  await expect(execute({ flags: {}, plan, traces, mode, modulesLoader })).rejects.toThrow("lookup_real_not_authorized");
  expect(modulesLoader).not.toHaveBeenCalled(); expect(mocks.buildCheckpoint).not.toHaveBeenCalled();
});

it("blocks unknown feasibility before any checkpoint, module load or skipped-unit write", async () => {
  const { traces, plan } = await fixture(), output = await scratch();
  plan.lookup.budget.paths = [];
  const modulesLoader = vi.fn();
  await expect(execute({ flags: {}, plan, traces, mode: "offline", output, modulesLoader })).rejects.toThrow("lookup_unknown_feasibility");
  expect(modulesLoader).not.toHaveBeenCalled(); expect(mocks.buildCheckpoint).not.toHaveBeenCalled(); expect(mocks.runProbe).not.toHaveBeenCalled();
  expect(await readdir(join(output, "units"))).toEqual([]);
  expect(summarizeLookup([], plan).arms["native-lookup"]).toMatchObject({ planned: 4, blocked: 4, statuses: { missing: 4 } });
});

it("does not treat retryable unstarted eligible work as terminal when a unit also has skips", async () => {
  const { traces, plan } = await fixture(), output = await scratch(), id = slot(plan);
  const path = plan.lookup.budget.paths.find(p => p.traceId === id.traceId && p.probeId === id.probeId);
  path.initialTokens = 10;
  const args = { flags: {}, plan, traces, mode: "offline", output, modulesLoader: async () => ({}), onPhase: () => {}, head: "a".repeat(40), dirty: false };
  const limit = plan.limits.maxLiveTurns; plan.limits.maxLiveTurns = 0;
  await execute(args);
  const file = join(output, "units", `r1-${id.traceId}-native-lookup.json`);
  const partial = JSON.parse(await readFile(file, "utf8"));
  expect(partial).toMatchObject({ complete: false, eligibleComplete: false });
  expect(partial.trials.map(trial => trial.status)).toEqual(["infeasible", "not_started"]);
  expect(mocks.runProbe).not.toHaveBeenCalled();
  plan.limits.maxLiveTurns = limit;
  mocks.buildCheckpoint.mockResolvedValue({ work: "fictional-work", record: { conversationId: "fictional-conversation" } });
  mocks.createJudge.mockReturnValue(null);
  mocks.runProbe.mockImplementation(async ({ trace, probe, arm, repeat }) => ({ traceId: trace.id, probeId: probe.id, arm: arm.id, repeat,
    category: probe.category, status: "completed", score: { pass: true }, usage: { calls: 1 } }));
  await execute(args);
  expect(mocks.runProbe).toHaveBeenCalledOnce();
  const resumed = JSON.parse(await readFile(file, "utf8"));
  expect(resumed).toMatchObject({ complete: false, eligibleComplete: true });
  expect(resumed.trials.map(trial => trial.status)).toEqual(["infeasible", "completed"]);
});

it("renders skipped, unknown-inventory blocked and missing counts separately", async () => {
  const { plan } = await fixture();
  plan.lookup.budget.paths.pop();
  const summary = summarizeLookup([], plan);
  expect(summary.arms["native-lookup"]).toMatchObject({ planned: 4, skipped: 3, blocked: 1, statuses: { infeasible: 3, missing: 1 } });
  const markdown = renderLookupMarkdown(summary);
  expect(markdown).toContain("| Planned slots | Skipped | Blocked | Missing |");
  expect(markdown).toContain("| native-lookup | 4 | 3 | 1 | 1 |");
});

it("does not accept assumption labels or a faux authorization object as ordinary readiness authority", () => {
  const catalog = { model: "openai-codex:gpt-6.1-sol", contextWindow: 400000, maxTokens: 128000, cost: { ...LOOKUP_ASSUMPTIONS.rates } };
  const descriptor = { capPolicy: "cap-gated-v1", outputCap: "catalog_max_assumed", inputEnvelope: "assumed-v1",
    assumptions: LOOKUP_ASSUMPTIONS, assumptionsSha256: digest(LOOKUP_ASSUMPTIONS) };
  expect(lookupPilotReadiness({ catalog, descriptor, capPolicy: "cap-gated-v1", authorization: { schema: "faux" } })).toMatchObject({ ready: false, status: "awaiting_authorization",
    authorization: { status: "awaiting_authorization" }, pricing: { status: "ready" }, assumptions: { status: "ready" }, blockers: ["lookup_authorization_required"] });
});

it("rejects assumption/catalog drift in cap-gated pricing readiness and uses unknown codes for unknown assumptions", () => {
  const catalog = { model: "openai-codex:gpt-6.1-sol", contextWindow: 400000, maxTokens: 128000, cost: { ...LOOKUP_ASSUMPTIONS.rates } };
  const descriptor = { capPolicy: "cap-gated-v1", outputCap: "catalog_max_assumed", inputEnvelope: "assumed-v1",
    assumptions: LOOKUP_ASSUMPTIONS, assumptionsSha256: digest(LOOKUP_ASSUMPTIONS) };
  for (const change of [c => { c.cost.input++; }, c => { c.maxTokens--; }, c => { c.contextWindow = 100; },
    c => { c.cost.tiers = [{ ...c.cost, inputTokensAbove: 1, output: 100 }]; }]) {
    const changed = structuredClone(catalog); change(changed);
    expect(lookupPilotReadiness({ catalog: changed, descriptor, capPolicy: "cap-gated-v1" })).toMatchObject({ ready: false, pricing: { status: "unknown" } });
  }
  expect(lookupPilotReadiness({ catalog, capPolicy: "cap-gated-v1" })).toMatchObject({
    outputCap: { status: "unknown", code: "lookup_output_cap_unknown" }, inputEnvelope: { status: "unknown", code: "lookup_input_envelope_unknown" } });
});
