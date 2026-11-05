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
const preparing = process.argv[1].endsWith("continuity-lookup-preparation-child.mjs"), ports = new Set();
const evidence = { pid: process.pid, isMainThread, ppid: process.ppid, preparing, ci: Object.hasOwn(process.env, "CI"),
  credentialKeys: Object.keys(process.env).filter(k => /^(OPENAI|ANTHROPIC|GOOGLE|AZURE|AWS|PI_API|CODEX|CHATGPT)/u.test(k)), builds: 0, denied: 0, unexpected: 0 };
const record = () => fs.writeFileSync(join(settings.witnesses, `${process.pid}-${threadId}.json`), JSON.stringify(evidence), { mode: 0o600 });
const denied = () => { evidence.denied++; record(); throw Error("test_egress_denied"); };
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
const fork = childProcess.fork;
childProcess.fork = function (path, args, options) {
  const env = { ...options.env, LOOKUP_BOUNDARY_SETTINGS: settingsPath }; delete env.NODE_OPTIONS;
  const child = fork(path, args, { ...options, env, execArgv: ["--import", fileURLToPath(import.meta.url)] });
  return child;
};
const originalOpen = promises.open;
promises.open = async (path, ...args) => {
  if (typeof path === "string" && settings.forbiddenCredential && path === settings.forbiddenCredential) throw Error("test_credential_denied");
  return originalOpen(path, ...args);
};
syncBuiltinESMExports();
registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  if (url.endsWith("/scripts/lib/continuity-lookup-preparation-child.mjs")) return { ...loaded, source: String(loaded.source).replace(".catch(() => { process.exitCode", ".catch(error => { globalThis.__lookupPreparationFailed(error); process.exitCode") };
  if (!url.endsWith("/scripts/lib/continuity-runner.mjs")) return loaded;
  let source = String(loaded.source);
  // Synthetic registered checkouts intentionally have a stub app. Use the built
  // local runtime only for this offline preparation test, never for inference.
  // One source turn suffices for the process-boundary proof; full replay belongs
  // to the separate configured-flow proof, not this miniature fixture.
  source = source.replace("export async function productionModules(root) {", `export async function productionModules(root) { root = ${JSON.stringify(settings.runtimeRoot)};`);
  const signature = "  if (pilot) ({ mode, authPath } = lookupOfflineBoundary";
  source = source.replace(signature, `  globalThis.__lookupPreparationBuild();\n  trace = { ...trace, turns: trace.turns.slice(0, 1) };\n${signature}`);
  source = source.replace("onPhase = () => {}", "onPhase = globalThis.__lookupPreparationStage");
  return { ...loaded, source };
} });
globalThis.__lookupPreparationFailed = error => { evidence.failure = error.stack; record(); };
globalThis.__lookupPreparationStage = phase => { evidence.phase = phase.phase; record(); };
globalThis.__lookupPreparationBuild = () => { evidence.builds++; record(); };
if (preparing && isMainThread) {
  const send = process.send.bind(process); process.send = (message, ...args) => { evidence.lastSent = message.type; record(); return send(message, ...args); };
  process.on("message", message => { evidence.lastReceived = message.type ?? "assignment"; record(); });
  const cap = await import(pathToFileURL(join(settings.runtimeRoot, "scripts/lib/continuity-lookup-real-capability.mjs")));
  for (const [name, call] of [["verify", () => cap.verifyLookupRealAssignment({})], ["mint", () => cap.createLookupRealSend({}, {})]]) {
    try { await call(); throw Error("test_unexpected_authority"); } catch (error) { evidence[name] = error.code; }
  }
  if (settings.fault === "crash") process.exit(1);
  if (settings.fault === "hang") await new Promise(() => { setInterval(() => {}, 1000); });
}
record();
