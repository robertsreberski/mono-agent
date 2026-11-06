// Diagnostic only: no authorization, claim, mkdir, open or registry-root injection.
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { userInfo } from "node:os";

export async function lookupRegistryReadiness(home = userInfo().homedir) {
  const uid = userInfo().uid, segments = [".local", "state", "mono-agent", "lookup-pilot"];
  let checked = 0;
  try {
    if (!isAbsolute(home) || resolve(home) !== home) throw Error("unsafe");
    // Match consumption's no-alias/non-owner-writable ancestor rules.
    for (let path = home; ; path = dirname(path)) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || ![uid, 0].includes(stat.uid) || (stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000))) throw Error("unsafe");
      if (dirname(path) === path) break;
    }
    if (await realpath(home) !== home) throw Error("unsafe");
    let path = home;
    for (const name of segments) {
      path = join(path, name);
      let stat;
      try {stat = await lstat(path);} catch (error) {
        if (error.code === "ENOENT") return {ready: true, parentExists: false, checked, missing: segments.length - checked, code: "lookup_registry_parent_will_be_created"};
        throw error;
      }
      if (!stat.isDirectory() || ![uid, 0].includes(stat.uid) || (stat.mode & 0o022) !== 0 || await realpath(path) !== path) throw Error("unsafe");
      if (["mono-agent", "lookup-pilot"].includes(name) && (stat.uid !== uid || (stat.mode & 0o077) !== 0)) throw Error("unsafe");
      checked++;
    }
    return {ready: true, parentExists: true, checked, missing: 0, code: "lookup_registry_parent_ready"};
  } catch {return {ready: false, parentExists: null, checked, code: "lookup_authorization_registry_unsafe"};}
}
