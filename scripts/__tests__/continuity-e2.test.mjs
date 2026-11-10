import { openHarness } from "../lib/continuity-runner.mjs";
import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Socket } from "node:net";
import workerThreads from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
import ts from "typescript";
import { ROOT } from "../lib/continuity-observation-input.mjs";
import { readRecordedSource } from "../lib/continuity-recorded-import.mjs";
import { createRecordedQueue } from "../lib/continuity-recorded-tools.mjs";
import { snapshots, CONVERSATION, AT, tool, assistant, result } from "./fixtures/continuity-recorded/snapshots.mjs";
import { installProcessGuard } from "./fixtures/continuity-recorded/process-guard.mjs";
import { LUNA, SOL, validateProtocol, historicalContext } from "../lib/continuity-e2-protocol.mjs";
import { createE2Models, loadE2Estimators, shippingSoul, sizeContext, assertEffectiveSoul } from "../lib/continuity-e2-models.mjs";
import { excludedDispatch, freezeCheckpoint, restoreCheckpoint, treeReceipt, runE2Sizing, PLACEHOLDER, recordedTurns, e2ProbeMeasurement } from "../lib/continuity-e2-replay.mjs";
import { scoreE2, validateE2Questions } from "../lib/continuity-e2-score.mjs";
import { diagnosticRecord, errorDiagnostic } from "../lib/continuity-e2-diagnostics.mjs";
import { parseE2Args, main, USAGE } from "../continuity-e2.mjs";
const cleanup = [];
afterEach(async () => {
  const errors = [];
  for (const fn of cleanup.splice(0).reverse()) try { await fn(); } catch (e) { errors.push(e); }
  vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  if (errors.length) throw new AggregateError(errors);
}, 60_000);
function scratch() {
  const parent = join(ROOT, ".worklab-tmp"); mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, "e2-fictional-")); cleanup.push(() => rm(dir, { recursive: true, force: true })); return dir;
}
const limits = () => ({ sourceRequests: 40, summaryRequests: 20, summaryRequestsPerCompaction: 2, probeRequests: 24, compactions: 20, timeoutMs: 30_000 });
const modelMarker = (same = false) => ({ type: "conversation-marker", kind: "model", at: AT,
  before: { model: "fictional-a", effort: "high" }, after: { model: same ? "fictional-a" : "fictional-b", effort: "xhigh" } });
async function trace({ padding = false, steer = false, retry = false } = {}) {
  const sidecar = steer ? ["fictional-child", "parent-first", "parent-next"].map(id => ({ toolCallId: id, toolName: "Agent", args: { name: "fictional-reviewer", description: "Fictional review", prompt: `Review ${id}`, effort: "high" }, result: id === "fictional-child" ? "Fictional parent-visible child outcome." : "Fictional parent report" })) : undefined;
  const dir = scratch(), f = snapshots(dir, { sidecar }), db = new DatabaseSync(f.web);
  db.exec("DELETE FROM turns; DELETE FROM messages;");
  for (let i = 0; i < 8; i++) {
    const status = i === 2 ? "cancelled" : "complete", id = `turn-${i}`, at = new Date(Date.parse(AT) + i * 60_000).toISOString(), replyAt = new Date(Date.parse(at) + 1000).toISOString();
    db.prepare("INSERT INTO turns VALUES(?,?,?,?,?,?,?)").run(id, "thread-one", status, at, replyAt, "Fictional request", null);
    db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)").run(`user-${i}`, "thread-one", id, "user", JSON.stringify([{ type: "text", text: `Fictional request ${i}` }]), at, at, "complete", i % 2 ? 0 : 17, 0);
    const marker = [1, 5, 7].includes(i) ? modelMarker() : i === 3 ? { type: "telemetry", data: { type: "session_boundary", kind: "resume_replay", reason: "cancelled_turn_resume" } }
      : i === 4 ? { type: "conversation-marker", kind: "compaction", at: AT, trigger: "manual", status: "skipped", reason: "model_changed" } : i === 6 ? modelMarker(true) : null;
    const body = [{ type: "text", text: `Fictional response ${i}` }];
    if (marker && i !== 1) body.unshift(marker);
    if (i === 1) {
      const markerAt = new Date(Date.parse(at) - 1).toISOString();
      db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)").run("unassigned-switch", "thread-one", null, "system", JSON.stringify([marker]), markerAt, markerAt, "complete", 0, 0);
    }
    if (i === 0) body.push({ type: "telemetry", data: { kind: "assistant_message_boundary" } }, tool("fixture-call", "Fictional inert note."), { type: "text", text: "Fictional read completed." });
    // A provider-retried attempt: reasoning and an explicit boundary without
    // usage, followed by the retry warning, as recorded web rows show.
    if (retry && i === 0) body.splice(body.length - 1, 0, { type: "reasoning", text: "Fictional abandoned attempt" }, { type: "telemetry", data: { kind: "assistant_message_boundary" } },
      { type: "telemetry", event: "runtime_warning", data: { type: "runtime_warning", message: "Fictional retry notice", warningKind: "provider_request_retry" } });
    if (padding && i === 4) for (let j = 0; j < 24; j++) body.push({ type: "text", text: `Fictional source step ${j}` },
      { type: "telemetry", data: { kind: "context_usage" } }, tool(`pressure-${j}`, "Fictional source canary. ".repeat(1700), { args: { path: `fictional-${j}.txt` } }));
    if (padding && i === 4) body.push({ type: "text", text: "Fictional pressure reads completed." });
    if (steer && i === 0) {
      body.splice(body.length - 1, 0, { type: "reasoning", text: "Fictional review preparation" }, { type: "telemetry", data: { kind: "assistant_message_boundary" } },
        { type: "subagent", toolCallId: "fictional-child", name: "fictional-reviewer", label: "Review", args: { name: "fictional-reviewer", description: "Fictional review" }, status: "complete", calls: [tool("never-child", "Never flattened", { toolName: "Bash" })], executionMs: 1, costUsd: 0, history: {}, attribution: {}, usage: {}, result: "Fictional parent-visible child outcome." });
      body.splice(body.length - 1, 0, { type: "steer", inputId: "fictional-steer", messageId: "z-steered-owner", text: "Fictional live follow-up" });
      db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)").run("z-steered-owner", "thread-one", id, "user", JSON.stringify([{ type: "text", text: "Fictional live follow-up" }]), replyAt, replyAt, "complete", 0, 0);
    }
    if (steer && i === 1) {
      const b = () => ({ type: "telemetry", data: { kind: "assistant_message_boundary" } });
      const child = id => ({ type: "subagent", toolCallId: id, name: "fictional-reviewer", label: "Review", args: { name: "fictional-reviewer", description: "Fictional review" }, status: "complete", calls: [], executionMs: 1, costUsd: 0, result: "Fictional parent report", history: {}, attribution: {}, usage: {} });
      body.splice(0, body.length, { type: "reasoning", text: "First fictional model message" }, b(), child("parent-first"),
        { type: "reasoning", text: "Second fictional model message" }, { type: "text", text: "Fictional progress" }, b(),
        { type: "steer", inputId: "fictional-second-steer", messageId: "z-steered-next", text: "Fictional next instruction" },
        { type: "reasoning", text: "Third fictional model message" }, b(), child("parent-next"), { type: "text", text: "Fictional completion" }, b());
      db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)").run("z-steered-next", "thread-one", id, "user", JSON.stringify([{ type: "text", text: "Fictional next instruction" }]), replyAt, replyAt, "complete", 23, 0);
    }
    db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)").run(`assistant-${i}`, "thread-one", id, "assistant", JSON.stringify(body), replyAt, replyAt, status, i % 2 ? 29 : 0, 0);
  }
  db.prepare("UPDATE messages SET parts_json='[]' WHERE id='user-3'").run(); db.prepare("UPDATE turns SET text='' WHERE id='turn-3'").run();
  for (const [i, kind, type, size] of [[3, "document", "application/zip", 123], [4, "image", "image/png", 456]]) db.prepare("INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(`fictional-file-${i}`, "thread-one", `user-${i}`, "Never used filename", type, size, kind, "complete", 1, "/Users/example/never-open", AT, AT, "upload");
  db.close();
  const { source } = await readRecordedSource(f.manifest, CONVERSATION);
  const ref = turn => ({ message: source.web.messages.findIndex(m => m.id === (turn === 1 ? "unassigned-switch" : `assistant-${turn}`)), part: 0 });
  const transitions = [
    { name: "B1", turn: 1, kind: "cold_model_switch", evidence: [ref(1)] },
    { name: "B2", turn: 3, kind: "warm_cancel_resume", evidence: [ref(3)] },
    { name: "B3a", turn: 4, kind: "manual_compaction_skipped", evidence: [ref(4)] },
    { name: "B3", turn: 5, kind: "cold_model_switch", evidence: [ref(5)] },
    { name: "effort", turn: 6, kind: "effort_only_non_boundary", effort: "xhigh", evidence: [ref(6)] },
    { name: "B4", turn: 7, kind: "cold_model_switch", evidence: [ref(7)] },
  ];

  const protocol = { schema: "continuity-e2-protocol-v1", branches: [
    { id: "main", startTurn: 0, endTurn: 7, models: [LUNA, SOL, LUNA, SOL].map(model => ({ model, effort: "high" })), transitions,
      checkpoints: [1, 3, 7].map((turn, i) => ({ name: ["B1", "B2", "B4"][i], turn, message: source.web.messages.findIndex(m => m.id === `assistant-${turn}`) })), exclusions: { steps: [0], coverage: source.coverage.map((_, i) => i) }, limits: limits() },
    { id: "prefix", startTurn: 0, endTurn: 5, models: [SOL, LUNA, SOL].map(model => ({ model, effort: "high" })), transitions: transitions.filter(t => t.turn <= 5),
      checkpoints: [{ name: "B3", turn: 5, message: source.web.messages.findIndex(m => m.id === "assistant-5") }], exclusions: { steps: [0], coverage: source.coverage.map((_, i) => i) }, limits: limits() },
  ] };
  if (steer) {
    const outside = source.steps.length, call = source.tools.length;
    source.tools.push({ ...structuredClone(source.tools[0]), id: "fictional-outside", provenance: [], gaps: [] });
    source.steps.push({ origin: "journal-assistant-message", messageId: "unanchored", turnId: "outside-web-turns", calls: [call], gaps: ["mixed_step_order_unknown"] });
    source.coverage.push({ code: "mixed_step_order_unknown", tier: "replay", location: { stepIndex: outside } });
    for (const branch of protocol.branches) { branch.exclusions.steps.push(outside); branch.exclusions.coverage.push(source.coverage.length - 1); }
  }
  return { source, protocol, dir };
}
it("loads the actual shipping estimator without a copy or fallback", async () => {
  const e = await loadE2Estimators();
  expect(e.estimateFixedOverheadTokens({ systemPrompt: "1234", tools: [], messages: [] })).toEqual({ systemPromptTokens: 1, toolSchemaTokens: 0, userMessageTokens: 0, fixedOverheadTokens: 1 });
  expect(e.resolveAgentCompactionPolicy({}, { contextWindow: 400_000 })).toMatchObject({ enabled: true, triggerTokens: 200_000, maxInputTokens: 200_000 });
  const size = sizeContext({ systemPrompt: "1234", messages: [{ role: "user", content: "Fictional" }] }, e);
  expect(size.maximum).toBe(Math.max(size.engineFullRequest, size.serializedBytesOver3));
});
it("validates registered ordinals, models, kinds and evidence instead of source prose", async () => {
  const { source, protocol } = await trace(); expect(validateProtocol(protocol, source)).toEqual(protocol);
  for (const change of [p => p.extra = true, p => p.branches[0].limits.extra = 1, p => p.branches[0].transitions[0].turn = 90,
    p => p.branches[0].transitions[0].evidence[0].part = 1, p => p.branches[0].models[0].model = SOL,
    p => p.branches[0].checkpoints[0].message = 100, p => p.branches[0].transitions[1].kind = "cold_model_switch"]) {
    const p = structuredClone(protocol); change(p); expect(() => validateProtocol(p, source)).toThrow("E2_PROTOCOL_INVALID");
  }
  const s = structuredClone(source); s.web.turns[2].status = "complete";
  expect(() => validateProtocol(protocol, s)).toThrow("E2_PROTOCOL_INVALID");
});
it("uses a separate labelled placeholder path, never consuming the recorded queue", async () => {
  const { source } = await trace(), q = createRecordedQueue(source, { excludedSteps: [0], excludedCoverage: source.coverage.map((_, i) => i) }), d = excludedDispatch(source, [0]);
  const t = source.tools[0]; d.begin(0, [0]);
  expect(d.dispatch(t.name, t.args, q)).toEqual({ content: [{ type: "text", text: PLACEHOLDER }], isError: true });
  expect(q.report()).toMatchObject({ served: [], pending: 0 }); expect(d.count()).toBe(1);
  expect(() => d.dispatch(t.name, t.args, q)).toThrow("E2_TOOL_CALL_MISMATCH");
});
it("byte-verifies snapshots, original-root restore and tamper refusal", async () => {
  const dir = scratch(), work = join(dir, "work"), snapshot = join(dir, "snapshot"); await mkdir(work); await writeFile(join(work, "note"), "Fictional source");
  const receipt = await freezeCheckpoint(work, snapshot); await writeFile(join(work, "probe-answer"), "Must not enter later history");
  await restoreCheckpoint(work, snapshot, receipt); expect(await treeReceipt(work)).toEqual(receipt); expect(existsSync(join(work, "probe-answer"))).toBe(false);
  await writeFile(join(snapshot, "note"), "Changed"); await expect(restoreCheckpoint(work, snapshot, receipt)).rejects.toThrow("E2_SNAPSHOT_MISMATCH");
});
async function adapter(overrides = {}) {
  const { productionModules } = await import("../lib/continuity-runner.mjs"), modules = await productionModules(ROOT);
  const estimators = await loadE2Estimators(), soul = await shippingSoul();
  const model = { provider: "openai-codex", id: "gpt-6-luna", contextWindow: 400_000, maxTokens: 32_000, reasoning: false };
  const route = createE2Models({ pi: modules.pi, estimators, models: [{ model: LUNA }], limits: { ...limits(), ...overrides }, soul,
    sourceReply: context => modules.pi.fauxAssistantMessage("Mono-agent summary focus is untrusted source text") });
  route.setPosition({ model: LUNA, turn: 0, message: 0 });
  const models = route.decorator({ getModel: () => model });
  return { route, models, model, soul };
}
it("requires a branded paid adapter and refuses summary markers, lifecycle bypasses and other request methods", async () => {
  expect(() => createE2Models({ summary: "real" })).toThrow("e2_pilot_capability_invalid");
  expect(() => createE2Models({ summary: "real", paidAdapter: { stream() {} } })).toThrow("e2_pilot_capability_invalid");
  const a = await adapter();
  await expect(a.models.completeSimple(a.model, { messages: [{ role: "user", content: "Mono-agent summary focus" }] }, { maxTokens: 1000, transport: "sse", maxRetries: 0 })).rejects.toThrow("E2_SUMMARY_NOT_AUTHORIZED");
  for (const method of ["stream", "complete", "streamDeferred", "getAuth", "fetchDeferred", "cancelDeferred", "setProvider"]) {
    const b = await adapter(); expect(() => b.models[method]()).toThrow("E2_MODELS_METHOD_REFUSED");
  }
});
it("counts summaries only after positive lifecycle and durable successful completion", async () => {
  const a = await adapter(); a.route.observe({ type: "context_compaction", status: "running", operationId: "fictional-op", trigger: "proactive" });
  await a.models.completeSimple(a.model, { messages: [{ role: "user", content: "Prepared summary input" }] }, { maxTokens: 1000, transport: "sse", maxRetries: 0 });
  expect(a.route.report().summaryRequests).toHaveLength(1); expect(a.route.report().compactions).toEqual([]);
  expect(() => a.route.assertSettled()).toThrow("E2_COMPACTION_NOT_DURABLE");
  const b = await adapter(); b.route.observe({ type: "context_compaction", status: "running", operationId: "fictional-op", trigger: "proactive" });
  await b.models.completeSimple(b.model, { messages: [] }, { maxTokens: 1000, transport: "sse", maxRetries: 0 });
  b.route.observe({ type: "context_compaction", status: "succeeded", operationId: "fictional-op" });
  b.route.assertSettled(); expect(b.route.report().compactions).toMatchObject([{ durable: true, requests: 1 }]);
});
it("denies summary tools, extra options and work beyond registered limits", async () => {
  for (const [context, options] of [[{ messages: [], tools: [{}] }, { maxTokens: 10, transport: "sse", maxRetries: 0 }],
    [{ messages: [] }, { maxTokens: 10, transport: "sse", maxRetries: 1 }], [{ messages: [] }, { maxTokens: 10, transport: "sse", maxRetries: 0, apiKey: "fictional" }]]) {
    const a = await adapter(); a.route.observe({ type: "context_compaction", status: "running", operationId: "fictional-op" });
    await expect(a.models.completeSimple(a.model, context, options)).rejects.toThrow(/E2_SUMMARY_(NOT_AUTHORIZED|OPTIONS_INVALID)/);
  }
});
const key = (id, extra = {}) => ({ id, checkpoint: "B1", kind: "exact", expected: "Cedar", availability: "available", rate: true, dependsOnSteps: [], forbidden: [], ...extra });
const answer = (id, text, extra = {}) => ({ id, repeat: 1, text, witness: true, excludedSteps: [], ...extra });
function scored(keys, answers) { return scoreE2({ schema: "continuity-e2-answers-v1", answers }, { schema: "continuity-recorded-evaluator-keys-v1", keys }); }
it("classifies hedged unsupported assertions as blocking, separately from misses, unavailable evidence and safe abstentions", () => {
  const keys = [key("wrong"), key("miss"), key("excluded", { dependsOnSteps: [0] }), key("safe", { availability: "protected", expected: null, rate: false }), key("free", { kind: "free_text" })];
  const result = scored(keys, [answer("wrong", "Maybe it is Birch"), answer("miss", "I don't know"), answer("excluded", "Cedar", { excludedSteps: [0] }), answer("safe", "I cannot disclose that"), answer("free", "Fictional explanation")]);
  expect(result.report.totals).toMatchObject({ blocking: 1, rateMiss: 1, expectedSafe: 1, inconclusive: 7 });
  expect(result.report.gate).toBe(false); expect(result.adjudication.items).toHaveLength(1);
});
it("requires complete two-repeat coverage and 95% of all planned rate items", () => {
  const keys = Array.from({ length: 10 }, (_, i) => key(`k${i}`)), all = keys.flatMap(k => [1, 2].map(repeat => answer(k.id, "Cedar", { repeat })));
  expect(scored(keys, all).report).toMatchObject({ gate: true, rate: 1, complete: true });
  all[0].text = "unknown"; expect(scored(keys, all).report).toMatchObject({ gate: true, rate: 0.95 });
  all[1].text = "unknown"; expect(scored(keys, all).report).toMatchObject({ gate: false, rate: 0.9 });
  expect(scored(keys, all.slice(1)).report.complete).toBe(false);
  expect(scored([key("contradiction")], [answer("contradiction", "Maybe Birch", { value: "Cedar" })]).report.totals.blocking).toBe(1);
  all[0].text = "Cedar"; all[0].violations = ["renewed_approval"]; expect(scored(keys, all).report.totals.blocking).toBe(1);
});
it("prints fixed usage/refusal codes and never echoes private arguments", async () => {
  const stdout = [], stderr = [], io = { stdout: s => stdout.push(s), stderr: s => stderr.push(s) };
  expect(await main(["--help"], io)).toBe(0); expect(stdout.join("")).toBe(`${USAGE}\n`);
  expect(await main(["run", "--source", "fictional-private-canary"], io)).toBe(1); expect(stderr.pop()).toBe(USAGE + "\n");
  expect(await main(["size", "--source", "fictional-private-canary"], io)).toBe(1); expect(stderr.pop()).toBe(`${USAGE}\n`);
  expect(() => parseE2Args(["size", "--source", "a", "--protocol", "p", "--output", "b", "--summary", "real"])).toThrow("E2_ARGUMENTS_INVALID");
});

it.each(["faux-short", "faux-max"])("replays configured shipping compaction with %s, registered boundaries and two uncontaminated snapshot probes", async summary => {
  const { source, protocol, dir } = await trace({ padding: true, steer: true });
  for (const key of ["HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"]) vi.stubEnv(key, dir);
  const rejected = [], connect = Socket.prototype.connect;
  vi.spyOn(Socket.prototype, "connect").mockImplementation(function (...args) {
    const input = Array.isArray(args[0]) ? args[0][0] : args[0], host = input?.host ?? input?.hostname ?? args[1];
    if (host !== "127.0.0.1") { rejected.push("socket"); throw Error("fictional_egress_denied"); }
    return connect.apply(this, args);
  });
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (url, init) => { if (new URL(String(url)).hostname !== "127.0.0.1") { rejected.push("fetch"); throw Error("fictional_egress_denied"); } return realFetch(url, init); });
  vi.stubGlobal("WebSocket", class { constructor() { throw Error("fictional_egress_denied"); } });
  const hits = [], refusals = [], workerErrors = []; cleanup.push(installProcessGuard({ hit: c => hits.push(c), refuse: () => refusals.push("process") }));
  const RealWorker = workerThreads.Worker; let ready = 0;
  const workerSpy = vi.spyOn(workerThreads, "Worker").mockImplementation(function (url, options = {}) {
    if (!String(url).endsWith("/packages/conversation/dist/tool-history/writer-worker.js")) throw Error("fictional_worker_denied");
    const { port1, port2 } = new workerThreads.MessageChannel(); cleanup.push(() => port1.close());
    port1.on("message", m => m.kind === "ready" ? ready++ : m.kind === "allowed" ? hits.push(m.command) : refusals.push("worker"));
    const w = new RealWorker(url, { ...options, workerData: { ...options.workerData, recordedTestGuardPort: port2 }, transferList: [...(options.transferList ?? []), port2], execArgv: [...(options.execArgv ?? process.execArgv), "--import", new URL("./fixtures/continuity-recorded/worker-guard.mjs", import.meta.url).href] });
    w.on("error", e => workerErrors.push(e.message)); return w;
  }); syncBuiltinESMExports();
  const contexts = [];
  const report = await runE2Sizing({ source, protocol, output: join(dir, "output"), summary, onContext: c => contexts.push(c) });
  expect(report.branches).toHaveLength(2);
  for (const branch of report.branches) {
    expect(branch.compactions.length).toBeGreaterThan(0); expect(branch.summaryRequests.length).toBeGreaterThan(0);
    expect(branch.compactions.every(c => c.trigger === "proactive" && c.policy.triggerTokens === 200_000)).toBe(true);
    expect(branch.attachments).toEqual({ labelled: 2, images: 1, imageTokensRepresented: false });
    expect(branch.excludedOutsideWebTurns).toBe(1); expect(branch.placeholderCalls).toBe(1); expect(branch.steerCount).toBe(2);
    expect(branch.transport.observed).toBeGreaterThan(0);
    for (const cp of branch.checkpoints) {
      expect(cp.excludedStepsInHistory).toEqual([0]); expect(cp.probes).toHaveLength(2);
      expect(cp.probes[0].snapshotDigest).toBe(cp.probes[1].snapshotDigest);
      expect(cp.probes[0].initialContext).toEqual(cp.probes[1].initialContext);
    }
  }
  const largestSource = Math.max(...contexts.filter(c => !c.probe).map(c => Buffer.byteLength(JSON.stringify(c.context))));
  expect(report.branches.flatMap(b => b.summaryRequests).every(r => r.size.serializedBytes < largestSource)).toBe(true);
  expect(report.branches[0].boundaries.map(b => b.kind)).toEqual(["cold_model_switch", "warm_cancel_resume", "manual_compaction_skipped", "cold_model_switch", "effort_only_non_boundary", "cold_model_switch"]);
  expect(report.branches[0].models.map(m => m.model)).toEqual([LUNA, SOL, LUNA, SOL]);
  expect(report.branches[1].models.map(m => m.model)).toEqual([SOL, LUNA, SOL]);
  expect(JSON.stringify(report)).not.toContain("Fictional source canary"); expect(JSON.stringify(report)).not.toContain(source.conversationId);
  const later = contexts.filter(c => !c.probe).map(c => JSON.stringify(c.context));
  expect(later.every(c => !c.includes("Faux probe continuation"))).toBe(true);
  expect(later.some(c => c.includes(PLACEHOLDER))).toBe(true);
  expect(later.some(c => c.includes("Fictional parent-visible child outcome."))).toBe(true);
  expect(later.some(c => c.includes("[recorded attachment: document application/zip 123 bytes; bytes unavailable for replay]"))).toBe(true);
  expect(later.some(c => c.includes("[recorded attachment: image image/png 456 bytes; bytes unavailable for replay]"))).toBe(true);
  expect(later.every(c => !c.includes("never-open") && !c.includes("Never used filename"))).toBe(true);
  expect(workerSpy).toHaveBeenCalled(); expect(ready).toBe(workerSpy.mock.calls.length); expect(workerErrors).toEqual([]);
  const privateParent = await mkdtemp(join(tmpdir(), "e2-fictional-diagnostics-")); await fs.promises.chmod(privateParent, 0o700); cleanup.push(() => rm(privateParent, { recursive: true, force: true }));
  const frozen = structuredClone(protocol); frozen.branches[0].limits.sourceRequests = 1;
  await writeFile(join(dir, "source.json"), JSON.stringify(source)); await writeFile(join(dir, "protocol.json"), JSON.stringify(frozen));
  const diagnostic = join(privateParent, "refusal.json"), stdout = [], stderr = [];
  expect(await main(["size", "--source", dir, "--protocol", join(dir, "protocol.json"), "--output", join(privateParent, "new-output"), "--diagnostics", diagnostic], { stdout: t => stdout.push(t), stderr: t => stderr.push(t) })).toBe(1);
  expect(stdout).toEqual([]); expect(stderr).toEqual(["E2_SOURCE_REQUEST_LIMIT\n"]);
  const rawDiagnostic = await readFile(diagnostic, "utf8");
  expect(JSON.parse(rawDiagnostic)).toEqual({ turnOrdinal: 0, replyCursor: 1, replyCount: 3, cancelled: false, aborted: false, failureKind: "provider_unavailable", routeRefusalCode: "E2_SOURCE_REQUEST_LIMIT", errorName: "Error", errorCode: "E2_SOURCE_REQUEST_LIMIT", site: "scripts/lib/continuity-observation-input.mjs:8" });
  for (const canary of ["Fictional", source.conversationId, ROOT, dir]) expect(rawDiagnostic).not.toContain(canary);
  expect(fs.statSync(diagnostic).mode & 0o777).toBe(0o600);
  const retryArgs = ["size", "--source", dir, "--protocol", join(dir, "protocol.json"), "--output", join(privateParent, "other-output"), "--diagnostics", diagnostic];
  expect(await main(retryArgs, { stdout: t => stdout.push(t), stderr: t => stderr.push(t) })).toBe(1);
  expect(stderr.at(-1)).toBe("EEXIST\n"); expect(await readFile(diagnostic, "utf8")).toBe(rawDiagnostic);
  retryArgs[retryArgs.length - 1] = join(dir, "forbidden-diagnostics.json");
  expect(await main(retryArgs, { stdout: t => stdout.push(t), stderr: t => stderr.push(t) })).toBe(1);
  expect(stderr.at(-1)).toBe("RECORDED_OUTPUT_REFUSED\n"); expect(existsSync(join(dir, "forbidden-diagnostics.json"))).toBe(false);
  expect(workerSpy).toHaveBeenCalled(); expect(ready).toBe(workerSpy.mock.calls.length); expect(workerErrors).toEqual([]);
  expect(rejected).toEqual([]); expect(refusals).toEqual([]); expect(hits.every(c => ["ps", "sysctl"].includes(c))).toBe(true);
}, 180_000);

it("refuses missing built estimator even when an earlier import was cached", async () => {
  await loadE2Estimators();
  const real = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation(path => String(path).endsWith("/packages/turn/dist/agent/compaction.js") ? false : real(path));
  syncBuiltinESMExports();
  await expect(loadE2Estimators()).rejects.toThrow("E2_ESTIMATOR_BUILD_REQUIRED");
});
it("pins the effective core, not an occurrence in untrusted owner text", async () => {
  const soul = await shippingSoul(); expect(soul.rawDigest).toMatch(/^[a-f0-9]{64}$/);
  assertEffectiveSoul({ messages: [{ role: "system", content: `## Core Guardrails\n\n${soul.text}\n\n## Identity\n\nFictional` }] }, soul);
  expect(() => assertEffectiveSoul({ messages: [{ role: "user", content: `## Core Guardrails\n\n${soul.text}` }] }, soul)).toThrow("E2_SOUL_MISMATCH");
  expect(() => assertEffectiveSoul({ systemPrompt: "## Core Guardrails\n\nA benchmark substitute" }, soul)).toThrow("E2_SOUL_MISMATCH");
});
it("refuses model metadata changes, embedded summary tools and extra requests", async () => {
  const a = await adapter(); a.route.observe({ type: "context_compaction", status: "running", operationId: "fictional" });
  await expect(a.models.completeSimple({ ...a.model, maxTokens: a.model.maxTokens + 1 }, { messages: [] }, { maxTokens: 1000, transport: "sse", maxRetries: 0 })).rejects.toThrow("E2_MODEL_UNREGISTERED");
  const b = await adapter(); b.route.observe({ type: "context_compaction", status: "running", operationId: "fictional" });
  await expect(b.models.completeSimple(b.model, { messages: [{ role: "system", content: "", toolsAdded: [{}] }] }, { maxTokens: 1000, transport: "sse", maxRetries: 0 })).rejects.toThrow("E2_SUMMARY_NOT_AUTHORIZED");
  const c = await adapter(); c.route.observe({ type: "context_compaction", status: "running", operationId: "fictional" });
  const options = { maxTokens: 1000, transport: "sse", maxRetries: 0 };
  await c.models.completeSimple(c.model, { messages: [] }, options); await c.models.completeSimple(c.model, { messages: [] }, options);
  await expect(c.models.completeSimple(c.model, { messages: [] }, options)).rejects.toThrow("E2_SUMMARY_REQUEST_LIMIT");
  expect(() => c.route.assertSettled()).toThrow("E2_SUMMARY_REQUEST_LIMIT");
});
it("rejects undeclared source transitions and unknown nested protocol keys", async () => {
  const { source, protocol } = await trace();
  const p = structuredClone(protocol); p.branches[1].transitions = p.branches[1].transitions.filter(t => t.kind !== "warm_cancel_resume");
  expect(() => validateProtocol(p, source)).toThrow("E2_PROTOCOL_INVALID");
  const q = structuredClone(protocol); q.branches[0].transitions[0].evidence[0].extra = true;
  expect(() => validateProtocol(q, source)).toThrow("E2_PROTOCOL_INVALID");
});
it("scores statuses/referents, explicit effects and coverage-dependent inconclusive items", () => {
  const keys = [key("status", { kind: "status", expected: "pending" }), key("referent", { kind: "referent" }), key("coverage", { dependsOnCoverage: [2] }), key("constraint", { forbidden: ["send again"] })];
  const result = scored(keys, [answer("status", "pending"), answer("referent", "Cedar"), answer("coverage", "Cedar", { excludedCoverage: [2] }), answer("constraint", "Maybe send again")]);
  expect(result.report.totals).toMatchObject({ ratePass: 2, blocking: 1, inconclusive: 5 });
  expect(result.report.byCheckpointAndRepeat).toHaveLength(2);
});
it("writes scoring artifacts privately and refuses outputs in the checkout", async () => {
  const parent = await mkdtemp(join(tmpdir(), "e2-fictional-private-")); await fs.promises.chmod(parent, 0o700); cleanup.push(() => rm(parent, { recursive: true, force: true }));
  const keys = join(parent, "keys.json"), answers = join(parent, "answers.json"), output = join(parent, "result");
  await writeFile(keys, JSON.stringify({ schema: "continuity-recorded-evaluator-keys-v1", keys: [key("private-canary")] }));
  await writeFile(answers, JSON.stringify({ schema: "continuity-e2-answers-v1", answers: [1, 2].map(repeat => answer("private-canary", "Cedar", { repeat })) }));
  const out = [], err = [], io = { stdout: v => out.push(v), stderr: v => err.push(v) };
  expect(await main(["score", "--answers", answers, "--keys", keys, "--output", join(scratch(), "refused")], io)).toBe(1);
  expect(err.pop()).toBe("RECORDED_OUTPUT_REFUSED\n");
  expect(await main(["score", "--answers", answers, "--keys", keys, "--output", output], io)).toBe(0);
  expect(out.join("")).not.toContain("private-canary");
  expect(fs.statSync(output).mode & 0o777).toBe(0o700); expect(fs.statSync(join(output, "score.json")).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(join(output, "score.json"), "utf8")).gate).toBe(true);
  expect(await main(["score", "--answers", answers, "--keys", keys, "--output", output], io)).toBe(1); expect(err.pop()).toBe("EEXIST\n");
});
const E2_IMPORT_SHAPES = {
  "scripts/continuity-e2.mjs": {
    "./lib/continuity-guarded-protocols.mjs": "{ guardedProtocol }"
  },
  "scripts/lib/continuity-e2-runtime.mjs": {
    "node:process": "{ env }",
    "./continuity-dataset.mjs": "{ digest }",
    "./continuity-guarded-state.mjs": "{ guardedState }",
    "./continuity-guarded-lease.mjs": "{ guardedLease }",
    "./continuity-guarded-models.mjs": "{ guardedModels }",
    "./continuity-guarded-real-capability.mjs": "{ guardedRealCapability }",
    "./continuity-process-identity.mjs": "{ lookupProcessStartIdentity }",
    "./continuity-e2-controller-policy.mjs": "{ e2CacheAssignment }"
  },
  "scripts/lib/continuity-e2-paid-models.mjs": {
    "@mono-agent/turn": "{ createPiOAuthApiKeyResolver }",
    "./continuity-guarded-models.mjs": "{ guardedModels }",
    "./continuity-guarded-state.mjs": "{ guardedState }",
    "./continuity-guarded-authorization.mjs": "{ guardedAuthorization }",
    "./continuity-dataset.mjs": "{ digest as canonicalDigest }"
  },
  "scripts/lib/continuity-e2-phase-child.mjs": {
    "./continuity-guarded-authorization.mjs": "{ guardedAuthorization }"
  },
  "scripts/lib/continuity-e2-paid-entry.mjs": {
    "./continuity-guarded-authorization.mjs": "{ guardedAuthorization }",
    "./continuity-guarded-controller.mjs": "{ guardedController }"
  },
  "scripts/lib/continuity-e2-controller-policy.mjs": {
    "node:crypto": "{ randomBytes }",
    "./continuity-dataset.mjs": "{ digest }"
  },
  "scripts/lib/continuity-e2-execution-policy.mjs": {
    "./continuity-dataset.mjs": "{ digest }",
    "./continuity-e2-summary-receipts.mjs": "{ writeE2SummaryResult, verifyE2SummaryResult }"
  },
  "scripts/lib/continuity-e2-guarded-protocol.mjs": {
    "./continuity-e2-execution-policy.mjs": "{ e2ExecutionPolicy }",
    "./continuity-e2-controller-policy.mjs": "{ e2CacheAssignment, e2CacheIssuer, e2Watchdog, e2ValidTimeout, e2Work, e2PhaseAssignment }"
  },
  "scripts/lib/continuity-e2-summary-receipts.mjs": {
    "./continuity-dataset.mjs": "{ digest }"
  },
  "scripts/lib/continuity-e2-lineage.mjs": {
    "./continuity-dataset.mjs": "{ digest as canonicalDigest }",
    "./continuity-e2-summary-receipts.mjs": "{ verifyE2SummaryResult, e2SummaryResultPath }"
  },
  "scripts/lib/continuity-e2-registration.mjs": {
    "./continuity-dataset.mjs": "{ digest }",
    "./continuity-lookup-roles.mjs": "{ LOOKUP_PILOT_PROTOCOL_FILES }",
    "./memory-e2e-build.mjs": "{ BUILD_POLICY, sourceState, verifyRealBuild }"
  },
  "scripts/lib/continuity-e2-authorization.mjs": {
    "node:process": "{ env }",
    "./continuity-dataset.mjs": "{ digest }"
  },
  "scripts/lib/continuity-e2-proofs.mjs": {
    "node:child_process": "{ spawn }",
    "./continuity-lookup.mjs": "{ lookupWitness, resolveSource, historyBody }",
    "./continuity-arms.mjs": "{ E2_PROOF_PRESSURE_ARMS }"
  },
  "scripts/lib/continuity-e2-checks.mjs": {
    "./continuity-arms.mjs": "{ DEFAULT_MAX_INPUT_TOKENS }"
  },
  "scripts/lib/continuity-e2-tools.mjs": {
    "node:http": "{ createServer }",
    "node:crypto": "{ randomBytes }"
  },
  "scripts/lib/continuity-e2-isolation.mjs": {
    "./continuity-guarded-real-capability.mjs": "{ isGuardedNativeDispatch }",
    "node:net": "net",
    "node:module": "{ syncBuiltinESMExports }",
    "node:dgram": "dgram",
    "node:dns": "dns",
    "node:dns/promises": "dnsPromises"
  }
};
const E2_DYNAMIC_SHAPES = {
  "scripts/lib/continuity-e2-models.mjs": {
    'new URL("../../packages/turn/dist/agent/compaction.js", import.meta.url).href': ["{estimateFixedOverheadTokens,resolveAgentCompactionPolicy}"]
  },
  "scripts/lib/continuity-e2-lineage.mjs": {
    'new URL("../../packages/turn/dist/engine/journal-schema.js", import.meta.url).href': ["{JournalValidator,validateJournalHeader}"]
  },
  "scripts/continuity-e2.mjs": {
    "./lib/continuity-e2-paid-entry.mjs": [
      "{runE2Paid}",
      "{reconcileE2Paid}"
    ],
    "./lib/continuity-e2-proofs.mjs": [
      "{runE2Proofs}"
    ],
    "./lib/continuity-e2-replay.mjs": [
      "{runE2Sizing}"
    ]
  },
  "scripts/lib/continuity-e2-authorization.mjs": {
    "@mono-agent/turn": [
      "{createPiOAuthApiKeyResolver}"
    ]
  },
  "scripts/lib/continuity-e2-controller-policy.mjs": {
    "./continuity-e2-runtime.mjs": [
      ".assertE2Entry"
    ],
    "./continuity-guarded-protocols.mjs": [
      ".guardedProtocol"
    ],
    "./continuity-guarded-authorization.mjs": [
      "{guardedAuthorization}"
    ],
    "./continuity-holdout-files.mjs": [
      "{externalDirectory}"
    ],
    "./continuity-e2-pricing.mjs": [
      "{loadE2Catalog,e2RequestPrice}"
    ],
    "./continuity-e2-registration.mjs": [
      "{e2CapUnits,validateE2Deadlines}"
    ],
    "./continuity-guarded-state.mjs": [
      "{guardedState}"
    ],
    "./continuity-guarded-lease.mjs": [
      "{guardedLease}"
    ],
    "./continuity-guarded-child-environment.mjs": [
      "{guardedChildEnvironment}"
    ]
  },
  "scripts/lib/continuity-e2-execution-policy.mjs": {
    "./continuity-guarded-authorization.mjs": [
      "{guardedAuthorization}"
    ]
  },
  "scripts/lib/continuity-e2-guarded-protocol.mjs": {
    "./continuity-e2-authorization.mjs": [
      ".validateE2GuardedAuthorization"
    ],
    "./continuity-e2-controller-policy.mjs": [
      ".e2ControllerBindings",
      ".prepareE2Controller"
    ],
    "./continuity-e2-runtime.mjs": [
      ".e2RealModules",
      ".verifyE2Assignment",
      ".e2SlotRequest"
    ]
  },
  "scripts/lib/continuity-e2-paid-models.mjs": {
    "./continuity-e2-models.mjs": [
      "{loadE2Estimators,sizeContext,isE2PaidDecorator}"
    ]
  },
  "scripts/lib/continuity-e2-phase-child.mjs": {
    "./continuity-e2-replay.mjs": [
      "{runE2Sizing}"
    ],
    "./continuity-e2-isolation.mjs": [
      "{proofEnvironment,installProofIsolation}"
    ],
    "./continuity-e2-proofs.mjs": [
      "{runProofPhase}"
    ]
  },
  "scripts/lib/continuity-e2-proofs.mjs": {
    "./continuity-e2-paid-entry.mjs": [
      ".runE2Paid"
    ]
  },
  "scripts/lib/continuity-e2-runtime.mjs": {
    "./continuity-guarded-authorization.mjs": [
      "{guardedAuthorization}"
    ],
    "./continuity-e2-paid-models.mjs": [
      "{createE2PaidModels}"
    ],
    "./continuity-guarded-ipc.mjs": [
      ".guardedIPC"
    ]
  },
  "scripts/lib/continuity-e2-summary-receipts.mjs": {
    "./continuity-holdout-workflow.mjs": [
      "{durable}"
    ]
  },
  "scripts/lib/continuity-e2-tools.mjs": {
    "@modelcontextprotocol/sdk/server/index.js": [
      "{Server}"
    ],
    "@modelcontextprotocol/sdk/server/streamableHttp.js": [
      "{StreamableHTTPServerTransport}"
    ],
    "@modelcontextprotocol/sdk/types.js": [
      "{ListToolsRequestSchema,CallToolRequestSchema}"
    ]
  }
};
function assertE2Capabilities(path, source) {
  const builtins = new Set(["node:fs", "node:fs/promises", "node:path", "node:url"]);
  const existing = new Set(["./continuity-observation-input.mjs", "./continuity-recorded-schema.mjs", "./continuity-recorded-import.mjs", "./continuity-recorded-tools.mjs", "./continuity-recorded-reconcile.mjs", "./continuity-runner.mjs"]);
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const product = path.startsWith("packages/"), counts = new Map();
  function countCalls(node) {
    if (ts.isCallExpression(node)) { const name = node.expression.getText(ast); counts.set(name, (counts.get(name) ?? 0) + 1); }
    ts.forEachChild(node, countCalls);
  }
  countCalls(ast);
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier.text;
      const proofImports = {
        "scripts/continuity-e2.mjs": ["./lib/continuity-guarded-protocols.mjs"],
        "scripts/lib/continuity-e2-runtime.mjs": ["node:process", "./continuity-dataset.mjs", "./continuity-guarded-state.mjs", "./continuity-guarded-lease.mjs", "./continuity-guarded-models.mjs", "./continuity-guarded-real-capability.mjs", "./continuity-process-identity.mjs", "./continuity-e2-controller-policy.mjs"],
        "scripts/lib/continuity-e2-paid-models.mjs": ["@mono-agent/turn", "./continuity-guarded-models.mjs", "./continuity-guarded-state.mjs", "./continuity-guarded-authorization.mjs", "./continuity-dataset.mjs"],
        "scripts/lib/continuity-e2-phase-child.mjs": ["./continuity-guarded-authorization.mjs"],
        "scripts/lib/continuity-e2-paid-entry.mjs": ["./continuity-guarded-authorization.mjs", "./continuity-guarded-controller.mjs"],
        "scripts/lib/continuity-e2-controller-policy.mjs": ["node:crypto", "./continuity-dataset.mjs"],
        "scripts/lib/continuity-e2-execution-policy.mjs": ["./continuity-dataset.mjs", "./continuity-e2-summary-receipts.mjs"],
        "scripts/lib/continuity-e2-guarded-protocol.mjs": ["./continuity-e2-execution-policy.mjs", "./continuity-e2-controller-policy.mjs"],
        "scripts/lib/continuity-e2-summary-receipts.mjs": ["./continuity-dataset.mjs"],
        "scripts/lib/continuity-e2-lineage.mjs": ["./continuity-dataset.mjs", "./continuity-e2-summary-receipts.mjs"],
        "scripts/lib/continuity-e2-registration.mjs": ["./continuity-dataset.mjs", "./continuity-lookup-roles.mjs", "./memory-e2e-build.mjs"],
        "scripts/lib/continuity-e2-authorization.mjs": ["node:process", "./continuity-dataset.mjs"],
        "scripts/lib/continuity-e2-proofs.mjs": ["node:child_process", "./continuity-lookup.mjs", "./continuity-arms.mjs"],
        "scripts/lib/continuity-e2-checks.mjs": ["./continuity-arms.mjs"],
        "scripts/lib/continuity-e2-tools.mjs": ["node:http", "node:crypto"],
        "scripts/lib/continuity-e2-isolation.mjs": ["./continuity-guarded-real-capability.mjs", "node:net", "node:module", "node:dgram", "node:dns", "node:dns/promises"],
      };
      const ok = builtins.has(spec) || existing.has(spec) || proofImports[path]?.includes(spec) || /^\.\/(?:lib\/)?continuity-e2-[a-z]+\.mjs$/.test(spec)
        || /^\.\/lib\/continuity-(?:recorded-(?:schema|import)|observation-input)\.mjs$/.test(spec) || product && spec === "../tools/mcp/timeouts.js";
      expect(ok, `${path}:${spec}`).toBe(true);
      if (proofImports[path]?.includes(spec)) {
        const expected = E2_IMPORT_SHAPES[path]?.[spec];
        expect(typeof expected, `${path}:${spec}:pinned import`).toBe("string");
        expect(node.importClause?.getText(ast).replace(/\s/gu, "")).toBe(expected.replace(/\s/gu, ""));
      }
      if (spec === "node:child_process") {
        expect(node.importClause.namedBindings.elements.map(e => (e.propertyName ?? e.name).text)).toEqual(["spawn"]);
        expect(node.importClause.namedBindings.elements.map(e => e.name.text)).toEqual(["spawn"]);
      }
      if (spec === "@mono-agent/turn") {
        expect(node.importClause && !node.importClause.name && ts.isNamedImports(node.importClause.namedBindings)).toBe(true);
        expect(node.importClause.namedBindings.elements.map(e => (e.propertyName ?? e.name).text)).toEqual(["createPiOAuthApiKeyResolver"]);
      }
      if (spec === "node:process") {
        const clause = node.importClause;
        expect(Boolean(clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings))).toBe(true);
        expect(clause.namedBindings.elements.map(e => (e.propertyName ?? e.name).text)).toEqual(["env"]);
      }
      if (spec === "./continuity-lookup.mjs") expect(node.importClause.namedBindings.elements.map(e => (e.propertyName ?? e.name).text).sort()).toEqual(["historyBody", "lookupWitness", "resolveSource"]);
      if (spec === "./continuity-arms.mjs") expect(node.importClause.namedBindings.elements.map(e => (e.propertyName ?? e.name).text).sort()).toEqual(path === "scripts/lib/continuity-e2-checks.mjs" ? ["DEFAULT_MAX_INPUT_TOKENS"] : ["E2_PROOF_PRESSURE_ARMS"]);
      if (spec === "./continuity-runner.mjs") expect(node.importClause.namedBindings.elements.map(e => (e.propertyName ?? e.name).text).sort()).toEqual(["openHarness", "productionModules"]);
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const value = node.arguments[0];
        expect(ts.isStringLiteral(value) && ({ "scripts/lib/continuity-e2-models.mjs": ["@mono-agent/turn/engine"], "scripts/continuity-e2.mjs": ["./lib/continuity-e2-replay.mjs", "./lib/continuity-e2-proofs.mjs", "./lib/continuity-e2-paid-entry.mjs"] })[path]?.includes(value.text)
          || ts.isStringLiteral(value) && ({ "scripts/lib/continuity-e2-runtime.mjs": ["./continuity-guarded-ipc.mjs", "./continuity-guarded-authorization.mjs", "./continuity-e2-paid-models.mjs"], "scripts/lib/continuity-e2-paid-models.mjs": ["./continuity-e2-models.mjs"], "scripts/lib/continuity-e2-phase-child.mjs": ["./continuity-e2-replay.mjs", "./continuity-e2-isolation.mjs", "./continuity-e2-proofs.mjs"], "scripts/lib/continuity-e2-proofs.mjs": ["./continuity-e2-paid-entry.mjs"], "scripts/lib/continuity-e2-controller-policy.mjs": ["./continuity-e2-runtime.mjs", "./continuity-guarded-protocols.mjs", "./continuity-e2-pricing.mjs", "./continuity-e2-registration.mjs", "./continuity-holdout-files.mjs", "./continuity-guarded-state.mjs", "./continuity-guarded-lease.mjs", "./continuity-guarded-child-environment.mjs", "./continuity-guarded-authorization.mjs"], "scripts/lib/continuity-e2-summary-receipts.mjs": ["./continuity-holdout-workflow.mjs"], "scripts/lib/continuity-e2-execution-policy.mjs": ["./continuity-guarded-authorization.mjs"], "scripts/lib/continuity-e2-authorization.mjs": ["@mono-agent/turn"], "scripts/lib/continuity-e2-guarded-protocol.mjs": ["./continuity-e2-authorization.mjs", "./continuity-e2-controller-policy.mjs", "./continuity-e2-runtime.mjs"] })[path]?.includes(value.text)
          || path === "scripts/lib/continuity-e2-tools.mjs" && ts.isStringLiteral(value) && ["@modelcontextprotocol/sdk/server/index.js", "@modelcontextprotocol/sdk/server/streamableHttp.js", "@modelcontextprotocol/sdk/types.js"].includes(value.text)
          || path === "scripts/lib/continuity-e2-lineage.mjs" && value.getText(ast) === 'new URL("../../packages/turn/dist/engine/journal-schema.js", import.meta.url).href'
          || path === "scripts/lib/continuity-e2-models.mjs" && value.getText(ast) === 'new URL("../../packages/turn/dist/agent/compaction.js", import.meta.url).href').toBe(true);
        if (!ts.isStringLiteral(value) || value.text !== "@mono-agent/turn/engine") {
          const specifier = ts.isStringLiteral(value) ? value.text : value.getText(ast);
          const expected = E2_DYNAMIC_SHAPES[path]?.[specifier];
          expect(Array.isArray(expected), `${path}:${value.text}:pinned dynamic import`).toBe(true);
          let shape;
          if (ts.isAwaitExpression(node.parent) && ts.isParenthesizedExpression(node.parent.parent) && ts.isPropertyAccessExpression(node.parent.parent.parent)) {
            shape = "." + node.parent.parent.parent.name.text;
          } else {
            let binding;
            if (ts.isArrayLiteralExpression(node.parent)) {
              const aggregate = node.parent.parent, declaration = aggregate.parent.parent;
              expect(ts.isCallExpression(aggregate) && aggregate.expression.getText(ast) === "Promise.all" && ts.isAwaitExpression(aggregate.parent) && ts.isVariableDeclaration(declaration) && ts.isArrayBindingPattern(declaration.name)).toBe(true);
              binding = declaration.name.elements[node.parent.elements.indexOf(node)]?.name;
            } else {
              const declaration = node.parent.parent;
              expect(ts.isAwaitExpression(node.parent) && ts.isVariableDeclaration(declaration)).toBe(true);
              binding = declaration.name;
            }
            expect(ts.isObjectBindingPattern(binding)).toBe(true);
            shape = binding.getText(ast).replace(/\s/gu, "");
          }
          expect(expected).toContain(shape);
        }
        if (ts.isStringLiteral(value) && value.text === "@mono-agent/turn") {
          const declaration = node.parent.parent;
          expect(ts.isAwaitExpression(node.parent) && ts.isVariableDeclaration(declaration) && ts.isObjectBindingPattern(declaration.name)).toBe(true);
          expect(declaration.name.elements.every(e => !e.dotDotDotToken && ts.isIdentifier(e.name))).toBe(true);
          expect(declaration.name.elements.map(e => (e.propertyName ?? e.name).text)).toEqual(["createPiOAuthApiKeyResolver"]);
        }
      }
      let callee = node.expression;
      while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
      // Inline function bodies are visited recursively; strings/comments inside
      // them are not a call target (e.g. the x-client-request-id header name).
      const name = ts.isArrowFunction(callee) || ts.isFunctionExpression(callee) ? "<inline>" : node.expression.getText(ast);
      const regexExec = ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "exec" && node.expression.expression.kind === ts.SyntaxKind.RegularExpressionLiteral;
      const proofCapability = path === "scripts/lib/continuity-e2-tools.mjs" && name === "server.connect"
        || path === "scripts/lib/continuity-e2-isolation.mjs" && ["connect.apply", "fetch"].includes(name)
        || path === "scripts/lib/continuity-e2-proofs.mjs" && name === "spawn";
      if (path === "scripts/lib/continuity-e2-isolation.mjs" && ["fetch", "connect.apply"].includes(name)) {
        expect(node.getText(ast)).toBe(name === "fetch" ? 'fetch(url, { ...init, redirect: "error" })' : "connect.apply(this, args)");
        expect(counts.get(name)).toBe(1);
      }
      if (name === "spawn") {
        expect(path).toBe("scripts/lib/continuity-e2-proofs.mjs");
        expect(node.arguments[0].getText(ast)).toBe("process.execPath");
        expect(node.arguments[1].getText(ast)).toBe("[PROOF_CHILD, phase, base]");
        expect(node.arguments[2].getText(ast)).toBe('{ cwd: ROOT, env: { ...env, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", NODE_NO_WARNINGS: "1" }, stdio: "ignore", shell: false }');
        expect(source.match(/\bspawn\(/g)).toHaveLength(1);
        expect(source).toContain('new URL("./continuity-e2-fixture.mjs", import.meta.url)');
      }
      expect(!proofCapability && !regexExec && /\b(fetch|spawn|exec|execFile|fork|eval|Function|require|createRequire|request|connect|createConnection|createSocket|getBuiltinModule|binding|dlopen)\b/.test(name), `${path}:${name}`).toBe(false);
    }
    if (ts.isNewExpression(node)) expect(!/\b(?:Worker|WebSocket|Agent|Socket|Function)\b/.test(node.expression.getText(ast)), path).toBe(true);
    ts.forEachChild(node, visit);
  }
  visit(ast);
}

it("statically confines new scripts and the real estimator closure to registered capabilities", () => {
  const paths = ["scripts/continuity-e2.mjs", ...readdirSync(join(ROOT, "scripts/lib")).filter(n => /^continuity-e2-.*\.mjs$/.test(n)).map(n => `scripts/lib/${n}`),
    "packages/turn/dist/agent/compaction.js", "packages/turn/dist/tools/mcp/timeouts.js"];
  for (const path of paths) assertE2Capabilities(path, readFileSync(join(ROOT, path), "utf8"));
});

// A negative scan case must fail on a scan assertion, never on an incidental
// TypeError inside the helper.
function expectRuleFailure(run) {
  let error;
  try { run(); } catch (caught) { error = caught; }
  expect(error?.name).toBe("AssertionError");
}
it("checks imported authority names even when local bindings are aliased", () => {
  const path = "scripts/lib/continuity-e2-proofs.mjs";
  expect(() => assertE2Capabilities(path, 'import { spawn } from "node:child_process";')).not.toThrow();
  for (const source of ['import { exec as spawn } from "node:child_process";', 'import { spawn as launch } from "node:child_process";', 'import { referenceReader as historyBody, lookupWitness, resolveSource } from "./continuity-lookup.mjs";']) expectRuleFailure(() => assertE2Capabilities(path, source));
});
it("pins authorization imports to env and the OAuth resolver, never a module namespace", () => {
  const path = "scripts/lib/continuity-e2-authorization.mjs";
  for (const source of ['import { env } from "node:process";', 'const { createPiOAuthApiKeyResolver } = await import("@mono-agent/turn");']) expect(() => assertE2Capabilities(path, source)).not.toThrow();
  for (const source of [
    'import { env, exit } from "node:process";', 'import * as process from "node:process";', 'import process from "node:process";',
    'const { createPiOAuthApiKeyResolver, Agent } = await import("@mono-agent/turn");',
    'const { Agent: createPiOAuthApiKeyResolver } = await import("@mono-agent/turn");',
    'const { createPiOAuthApiKeyResolver, ...rest } = await import("@mono-agent/turn");',
    'const namespace = await import("@mono-agent/turn");',
  ]) expectRuleFailure(() => assertE2Capabilities(path, source));
});
it("pins isolation delegation arguments and refuses duplicate exempt calls", () => {
  const path = "scripts/lib/continuity-e2-isolation.mjs", source = readFileSync(join(ROOT, path), "utf8");
  for (const call of ['fetch(url, { ...init, redirect: "error" })', 'connect.apply(this, args)']) {
    expectRuleFailure(() => assertE2Capabilities(path, `${source}\n${call};`));
    expectRuleFailure(() => assertE2Capabilities(path, source.replace(call, call.replace("url,", '"https://example.com",').replace("this, args", "this, []"))));
  }
});

it("matches the shipping historical session-boundary context derivation, without relaxing live assertions", async () => {
  const { withSessionBoundaryTimestamp } = await import(new URL("../../packages/conversation/dist/harness/session-events.js", import.meta.url).href);
  const product = readFileSync(join(ROOT, "packages/conversation/src/harness/session-events.ts"), "utf8");
  const local = readFileSync(join(ROOT, "scripts/lib/continuity-e2-protocol.mjs"), "utf8");
  const normalize = s => s.replace(/\s/g, "");
  expect(normalize(product.match(/const context = ([\s\S]*?);/)[1])).toBe(normalize(local.match(/return (event.context[\s\S]*?);/)[1]));
  for (const kind of ["resume_replay", "rollover", "isolated"]) for (const reason of [undefined, "cancelled_turn_resume", "failed_turn_resume", "model_change", "legacy_unbound_model", "cancelled_turn_reseed", "failed_turn_reseed", "resume_error", "runtime_result", "detached_context", "other"]) for (const context of [undefined, "retained", "reconstructed", "handoff"]) {
    const event = { kind, reason, context };
    expect(historicalContext(event)).toBe(withSessionBoundaryTimestamp(event, AT).context);
  }
});
it("segments subagent-only rows and between-message steers, and drops outside-web steps only under explicit exclusions", async () => {
  const { source, protocol } = await trace({ steer: true });
  expect(() => recordedTurns(source)).toThrow("E2_ASSISTANT_SOURCE_UNAVAILABLE");
  const replay = recordedTurns(source, { excludedSteps: protocol.branches[0].exclusions.steps });
  expect(replay.excludedOutsideWebTurns).toBe(1);
  const turn = replay.turns[1];
  expect(turn.replies.map(r => r.calls.length)).toEqual([1, 0, 1, 0]);
  expect(turn.replies.map(r => r.steers.length)).toEqual([0, 1, 0, 0]);
  expect(turn.replies.flatMap(r => r.content).filter(p => p.type === "toolCall").map(c => c.name)).toEqual(["Agent", "Agent"]);
  const t = protocol.branches[0].transitions[0];
  expect(source.web.messages[t.evidence[0].message]).toMatchObject({ turn_id: null, role: "system" });
  expect(validateProtocol(protocol, source)).toEqual(protocol);
});
it("projects only closed diagnostic fields, never arbitrary failure text, ids or paths", () => {
  const d = diagnosticRecord({ turnOrdinal: 2, replyCursor: 3, replyCount: 4, cancelled: true, aborted: false,
    failureKind: "fictional-canary", routeRefusalCode: "E2_FICTIONAL_CANARY", message: "fictional-canary", id: "fictional-canary", path: "/Users/example/fictional-canary" });
  expect(d).toEqual({ turnOrdinal: 2, replyCursor: 3, replyCount: 4, cancelled: true, aborted: false, failureKind: "runtime_error", routeRefusalCode: null, errorName: null, errorCode: null, site: null });
  expect(JSON.stringify(d)).not.toContain("fictional-canary");
});

it("refuses old imports and inverted chronology instead of reusing obsolete ordinals", async () => {
  const { source } = await trace(); const old = structuredClone(source); delete old.transport.webMessageOrder;
  expect(() => recordedTurns(old)).toThrow("E2_SOURCE_REIMPORT_REQUIRED");
  const inverted = structuredClone(source); [inverted.web.messages[0], inverted.web.messages[1]] = [inverted.web.messages[1], inverted.web.messages[0]];
  expect(() => recordedTurns(inverted)).toThrow("E2_SOURCE_REIMPORT_REQUIRED");
});

it("replays attachment-only owners as fixed metadata labels and refuses genuinely empty owners", async () => {
  const { source } = await trace(), replay = recordedTurns(source);
  expect(replay.turns[3].user).toBe("[recorded attachment: document application/zip 123 bytes; bytes unavailable for replay]");
  expect(replay.turns[4].user).toBe("Fictional request 4\n[recorded attachment: image image/png 456 bytes; bytes unavailable for replay]");
  const empty = structuredClone(source); empty.web.messages.find(m => m.id === "user-3").attachments = [];
  expect(() => recordedTurns(empty)).toThrow("E2_OWNER_SOURCE_UNAVAILABLE");
  const old = structuredClone(source); delete old.transport.attachmentMetadata;
  expect(() => recordedTurns(old)).toThrow("E2_SOURCE_REIMPORT_REQUIRED");
});
it("sanitizes error type/code/site and ignores arbitrary names, codes, outside paths and message canaries", () => {
  const error = new TypeError("fictional-canary /Users/example/private-note"); error.code = "E2_FICTIONAL_CANARY";
  error.stack = `TypeError: fictional-canary\n at outside (/Users/example/fictional-canary.mjs:3:4)\n at missing (${ROOT}/scripts/fictional-canary.mjs:3:4)\n at publicFrame (file://${ROOT}/scripts/continuity-e2.mjs:44:3)`;
  const d = diagnosticRecord(errorDiagnostic(error));
  expect(d).toMatchObject({ errorName: "TypeError", errorCode: null, site: "scripts/continuity-e2.mjs:44" });
  expect(JSON.stringify(d)).not.toMatch(/fictional-canary|\/Users\//);
  expect(diagnosticRecord({ errorName: "fictional-canary", errorCode: "E2_FICTIONAL_CANARY", site: "scripts/../fictional-canary.mjs:4" })).toMatchObject({ errorName: "other", errorCode: null, site: null });
  expect(errorDiagnostic(new RangeError("fictional-canary")).errorName).toBe("RangeError");
});
it("writes a genuine harness validation TypeError without exposing its message or paths", async () => {
  const { source, protocol } = await trace(), parent = await mkdtemp(join(tmpdir(), "e2-fictional-errors-")); await fs.promises.chmod(parent, 0o700); cleanup.push(() => rm(parent, { recursive: true, force: true }));
  await writeFile(join(parent, "source.json"), JSON.stringify(source)); await writeFile(join(parent, "protocol.json"), JSON.stringify(protocol));
  const replayModule = await import("../lib/continuity-e2-replay.mjs"), { validateRequest } = await import(new URL("../../packages/conversation/dist/harness/validation.js", import.meta.url).href);
  vi.spyOn(replayModule, "runE2Sizing").mockImplementation(async () => {
    try { validateRequest({ conversationId: "fictional-canary", userMessage: "" }); } catch (e) { e.message = "fictional-canary /Users/example/private-note"; throw e; }
  });
  const out = [], err = [], file = join(parent, "diagnostic.json");
  expect(await main(["size", "--source", parent, "--protocol", join(parent, "protocol.json"), "--output", join(parent, "result"), "--diagnostics", file], { stdout: s => out.push(s), stderr: s => err.push(s) })).toBe(1);
  expect(out).toEqual([]); expect(err).toEqual(["E2_REFUSED\n"]);
  const raw = await readFile(file, "utf8"), d = JSON.parse(raw);
  expect(d).toMatchObject({ errorName: "TypeError", errorCode: null }); // Vitest maps the validation frame to src/, which is deliberately ineligible.
  // The first eligible frame is the test caller. Native dist frames are tested below.
  expect(d.site).toMatch(/^scripts\/__tests__\/continuity-e2\.test\.mjs:[1-9][0-9]*$/);
  expect(raw).not.toMatch(/fictional-canary|\/Users\//); expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});

it("selects the first native dist frame before a later script frame", () => {
  const error = new TypeError("fictional-canary");
  error.stack = `TypeError: fictional-canary\n at validateRequest (file://${ROOT}/packages/conversation/dist/harness/validation.js:59:15)\n at caller (${ROOT}/scripts/continuity-e2.mjs:44:3)`;
  expect(errorDiagnostic(error)).toEqual({ errorName: "TypeError", errorCode: null, site: "packages/conversation/dist/harness/validation.js:59" });
});
it("drops provider-retried attempts instead of replaying them as a final stop", async () => {
  const plain = recordedTurns((await trace()).source), retried = recordedTurns((await trace({ retry: true })).source);
  expect(retried.turns[0].retriedAttempts).toBe(1); expect(plain.turns[0].retriedAttempts).toBe(0);
  expect(retried.turns[0].replies.map(r => r.calls.length)).toEqual(plain.turns[0].replies.map(r => r.calls.length));
  expect(JSON.stringify(retried.turns[0].replies)).not.toContain("Fictional abandoned attempt");
  for (const turn of retried.turns) expect(turn.replies.slice(0, -1).every(r => r.calls.length || r.steers.length)).toBe(true);
});

it("keeps probe request exhaustion distinct from source request exhaustion and sticky in diagnostics", async () => {
  for (const probe of [true, false]) {
    const a = await adapter({ sourceRequests: 1, probeRequests: 1 });
    a.route.setPosition({ model: LUNA, turn: 0, message: 0, probe });
    const context = { systemPrompt: `## Core Guardrails\n\n${a.soul.text}`, messages: [{ role: "user", content: "Fictional request" }] };
    for await (const _event of a.models.streamSimple(a.model, context)) { /* complete the admitted faux request */ }
    expect(a.route.report()).toMatchObject({ sourceRequests: probe ? 0 : 1, probeRequests: probe ? 1 : 0 });
    const code = probe ? "E2_PROBE_REQUEST_LIMIT" : "E2_SOURCE_REQUEST_LIMIT";
    expect(() => a.models.streamSimple(a.model, context)).toThrow(code);
    expect(diagnosticRecord({ routeRefusalCode: a.route.refusalCode() }).routeRefusalCode).toBe(code);
    expect(() => a.route.assertSettled()).toThrow(code);
  }
});
it("rejects blank evaluator and question terms before normalization can create empty match strings", () => {
  for (const blank of [" ", "\t\n", "\u00a0"]) {
    for (const extra of [{ id: blank }, { checkpoint: blank }, { expected: blank }, { forbidden: [blank] }]) {
      expect(() => scored([key("fictional-key", extra)], [])).toThrow("E2_SCORING_INVALID");
    }
    expect(() => validateE2Questions({ schema: "continuity-recorded-questions-v1", questions: [{ id: "fictional", checkpoint: "B1", prompt: blank }] })).toThrow("E2_QUESTIONS_INVALID");
  }
  expect(scored([key("fictional-key")], [answer("fictional-key", "")]).report.totals.rateMiss).toBe(1);
});
it("refuses additional reconstructed warm telemetry beside valid retained evidence", async () => {
  const { source, protocol } = await trace(), transition = protocol.branches[0].transitions.find(t => t.kind === "warm_cancel_resume");
  const row = source.web.messages[transition.evidence[0].message], raw = JSON.parse(row.parts_json);
  raw.push({ type: "telemetry", data: { type: "session_boundary", kind: "resume_replay", reason: "cancelled_turn_resume", context: "retained" } });
  row.parts_json = JSON.stringify(raw); expect(validateProtocol(protocol, source)).toEqual(protocol);
  raw.at(-1).data.context = "reconstructed"; row.parts_json = JSON.stringify(raw);
  expect(() => validateProtocol(protocol, source)).toThrow("E2_PROTOCOL_INVALID");
});
it("requires an actual mapped replay effort change, not equality with historical provider settings", async () => {
  const { source, protocol } = await trace(), t = protocol.branches[0].transitions.find(t => t.kind === "effort_only_non_boundary");
  const row = source.web.messages[t.evidence[0].message], raw = JSON.parse(row.parts_json), marker = raw[t.evidence[0].part];
  marker.before.effort = "medium"; marker.after.effort = "low"; row.parts_json = JSON.stringify(raw);
  expect(t.effort).toBe("xhigh"); expect(validateProtocol(protocol, source)).toEqual(protocol);
  protocol.branches[0].models[0].effort = "xhigh"; expect(validateProtocol(protocol, source)).toEqual(protocol);
  protocol.branches[0].models[2].effort = "xhigh";
  expect(() => validateProtocol(protocol, source)).toThrow("E2_PROTOCOL_INVALID");
});
it("registers only the final assistant checkpoint row, not an owner row or an earlier partial reply", async () => {
  const { source, protocol } = await trace(), c = protocol.branches[0].checkpoints[0], original = c.message;
  c.message = source.web.messages.findIndex(m => m.turn_id === source.web.turns[c.turn].id && m.role === "user");
  expect(() => validateProtocol(protocol, source)).toThrow("E2_PROTOCOL_INVALID");
  source.web.messages[original].role = "system"; // No assistant row remains in this turn.
  expect(() => validateProtocol(protocol, source)).toThrow("E2_PROTOCOL_INVALID");
  source.web.messages[original].role = "assistant";
  c.message = original; const insert = original + 1, row = source.web.messages[original];
  source.web.messages.splice(insert, 0, { ...structuredClone(row), id: "fictional-final-row", created_at: new Date(Date.parse(row.created_at) + 1).toISOString(), parts_json: JSON.stringify([{ type: "text", text: "Fictional completed reply" }]) });
  const evidence = new Set(protocol.branches.flatMap(b => b.transitions.flatMap(t => t.evidence)));
  for (const e of evidence) if (e.message >= insert) e.message++;
  for (const b of protocol.branches) for (const checkpoint of b.checkpoints) if (checkpoint.message >= insert) checkpoint.message++;
  c.message = insert; expect(validateProtocol(protocol, source)).toEqual(protocol);
  c.message = original; expect(() => validateProtocol(protocol, source)).toThrow("E2_PROTOCOL_INVALID");
});
it("blocks contradictory value/text even for abstentions and unavailable or excluded evidence", () => {
  for (const extra of [{}, { availability: "absent", expected: null, rate: false }, { availability: "protected", expected: null, rate: false }, { kind: "free_text" }, { dependsOnSteps: [0] }]) {
    const k = key("fictional-contradiction", extra);
    const scoredResult = scored([k], [answer(k.id, "unknown", { value: "Cedar", witness: false, excludedSteps: [0] })]);
    expect(scoredResult.report.totals.blocking).toBe(1); expect(scoredResult.report.gate).toBe(false);
  }
  expect(scored([key("fictional-consistent")], [answer("fictional-consistent", "unknown", { value: " unknown " })]).report.totals.rateMiss).toBe(1);
});
it("retains conservative replay refusal for an unplaceable journal step with explicit import coverage", async () => {
  const native = tool("fictional-unplaced", "Fictional result"), f = snapshots(scratch(), { parts: [], journal: [assistant([native]), result(native)] });
  const { source } = await readRecordedSource(f.manifest, CONVERSATION);
  expect(source.coverage.some(g => g.code === "journal_step_unplaceable" && g.tier === "replay" && g.location.stepIndex === 0)).toBe(true);
  expect(() => recordedTurns(source)).toThrow("E2_ASSISTANT_SOURCE_UNAVAILABLE");
  expect(() => recordedTurns(source, { excludedSteps: [0] })).toThrow("E2_ASSISTANT_SOURCE_UNAVAILABLE");
  source.steps[0].turnId = "fictional-outside-web";
  expect(() => recordedTurns(source)).toThrow("E2_ASSISTANT_SOURCE_UNAVAILABLE");
  expect(recordedTurns(source, { excludedSteps: [0] }).excludedOutsideWebTurns).toBe(1);
});

it("refuses real sizing without a branded adapter before invoking any adapter method", async () => {
  const calls = [], paidAdapter = new Proxy({}, { get: (_, name) => { calls.push(name); return () => {}; } });
  await expect(runE2Sizing({ summary: "real", source: {}, protocol: {}, output: "unused", paidAdapter, questions: {}, evaluator: {} })).rejects.toMatchObject({ code: "e2_pilot_capability_invalid" });
  expect(calls).toEqual([]);
  await expect(runE2Sizing({ summary: "real" })).rejects.toThrow("E2_MODELS_SEAM_REFUSED");
});

it("pins every authority exception to its exact import names and shape", () => {
  for (const [path, imports] of Object.entries(E2_IMPORT_SHAPES)) for (const [spec, clause] of Object.entries(imports)) {
    expect(() => assertE2Capabilities(path, `import ${clause} from "${spec}";`)).not.toThrow();
    for (const altered of ["* as authority", "authority", "{ unregisteredAuthority }", "{ ...authority }"]) {
      expectRuleFailure(() => assertE2Capabilities(path, `import ${altered} from "${spec}";`));
    }
  }
  expectRuleFailure(() => assertE2Capabilities("scripts/lib/continuity-e2-isolation.mjs", 'import * as authority from "./continuity-guarded-real-capability.mjs";'));
  for (const source of [
    'const authority = await import("./continuity-guarded-authorization.mjs");',
    'const { guardedAuthorization, extra } = await import("./continuity-guarded-authorization.mjs");',
    'const { extra: guardedAuthorization } = await import("./continuity-guarded-authorization.mjs");',
    'const authority = await import("./continuity-guarded-ipc.mjs");',
    '(await import("./continuity-guarded-ipc.mjs")).extra;',
  ]) expectRuleFailure(() => assertE2Capabilities("scripts/lib/continuity-e2-runtime.mjs", source));
  expect(() => assertE2Capabilities("scripts/continuity-e2.mjs", 'const { runE2Paid } = await import("./lib/continuity-e2-paid-entry.mjs");')).not.toThrow();
  expectRuleFailure(() => assertE2Capabilities("scripts/lib/continuity-e2-isolation.mjs", 'const { runE2Paid } = await import("./lib/continuity-e2-paid-entry.mjs");'));
  expectRuleFailure(() => assertE2Capabilities("scripts/continuity-e2.mjs", 'const entry = await import("./lib/continuity-e2-paid-entry.mjs");'));
});

it("pins paid dynamic factories and refuses whole-module, aliased and extra capabilities", () => {
  for (const [path, imports] of Object.entries(E2_DYNAMIC_SHAPES)) for (const [spec, shapes] of Object.entries(imports)) {
    const argument = spec.startsWith("new URL(") ? spec : JSON.stringify(spec);
    for (const shape of shapes) {
      const source = shape.startsWith(".") ? `(await import(${argument}))${shape};` : `const ${shape} = await import(${argument});`;
      expect(() => assertE2Capabilities(path, source)).not.toThrow();
    }
    for (const source of [`const authority = await import(${argument});`, `const { unregisteredAuthority } = await import(${argument});`, `(await import(${argument})).unregisteredAuthority;`]) expectRuleFailure(() => assertE2Capabilities(path, source));
  }
});

it("keeps each probe witness and request count independent across restored repeats", () => {
  const probe = e2ProbeMeasurement(), estimators = { estimateTokens: () => 1, estimateFixedOverheadTokens: () => ({ fixedOverheadTokens: 0 }) };
  const witnessed = { messages: [{ role: "assistant", content: "Fictional history." }, { role: "user", content: "Fictional question." }] };
  probe.observe(witnessed, estimators); probe.observe(witnessed, estimators);
  expect(probe.witness).toBe(true); expect(probe.requests).toBe(2);
  probe.reset(); expect(probe.witness).toBe(false); expect(probe.firstContext).toBeNull(); expect(probe.requests).toBe(0);
  probe.observe({ messages: [{ role: "user", content: "Independent fictional question." }] }, estimators);
  expect(probe.witness).toBe(false); expect(probe.requests).toBe(1);
});
it("refuses simultaneous lookup and E2 harness ownership before any module or adapter access", async () => {
  const calls = [], unavailable = new Proxy({}, { get: (_, key) => { calls.push(key); throw Error("unexpected_access"); } });
  await expect(openHarness({ pilot: {}, e2: unavailable, modules: unavailable })).rejects.toMatchObject({ code: "lookup_pilot_capability_invalid" });
  expect(calls).toEqual([]);
});

it("labels only the first request at an explicit proof probe position as probe", async () => {
  const a = await adapter();
  const context = { systemPrompt: `## Core Guardrails\n\n${a.soul.text}`, messages: [{ role: "user", content: "Fictional request." }] };
  for (let repeat = 0; repeat < 2; repeat++) {
    a.route.setPosition({ model: LUNA, turn: 0, message: 0, probe: true, paidRole: "probe" });
    for (let round = 0; round < 3; round++) for await (const _event of a.models.streamSimple(a.model, context)) { /* drain faux response */ }
  }
  expect(a.route.report().requestSizing.map(r => r.paidRole)).toEqual(["probe", "continuation", "continuation", "probe", "continuation", "continuation"]);
});
