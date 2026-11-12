// Fictional, isolated control-arm evidence; no provider or operator artifacts.
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { ROOT } from "../lib/continuity-observation-input.mjs";
import { digest as hash } from "../lib/continuity-recorded-schema.mjs";
import { digest } from "../lib/continuity-dataset.mjs";
import { productionModules } from "../lib/continuity-runner.mjs";
import { runE2Sizing } from "../lib/continuity-e2-replay.mjs";
import { e2ProbeCounts, e2PhaseSchedule, e2ToolPolicies, validateE2ReplayLimits } from "../lib/continuity-e2-registration.mjs";
import { e2ReplayArm, e2ProbeRequestCount, assertE2ReplayBinding, SOL } from "../lib/continuity-e2-protocol.mjs";
import { normalizeE2Sizing, estimateE2SizingSet } from "../lib/continuity-e2-sizing.mjs";
import { e2ExecutionPolicy } from "../lib/continuity-e2-execution-policy.mjs";
import { e2RequestPrice } from "../lib/continuity-e2-pricing.mjs";
import { guardedAuthorization } from "../lib/continuity-guarded-authorization.mjs";
import { e2AuthorizationBindings } from "../lib/continuity-e2-authorization.mjs";
import { verifyE2NativeLineage } from "../lib/continuity-e2-lineage.mjs";
import { parseE2Args, main } from "../continuity-e2.mjs";
import { assertE2BaselineRequest as assertE2BaselineContext } from "../lib/continuity-e2-lineage.mjs";
import { baselineToolSource } from "./fixtures/e2-baseline-tools.mjs";
import { e2NativeFixture, E2_NATIVE_TEST_TIMEOUT_MS } from "./fixtures/e2-native-registration.mjs";
const build = vi.hoisted(() => ({ state: vi.fn(() => ({ head: "b".repeat(40), dirty: false })), verify: vi.fn(async () => {}) }));
vi.mock("../lib/memory-e2e-build.mjs", () => ({ BUILD_POLICY: "fresh-clean-head-agent-app-closure-v1", sourceState: build.state, verifyRealBuild: build.verify }));
const roots = [], servers = [];
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});
async function fixture(summary = "faux-short", observe = false, recordedTools = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "e2-baseline-"))); roots.push(root);
  const f = await e2NativeFixture(root), r = f.pilot.registration;
  if (recordedTools) f.trace.source = await baselineToolSource(root);
  for (const key of ["HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"]) vi.stubEnv(key, f.home);
  f.trace.protocol.probeLookupRounds = 3;
  for (const branch of f.trace.protocol.branches) branch.exclusions.coverage = f.trace.source.coverage.flatMap((gap, i) => gap.tier === "replay" ? [i] : []);
  const frozen = JSON.stringify(f.trace.protocol), contexts = [], configs = [], routes = [];
  const modules = await productionModules(ROOT);
  const wrapped = { ...modules, config: { ...modules.config, resolveJsonMonoAgentConfig(args) {
    const value = modules.config.resolveJsonMonoAgentConfig(args); configs.push(value); return value;
  } }, app: { ...modules.app, createConfiguredAgentRuntime(args) {
    const base = modules.app.createConfiguredAgentRuntime(args);
    return new Proxy(base, { get(target, key) {
      if (key === "run") return (prompt, options) => { routes.push(options); return target.run(prompt, options); };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  } } };
  const record = await runE2Sizing({ ...f.trace, output: join(root, "baseline-sizing"), replayArm: "baseline", summary,
    ...(observe ? { modules: wrapped } : {}), onContext: value => contexts.push(value) });
  expect(JSON.stringify(f.trace.protocol)).toBe(frozen);
  const bind = async (binding, value) => { const raw = JSON.stringify(value); await writeFile(binding.path, raw, { mode: 0o600 }); binding.sha256 = hash(raw); };
  const questions = { schema: "continuity-recorded-questions-v1", questions: [{ id: "fictional-baseline-item", checkpoint: "B1", prompt: "State the fictional recorded response." }] };
  const keys = { schema: "continuity-recorded-evaluator-keys-v1", keys: [{ id: "fictional-baseline-item", checkpoint: "B1", kind: "exact", expected: "Fictional response", availability: "available", rate: true, dependsOnSteps: [], forbidden: [] }] };
  await bind(r.source, f.trace.source); await bind(r.protocol, f.trace.protocol); await bind(r.probes, questions); await bind(r.keys, keys); await bind(r.sizing[0], record);
  r.replayArm = "baseline";
  r.probeCounts = e2ProbeCounts(f.trace.protocol, questions, keys, f.trace.source, "baseline");
  r.toolPolicies = e2ToolPolicies("baseline");
  r.schedule = e2PhaseSchedule(f.trace.protocol, [record], r.probeCounts, "baseline");
  await f.persist();
  return { ...f, record, contexts, configs, routes, questions, keys, bind };
}
it.each(["faux-short", "faux-max"])("sizes the baseline offline with %s, config/tool/pack absence and replay-only funding", async summary => {
  const f = await fixture(summary, true), r = f.pilot.registration;
  expect(f.record).toMatchObject({ replayArm: "baseline", qualification: false, semanticQualification: false });
  expect(f.record.branches.flatMap(b => b.checkpoints.flatMap(c => c.probes))).toHaveLength(8);
  expect(f.record.branches.flatMap(b => b.checkpoints.flatMap(c => c.probes)).every(p => p.requests === 1)).toBe(true);
  expect(f.contexts.filter(c => c.probe)).toHaveLength(8);
  for (const { context } of f.contexts) expect(() => assertE2BaselineContext(context)).not.toThrow();
  expect(f.configs.length).toBeGreaterThan(0);
  for (const c of f.configs) {
    expect(c.runtime.session.continuity.enabled).toBe(false); expect(c.runtime.compaction.enabled).toBe(true);
    expect(c.tools.allowedTools).toEqual([]);
  }
  expect(f.routes.length).toBeGreaterThan(0);
  for (const options of f.routes) { expect(options.allowedTools).toEqual([]); expect(options.mcpServers).not.toHaveProperty("mono-agent-conversation-history"); }
  expect(r.probeCounts.every(c => c.lookupRounds === 3 && c.requestsPerProbe === 1)).toBe(true);
  expect(r.schedule).toHaveLength(1); expect(r.schedule[0]).toMatchObject({ kind: "replay", arm: "baseline" });
  expect(r.schedule[0].budgets).toEqual([{ checkpoint: 0, paidRole: "probe", model: SOL, maxRequests: 2 }]);
  expect(() => validateE2ReplayLimits(f.trace.protocol, [f.record], "baseline")).not.toThrow();
  const estimate = estimateE2SizingSet({ protocol: f.trace.protocol, roles: r.roles, records: [f.record], catalog: r.catalog, probeCounts: r.probeCounts, replayArm: "baseline" });
  expect(estimate.fundedSchedule.totals.requests).toBe(2); expect(estimate).toMatchObject({ replayArm: "baseline", qualification: false, proofArms: 0 });
  expect(() => normalizeE2Sizing(f.trace.protocol, { ...f.record, qualification: true }, 0, "baseline")).toThrow("E2_ESTIMATE_INVALID");
  const cliOutput = join(f.root, "cli-sizing"), stdout = [], stderr = [];
  expect(await main(["size", "--source", f.root, "--protocol", r.protocol.path, "--output", cliOutput, "--summary", summary, "--replay-arm", "baseline"], { stdout: v => stdout.push(v), stderr: v => stderr.push(v) })).toBe(0);
  expect(stderr).toEqual([]); expect(JSON.parse(stdout[0])).toMatchObject({ branches: 2, checkpoints: 4, summaryRequests: 0 });
  const cliSizing = JSON.parse(await readFile(join(cliOutput, "sizing.json")));
  expect(cliSizing).toMatchObject({ replayArm: "baseline", qualification: false });
  const limitsPath = join(f.root, "estimate-limits.json"), estimateOutput = join(f.root, "cli-estimate");
  await writeFile(limitsPath, JSON.stringify({ schema: "continuity-e2-estimate-limits-v1", roles: r.roles, probeCounts: r.probeCounts }));
  expect(await main(["--estimate", "--protocol", r.protocol.path, "--limits", limitsPath, "--sizing", join(cliOutput, "sizing.json"), "--output", estimateOutput, "--replay-arm", "baseline"], { stdout: v => stdout.push(v), stderr: v => stderr.push(v) })).toBe(0);
  expect(stderr).toEqual([]);
  expect(JSON.parse(await readFile(join(estimateOutput, "estimate.json")))).toMatchObject({ replayArm: "baseline", qualification: false, fundedSchedule: { totals: { requests: 2 } } });
  vi.stubEnv("CI", undefined);
  await expect(guardedAuthorization("e2-validation").validate(f.args)).resolves.toBeDefined();
  expect(() => normalizeE2Sizing(f.trace.protocol, f.record)).toThrow("E2_ESTIMATE_INVALID");
  expect(() => validateE2ReplayLimits(f.trace.protocol, [f.record])).toThrow("e2_registration_invalid");
  const proof = JSON.parse(await readFile(new URL("./fixtures/continuity-e2-cap-sizing.json", import.meta.url))).sizing;
  expect(() => e2PhaseSchedule(f.trace.protocol, [f.record, proof], r.probeCounts, "baseline")).toThrow("e2_registration_invalid");
}, E2_NATIVE_TEST_TIMEOUT_MS);
it("keeps closed arm defaults and refuses tools/packs and a second admitted probe request", async () => {
  expect(e2ReplayArm()).toBe("continuity"); expect(e2ProbeRequestCount({ probeLookupRounds: 3 })).toBe(4);
  expect(e2ProbeRequestCount({ probeLookupRounds: 3 }, "baseline")).toBe(1);
  expect(() => e2ProbeRequestCount({ probeLookupRounds: 0 }, "baseline")).toThrow("E2_PROBE_LOOKUP_ROUNDS_INVALID");
  const args = ["size", "--source", "s", "--protocol", "p", "--output", "o"];
  expect(parseE2Args(args)).not.toHaveProperty("replay-arm");
  expect(parseE2Args([...args, "--replay-arm", "baseline"])["replay-arm"]).toBe("baseline");
  expect(() => parseE2Args([...args, "--replay-arm", "other"])).toThrow("E2_ARGUMENTS_INVALID");
  expect(() => assertE2BaselineContext({ tools: [{ name: "ConversationHistory" }] })).toThrow("E2_PROBE_TOOLS_REFUSED");
  expect(() => assertE2BaselineContext({ messages: [{ toolsAdded: [{ name: "ConversationHistory" }] }] })).toThrow("E2_PROBE_TOOLS_REFUSED");
  expect(() => assertE2BaselineContext({ messages: [{ role: "user", content: "### Conversation continuity pack (historical evidence)\nFictional" }, { role: "user", content: "Fictional current prompt" }] })).toThrow("e2_payload_forbidden");
  const f = await fixture(), r = f.pilot.registration, planned = r.schedule[0], model = SOL, catalog = r.catalog.find(c => c.model === model), role = r.roles.find(c => c.role === "probe" && c.model === model);
  const p = { requestId: "fictional-request", slotId: planned.slotId, round: 1, payloadDigest: "a".repeat(64), reservationUnits: e2RequestPrice(catalog, { inputTokens: 10, maxOutputTokens: role.maxOutputTokens }).reservationUnits, inputTokens: 10, model, paidRole: "probe", checkpoint: 0 };
  const admitted = e2ExecutionPolicy.admission(f.pilot, planned, { holds: [] }, p);
  expect(admitted.metadata).toMatchObject({ replayArm: "baseline", probeRequest: 1, tools: [] });
  expect(e2ExecutionPolicy.retry(f.pilot, { slots: [{ holds: [{ paidRole: "probe" }] }] }, 0, {})).toEqual({ allowed: false });
  expect(() => e2ExecutionPolicy.admission(f.pilot, planned, { holds: [{ checkpoint: 0, probeRequest: 1 }] }, { ...p, paidRole: "continuation" })).toThrow("e2_request_limit");
  const body = { model: "gpt-6.1-sol", stream: true, store: false, input: [], tools: [] };
  expect(() => e2ExecutionPolicy.assertBody(Buffer.from(JSON.stringify({ ...body, instructions: "Explain the heading ### Conversation continuity pack (historical evidence)" })), admitted.metadata)).not.toThrow();
  expect(() => e2ExecutionPolicy.assertBody(Buffer.from(JSON.stringify({ ...body, tools: [{ type: "function", name: "ConversationHistory" }] })), { ...admitted.metadata })).toThrow("e2_tools_forbidden");
  expect(() => e2ExecutionPolicy.assertBody(Buffer.from(JSON.stringify({ ...body, input: [{ role: "user", content: "### Conversation continuity pack (historical evidence)\nFictional" }, { role: "user", content: "Fictional current prompt" }] })), admitted.metadata)).toThrow("e2_payload_forbidden");
}, E2_NATIVE_TEST_TIMEOUT_MS);
it("binds registration, authorization and report arms and rejects relabelling", async () => {
  const f = await fixture(); vi.stubEnv("CI", undefined);
  const auth = guardedAuthorization("e2-validation");
  const handle = await auth.validate(f.args); expect(auth.bindsRegistration(handle, f.pilot)).toBe(true);
  expect(f.artifact.bindings.replayArm).toBe("baseline");
  const other = structuredClone(f.pilot); delete other.registration.replayArm;
  expect(auth.bindsRegistration(handle, other)).toBe(false);
  expect(digest(e2AuthorizationBindings(other, f.args.registrationSha256, { outputRoot: f.args.outputRoot, credentialPath: f.args.credentialPath, salt: f.artifact.salt, accountCommitment: f.artifact.accountCommitment }))).not.toBe(digest(f.artifact.bindings));
  for (const report of [{}, { replayArm: "continuity" }, { replayArm: "baseline", qualification: true }])
    expect(() => assertE2ReplayBinding(f.pilot.registration, report)).toThrow("e2_authorization_binding_mismatch");
  expect(() => assertE2ReplayBinding(f.pilot.registration, { replayArm: "baseline", qualification: false })).not.toThrow();
  f.artifact.bindings.replayArm = "continuity"; await writeFile(f.args.authorizationPath, JSON.stringify(f.artifact), { mode: 0o600 });
  await expect(auth.validate(f.args)).rejects.toMatchObject({ code: "e2_authorization_binding_mismatch" });
  const output = [], errors = [];
  expect(await main(["run", "--summary", "real", "--registration", f.args.registrationPath, "--sha256", f.args.registrationSha256, "--authorization", f.args.authorizationPath, "--credentials", f.args.credentialPath, "--output", f.args.outputRoot], { stdout: v => output.push(v), stderr: v => errors.push(v) })).toBe(1);
  expect(errors).toEqual(["e2_authorization_binding_mismatch\n"]); expect(output).toEqual([]);
}, E2_NATIVE_TEST_TIMEOUT_MS);
it("allows no-lineage absence but still refuses an unverified summary claim", async () => {
  const state = { slots: [{ lineages: {} }], schedule: [{ kind: "replay" }] }, assignment = { index: 0, outputRoot: "/fictional" }, hold = { lineageScope: 0 };
  const read = () => { throw Error("unexpected archive read"); };
  await expect(verifyE2NativeLineage(Buffer.from(JSON.stringify({ input: [] })), hold, state, assignment, read)).resolves.toEqual({ native: 0, branch: 0, pack: 0, none: true });
  await expect(verifyE2NativeLineage(Buffer.from(JSON.stringify({ input: [{ role: "user", content: "<previous-summary>\nUnverified fictional summary\n</previous-summary>" }] })), hold, state, assignment, read)).rejects.toThrow("e2_summary_receipt_invalid");
});
it("executes a faux end-to-end baseline through the shipping SDK/controller/scorer with one tool-free request per repeat", async () => {
  const f = await fixture(), received = []; let listenerError;
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const bytes = request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(Buffer.concat(chunks)) : Buffer.concat(chunks);
      received.push(JSON.parse(bytes));
      const item = { type: "message", id: "msg_fictional", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fictional response", annotations: [] }] };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: "Fictional response" },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "fictional-response", status: "completed", output: [item], service_tier: "default", usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 } } } }]
        .map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
    } catch (error) { listenerError = error; response.writeHead(500).end(); }
  }); servers.push(server); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const preload = join(f.root, "preload.mjs"), profile = { root: ROOT, home: f.home, args: f.args, production: true, preload,
    endpoint: `http://127.0.0.1:${server.address().port}/codex/responses`, result: join(f.root, "result.json") };
  const profilePath = join(f.root, "profile.json"); await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 });
  await writeFile(preload, `import{installE2NativeRealm}from ${JSON.stringify(pathToFileURL(join(ROOT, "scripts/__tests__/fixtures/e2-native-realm.mjs")).href)};await installE2NativeRealm(${JSON.stringify(profile)});`, { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, join(ROOT, "scripts/__tests__/fixtures/e2-native-supervisor.mjs"), profilePath], { cwd: ROOT, env: { HOME: f.home, PATH: "/usr/bin:/bin", LANG: "C", NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", data => { stderr += data; }); const [code] = await once(child, "close");
  const result = JSON.parse(await readFile(profile.result)); expect({ code, stderr, error: result.error }).toEqual({ code: 0, stderr: "", error: undefined });
  expect(listenerError).toBeUndefined(); expect(result.report).toMatchObject({ replayArm: "baseline", qualification: false, stop: "completed" });
  expect(received).toHaveLength(2);
  for (const body of received) { expect(body.tools ?? []).toEqual([]); expect(JSON.stringify(body)).not.toContain("### Conversation continuity pack (historical evidence)"); }
  expect(result.report.phases[0].summaryPresence).toMatchObject({ checked: 2, none: 2, pack: 0 });
  const score = JSON.parse(await readFile(join(f.args.outputRoot, "work/replay/score.json")));
  expect(score.report).toMatchObject({ normalization: "e2-answer-normalization-v1", qualification: false, complete: true });
  const replay = JSON.parse(await readFile(join(f.args.outputRoot, "work/replay/replay.json")));
  expect(replay).toMatchObject({ replayArm: "baseline", qualification: false });
}, E2_NATIVE_TEST_TIMEOUT_MS);

it.each(["faux-short", "faux-max"])("sizes recorded source tools in the baseline with %s, unchanged from continuity", async summary => {
  const f = await fixture(summary, true, true), continuity = [];
  expect(f.trace.source.tools.map(t => t.name)).toEqual(["Read"]);
  expect(f.contexts.filter(c => c.probe).every(c => [...(c.context.tools ?? []), ...c.context.messages.flatMap(m => m.toolsAdded ?? [])].length === 0)).toBe(true);
  const baselineSource = f.contexts.filter(c => !c.probe).map(c => c.context);
  expect(baselineSource.length).toBeGreaterThan(0);
  for (const context of baselineSource) {
    expect(() => assertE2BaselineContext(context, { kind: "source", sourceTools: ["Read"] })).not.toThrow();
    expect((context.tools ?? context.messages.flatMap(m => m.toolsAdded ?? [])).map(t => t.name)).toEqual(["Read"]);
  }
  expect(f.contexts.some(c => c.context.messages.some(m => m.role === "toolResult" && m.toolName === "Read"))).toBe(true);
  await runE2Sizing({ ...f.trace, output: join(f.root, "continuity-tool-sizing"), summary,
    onContext: c => { if (!c.probe) continuity.push(c.context); } });
  expect(baselineSource.map(c => c.tools)).toEqual(continuity.map(c => c.tools));
  expect(baselineSource.map(c => c.messages.flatMap(m => m.toolsAdded ?? [])))
    .toEqual(continuity.map(c => c.messages.flatMap(m => m.toolsAdded ?? [])));
  for (const options of f.routes) {
    expect(options.mcpServers).not.toHaveProperty("mono-agent-conversation-history");
    expect(Object.keys(options.mcpServers)).toEqual(Object.keys(options.mcpServers).length ? ["continuity-recorded"] : []);
  }
}, E2_NATIVE_TEST_TIMEOUT_MS);
it("scopes tool absence to probes/summaries and detects packs by injected role and position", () => {
  const heading = "### Conversation continuity pack (historical evidence)\nFictional historical evidence";
  const current = { role: "user", content: "Fictional current prompt" };
  for (const kind of ["probe", "source", "summary"]) {
    expect(() => assertE2BaselineContext({ messages: [{ role: "user", content: `Discuss ${heading}` }, current] }, { kind })).not.toThrow();
    expect(() => assertE2BaselineContext({ messages: [{ role: "assistant", content: heading }, current] }, { kind })).not.toThrow();
    expect(() => assertE2BaselineContext({ messages: [{ role: "user", content: heading }] }, { kind })).not.toThrow();
    const serialized = `<conversation>\n[User]: ${heading}\n\n[Assistant]: Fictional response\n</conversation>\n\n`;
    expect(() => assertE2BaselineContext({ messages: [{ role: "user", content: serialized }] }, { kind })).not.toThrow();
    const pack = `${heading}\nGenerated summary evidence id="chr1_${"a".repeat(43)}" sha256="${"b".repeat(64)}": "Fictional summary"`;
    expect(() => assertE2BaselineContext({ messages: [{ role: "user", content: serialized.replace(heading, pack) }] }, { kind })).toThrow("e2_payload_forbidden");
    expect(() => assertE2BaselineContext({ messages: [{ role: "user", content: [{ type: "text", text: heading }] }, current] }, { kind })).toThrow("e2_payload_forbidden");
    expect(() => assertE2BaselineContext({ tools: [{ name: "ConversationHistory" }] }, { kind })).toThrow("E2_PROBE_TOOLS_REFUSED");
    expect(() => assertE2BaselineContext({ messages: [{ toolsAdded: [{ name: "ConversationHistory" }] }] }, { kind })).toThrow("E2_PROBE_TOOLS_REFUSED");
    expect(() => assertE2BaselineContext({ messages: [{ role: "toolResult", toolName: "ConversationHistory" }] }, { kind })).toThrow("E2_PROBE_TOOLS_REFUSED");
    expect(() => assertE2BaselineContext({ mcpServers: { "mono-agent-conversation-history": {} } }, { kind })).toThrow("E2_PROBE_TOOLS_REFUSED");
  }
  for (const kind of ["probe", "summary"]) {
    expect(() => assertE2BaselineContext({ tools: [{ name: "Read" }] }, { kind })).toThrow("E2_PROBE_TOOLS_REFUSED");
    expect(() => assertE2BaselineContext({ messages: [{ toolsAdded: [{ name: "Read" }] }] }, { kind })).toThrow("E2_PROBE_TOOLS_REFUSED");
  }
  expect(() => assertE2BaselineContext({ tools: [{ name: "Read" }] }, { kind: "source", sourceTools: ["Read"] })).not.toThrow();
  for (const tools of [[], [{ name: "UnexpectedFictionalTool" }]])
    expect(() => assertE2BaselineContext({ tools }, { kind: "source", sourceTools: ["Read"] })).toThrow("E2_PROBE_TOOLS_REFUSED");
});
it("applies the baseline native-body boundary to source, summary and probe requests", () => {
  const body = { model: "gpt-6.1-sol", stream: true, store: false, input: [], tools: [{ type: "function", name: "Read" }] };
  const hold = { model: SOL, replayArm: "baseline", paidRole: "source", tools: ["Read"] };
  const check = (value, metadata = hold) => e2ExecutionPolicy.assertBody(Buffer.from(JSON.stringify(value)), metadata);
  expect(() => check(body)).not.toThrow();
  for (const metadata of [{ ...hold, paidRole: "probe", probeRequest: 1 }, { ...hold, paidRole: "summary" }])
    expect(() => check(body, metadata)).toThrow("E2_PROBE_TOOLS_REFUSED");
  expect(() => check({ ...body, tools: [{ type: "function", name: "ConversationHistory" }] }, { ...hold, tools: ["ConversationHistory"] })).toThrow("E2_PROBE_TOOLS_REFUSED");
  expect(() => check({ ...body, input: [{ type: "function_call", name: "ConversationHistory", arguments: "{}" }] })).toThrow("E2_PROBE_TOOLS_REFUSED");
  const heading = "### Conversation continuity pack (historical evidence)\nFictional historical evidence";
  const current = { role: "user", content: "Fictional current prompt" };
  for (const paidRole of ["source", "probe", "summary"]) {
    const metadata = { ...hold, paidRole, tools: [], ...(paidRole === "probe" ? { probeRequest: 1 } : {}) };
    expect(() => check({ ...body, tools: [], input: [{ role: "user", content: `Discuss ${heading}` }, current] }, metadata)).not.toThrow();
    expect(() => check({ ...body, tools: [], input: [{ role: "user", content: [{ type: "input_text", text: heading }] }, current] }, metadata)).toThrow("e2_payload_forbidden");
  }
});
