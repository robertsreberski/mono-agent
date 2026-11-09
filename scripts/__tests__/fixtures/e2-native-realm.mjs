// Test-only Node preload: pin a fictional OS account, mock build attestation only,
// and replace the sole guarded provider fetch with an owned HTTP loopback.
import os from "node:os";
import { installE2NativeTransport } from "./e2-native-transport.mjs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
export async function installE2NativeRealm(profile) {
  const user = os.userInfo(), actualHome = user.homedir;
  if (!profile.home || !profile.root || !profile.endpoint?.startsWith("http://127.0.0.1:")) throw Error("test_realm_invalid");
  installE2NativeTransport(profile);
  os.userInfo = () => ({ ...user, homedir: profile.home });
  const forbid = value => {
    if (value instanceof URL) value = fileURLToPath(value);
    if (typeof value !== "string") return;
    const path = resolve(value);
    if ([".local/state", ".config", ".pi"].some(part => path === join(actualHome, part) || path.startsWith(join(actualHome, part) + "/"))) throw Error("test_real_store_forbidden");
  };
  for (const target of [fs, fsp]) for (const name of ["open", "readFile", "writeFile", "appendFile", "mkdir", "readdir", "lstat", "stat", "realpath", "unlink", "rm", "rename", "access", "copyFile", "link", "symlink", "readlink", "chmod", "opendir", "truncate", "createReadStream", "createWriteStream"]) {
    for (const suffix of target === fs ? ["", "Sync"] : [""]) {
      const key = name + suffix, original = target[key]; if (typeof original !== "function") continue;
      const wrapped = function (...args) { forbid(args[0]); if (["rename", "copyFile", "link", "symlink"].includes(name)) forbid(args[1]); return original.apply(this, args); };
      if (original.native) wrapped.native = function (...args) { forbid(args[0]); return original.native.apply(this, args); };
      target[key] = wrapped;
    }
  }
  syncBuiltinESMExports();
  const buildURL = pathToFileURL(join(profile.root, "scripts/lib/memory-e2e-build.mjs")).href;
  registerHooks({ load(url, context, next) {
    if (url === buildURL) return { format: "module", shortCircuit: true, source: 'export const BUILD_POLICY="fresh-clean-head-agent-app-closure-v1";export const sourceState=()=>({head:"' + "b".repeat(40) + '",dirty:false});export async function verifyRealBuild(){};export async function prepareRealBuild(){throw Error("test_rebuild_forbidden")}' };
    return next(url, context);
  } });
  const originalFetch = globalThis.fetch.bind(globalThis); let authorized = () => false, spawned = false;
  globalThis.fetch = async (url, init) => {
    const endpoint = String(url);
    if (endpoint === "https://chatgpt.com/backend-api/codex/responses") {
      if (!authorized()) throw Error("test_unguarded_provider_fetch");
      if (profile.fault === "containment" && !spawned) {
        spawned = true;
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", env: { HOME: profile.home, PATH: "/usr/bin:/bin" } });
        await fsp.writeFile(profile.descendant, JSON.stringify({ pid: child.pid, parent: process.pid }), { mode: 0o600 });
      }
      const response = await originalFetch(profile.endpoint, init);
      if (profile.fault === "crash") process.kill(process.pid, "SIGKILL");
      return response;
    }
    const parsed = new URL(endpoint);
    if (!["http:", "https:"].includes(parsed.protocol) || !["127.0.0.1", "[::1]"].includes(parsed.hostname)) throw Error("test_external_fetch_forbidden");
    return originalFetch(url, init);
  };
  const { isGuardedNativeDispatch } = await import(pathToFileURL(join(profile.root, "scripts/lib/continuity-guarded-real-capability.mjs")).href);
  authorized = () => isGuardedNativeDispatch("e2-validation");
}
