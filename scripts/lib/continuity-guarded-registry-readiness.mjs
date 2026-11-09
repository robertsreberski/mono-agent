// Shared guarded-run mechanics; policy is selected only by a closed protocol id.
import { lstat, realpath, access, constants } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { userInfo } from "node:os";
import { guardedProtocol } from "./continuity-guarded-protocols.mjs";
const instances = new Map();
export function guardedRegistryReadiness(id) {
  const protocol = guardedProtocol(id);
  if (!instances.has(protocol)) instances.set(protocol, bind(protocol, id));
  return instances.get(protocol);
}
function bind(protocol, id) {
  async function registryReadiness(home = userInfo().homedir) {
    const uid = userInfo().uid, segments = protocol.policy.REGISTRY_LAYOUT;
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
      for (const [name, privateMode] of segments) {
        path = join(path, name);
        let stat;
        try {stat = await lstat(path);} catch (error) {
          if (error.code === "ENOENT") {
            await access(dirname(path), constants.W_OK | constants.X_OK);
            return {ready: true, parentExists: false, checked, missing: segments.length - checked, code: protocol.codes.registry_parent_will_be_created};
          }
          throw error;
        }
        if (!stat.isDirectory() || ![uid, 0].includes(stat.uid) || (stat.mode & 0o022) !== 0 || await realpath(path) !== path) throw Error("unsafe");
        if (privateMode && (stat.uid !== uid || (stat.mode & 0o077) !== 0)) throw Error("unsafe");
        if (name === segments.at(-2)[0]) await access(path, constants.X_OK);
        checked++;
      }
      await access(path, constants.W_OK | constants.X_OK);
      return {ready: true, parentExists: true, checked, missing: 0, code: protocol.codes.registry_parent_ready};
    } catch {return {ready: false, parentExists: null, checked, code: protocol.codes.authorization_registry_unsafe};}
  }
  return Object.freeze({ registryReadiness });
}
