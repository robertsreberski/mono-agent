// Test-only offline-boundary instrumentation; explicitly imported in every owned process.
import { isMainThread, threadId } from "node:worker_threads";
import * as fs from "node:fs";
import promises from "node:fs/promises";
import childProcess from "node:child_process";
import { Socket } from "node:net";
import { Server } from "node:http";
import { syncBuiltinESMExports, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
const settingsPath = process.env.LOOKUP_BOUNDARY_SETTINGS, settings = JSON.parse(fs.readFileSync(settingsPath));
const preparing = process.argv[1].endsWith("continuity-lookup-preparation-child.mjs"), ports = new Set(settings.allowedPorts ?? []);
const evidence = { pid: process.pid, isMainThread, ppid: process.ppid, preparing, ci: Object.hasOwn(process.env, "CI"),
  credentialKeys: Object.keys(process.env).filter(k => /^(OPENAI|ANTHROPIC|GOOGLE|AZURE|AWS|PI_API|CODEX|CHATGPT)/u.test(k)), builds: 0, credentialDenied: 0, denied: 0, unexpected: 0 };
const record = () => fs.writeFileSync(join(settings.witnesses, `${process.pid}-${threadId}.json`), JSON.stringify(evidence), { mode: 0o600 });
let checking = true;
const denied = () => { if (checking) evidence.denied++; else evidence.unexpected++; record(); throw Error("test_egress_denied"); };
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) { this.once("listening", () => ports.add(this.address().port)); return listen.apply(this, args); };
const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  const input = Array.isArray(args[0]) ? args[0][0] : args[0], options = typeof input === "object" ? input : { port: input, host: args[1] };
  if (options.host === "127.0.0.1" && ports.has(Number(options.port))) return connect.apply(this, args);
  return denied();
};
const native = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const parsed = new URL(url);
  if (parsed.hostname === "127.0.0.1" && ports.has(Number(parsed.port))) return native(url, init);
  return Promise.reject((() => { try { denied(); } catch (error) { return error; } })());
};
try { new Socket().connect({ host: "192.0.2.1", port: 1 }); } catch {}
await globalThis.fetch("https://fixture.invalid/").catch(() => {});
checking = false;
const fork = childProcess.fork;
childProcess.fork = function (path, args, options) {
  const env = { ...options.env, LOOKUP_BOUNDARY_SETTINGS: settingsPath }; delete env.NODE_OPTIONS;
  const child = fork(path, args, { ...options, env, execArgv: ["--import", fileURLToPath(import.meta.url)] });
  if (settings.fault === "listener-error" && String(path).endsWith("lookup-preparation-verifier.mjs")) queueMicrotask(() => child.emit("error", Error("fixture_listener_error")));
  return child;
};
const originalOpen = promises.open;
promises.open = async (path, ...args) => {
  if (typeof path === "string" && settings.forbiddenCredential && path === settings.forbiddenCredential) { evidence.credentialDenied++; record(); throw Error("test_credential_denied"); }
  return originalOpen(path, ...args);
};
syncBuiltinESMExports();
if (settings.forbiddenCredential) {
  try { await promises.open(settings.forbiddenCredential); throw Error("test_credential_denial_missing"); }
  catch (error) { if (error.message !== "test_credential_denied") throw error; }
}
registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  if (settings.gateOpen && url.endsWith("/continuity-lookup-pilot-entry.mjs")) return { ...loaded,
    source: 'export const LOOKUP_PILOT_REAL_ROUTE_ENABLED = true; export function assertLookupPilotEntry() {}' };
  if (settings.fault === "lease-home" && url.endsWith("/scripts/lib/continuity-lookup-pilot-runtime.mjs")) return { ...loaded,
    source: String(loaded.source).replace('if (!ok) throw Object.assign(new Error(code)', 'if (!ok) globalThis.__lookupRefusal(code, new Error().stack); if (!ok) throw Object.assign(new Error(code)') };
  if (url.endsWith("/scripts/lib/continuity-lookup-pilot-probe.mjs")) return { ...loaded,
    source: String(loaded.source).replace("    if (LOOKUP_GUARD_POLICY_REFUSALS.includes(trial.failure))", "    globalThis.__lookupTrial(trial);\n    if (LOOKUP_GUARD_POLICY_REFUSALS.includes(trial.failure))") };
  if (url.endsWith("/scripts/lib/continuity-lookup-preparation-child.mjs")) return { ...loaded,
    source: String(loaded.source).replace(".catch(async () => {", ".catch(async error => { globalThis.__lookupPreparationFailed(error);") };
  if (!url.endsWith("/scripts/lib/continuity-runner.mjs")) return loaded;
  let source = String(loaded.source);
  // Synthetic registered checkouts intentionally have a stub app. Use the built
  // local runtime only for this offline preparation test, never for inference.
  // One source turn suffices for the process-boundary proof; full replay belongs
  // to the separate configured-flow proof, not this miniature fixture.
  if (!settings.configured) source = source.replace("export async function productionModules(root) {", `export async function productionModules(root) { root = ${JSON.stringify(settings.runtimeRoot)};`);
  const signature = "  if (pilot) ({ mode, authPath } = lookupOfflineBoundary";
  source = source.replace(signature, `  globalThis.__lookupPreparationBuild(trace.turns.length);\n  ${(settings.configured || settings.fullReplay) ? "" : "trace = { ...trace, turns: trace.turns.slice(0, 1) };"}\n${signature}`);
  source = source.replace("onPhase = () => {}", "onPhase = globalThis.__lookupPreparationStage");
  source = source.replace("  let runtime, harness, closing;", "  globalThis.__lookupOwnership(modules, work, homeDir);\n  let runtime, harness, closing;");
  if (settings.leaveLease && preparing) source = source.replace("export async function buildCheckpoint(", "async function originalCheckpoint(") + `
    export async function buildCheckpoint(options) { const checkpoint = await originalCheckpoint(options); await globalThis.__lookupKeepLease(options.modules, checkpoint.work); return checkpoint; }`;
  return { ...loaded, source };
} });
globalThis.__lookupRefusal = (code, stack) => { evidence.refusal = {code, stack}; record(); };
globalThis.__lookupTrial = trial => { evidence.trialFailure = trial.failure; record(); };
globalThis.__lookupPreparationFailed = error => { evidence.failure = error.stack; record(); };
globalThis.__lookupPreparationStage = phase => { evidence.phase = phase.phase; if (phase.phase === "replay-turn-completion") evidence.turns = (evidence.turns ?? 0) + 1; record(); };
globalThis.__lookupOwnership = (modules, work, homeDir) => {
  const owner = JSON.parse(fs.readFileSync(join(modules.coordinator.agentRootLeasePath(work, homeDir), "owner.json")));
  (evidence.leaseOwners ??= []).push(owner.pid); record();
};
globalThis.__lookupKeepLease = async (modules, work) => {
  const homeDir = new URL("../lease-home/", `file://${work}/`).pathname.replace(/\/$/u, "");
  globalThis.__lookupLeaseKeeper = await modules.coordinator.acquireAgentRootOwnership(work, {homeDir});
  evidence.leftoverOwner = JSON.parse(fs.readFileSync(join(modules.coordinator.agentRootLeasePath(work, homeDir), "owner.json"))).pid; record();
};
process.once("exit", code => { evidence.exitCode = code; record(); });
globalThis.__lookupPreparationBuild = turns => { evidence.builds++; evidence.registeredTurns = turns; record(); };
if (preparing && isMainThread) {
  const send = process.send.bind(process); process.send = (message, ...args) => { evidence.lastSent = message.type; if (message.type === "prepared" && settings.linger) { setInterval(() => {}, 1000); evidence.lingering = true; } record(); return send(message, ...args); };
  process.on("message", message => { evidence.lastReceived = message.type ?? "assignment"; record();
    if (message.pilot && settings.fault === "prepare-failure") message.roleRequest.binding.id = "fictional-invalid";
    if (settings.gateOpen && message.pilot) void (async () => {
      const root = message.pilot.registration.codes[message.slot.code].path;
      const ipc = await import(pathToFileURL(join(root, "scripts/lib/continuity-lookup-ipc.mjs")));
      const faux = await import(pathToFileURL(join(root, "scripts/lib/continuity-lookup-faux-capability.mjs")));
      for (const [name, call] of [["fauxVerify", () => ipc.verifyLookupPilotParent(message)], ["fauxMint", () => faux.createLookupFauxSend(message, {})]]) {
        try { await call(); evidence[name] = "unexpected"; } catch (error) { evidence[name] = error.code; }
      }
      evidence.gateOpen = true; record();
    })();
  });
  const cap = await import(pathToFileURL(join(settings.runtimeRoot, "scripts/lib/continuity-lookup-real-capability.mjs")));
  for (const [name, call] of [["verify", () => cap.verifyLookupRealAssignment({})], ["mint", () => cap.createLookupRealSend({}, {})]]) {
    try { await call(); throw Error("test_unexpected_authority"); } catch (error) { evidence[name] = error.code; }
  }
  if (settings.fault === "crash") process.exit(1);
  if (settings.fault === "hang") await new Promise(() => { setInterval(() => {}, 1000); });
}
record();

if (settings.fault === "verifier-close" && process.argv[1].endsWith("lookup-preparation-verifier.mjs")) process.exit(0);
if (settings.fault === "driver-close" && process.argv[1].endsWith("lookup-preparation-driver.mjs")) process.exit(0);
