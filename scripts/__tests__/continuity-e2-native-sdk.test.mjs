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

async function run({ scenario = "probe", requests = 1, rows = [{ role: "probe", model: SOL }], capUnits, reuse = false, crossOutputReuse = false, production = false, fault, arm = "pressure", replay = false, probeLookupRounds = 1, probeLookups = false, phaseStartupDelayMs = 0 } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "e2-native-sdk-"))); roots.push(root);
  const originalHome = process.env.HOME;
  const fixture = await e2NativeFixture(root, { rows, arm, replay, probeLookupRounds, ...(capUnits ? { capUnits } : {}) });
  expect(process.env.HOME).toBe(originalHome);
  if (replay) { expect(fixture.sizingHomes.length).toBeGreaterThan(0); expect(new Set(fixture.sizingHomes)).toEqual(new Set([fixture.home])); }
  const received = [], wireIdentities = []; let listenerError;
  const server = http.createServer(async (request, response) => {
    try {
      wireIdentities.push({ session: request.headers["session-id"], request: request.headers["x-client-request-id"] });
      const chunks = []; for await (const chunk of request) chunks.push(chunk); received.push(JSON.parse(request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(Buffer.concat(chunks)) : Buffer.concat(chunks)));
      if (fault === "model-error") { response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "fictional_backend_failure", message: "Fictional backend failure." } })); return; }
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (scenario === "cancel" || fault) { response.flushHeaders(); return; }
      if (replay) {
        const tool = received.at(-1).tools?.find(t => t.name === "ConversationHistory");
        response.end(probeLookups && tool ? toolEvents(tool.name, { action: "search", query: "Fictional response", limit: 1 }, received.length) : events("Fictional response"));
      }
      else if (scenario === "proof") {
        const body = received.at(-1), current = body.input.filter(i => i.role === "user").at(-1)?.content;
        if (arm === "cancel" && JSON.stringify(current).includes("Continue without repeating the completed fictional sentinel")) { response.flushHeaders(); return; }
        response.end(proofReply(body, received.length));
      } else response.end(events("FICTIONAL-SUMMARY-ANSWER-CANARY", scenario === "cap"));
    } catch (error) { listenerError = error; response.writeHead(500).end(); }
  }); servers.push(server); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const profile = { phaseStartupDelayMs, preload: join(root, "preload.mjs"), crossOutputReuse, root: ROOT, home: fixture.home, args: fixture.args, scenario, requests, reuse, production, fault,
    endpoint: `http://127.0.0.1:${server.address().port}/codex/responses`, result: join(root, "result.json"), descendant: join(root, "descendant.json") };
  const profilePath = join(root, "profile.json"), preload = join(root, "preload.mjs");
  await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 });
  await writeFile(preload, `import{installE2NativeRealm}from ${JSON.stringify(pathToFileURL(join(ROOT, "scripts/__tests__/fixtures/e2-native-realm.mjs")).href)};await installE2NativeRealm(${JSON.stringify(profile)});`, { mode: 0o600 });
  const before = await readFile(fixture.args.credentialPath), child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, join(ROOT, "scripts/__tests__/fixtures/e2-native-supervisor.mjs"), profilePath], {
    cwd: ROOT, env: { HOME: fixture.home, PATH: "/usr/bin:/bin", LANG: "C", NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", bytes => { stderr += bytes; }); const [code] = await once(child, "close");
  const result = JSON.parse(await readFile(profile.result, "utf8"));
  expect(listenerError).toBeUndefined(); expect({ code, error: result.error, stderr }).toEqual({ code: 0, error: undefined, stderr: "" });
  expect(await readFile(fixture.args.credentialPath)).toEqual(before);
  expect(await readdir(join(fixture.home, ".local/state/mono-agent/lcc-e2/consumed-v1"))).toHaveLength(1);
  return { ...result, received, wireIdentities, root, profile, funded: fixture.pilot.registration.schedule[0].budgets };
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
  expect(result.received).toHaveLength(1); expect(result.report.costs.retainedUnits).toBe("3920000000");
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
  expect(result.received).toHaveLength(1); expect(result.report.stop).toBe("e2_worker_timeout");
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
  expect(result.received).toHaveLength(1); expect(result.report.schedule.visited).toBe(1); expect(result.report.schedule.remaining).toBe(1);
  expect(result.report.stop).toBe("e2_phase_failed"); expect(result.report.costs.retainedUnits).toBe("3920000000");
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
