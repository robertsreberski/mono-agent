// Pure observation/denial preload. No source rewriting, fake Models, entrypoint
// replacement, checkpoint substitution, SDK copies or resolution redirects.
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";
import { installLookupProofScope } from "../../__tests__/fixtures/lookup-proof-scope.mjs";
const encoded = new URL(import.meta.url).searchParams.get("policy");
if (!encoded) throw Error("lookup_configured_proof_policy_required");
const policy = JSON.parse(Buffer.from(encoded, "base64url").toString());
const loaded = new Map(), events = [], forks = [], httpCalls = [], startedAt = Date.now();
let peakRSSBytes = 0, sentinel = false, globalFetchCalls = 0;
const snapshot = () => ({role: policy.role, home: process.env.HOME, xdg: [process.env.XDG_CACHE_HOME, process.env.XDG_CONFIG_HOME, process.env.XDG_DATA_HOME, process.env.XDG_STATE_HOME], git: [process.env.GIT_CONFIG_GLOBAL, process.env.GIT_CONFIG_NOSYSTEM], startedAt, at: Date.now(), elapsedMs: Date.now() - startedAt, httpCalls, peakRSSBytes: Math.max(peakRSSBytes, process.resourceUsage().maxRSS * 1024), events, forks, loaded: [...loaded.values()], globalFetchSentinel: sentinel, globalFetchCalls});
policy.preloadUrl = new URL(import.meta.url).href.split("?")[0];
policy.onFork = ({command, args, options, role}) => {
  if (policy.role !== "controller" || args.length || !/^[-a-zA-Z0-9]+$/u.test(role)) throw Error("test_nested_probe_denied");
  const expectedHome = join(policy.outputRoot, "work", options.env.HOME.split("/").at(-2), `${role}-home`);
  if (options.env.HOME !== expectedHome) throw Error("test_fork_home_denied");
  const imported = [];
  for (let i = 0; i < process.execArgv.length; i++) if (process.execArgv[i] === "--import") imported.push("--import", process.execArgv[++i]);
  if (JSON.stringify(options.execArgv) !== JSON.stringify(imported)) throw Error("test_fork_argv_denied");
  const state = JSON.parse(fs.readFileSync(join(policy.outputRoot, "lookup-pilot-controller.json"), "utf8")), slotId = options.env.HOME.split("/").at(-2), slot = state.slots.find(s => s.slotId === slotId);
  if (!slot || (role === "probe" && (!slot.preparation?.exited || !slot.preparation.treeDigest || slot.worker !== null))) throw Error("test_probe_before_preparation_exit");
  const manifestPath = join(policy.outputRoot, "work", slotId, "checkpoint/preparation.json");
  const manifest = role === "probe" ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
  forks.push({command, args, role, slotId, at: Date.now(), preparation: slot.preparation, conversationId: manifest?.conversationId ?? null, work: join(dirname(manifestPath), "work"), envKeys: Object.keys(options.env).sort()});
};
const scope = installLookupProofScope(policy), processCanaries = scope.canaries();
globalThis[Symbol.for("lookup.proof.scope")] = scope;
// Pass through the loader untouched; hash the bytes actually loaded. Loader/native
// I/O itself is not claimed to be mediated by the JavaScript fs wrappers.
registerHooks({load(url, context, next) {
  const result = next(url, context);
  if (url.startsWith("file:") && result.source != null) loaded.set(url, {url, format: result.format, sha256: createHash("sha256").update(result.source).digest("hex")});
  return result;
}});
const originals = [], observe = (object, name) => {
  if (typeof object[name] !== "function") return;
  const original = object[name]; originals.push(() => {object[name] = original;});
  object[name] = function (...args) {
    const stack = new Error().stack, path = typeof args[0] === "string" ? args[0] : null;
    for (const phase of ["buildCheckpoint", "restorePreparation", "installTree", "runProbe"]) if (stack.includes(phase) && path && path.startsWith(policy.ownedRoot)) {
      if (phase === "buildCheckpoint" && policy.role === "probe") throw Error("test_probe_build_checkpoint_denied");
      const entry = {phase, api: name, path, at: Date.now()};
      if (!events.some(e => e.phase === phase && e.path === path && e.api === name)) events.push(entry);
    }
    return original.apply(this, args);
  };
};
for (const object of [fs, fsp]) for (const method of ["mkdir", "cp", "rm", "writeFile", "rename", "open", "readFile"]) observe(object, method);
syncBuiltinESMExports();
// Faux capability captures its native transport as part of normal dynamic probe
// imports, before runProbe starts its own History listener. Install the global
// fetch sentinel at that listener, not by pre-importing/warming any SDK.
import net from "node:net";
import { Server as HttpServer } from "node:http";
const emit = HttpServer.prototype.emit;
HttpServer.prototype.emit = function (event, ...args) {
  if (event === "request" && policy.role !== "controller") {
    const chunks = [], request = args[0];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {try {
      const body = JSON.parse(Buffer.concat(chunks));
      for (const rpc of [body].flat()) if (rpc.method) httpCalls.push({method: rpc.method, tool: rpc.params?.name ?? null, action: rpc.params?.arguments?.action ?? null, port: this.address()?.port, at: Date.now()});
    } catch { /* Observe JSON RPC only; no parsing or transport substitution. */ }});
  }
  return emit.call(this, event, ...args);
};
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  this.prependOnceListener("listening", () => {
    scope.files.constructed();
    if (!sentinel) {
      globalThis.fetch = () => {globalFetchCalls++; throw Error("test_global_fetch_denied");}; sentinel = true;
      try {globalThis.fetch();} catch (error) {if (error.message !== "test_global_fetch_denied") throw error;}
      globalFetchCalls = 0;
    }
  });
  return listen.apply(this, args);
};
const save = () => {peakRSSBytes = Math.max(peakRSSBytes, process.resourceUsage().maxRSS * 1024); scope.save({...snapshot(), processCanaries});};
const sampler = setInterval(save, 100); sampler.unref();
if (!isMainThread) scope.files.constructed();
process.on("exit", save);
save();
