// Test-only transport floor, installed before any benchmark/SDK import.
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import dgram from "node:dgram";
import subprocess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
export function installE2NativeTransport(profile) {
  const refuse = () => { throw Error("test_external_transport_forbidden"); };
  const endpoint = new URL(profile.endpoint), key = (host, port) => `${host === "[::1]" ? "::1" : host}:${Number(port)}`;
  const targets = new Set([key(endpoint.hostname, endpoint.port)]);
  const allowed = (host, port) => ["127.0.0.1", "::1", "[::1]"].includes(host) && targets.has(key(host, port));
  const check = args => {
    let value = args[0]; if (Array.isArray(value)) value = value[0];
    const options = typeof value === "object" && value !== null ? value : { port: value, host: typeof args[1] === "string" ? args[1] : "localhost" };
    if (options.path || !allowed(options.host ?? options.hostname, options.port)) refuse();
  };
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    // Only listeners created by this realm may become additional owned targets.
    const options = typeof args[0] === "object" ? args[0] : { port: args[0], host: args[1] };
    if (!options || options.path || !["127.0.0.1", "::1"].includes(options.host)) refuse();
    let owned;
    this.prependOnceListener("listening", () => { const address = this.address(); if (address && typeof address === "object") { owned = key(address.address, address.port); targets.add(owned); } });
    this.once("close", () => { if (owned) targets.delete(owned); });
    return listen.apply(this, args);
  };
  for (const [target, key] of [[net.Socket.prototype, "connect"], [net, "connect"], [net, "createConnection"]]) {
    const original = target[key]; target[key] = function (...args) { check(args); return original.apply(this, args); };
  }
  tls.connect = refuse;
  const request = http.request;
  http.request = function (...args) {
    const first = args[0], url = typeof first === "string" || first instanceof URL ? new URL(first) : null;
    const options = url ? { hostname: url.hostname, port: url.port || 80, ...(typeof args[1] === "object" ? args[1] : {}) } : first;
    if (!options || !allowed(options.hostname ?? options.host, options.port ?? 80)) refuse();
    return request.apply(this, args);
  };
  http.get = function (...args) { const result = http.request(...args); result.end(); return result; };
  https.request = https.get = refuse; // This realm owns no TLS server.
  for (const target of [dns, dnsPromises, dns.Resolver.prototype, dnsPromises.Resolver.prototype]) {
    for (const name of new Set([...Object.getOwnPropertyNames(target), "lookup", "lookupService"])) {
      if (/^(?:resolve|reverse|lookup)/u.test(name) && typeof target[name] === "function") target[name] = refuse;
    }
  }
  // Node's numeric-IP listen path still calls lookup. Answer literals locally;
  // never delegate even a loopback lookup to the host resolver.
  const literal = (host, options) => {
    if (!["127.0.0.1", "::1"].includes(host)) refuse();
    const family = host === "::1" ? 6 : 4;
    return options?.all ? [{ address: host, family }] : { address: host, family };
  };
  dns.lookup = (host, options, callback) => {
    if (typeof options === "function") { callback = options; options = {}; }
    const result = literal(host, options);
    queueMicrotask(() => Array.isArray(result) ? callback(null, result) : callback(null, result.address, result.family));
  };
  dnsPromises.lookup = (host, options) => Promise.resolve(literal(host, options));
  dgram.createSocket = refuse;
  dgram.Socket = class { constructor() { refuse(); } };
  globalThis.WebSocket = class { constructor() { refuse(); } };
  const preload = pathToFileURL(profile.preload).href;
  const inherit = args => args.includes(preload) ? args : ["--import", preload, ...args];
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
    const original = subprocess[name];
    subprocess[name] = function (executable, args, ...rest) {
      if (!Array.isArray(args)) { if (args !== undefined) rest.unshift(args); args = []; }
      if (executable === process.execPath) return original.call(this, executable, inherit(args), ...rest);
      // Process-incarnation checks are the only non-Node subprocesses needed here.
      const identity = executable === "/bin/ps" && (args.length === 4 && args[0] === "-p" && /^\d+$/u.test(args[1]) && args[2] === "-o" && args[3] === "lstart=" || JSON.stringify(args) === '["-axo","pid=,pgid=,lstart=,stat="]')
        || ["ps", "/bin/ps"].includes(executable) && JSON.stringify(args) === '["-axo","pid=,pgid=,stat="]'
        || executable === "/usr/sbin/sysctl" && args.length === 2 && args[0] === "-n" && ["kern.bootsessionuuid", "kern.boottime"].includes(args[1]);
      if (!identity) refuse();
      return original.call(this, executable === "ps" ? "/bin/ps" : executable, args, ...rest);
    };
  }
  const fork = subprocess.fork;
  subprocess.fork = function (modulePath, args, options) {
    if (!Array.isArray(args)) { options = args ?? options; args = []; }
    options ??= {};
    if (options.execPath && options.execPath !== process.execPath) refuse();
    return fork.call(this, modulePath, args, { ...options, execArgv: inherit(options.execArgv ?? process.execArgv) });
  };
  subprocess.exec = subprocess.execSync = refuse;
  syncBuiltinESMExports();
}
