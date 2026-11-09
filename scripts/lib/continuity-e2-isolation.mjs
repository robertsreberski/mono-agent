// Offline proof containment, including fixture children. Never installed by C1.
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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
export function installProofIsolation(env) {
  const saved = Object.fromEntries(PROOF_ENV_KEYS.map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  const connect = net.Socket.prototype.connect, fetch = globalThis.fetch, WebSocket = globalThis.WebSocket;
  net.Socket.prototype.connect = function (...args) {
    const input = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host = typeof input === "object" ? input?.host ?? input?.hostname : args[1];
    if (host !== "127.0.0.1" && host !== "::1") fail("E2_PROOF_EGRESS_REFUSED");
    return connect.apply(this, args);
  };
  globalThis.fetch = (url, init) => {
    const parsed = new URL(typeof url === "string" || url instanceof URL ? url : url.url);
    if (!["http:", "https:"].includes(parsed.protocol) || !["127.0.0.1", "[::1]"].includes(parsed.hostname)) fail("E2_PROOF_EGRESS_REFUSED");
    return fetch(url, { ...init, redirect: "error" });
  };
  globalThis.WebSocket = class { constructor() { fail("E2_PROOF_EGRESS_REFUSED"); } };
  syncBuiltinESMExports();
  return () => {
    net.Socket.prototype.connect = connect; globalThis.fetch = fetch; globalThis.WebSocket = WebSocket;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    syncBuiltinESMExports();
  };
}
