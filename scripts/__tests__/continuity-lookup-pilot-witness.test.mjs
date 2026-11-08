import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

// Faux configured route: the real faux factory, guard, private serializer and runLiveTurn.
// Only the controller/IPC/preparation/role authority graph is mocked, like the credentialed unit.
let ROOT;
const sha = value => createHash("sha256").update(value).digest("hex");
const MARKER = "MORGAN-7Q4"; // Fictional evaluator annotation, never pilot content.
const mocked = ["pilot-state", "ipc", "roles", "preparation"].map(name => `../lib/continuity-lookup-${name}.mjs`);
let base, server, port, state, modules, runner, faux, records, plan, arm, patch, soul, rejected = [];
const arrivals = new Map();

function events(items) {
  const rows = items.flatMap((item, index) => [
    { type: "response.output_item.added", output_index: index, item: item.type === "function_call" ? { ...item, arguments: "" } : { ...item, content: [] } },
    ...(item.type === "message" ? [{ type: "response.content_part.added", output_index: index, content_index: 0, item_id: item.id, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", output_index: index, content_index: 0, item_id: item.id, delta: item.content[0].text }] : []),
    { type: "response.output_item.done", output_index: index, item },
  ]);
  rows.push({ type: "response.completed", response: { id: "fictional-response", status: "completed", output: items, service_tier: "default", usage: { input_tokens: 10, output_tokens: 5 } } });
  return rows.map(row => `data: ${JSON.stringify(row)}\n\n`).join("");
}

beforeAll(async () => {
  vi.resetModules();
  base = await realpath(await mkdtemp(join(tmpdir(), "lookup-pilot-witness-")));
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) vi.stubEnv(key, join(base, "home"));
  for (const key of Object.keys(process.env)) if (/^CI$|^CONTINUITY_DEBUG$/u.test(key)) vi.stubEnv(key, undefined);
  await mkdir(join(base, "home"));
  server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks), bytes = request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw, body = JSON.parse(bytes);
    const key = request.headers["session-id"], round = (arrivals.get(key)?.length ?? 0) + 1;
    arrivals.set(key, [...(arrivals.get(key) ?? []), { round, digest: sha(bytes), marker: bytes.includes(MARKER), consumed: state.slots[0].holds.at(-1)?.consumed === true }]);
    const tool = body.tools.find(t => t.name.endsWith("ConversationHistory"));
    // Round one puts the marker into the NEXT context through the model's own tool arguments.
    const item = round === 1
      ? { type: "function_call", id: "fc_fictional", call_id: "call_fictional", name: tool.name, arguments: JSON.stringify({ action: "search", query: MARKER, limit: 3 }), status: "completed" }
      : { type: "message", id: "msg_fictional", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Fictional answer.", annotations: [] }] };
    response.writeHead(200, { "content-type": "text/event-stream" }).end(events([item]));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  const connect = Socket.prototype.connect;
  vi.spyOn(Socket.prototype, "connect").mockImplementation(function (...args) {
    const input = Array.isArray(args[0]) ? args[0][0] : args[0], host = input?.host ?? input?.hostname ?? args[1];
    if (host !== "127.0.0.1") { rejected.push(String(host)); throw Error("test_egress_denied"); }
    return connect.apply(this, args);
  });
  const native = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", (url, init) => {
    if (new URL(String(url?.url ?? url)).hostname !== "127.0.0.1") { rejected.push(String(url)); throw Error("test_global_fetch_denied"); }
    return native(url, init);
  });
  vi.doMock("../lib/continuity-lookup-pilot-state.mjs", async original => ({ ...await original(), readPilotPrivate: async path => path.endsWith("/state") ? state : (await original()).readPilotPrivate(path), pilotStatePath: root => `${root}/state` }));
  vi.doMock("../lib/continuity-lookup-ipc.mjs", async original => ({ ...await original(), verifyLookupPilotParent: async () => state,
    createLookupPilotIPC: async () => ({ brand: "lookup-faux-test-only-v1", testOnly: true,
      admit: async request => { const hold = { permitId: `permit-${state.slots[0].holds.length}`, payloadDigest: request.payloadDigest, consumed: false, revoked: false, settlement: null }; state.slots[0].holds.push(hold); return hold; },
      consume: async hold => { hold.consumed = true; }, settle: async (hold, outcome) => { hold.settlement = outcome; }, stop: async () => {}, close() {} }) }));
  vi.doMock("../lib/continuity-lookup-roles.mjs", async original => ({ ...await original(), verifyRoleRequest: async () => {} }));
  vi.doMock("../lib/continuity-lookup-preparation.mjs", async original => ({ ...await original(), verifyLookupPreparation: async () => {} }));
  ({ ROOT } = await import("../lib/continuity-lookup-roles.mjs"));
  faux = await import("../lib/continuity-lookup-faux-capability.mjs"); // Captures the loopback-only fetch.
  records = await import("../lib/continuity-lookup-slot-record.mjs");
  runner = await import("../lib/continuity-runner.mjs"); modules = await runner.productionModules(ROOT);
  const { loadTraces, makePlan } = await import("../lib/continuity-dataset.mjs");
  const { LOOKUP_MODE } = await import("../lib/continuity-lookup.mjs");
  const { armById, mergePatch } = await import("../lib/continuity-arms.mjs");
  plan = makePlan({ ...await loadTraces({ suite: "original" }), probeMode: LOOKUP_MODE, arms: ["native-lookup", "continuity-pack-cold"], profile: { reader: "openai-codex:gpt-6.1-sol", readerEffort: "high", judge: null } });
  arm = armById("continuity-pack-cold"); patch = mergePatch(arm.sessionConfig ?? {}, arm.probeConfig);
  soul = await readFile(new URL(`../fixtures/${plan.lookup.soul.file}`, import.meta.url));
}, 120000);

afterAll(async () => {
  try { server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); }
  finally {
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const path of mocked) vi.doUnmock(path);
    if (base) await rm(base, { recursive: true, force: true });
  }
}, 120000);

async function probe(name, userMessage) {
  const { lookupPilotWork, lookupOfflineBoundary } = await import("../lib/continuity-lookup-pilot-runtime.mjs");
  const cacheKey = `lk-fictional-${name}`, slotId = `slot-${name}`;
  const a = { outputRoot: base, index: 0, slotId, runId: "run-fictional", cacheKey, slot: { code: "R0", suite: "original" }, plan,
    roleRequest: { binding: { arm: arm.id } }, pilot: { registration: { codes: { R0: { path: ROOT } } }, descriptor: { deadlines: { deadlineMs: 600000 } } } };
  state = { schema: "continuity-lookup-faux-controller-v1", fauxEndpoint: `http://127.0.0.1:${port}/codex/responses`, stop: null, cursor: 0,
    deadlineAt: Date.now() + 600000, slots: [{ terminal: null, startedAt: Date.now(), holds: [] }] };
  const work = lookupPilotWork(a); await mkdir(work, { recursive: true, mode: 0o700 });
  await writeFile(join(work, "IDENTITY.md"), "You are a fictional test assistant."); await writeFile(join(work, "BENCHMARK-SOUL.md"), soul);
  const authPath = lookupOfflineBoundary({ plan, arm, work }).authPath;
  const configPatch = runner.lookupConfig(work, plan, runner.pilotDispatchConfig(patch), true);
  const config = modules.config.resolveJsonMonoAgentConfig({ json: runner.configJson({ work, authPath, model: plan.reader.model, effort: plan.reader.effort, tools: false, configPatch }), cwd: work });
  const send = await faux.createLookupFauxSend(a, { plan, arm, config });
  expect(faux.isFauxLookupSend(send)).toBe(true);
  const live = await runner.runLiveTurn({ modules, work, authPath, plan, mode: "paid", configPatch: patch, userMessage, clock: { value: new Date("2030-01-01T00:00:00Z") },
    conversationId: `fictional-${name}`, owner: "Morgan", pilot: { routeKind: "faux", authorization: { schema: "continuity-lookup-faux-authorization-v1" }, plan, arm, send },
    lookupSource: { availability: "unknown" }, lookupAnnotation: { availability: "annotated", value: MARKER } });
  return { a, live, send, arrivals: arrivals.get(cacheKey) };
}

it.each([["present", `Quick fictional check about ${MARKER}.`, true], ["absent", "Quick fictional check.", false]])("faux pilot witnesses initial presence from the first forwarded context only (%s)", async (name, userMessage, expected) => {
  const { a, live, send, arrivals: seen } = await probe(name, userMessage);
  expect(live.failureKind).toBeNull(); expect(live.text).toBe("Fictional answer.");
  // Two forwarded requests; the absent case's second context carries the marker in tool arguments.
  expect(seen.map(row => row.round)).toEqual([1, 2]); expect(seen.map(row => row.marker)).toEqual([expected, true]); expect(seen.every(row => row.consumed)).toBe(true);
  expect(state.slots[0].holds.map(h => h.payloadDigest)).toEqual(seen.map(row => row.digest));
  expect(live.lookup).toMatchObject({ initiallyPresent: expected, rounds: 2, calls: 1 });
  expect(live.lookup.initialContextBytes).toBeGreaterThan(0);
  expect(JSON.stringify(live.lookup)).not.toContain(MARKER);
  expect(() => send.observeForwarded(() => {})).toThrow("lookup_pilot_capability_invalid"); // set once by runLiveTurn
  // The private slot record round-trips through the production writer/validator, content-free.
  const record = await records.writeLookupSlotRecord(a, { ...live.lookup, witnessedRecovery: false });
  expect(await records.readLookupSlotRecord(a)).toEqual(record);
  expect(record).toMatchObject({ initiallyPresent: expected, rounds: 2, calls: 1, sourceAvailability: "unknown", witnessedRecovery: false });
  expect((await stat(records.lookupSlotRecordPath(a))).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(record)).not.toContain(MARKER);
  expect(rejected).toEqual([]);
}, 60000);
