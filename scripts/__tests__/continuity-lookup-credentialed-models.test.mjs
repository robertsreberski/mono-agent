import { afterAll, beforeAll, expect, it, vi } from "vitest";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Socket } from "node:net";
import workers from "node:worker_threads";
import { syncBuiltinESMExports, createRequire } from "node:module";
import { userInfo, tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { Session } from "node:inspector/promises";
import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import { credentialedHomeCanary } from "./fixtures/lookup-credentialed-home.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const sha = value => createHash("sha256").update(value).digest("hex");
const ACCOUNT = "FICTIONAL-ACCOUNT-NOT-REAL", SALT = "fictional-unit-salt";
const commitment = account => sha(`mono-agent/lookup-pilot/account-v1\0${SALT}\0${account}`);
const require = createRequire(new URL("../../packages/turn/package.json", import.meta.url));
const { Agent, getGlobalDispatcher, setGlobalDispatcher } = require("undici");
const mocked = ["roles", "pilot", "authorization", "pilot-state", "ipc", "pilot-entry", "preparation"].map(name => `../lib/continuity-lookup-${name}.mjs`);
let oldStackFormatter, coverage, sdkFetchOffset;
const knownRefreshFunctions = new Set();
let base, guard, server, agent, oldDispatcher, modules, runner, cap, current, state, permit, binding, schedule;
let arrivals = [], nativeAttempts = 0, globalCalls = 0, forbiddenConnections = 0, refreshAttempts = 0;
const handle = Object.freeze({});
const nativeWorker = workers.Worker;

beforeAll(async () => {
  // Opt out of the root test setup's account-home mocks: the real app must not
  // need them when openHarness owns an explicit private lease-home.
  vi.doUnmock("../../packages/app/src/host/account-home.js");
  vi.doUnmock("../../packages/app/dist/host/account-home.js");
  vi.resetModules();
  const temp = fs.realpathSync(tmpdir()), homeRelative = relative(fs.realpathSync(userInfo().homedir), temp);
  expect(homeRelative.startsWith("..") || isAbsolute(homeRelative)).toBe(true);
  base = await mkdtemp(join(temp, "lookup-credentialed-"));
  await mkdir(join(base, "credential")); await mkdir(join(base, "evidence"));
  const credential = join(base, "credential", "auth.json");
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const access = `${encode({alg: "none"})}.${encode({exp: Math.floor(Date.now() / 1000) + 86400, "https://api.openai.com/auth": {chatgpt_account_id: ACCOUNT}})}.FAKE-TEST-SIGNATURE`;
  await writeFile(credential, JSON.stringify({"openai-codex": {type: "oauth", access, refresh: "FAKE-TEST-REFRESH-NOT-REAL", expires: Date.now() + 86400000}}), {mode: 0o600});
  server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks), bytes = request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw;
      const body = JSON.parse(bytes);
      // The authority graph is unit-only; transport/credential/serializer paths are real.
      expect(state.slots[0].holds.at(-1)).toMatchObject({consumed: true, payloadDigest: sha(bytes)});
      arrivals.push({account: request.headers["chatgpt-account-id"], cache: body.prompt_cache_key,
        session: request.headers["session-id"], request: request.headers["x-client-request-id"], method: request.method, path: request.url});
      if (current.status === 503) { response.writeHead(503, {"content-type": "application/json"}).end('{"error":{"message":"fictional retryable failure"}}'); return; }
      const item = {type: "message", id: "msg_fictional", role: "assistant", status: "completed", content: [{type: "output_text", text: "Fictional answer.", annotations: []}]};
      const events = [
        {type: "response.output_item.added", output_index: 0, item: {...item, content: []}},
        {type: "response.content_part.added", output_index: 0, content_index: 0, item_id: item.id, part: {type: "output_text", text: "", annotations: []}},
        {type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: "Fictional answer."},
        {type: "response.output_item.done", output_index: 0, item},
        {type: "response.completed", response: {id: "fictional-response", status: "completed", output: [item], service_tier: "default", usage: {input_tokens: 10, output_tokens: 5, output_tokens_details: {reasoning_tokens: 0}}}},
      ];
      response.writeHead(200, {"content-type": "text/event-stream"}).end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
    } catch (error) { current.listenerError = error; response.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const connect = Socket.prototype.connect;
  vi.spyOn(Socket.prototype, "connect").mockImplementation(function (...args) {
    let options = args[0]; if (Array.isArray(options)) options = options[0];
    if (options?.host !== "127.0.0.1" || Number(options?.port) !== server.address().port) { forbiddenConnections++; throw Error("test_egress_denied"); }
    return connect.apply(this, args);
  });
  vi.stubGlobal("WebSocket", class { constructor() { throw Error("test_websocket_denied"); } });
  agent = new Agent(); oldDispatcher = getGlobalDispatcher();
  setGlobalDispatcher({dispatch(options, handler) {
    if (String(options.origin) !== "https://chatgpt.com" || options.path !== "/backend-api/codex/responses") {
      refreshAttempts++; throw Error("test_refresh_or_egress_denied");
    }
    nativeAttempts++;
    return agent.dispatch({...options, origin}, handler);
  }});
  // CI clearing is confined to this denied-egress in-process unit, never a production fork.
  for (const key of Object.keys(process.env)) if (/_API_KEY$|_TOKEN$|^CI$|^CONTINUITY_DEBUG$/u.test(key)) vi.stubEnv(key, undefined);
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) vi.stubEnv(key, join(base, "home"));
  await mkdir(join(base, "home"));
  // No real authority/registry: only this boundary is mocked, not the branded factory.
  const proc = new Proxy(process, {get: (target, key) => key === "connected" ? true : Reflect.get(target, key, target)});
  vi.doMock("node:process", () => ({default: proc}));
  vi.doMock("../lib/continuity-lookup-roles.mjs", () => ({ROOT, roleBinding: () => binding, verifyRoleRequest: async () => {}}));
  vi.doMock("../lib/continuity-lookup-pilot.mjs", () => ({validateLookupPilotRegistration: async () => {}}));
  vi.doMock("../lib/continuity-lookup-pilot-entry.mjs", () => ({assertLookupPilotEntry() {}}));
  vi.doMock("../lib/continuity-lookup-preparation.mjs", () => ({verifyLookupPreparation: async () => {}}));
  vi.doMock("../lib/continuity-lookup-authorization.mjs", () => ({LOOKUP_AUTHORIZATION_SCHEMA: "continuity-lookup-pilot-authorization-v1",
    validateLookupAuthorization: async () => handle, verifyLookupConsumption: async () => {},
    lookupAuthorizationBindsPilot: received => received === handle,
    lookupAuthorizationMatchesAccount: (received, account) => received === handle && commitment(account) === current.commitment}));
  vi.doMock("../lib/continuity-lookup-pilot-state.mjs", () => ({LOOKUP_REAL_CONTROLLER: "continuity-lookup-controller-v1", readPilotPrivate: async () => state,
    pilotStatePath: root => `${root}/state`, samePilot: (a, b) => JSON.stringify(a) === JSON.stringify(b), lookupPilotSchedule: () => schedule}));
  vi.doMock("../lib/continuity-process-identity.mjs", () => ({lookupProcessStartIdentity: pid => pid === process.ppid ? "parent" : "child"}));
  vi.doMock("../lib/continuity-lookup-ipc.mjs", () => ({createLookupPilotIPC: async () => permit}));
  const policy = {root: ROOT, home: userInfo().homedir, credential, evidence: join(base, "evidence")};
  guard = credentialedHomeCanary(policy); guard.canaries();
  workers.Worker = class extends nativeWorker {
    constructor(entry, options = {}) {
      const preload = new URL("./fixtures/lookup-credentialed-home.mjs", import.meta.url);
      preload.searchParams.set("canary", Buffer.from(JSON.stringify(policy)).toString("base64url"));
      super(entry, {...options, execArgv: [...(options.execArgv ?? process.execArgv), "--import", preload.href]});
    }
  }; syncBuiltinESMExports();
  sdkFetchOffset = (await readFile(new URL("../../packages/turn/node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js", import.meta.url), "utf8")).indexOf("response = await (options?.fetch");
  expect(sdkFetchOffset).toBeGreaterThan(0);
  cap = await import("../lib/continuity-lookup-real-capability.mjs"); // Captures native fetch, before sentinel.
  runner = await import("../lib/continuity-runner.mjs"); modules = await runner.productionModules(ROOT);
  const {accountHomeDirectory} = await import("../../packages/app/dist/host/account-home.js");
  expect(accountHomeDirectory()).toBe(userInfo().homedir);
  vi.stubGlobal("fetch", () => { globalCalls++; throw Error("test_global_fetch_denied"); });
  // Vitest sourcemap diagnostics are not application I/O. Avoid .map reads without warming or substituting SDK code.
  expect(() => globalThis.fetch("https://example.invalid/denied-canary")).toThrow("test_global_fetch_denied"); globalCalls = 0;
  expect(() => getGlobalDispatcher().dispatch({origin: "https://example.invalid", path: "/denied-canary"}, {})).toThrow("test_refresh_or_egress_denied"); refreshAttempts = 0;
  coverage = new Session(); coverage.connect();
  await coverage.post("Profiler.enable"); await coverage.post("Profiler.startPreciseCoverage", {callCount: true, detailed: true});
  oldStackFormatter = Error.prepareStackTrace; Error.prepareStackTrace = (error, frames) => `${error.name}: ${error.message}\n${frames.map(frame => `    at ${frame}`).join("\n")}`;
}, 120000);

afterAll(async () => {
  try {
    await coverage?.post("Profiler.stopPreciseCoverage"); coverage?.disconnect();
    if (oldDispatcher) setGlobalDispatcher(oldDispatcher);
    await agent?.close(); server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    guard?.save();
    const metrics = process.env.LOOKUP_CREDENTIALED_METRICS_FILE;
    if (metrics) await writeFile(metrics, JSON.stringify({parent: guard?.result(), workers: base ? await Promise.all((await readdir(join(base, "evidence"))).map(async name => [name, JSON.parse(await readFile(join(base, "evidence", name)))])) : []}));
    if (guard) { expect(guard.result().denied).toEqual([]); expect(guard.result().nonModuleReads).toEqual([]); }
  } finally {
    guard?.restore(); Error.prepareStackTrace = oldStackFormatter;
    workers.Worker = nativeWorker; syncBuiltinESMExports();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    for (const path of mocked) vi.doUnmock(path); vi.doUnmock("node:process"); vi.doUnmock("../lib/continuity-process-identity.mjs");
    if (base) await rm(base, {recursive: true, force: true});
  }
}, 120000);

it.each([[200, false], [503, false], [200, true]])("credentialed configured harness uses the installed SDK once (status=%s, mismatched account=%s)", async (status, mismatch) => {
  const {digest} = await import("../lib/continuity-dataset.mjs");
  const {lookupPilotWork} = await import("../lib/continuity-lookup-pilot-runtime.mjs");
  const id = `slot-${status}-${mismatch}`;
  current = {status, commitment: commitment(mismatch ? "FICTIONAL-OTHER-ACCOUNT" : ACCOUNT)};
  binding = {id: "native", code: "R0", arm: "native-lookup"};
  const slot = {slotId: id, roleId: "native", code: "R0", suite: "holdout"}; schedule = [slot];
  const common = {corpora: [{suite: "holdout"}]}, build = {fictional: true};
  const a = {pilot: {registration: {roles: [binding], common, codes: {R0: {path: ROOT, build}}}, descriptor: {capUSD: 100, deadlines: {deadlineMs: 600000}}},
    authorization: {schema: "continuity-lookup-pilot-authorization-v1", authorizationPath: join(base, "absent-authorization"), registrationPath: join(base, "absent-registration"), registrationSha256: "a".repeat(64), credentialPath: join(base, "credential", "auth.json"), controllerRoot: ROOT, outputRoot: base},
    outputRoot: base, epoch: "epoch-fictional", runId: "run-fictional", index: 0, cacheKey: `assigned-${status}-${mismatch}`, slotId: id, slot,
    plan: {judge: null}, roleRequest: {binding, common, build}};
  state = {schema: "continuity-lookup-controller-v1", recovery: false, cursor: 0, stop: null, binding: digest(a.pilot), runId: a.runId, epoch: a.epoch,
    deadlineAt: Date.now() + 600000, controller: {pid: process.ppid, startIdentity: "parent"}, cacheKeysUnique: true, schedule,
    slots: [{terminal: null, slotId: id, cacheKey: a.cacheKey, worker: {pid: process.pid, startIdentity: "child"}, ready: true, startedAt: Date.now(), holds: []}]};
  permit = Object.freeze({brand: "lookup-controller-v1", testOnly: false, pilot: true,
    admit: vi.fn(async request => { const hold = {permitId: "fictional-permit", payloadDigest: request.payloadDigest, consumed: false, revoked: false, settlement: null}; state.slots[0].holds.push(hold); return hold; }),
    consume: vi.fn(async hold => { hold.consumed = true; }), settle: vi.fn(async () => {}), stop: vi.fn(async () => {}), close: vi.fn()});
  const work = lookupPilotWork(a); await mkdir(work, {recursive: true});
  await writeFile(join(work, "IDENTITY.md"), "You are a fictional test assistant.");
  await writeFile(join(work, "SOUL.md"), "Give a fictional answer.");
  const arm = {id: binding.arm, midCheckpoint: null, ledgerUpkeep: false};
  const configPatch = {runtime: {compaction: {enabled: false}, retry: {primaryAttempts: 1}}, providers: {piNative: {transport: "sse", piMaxRetries: 0}}, context: {soulPath: join(work, "SOUL.md")}};
  const input = {work, authPath: a.authorization.credentialPath, model: "openai-codex:gpt-6.1-sol", effort: "high", tools: false, configPatch, clock: {value: new Date("2030-01-01T00:00:00Z")}};
  const config = modules.config.resolveJsonMonoAgentConfig({json: runner.configJson(input), cwd: work});
  const beforeCredential = await readFile(a.authorization.credentialPath);
  const send = await cap.createLookupRealSend(a, {plan: a.plan, arm, config});
  expect(cap.isRealLookupSend(send)).toBe(true); expect(cap.isRealLookupDecorator(send.decorator)).toBe(true);
  const start = nativeAttempts, arrived = arrivals.length;
  let opened, result;
  try {
    guard.constructed();
    opened = await runner.openHarness({...input, modules, pilot: {routeKind: "real", plan: a.plan, arm, send}, route: () => ({piModelsDecorator: send.decorator})});
    result = await opened.harness.run({conversationId: `fictional-${id}`, userMessage: "Give a fictional answer.", abortSignal: AbortSignal.timeout(30000), captureSpeakerKind: "human-turn", metadata: {source: "web"}, sender: {displayName: "Morgan"}});
  } finally { await opened?.close(); }
  const executed = (await coverage.post("Profiler.takePreciseCoverage")).result;
  const calls = (suffix, names) => executed.filter(script => script.url.endsWith(suffix)).flatMap(script => script.functions).filter(fn => names.includes(fn.functionName)).reduce((sum, fn) => sum + fn.ranges[0].count, 0);
  const sdkRanges = executed.filter(script => script.url.endsWith("/api/openai-codex-responses.js")).flatMap(script => script.functions).flatMap(fn => fn.ranges).filter(range => range.startOffset <= sdkFetchOffset && range.endOffset > sdkFetchOffset).sort((a, b) => (a.endOffset-a.startOffset) - (b.endOffset-b.startOffset));
  for (const fn of executed.filter(script => script.url.endsWith("/auth/oauth/openai-codex.js")).flatMap(script => script.functions)) if (["refresh", "refreshOpenAICodexToken", "refreshAccessToken"].includes(fn.functionName)) knownRefreshFunctions.add(fn.functionName);
  const refreshFunctions = knownRefreshFunctions.size;
  const proof = {sdkFetchCalls: sdkRanges[0]?.count, refreshFunctions, nativeAttempts: nativeAttempts - start, refresh: calls("/auth/oauth/openai-codex.js", ["refresh", "refreshOpenAICodexToken", "refreshAccessToken"]),
    oauth: calls("/auth/oauth/openai-codex.js", ["toAuth"]), credential: calls("/providers/pi/auth.js", ["readCredential"]), models: calls("/execution/pi/run.js", ["buildRunModels"])};
  if (process.env.LOOKUP_CREDENTIALED_METRICS_FILE) await writeFile(join(base, "evidence", `result-${id}.json`), JSON.stringify({result, proof}));
  expect(proof.sdkFetchCalls).toBe(1); expect(proof.refreshFunctions).toBeGreaterThanOrEqual(3);
  expect(proof.refresh).toBe(0); expect(proof.oauth).toBeGreaterThan(0); expect(proof.credential).toBeGreaterThan(0); expect(proof.models).toBeGreaterThan(0);
  if (current.listenerError) throw current.listenerError;
  expect(await readFile(a.authorization.credentialPath)).toEqual(beforeCredential);
  expect(cap.isRealLookupDecorator(send.decorator)).toBe(false); // Actual one-shot decorator ran.
  expect(permit.admit).toHaveBeenCalledTimes(1); expect(permit.consume).toHaveBeenCalledTimes(1);
  expect(nativeAttempts - start).toBe(mismatch ? 0 : 1);
  expect(arrivals.length - arrived).toBe(mismatch ? 0 : 1);
  if (mismatch) expect(permit.stop).toHaveBeenCalledExactlyOnceWith("lookup_account_mismatch");
  else {
    expect(permit.stop).not.toHaveBeenCalled();
    expect(arrivals.at(-1)).toEqual({account: ACCOUNT, cache: a.cacheKey, session: a.cacheKey, request: a.cacheKey, method: "POST", path: "/backend-api/codex/responses"});
    expect(commitment(arrivals.at(-1).account)).toBe(current.commitment);
    expect(permit.settle).toHaveBeenCalledTimes(1);
    expect(permit.settle.mock.calls[0][1].kind).toBe(status === 200 ? "settled" : "lost");
  }
  if (status === 200 && !mismatch) { expect(result.failure).toBeFalsy(); expect(result.text).toBe("Fictional answer."); }
  else expect(result.failure).toBeTruthy();
  expect(globalCalls).toBe(0); expect(forbiddenConnections).toBe(0); expect(refreshAttempts).toBe(0);
  const home = guard.result(); expect(home.credentialReads).toBeGreaterThan(0); expect(home.credentialWrites).toBe(0); expect(home.denied).toEqual([]); expect(home.constructed).toBe(true); expect(home.nonModuleReads).toEqual([]);
  const workerFiles = (await readdir(join(base, "evidence"))).filter(name => name.startsWith("home-") && name !== "home-0.json");
  expect(workerFiles.length).toBeGreaterThan(0);
  for (const name of workerFiles) { const proof = JSON.parse(await readFile(join(base, "evidence", name))); expect(proof).toMatchObject({constructed: true, canaries: 3, denied: [], credentialWrites: 0, nonModuleReads: []}); }
}, 120000);
