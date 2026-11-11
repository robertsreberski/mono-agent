// Native SDK subprocesses; the only provider transport is replaced by owned HTTP loopback.
import { afterEach, expect, it } from "vitest";
import { mkdtemp, realpath, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { e2PhaseWork } from "../lib/continuity-e2-lineage.mjs";
import { guardedAccounting } from "../lib/continuity-guarded-accounting.mjs";
import { ROOT } from "../lib/continuity-observation-input.mjs";
import { FACT, NEXT_ACTION } from "../lib/continuity-e2-tools.mjs";
import { SOL } from "../lib/continuity-e2-protocol.mjs";
import { e2NativeFixture, E2_NATIVE_TEST_TIMEOUT_MS } from "./fixtures/e2-native-registration.mjs";
const roots = [], servers = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function events(text, full = false) {
  const item = { type: "message", id: "msg_fictional", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  return [
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: item.id, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "fictional-response", status: "completed", output: [item], service_tier: full ? "priority" : "default",
      usage: { input_tokens: full ? 272000 : 10, output_tokens: full ? 128000 : 5, input_tokens_details: full ? { cache_write_tokens: 272000 } : { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
}
function toolEvents(name, args, count) {
  const item = { type: "function_call", id: `fc_fictional_${count}`, call_id: `call_fictional_${count}`, name, arguments: JSON.stringify(args), status: "completed" };
  return [{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `fictional-response-${count}`, status: "completed", output: [item], service_tier: "default", usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 } } } }]
    .map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
}
function proofReply(body, count) {
  const name = body.tools?.find(t => t.name?.endsWith("ConversationHistory"))?.name;
  if (!name) return events("Fictional compacted context; retrieve archival evidence before answering.");
  const output = body.input.filter(i => i.type === "function_call_output").at(-1)?.output;
  let history;
  if (typeof output === "string") {
    // SDK flattens MCP blocks with newlines; rejoin the actual continued body.
    const normalized = output.replace(/\n?\[continued section \d+ of \d+\]\n/gu, "");
    const matches = [...normalized.matchAll(/\{"action":"(?:search|get)","status":/gu)];
    const offset = matches.at(-1)?.index;
    if (offset !== undefined) { try { history = JSON.parse(normalized.slice(offset)); } catch {} }
  }
  if (history?.action === "search") {
    const row = history.items?.find(i => i.kind === "tool" && i.toolName === "ProofRead") ?? history.items?.find(i => i.kind === "tool");
    if (!row?.recordId) throw Error("fictional_backend_missing_history_record");
    return toolEvents(name, { action: "get", recordId: row.recordId, chunkBytes: 8192 }, count);
  }
  if (history?.action === "get") return history.nextCursor ? toolEvents(name, { action: "get", cursor: history.nextCursor }, count) : events(`${FACT}; next: ${NEXT_ACTION}.`);
  return toolEvents(name, { action: "search", query: "proof-evidence", limit: 10 }, count);
}

async function run({ scenario = "probe", requests = 1, rows = [{ role: "probe", model: SOL }], capUnits, reuse = false, crossOutputReuse = false, production = false, fault, arm = "pressure", replay = false, probeLookupRounds = 1, probeLookups = false, phaseStartupDelayMs = 0, deadlines, expectedControllerError, retryOnce = false, failOdd = false, failAfter = 0 } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "e2-native-sdk-"))); roots.push(root);
  const originalHome = process.env.HOME;
  const fixture = await e2NativeFixture(root, { rows, arm, replay, probeLookupRounds, ...(deadlines ? { deadlines } : {}), ...(capUnits ? { capUnits } : {}) });
  expect(process.env.HOME).toBe(originalHome);
  if (replay) { expect(fixture.sizingHomes.length).toBeGreaterThan(0); expect(new Set(fixture.sizingHomes)).toEqual(new Set([fixture.home])); }
  const received = [], wireIdentities = [], receivedBytes = []; let listenerError;
  const server = http.createServer(async (request, response) => {
    try {
      wireIdentities.push({ session: request.headers["session-id"], request: request.headers["x-client-request-id"] });
      const chunks = []; for await (const chunk of request) chunks.push(chunk); const bytes = request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(Buffer.concat(chunks)) : Buffer.concat(chunks); receivedBytes.push(bytes); received.push(JSON.parse(bytes));
      const responseFault = (retryOnce && received.length > 1 || failOdd && received.length % 2 === 0) ? undefined : fault;
      if (responseFault === "dispatch-break") { request.socket.destroy(); return; }
      if (responseFault === "crash-retry" && received.length === 1 || ["model-error", "fixture-diagnostic-write", "cancel-retry"].includes(responseFault) || failAfter && received.length > failAfter) { response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "fictional_backend_failure", message: "Fictional backend failure." } })); return; }
      if (responseFault?.startsWith("http-rate-json")) {
        const error = responseFault === "http-rate-json-quota" ? { code: "insufficient_quota" }
          : responseFault === "http-rate-json-mixed" ? { code: "server_error", type: "insufficient_quota" }
          : responseFault === "http-rate-json-unknown" ? { code: "fictional_unknown" } : { code: "rate_limit_exceeded" };
        response.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error })); return;
      }
      if (["http-quota", "http-other"].includes(responseFault)) { response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: responseFault === "http-quota" ? "insufficient_quota" : "invalid_request_error" } })); return; }
      if (responseFault === "http-context") { response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "context_length_exceeded", message: "PRIVATE-CAUSE-CANARY" } })); return; }
      if (["http-auth", "http-rate"].includes(responseFault)) { response.writeHead(responseFault === "http-auth" ? 401 : 429).end(); return; }
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (responseFault === "midstream-reset") {
        response.write('data: {"type":"response.created","response":{"id":"fictional-partial","status":"in_progress"}}\n\n');
        setTimeout(() => response.destroy(), 25); return;
      }
      if (responseFault?.startsWith("sse-")) {
        const code = { "sse-context": "context_length_exceeded", "sse-server": "server_error", "sse-stream": "stream_error", "sse-rate": "rate_limit_exceeded", "sse-overload": "overloaded_error", "sse-transient": "transient_error", "sse-auth": "authentication_error", "sse-quota": "insufficient_quota", "sse-invalid": "invalid_request_error", "sse-policy": "content_policy_violation", "sse-type": "server_error", "sse-incomplete": "service_unavailable", "sse-error": "internal_server_error", "sse-context-reset": "context_length_exceeded" }[responseFault];
        const error = responseFault === "sse-mixed-quota" ? { code: "server_error", type: "insufficient_quota" }
          : responseFault === "sse-mixed-context" ? { code: "server_error", type: "context_length_exceeded" }
          : { ...(responseFault === "sse-type" ? { type: code } : { code }), message: "PRIVATE-CAUSE-CANARY" };
        const event = responseFault === "sse-error" ? { type: "error", error } : { type: responseFault === "sse-incomplete" ? "response.incomplete" : "response.failed", response: { error } };
        const frame = `data: ${JSON.stringify(event)}\n\n`;
        if (responseFault === "sse-context-reset") { response.write(frame); setTimeout(() => response.destroy(), 25); }
        else response.end(frame);
        return;
      }
      if (["empty", "length"].includes(responseFault)) {
        const data = events(responseFault === "empty" ? "" : "Fictional response").split("\n\n").filter(Boolean).map(line => JSON.parse(line.slice(6)));
        if (responseFault === "length") { const last = data.at(-1); last.type = "response.incomplete"; last.response.status = "incomplete"; last.response.incomplete_details = { reason: "max_output_tokens" }; }
        response.end(data.map(e => `data: ${JSON.stringify(e)}\n\n`).join("")); return;
      }
      if (["cancel", "cancel-then-refuse"].includes(scenario) || ["crash", "containment", "request-timeout"].includes(responseFault)) { response.flushHeaders(); return; }
      if (replay) {
        const tool = received.at(-1).tools?.find(t => t.name === "ConversationHistory");
        response.end(probeLookups && tool ? toolEvents(tool.name, { action: "search", query: "Fictional response", limit: 1 }, received.length) : events("Fictional response"));
      }
      else if (scenario === "proof") {
        const body = received.at(-1), current = body.input.filter(i => i.role === "user").at(-1)?.content;
        if (arm === "cancel" && JSON.stringify(current).includes("Continue without repeating the completed fictional sentinel")) { response.flushHeaders(); return; }
        response.end(proofReply(body, received.length));
      } else response.end(events(scenario.startsWith("lineage-pack") ? "Fictional evidence at /home/example/private/file.txt" : "FICTIONAL-SUMMARY-ANSWER-CANARY", scenario === "cap"));
    } catch (error) { listenerError = error; response.writeHead(500).end(); }
  }); servers.push(server); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const profile = { phaseStartupDelayMs, preload: join(root, "preload.mjs"), crossOutputReuse, root: ROOT, home: fixture.home, args: fixture.args, scenario, requests, reuse, production, fault, retryOnce,
    endpoint: `http://127.0.0.1:${server.address().port}/codex/responses`, result: join(root, "result.json"), descendant: join(root, "descendant.json") };
  const profilePath = join(root, "profile.json"), preload = join(root, "preload.mjs");
  await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 });
  await writeFile(preload, `import{installE2NativeRealm}from ${JSON.stringify(pathToFileURL(join(ROOT, "scripts/__tests__/fixtures/e2-native-realm.mjs")).href)};await installE2NativeRealm(${JSON.stringify(profile)});`, { mode: 0o600 });
  const before = await readFile(fixture.args.credentialPath), child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, join(ROOT, "scripts/__tests__/fixtures/e2-native-supervisor.mjs"), profilePath], {
    cwd: ROOT, env: { HOME: fixture.home, PATH: "/usr/bin:/bin", LANG: "C", NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", bytes => { stderr += bytes; }); const [code] = await once(child, "close");
  const result = JSON.parse(await readFile(profile.result, "utf8"));
  if (expectedControllerError) {
    expect(listenerError).toBeUndefined(); expect({ code, error: result.error, stderr }).toEqual({ code: 1, error: expectedControllerError, stderr: "" });
    return { ...result, received, state: JSON.parse(await readFile(join(fixture.args.outputRoot, "e2-validation-controller.json"))) };
  }
  expect(listenerError).toBeUndefined(); expect({ code, error: result.error, stderr }).toEqual({ code: 0, error: undefined, stderr: "" });
  expect(await readFile(fixture.args.credentialPath)).toEqual(before);
  expect(await readdir(join(fixture.home, ".local/state/mono-agent/lcc-e2/consumed-v1"))).toHaveLength(1);
  return { ...result, received, receivedBytes, wireIdentities, root, profile, funded: fixture.pilot.registration.schedule[0].budgets };
}
it("uses the genuine SDK and single guarded send, burns authority once, and publishes no canaries", async () => {
  const result = await run({ reuse: true }); expect(result.received).toHaveLength(1); expect(result.report.stop).toBe("completed");
  expect(result.reuse).toBe("e2_authorization_lease_invalid"); expect(result.reconciled.reconciliation).toBe(true);
  for (const canary of [result.root, "FICTIONAL-CONTEXT-CANARY", "FICTIONAL-SUMMARY-ANSWER-CANARY"]) expect(JSON.stringify(result.report)).not.toContain(canary);
}, E2_NATIVE_TEST_TIMEOUT_MS);
it("refuses the next ceiling reservation above the exact cap before a third send", async () => {
  const result = await run({ scenario: "cap", requests: 3, reuse: true, capUnits: "8000000000", rows: Array.from({ length: 3 }, () => ({ role: "probe", model: SOL })) });
  expect(result.received).toHaveLength(2); expect(result.report.stop).toBe("budget_admission"); expect(result.caught).toBe("not_admitted_cap"); expect(result.reuse).toBe("e2_authorization_lease_invalid");
  expect(result.report.costs.totalUnits).toBe("7840000000");
}, E2_NATIVE_TEST_TIMEOUT_MS);
it.each(["unauthorized-summary", "direct-model", "alternate-stream"])("refuses %s before native dispatch", async scenario => {
  const result = await run({ scenario, rows: [{ role: "summary", model: SOL }, { role: "probe", model: SOL }] });
  expect(result.received).toHaveLength(0); expect(result.report.stop).toBe(scenario === "unauthorized-summary" ? "e2_summary_not_authorized" : "e2_method_forbidden");
}, E2_NATIVE_TEST_TIMEOUT_MS);
it("retains full liability when cancelled after actual response headers", async () => {
  const result = await run({ scenario: "cancel", rows: [{ role: "continuation", model: SOL }] });
  expect(result.received).toHaveLength(1); expect(result.report.retries.attempted).toBe(0); expect(result.report.costs.retainedUnits).toBe("3920000000");
}, E2_NATIVE_TEST_TIMEOUT_MS);
it("verifies generated output and an actual durable journal before accepting the SDK probe body", async () => {
  const result = await run({ scenario: "summary", rows: [{ role: "summary", model: SOL }, { role: "probe", model: SOL }] });
  expect(result.received).toHaveLength(2); expect(result.report.stop).toBe("completed"); expect(result.report.phases[0].calls.verifiedSummaries).toBe(1);
  expect(result.wireIdentities.every(h => typeof h.session === "string" && h.session.length > 0 && h.session === h.request)).toBe(true);
}, E2_NATIVE_TEST_TIMEOUT_MS);
it("stops changed summary text at the real gate without forwarding a probe", async () => {
  const result = await run({ scenario: "lineage-tamper", rows: [{ role: "summary", model: SOL }, { role: "probe", model: SOL }] });
  expect(result.received).toHaveLength(1); expect(result.report.stop).toBe("e2_summary_receipt_invalid");
}, E2_NATIVE_TEST_TIMEOUT_MS);

const productionRows = ["summary", "continuation", "probe"].flatMap(role => Array.from({ length: 8 }, () => ({ role, model: SOL })));
it("reconciles a crashed genuine phase child without dispatching another native request", async () => {
  const result = await run({ production: true, fault: "crash", reuse: true, rows: productionRows });
  expect(result.received, JSON.stringify(result.report)).toHaveLength(1); expect(result.report.stop).not.toBe("completed");
  expect(result.report.costs.retainedUnits).toBe("3920000000"); expect(result.reconciled.reconciliation).toBe(true); expect(result.reuse).toBe("e2_authorization_lease_invalid");
}, E2_NATIVE_TEST_TIMEOUT_MS);
it("contains a real descendant of the genuine phase child at the watchdog, retaining its hold", async () => {
  const result = await run({ production: true, fault: "containment", rows: productionRows });
  expect(result.received).toHaveLength(1); expect(result.report.retries.attempted).toBe(0); expect(result.report.stop).toBe("e2_worker_timeout");
  expect(result.report.costs.retainedUnits).toBe("3920000000");
  const descendant = JSON.parse(await readFile(result.profile.descendant, "utf8"));
  expect(() => process.kill(descendant.pid, 0)).toThrow();
}, E2_NATIVE_TEST_TIMEOUT_MS);

it("runs genuine C2 continuation/probe SDK tool rounds through the literal phase child", async () => {
  const result = await run({ production: true, scenario: "proof", arm: "switch", rows: productionRows });
  expect(result.report.stop, JSON.stringify(result.report)).toBe("completed"); expect(result.report.phases[0].score).toBe(1);
  expect(result.received.length).toBeGreaterThanOrEqual(4);
}, E2_NATIVE_TEST_TIMEOUT_MS);
it("allows only the registered completed cancellation seed-to-resume transition in one controller", async () => {
  const rows = [...Array.from({ length: 8 }, () => ({ role: "summary", model: SOL, phase: "seed" })),
    { role: "continuation", model: SOL, phase: "seed" }, ...Array.from({ length: 8 }, () => ({ role: "continuation", model: SOL, phase: "resume" })),
    ...Array.from({ length: 8 }, () => ({ role: "probe", model: SOL, phase: "resume" }))];
  const result = await run({ production: true, scenario: "proof", arm: "cancel", rows });
  expect(result.report.stop, JSON.stringify(result.report)).toBe("completed"); expect(result.report.phases).toHaveLength(2);
  expect(result.report.phases[1].score).toBe(1); expect(BigInt(result.report.costs.retainedUnits)).toBe(3920000000n);
}, E2_NATIVE_TEST_TIMEOUT_MS);

it("replays genuine C1 snapshots and frozen private questions through both pristine checkpoint copies", async () => {
  const result = await run({ production: true, replay: true });
  expect(result.report.stop, JSON.stringify(result.report)).toBe("completed"); expect(result.received).toHaveLength(2);
  for (const body of result.received) expect(JSON.stringify(body)).toContain("PRIVATE-FROZEN-FICTIONAL-QUESTION");
  const replay = JSON.parse(await readFile(join(result.root, "output/work/replay/replay.json"), "utf8"));
  expect(replay.branches.flatMap(b => b.checkpoints.flatMap(c => c.probes.map(p => p.requests)))).toEqual([1, 1]);
  expect(result.report.phases[0].score).toBe(1);
}, E2_NATIVE_TEST_TIMEOUT_MS);

it("a genuine SDK model failure ends the authorization before any registered resume phase", async () => {
  const rows = [...Array.from({ length: 8 }, () => ({ role: "summary", model: SOL, phase: "seed" })),
    { role: "continuation", model: SOL, phase: "seed" }, { role: "continuation", model: SOL, phase: "resume" }, { role: "probe", model: SOL, phase: "resume" }];
  const result = await run({ production: true, arm: "cancel", rows, fault: "model-error", reuse: true });
  expect(result.received).toHaveLength(2); expect(result.report.schedule.visited).toBe(1); expect(result.report.schedule.remaining).toBe(1);
  expect(result.report.stop).toBe("e2_phase_failed"); expect(result.report.costs.retainedUnits).toBe("7840000000");
  expect(result.reuse).toBe("e2_authorization_lease_invalid");
}, E2_NATIVE_TEST_TIMEOUT_MS);

it("refuses independently consumed authority at a different output root through the real registry path", async () => {
  const result = await run({ crossOutputReuse: true });
  expect(result.received).toHaveLength(1);
  expect(result.crossOutputReuse).toBe("e2_authorization_already_consumed");
  expect(result.crossOutputMarker).toBe(false);
}, E2_NATIVE_TEST_TIMEOUT_MS);

it("allows a cold phase start beyond ten seconds without bypassing guarded SDK admission", async () => {
  const started = performance.now();
  const result = await run({ production: true, scenario: "proof", arm: "switch", rows: productionRows, phaseStartupDelayMs: 11_000 });
  expect(performance.now() - started).toBeGreaterThanOrEqual(11_000);
  expect(result.report.stop, JSON.stringify(result.report)).toBe("completed");
  expect(result.received.length).toBeGreaterThanOrEqual(4);
  expect(result.report.phases[0].calls.consumed).toBe(result.received.length);
}, E2_NATIVE_TEST_TIMEOUT_MS);

it("funds R=3 and withdraws native tools on each fourth C1 probe request", async () => {
  const result = await run({ replay: true, production: true, probeLookupRounds: 3, probeLookups: true });
  expect(result.report.stop, JSON.stringify(result.report)).toBe("completed");
  const probes = result.received.filter(body => JSON.stringify(body.input).includes("PRIVATE-FROZEN-FICTIONAL-QUESTION"));
  expect(probes).toHaveLength(8);
  expect(probes.map(body => (body.tools ?? []).map(t => t.name))).toEqual([
    ["ConversationHistory"], ["ConversationHistory"], ["ConversationHistory"], [],
    ["ConversationHistory"], ["ConversationHistory"], ["ConversationHistory"], [],
  ]);
  expect(result.funded.filter(b => b.paidRole !== "summary").reduce((n, b) => n + b.maxRequests, 0)).toBe(8);
  expect(result.report.phases[0].calls.settled).toBe(result.received.length);
}, E2_NATIVE_TEST_TIMEOUT_MS);
it("settles an early native answer without spending unused R=3 continuation funding", async () => {
  const result = await run({ replay: true, production: true, probeLookupRounds: 3 });
  expect(result.report.stop, JSON.stringify(result.report)).toBe("completed");
  const probes = result.received.filter(body => JSON.stringify(body.input).includes("PRIVATE-FROZEN-FICTIONAL-QUESTION"));
  expect(probes).toHaveLength(2);
  expect(result.funded.filter(b => b.paidRole !== "summary").reduce((n, b) => n + b.maxRequests, 0)).toBe(8);
  expect(result.report.phases[0].calls.settled).toBe(result.received.length);
  expect(result.report.costs).toMatchObject({ retainedUnits: "0", activeUnits: "0" });
}, E2_NATIVE_TEST_TIMEOUT_MS);

it("kills a stalled genuine paid request on its own clock, not the longer phase watchdog", async () => {
  const started = performance.now();
  const result = await run({ production: true, fault: "request-timeout", rows: productionRows,
    deadlines: { requestDeadlineMs: 1000, phaseDeadlineMs: 60000, childWatchdogMs: 60000, runDeadlineMs: 120000 } });
  expect(result.received).toHaveLength(1); expect(result.report.retries.attempted).toBe(0); expect(result.report.stop).toBe("e2_worker_timeout");
  expect(result.report.costs).toMatchObject({ retainedUnits: "3920000000", activeUnits: "0" });
  expect(performance.now() - started).toBeLessThan(60000);
}, E2_NATIVE_TEST_TIMEOUT_MS);

it("refuses a smuggled summary in a no-lineage SDK baseline with zero fetches", async () => {
  const result = await run({ scenario: "baseline-smuggle", rows: [{ role: "probe", model: SOL }] });
  expect(result.received).toHaveLength(0); expect(result.report.stop).toBe("e2_summary_receipt_invalid");
}, E2_NATIVE_TEST_TIMEOUT_MS);
it.each(["lineage-extra-native", "lineage-extra-pack", "lineage-pack-text", "lineage-pack-sha", "archive-tamper"])("refuses %s at the genuine SDK gate with zero probe fetches", async scenario => {
  const result = await run({ scenario, rows: [{ role: "summary", model: SOL }, { role: "probe", model: SOL }] });
  expect(result.received).toHaveLength(1); expect(result.report.stop).toBe("e2_summary_receipt_invalid");
  expect(result.report.phases[0].summaryPresence).toMatchObject({ checked: 1, unobserved: 1 });
}, E2_NATIVE_TEST_TIMEOUT_MS);
it.each([["lineage-branch", "branch"], ["lineage-pack", "pack"], ["archive-absent", "none"], ["lineage-absent", "none"]])("accepts and durably reports %s at the genuine SDK boundary", async (scenario, kind) => {
  const result = await run({ scenario, rows: [{ role: "summary", model: SOL }, { role: "probe", model: SOL }] });
  expect(result.received).toHaveLength(2); expect(result.report.stop).toBe("completed");
  expect(result.report.phases[0].summaryPresence).toMatchObject({ checked: 2, unobserved: 0, [kind]: kind === "none" ? 2 : 1 });
}, E2_NATIVE_TEST_TIMEOUT_MS);

it.each(["unwitnessed-settled", "unwitnessed-own-abort"])("refuses %s in the real controller before any fetch", async scenario => {
  const result = await run({ scenario, expectedControllerError: "e2_summary_receipt_invalid" });
  expect(result.received).toHaveLength(0); expect(result.state.slots[0].terminal).toBe("integrity_stop");
  expect(result.state.slots[0].holds[0].summaryPresence).toBeUndefined();
  expect(result.state.stop).toBe("e2_summary_receipt_invalid");
}, E2_NATIVE_TEST_TIMEOUT_MS);
it.each(["unwitnessed-lost", "unwitnessed-before-send"])("allows %s without inventing a body witness", async scenario => {
  const result = await run({ scenario }); expect(result.received).toHaveLength(0);
  expect(result.report.phases[0].summaryPresence).toMatchObject({ checked: 0, unobserved: 1, none: 0 });
}, E2_NATIVE_TEST_TIMEOUT_MS);
it.each(["baseline-function-output", "baseline-reasoning-summary"])("denies %s with zero native fetches", async scenario => {
  const result = await run({ scenario }); expect(result.received).toHaveLength(0);
  expect(result.report.stop).toBe("e2_summary_receipt_invalid");
}, E2_NATIVE_TEST_TIMEOUT_MS);

it.each([
  ["model-error", "sdk_error_result", "server", 500, false],
  ["sse-context", "sdk_error_result", "context", 200, false],
  ["sse-server", "sdk_error_result", "stream", 200, false],
  ["sse-stream", "sdk_error_result", "stream", 200, false],
  ["http-auth", "sdk_error_result", "auth", 401, false],
  ["http-rate", "sdk_error_result", "rate", 429, false],
  ["http-context", "sdk_error_result", "context", 400, false],
  ["sse-rate", "sdk_error_result", "rate", 200, false],
  ["empty", "empty_final_text", "unknown", 200, true],
  ["length", "sdk_length_result", "length", 200, true],
  ["rejected", "sdk_promise_rejected", "stream", 200, true],
])("records closed %s diagnostics through the owned SDK route", async (fault, causeClass, providerClass, httpStatus, terminalUsageObserved) => {
  const result = await run({ fault });
  const cause = result.report.phases[0].diagnostics?.nativeCause;
  const retried = ["model-error", "sse-stream", "sse-server", "http-rate", "empty"].includes(fault);
  expect(cause, JSON.stringify(result.report)).toMatchObject({ round: retried ? 2 : 1, role: "probe", checkpoint: 0, causeClass, providerClass, httpStatus, terminalUsageObserved });
  expect(cause.payloadDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(cause.responseHeadersObserved).toBe(httpStatus !== null);
  expect(result.received).toHaveLength(retried ? 2 : 1);
  for (const value of [result.root, "PRIVATE-CAUSE-CANARY", "Fictional backend failure"]) expect(JSON.stringify(result.report)).not.toContain(value);
}, E2_NATIVE_TEST_TIMEOUT_MS);

it("records an unexpected SDK abortion without changing lost/abort liability", async () => {
  const result = await run({ scenario: "unexpected-abort" });
  expect(result.report.phases[0].diagnostics?.nativeCause).toMatchObject({ causeClass: "sdk_aborted_result", responseHeadersObserved: true, terminalUsageObserved: false });
  expect(result.report.costs.retainedUnits).toBe("3920000000");
}, E2_NATIVE_TEST_TIMEOUT_MS);

it("keeps accepted C1 answers outside restored roots and emits only informational partial quality on failure", async () => {
  const result = await run({ production: true, replay: true, failAfter: 1, fault: "slow-refusal" });
  expect(result.report.stop).toBe("e2_phase_failed"); expect(result.report.qualityMeasured).toBe(false);
  const base = join(result.root, "output/work/replay"), entry = JSON.parse(await readFile(join(base, "answer-progress/000001.json")));
  expect(entry).toMatchObject({ schema: "continuity-e2-answer-progress-v1", round: 1, checkpoint: 0, answer: { repeat: 1, text: "Fictional response" } });
  expect(entry.registrationSha256).toMatch(/^[a-f0-9]{64}$/u); expect(entry.payloadDigest).toMatch(/^[a-f0-9]{64}$/u);
  const partial = JSON.parse(await readFile(join(base, "partial-score.json")));
  expect(partial).toMatchObject({ schema: "continuity-e2-informational-partial-score-v1", informational: true, qualityMeasured: false, completedAnswers: 1, plannedAnswers: 2 });
  expect(partial).not.toHaveProperty("gate"); expect(result.report.phases[0].diagnostics.partialQuality).toEqual(partial);
  await expect(readFile(join(base, "whole-refusal.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(result.report.phases[0].diagnostics.nativeCause).toMatchObject({ round: 3, causeClass: "sdk_error_result", httpStatus: 500 });
  await expect(readFile(join(base, "answers.json"))).rejects.toMatchObject({ code: "ENOENT" });
}, E2_NATIVE_TEST_TIMEOUT_MS);

it.each(["baseline-previous", "lineage-previous-forged"])("refuses %s before any corresponding SDK fetch", async scenario => {
  const hasLineage = scenario.startsWith("lineage");
  const result = await run({ scenario, rows: hasLineage ? [{ role: "summary", model: SOL }, { role: "probe", model: SOL }] : [{ role: "probe", model: SOL }] });
  expect(result.report.stop).toBe("e2_summary_receipt_invalid"); expect(result.received).toHaveLength(hasLineage ? 1 : 0);
}, E2_NATIVE_TEST_TIMEOUT_MS);

it("accepts the genuine incremental summary formatter at the SDK gate", async () => {
  const result = await run({ scenario: "lineage-previous", rows: [{ role: "summary", model: SOL }, { role: "probe", model: SOL }] });
  expect(result.report.stop).toBe("completed"); expect(result.received).toHaveLength(2);
  expect(result.report.phases[0].summaryPresence.native).toBe(1);
}, E2_NATIVE_TEST_TIMEOUT_MS);

it("reconstructs informational partial quality from durable progress after abrupt genuine C1 child loss", async () => {
  const result = await run({ production: true, replay: true, fault: "crash-after-one" });
  expect(result.received).toHaveLength(2); expect(result.report.stop).not.toBe("completed"); expect(result.report.qualityMeasured).toBe(false);
  const partial = JSON.parse(await readFile(join(result.root, "output/work/replay/partial-score.json")));
  expect(partial).toMatchObject({ informational: true, qualityMeasured: false, completedAnswers: 1 });
  expect(result.report.phases[0].diagnostics.partialQuality).toEqual(partial);
}, E2_NATIVE_TEST_TIMEOUT_MS);

it.each(["progress-write"])("keeps the paid replay successful after a %s recovery-evidence failure and reports its gap", async fault => {
  const result = await run({ production: true, replay: true, fault });
  expect(result.received).toHaveLength(2); expect(result.report.stop).toBe("completed");
  expect(result.report.phases[0].diagnostics).toMatchObject({ progressGap: fault === "answer-binding" ? 2 : 1 });
  expect(result.report.stop).not.toBe("e2_permit_invalid");
  const base = join(result.root, "output/work/replay"), answers = JSON.parse(await readFile(join(base, "answers.json"))), score = JSON.parse(await readFile(join(base, "score.json")));
  expect(answers.answers).toHaveLength(2); expect(score.report).toMatchObject({ complete: true, gate: true });
  await expect(readFile(join(base, "partial-score.json"))).rejects.toMatchObject({ code: "ENOENT" });
}, E2_NATIVE_TEST_TIMEOUT_MS);
it("reports missing answer recovery evidence in controller-only partial quality without failing its accepted paid answer", async () => {
  const result = await run({ production: true, replay: true, fault: "progress-write", failAfter: 1 });
  expect(result.received).toHaveLength(3); expect(result.report.stop).toBe("e2_phase_failed");
  expect(result.report.phases[0].diagnostics).toMatchObject({ progressGap: 1, partialQuality: { progressGap: 1, completedAnswers: 0, plannedAnswers: 2, qualityMeasured: false } });
}, E2_NATIVE_TEST_TIMEOUT_MS);
it("labels a synchronous pre-send guarded SDK refusal without misclassifying it as an SDK promise failure", async () => {
  const result = await run({ production: true, replay: true, fault: "guard-refused" });
  expect(result.received).toHaveLength(0);
  expect(result.report.phases[0].diagnostics.nativeCause).toMatchObject({ sourceStage: "guard_refused", causeClass: "guard_refused", payloadDigest: null, responseHeadersObserved: false });
}, E2_NATIVE_TEST_TIMEOUT_MS);

it("stops on an unsettled answer binding instead of treating it as optional journal I/O", async () => {
  const result = await run({ production: true, replay: true, fault: "answer-binding" });
  expect(result.report.stop).toBe("e2_phase_failed"); expect(result.report.qualityMeasured).toBe(false); expect(result.received).toHaveLength(1);
  await expect(readFile(join(result.root, "output/work/replay/answers.json"))).rejects.toMatchObject({ code: "ENOENT" });
}, E2_NATIVE_TEST_TIMEOUT_MS);
it.each(["lineage-previous-stale", "lineage-previous-cross-scope"])("refuses %s at the controller SDK boundary with no corresponding fetch", async scenario => {
  const result = await run({ scenario, rows: [{ role: "summary", model: SOL }, { role: "probe", model: SOL }] });
  expect(result.received).toHaveLength(1); expect(result.report.stop).toBe("e2_summary_receipt_invalid");
  expect(result.report.phases[0].calls.consumed).toBe(2);
}, E2_NATIVE_TEST_TIMEOUT_MS);

it("keeps malformed but registered recovery entries explicitly inconclusive with a visible gap", async () => {
  const result = await run({ production: true, replay: true, fault: "progress-malformed", failAfter: 1 });
  expect(result.report.phases[0].diagnostics).toMatchObject({ progressGap: 1, partialQuality: { progressGap: 1, completedAnswers: 0, plannedAnswers: 2, qualityMeasured: false } });
}, E2_NATIVE_TEST_TIMEOUT_MS);
it("keeps the admitted digest on a refusal before consume", async () => {
  const result = await run({ fault: "after-admit" }), state = JSON.parse(await readFile(join(result.root, "output/e2-validation-controller.json")));
  expect(result.received).toHaveLength(0); expect(state.slots[0].holds[0].consumed).toBe(false);
  expect(result.report.phases[0].diagnostics.nativeCause.payloadDigest).toBe(state.slots[0].holds[0].payloadDigest);
}, E2_NATIVE_TEST_TIMEOUT_MS);
it("still sends done when the fixture refusal artifact cannot be written", async () => {
  const result = await run({ fault: "fixture-diagnostic-write" });
  expect(result.caught).toBe("e2_phase_failed"); expect(result.report.stop).toBe("e2_phase_failed"); expect(result.received).toHaveLength(2);
}, E2_NATIVE_TEST_TIMEOUT_MS);

it.each([
  ["dispatch-break", "stream"], ["dispatch-refused", "stream"], ["dispatch-unreachable", "stream"], ["dispatch-pipe", "stream"], ["midstream-reset", "stream"], ["body-aborted", "stream"], ["body-reset", "stream"], ["body-premature", "stream"], ["body-socket", "stream"], ["sse-stream", "stream"], ["sse-server", "stream"],
  ["sse-overload", "stream"], ["sse-transient", "stream"], ["sse-type", "stream"], ["sse-incomplete", "stream"], ["sse-error", "stream"], ["model-error", "http_5xx"],
  ["http-rate", "http_429"], ["http-rate-json", "http_429"], ["http-rate-json-unknown", "http_429"], ["empty", "empty_final_text"], ["sdk-aborted", "unowned_aborted_result"],
])("retries eligible %s once with identical bytes and a fresh independently verified hold", async (fault, cause) => {
  const result = await run({ fault, retryOnce: true });
  expect(result.report.stop, JSON.stringify(result.report)).toBe("completed"); expect(result.received).toHaveLength(2);
  expect(result.receivedBytes[1]).toEqual(result.receivedBytes[0]);
  expect(result.report.retries).toEqual({ attempted: 1, succeeded: 1, causeClasses: { [cause]: 1 } });
  expect(result.report.phases[0].retries).toEqual(result.report.retries);
  const state = JSON.parse(await readFile(join(result.root, "output/e2-validation-controller.json"))), holds = state.slots[0].holds;
  expect(holds.map(h => h.payloadDigest)).toEqual([holds[0].payloadDigest, holds[0].payloadDigest]);
  expect(holds[1]).toMatchObject({ retryOf: 1, consumed: true, paidRole: holds[0].paidRole, model: holds[0].model, checkpoint: holds[0].checkpoint, reservedUnits: holds[0].reservedUnits });
  expect(holds[1].permitId).not.toBe(holds[0].permitId); expect(holds.every(h => h.summaryPresence)).toBe(true);
  if (["empty", "sdk-aborted"].includes(fault)) expect(result.report.costs.completeUnits).toBe("140000");
  else expect(result.report.costs.retainedUnits).toBe("3920000000");
}, E2_NATIVE_TEST_TIMEOUT_MS);

it.each(["http-auth", "http-context", "http-quota", "http-other", "http-rate-json-quota", "http-rate-json-mixed", "sse-mixed-quota", "sse-mixed-context", "sse-context", "sse-rate", "sse-auth", "sse-quota", "sse-invalid", "sse-policy", "sse-context-reset", "length", "sdk-unknown", "sdk-deadline", "body-deadline"])("never retries ineligible %s despite a recoverable next response", async fault => {
  const result = await run({ fault, retryOnce: true });
  expect(result.received).toHaveLength(1); expect(result.report.retries.attempted).toBe(0); expect(result.report.stop).not.toBe("completed");
}, E2_NATIVE_TEST_TIMEOUT_MS);

it("stops after the sole retry fails, retaining both lost liabilities", async () => {
  const result = await run({ fault: "model-error", reuse: true });
  expect(result.received).toHaveLength(2); expect(result.report.retries).toEqual({ attempted: 1, succeeded: 0, causeClasses: { http_5xx: 1 } });
  expect(result.report.costs.retainedUnits).toBe("7840000000"); expect(result.reuse).toBe("e2_authorization_lease_invalid");
}, E2_NATIVE_TEST_TIMEOUT_MS);
it("does not fetch a retry when the failed hold leaves insufficient cap", async () => {
  const result = await run({ fault: "model-error", retryOnce: true, capUnits: "5000000000" });
  expect(result.received).toHaveLength(1); expect(result.report.stop).toBe("budget_admission");
  expect(result.report.costs.retainedUnits).toBe("3920000000"); expect(result.report.retries.attempted).toBe(0);
  const state = JSON.parse(await readFile(join(result.root, "output/e2-validation-controller.json")));
  expect(result.report.phases[0].terminal).toBe("lost"); expect(state.slots[0].terminal).toBe("lost");
  expect(guardedAccounting("e2-validation").accountRun(state.slots).consecutiveProviderLosses).toBe(1);
}, E2_NATIVE_TEST_TIMEOUT_MS);
it("stops the ninth eligible failure without consuming another logical slot or retry", async () => {
  const result = await run({ fault: "model-error", failOdd: true, requests: 9, rows: Array.from({ length: 9 }, () => ({ role: "probe", model: SOL })) });
  expect(result.received).toHaveLength(17); expect(result.report.stop).toBe("e2_phase_failed");
  expect(result.report.retries).toEqual({ attempted: 8, succeeded: 8, causeClasses: { http_5xx: 8 } });
  expect(result.funded.reduce((n, b) => n + b.maxRequests, 0)).toBe(9);
}, E2_NATIVE_TEST_TIMEOUT_MS);
it("reconciles abrupt child loss during a retry without any automatic resend", async () => {
  const result = await run({ fault: "crash-retry", reuse: true });
  expect(result.received).toHaveLength(2); expect(result.report.stop).not.toBe("completed");
  expect(result.report.costs.retainedUnits).toBe("7840000000"); expect(result.reconciled.reconciliation).toBe(true);
  expect(result.reuse).toBe("e2_authorization_lease_invalid"); expect(result.report.retries.succeeded).toBe(0);
}, E2_NATIVE_TEST_TIMEOUT_MS);
it("retries a generated summary without accepting its failed predecessor as durable lineage", async () => {
  const result = await run({ fault: "empty", retryOnce: true, scenario: "summary", rows: [{ role: "summary", model: SOL }, { role: "probe", model: SOL }] });
  expect(result.report.stop, JSON.stringify(result.report)).toBe("completed"); expect(result.received).toHaveLength(3);
  expect(result.receivedBytes[1]).toEqual(result.receivedBytes[0]); expect(result.report.phases[0].calls.verifiedSummaries).toBe(1);
}, E2_NATIVE_TEST_TIMEOUT_MS);
it("keeps R=3 logical tool ordinals unchanged after retrying the first probe", async () => {
  const result = await run({ production: true, replay: true, probeLookupRounds: 3, probeLookups: true, fault: "model-error", retryOnce: true });
  expect(result.report.stop, JSON.stringify(result.report)).toBe("completed"); expect(result.received).toHaveLength(9);
  expect(result.receivedBytes[1]).toEqual(result.receivedBytes[0]);
  expect(result.received.map(b => (b.tools ?? []).length)).toEqual([1, 1, 1, 1, 0, 1, 1, 1, 0]);
  expect(result.funded.filter(b => b.paidRole !== "summary").reduce((n,b) => n + b.maxRequests,0)).toBe(8);
}, E2_NATIVE_TEST_TIMEOUT_MS);

it("does not admit a retry after owner abort during retry IPC and releases the pending grant", async () => {
  const result = await run({ fault: "cancel-retry", retryOnce: true });
  expect(result.received).toHaveLength(1); expect(result.report.retries.attempted).toBe(0);
  const state = JSON.parse(await readFile(join(result.root, "output/e2-validation-controller.json")));
  expect(state.slots[0].holds).toHaveLength(1); expect(state.slots[0].holds[0].retryCanceled).toBe(true);
  expect(state.slots[0].retryPending).toBeUndefined(); expect(state.slots[0].terminal).toBe("lost");
}, E2_NATIVE_TEST_TIMEOUT_MS);

it("does not retain deliberate cancellation as a cause or mask a later genuine guard failure", async () => {
  const result = await run({ scenario: "cancel-then-refuse", fault: "cancel-rejected", rows: [{ role: "continuation", model: SOL }, { role: "probe", model: SOL }] });
  expect(result.received).toHaveLength(1);
  const state = JSON.parse(await readFile(join(result.root, "output/e2-validation-controller.json")));
  expect(JSON.parse(await readFile(join(e2PhaseWork(join(result.root, "output"), state.schedule[0]), "cancel-cause.json")))).toBeNull();
  expect(state.slots[0].holds[0].nativeCause).toBeUndefined();
  expect(result.report.phases[0].diagnostics.nativeCause).toMatchObject({ round: 2, causeClass: "guard_refused", ownerCanceled: false });
}, E2_NATIVE_TEST_TIMEOUT_MS);
