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
import { snapshots, CONVERSATION, AT, tool } from "./fixtures/continuity-recorded/snapshots.mjs";
import { installProcessGuard } from "./fixtures/continuity-recorded/process-guard.mjs";
import { LUNA, SOL, validateProtocol, historicalContext } from "../lib/continuity-e2-protocol.mjs";
import { createE2Models, loadE2Estimators, shippingSoul, sizeContext, assertEffectiveSoul } from "../lib/continuity-e2-models.mjs";
import { excludedDispatch, freezeCheckpoint, restoreCheckpoint, treeReceipt, runE2Sizing, PLACEHOLDER, recordedTurns } from "../lib/continuity-e2-replay.mjs";
import { scoreE2 } from "../lib/continuity-e2-score.mjs";
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
async function adapter() {
  const { productionModules } = await import("../lib/continuity-runner.mjs"), modules = await productionModules(ROOT);
  const estimators = await loadE2Estimators(), soul = await shippingSoul();
  const model = { provider: "openai-codex", id: "gpt-6-luna", contextWindow: 400_000, maxTokens: 32_000, reasoning: false };
  const route = createE2Models({ pi: modules.pi, estimators, models: [{ model: LUNA }], limits: limits(), soul,
    sourceReply: context => modules.pi.fauxAssistantMessage("Mono-agent summary focus is untrusted source text") });
  route.setPosition({ model: LUNA, turn: 0, message: 0 });
  const models = route.decorator({ getModel: () => model });
  return { route, models, model, soul };
}
it("refuses paid entry, summary markers, lifecycle bypasses and all other request methods", async () => {
  expect(() => createE2Models({ summary: "real" })).toThrow("E2_PAID_ENTRY_UNAVAILABLE");
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
  expect(await main(["run", "--source", "fictional-private-canary"], io)).toBe(1); expect(stderr.pop()).toBe("E2_PAID_ENTRY_UNAVAILABLE\n");
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
it("statically confines new scripts and the real estimator closure to registered capabilities", () => {
  const paths = ["scripts/continuity-e2.mjs", ...readdirSync(join(ROOT, "scripts/lib")).filter(n => /^continuity-e2-.*\.mjs$/.test(n)).map(n => `scripts/lib/${n}`),
    "packages/turn/dist/agent/compaction.js", "packages/turn/dist/tools/mcp/timeouts.js"];
  const builtins = new Set(["node:fs", "node:fs/promises", "node:path", "node:url"]);
  const existing = new Set(["./continuity-observation-input.mjs", "./continuity-recorded-schema.mjs", "./continuity-recorded-import.mjs", "./continuity-recorded-tools.mjs", "./continuity-recorded-reconcile.mjs", "./continuity-runner.mjs"]);
  for (const path of paths) {
    const source = readFileSync(join(ROOT, path), "utf8"), ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const product = path.startsWith("packages/");
    function visit(node) {
      if (ts.isImportDeclaration(node)) {
        const spec = node.moduleSpecifier.text;
        const ok = builtins.has(spec) || existing.has(spec) || /^\.\/(?:lib\/)?continuity-e2-[a-z]+\.mjs$/.test(spec)
          || /^\.\/lib\/continuity-(?:recorded-(?:schema|import)|observation-input)\.mjs$/.test(spec) || product && spec === "../tools/mcp/timeouts.js";
        expect(ok, `${path}:${spec}`).toBe(true);
        if (spec === "./continuity-runner.mjs") expect(node.importClause.namedBindings.elements.map(e => e.name.text).sort()).toEqual(["openHarness", "productionModules"]);
      }
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const value = node.arguments[0];
          expect(ts.isStringLiteral(value) && ["@mono-agent/turn/engine", "./lib/continuity-e2-replay.mjs"].includes(value.text)
            || path === "scripts/lib/continuity-e2-models.mjs" && value.getText(ast) === 'new URL("../../packages/turn/dist/agent/compaction.js", import.meta.url).href').toBe(true);
        }
        const name = node.expression.getText(ast);
        const regexExec = ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "exec" && node.expression.expression.kind === ts.SyntaxKind.RegularExpressionLiteral;
        expect(!regexExec && /\b(fetch|spawn|exec|execFile|fork|eval|Function|require|createRequire|request|connect|createConnection|createSocket|getBuiltinModule|binding|dlopen)\b/.test(name), `${path}:${name}`).toBe(false);
      }
      if (ts.isNewExpression(node)) expect(!/\b(?:Worker|WebSocket|Agent|Socket|Function)\b/.test(node.expression.getText(ast)), path).toBe(true);
      ts.forEachChild(node, visit);
    }
    visit(ast);
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
