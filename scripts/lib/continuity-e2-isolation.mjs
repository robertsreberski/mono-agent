// Offline proof containment, including fixture children. Never installed by C1.
import net from "node:net";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isGuardedNativeDispatch } from "./continuity-guarded-real-capability.mjs";
import { fail } from "./continuity-observation-input.mjs";

export const PROOF_ENV_KEYS = Object.freeze(["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "TMPDIR", "TMP", "TEMP"]);
export async function proofEnvironment(base) {
  const env = {};
  for (const key of PROOF_ENV_KEYS) {
    env[key] = join(base, key.toLowerCase());
    await mkdir(env[key], { recursive: true, mode: 0o700 });
  }
  return env;
}
const loopback = host => host === "127.0.0.1" || host === "::1";
const dnsMethod = name => /^(?:lookup(?:Service)?|resolve[A-Za-z0-9]*|reverse)$/.test(name);
// Even a literal passed to native resolve/reverse can issue an external DNS
// query. Answer only address lookups locally; unsupported record types refuse.
function localDns(name, args) {
  const host = args[0];
  if (!loopback(host)) fail("E2_PROOF_EGRESS_REFUSED");
  const family = host === "::1" ? 6 : 4, options = args[1];
  if (name === "lookup") return typeof options === "object" && options?.all ? [[{ address: host, family }]] : [host, family];
  const type = name === "resolve" ? options ?? "A" : name.slice(7).toUpperCase();
  if (type === "ANY") return [[{ address: host, type: family === 6 ? "AAAA" : "A", ttl: 0 }]];
  if (!(type === "4" || type === "A") || family !== 4) {
    if (!(type === "6" || type === "AAAA") || family !== 6) fail("E2_PROOF_EGRESS_REFUSED");
  }
  return [[typeof options === "object" && options?.ttl ? { address: host, ttl: 0 } : host]];
}
export function installProofIsolation(env) {
  const saved = Object.fromEntries(PROOF_ENV_KEYS.map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  const connect = net.Socket.prototype.connect, fetch = globalThis.fetch, WebSocket = globalThis.WebSocket;
  const createSocket = dgram.createSocket, DatagramSocket = dgram.Socket, resolvers = [];
  net.Socket.prototype.connect = function (...args) {
    const input = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host = typeof input === "object" ? input?.host ?? input?.hostname : args[1];
    // Undici carries path: undefined for TCP; assigned path values select Unix sockets.
    if (typeof input === "string" || input && typeof input === "object" && (input.path !== undefined || input.socketPath !== undefined)
      || !loopback(host) && !isGuardedNativeDispatch("e2-validation")) fail("E2_PROOF_EGRESS_REFUSED");
    return connect.apply(this, args);
  };
  globalThis.fetch = (url, init) => {
    const parsed = new URL(typeof url === "string" || url instanceof URL ? url : url.url);
    if (!["http:", "https:"].includes(parsed.protocol) || !["127.0.0.1", "[::1]"].includes(parsed.hostname)) fail("E2_PROOF_EGRESS_REFUSED");
    return fetch(url, { ...init, redirect: "error" });
  };
  globalThis.WebSocket = class { constructor() { fail("E2_PROOF_EGRESS_REFUSED"); } };
  dgram.createSocket = () => fail("E2_PROOF_EGRESS_REFUSED");
  dgram.Socket = class { constructor() { fail("E2_PROOF_EGRESS_REFUSED"); } };
  for (const [target, promise] of [[dns, false], [dns.Resolver.prototype, false], [dnsPromises, true], [dnsPromises.Resolver.prototype, true]]) {
    for (const name of Object.getOwnPropertyNames(target).filter(name => dnsMethod(name) && typeof target[name] === "function")) {
      resolvers.push([target, name, Object.getOwnPropertyDescriptor(target, name)]);
      const original = target[name];
      target[name] = promise ? async (...args) => {
        if (isGuardedNativeDispatch("e2-validation")) return original.apply(target, args);
        const result = localDns(name, args);
        return name === "lookup" && !(typeof args[1] === "object" && args[1]?.all) ? { address: result[0], family: result[1] } : result[0];
      } : (...args) => {
        if (isGuardedNativeDispatch("e2-validation")) return original.apply(target, args);
        const callback = args.at(-1), input = args.slice(0, -1), result = localDns(name, input);
        if (typeof callback !== "function") fail("E2_PROOF_EGRESS_REFUSED");
        queueMicrotask(() => callback(null, ...result));
      };
    }
  }
  syncBuiltinESMExports();
  return () => {
    net.Socket.prototype.connect = connect; globalThis.fetch = fetch; globalThis.WebSocket = WebSocket;
    dgram.createSocket = createSocket; dgram.Socket = DatagramSocket;
    for (const [target, name, descriptor] of resolvers) Object.defineProperty(target, name, descriptor);
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    syncBuiltinESMExports();
  };
}
